# Lesson 60: Autocompact

## Proactive Compaction

Microcompact clears individual tool results. But what happens when the conversation itself — the accumulated messages, assistant reasoning, user instructions, and remaining tool results — grows too large? Clearing a few tool results won't be enough.

Autocompact is the proactive answer. When the token count approaches the warning threshold, autocompact triggers a full conversation summarization. It replaces the entire conversation history with a compressed summary, freeing massive amounts of context space.

The key word is *proactive*. Autocompact fires before the context window is full — while there's still room to make the summarization API call itself.

## When Does It Trigger?

The decision to autocompact is made by `shouldAutoCompact()`:

```typescript
function shouldAutoCompact(
  tokenCount: number,
  model: ModelId,
  options: AutocompactOptions
): boolean {
  const effectiveWindow = getEffectiveContextWindowSize(model);
  const threshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;

  // Don't compact if we're well under the threshold
  if (tokenCount < threshold) {
    return false;
  }

  // Don't compact if context collapse is enabled and active
  // (collapse handles reduction differently — see Lesson 63)
  if (options.contextCollapseEnabled) {
    return false;
  }

  // Don't compact if we recently compacted (avoid thrashing)
  if (options.turnsSinceLastCompact < MIN_TURNS_BETWEEN_COMPACTS) {
    return false;
  }

  return true;
}
```

The threshold is the effective window minus the AUTOCOMPACT_BUFFER_TOKENS (13K). For a 200K model, that's about 171K tokens. Once the conversation exceeds this, autocompact kicks in.

Note the interaction with context collapse: when collapse is enabled, it takes priority over autocompact. We'll cover this relationship in Lesson 63.

## The Circuit Breaker

Compaction can fail. The summarization API call might time out, return an error, or produce a summary that's still too large. If compaction fails repeatedly, the agent shouldn't keep trying — it should give up and let other mechanisms handle the situation.

`autoCompactIfNeeded()` implements a circuit breaker pattern:

```typescript
const MAX_CONSECUTIVE_FAILURES = 3;

async function* autoCompactIfNeeded(
  messages: Message[],
  model: ModelId,
  state: AutocompactState
): AsyncGenerator<AgentEvent> {
  // Circuit breaker: stop after 3 consecutive failures
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    console.warn(
      "Autocompact circuit breaker open: " +
      `${state.consecutiveFailures} consecutive failures`
    );
    return;
  }

  const tokenCount = estimateTokenCount(messages);

  if (!shouldAutoCompact(tokenCount, model, state.options)) {
    return;
  }

  yield { type: "autocompact_start", tokenCount };

  try {
    // Try session memory compaction first (cheaper)
    const sessionResult = await trySessionMemoryCompact(messages, model);
    if (sessionResult.success) {
      state.consecutiveFailures = 0;
      yield { type: "autocompact_complete", method: "session_memory" };
      return;
    }

    // Fall back to full conversation compaction
    const compactResult = await compactConversation(messages, model);
    if (compactResult.success) {
      state.consecutiveFailures = 0;
      yield { type: "autocompact_complete", method: "full_compact" };
      return;
    }

    // Compaction didn't free enough space
    state.consecutiveFailures++;
    yield { type: "autocompact_insufficient" };

  } catch (error) {
    state.consecutiveFailures++;
    yield {
      type: "autocompact_error",
      error: error.message,
      consecutiveFailures: state.consecutiveFailures,
    };
  }
}
```

The circuit breaker prevents infinite compaction loops. After 3 consecutive failures, autocompact stops trying. The conversation will eventually hit the blocking limit, triggering reactive compact (Lesson 62) or context collapse (Lesson 63) as fallback strategies.

## Two-Phase Compaction Attempt

Notice the two-phase approach in the code above:

### Phase 1: Session Memory Compaction

Session memory compaction is lighter weight. It tries to compress just the session-specific memory (recent context, working state) without rewriting the entire conversation:

```typescript
async function trySessionMemoryCompact(
  messages: Message[],
  model: ModelId
): Promise<CompactResult> {
  // Extract session memory from recent messages
  const sessionMemory = extractSessionMemory(messages);

  if (!sessionMemory || sessionMemory.tokenCount < MIN_MEMORY_COMPACT_SIZE) {
    return { success: false, reason: "insufficient_session_memory" };
  }

  // Summarize just the session memory portion
  const summary = await summarizeSessionMemory(sessionMemory, model);

  // Replace the session memory block with the summary
  replaceSessionMemory(messages, summary);

  return {
    success: true,
    tokensFreed: sessionMemory.tokenCount - estimateTokenCount(summary),
  };
}
```

This is faster and cheaper than full compaction because it only summarizes a portion of the conversation. If it frees enough space, the agent continues without a full rewrite.

### Phase 2: Full Conversation Compaction

If session memory compaction isn't enough (or isn't available), the agent falls back to full compaction — summarizing the entire conversation into a compact summary. This is the heavy-duty mechanism covered in detail in Lesson 61.

```typescript
async function compactConversation(
  messages: Message[],
  model: ModelId
): Promise<CompactResult> {
  // Generate a summary of the entire conversation
  const summary = await generateCompactSummary(messages, model);

  // Replace all messages with the summary
  const newMessages = [
    createBoundaryMessage(summary),
  ];

  // Calculate savings
  const oldTokens = estimateTokenCount(messages);
  const newTokens = estimateTokenCount(newMessages);

  return {
    success: true,
    tokensFreed: oldTokens - newTokens,
    newMessages,
  };
}
```

Full compaction typically reduces context by 80-95%. A 170K-token conversation becomes a 10-20K-token summary. The trade-off is information loss — details from individual tool results and intermediate reasoning are gone, replaced by a high-level summary.

## Post-Compact Cleanup

After a successful compaction, several subsystems need to be reset:

```typescript
function postCompactCleanup(state: AgentState): void {
  // 1. Reset microcompact state
  //    Old tool results no longer exist — nothing to microcompact
  state.microcompact.reset();

  // 2. Reset classifiers
  //    Conversation changed; cached classifications are stale
  state.classifiers.reset();

  // 3. Clear session cache markers
  //    The prompt prefix changed; old cache breakpoints are invalid
  state.sessionCache.invalidate();

  // 4. Reset context collapse state
  //    Staged collapses were applied or are no longer relevant
  resetContextCollapse(state);

  // 5. Update token count
  //    Recount tokens with the new, smaller message set
  state.tokenCount = estimateTokenCount(state.messages);
}
```

Each cleanup step is important:

- **Microcompact reset**: The old messages that microcompact was tracking no longer exist. Starting fresh prevents stale references.
- **Classifier reset**: If the agent was classifying tool results or messages (e.g., for relevance scoring), those classifications are based on the old conversation and need recomputing.
- **Session cache invalidation**: Prompt caching relies on a stable prefix. After compaction, the entire prompt has changed — old cache entries are useless.
- **Context collapse reset**: Any staged collapses (Lesson 63) that were queued are either applied during compaction or no longer relevant.

## The User Experience

From the user's perspective, autocompact is nearly invisible. They might see a brief status message:

```
⟳ Compacting conversation history...
```

The agent pauses for 2-5 seconds while the summary is generated, then continues working. The model's behavior should be seamless — it has the summary of everything that happened, so it can pick up right where it left off.

But there are subtle effects. After compaction, the model may:

- Ask to re-read a file it previously read (the detailed content was lost in summarization)
- Repeat a question the user already answered (if the answer was buried in details the summary omitted)
- Lose track of nuanced decisions made earlier

Good compaction summaries minimize these issues by preserving key decisions, file modifications, and error patterns. We'll see exactly how the summary is generated in Lesson 61.

## Autocompact in the Agent Loop

Here's where autocompact fits in the main agent loop:

```typescript
async function* agentLoop(task: Task): AsyncGenerator<AgentEvent> {
  while (!task.isComplete) {
    // 1. Estimate current token usage
    const tokenCount = estimateTokenCount(task.messages);

    // 2. Proactive compaction check
    yield* autoCompactIfNeeded(task.messages, task.model, task.autocompactState);

    // 3. Apply microcompact (lightweight, every turn)
    const { messages, cacheEdits } = cachedMicroCompact(task.messages);

    // 4. Make the API call
    const response = yield* queryModel(messages, task.model, cacheEdits);

    // 5. Process response, execute tools, etc.
    yield* processResponse(response, task);
  }
}
```

Autocompact runs before each API call, right after the token count check. If compaction fires, the messages are rewritten before the API call proceeds. Microcompact then further optimizes the (possibly already compacted) messages.

## Monitoring and Observability

Autocompact emits events that the agent tracks for monitoring:

```typescript
interface AutocompactMetrics {
  totalCompactions: number;
  sessionMemoryCompactions: number;
  fullCompactions: number;
  totalTokensFreed: number;
  averageTokensFreed: number;
  circuitBreakerTrips: number;
  compactionLatencyMs: number[];
}
```

These metrics help diagnose issues:
- High `circuitBreakerTrips` suggests compaction is consistently failing — maybe the model can't generate good summaries for certain conversation patterns
- Low `averageTokensFreed` suggests compaction isn't effective — the conversation might be structured in a way that doesn't compress well
- High `compactionLatencyMs` means the user experiences noticeable pauses

## Key Takeaways

1. **Autocompact triggers proactively** — before the context window fills up, not after
2. **Circuit breaker prevents loops** — 3 consecutive failures and autocompact stops trying
3. **Two-phase approach** — try lightweight session memory compaction first, then full conversation compaction
4. **Post-compact cleanup is essential** — microcompact, classifiers, caches, and collapse state all need resetting
5. **Nearly invisible to users** — a brief pause, then the agent continues seamlessly
6. **Full compaction achieves 80-95% reduction** — at the cost of losing detailed intermediate context

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Circuit Breaker Rationale
**Question:** Why does autocompact use a circuit breaker that stops after 3 consecutive failures? What would happen without it? Why is the breaker based on *consecutive* failures rather than *total* failures?

[View Answer](../../answers/06-context-management/answer-60.md#exercise-1)

### Exercise 2 — Implement shouldAutoCompact
**Challenge:** Write the `shouldAutoCompact` function that takes `tokenCount`, `modelContextWindow`, `maxOutputTokens`, and an options object with `contextCollapseEnabled` and `turnsSinceLastCompact`. Use `AUTOCOMPACT_BUFFER_TOKENS = 13_000` and `MIN_TURNS_BETWEEN_COMPACTS = 3`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-60.md#exercise-2)

### Exercise 3 — Circuit Breaker Class
**Challenge:** Implement a generic `CircuitBreaker` class with `maxFailures`, `recordSuccess()`, `recordFailure()`, and `isOpen()` methods. Then show how it would be used by `autoCompactIfNeeded`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-60.md#exercise-3)

### Exercise 4 — Post-Compact Cleanup
**Question:** After a successful compaction, why must the microcompact state, classifiers, session cache, and context collapse state all be reset? What specific bugs would occur if each one was accidentally skipped?

[View Answer](../../answers/06-context-management/answer-60.md#exercise-4)

---

*Previous: [Lesson 59 — Microcompact](59-microcompact.md) · Next: [Lesson 61 — Compaction Summary](61-compaction-summary.md)*
