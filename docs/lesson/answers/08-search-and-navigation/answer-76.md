# Answers: Lesson 76 — Search Pagination

## Exercise 1
**Question:** Why is the default `head_limit` set to 250 and not 10 or 10,000?

**Answer:** At `head_limit: 10`, most targeted searches would be truncated. The model would need dozens of pagination calls to see all results for common searches like "find all TODO comments" — each call costs a turn in the agent loop, adding latency and token cost. At `head_limit: 10000`, a broad search like `GrepTool({ pattern: "import" })` could return 200KB+ of text, consuming most of the context window. This degrades the model's reasoning quality (too much noise), costs more (input tokens), and slows responses. At 250, the vast majority of focused, task-relevant searches return complete results in a single call. Only genuinely broad searches need pagination, and even then just one or two extra pages usually suffice.

---

## Exercise 2
**Challenge:** Implement the `paginateResults` function.

**Answer:**
```typescript
interface PaginationResult {
  results: string[];
  hasMore: boolean;
  totalCount: number;
}

function paginateResults(
  allResults: string[],
  headLimit: number,
  offset: number
): PaginationResult {
  const afterOffset = allResults.slice(offset);

  const limited =
    headLimit > 0
      ? afterOffset.slice(0, headLimit)
      : afterOffset;

  return {
    results: limited,
    hasMore: headLimit > 0 && afterOffset.length > limited.length,
    totalCount: allResults.length,
  };
}

// Tests
const data = Array.from({ length: 100 }, (_, i) => `result-${i}`);

const page1 = paginateResults(data, 25, 0);
console.assert(page1.results.length === 25);
console.assert(page1.hasMore === true);
console.assert(page1.totalCount === 100);

const page2 = paginateResults(data, 25, 75);
console.assert(page2.results.length === 25);
console.assert(page2.hasMore === false);

const unlimited = paginateResults(data, 0, 0);
console.assert(unlimited.results.length === 100);
console.assert(unlimited.hasMore === false);
```
**Explanation:** The function first applies the offset to skip already-seen results, then applies the head_limit cap. When `headLimit` is 0, all remaining results are returned (unlimited mode). The `hasMore` flag is `true` only when results were actually truncated — this drives the "more results available" indicator. The `totalCount` always reflects the full result set regardless of pagination.

---

## Exercise 3
**Challenge:** Implement `formatPaginatedOutput`.

**Answer:**
```typescript
function formatPaginatedOutput(
  results: string[],
  hasMore: boolean,
  totalCount: number,
  headLimit: number,
  offset: number
): string {
  if (results.length === 0) {
    return "No matches found.";
  }

  let output = results.join("\n");

  if (hasMore) {
    const shown = results.length;
    const remaining = totalCount - offset - shown;
    const nextOffset = offset + headLimit;

    output +=
      `\n\nShowing ${shown} of ${totalCount} total results. ` +
      `${remaining} more results available. ` +
      `Use offset=${nextOffset} to see the next page.`;
  }

  return output;
}

// Test
const { results, hasMore, totalCount } = paginateResults(
  Array.from({ length: 312 }, (_, i) => `src/file${i}.ts:${i}: // TODO item`),
  50,
  0
);

console.log(formatPaginatedOutput(results, hasMore, totalCount, 50, 0));
// Output ends with:
// Showing 50 of 312 total results. 262 more results available. Use offset=50 to see the next page.
```
**Explanation:** The formatter joins results with newlines and conditionally appends a pagination notice. The notice includes three key pieces of information: how many results are shown, how many total exist, and the exact `offset` value for the next page. This "teaches" the model how to get more results without needing to calculate the offset itself. The empty-results case returns a clean "No matches found" message.

---

## Exercise 4
**Challenge:** Write a paginated iterator using an async generator.

**Answer:**
```typescript
interface SearchResult {
  results: string[];
  hasMore: boolean;
  totalCount: number;
}

type SearchFn = (offset: number, limit: number) => Promise<SearchResult>;

async function* paginatedSearch(
  searchFn: SearchFn,
  pageSize: number,
  maxPages: number = Infinity
): AsyncGenerator<string[], void, undefined> {
  let offset = 0;
  let pageCount = 0;

  while (pageCount < maxPages) {
    const page = await searchFn(offset, pageSize);

    if (page.results.length === 0) break;

    yield page.results;

    pageCount++;

    if (!page.hasMore) break;

    offset += pageSize;
  }
}

// Usage example
async function collectAllTODOs(): Promise<string[]> {
  const allResults: string[] = [];

  const search: SearchFn = async (offset, limit) => {
    const raw = ["TODO: fix auth", "TODO: add tests", "TODO: refactor"];
    return paginateResults(raw, limit, offset);
  };

  for await (const page of paginatedSearch(search, 50, 10)) {
    allResults.push(...page);
  }

  return allResults;
}
```
**Explanation:** The async generator encapsulates the pagination loop. It calls the search function with increasing offsets, yields each page of results, and stops when either: no results are returned, `hasMore` is false, or `maxPages` is reached. The `maxPages` guard prevents infinite loops if the search function misbehaves. Callers use `for await...of` to process pages one at a time, which keeps memory usage low for very large result sets.
