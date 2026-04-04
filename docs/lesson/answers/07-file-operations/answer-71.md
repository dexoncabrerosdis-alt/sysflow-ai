# Answers: Lesson 71 — Diff and Patch

## Exercise 1
**Question:** List the four stages of the diff pipeline with inputs, outputs, and use cases.

**Answer:** (1) **`getPatchForEdit()`** — Input: file path, old content, new content, old_string, new_string. Output: a targeted patch for a single edit with 3 lines of context. Use when a single `old_string → new_string` replacement was made. (2) **`getPatchForEdits()`** — Input: file path, original content, final content, array of edits. Output: an aggregated patch. Use when `replace_all` or multiple edits happened to the same file. It delegates to `getPatchFromContents` because stitching individual patches is error-prone. (3) **`getPatchFromContents()`** — Input: file path, old content, new content. Output: raw unified diff using the `structuredPatch` algorithm. The core engine — use when you only have before/after content without knowing the specific edits. (4) **`getPatchForDisplay()`** — Input: file path, patch string, display options. Output: formatted patch with ANSI colors, dual line numbers. Use for terminal/UI display to the user.

---

## Exercise 2
**Challenge:** Write a `countLinesChanged` function.

**Answer:**

```typescript
function countLinesChanged(patch: string): {
  added: number;
  removed: number;
  modified: number;
} {
  const lines = patch.split("\n");
  let added = 0;
  let removed = 0;

  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed++;
    }
  }

  return {
    added,
    removed,
    modified: Math.min(added, removed),
  };
}
```

**Explanation:** The function skips the `+++` and `---` file headers that also start with `+`/`-`. The `modified` heuristic uses `min(added, removed)` because paired additions and removals typically represent modified lines (e.g., 5 lines removed + 5 lines added = 5 modified lines, not a deletion + insertion).

---

## Exercise 3
**Challenge:** Implement diff escaping and unescaping.

**Answer:**

```typescript
const ESCAPE_MAP: Record<string, string> = {
  "&": "__AMP_TOKEN__",
  "$": "__DOLLAR_TOKEN__",
};

function escapeForDiff(content: string): string {
  let result = content;
  for (const [char, token] of Object.entries(ESCAPE_MAP)) {
    result = result.split(char).join(token);
  }
  return result;
}

function unescapeFromDiff(patch: string): string {
  let result = patch;
  for (const [char, token] of Object.entries(ESCAPE_MAP)) {
    result = result.split(token).join(char);
  }
  return result;
}

// Test: without escaping, $ can cause issues in some diff implementations
const oldContent = 'price = "$100";\n';
const newContent = 'price = "$200";\n';

// Escaped flow produces correct output:
const escaped = escapeForDiff(oldContent);
// escaped: 'price = "__DOLLAR_TOKEN__100";\n'
// diff runs cleanly on escaped content
// unescape restores $ in the final patch
```

**Explanation:** The `&` and `$` characters can interact with some diff algorithm internals or shell processing. Escaping them to long, unique placeholder tokens before diffing, then restoring them in the output, avoids these edge cases without affecting the diff algorithm's logic.

---

## Exercise 4
**Challenge:** Write `adjustHunkLineNumbers`.

**Answer:**

```typescript
function adjustHunkLineNumbers(
  patchText: string,
  readOffset: number
): string {
  if (readOffset <= 1) return patchText;

  const adjustment = readOffset - 1;

  return patchText.replace(
    /@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/g,
    (match, oldStart, oldCount, newStart, newCount) => {
      const adjustedOld = parseInt(oldStart) + adjustment;
      const adjustedNew = parseInt(newStart) + adjustment;
      return `@@ -${adjustedOld}${oldCount || ""} +${adjustedNew}${newCount || ""} @@`;
    }
  );
}
```

**Explanation:** When a file was partially read starting at line `readOffset`, the diff's internal line numbers are relative to the viewed portion (starting at 1). This function adds the offset to align them with the actual file line numbers. For example, if the read started at line 100 and the diff shows a change at "line 5," the adjusted output shows line 104.
