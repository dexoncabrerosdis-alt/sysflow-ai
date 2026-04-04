# Answers: Lesson 51 — Prompt Caching

## Exercise 1
**Question:** What does "byte-identical prefix" mean? Give three examples of changes that break the cache.

**Answer:** "Byte-identical prefix" means the beginning of the new request must be exactly the same — at the byte level — as the beginning of the cached request. Not "similar," not "semantically equivalent" — character-for-character identical. Three changes that break the cache even though the prompt is semantically the same: (1) **An extra space** — "You are an interactive CLI agent " (trailing space) vs "You are an interactive CLI agent" — one byte difference invalidates the entire cache. (2) **Different tool ordering** — Sending tools as [FileRead, Bash, Grep] on turn 1 and [Bash, FileRead, Grep] on turn 2. The tool definitions are part of the cached prefix, so reordering changes the bytes. (3) **A timestamp in a static section** — "Agent v1.0 | Started 2025-07-15T10:30:00Z" vs "Agent v1.0 | Started 2025-07-15T10:30:05Z". Even though the prompt is functionally identical, the different timestamp bytes break the prefix match.

---

## Exercise 2
**Challenge:** Write a function that returns a cacheable two-block prompt structure.

**Answer:**
```typescript
interface SystemPromptBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

function buildCacheablePrompt(
  staticContent: string,
  dynamicContent: string
): SystemPromptBlock[] {
  return [
    {
      type: "text",
      text: staticContent,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: dynamicContent,
    },
  ];
}
```
**Explanation:** The first block contains all static content with `cache_control: { type: "ephemeral" }`, which tells the API to cache this prefix. The second block contains dynamic content without cache control — it's reprocessed every turn. The API caches everything up to and including the first block; the second block is always fresh.

---

## Exercise 3
**Challenge:** Write a cache savings calculator.

**Answer:**
```typescript
function calculateCacheSavings(
  staticTokens: number,
  dynamicTokens: number,
  turns: number
): { withCache: number; withoutCache: number; savings: number } {
  const standardRate = 3.0;
  const cacheReadRate = 0.3;
  const cacheWriteRate = 3.75;

  const withoutCache =
    turns *
    (staticTokens + dynamicTokens) *
    (standardRate / 1_000_000);

  const withCache =
    1 * staticTokens * (cacheWriteRate / 1_000_000) +
    (turns - 1) * staticTokens * (cacheReadRate / 1_000_000) +
    turns * dynamicTokens * (standardRate / 1_000_000);

  return {
    withoutCache: Math.round(withoutCache * 10000) / 10000,
    withCache: Math.round(withCache * 10000) / 10000,
    savings: Math.round((withoutCache - withCache) * 10000) / 10000,
  };
}
```
**Explanation:** Without caching, all tokens are charged at the standard rate every turn. With caching, the static portion is charged at the write rate (25% premium) on the first turn and the read rate (90% discount) on subsequent turns. Dynamic tokens always pay full price. The savings scale with both the static portion size and the number of turns.

---

## Exercise 4
**Question:** Why must tool definitions be sorted deterministically? What happens with unsorted tools?

**Answer:** Tool definitions are part of the API request payload and affect the cache prefix computation. If tools arrive in different orders on different turns — which easily happens when tools are loaded from Maps, Sets, or dynamic sources where insertion order isn't guaranteed — the byte sequence of the request changes. Even though the same tools are present, the different ordering means a different byte prefix, which invalidates the cache. Every turn becomes a cache miss, and you lose all caching benefits on tool definitions (which can be 5,000-10,000 tokens). The fix is simple: sort tools alphabetically by name before sending them to the API. `tools.sort((a, b) => a.name.localeCompare(b.name))` ensures deterministic ordering regardless of how tools were loaded.
