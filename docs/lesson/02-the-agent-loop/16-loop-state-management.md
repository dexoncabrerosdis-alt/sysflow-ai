# Lesson 16: Loop State Management

In our simple agent loop from Lesson 12, "state" was just the `messages` array. We appended to it and passed it to the next API call. Claude Code's loop tracks far more than messages — it maintains a rich state object that gets rebuilt on every iteration.

## The State Type

Here's what the loop tracks:

```typescript
type State = {
  // The full conversation history
  messages: Message[];

  // Context about in-flight tool operations
  toolUseContext: ToolUseContext;

  // Tracking for automatic context compaction
  autoCompactTracking: {
    lastCompactedAt: number;      // Turn count at last compaction
    tokensSinceLastCompact: number; // Tokens consumed since then
  };

  // How many times we've recovered from max_output_tokens
  maxOutputTokensRecoveryCount: number;

  // Whether we've tried reactive compaction already
  hasAttemptedReactiveCompact: boolean;

  // Current iteration number
  turnCount: number;

  // Budget tokens remaining for the task
  remainingBudgetTokens: number | null;

  // Messages that were compacted (for potential restoration)
  compactedMessageIds: Set<string>;
};
```

Each field exists for a reason. Let's understand them.

## Field by Field

### messages

The conversation history — same as Lesson 12, but richer. Messages can be assistant responses, tool results, system messages, or compacted summaries. This is the primary input to every model API call.

### toolUseContext

Tracks the state of tool operations across iterations:

```typescript
type ToolUseContext = {
  activeToolCalls: Map<string, ToolCallInfo>;  // Currently executing
  completedToolIds: Set<string>;               // Already finished
  pendingToolResults: ToolResult[];            // Results waiting to be processed
};
```

Why is this needed? Because tools can be interrupted. If the user presses Ctrl+C while a file is being written, the loop needs to know which tools finished and which didn't, so it can report accurately.

### autoCompactTracking

Context windows have limits. When the conversation grows too long, Claude Code **compacts** it — summarizing old messages to free up space. This field tracks when compaction last happened and how many tokens have been used since, so the loop can decide when to compact again:

```typescript
// Pseudo-logic inside the loop
if (state.autoCompactTracking.tokensSinceLastCompact > COMPACT_THRESHOLD) {
  messages = await compactConversation(state.messages);
  state.autoCompactTracking = {
    lastCompactedAt: state.turnCount,
    tokensSinceLastCompact: 0,
  };
}
```

### maxOutputTokensRecoveryCount

Sometimes the model hits its output token limit mid-response. When this happens, Claude Code can ask the model to continue where it left off. This counter tracks how many times that's happened in the current task, preventing infinite continuation loops:

```typescript
if (response.stop_reason === "max_tokens") {
  if (state.maxOutputTokensRecoveryCount < MAX_RECOVERY_ATTEMPTS) {
    // Ask the model to continue
    return { type: "continue", reason: "max_output_tokens_recovery" };
  } else {
    // Too many retries, stop
    return { type: "terminal", reason: "model_error" };
  }
}
```

### hasAttemptedReactiveCompact

Distinct from auto-compaction, reactive compaction happens when the context window is about to overflow and the loop **must** compact to continue. This flag ensures the loop only tries this once — if compaction fails to free enough space, the loop stops instead of compacting in a loop.

### turnCount

The simple iteration counter. Incremented at the start of every loop iteration. Compared against `maxTurns` to enforce the iteration limit.

### remainingBudgetTokens

When a task has a token budget, this tracks how many tokens are left. Every API call deducts from the budget. When it hits zero, the loop must stop.

### compactedMessageIds

When messages are compacted, their IDs are stored here. This allows the system to know which messages were summarized (useful for debugging and for restoring context if needed).

## How State Is Initialized

At the start of `queryLoop()`, state is created from `QueryParams`:

```typescript
let state: State = {
  messages: [...params.messages],
  toolUseContext: params.toolUseContext,
  autoCompactTracking: {
    lastCompactedAt: 0,
    tokensSinceLastCompact: 0,
  },
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  turnCount: 0,
  remainingBudgetTokens: params.taskBudgetTokens ?? null,
  compactedMessageIds: new Set(),
};
```

The messages come from the params (which may include prior conversation). The counters and flags all start at zero/false. The budget comes from the task configuration.

## How State Evolves

Here's the critical design principle: **state is rebuilt each iteration, never mutated in place**.

```typescript
while (true) {
  // ... do work with current state ...

  // Build the NEXT state as a new object
  const next: State = {
    messages: [...state.messages, assistantMessage, ...toolResults],
    toolUseContext: updatedToolContext,
    autoCompactTracking: updatedCompactTracking,
    maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount + (recovered ? 1 : 0),
    hasAttemptedReactiveCompact: state.hasAttemptedReactiveCompact || didReactiveCompact,
    turnCount: state.turnCount + 1,
    remainingBudgetTokens: deductTokens(state.remainingBudgetTokens, tokensUsed),
    compactedMessageIds: state.compactedMessageIds,
  };

  // Replace state entirely
  state = next;
}
```

This is an immutable state pattern. The old state is never modified — a new state object is created with the updated values, and the variable is reassigned.

Why not just mutate `state.turnCount++`? Three reasons:

**1. Predictability.** At any point in the iteration, `state` reflects the state at the **start** of this iteration, not some partially-updated in-between state. There's no risk of reading a field that was already updated for the next iteration.

**2. Debugging.** If something goes wrong, you can log the old state and the new state and compare them. With mutation, the old state is gone.

**3. Transitions.** The decision of "what should the next state be?" is complex — it depends on whether tools were executed, whether compaction happened, whether the model hit limits. Building the next state as a single expression makes all these dependencies explicit.

## State Transitions in Practice

Here's a more realistic view of how state evolves across iterations:

```
Iteration 1:
  state.turnCount = 0
  state.messages = [user message]
  → Model calls read_file
  → Tool returns file content
  next.turnCount = 1
  next.messages = [user message, assistant(read_file), tool_result(content)]

Iteration 2:
  state.turnCount = 1
  state.messages = [user, assistant, tool_result]
  → Model calls write_file
  → Tool writes file
  next.turnCount = 2
  next.messages = [user, assistant, tool_result, assistant(write_file), tool_result(ok)]

Iteration 3:
  state.turnCount = 2
  state.messages = [user, assistant, tool_result, assistant, tool_result]
  → Model responds with text (no tools)
  → Loop terminates: Terminal { reason: "completed" }
```

Each iteration reads the current state, does work, and produces the next state. The loop is a state machine where the transitions are determined by the model's behavior and the tool execution results.

## Comparing to Our Simple Loop

| Simple Loop (Lesson 12) | Claude Code State |
|--------------------------|-------------------|
| `messages` array | `state.messages` |
| `iterations` counter | `state.turnCount` |
| `maxIterations` check | `maxTurns` + budget + reactive flags |
| `messages.push(...)` | `state = buildNextState(...)` |
| No error tracking | `maxOutputTokensRecoveryCount`, `hasAttemptedReactiveCompact` |
| No compaction | `autoCompactTracking`, `compactedMessageIds` |

The simple loop's `messages.push()` is mutation. Claude Code's `state = next` is replacement. Both achieve the same goal — maintaining conversation history across iterations — but the replacement pattern scales to the additional complexity that a production agent requires.

## The State Is the Loop's Memory

Think of the `State` object as the loop's short-term memory. It knows:
- What happened (messages)
- What's happening now (toolUseContext)
- How long it's been running (turnCount)
- How much resource it has left (remainingBudgetTokens)
- What recovery strategies it has already tried (maxOutputTokensRecoveryCount, hasAttemptedReactiveCompact)

Every decision the loop makes — should I compact? should I stop? should I retry? — is based on reading this state. The state is the single source of truth for the loop's situation.

---

**Key Takeaways**
- The loop maintains a `State` object tracking messages, turn count, budgets, compaction, and recovery counters
- State is **rebuilt** each iteration, not mutated — the old state is replaced entirely
- Each field exists to support a specific loop behavior: compaction, recovery, budgeting, or limits
- The immutable state pattern makes the loop predictable: `state` always reflects the start of the current iteration
- State transitions are explicit: `state = next` happens once at the bottom of the loop
- The `State` type is the loop's memory — every decision reads from it

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook.

### Exercise 1 — State Fields and Their Purposes
**Question:** For each of these `State` fields, explain what loop behavior it supports and what would go wrong without it: `autoCompactTracking`, `maxOutputTokensRecoveryCount`, `hasAttemptedReactiveCompact`.

[View Answer](../../answers/02-the-agent-loop/answer-16.md#exercise-1)

### Exercise 2 — Immutable vs. Mutable State
**Question:** Claude Code rebuilds the state object each iteration (`state = next`) instead of mutating it (`state.turnCount++`). Give the three reasons for this design and explain each with an example.

[View Answer](../../answers/02-the-agent-loop/answer-16.md#exercise-2)

### Exercise 3 — Build an Immutable State Loop
**Challenge:** Write a loop that processes items from a queue using immutable state. Define a `State` type with `items: string[]`, `processed: number`, and `errors: string[]`. Each iteration should process the first item, and if it contains the word "bad", add it to errors. Build `nextState` as a new object each iteration.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-16.md#exercise-3)

### Exercise 4 — State Transition Trace
**Challenge:** Trace the state transitions for a 3-iteration agent task where: iteration 1 reads a file (2,000 tokens), iteration 2 writes a file (1,500 tokens), iteration 3 gives a final answer (800 tokens). Show the full `State` object at the start of each iteration. Assume `remainingBudgetTokens` starts at 10,000.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-16.md#exercise-4)

### Exercise 5 — Why Not Just messages.push()?
**Question:** Our simple loop from Lesson 12 used `messages.push()` to mutate the history. Claude Code uses `state = { ...state, messages: [...state.messages, ...newMessages] }`. What specific production problems does the immutable approach solve that `push()` doesn't?

[View Answer](../../answers/02-the-agent-loop/answer-16.md#exercise-5)
