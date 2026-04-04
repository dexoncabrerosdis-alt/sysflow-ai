# Answers: Lesson 18 — Turn Counting and Limits

## Exercise 1
**Question:** List the five layers of limits from most specific to most general.

**Answer:**

**Layer 1: Recovery limits** (most specific) — `maxOutputTokensRecoveryCount` and `hasAttemptedReactiveCompact`. These catch infinite retry loops for specific failure modes. Without them, the loop could endlessly retry output recovery or compaction, never making progress. The previous layers don't exist yet at this level — these are the first line of defense against loop-within-a-loop problems.

**Layer 2: Pre-API token check** — Estimates whether the messages fit in the context window before making the API call. Catches cases where the conversation has grown too large. Recovery limits don't cover this because the problem isn't a retry — it's that the conversation is simply too big. Without this, the loop would waste an API call that would fail anyway, costing money and time.

**Layer 3: Token budget** — Limits total API spend across all iterations. Catches expensive tasks where individual calls are fine but cumulative cost is high (e.g., 50 turns of moderate token usage). Pre-API checks only look at the current call's feasibility, not the cumulative cost. Without budgets, a task could consume an entire account's allocation through many individually-reasonable calls.

**Layer 4: Turn limit** — `maxTurns` caps the total number of iterations. Catches cases where each turn is cheap (small token usage, small context) but the model is confused and looping without making progress. Token budgets wouldn't catch this because each turn barely costs anything. Without turn limits, a loop making 1,000 tiny API calls would run forever.

**Layer 5: User interruption** (most general) — Ctrl+C / abort. The human always has final authority. Catches everything else — cases where the agent is technically within all limits but the human can see it's doing the wrong thing. No automated limit can replace human judgment for recognizing "this isn't what I asked for."

---

## Exercise 2
**Challenge:** Write a loop with token budget tracking using immutable state.

**Answer:**
```typescript
type State = {
  turnCount: number;
  remainingBudgetTokens: number;
  totalTokensUsed: number;
};

function simulateApiCall(): number {
  return Math.floor(Math.random() * 1501) + 500; // 500–2000 tokens
}

function runBudgetedLoop(initialBudget: number): State {
  let state: State = {
    turnCount: 0,
    remainingBudgetTokens: initialBudget,
    totalTokensUsed: 0,
  };

  while (state.remainingBudgetTokens > 0) {
    const tokensUsed = simulateApiCall();

    const nextState: State = {
      turnCount: state.turnCount + 1,
      remainingBudgetTokens: state.remainingBudgetTokens - tokensUsed,
      totalTokensUsed: state.totalTokensUsed + tokensUsed,
    };

    console.log(
      `Turn ${nextState.turnCount}: used ${tokensUsed} tokens | ` +
      `remaining: ${Math.max(0, nextState.remainingBudgetTokens)} | ` +
      `total: ${nextState.totalTokensUsed}`
    );

    state = nextState;
  }

  console.log(`\nBudget exhausted after ${state.turnCount} turns.`);
  console.log(`Total tokens used: ${state.totalTokensUsed} of ${initialBudget}`);
  return state;
}

runBudgetedLoop(10000);
// Example output:
// Turn 1: used 1247 tokens | remaining: 8753 | total: 1247
// Turn 2: used 892 tokens | remaining: 7861 | total: 2139
// ...
// Turn 8: used 1654 tokens | remaining: 0 | total: 10382
// Budget exhausted after 8 turns.
```

**Explanation:** Each iteration simulates an API call, deducts tokens from the budget, and builds a new state. The loop stops when `remainingBudgetTokens` drops to zero or below. The immutable pattern ensures `state.remainingBudgetTokens` reflects the pre-deduction value throughout the iteration body.

---

## Exercise 3
**Question:** Which limit catches each case, and why do you need both?

**Answer:**

**Task A (3 turns, 150,000 tokens):** The **token budget** catches this. With only 3 turns, the turn limit (default 100) is nowhere close. But reading huge files means each API call consumes massive input tokens. A token budget of, say, 50,000 would stop this at turn 2. The turn limit is useless here — 3 turns seems perfectly reasonable.

**Task B (45 turns, 8,000 tokens):** The **turn limit** catches this — if the model is confused and looping at turn 45 with no progress, `maxTurns = 50` will stop it soon. The token budget won't help because 8,000 tokens is tiny — well within any reasonable budget. Each turn costs almost nothing, but the model is wasting time, not money.

You need both because they measure orthogonal dimensions of "too much." Token budget measures **cost** (how much money is being spent). Turn limit measures **time/progress** (how many decision cycles have passed). A task can be cheap but endless (many tiny turns) or expensive but short (few huge turns). Neither limit alone covers both failure modes.

---

## Exercise 4
**Challenge:** Write a `checkTokenLimit` function.

**Answer:**
```typescript
type TokenCheckResult = {
  fits: boolean;
  estimated: number;
  available: number;
};

function checkTokenLimit(
  messages: Array<{ role: string; content: string | object }>,
  modelContextWindow: number,
  reservedForOutput: number
): TokenCheckResult {
  const estimateTokens = (content: string | object): number => {
    const text = typeof content === "string"
      ? content
      : JSON.stringify(content);
    return Math.ceil(text.length / 4);
  };

  const estimated = messages.reduce(
    (total, msg) => total + estimateTokens(msg.content) + 4, // +4 for role/formatting overhead
    0
  );

  const available = modelContextWindow - reservedForOutput;

  return {
    fits: estimated <= available,
    estimated,
    available,
  };
}

// Usage
const result = checkTokenLimit(
  [
    { role: "user", content: "Fix the auth bug" },
    { role: "assistant", content: "Let me read the file..." },
    { role: "user", content: "x".repeat(800000) }, // Huge tool result
  ],
  200000,
  4096
);

// result = { fits: false, estimated: ~200016, available: 195904 }
```

**Explanation:** The function estimates tokens using the rough `chars / 4` heuristic (real tokenizers are more precise but expensive to run). It adds a small overhead per message for role formatting. The `available` space is the context window minus the reserved output space — there's no point filling the entire context window because the model needs room to generate a response. Returning an object (not just a boolean) lets callers log the numbers for debugging.

---

## Exercise 5
**Question:** Calculate the cost with and without limits, and explain why this matters more for automated workflows.

**Answer:**

**Without limits:** 847 turns × $0.015/turn = **$12.71** wasted on a task accomplishing nothing.

**With limits (maxTurns = 50):** 50 turns × $0.015/turn = **$0.75** — the loop stops early, the user is notified, and the damage is contained to 6% of the unlimited cost.

**Savings:** $11.96 per incident, or a 94% cost reduction.

**Why this matters more for automated workflows:**

In interactive use, a human is watching. They'd likely notice after 5-10 turns that the agent is stuck and press Ctrl+C — the human is layer 5 (user interruption). The automated limits are a safety net but rarely the primary defense.

In automated workflows (CI pipelines, batch processing, scheduled tasks), **there is no human watching**. Hundreds of tasks might run overnight or in parallel across PRs. A single confused task without limits could: (1) consume the entire API budget allocated for the batch, (2) block other tasks waiting for the same resource, (3) go unnoticed until the morning when someone checks the bill. With `maxTurns` and token budgets, each task self-limits. Even if 10 out of 100 tasks go haywire, each is capped at $0.75 instead of running unchecked. The limits are the *only* defense in unattended execution — there's no human layer 5 to catch problems.
