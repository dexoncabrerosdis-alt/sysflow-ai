# Lesson 76: Search Pagination — Controlling Result Volume

## The Context Explosion Problem

A naive search tool returns *everything*. Search for `"import"` in a large TypeScript project and you might get 10,000+ matches. Feeding all of that into the model's context would:

1. **Blow the context window** — exceeding token limits
2. **Waste money** — input tokens cost money, and most results are irrelevant
3. **Confuse the model** — too much information degrades reasoning quality
4. **Slow everything down** — more tokens = more latency

Claude Code solves this with a pagination system built into every search tool. This lesson explains how it works and why the defaults matter.

---

## The Two Pagination Parameters

### head_limit: Cap the Total Results

```typescript
head_limit: z
  .number()
  .int()
  .nonnegative()
  .optional()
  .default(250)
  .describe("Maximum number of results to return. 0 for unlimited.")
```

`head_limit` is the maximum number of results returned. The default of 250 is carefully chosen:

- **Large enough** to find what you're looking for in most cases
- **Small enough** to fit comfortably in context alongside conversation history
- **A round number** that the model can reason about

### offset: Skip Past Already-Seen Results

```typescript
offset: z
  .number()
  .int()
  .nonnegative()
  .optional()
  .default(0)
  .describe("Number of results to skip (for pagination)")
```

`offset` enables the model to page through large result sets:

```
First call:  GrepTool({ pattern: "TODO", head_limit: 50, offset: 0 })   → results 1-50
Second call: GrepTool({ pattern: "TODO", head_limit: 50, offset: 50 })  → results 51-100
Third call:  GrepTool({ pattern: "TODO", head_limit: 50, offset: 100 }) → results 101-150
```

---

## The Pagination Implementation

```typescript
function paginateResults(
  allResults: string[],
  headLimit: number,
  offset: number
): { results: string[]; hasMore: boolean; totalCount: number } {
  // Apply offset
  const afterOffset = allResults.slice(offset);

  // Apply head_limit (0 means unlimited)
  const limited =
    headLimit > 0
      ? afterOffset.slice(0, headLimit)
      : afterOffset;

  return {
    results: limited,
    hasMore: afterOffset.length > limited.length,
    totalCount: allResults.length,
  };
}
```

### The "Has More" Indicator

When results are truncated, the output tells the model:

```typescript
function formatPaginatedOutput(
  results: string[],
  hasMore: boolean,
  totalCount: number,
  headLimit: number,
  offset: number
): string {
  let output = results.join("\n");

  if (hasMore) {
    const remaining = totalCount - offset - results.length;
    output +=
      `\n\n` +
      `Showing ${results.length} of ${totalCount} total results. ` +
      `${remaining} more results available. ` +
      `Use offset=${offset + headLimit} to see the next page.`;
  }

  return output;
}
```

Example output:

```
src/auth/handler.ts:42:  // TODO: Add rate limiting
src/auth/handler.ts:67:  // TODO: Validate token expiry
src/api/routes.ts:15:    // TODO: Add pagination to list endpoint
... (47 more matches)

Showing 50 of 312 total results. 262 more results available.
Use offset=50 to see the next page.
```

This message serves dual purposes:
1. **Informs** the model that results were truncated
2. **Teaches** the model exactly how to get more results

---

## Why Defaults Matter

The default `head_limit: 250` is not arbitrary. It balances several concerns:

### Too Low (e.g., 10)

```
Search: GrepTool({ pattern: "database" })
Results: 10 of 450 matches shown

Problem: The model would need 45 pagination calls to see everything.
Each call costs a turn in the agent loop.
```

### Too High (e.g., 10000)

```
Search: GrepTool({ pattern: "import" })
Results: 10000 matches, ~200KB of text

Problem: This consumes most of the context window.
The model's reasoning quality degrades with too much input.
```

### The Sweet Spot (250)

```
Search: GrepTool({ pattern: "handleAuth" })
Results: 12 matches (all fit in 250)

Search: GrepTool({ pattern: "TODO" })
Results: 250 of 312 matches (most shown, minimal pagination needed)
```

At 250, the vast majority of targeted searches return complete results. Only broad or unfocused searches need pagination.

---

## head_limit: 0 — The Unlimited Option

Sometimes the model genuinely needs all results:

```typescript
GrepTool({
  pattern: "oldFunctionName",
  output_mode: "files_with_matches",
  head_limit: 0,  // Get ALL files
})
```

With `head_limit: 0`, no truncation occurs. This is appropriate when:
- Using `files_with_matches` mode (just file paths, low volume)
- Using `count` mode (just numbers, very low volume)
- The model knows the result set is small

The system prompt includes a warning about unlimited results:

```
Use head_limit: 0 only when you specifically need all results
and expect the result set to be manageable. Large unlimited
searches can overwhelm context.
```

---

## maxResultSizeChars: The Safety Net

Beyond `head_limit`, there's a character-level cap that prevents any single tool from returning too much text:

```typescript
const MAX_RESULT_SIZE_CHARS = 100000; // ~100KB

function enforceMaxResultSize(output: string): string {
  if (output.length <= MAX_RESULT_SIZE_CHARS) {
    return output;
  }

  const truncated = output.substring(0, MAX_RESULT_SIZE_CHARS);
  const lastNewline = truncated.lastIndexOf("\n");
  const cleanTruncated = truncated.substring(0, lastNewline);

  return (
    cleanTruncated +
    `\n\n[Output truncated at ${MAX_RESULT_SIZE_CHARS} characters. ` +
    `Use a more specific search pattern or reduce head_limit.]`
  );
}
```

This catches cases where individual results are very large (e.g., a match with 100 lines of context). Even with `head_limit: 250`, if each result has 50 context lines, the total could be enormous. The character cap is the final safety net.

---

## How Pagination Works Across Output Modes

### Content Mode

```
head_limit counts individual match lines:

src/auth.ts:42:  handleAuth(req)     ← 1 result
src/auth.ts:43:  // context line     ← NOT counted (context)
src/auth.ts:44:  return response;    ← NOT counted (context)
--
src/middleware.ts:15:  handleAuth(r)  ← 2 results
```

Context lines (from `-B`/`-A`/`-C`) are NOT counted against `head_limit`. Only actual match lines count.

### Files With Matches Mode

```
head_limit counts files:

src/auth/handler.ts     ← 1 result
src/middleware/auth.ts   ← 2 results
src/tests/auth.test.ts   ← 3 results
```

### Count Mode

```
head_limit counts files (each with their count):

src/auth/handler.ts:3     ← 1 result
src/middleware/auth.ts:1   ← 2 results
src/tests/auth.test.ts:7  ← 3 results
```

---

## Pagination Strategies the Agent Uses

### Strategy 1: Start Broad, Narrow Down

```
Step 1: GrepTool({ pattern: "auth", output_mode: "count" })
        → 47 files contain "auth" — too many

Step 2: GrepTool({ pattern: "auth", output_mode: "count", glob: "*.config.*" })
        → 2 files — manageable
```

The model uses count mode to gauge scope before requesting full content.

### Strategy 2: File List Then Targeted Read

```
Step 1: GrepTool({ pattern: "handleAuth", output_mode: "files_with_matches" })
        → src/auth/handler.ts, src/middleware/auth.ts

Step 2: Read({ file_path: "src/auth/handler.ts" })
        → Read the full file for context
```

Using `files_with_matches` keeps the first search lightweight.

### Strategy 3: Paginated Deep Dive

```
Step 1: GrepTool({ pattern: "TODO|FIXME|HACK", head_limit: 50, offset: 0 })
        → First 50 TODOs

Step 2: GrepTool({ pattern: "TODO|FIXME|HACK", head_limit: 50, offset: 50 })
        → Next 50 TODOs

... continues until all are reviewed
```

Used when the model needs to systematically process all results.

---

## Interaction with Context Management

Recall from Module 06 that compaction layers manage context window size. Pagination interacts with compaction:

```
Turn 1: Search returns 250 results (~15KB)
Turn 5: Compaction summarizes: "Search found 250 results for 'TODO' across 47 files"
Turn 8: Model references compacted summary, pages to offset=250 for more

The detailed results are compacted, but the pagination state is preserved.
```

This means the model can efficiently process large result sets over many turns without the early results consuming context forever.

---

## Key Takeaways

1. **head_limit (default 250)** caps results to prevent context explosion. The default balances completeness against context cost.

2. **offset** enables pagination through large result sets, with the "has more" message teaching the model how to get the next page.

3. **maxResultSizeChars** is the final safety net — a character-level cap that catches edge cases where individual results are very large.

4. **head_limit: 0** removes the cap for cases where all results are needed, but comes with a context-explosion warning.

5. **Different output modes count differently** — content counts match lines, files_with_matches and count count files.

6. **Pagination strategies** (count first, file list then read, paginated deep dive) let the model efficiently navigate large result sets.

---

## What's Next

Text search (Grep) and file search (Glob) work at the syntactic level — they match strings and patterns. Lesson 77 introduces **LSP integration**, which provides *semantic* code navigation: go-to-definition, find-references, and type information.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Default head_limit Tradeoffs
**Question:** Why is the default `head_limit` set to 250 and not 10 or 10,000? Explain what goes wrong at each extreme and why 250 is the "sweet spot."

[View Answer](../../answers/08-search-and-navigation/answer-76.md#exercise-1)

### Exercise 2 — Implement paginateResults
**Challenge:** Write a `paginateResults` function that takes an array of result strings, a `headLimit` number, and an `offset` number. Return an object with `results`, `hasMore`, and `totalCount`. Handle `headLimit: 0` as unlimited.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-76.md#exercise-2)

### Exercise 3 — Format Paginated Output
**Challenge:** Implement a `formatPaginatedOutput` function that joins results into a string and appends a "Showing X of Y total results. Z more results available. Use offset=N to see the next page." message when results are truncated.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-76.md#exercise-3)

### Exercise 4 — Paginated Iterator
**Challenge:** Write an async generator function `paginatedSearch` that takes a search function, `pageSize`, and `maxPages`. It should call the search function repeatedly with increasing offsets, yield each page of results, and stop when there are no more results or `maxPages` is reached.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-76.md#exercise-4)
