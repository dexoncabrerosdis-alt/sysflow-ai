# Answers: Lesson 16 — Loop State Management

## Exercise 1
**Question:** Explain the purpose of `autoCompactTracking`, `maxOutputTokensRecoveryCount`, and `hasAttemptedReactiveCompact`.

**Answer:**

**`autoCompactTracking`** — Supports automatic context compaction. It tracks when compaction last happened (`lastCompactedAt`) and how many tokens have been consumed since (`tokensSinceLastCompact`). When the token count exceeds a threshold, the loop calls the model to summarize old messages. Without this field, the loop would have no way to know when to compact — it would either compact every iteration (wasteful) or never compact (eventually hitting the context window limit).

**`maxOutputTokensRecoveryCount`** — Supports output truncation recovery. When the model hits its output token limit mid-response, the loop asks it to continue. This counter tracks how many recovery attempts have been made. Without it, recovery could loop infinitely: model hits limit → recovery → hits limit again → recovery → forever. The counter caps recovery attempts (typically at 3), after which the loop escalates to a larger model or terminates.

**`hasAttemptedReactiveCompact`** — Supports emergency compaction. Unlike auto-compaction (proactive, threshold-based), reactive compaction is a last resort when the context window is about to overflow. This boolean flag ensures the loop only tries reactive compaction once. Without it, the loop could enter a cycle: context too large → compact → still too large → compact → same result → forever. The flag forces termination with `prompt_too_long` if one compaction attempt isn't enough.

---

## Exercise 2
**Question:** Give the three reasons for immutable state with examples.

**Answer:**

**1. Predictability** — At any point during an iteration, `state` reflects the state at the *start* of this iteration. Example: if you check `state.turnCount` at the beginning and end of the iteration body, you get the same value. With mutation, `state.turnCount++` at the top would mean later code sees the incremented value, making it ambiguous whether "current turn" means the old or new count.

**2. Debugging** — You can compare old and new state to understand what changed. Example: `console.log("before:", state, "after:", nextState)` shows exactly which fields changed. With mutation, the old state is overwritten — by the time you inspect it after a bug, the original values are gone. This makes post-mortem debugging of "why did the loop stop on turn 7?" nearly impossible.

**3. Explicit Transitions** — Building the next state as a single expression makes all dependencies visible. Example: `nextState.remainingBudgetTokens = deductTokens(state.remainingBudgetTokens, tokensUsed)` clearly shows the budget depends on both the old budget and tokens used this turn. With scattered mutations like `state.budget -= tokensUsed` placed anywhere in the loop body, it's hard to see all the ways state changes or ensure they happen in the right order.

---

## Exercise 3
**Challenge:** Build an immutable state loop that processes a queue.

**Answer:**
```typescript
type State = {
  items: string[];
  processed: number;
  errors: string[];
};

function processQueue(initialItems: string[]): State {
  let state: State = {
    items: initialItems,
    processed: 0,
    errors: [],
  };

  while (state.items.length > 0) {
    const [current, ...remaining] = state.items;

    const isError = current.includes("bad");

    // Build next state as a new object — never mutate
    const nextState: State = {
      items: remaining,
      processed: state.processed + 1,
      errors: isError
        ? [...state.errors, current]
        : state.errors,
    };

    console.log(
      `Processed "${current}" | ` +
      `remaining: ${nextState.items.length} | ` +
      `errors: ${nextState.errors.length}`
    );

    state = nextState;
  }

  return state;
}

const result = processQueue(["good-1", "bad-item", "good-2", "bad-thing", "good-3"]);
// result = { items: [], processed: 5, errors: ["bad-item", "bad-thing"] }
```

**Explanation:** Each iteration destructures the first item from the queue, builds a completely new `State` object with the remaining items and updated counters, then replaces `state` with `nextState`. The old state is never modified. You can verify this by logging `state` at any point — it always reflects the start of the current iteration.

---

## Exercise 4
**Challenge:** Trace state transitions for a 3-iteration task.

**Answer:**
```
=== Start of Iteration 1 ===
State: {
  messages: [{ role: "user", content: "Fix the auth bug" }],
  turnCount: 0,
  remainingBudgetTokens: 10000,
  autoCompactTracking: { lastCompactedAt: 0, tokensSinceLastCompact: 0 },
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
}
→ Model calls read_file("src/auth.ts") — uses 2,000 tokens

=== Start of Iteration 2 ===
State: {
  messages: [user, assistant(read_file), tool_result(file contents)],
  turnCount: 1,
  remainingBudgetTokens: 8000,        // 10000 - 2000
  autoCompactTracking: { lastCompactedAt: 0, tokensSinceLastCompact: 2000 },
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
}
→ Model calls write_file("src/auth.ts", fixedCode) — uses 1,500 tokens

=== Start of Iteration 3 ===
State: {
  messages: [user, assistant(read), tool_result, assistant(write), tool_result(ok)],
  turnCount: 2,
  remainingBudgetTokens: 6500,        // 8000 - 1500
  autoCompactTracking: { lastCompactedAt: 0, tokensSinceLastCompact: 3500 },
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
}
→ Model responds with text "I've fixed the bug..." — uses 800 tokens
→ Terminal: { reason: "completed" }

Final budget: 5700 tokens remaining (10000 - 2000 - 1500 - 800)
```

**Explanation:** Each iteration reads the current state, performs work, and builds the next state. The `turnCount` increments by 1, `remainingBudgetTokens` decreases by tokens used, and `tokensSinceLastCompact` accumulates. Messages grow with each assistant response and tool result.

---

## Exercise 5
**Question:** What production problems does immutable state solve that `messages.push()` doesn't?

**Answer:** Three specific production problems:

**1. Mid-iteration consistency.** With `push()`, the messages array changes throughout the iteration. If code early in the iteration counted `messages.length` and code later in the same iteration read it again, the count would differ. This causes subtle bugs in token estimation (calculated before tools run but checked after), compaction decisions, and logging. Immutable state guarantees consistency: `state.messages.length` returns the same value no matter where in the iteration you read it.

**2. Compaction safety.** When the loop decides to compact messages, it needs to replace old messages with a summary. With `push()`, the array is shared — any reference to the old messages array now points to the compacted version, potentially breaking in-flight tool operations that were holding a reference. With immutable state, compacted messages go into `nextState.messages`, leaving the current iteration's `state.messages` untouched until the explicit `state = nextState` swap.

**3. Error recovery.** When something fails mid-iteration (tool crash, API error), the loop may need to retry the iteration. With mutation, the state is partially updated — some fields reflect the new iteration, others reflect the old one. With immutable state, the current `state` is unchanged by the failed work, so retrying simply means calling the model again with the same `state`. No rollback logic is needed because nothing was modified.
