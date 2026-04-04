# Lesson 71: Diff and Patch — Showing What Changed

## Why Diffs Matter

The `old_string → new_string` edit model (Lesson 68) is great for the agent, but the **user** needs to see exactly what changed. A string replacement doesn't inherently produce a diff — you have to generate one. This lesson covers Claude Code's diff pipeline: from edit to structured patch to display.

---

## The Diff Pipeline

```
Edit completed (old content → new content)
        │
        ▼
┌────────────────────┐
│ getPatchForEdit()   │ → Single-edit patch
└──────────┬─────────┘
        ▼
┌────────────────────┐
│ getPatchForEdits()  │ → Multi-edit aggregation
└──────────┬─────────┘
        ▼
┌────────────────────┐
│ getPatchFromContents│ → Raw content diffing
└──────────┬─────────┘
        ▼
┌────────────────────┐
│ getPatchForDisplay()│ → UI-ready formatting
└────────────────────┘
```

Each function handles a different level of abstraction. Let's trace through them.

---

## getPatchForEdit: Single Edit to Patch

When one `old_string → new_string` replacement completes, this function generates the patch:

```typescript
function getPatchForEdit(
  filePath: string,
  oldContent: string,
  newContent: string,
  oldString: string,
  newString: string
): string {
  // For small, localized edits, generate a targeted patch
  // rather than diffing the entire file
  const editStart = oldContent.indexOf(oldString);
  const editEnd = editStart + oldString.length;

  // Extract context around the edit
  const contextBefore = getContextLines(oldContent, editStart, CONTEXT_LINES);
  const contextAfter = getContextLines(
    oldContent,
    editEnd,
    CONTEXT_LINES
  );

  return formatPatch(filePath, contextBefore, oldString, newString, contextAfter);
}

const CONTEXT_LINES = 3;
```

The `CONTEXT_LINES = 3` constant matches the unified diff convention — three lines of context before and after the change. This gives enough surrounding code for a human to understand the location without overwhelming the display.

---

## getPatchForEdits: Aggregating Multiple Edits

When `replace_all` is used or multiple edits happen to the same file, individual patches are combined:

```typescript
function getPatchForEdits(
  filePath: string,
  originalContent: string,
  finalContent: string,
  edits: Array<{ oldString: string; newString: string }>
): string {
  // If edits are close together, they'll be merged into one hunk
  // If far apart, they'll be separate hunks
  return getPatchFromContents(filePath, originalContent, finalContent);
}
```

For multiple edits, it's simpler and more correct to just diff the before/after content rather than trying to stitch individual patches together.

---

## getPatchFromContents: The Core Diffing Engine

This is where the actual diff algorithm runs. It uses the `diff` npm package's `structuredPatch` function:

```typescript
import { structuredPatch } from "diff";

const DIFF_TIMEOUT_MS = 5000;

function getPatchFromContents(
  filePath: string,
  oldContent: string,
  newContent: string
): string {
  // Escape special characters that confuse the diff algorithm
  const escapedOld = escapeForDiff(oldContent);
  const escapedNew = escapeForDiff(newContent);

  const patch = structuredPatch(
    filePath,
    filePath,
    escapedOld,
    escapedNew,
    "", // old header
    "", // new header
    {
      context: CONTEXT_LINES,
    }
  );

  // Unescape the result
  return unescapeFromDiff(formatStructuredPatch(patch));
}
```

### The structuredPatch Function

`structuredPatch` from the `diff` package returns a structured object:

```typescript
interface ParsedPatch {
  oldFileName: string;
  newFileName: string;
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];  // prefixed with ' ', '+', or '-'
  }>;
}
```

Each hunk represents a contiguous region of changes with surrounding context. The `lines` array uses the unified diff convention:
- `' '` prefix: unchanged context line
- `'+'` prefix: added line
- `'-'` prefix: removed line

---

## Escaping for Diff

The diff algorithm can be confused by certain characters. Claude Code escapes them before diffing:

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
```

The `&` and `$` characters are escaped to placeholder tokens before diffing, then restored in the output. This prevents edge cases where these characters interact with the diff algorithm's internal processing.

---

## The DIFF_TIMEOUT_MS Guard

Diff algorithms can be expensive on large files with many changes. A pathological case (like diffing two completely different 10,000-line files) could hang the agent:

```typescript
const DIFF_TIMEOUT_MS = 5000;

function getPatchFromContentsWithTimeout(
  filePath: string,
  oldContent: string,
  newContent: string
): string {
  const startTime = Date.now();

  const result = getPatchFromContents(filePath, oldContent, newContent);

  if (Date.now() - startTime > DIFF_TIMEOUT_MS) {
    console.warn(
      `Diff for ${filePath} took ${Date.now() - startTime}ms ` +
      `(timeout: ${DIFF_TIMEOUT_MS}ms)`
    );
    // Return a simplified diff instead
    return formatSimplifiedDiff(filePath, oldContent, newContent);
  }

  return result;
}

function formatSimplifiedDiff(
  filePath: string,
  oldContent: string,
  newContent: string
): string {
  const oldLines = oldContent.split("\n").length;
  const newLines = newContent.split("\n").length;
  return (
    `--- ${filePath}\n+++ ${filePath}\n` +
    `@@ File changed: ${oldLines} lines → ${newLines} lines @@\n` +
    `(diff too large to display)`
  );
}
```

The 5-second timeout prevents the diff from blocking the agent loop. When it triggers, a simplified summary replaces the full diff.

---

## countLinesChanged: Analytics

After generating the patch, the system counts what changed for analytics and user feedback:

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
    modified: Math.min(added, removed), // paired add/remove = modification
  };
}
```

The `modified` count uses a heuristic: if 5 lines were removed and 5 added, those are likely 5 modified lines rather than a deletion + insertion.

---

## getPatchForDisplay: UI Formatting

The final stage formats the patch for the user interface:

```typescript
function getPatchForDisplay(
  filePath: string,
  patch: string,
  options: { color?: boolean; lineNumbers?: boolean } = {}
): string {
  const { color = true, lineNumbers = true } = options;
  const lines = patch.split("\n");
  const formatted: string[] = [];

  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      // Parse hunk header for line numbers
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (match) {
        oldLineNum = parseInt(match[1]);
        newLineNum = parseInt(match[2]);
      }
      formatted.push(color ? `\x1b[36m${line}\x1b[0m` : line);
      continue;
    }

    if (line.startsWith("-")) {
      const prefix = lineNumbers
        ? `${String(oldLineNum++).padStart(4)}    `
        : "";
      formatted.push(
        color ? `\x1b[31m${prefix}${line}\x1b[0m` : `${prefix}${line}`
      );
    } else if (line.startsWith("+")) {
      const prefix = lineNumbers
        ? `    ${String(newLineNum++).padStart(4)} `
        : "";
      formatted.push(
        color ? `\x1b[32m${prefix}${line}\x1b[0m` : `${prefix}${line}`
      );
    } else {
      const prefix = lineNumbers
        ? `${String(oldLineNum++).padStart(4)} ${String(newLineNum++).padStart(4)} `
        : "";
      formatted.push(`${prefix}${line}`);
    }
  }

  return formatted.join("\n");
}
```

The display formatter adds:
- **ANSI colors**: Red for removed, green for added, cyan for hunk headers
- **Dual line numbers**: Old file line number on the left, new on the right
- **Context alignment**: Unchanged lines show both line numbers

---

## adjustHunkLineNumbers: Handling Partial Reads

When the model read only part of a file (using `offset`/`limit`), the diff line numbers need adjustment:

```typescript
function adjustHunkLineNumbers(
  patch: ParsedPatch,
  readOffset: number
): ParsedPatch {
  return {
    ...patch,
    hunks: patch.hunks.map((hunk) => ({
      ...hunk,
      oldStart: hunk.oldStart + readOffset - 1,
      newStart: hunk.newStart + readOffset - 1,
    })),
  };
}
```

If the model read from line 100 and the edit is at "line 5" of the viewed content, the displayed diff should show line 104, not line 5.

---

## Example: End-to-End Diff Generation

Starting file:

```javascript
function greet(name) {
  console.log("Hello, " + name);
  return true;
}
```

Edit: `old_string = 'console.log("Hello, " + name);'`, `new_string = 'console.log(\`Hello, ${name}!\`);'`

Generated patch:

```diff
--- src/greet.js
+++ src/greet.js
@@ -1,4 +1,4 @@
 function greet(name) {
-  console.log("Hello, " + name);
+  console.log(`Hello, ${name}!`);
   return true;
 }
```

Display output (with colors and line numbers):

```
   1    1  function greet(name) {
   2      -  console.log("Hello, " + name);
        2 +  console.log(`Hello, ${name}!`);
   3    3    return true;
   4    4  }
```

Analytics: `{ added: 1, removed: 1, modified: 1 }`

---

## Key Takeaways

1. **The diff pipeline** transforms string replacements into human-readable unified diffs through four stages.

2. **structuredPatch()** from the `diff` package does the heavy lifting, producing hunks with context.

3. **Character escaping** (`&`, `$` → tokens) prevents edge cases in the diff algorithm.

4. **DIFF_TIMEOUT_MS = 5000** prevents pathological diffs from hanging the agent loop.

5. **adjustHunkLineNumbers()** corrects line numbers when edits target partially-read files.

6. **countLinesChanged()** provides analytics — added, removed, and modified line counts.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Diff Pipeline Stages
**Question:** List the four stages of the diff pipeline in order. For each stage, explain what it takes as input, what it produces as output, and when you'd use that specific stage (vs. skipping to a later one).

[View Answer](../../answers/07-file-operations/answer-71.md#exercise-1)

### Exercise 2 — Line Change Counter
**Challenge:** Write a `countLinesChanged(patch: string)` function that parses a unified diff string and returns `{ added: number, removed: number, modified: number }`. Lines starting with `+` (but not `+++`) are added, lines starting with `-` (but not `---`) are removed. Modified = `min(added, removed)`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-71.md#exercise-2)

### Exercise 3 — Diff Escaping
**Challenge:** Implement `escapeForDiff(content: string)` and `unescapeFromDiff(patch: string)` that handle the `&` and `$` character escaping described in the lesson. Write a test showing that without escaping, a diff of content containing `$` produces incorrect output.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-71.md#exercise-3)

### Exercise 4 — Hunk Line Number Adjuster
**Challenge:** Write `adjustHunkLineNumbers(patchText: string, readOffset: number)` that adjusts the `@@ -X,Y +X,Y @@` line numbers in a unified diff by adding an offset. This handles the case where a partial file read produced a diff starting at "line 1" but the actual read started at line 100.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-71.md#exercise-4)

---

## What's Next

Lesson 72 covers a specialized editing case: **Jupyter notebooks**. Because `.ipynb` files are JSON with a cell structure, they need their own editing tool that works at the cell level rather than raw string replacement.
