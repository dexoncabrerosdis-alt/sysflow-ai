# Answers: Lesson 60 — Autocompact

## Exercise 1
**Question:** Why does autocompact use a circuit breaker that stops after 3 consecutive failures?

**Answer:** Without a circuit breaker, autocompact would retry compaction on every turn once the warning threshold is hit. If compaction consistently fails (e.g., the summarization model is down or the conversation can't be compressed enough), the agent would waste an API call on compaction every turn — adding latency and cost while never succeeding. The breaker uses *consecutive* failures rather than total failures because a single success proves compaction can work for this conversation. A past failure followed by success means the issue was transient; the counter resets. Using total failures would permanently disable compaction after any 3 failures across the entire session, even if they were spaced far apart and caused by unrelated transient issues.

---

## Exercise 2
**Challenge:** Write the `shouldAutoCompact` function.

**Answer:**

```typescript
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const MIN_TURNS_BETWEEN_COMPACTS = 3;

interface AutocompactOptions {
  contextCollapseEnabled: boolean;
  turnsSinceLastCompact: number;
}

function shouldAutoCompact(
  tokenCount: number,
  modelContextWindow: number,
  maxOutputTokens: number,
  options: AutocompactOptions
): boolean {
  const effectiveWindow = modelContextWindow - maxOutputTokens;
  const threshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;

  if (tokenCount < threshold) {
    return false;
  }

  if (options.contextCollapseEnabled) {
    return false;
  }

  if (options.turnsSinceLastCompact < MIN_TURNS_BETWEEN_COMPACTS) {
    return false;
  }

  return true;
}
```

**Explanation:** The function applies three guards: (1) don't compact if under the threshold, (2) defer to context collapse if it's enabled, (3) don't compact if we recently compacted (prevents thrashing). Only when all three pass does compaction proceed.

---

## Exercise 3
**Challenge:** Implement a generic `CircuitBreaker` class.

**Answer:**

```typescript
class CircuitBreaker {
  private maxFailures: number;
  private consecutiveFailures: number = 0;

  constructor(maxFailures: number) {
    this.maxFailures = maxFailures;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
  }

  isOpen(): boolean {
    return this.consecutiveFailures >= this.maxFailures;
  }

  reset(): void {
    this.consecutiveFailures = 0;
  }
}

// Usage in autoCompactIfNeeded:
const compactBreaker = new CircuitBreaker(3);

async function autoCompactIfNeeded(messages: Message[]): Promise<boolean> {
  if (compactBreaker.isOpen()) {
    console.warn("Autocompact circuit breaker open — skipping");
    return false;
  }

  try {
    const result = await compactConversation(messages);
    if (result.success) {
      compactBreaker.recordSuccess();
      return true;
    }
    compactBreaker.recordFailure();
    return false;
  } catch (error) {
    compactBreaker.recordFailure();
    return false;
  }
}
```

**Explanation:** The `CircuitBreaker` class is a reusable pattern. `isOpen()` returns true when the failure threshold is reached, signaling the caller to skip the operation. `recordSuccess` resets the counter, allowing the breaker to close after recovery.

---

## Exercise 4
**Question:** After a successful compaction, why must all subsystem states be reset?

**Answer:** **Microcompact state**: It tracks which tool results to clear by their message indices. After compaction, old messages no longer exist — the indices would point to wrong messages or be out of bounds, causing crashes or clearing the wrong content. **Classifiers**: They cache classifications (e.g., relevance scores) keyed to specific messages. The old messages are gone, so cached classifications would reference nonexistent data and potentially misclassify the new summary. **Session cache**: Prompt caching relies on a stable prefix. Compaction completely rewrites the prompt content, so old cache breakpoints no longer match — the agent would send cache-control headers for offsets that don't correspond to the new content, causing cache misses or errors. **Context collapse state**: Staged collapses reference specific message index ranges. After compaction, the entire message array was replaced with a single summary message, so those staged ranges are invalid and attempting to drain them would corrupt the conversation.
