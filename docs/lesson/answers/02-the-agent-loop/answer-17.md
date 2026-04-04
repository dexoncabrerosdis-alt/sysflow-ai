# Answers: Lesson 17 — Terminal and Continue Reasons

## Exercise 1
**Question:** Classify each scenario as a specific terminal or continue reason.

**Answer:**

**(a) The model says "I've fixed the bug" with no tool calls.**
**Terminal: `completed`** — The model responded with text and no tool use, indicating it considers the task finished. This is the happy path.

**(b) The user presses Ctrl+C while the model is streaming text.**
**Terminal: `aborted_streaming`** — The user interrupted during the model's response generation (streaming phase). The incomplete response is discarded.

**(c) The model's response was cut off at 4,096 tokens.**
**Continue: `max_output_tokens_recovery`** — The model hit the output token limit mid-response. The loop will append a "please continue" message and call the model again to finish its response (assuming the recovery counter hasn't been exhausted).

**(d) The model called `write_file` and `read_file` in one response.**
**Continue: `tool_use`** — The most common continue reason. The model used tools, so the loop must execute them, add results to the conversation, and call the model again.

**(e) The conversation exceeded the 200k context window.**
**Terminal: `prompt_too_long`** — The conversation history exceeds the model's context window. If reactive compaction hasn't been tried, it would first be a `reactive_compact_retry` continue. But if compaction was already attempted (or can't free enough space), it's a terminal `prompt_too_long`.

---

## Exercise 2
**Challenge:** Write a simplified `determineTransition` function.

**Answer:**
```typescript
type Transition =
  | { type: "terminal"; terminal: { reason: string }; messages: Message[] }
  | { type: "continue"; reason: string; nextState: Partial<State>; messages: Message[] };

function determineTransition(
  state: State,
  response: { stopReason: string; message: Message; hasToolUse: boolean; toolBlocks: ToolBlock[] },
  wasAborted: boolean
): Transition {
  // 1. Check abort first — user intent overrides everything
  if (wasAborted) {
    return {
      type: "terminal",
      terminal: { reason: response.stopReason === "end_turn" ? "aborted_tools" : "aborted_streaming" },
      messages: [],
    };
  }

  // 2. Model finished without tools — task complete
  if (response.stopReason === "end_turn" && !response.hasToolUse) {
    return {
      type: "terminal",
      terminal: { reason: "completed" },
      messages: [response.message],
    };
  }

  // 3. Output truncated — try recovery
  if (response.stopReason === "max_tokens") {
    if (state.maxOutputTokensRecoveryCount < 3) {
      return {
        type: "continue",
        reason: "max_output_tokens_recovery",
        nextState: {
          maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount + 1,
        },
        messages: [response.message],
      };
    }
    return {
      type: "terminal",
      terminal: { reason: "model_error" },
      messages: [response.message],
    };
  }

  // 4. Model used tools — normal continuation
  if (response.hasToolUse) {
    return {
      type: "continue",
      reason: "tool_use",
      nextState: {
        turnCount: state.turnCount + 1,
      },
      messages: [response.message],
    };
  }

  // Fallback — shouldn't reach here
  return {
    type: "terminal",
    terminal: { reason: "model_error" },
    messages: [],
  };
}
```

**Explanation:** The function checks conditions in priority order: abort (user intent) first, then completion (happy path), then output limits (recoverable error), then tool use (normal flow). Each branch returns a fully typed `Transition` object with the appropriate reason, state updates, and messages. The ordering matters — an aborted request that also has tool use should be treated as aborted, not as tool_use.

---

## Exercise 3
**Question:** Why detailed reasons instead of `shouldContinue: boolean`?

**Answer:**

**1. Analytics** — Detailed reasons enable data-driven improvements. Example: if analytics show 15% of sessions end with `prompt_too_long`, the team knows to improve the compaction algorithm. If 40% end with `max_turns`, the default limit may be too low. With a boolean, you'd only know "continued" or "stopped" — useless for understanding failure patterns.

**2. Debugging** — When a user reports "the agent just stopped working," the terminal reason immediately identifies the cause. `aborted_streaming` means the user interrupted. `model_error` means the API failed. `blocking_limit` means a permission was denied. With a boolean, every bug report starts with a manual investigation: "was it an error? a limit? user action?" The reason is the first line of the diagnostic.

**3. Recovery routing** — Different continue reasons require different behaviors in the next iteration. `tool_use` means "execute tools and call the model with results." `max_output_tokens_recovery` means "append a continue prompt and retry without tool execution." `reactive_compact_retry` means "compact messages and retry the same API call." A boolean can't encode these distinctions — you'd need additional flags or checks to determine *what kind* of continuation is needed.

---

## Exercise 4
**Challenge:** Write a switch statement routing on ContinueReason.

**Answer:**
```typescript
async function handleContinuation(
  transition: { reason: string; nextState: Partial<State> },
  state: State,
  toolBlocks: ToolBlock[],
  params: QueryParams
): Promise<State> {
  switch (transition.reason) {
    case "tool_use": {
      // Normal flow: execute tools and build next state with results
      const toolResults = await executeAllTools(toolBlocks, params);
      return {
        ...state,
        ...transition.nextState,
        messages: [...state.messages, ...toolResults],
      };
    }

    case "reactive_compact_retry": {
      // Context too large: compact and retry the same API call
      const compacted = await compactConversation(state.messages, params.model);
      return {
        ...state,
        messages: compacted,
        hasAttemptedReactiveCompact: true,
        autoCompactTracking: { lastCompactedAt: state.turnCount, tokensSinceLastCompact: 0 },
      };
    }

    case "max_output_tokens_recovery": {
      // Output truncated: ask model to continue where it left off
      const continueMessage: Message = {
        role: "user",
        content: "Your response was truncated. Please continue exactly where you left off.",
      };
      return {
        ...state,
        ...transition.nextState,
        messages: [...state.messages, continueMessage],
      };
    }

    case "max_output_tokens_escalate": {
      // Repeated truncation: switch to a model with larger output capacity
      return {
        ...state,
        ...transition.nextState,
        model: "claude-sonnet-4-20250514", // model with extended output
      };
    }

    default:
      return { ...state, ...transition.nextState };
  }
}
```

**Explanation:** Each reason triggers fundamentally different behavior. `tool_use` executes tools. `reactive_compact_retry` summarizes the conversation without executing anything. `max_output_tokens_recovery` adds a message without executing tools. `max_output_tokens_escalate` changes the model. A boolean `shouldContinue` couldn't distinguish these — the reason is a routing instruction for the next iteration.

---

## Exercise 5
**Question:** What is the practical difference between `aborted_streaming` and `aborted_tools`?

**Answer:** The difference is *when* the user interrupted and *what cleanup is needed*:

**`aborted_streaming`** — The user interrupted while the model was generating its response (tokens were streaming). The response is incomplete — it might have a half-finished sentence or a partially formed tool call. Cleanup is simple: discard the incomplete response. No tools ran, no files were modified, no side effects occurred. The conversation history remains clean up to the last complete turn.

**`aborted_tools`** — The user interrupted while tools were executing. Some tools may have completed and some may not. A `write_file` tool might have written half a file. A `bash` command might be running in the background. Cleanup is complex: the loop needs to determine which tools completed (their results should be recorded), which were interrupted (their partial results need annotation), and whether any side effects need to be rolled back or at least reported to the user.

Claude Code distinguishes them because the **risk profile** is completely different. Aborting during streaming is always safe (no real-world effects). Aborting during tools is potentially unsafe (partial file writes, running processes) and may require cleanup. The distinction also matters for conversation history: an aborted stream can be cleanly removed, but aborted tool results (even partial ones) should be preserved so the model knows what happened if the user continues.
