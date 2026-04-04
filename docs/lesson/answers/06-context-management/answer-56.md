# Answers: Lesson 56 — Why Context Matters

## Exercise 1
**Question:** Using the desk analogy from this lesson, explain what happens when an agent reads 10 files, edits 5 of them, and then needs to read 3 more files — but context is 90% full. Which context management strategies would apply and in what order?

**Answer:** At 90% capacity, the desk is nearly covered. The agent has 10 file-read results plus 5 edit results taking up space. First, microcompact would fire, clearing the content of old tool results (the initial file reads whose content is now stale after edits). If that's insufficient, autocompact would trigger at the warning threshold, summarizing the entire conversation into a compact overview. Only then would the agent have room to read the 3 new files. This mirrors the "summarize several documents into one page" option from the desk analogy — you condense old notes to make room for new ones.

---

## Exercise 2
**Challenge:** Write a TypeScript function that takes a list of tool results (each with a `type` and `tokenCount`) and a `maxContextTokens` budget, and returns an object reporting: total tokens used, remaining budget, and a boolean `isOverBudget`. Include the system prompt overhead as a constant of 3000 tokens.

**Answer:**

```typescript
const SYSTEM_PROMPT_TOKENS = 3000;

interface ToolResult {
  type: string;
  tokenCount: number;
}

interface BudgetReport {
  totalTokensUsed: number;
  remainingBudget: number;
  isOverBudget: boolean;
}

function calculateContextBudget(
  toolResults: ToolResult[],
  maxContextTokens: number
): BudgetReport {
  const toolTokens = toolResults.reduce(
    (sum, result) => sum + result.tokenCount,
    0
  );
  const totalTokensUsed = SYSTEM_PROMPT_TOKENS + toolTokens;
  const remainingBudget = maxContextTokens - totalTokensUsed;

  return {
    totalTokensUsed,
    remainingBudget,
    isOverBudget: remainingBudget < 0,
  };
}
```

**Explanation:** The function sums all tool result tokens, adds the fixed system prompt overhead, and compares against the budget. The `isOverBudget` flag lets callers quickly determine whether context management needs to intervene.

---

## Exercise 3
**Challenge:** Write a function `projectCosts(turns: number, avgTokensPerTurn: number, compactionAt: number)` that computes the total cost of a conversation with and without compaction.

**Answer:**

```typescript
function projectCosts(
  turns: number,
  avgTokensPerTurn: number,
  compactionAt: number
): { withoutCompaction: number; withCompaction: number; savings: number } {
  const costPer1KTokens = 0.002;
  let withoutTotal = 0;
  let withTotal = 0;

  let cumulativeTokens = 0;
  let compactedTokens = 0;

  for (let turn = 1; turn <= turns; turn++) {
    cumulativeTokens += avgTokensPerTurn;
    withoutTotal += (cumulativeTokens / 1000) * costPer1KTokens;

    compactedTokens += avgTokensPerTurn;
    if (turn === compactionAt) {
      compactedTokens = Math.round(compactedTokens * 0.15);
    }
    withTotal += (compactedTokens / 1000) * costPer1KTokens;
  }

  return {
    withoutCompaction: Math.round(withoutTotal * 100) / 100,
    withCompaction: Math.round(withTotal * 100) / 100,
    savings: Math.round((withoutTotal - withTotal) * 100) / 100,
  };
}
```

**Explanation:** The function accumulates tokens per turn. Without compaction, the cumulative count grows linearly. With compaction, at the specified turn the context drops to 15% of its size. Each turn's cost is proportional to the total tokens at that point. The savings demonstrate why compaction is critical for long conversations.

---

## Exercise 4
**Question:** A user reports that their agent "keeps repeating the same file edits and going in circles" during a long refactoring task. Which of the three failure modes described in this lesson is most likely the cause, and why?

**Answer:** This is the "Degraded Output Quality" (soft failure) mode. When context grows very large, the model suffers from the "lost in the middle" problem — it forgets instructions and loses track of which files it already edited. The repeated edits indicate the model can no longer see or recall its earlier work buried deep in the context. Autocompact (Layer 5) would most directly address this by summarizing the conversation, including a list of completed edits, so the model has a clear record of what's done and what remains.
