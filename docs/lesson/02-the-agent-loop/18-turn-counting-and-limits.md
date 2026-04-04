# Lesson 18: Turn Counting and Limits

An agent loop without limits is a liability. A confused model can loop forever, a broken tool can cause infinite retries, and a runaway task can burn through an API budget in minutes. Claude Code uses multiple layers of limits, each catching different failure modes.

## Turn Counting

The simplest limit is the **turn count** — how many iterations the loop has completed.

```typescript
// At the start of queryLoop
let state: State = {
  turnCount: 0,
  // ...
};

while (true) {
  state = { ...state, turnCount: state.turnCount + 1 };

  // ... do work ...

  // Check the limit
  if (state.turnCount >= maxTurns) {
    return { reason: "max_turns" };
  }

  // ... continue loop ...
}
```

What counts as a "turn"? Each iteration of the `while (true)` loop — which typically corresponds to one model API call plus any tool execution that follows. If the model calls three tools in one response, that's still one turn.

Note: not every continue reason increments the turn count equally. A `reactive_compact_retry` (where the same API call is retried with compacted context) may not count as a new turn since no progress was made — it's a retry, not new work.

## maxTurns: The Configurable Limit

`maxTurns` is set through `QueryParams` and can come from multiple sources:

```typescript
// From the SDK
const engine = new QueryEngine({
  maxTurns: 50,  // Hard limit for this session
});

// From CLI flags
claude --max-turns 25

// Default
const DEFAULT_MAX_TURNS = 100;
```

The value is a balance. Too low, and the agent can't complete complex tasks that legitimately require many steps. Too high, and confused agents waste resources. The default is typically high enough for real tasks but low enough to catch infinite loops within a reasonable time.

When `maxTurns` is reached, the loop returns a terminal with reason `"max_turns"`:

```typescript
if (state.turnCount >= params.maxTurns) {
  return {
    reason: "max_turns",
    diagnostics: {
      turnCount: state.turnCount,
      tokensUsed: totalTokensConsumed,
      duration: Date.now() - startTime,
    },
  };
}
```

The diagnostics are included so the consumer can tell the user what happened: "Stopped after 50 turns. The task may be incomplete."

## Token Budget: Limiting Spend

Turn counting alone isn't enough. A single turn that generates a massive response or reads a huge file can consume far more tokens than 10 turns of simple file navigation. The **token budget** limits total token consumption, not iteration count.

```typescript
interface QueryParams {
  // Maximum tokens to spend across ALL API calls in this task
  taskBudgetTokens?: number;
}
```

Token budget tracking works like a prepaid card:

```typescript
// After each API call
const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

state = {
  ...state,
  remainingBudgetTokens: state.remainingBudgetTokens !== null
    ? state.remainingBudgetTokens - tokensUsed
    : null,
};

// Check if budget is exhausted
if (state.remainingBudgetTokens !== null && state.remainingBudgetTokens <= 0) {
  return { reason: "completed", budgetExhausted: true };
}
```

Token budgets are especially important for automated workflows (CI pipelines, batch processing) where many tasks run without human oversight. Without budgets, a single confused task could consume the entire account's allocation.

## The Pre-API Guard: Checking Before Calling

There's no point making an API call if the conversation already exceeds the model's context window. Claude Code checks this **before** the API call:

```typescript
async function checkTokenLimit(state: State, model: string): Promise<boolean> {
  const estimatedTokens = estimateMessageTokens(state.messages);
  const contextWindow = getContextWindowSize(model);
  const reservedForOutput = getMaxOutputTokens(model);

  // Is there room for the prompt AND a meaningful response?
  if (estimatedTokens > contextWindow - reservedForOutput) {
    return false; // Don't bother calling the API
  }

  return true;
}
```

If this check fails and compaction has already been attempted, the loop terminates with `prompt_too_long`. This saves an API call that would fail anyway and gives a clearer error message.

## Recovery Limits: Preventing Infinite Recovery

Some continue reasons involve retrying — but retries must also be limited. Each recovery mechanism has its own counter:

```typescript
// Max output tokens recovery
if (state.maxOutputTokensRecoveryCount >= 3) {
  // Stop trying to recover, escalate or terminate
}

// Reactive compaction
if (state.hasAttemptedReactiveCompact) {
  // Already tried once, don't try again
}
```

Without these, you could get loops like:
1. Model hits output limit → recovery
2. Recovery hits output limit → recovery
3. Recovery hits output limit → recovery
4. ... forever

The counter ensures at most N recovery attempts before the loop either escalates (tries a different model or strategy) or terminates.

## The Safety Net: Multiple Layers

Here's the complete picture of all limits, from most specific to most general:

```
Layer 1: Recovery limits
  ↓ Prevents infinite retries for specific failure modes
  ↓ (maxOutputTokensRecoveryCount, hasAttemptedReactiveCompact)

Layer 2: Pre-API token check
  ↓ Prevents wasted API calls when context is too large
  ↓ (estimateMessageTokens vs contextWindow)

Layer 3: Token budget
  ↓ Prevents excessive spend across all iterations
  ↓ (remainingBudgetTokens)

Layer 4: Turn limit
  ↓ Prevents infinite loops regardless of token efficiency
  ↓ (turnCount vs maxTurns)

Layer 5: User interruption
  ↓ The human always has the final say
  ↓ (Ctrl+C → aborted_streaming or aborted_tools)
```

Each layer catches failures that slip through the previous one:
- Recovery limits stop infinite retries
- Token checks stop impossible API calls
- Token budgets stop expensive tasks
- Turn limits stop everything else
- The user can always pull the plug

## Practical Turn Counts

How many turns do real tasks take? Here's a rough guide:

| Task | Typical Turns |
|------|--------------|
| Answer a question about one file | 2–3 |
| Fix a simple bug | 3–5 |
| Implement a small feature | 5–15 |
| Refactor across multiple files | 10–30 |
| Large feature with tests | 20–50 |
| "Explore and understand the codebase" | 10–25 |

A default limit of 100 turns accommodates even large tasks while catching genuine infinite loops. Most real tasks complete in under 30 turns.

## Turn Counting and Analytics

Turn counts are reported in the terminal diagnostics, enabling analysis of agent performance:

```typescript
// When the loop terminates
const terminal: Terminal = {
  reason: terminalReason,
  diagnostics: {
    turnCount: state.turnCount,
    tokensUsed: calculateTotalTokens(state),
    duration: Date.now() - loopStartTime,
    toolCallCount: countToolCalls(state.messages),
  },
};
```

This data answers questions like:
- Are tasks completing efficiently? (low turn count = good)
- Are we hitting limits often? (many `max_turns` = limits too low or tasks too complex)
- What's the cost per task? (tokens used * price per token)

## Example: A Runaway Loop Caught

Here's what happens when a task goes wrong without limits vs. with limits:

**Without limits:**
```
Turn 1: Model reads file → empty result (file doesn't exist)
Turn 2: Model reads file again with different path → empty result
Turn 3: Model reads file again → empty result
Turn 4: Model reads file again → empty result
... 
Turn 847: Model reads file again → empty result
(You've now spent $12 on API calls for nothing)
```

**With limits (maxTurns = 50):**
```
Turn 1-49: Same confused behavior
Turn 50: max_turns reached → Terminal { reason: "max_turns" }
Output: "Stopped after 50 turns. The task may be incomplete."
(You spent $0.72 instead of $12+, and the user was notified)
```

The limits don't fix the underlying problem (the model is confused), but they contain the damage.

---

**Key Takeaways**
- `turnCount` tracks loop iterations; `maxTurns` caps them
- Token budgets limit total API spend, independent of turn count
- Pre-API token checks prevent wasted calls when context is already too large
- Recovery mechanisms (output recovery, compaction) have their own counters to prevent infinite retries
- Five layers of limits work together: recovery limits, token checks, token budgets, turn limits, user interruption
- Most real tasks complete in under 30 turns; a default limit of ~100 is typical
- Turn count diagnostics are reported on termination for analytics and debugging

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook.

### Exercise 1 — Five Layers of Safety
**Question:** List the five layers of limits in Claude Code from most specific to most general. For each layer, explain what failure mode it catches that the previous layers don't.

[View Answer](../../answers/02-the-agent-loop/answer-18.md#exercise-1)

### Exercise 2 — Implement Token Budget Tracking
**Challenge:** Write a loop that tracks a token budget. Start with 10,000 tokens. Each iteration, simulate an API call that uses a random number of tokens (500-2,000). The loop should: deduct tokens after each call, print remaining budget, and stop when the budget is exhausted. Use immutable state.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-18.md#exercise-2)

### Exercise 3 — Turn Count vs. Token Budget
**Question:** A task uses 3 turns but consumes 150,000 tokens (reading huge files). Another task uses 45 turns but only 8,000 tokens (many small file checks). Which limit catches each case, and why do you need both?

[View Answer](../../answers/02-the-agent-loop/answer-18.md#exercise-3)

### Exercise 4 — Pre-API Guard Implementation
**Challenge:** Write a `checkTokenLimit` function that estimates whether a set of messages will fit in the context window. It should take `messages`, `modelContextWindow` (e.g., 200,000), and `reservedForOutput` (e.g., 4,096). Estimate tokens as `text.length / 4`. Return `{ fits: boolean, estimated: number, available: number }`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-18.md#exercise-4)

### Exercise 5 — Runaway Loop Cost Analysis
**Question:** An agent loop with no limits runs for 847 turns at $0.015 per turn average before a human notices and kills it. The same loop with `maxTurns = 50` would have stopped early. Calculate the cost with and without limits. Then explain why the cost difference matters more for automated workflows (CI/batch) than interactive use.

[View Answer](../../answers/02-the-agent-loop/answer-18.md#exercise-5)
