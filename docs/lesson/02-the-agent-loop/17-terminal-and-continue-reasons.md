# Lesson 17: Terminal and Continue Reasons

Every iteration of the agent loop ends with a decision: **stop or continue?** In our simple loop from Lesson 12, this was a single `if` check — did the model use tools or not? Claude Code formalizes this into a type system that categorizes every possible outcome.

## The Core Idea

After the model responds and tools execute, the loop must answer one question: what happens next? There are exactly two possibilities:

1. **Terminal**: The loop stops. The agent is done (successfully or not).
2. **Continue**: The loop runs another iteration. There's more work to do.

But within each category, there are many *reasons*. A terminal could be "task completed successfully" or "the user aborted." A continue could be "the model wants to use more tools" or "we need to retry because the output was truncated." Claude Code tracks the specific reason because it matters for analytics, debugging, error messages, and recovery logic.

## Terminal Reasons

A terminal reason means the loop exits. Here are the real reasons from Claude Code:

```typescript
type TerminalReason =
  | "completed"                // Model finished the task normally
  | "blocking_limit"           // Hit a permission/blocking limit
  | "image_error"              // Failed to process an image
  | "model_error"              // API error that can't be recovered
  | "aborted_streaming"        // User interrupted during model streaming
  | "aborted_tools"            // User interrupted during tool execution
  | "prompt_too_long"          // Context window exceeded, can't continue
  | "stop_hook_prevented"      // A hook prevented the response
  | "hook_stopped"             // A hook terminated the loop
  | "max_turns";               // Hit the iteration limit
```

### What each means:

**`completed`** — The happy path. The model responded with text (no tool calls), indicating it considers the task done. This is the equivalent of our simple loop's `stop_reason === "end_turn"` check.

**`blocking_limit`** — The model wanted to use a tool that requires user approval, but the approval limit was reached or denied. The agent can't proceed without permission it doesn't have.

**`image_error`** — The model tried to process an image that couldn't be loaded or decoded. Since the model can't see the image, it can't proceed meaningfully.

**`model_error`** — The API returned an error (rate limit, server error, malformed request) and all retry strategies have been exhausted. No point in continuing.

**`aborted_streaming`** — The user pressed Ctrl+C (or equivalent) while the model was generating a response. The incomplete response is discarded.

**`aborted_tools`** — The user pressed Ctrl+C while tools were executing. Partially completed tool operations may need cleanup.

**`prompt_too_long`** — The conversation history exceeds the model's context window, and compaction either failed or wasn't enough. The conversation literally can't fit in the model's memory.

**`stop_hook_prevented`** — A configured hook (a user-defined script that runs before/after tool execution) blocked the model's response. The hook said "no."

**`hook_stopped`** — A hook terminated the entire loop, not just a single response.

**`max_turns`** — The iteration count hit the configured maximum. This is the safety net that prevents runaway loops.

## Continue Reasons

A continue reason means the loop runs again. Here are the real reasons:

```typescript
type ContinueReason =
  | "tool_use"                       // Model called tools, need to execute and continue
  | "reactive_compact_retry"         // Context too large, compacted, retry the API call
  | "max_output_tokens_recovery"     // Output was truncated, ask model to continue
  | "max_output_tokens_escalate"     // Output truncated repeatedly, try a bigger model
  | "collapse_drain_retry"           // Collapsed large tool results, retry
  | "stop_hook_blocking"             // A hook said to block but allow retry
  | "token_budget_continuation"      // Budget remaining, model should keep going
  | "queued_command"                 // There are queued commands to process
```

### What each means:

**`tool_use`** — The most common continue reason by far. The model called one or more tools. The loop needs to execute them, add the results to the conversation, and call the model again. This is the normal flow from Lesson 12.

**`reactive_compact_retry`** — The model API call would have exceeded the context window. The loop compacted the conversation (summarized old messages) and needs to retry the API call with the shorter history.

**`max_output_tokens_recovery`** — The model's response was cut off because it hit the output token limit. The loop adds a "please continue" message and calls the model again to finish its response.

**`max_output_tokens_escalate`** — The model keeps hitting the output limit even after recovery attempts. The loop switches to a model with a larger output capacity (for example, from a smaller model to Sonnet with extended output).

**`collapse_drain_retry`** — Large tool results were collapsed (truncated or summarized) to free up context space. The API call needs to be retried with the smaller results.

**`stop_hook_blocking`** — A hook blocked the current response but allows the loop to continue with a different approach.

**`token_budget_continuation`** — The task has remaining token budget, and the model indicated it has more work to do. Used in agentic workflows where tasks are explicitly budgeted.

**`queued_command`** — A command was queued during tool execution that needs to be processed in the next iteration.

## The Transition Type

These reasons are bundled into a transition object that determines the loop's next action:

```typescript
type Transition =
  | {
      type: "terminal";
      terminal: Terminal;
      messages: Message[];
    }
  | {
      type: "continue";
      reason: ContinueReason;
      nextState: Partial<State>;
      messages: Message[];
    };

type Terminal = {
  reason: TerminalReason;
  diagnostics?: {
    turnCount: number;
    tokensUsed: number;
    duration: number;
  };
};
```

The function that determines the transition is the most important decision point in the loop:

```typescript
function determineTransition(
  state: State,
  response: ModelResponse,
  toolResults: ToolResult[]
): Transition {
  // Did the user abort?
  if (wasAborted()) {
    return {
      type: "terminal",
      terminal: { reason: response.streaming ? "aborted_streaming" : "aborted_tools" },
      messages: [],
    };
  }

  // Did the model finish without tool use?
  if (response.stopReason === "end_turn" && !hasToolUse(response)) {
    return {
      type: "terminal",
      terminal: { reason: "completed" },
      messages: [response.message],
    };
  }

  // Did the model hit output limits?
  if (response.stopReason === "max_tokens") {
    if (state.maxOutputTokensRecoveryCount < MAX_RECOVERIES) {
      return {
        type: "continue",
        reason: "max_output_tokens_recovery",
        nextState: {
          maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount + 1,
        },
        messages: [response.message],
      };
    }
  }

  // Did the model use tools?
  if (hasToolUse(response)) {
    return {
      type: "continue",
      reason: "tool_use",
      nextState: {
        messages: [...state.messages, response.message, ...toolResults],
        turnCount: state.turnCount + 1,
      },
      messages: [response.message, ...toolResults],
    };
  }

  // Shouldn't reach here, but be safe
  return {
    type: "terminal",
    terminal: { reason: "model_error" },
    messages: [],
  };
}
```

## Why This Categorization Matters

You might wonder: why not just use a boolean? `shouldContinue: true/false`. The detailed categorization serves three purposes:

### 1. Analytics

Claude Code tracks why loops end. If 30% of sessions end with `prompt_too_long`, that's a signal to improve compaction. If `max_turns` is hit frequently, the default limit might be too low.

```typescript
trackMetric("loop_terminal_reason", terminal.reason);
trackMetric("loop_turns", terminal.diagnostics.turnCount);
```

### 2. Debugging

When a user reports "it just stopped," the terminal reason immediately narrows the investigation. `aborted_streaming` means the user interrupted. `model_error` means the API failed. `max_turns` means the task was too long. Without the reason, every bug report starts with "what happened?"

### 3. Recovery Logic

Different continue reasons trigger different behaviors in the next iteration:

```typescript
// Inside the loop, after determining a continue transition
switch (transition.reason) {
  case "tool_use":
    // Normal flow: execute tools, build next state
    break;

  case "reactive_compact_retry":
    // Don't execute tools — retry the same API call with compacted context
    break;

  case "max_output_tokens_recovery":
    // Append a "please continue" message, don't execute tools
    break;

  case "max_output_tokens_escalate":
    // Switch to a more capable model before retrying
    break;
}
```

The reason isn't just a label — it's a routing instruction for the next iteration.

## The Full Picture

Here's how terminal and continue reasons fit into the loop:

```
while (true) {
  call model
       ↓
  determine transition
       ↓
  ┌─────────────────────────────────────────┐
  │ terminal?                               │
  │   → return Terminal { reason: "..." }   │
  │                                         │
  │ continue?                               │
  │   → execute appropriate recovery/tools  │
  │   → build next state                    │
  │   → loop again                          │
  └─────────────────────────────────────────┘
```

Every iteration either terminates or continues, and the specific reason determines what happens next.

---

**Key Takeaways**
- Every loop iteration ends with a `Transition`: either terminal (stop) or continue (loop again)
- Terminal reasons include: completed, errors, aborts, limits, hooks
- Continue reasons include: tool_use, compaction retries, output recovery, model escalation
- The `Transition` type bundles the reason with the next state and any messages to yield
- Categorization enables analytics, debugging, and correct recovery behavior
- `tool_use` is the most common continue reason — the normal "model used tools, keep going" flow
- `completed` is the most common terminal reason — the "model is done" happy path

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook.

### Exercise 1 — Classify the Reasons
**Question:** Categorize each of the following scenarios as a specific terminal or continue reason: (a) The model says "I've fixed the bug" with no tool calls. (b) The user presses Ctrl+C while the model is streaming text. (c) The model's response was cut off at 4,096 tokens. (d) The model called `write_file` and `read_file` in one response. (e) The conversation exceeded the 200k context window.

[View Answer](../../answers/02-the-agent-loop/answer-17.md#exercise-1)

### Exercise 2 — Implement determineTransition
**Challenge:** Write a simplified `determineTransition` function. It should check, in order: (1) was the request aborted? (2) did the model finish without tools? (3) did the model hit the output token limit? (4) did the model use tools? Return the appropriate `Transition` object for each case.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-17.md#exercise-2)

### Exercise 3 — Why Not a Boolean?
**Question:** Why does Claude Code use detailed terminal/continue reasons instead of a simple `shouldContinue: boolean`? Explain the three specific benefits with examples.

[View Answer](../../answers/02-the-agent-loop/answer-17.md#exercise-3)

### Exercise 4 — Recovery Routing
**Challenge:** Write a `switch` statement that handles each `ContinueReason` differently in the next iteration. For `tool_use`, execute tools normally. For `reactive_compact_retry`, retry the API call without tools. For `max_output_tokens_recovery`, append a "please continue" message. For `max_output_tokens_escalate`, switch to a larger model.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-17.md#exercise-4)

### Exercise 5 — aborted_streaming vs. aborted_tools
**Question:** What is the practical difference between `aborted_streaming` and `aborted_tools`? Why does Claude Code distinguish between them? What cleanup considerations differ?

[View Answer](../../answers/02-the-agent-loop/answer-17.md#exercise-5)
