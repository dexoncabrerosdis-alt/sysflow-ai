# Lesson 58: Tool Result Budgets

## The First Line of Defense

Before context management strategies like compaction or summarization come into play, there's a simpler question: *how big should each tool result be in the first place?*

A single `grep` across a large codebase could return megabytes of matches. Reading a minified JavaScript bundle could dump 500K characters into context. Without limits, one bad tool call can fill the entire context window in a single turn.

Tool result budgets are the first line of defense. They cap the size of each individual tool result before it enters the conversation history.

## Per-Tool Size Limits

Each tool has a `maxResultSizeChars` limit — the maximum number of characters allowed in its result. These limits are tuned per tool based on how much output that tool typically produces and how useful large results are:

```typescript
const TOOL_RESULT_LIMITS: Record<string, number> = {
  // File editing can produce large diffs — generous limit
  FileEdit:       100_000,

  // Search results beyond a point aren't useful
  Grep:            20_000,
  Glob:            20_000,

  // Shell output can be huge (build logs, test output)
  Shell:           30_000,

  // File reading has no character cap here — bounded by
  // line limits and file-size checks elsewhere
  FileRead:        Infinity,

  // Web fetch results are capped separately
  WebFetch:        50_000,

  // Default for tools without a specific limit
  DEFAULT:         30_000,
};
```

Why different limits per tool?

- **FileEdit (100K)**: Edit results include the diff and surrounding context. Large refactors across many lines need room to show what changed. Truncating a diff makes it useless.
- **Grep (20K)**: Search results have diminishing returns. If grep returns 500 matches, the first 20-50 are usually enough to understand the pattern. The rest are noise.
- **FileRead (Infinity)**: File reads are controlled at a different layer — the tool itself limits how many lines it returns. No character cap is needed here.
- **Shell (30K)**: Build output and test results can be enormous, but the useful information (errors, failures) is usually near the end. The budget is moderate, and truncation preserves the tail.

## Applying the Budget

The `applyToolResultBudget` function enforces these limits:

```typescript
function applyToolResultBudget(
  toolName: string,
  result: string
): { content: string; wasTruncated: boolean } {
  const maxChars = TOOL_RESULT_LIMITS[toolName] ?? TOOL_RESULT_LIMITS.DEFAULT;

  if (maxChars === Infinity || result.length <= maxChars) {
    return { content: result, wasTruncated: false };
  }

  // Truncate and add a notice
  const truncated = result.slice(0, maxChars);
  const notice = `\n\n[Result truncated: showing ${maxChars.toLocaleString()} of ${result.length.toLocaleString()} characters]`;

  return {
    content: truncated + notice,
    wasTruncated: true,
  };
}
```

The function is simple: check the limit, truncate if needed, append a notice so the model knows the result was cut short. The model can then decide whether it needs to refine its search or read a specific section.

## The Tool Result Processing Pipeline

Tool results don't go directly from tool execution into the conversation. They pass through a processing pipeline:

```
Tool executes
     │
     ▼
┌──────────────────┐
│ Raw tool output   │  (could be megabytes)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ processToolResult │  Format, clean, normalize
│ Block()           │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ applyToolResult   │  Apply character budget
│ Budget()          │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ addToolResult()   │  Insert into conversation messages
└────────┬─────────┘
         │
         ▼
  Message history
```

Let's trace through a concrete example. The agent runs a grep search:

```typescript
// 1. Tool executes — returns raw output
const rawResult = await grepTool.execute({
  pattern: "useState",
  path: "./src",
});
// rawResult might be 85,000 characters (hundreds of matches)

// 2. Process the result block — format for display
const processed = processToolResultBlock(rawResult);
// Adds line numbers, formats paths, etc.

// 3. Apply the budget — cap at 20K chars
const budgeted = applyToolResultBudget("Grep", processed);
// budgeted.content is 20,000 chars + truncation notice
// budgeted.wasTruncated is true

// 4. Add to conversation
addToolResult(messages, toolCallId, budgeted.content);
```

After step 3, the 85K-character grep result is reduced to 20K characters. The model sees the first ~20K characters of matches plus a notice that results were truncated. This is usually enough — the model can refine its search if it needs more specific results.

## Persisting Large Results to Disk

When a tool result exceeds the budget, Claude Code doesn't just throw away the excess. Large results are persisted to disk under the session directory:

```typescript
async function persistLargeResult(
  sessionId: string,
  toolCallId: string,
  fullResult: string
): Promise<string> {
  const resultPath = path.join(
    getSessionDir(sessionId),
    "tool-results",
    `${toolCallId}.txt`
  );

  await fs.writeFile(resultPath, fullResult, "utf-8");
  return resultPath;
}
```

The full result is saved to `session/tool-results/<toolCallId>.txt`. This means:

- The context only contains the truncated version (within budget)
- The full result is available on disk if the agent needs it later
- The agent can re-read specific portions using file read tools

```
Context (20K chars):
  "Found 342 matches for 'useState' in ./src
   src/components/App.tsx:15: const [count, setCount] = useState(0)
   src/components/App.tsx:23: const [name, setName] = useState('')
   ... (300+ more matches) ...
   [Result truncated: showing 20,000 of 85,000 characters.
    Full result saved to session/tool-results/call_abc123.txt]"

Disk (85K chars):
  session/tool-results/call_abc123.txt → full grep output
```

This is the "virtual memory" pattern from Lesson 56 — overflow goes to a slower storage tier (disk) while the fast tier (context) stays within budget.

## Preview Tags for Truncated Content

When results are truncated, Claude Code sometimes wraps them in preview tags to signal to the model that it's seeing a partial view:

```typescript
function formatTruncatedResult(
  content: string,
  totalSize: number,
  maxSize: number
): string {
  return [
    `<preview maxChars="${maxSize}" totalChars="${totalSize}">`,
    content,
    `</preview>`,
    `[Showing first ${maxSize} of ${totalSize} characters. `,
    `Use more specific queries to narrow results.]`,
  ].join("\n");
}
```

The `<preview>` tag tells the model two things:
1. This is not the complete result
2. Here's how much was omitted

The model can use this information to decide its next action. If it sees `totalChars="85000"` from a grep, it knows the search was too broad and it should add more specific filters.

## Truncation Strategies: Head vs. Tail

Not all truncation is equal. Different tools benefit from different truncation strategies:

```typescript
type TruncationStrategy = "head" | "tail" | "head_and_tail";

function truncateResult(
  result: string,
  maxChars: number,
  strategy: TruncationStrategy
): string {
  if (result.length <= maxChars) return result;

  switch (strategy) {
    case "head":
      // Keep the beginning (good for search results, file reads)
      return result.slice(0, maxChars);

    case "tail":
      // Keep the end (good for build output, error logs)
      return result.slice(-maxChars);

    case "head_and_tail":
      // Keep both ends (good for long file reads)
      const halfBudget = Math.floor(maxChars / 2);
      const head = result.slice(0, halfBudget);
      const tail = result.slice(-halfBudget);
      return head + "\n\n[... middle truncated ...]\n\n" + tail;
  }
}
```

- **Head truncation**: Keep the beginning. Best for search results where the first matches are most relevant.
- **Tail truncation**: Keep the end. Best for build/test output where errors appear at the bottom.
- **Head-and-tail**: Keep both ends. Best for reading large files where the imports (top) and exports (bottom) are both important.

## GrowthBook Feature Flag Overrides

Tool result limits aren't hardcoded constants — they're tunable via feature flags (GrowthBook in Claude Code's case):

```typescript
function getToolResultLimit(toolName: string): number {
  // Check for feature flag override first
  const override = getFeatureFlag(`tool_result_limit_${toolName}`);
  if (override !== undefined) {
    return override;
  }

  // Fall back to default
  return TOOL_RESULT_LIMITS[toolName] ?? TOOL_RESULT_LIMITS.DEFAULT;
}
```

This allows the team to:
- A/B test different limits to find optimal values
- Increase limits for specific tools when users report truncation issues
- Decrease limits if a tool is causing context bloat
- Test different limits for different model configurations

For example, if a new model handles larger contexts better, the team can gradually increase tool result limits for that model and measure the impact on task success rates.

## Why Not Just Use Smaller Limits?

You might wonder: why not set every tool to 5K characters and save tons of context? Because **truncation loses information**, and lost information means worse agent performance.

If a file edit result is truncated, the model can't verify its edit was applied correctly. If grep results are too short, the model misses important matches. If shell output cuts off the error message, the model can't debug the failure.

The per-tool limits represent a careful balance:
- **Too generous**: wastes context on low-value content
- **Too restrictive**: loses critical information the model needs

The current values were tuned empirically — by observing where truncation caused task failures and where larger results didn't improve performance.

## Key Takeaways

1. **Per-tool budgets are the first line of defense** — they cap results before they enter context
2. **Different tools get different limits** — tuned for each tool's typical output and value
3. **Large results persist to disk** — the full output is saved even when context gets the truncated version
4. **Truncation strategy matters** — head, tail, or both, depending on where useful information lives
5. **Preview tags inform the model** — the model knows results were truncated and can refine its approach
6. **Limits are tunable via feature flags** — allowing experimentation without code changes

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Truncation Strategy Selection
**Question:** For each scenario, identify the best truncation strategy (head, tail, or head_and_tail) and explain why: (a) a `npm test` output with 500 lines, (b) a grep search returning 1000 matches, (c) reading a 2000-line Python module.

[View Answer](../../answers/06-context-management/answer-58.md#exercise-1)

### Exercise 2 — Implement applyToolResultBudget
**Challenge:** Implement the `applyToolResultBudget` function with support for per-tool limits and a default fallback. Include the truncation notice. Your function should accept the tool name, raw result string, and an optional overrides map.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-58.md#exercise-2)

### Exercise 3 — Truncation with Strategy
**Challenge:** Write a `truncateResult(result: string, maxChars: number, strategy: "head" | "tail" | "head_and_tail")` function that implements all three truncation strategies. For "head_and_tail", split the budget evenly and insert a `[... middle truncated ...]` marker.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-58.md#exercise-3)

### Exercise 4 — Preview Tag Parser
**Challenge:** Write a function `parsePreviewTag(content: string)` that extracts the `maxChars` and `totalChars` values from a `<preview>` tag in a truncated result. Return `null` if no preview tag is found.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-58.md#exercise-4)

---

*Previous: [Lesson 57 — Token Budgets and Limits](57-token-budgets-and-limits.md) · Next: [Lesson 59 — Microcompact](59-microcompact.md)*
