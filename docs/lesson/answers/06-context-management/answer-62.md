# Answers: Lesson 62 — Reactive Compact

## Exercise 1
**Question:** Compare autocompact and reactive compact across four dimensions.

**Answer:** **Trigger:** Autocompact triggers when token count exceeds the warning threshold (~171K for a 200K model). Reactive compact triggers when the API returns a 413 error. **Timing:** Autocompact runs *before* the API call (proactive). Reactive compact runs *after* the API call fails (reactive). **Circuit breaker:** Autocompact has one (stops after 3 consecutive failures). Reactive compact does not — because it's the last resort. If reactive compact gave up, the agent would be stuck in an unrecoverable state with no way to continue. It *must* attempt recovery. **User cost:** Autocompact is a planned ~3-second pause. Reactive compact costs ~5-10 seconds because it includes the time for the failed API call plus the recovery compaction.

---

## Exercise 2
**Challenge:** Write a simplified `tryReactiveCompact` function.

**Answer:**

```typescript
interface ReactiveCompactResult {
  recovered: boolean;
  phase: "collapse_drain" | "full_compact" | "terminal";
  tokensFreed: number;
}

async function tryReactiveCompact(
  messages: Message[],
  drainCollapses: (msgs: Message[]) => { tokensFreed: number },
  compactConversation: (msgs: Message[]) => Promise<{ success: boolean; newMessages: Message[]; tokensFreed: number }>,
  effectiveWindow: number,
  estimateTokens: (msgs: Message[]) => number
): Promise<ReactiveCompactResult> {
  // Phase 1: Drain staged collapses
  const drainResult = drainCollapses(messages);
  if (drainResult.tokensFreed > 0) {
    const newCount = estimateTokens(messages);
    if (newCount < effectiveWindow) {
      return { recovered: true, phase: "collapse_drain", tokensFreed: drainResult.tokensFreed };
    }
  }

  // Phase 2: Full compaction
  try {
    const compactResult = await compactConversation(messages);
    if (compactResult.success) {
      messages.length = 0;
      messages.push(...compactResult.newMessages);
      return { recovered: true, phase: "full_compact", tokensFreed: compactResult.tokensFreed };
    }
  } catch (error) {
    // Fall through to terminal
  }

  // Phase 3: Terminal failure
  return { recovered: false, phase: "terminal", tokensFreed: 0 };
}
```

**Explanation:** The function follows the escalation chain. Phase 1 is fast (no API call). Phase 2 summarizes the full conversation. Phase 3 signals that recovery is impossible. The caller should throw a terminal error if phase 3 is reached.

---

## Exercise 3
**Challenge:** Write a `postReactiveCompactAdjustments` function.

**Answer:**

```typescript
interface AutocompactState {
  consecutiveFailures: number;
  temporaryThresholdReduction: number;
  baseThreshold: number;
}

interface AgentState {
  autocompact: AutocompactState;
}

function postReactiveCompactAdjustments(
  state: AgentState,
  thresholdReduction: number = 10_000
): void {
  // Lower the threshold to trigger autocompact sooner on subsequent turns
  state.autocompact.temporaryThresholdReduction = thresholdReduction;

  // Reset the circuit breaker so autocompact can try again
  state.autocompact.consecutiveFailures = 0;
}

function getEffectiveAutocompactThreshold(state: AutocompactState): number {
  return state.baseThreshold - state.temporaryThresholdReduction;
}
```

**Explanation:** After a 413 recovery, lowering the autocompact threshold makes proactive compaction more aggressive — it will fire sooner on the next turn, providing a bigger buffer before the hard limit. Resetting the circuit breaker ensures autocompact is allowed to try again even if it had previously failed.

---

## Exercise 4
**Question:** Analyze the 413 error with prompt tokens 207,342 and max tokens 200,000.

**Answer:** The overrun is `207,342 - 200,000 = 7,342` tokens, which is a 3.7% overrun. Since draining staged collapses typically saves 10-30K tokens, this would very likely be sufficient — even the low end (10K) exceeds the 7.3K overrun by a comfortable margin. This is the ideal scenario for Phase 1 recovery: a small estimation error pushed the prompt just past the limit, and pre-staged collapses can quickly bring it back under without needing a full compaction.
