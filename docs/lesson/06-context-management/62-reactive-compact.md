# Lesson 62: Reactive Compact

## When Proactive Isn't Enough

Autocompact (Lesson 60) is proactive — it triggers when the token count crosses a warning threshold, *before* the context window is full. But proactive measures can fail:

- The token count estimate was too low (estimation error)
- A single tool result pushed the count past the blocking limit in one jump
- Autocompact's circuit breaker tripped (3 consecutive failures)
- The summarization API call itself added tokens before they could be freed
- Context collapse was enabled but didn't reduce enough

In these cases, the API call goes out and comes back with an HTTP 413: **prompt too long**. The request was rejected because it exceeded the model's context window.

Reactive compact is the emergency handler for this situation.

## The 413 Error

When the API returns 413, the response looks like this:

```json
{
  "type": "error",
  "error": {
    "type": "prompt_too_long",
    "message": "The prompt is too long. Max tokens: 200000, prompt tokens: 207342"
  }
}
```

This is different from most API errors:
- It's not transient (retrying with the same prompt will fail again)
- It's not a server issue (the request was well-formed, just too large)
- The only fix is to *reduce the prompt size* and retry

Standard retry logic (Lesson 4) won't help here. The agent needs a specialized recovery path.

## tryReactiveCompact()

When the agent catches a 413 error, it calls `tryReactiveCompact()`:

```typescript
async function* tryReactiveCompact(
  messages: Message[],
  model: ModelId,
  error: APIError,
  state: AgentState
): AsyncGenerator<AgentEvent> {
  yield {
    type: "reactive_compact_start",
    reason: "prompt_too_long",
    currentTokens: error.promptTokens,
    maxTokens: error.maxTokens,
  };

  // Phase 1: Drain any staged context collapses first
  //   Context collapse (Lesson 63) may have staged reductions
  //   that haven't been committed yet. Apply them now.
  if (state.contextCollapse.hasStagedCollapses()) {
    yield { type: "draining_staged_collapses" };
    const drained = state.contextCollapse.drainStagedCollapses(messages);

    if (drained.tokensFreed > 0) {
      // Recount tokens after draining
      const newCount = estimateTokenCount(messages);
      const effectiveWindow = getEffectiveContextWindowSize(model);

      if (newCount < effectiveWindow) {
        yield {
          type: "reactive_compact_complete",
          method: "collapse_drain",
          tokensFreed: drained.tokensFreed,
        };
        return;  // Draining was enough — retry the API call
      }
    }
  }

  // Phase 2: Full compaction
  //   If draining collapses wasn't enough (or there were none),
  //   do a full conversation compaction.
  try {
    const result = await compactConversation(messages, model);

    if (result.success) {
      // Replace messages with the compacted version
      messages.length = 0;
      messages.push(...result.newMessages);

      // Post-compact cleanup
      postCompactCleanup(state);

      yield {
        type: "reactive_compact_complete",
        method: "full_compact",
        tokensFreed: result.tokensFreed,
      };
      return;
    }
  } catch (compactError) {
    yield {
      type: "reactive_compact_error",
      error: compactError.message,
    };
  }

  // Phase 3: Terminal failure
  //   If compaction itself failed, there's nothing left to try.
  //   The agent must stop.
  yield {
    type: "reactive_compact_terminal",
    reason: "Unable to reduce context size below model limit",
  };

  throw new TerminalError(
    "prompt_too_long",
    "Failed to reduce context size after 413 error. " +
    "The conversation is too large to continue."
  );
}
```

## The Three Phases

Reactive compact has a clear escalation path:

```
413 Error Received
       │
       ▼
 ┌─────────────┐     ┌───────────────┐
 │ Phase 1:     │ yes │ Retry API     │
 │ Drain staged ├────→│ call          │
 │ collapses    │     └───────────────┘
 └──────┬──────┘
    not enough
        │
        ▼
 ┌─────────────┐     ┌───────────────┐
 │ Phase 2:     │ yes │ Retry API     │
 │ Full compact ├────→│ call          │
 └──────┬──────┘     └───────────────┘
     failed
        │
        ▼
 ┌─────────────┐
 │ Phase 3:     │
 │ Terminal     │
 │ error — stop │
 └─────────────┘
```

### Phase 1: Drain Staged Collapses

Context collapse (covered in Lesson 63) works by staging reductions that are applied lazily. When a 413 hits, these staged reductions are committed immediately — "drained" — to free space without the cost of a full compaction.

This is the fastest path to recovery: no API call needed, just apply pending reductions. If it frees enough tokens, the original API call is retried immediately.

### Phase 2: Full Compaction

If draining isn't enough, reactive compact falls back to full conversation compaction — the same mechanism autocompact uses (Lesson 61). The entire conversation is summarized into a compact form.

There's an irony here: generating the summary requires an API call, which itself needs context space. Reactive compact uses a smaller model or a shorter prompt for this summarization to ensure it fits even when the main model's context is full.

```typescript
async function emergencyCompact(
  messages: Message[],
  model: ModelId
): Promise<CompactResult> {
  // Use a more aggressive summarization prompt
  const prompt = getEmergencyCompactPrompt(messages);

  // May use a different model with a larger context window
  // for the summarization call itself
  const summaryModel = getSummarizationModel(model);

  const summary = await callModel(prompt, summaryModel);
  return {
    success: true,
    newMessages: [createBoundaryMessage(summary)],
    tokensFreed: estimateTokenCount(messages) - estimateTokenCount(summary),
  };
}
```

### Phase 3: Terminal Failure

If compaction itself fails (the summarization API call errors, the summary is still too large, etc.), there's nothing left to try. The agent raises a terminal error and stops.

This is rare but possible. It can happen when:
- The system prompt alone exceeds the context window (misconfiguration)
- The model is unavailable and can't generate a summary
- The conversation has so many images/attachments that even after stripping, it doesn't fit

The terminal error message is surfaced to the user, who can start a new conversation or reduce their system prompt.

## How It Differs from Autocompact

| Aspect | Autocompact | Reactive Compact |
|--------|-------------|------------------|
| **Trigger** | Token count exceeds warning threshold | API returns 413 error |
| **Timing** | Before the API call | After the API call fails |
| **Proactive vs. reactive** | Proactive (preventive) | Reactive (recovery) |
| **Circuit breaker** | Yes (3 failures → stop) | No (must try — it's the last resort) |
| **Collapse drain** | No | Yes (try draining first) |
| **Terminal failure** | Yields to reactive compact | Raises terminal error |
| **Performance** | Planned pause (~3s) | Unplanned delay (~5-10s, includes failed API call + compaction) |

The key insight: autocompact is a comfort measure. Reactive compact is an emergency measure. Autocompact says "we're getting close, let's clean up." Reactive compact says "we've already crashed, let's recover."

## Integration with the Query Loop

Here's how reactive compact fits into the agent's API call handling:

```typescript
async function* queryModel(
  messages: Message[],
  model: ModelId,
  state: AgentState
): AsyncGenerator<AgentEvent> {
  // Autocompact check (proactive)
  yield* autoCompactIfNeeded(messages, model, state.autocompactState);

  try {
    // Make the API call
    const response = await callAPI(messages, model);
    yield* processResponse(response);

  } catch (error) {
    if (isPromptTooLong(error)) {
      // Reactive compact (emergency)
      yield* tryReactiveCompact(messages, model, error, state);

      // Retry the API call with compacted messages
      const retryResponse = await callAPI(messages, model);
      yield* processResponse(retryResponse);

    } else {
      // Other errors — standard retry logic (Lesson 4)
      throw error;
    }
  }
}
```

The flow is: proactive check → API call → if 413, reactive compact → retry. If the retry also fails with 413, the terminal error from reactive compact ends the task.

## The collapse_drain_retry Continue Reason

When reactive compact successfully recovers via collapse draining, it uses a special continue reason to signal this to the agent loop:

```typescript
enum ContinueReason {
  TOOL_USE = "tool_use",
  AUTOCOMPACT = "autocompact",
  COLLAPSE_DRAIN_RETRY = "collapse_drain_retry",
  // ...
}
```

The `collapse_drain_retry` reason tells the loop:
1. The previous API call failed with 413
2. Staged collapses were drained to free space
3. The API call should be retried with the same intent

This is important because the retry should preserve the model's pending tool calls and reasoning — the failure was a context issue, not a logic issue. The model was in the middle of work when the 413 interrupted it.

## Preventing Repeated 413s

After a reactive compact, the agent takes extra precautions to avoid immediately hitting another 413:

```typescript
function postReactiveCompactAdjustments(state: AgentState): void {
  // Lower the autocompact threshold temporarily
  // This makes proactive compaction more aggressive,
  // reducing the chance of another 413
  state.autocompactState.temporaryThresholdReduction = 10_000;

  // Reset the circuit breaker
  // The reactive compact succeeded, so autocompact should
  // be allowed to try again
  state.autocompactState.consecutiveFailures = 0;
}
```

By temporarily lowering the autocompact threshold, the agent becomes more aggressive about proactive compaction. This means it will compact sooner on subsequent turns, providing more buffer before the hard limit.

## Real-World Frequency

In practice, reactive compact is rare when autocompact is working correctly. Statistics from production usage:

- **Autocompact fires**: ~1 in 15 conversations (any conversation with 20+ turns)
- **Reactive compact fires**: ~1 in 200 conversations (only when autocompact fails or estimation is off)
- **Terminal failure**: ~1 in 5,000 conversations (extremely rare)

The rarity of reactive compact is a testament to how well the proactive layers work. But when it does fire, it's critical — without it, 1 in 200 conversations would crash with an unrecoverable error.

## Key Takeaways

1. **Reactive compact handles 413 errors** — the emergency path when proactive measures fail
2. **Three escalation phases** — drain collapses, full compaction, terminal failure
3. **Collapse draining is the fastest recovery** — no API call needed, just apply pending reductions
4. **No circuit breaker** — reactive compact must try because it's the last resort
5. **Post-recovery adjustments** — lowers autocompact threshold to prevent recurrence
6. **Rare in practice** — fires in ~0.5% of conversations, but essential for reliability

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Reactive vs Proactive
**Question:** Compare autocompact and reactive compact across these dimensions: trigger condition, timing relative to the API call, whether a circuit breaker is used, and performance cost to the user. Why doesn't reactive compact use a circuit breaker?

[View Answer](../../answers/06-context-management/answer-62.md#exercise-1)

### Exercise 2 — Implement tryReactiveCompact
**Challenge:** Write a simplified `tryReactiveCompact` function that implements the three-phase escalation: (1) drain staged collapses, (2) full compaction, (3) terminal error. Accept `messages`, a `drainCollapses` function, a `compactConversation` function, and an `effectiveWindow` size. Return an object indicating which phase succeeded.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-62.md#exercise-2)

### Exercise 3 — Post-Recovery Adjustments
**Challenge:** Write a `postReactiveCompactAdjustments` function that lowers the autocompact threshold by a configurable amount and resets the circuit breaker. Include TypeScript types for the state object it modifies.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-62.md#exercise-3)

### Exercise 4 — Error Classification
**Question:** An API call returns HTTP 413 with `"prompt tokens: 207342, max tokens: 200000"`. Calculate how many tokens over the limit this is, what percentage overrun it represents, and explain whether draining staged collapses (typically saving 10-30K tokens) would likely be sufficient to recover.

[View Answer](../../answers/06-context-management/answer-62.md#exercise-4)

---

*Previous: [Lesson 61 — Compaction Summary](61-compaction-summary.md) · Next: [Lesson 63 — Context Collapse](63-context-collapse.md)*
