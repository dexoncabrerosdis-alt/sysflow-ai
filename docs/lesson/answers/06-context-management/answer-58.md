# Answers: Lesson 58 — Tool Result Budgets

## Exercise 1
**Question:** For each scenario, identify the best truncation strategy and explain why.

**Answer:** (a) **Tail** — test output puts errors and failure summaries at the bottom. Keeping the end preserves the actionable information. (b) **Head** — grep results are ordered by file/occurrence, and the first matches are usually the most relevant. The model can refine its search if it needs more. (c) **Head and tail** — a Python module's imports are at the top and its class/function exports are at the bottom. Both ends carry structural information, while the middle (implementation details) is less critical for initial understanding.

---

## Exercise 2
**Challenge:** Implement the `applyToolResultBudget` function.

**Answer:**

```typescript
const DEFAULT_LIMITS: Record<string, number> = {
  FileEdit: 100_000,
  Grep: 20_000,
  Glob: 20_000,
  Shell: 30_000,
  FileRead: Infinity,
  WebFetch: 50_000,
  DEFAULT: 30_000,
};

function applyToolResultBudget(
  toolName: string,
  result: string,
  overrides?: Record<string, number>
): { content: string; wasTruncated: boolean } {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const maxChars = limits[toolName] ?? limits.DEFAULT;

  if (maxChars === Infinity || result.length <= maxChars) {
    return { content: result, wasTruncated: false };
  }

  const truncated = result.slice(0, maxChars);
  const notice =
    `\n\n[Result truncated: showing ${maxChars.toLocaleString()} ` +
    `of ${result.length.toLocaleString()} characters]`;

  return {
    content: truncated + notice,
    wasTruncated: true,
  };
}
```

**Explanation:** The function merges default limits with optional overrides (supporting feature-flag-style configuration), looks up the limit for the given tool, and truncates with a descriptive notice if needed. `Infinity` is used for tools like FileRead that are bounded elsewhere.

---

## Exercise 3
**Challenge:** Write a `truncateResult` function implementing all three truncation strategies.

**Answer:**

```typescript
function truncateResult(
  result: string,
  maxChars: number,
  strategy: "head" | "tail" | "head_and_tail"
): string {
  if (result.length <= maxChars) return result;

  switch (strategy) {
    case "head":
      return result.slice(0, maxChars);

    case "tail":
      return result.slice(-maxChars);

    case "head_and_tail": {
      const halfBudget = Math.floor(maxChars / 2);
      const head = result.slice(0, halfBudget);
      const tail = result.slice(-halfBudget);
      return head + "\n\n[... middle truncated ...]\n\n" + tail;
    }
  }
}
```

**Explanation:** Each strategy preserves the most valuable portion of the output. The `head_and_tail` approach splits the budget in half and inserts a clear marker so the model knows content was removed from the middle.

---

## Exercise 4
**Challenge:** Write a function `parsePreviewTag(content: string)` that extracts values from a `<preview>` tag.

**Answer:**

```typescript
interface PreviewInfo {
  maxChars: number;
  totalChars: number;
}

function parsePreviewTag(content: string): PreviewInfo | null {
  const match = content.match(
    /<preview\s+maxChars="(\d+)"\s+totalChars="(\d+)">/
  );

  if (!match) return null;

  return {
    maxChars: parseInt(match[1], 10),
    totalChars: parseInt(match[2], 10),
  };
}
```

**Explanation:** The function uses a regex to match the `<preview>` tag format and extract both numeric attributes. It returns `null` when no tag is present, letting the caller distinguish between truncated and complete results.
