# Answers: Lesson 57 — Token Budgets and Limits

## Exercise 1
**Question:** For a model with a 128K context window and 8K max output tokens, calculate the effective window size, the usable input budget (after the 13K safety buffer), and the token count that would trigger the "blocking" state.

**Answer:** The effective window is `128,000 - 8,000 = 120,000` tokens. The usable input budget (warning threshold) is `120,000 - 13,000 = 107,000` tokens. The blocking state triggers when tokens reach or exceed the effective window of 120,000. So: anything below 107K is "ok," between 107K and 120K is "warning" (triggers autocompact), and at or above 120K is "blocking" (don't call the API).

---

## Exercise 2
**Challenge:** Implement the `calculateTokenWarningState` function from scratch.

**Answer:**

```typescript
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

interface TokenWarningState {
  level: "ok" | "warning" | "blocking";
  isAtBlockingLimit: boolean;
  tokenCount: number;
  effectiveWindow: number;
  warningThreshold: number;
}

function calculateTokenWarningState(
  tokenCount: number,
  contextWindowSize: number,
  maxOutputTokens: number
): TokenWarningState {
  const effectiveWindow = contextWindowSize - maxOutputTokens;
  const warningThreshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;

  if (tokenCount >= effectiveWindow) {
    return {
      level: "blocking",
      isAtBlockingLimit: true,
      tokenCount,
      effectiveWindow,
      warningThreshold,
    };
  }

  if (tokenCount >= warningThreshold) {
    return {
      level: "warning",
      isAtBlockingLimit: false,
      tokenCount,
      effectiveWindow,
      warningThreshold,
    };
  }

  return {
    level: "ok",
    isAtBlockingLimit: false,
    tokenCount,
    effectiveWindow,
    warningThreshold,
  };
}
```

**Explanation:** The function computes two thresholds from the model's parameters: the effective window (hard stop) and the warning threshold (proactive compaction trigger). It compares the current token count against both thresholds in order from most severe to least, returning the appropriate state.

---

## Exercise 3
**Challenge:** Write a `TaskBudgetTracker` class that tracks cumulative token usage across API calls.

**Answer:**

```typescript
class TaskBudgetTracker {
  private maxTokens: number;
  private tokensUsed: number = 0;
  private callCount: number = 0;

  constructor(maxTokens: number) {
    this.maxTokens = maxTokens;
  }

  recordUsage(inputTokens: number, outputTokens: number): void {
    this.tokensUsed += inputTokens + outputTokens;
    this.callCount++;
  }

  getRemainingBudget(): number {
    return Math.max(0, this.maxTokens - this.tokensUsed);
  }

  isExhausted(): boolean {
    return this.tokensUsed >= this.maxTokens;
  }

  getStats(): { tokensUsed: number; callCount: number; remaining: number } {
    return {
      tokensUsed: this.tokensUsed,
      callCount: this.callCount,
      remaining: this.getRemainingBudget(),
    };
  }
}
```

**Explanation:** The class accumulates both input and output tokens per call. `getRemainingBudget` returns 0 if the budget is exceeded (never negative). `isExhausted` provides a quick boolean check for the agent loop to decide whether to continue or stop.

---

## Exercise 4
**Question:** Explain why the three budgets form a hierarchy. What would go wrong if you only checked the task budget and ignored the per-request limits?

**Answer:** The three budgets operate at different granularities: the usable window limits a single request's input size, the effective window is the absolute per-request ceiling, and the task budget limits total cumulative usage. If you only checked the task budget, individual requests could exceed the context window and trigger 413 errors, even though you had remaining task budget. A task with a 1M token budget could still fail on turn 5 if a single request tried to send 250K tokens to a model with a 200K window. Each budget protects against a different failure: per-request budgets prevent API rejections, while the task budget prevents runaway cost accumulation.
