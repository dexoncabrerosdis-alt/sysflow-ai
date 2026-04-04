# Lesson 70: Read Before Edit — The #1 Guardrail

## The Problem: Hallucinated Edits

The single most common failure mode of AI coding agents is **editing a file the model has never read**. The model "remembers" what it thinks the file contains — from training data, from a similar file, from a previous conversation — and generates an `old_string` that doesn't exist.

```
Model: "I know what React components look like, so the App.tsx file probably has..."
Reality: The actual App.tsx uses a completely different structure
Result: old_string not found → failed edit → wasted turn
```

Claude Code solves this with a hard requirement: **you must read a file before you can edit it**. This lesson covers the validation system that enforces this rule.

---

## The readFileState Registry

Recall from Lesson 66 that every file read is cached:

```typescript
interface ReadFileEntry {
  content: string;
  mtime: number;
  readTime: number;
  offset?: number;
  limit?: number;
}

const readFileState: Map<string, ReadFileEntry> = new Map();
```

FileEditTool checks this registry before every edit. No entry = no edit.

---

## Validation Step 1: Has the File Been Read?

```typescript
async function validateEditPreconditions(
  filePath: string,
  oldString: string,
  fileContent: string
): Promise<void> {
  const readEntry = readFileState.get(filePath);

  if (!readEntry) {
    throw new ToolError(
      `You must read the file before editing it. ` +
      `Use the Read tool to read ${filePath} first, then retry the edit.`
    );
  }
}
```

This check is absolute. Even if the model is 100% confident about the file's contents, the edit will be rejected without a prior read. This forces the agent to spend one tool call verifying its assumptions before modifying anything.

The error message is intentionally instructive — it tells the model exactly what to do next. This is the "error messages as prompts" pattern: the model reads the error, calls Read, then retries the edit. Three tool calls instead of one, but the edit succeeds.

---

## Validation Step 2: Mtime Check (External Modification Detection)

Between the read and the edit, the file might have changed. Maybe the user edited it manually. Maybe a build tool regenerated it. Maybe another tool call modified it.

```typescript
async function checkForExternalModification(
  filePath: string,
  readEntry: ReadFileEntry
): Promise<void> {
  const currentStats = await fs.stat(filePath);
  const currentMtime = currentStats.mtimeMs;

  if (currentMtime !== readEntry.mtime) {
    // File changed since we read it!
    // Fall back to content comparison (mtime can be unreliable)
    const currentContent = await fs.readFile(filePath, "utf-8");

    if (currentContent !== readEntry.content) {
      throw new ToolError(
        `File ${filePath} has been modified since you last read it ` +
        `(read at ${new Date(readEntry.readTime).toISOString()}, ` +
        `modified at ${new Date(currentMtime).toISOString()}). ` +
        `Please read it again before editing.`
      );
    }
    // mtime changed but content is the same (e.g., touch command)
    // Allow the edit to proceed
  }
}
```

The two-tier check is important:

1. **Fast path**: Compare `mtime` values (no I/O needed if stats are cached)
2. **Fallback**: If `mtime` differs, actually read the content and compare

Why the fallback? Because `mtime` can change without content changing:
- `touch` updates mtime without modifying content
- Some editors write the same content on save
- File system quirks on network drives

And the reverse: on some Windows configurations, `mtime` resolution is coarse (2-second granularity in FAT32), so content can change without `mtime` changing. The content comparison catches this.

---

## Validation Step 3: Content Comparison Fallback for Windows

Windows has additional `mtime` quirks that deserve special handling:

```typescript
async function checkModificationWindows(
  filePath: string,
  readEntry: ReadFileEntry
): Promise<boolean> {
  // Windows NTFS has 100ns mtime resolution, but some operations
  // (like git checkout) can produce files with identical mtimes
  // but different content
  if (process.platform === "win32") {
    const currentContent = await fs.readFile(filePath, "utf-8");
    return currentContent === readEntry.content;
  }
  return true;
}
```

On Windows, the system is more conservative — it performs content comparison more frequently because `mtime` alone is less reliable.

---

## Validation Step 4: Partial View Detection

When the model reads only part of a file (using `offset`/`limit`), it has a **partial view**. Editing content outside the viewed range is dangerous:

```typescript
function validateEditWithinView(
  readEntry: ReadFileEntry,
  oldString: string,
  fileContent: string
): void {
  if (readEntry.offset === undefined && readEntry.limit === undefined) {
    return; // Full file was read, no restrictions
  }

  // The model only saw a portion of the file
  const viewedContent = readEntry.content;

  if (!viewedContent.includes(oldString)) {
    throw new ToolError(
      `The old_string you're trying to replace was not in the portion ` +
      `of the file you read (lines ${readEntry.offset} to ` +
      `${(readEntry.offset || 1) + (readEntry.limit || 0)}). ` +
      `Read the relevant section first, or read the entire file.`
    );
  }
}
```

This prevents a subtle failure: the model reads lines 1-50, then tries to edit line 200 based on assumptions about what's there. The validation catches this and directs the model to read the relevant section.

---

## Validation Step 5: Multiple Match Detection

Even after all the above checks pass, there's one more: the `old_string` must match uniquely (unless `replace_all` is set):

```typescript
function validateUniqueMatch(
  fileContent: string,
  oldString: string,
  replaceAll: boolean
): void {
  if (replaceAll) return; // Multiple matches are expected

  const firstIndex = fileContent.indexOf(oldString);
  if (firstIndex === -1) {
    // This shouldn't happen if earlier checks passed, but belt-and-suspenders
    throw new ToolError(
      `old_string was not found in the file. ` +
      `Make sure it matches the file content exactly, ` +
      `including whitespace and indentation.`
    );
  }

  const secondIndex = fileContent.indexOf(oldString, firstIndex + 1);
  if (secondIndex !== -1) {
    // Count total occurrences for a helpful error message
    let count = 2;
    let searchFrom = secondIndex + 1;
    while (true) {
      const next = fileContent.indexOf(oldString, searchFrom);
      if (next === -1) break;
      count++;
      searchFrom = next + 1;
    }

    throw new ToolError(
      `old_string appears ${count} times in the file. ` +
      `Include more surrounding context to make your match unique, ` +
      `or set replace_all: true to replace all ${count} occurrences.`
    );
  }
}
```

The error message includes the count of matches — "appears 7 times" tells the model how ambiguous its match was and gives it two clear paths forward.

---

## The Complete Validation Pipeline

Putting it all together, here's the validation that runs before every edit:

```typescript
async function validateEdit(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): Promise<string> {
  // Step 0: Normalize input (quotes, whitespace — Lesson 69)
  const normalized = normalizeFileEditInput({ old_string: oldString, new_string: newString });
  oldString = normalized.old_string;
  newString = normalized.new_string;

  // Step 1: Must have been read
  const readEntry = readFileState.get(filePath);
  if (!readEntry) {
    throw new ToolError(`Read ${filePath} before editing it.`);
  }

  // Step 2: Check for external modifications
  await checkForExternalModification(filePath, readEntry);

  // Step 3: Read current content
  const fileContent = await fs.readFile(filePath, "utf-8");

  // Step 4: Partial view check
  validateEditWithinView(readEntry, oldString, fileContent);

  // Step 5: Find the actual string (with normalization fallback)
  const match = findActualString(fileContent, oldString);
  if (!match.found) {
    throw new ToolError(
      `old_string not found in ${filePath}. ` +
      `Make sure it matches exactly. Use Read to verify the file contents.`
    );
  }

  // Step 6: Uniqueness check
  validateUniqueMatch(fileContent, match.actualString, replaceAll);

  // Step 7: Apply the edit
  const newContent = applyEdit(fileContent, match.actualString, newString, replaceAll);

  // Step 8: Write and update cache
  await writeTextContent(filePath, newContent);
  updateReadFileState(filePath, newContent);

  return newContent;
}
```

---

## Why This Matters: Real Failure Rates

Without the read-before-edit check, agents attempt blind edits roughly 15-20% of the time. Of those blind edits, roughly 60% fail because the `old_string` doesn't match the actual file content. That's a 9-12% overall edit failure rate from hallucinated content alone.

With the check in place, the failure rate drops to near zero for content mismatch errors. The tradeoff is an extra Read tool call, but that call costs ~500ms vs. the ~5 seconds of a failed edit + retry cycle.

```
Without read-before-edit:
  Agent attempts blind edit → 60% failure → retry with read → succeed
  Cost: 2 tool calls + error handling ≈ 8 seconds

With read-before-edit:
  Agent reads file → edits with real content → succeed
  Cost: 2 tool calls, no errors ≈ 3 seconds
```

The guardrail is faster *even though it adds a step*, because it eliminates the retry cycle.

---

## How the System Prompt Reinforces This

The tool's own description in the system prompt says:

```
You MUST read a file before editing it. If you haven't read the file
in this conversation, you MUST read it first. Editing without reading
will fail.
```

This is belt-and-suspenders design:
1. **System prompt** tells the model to read first (soft enforcement)
2. **readFileState check** rejects edits without a read (hard enforcement)
3. **Error message** tells the model to read and retry (recovery path)

---

## Key Takeaways

1. **Read-before-edit is the #1 guardrail** against hallucinated edits — the most common agent failure mode.

2. **readFileState** tracks every file read, with content and modification time.

3. **Mtime checking** detects external modifications between read and edit, with a content-comparison fallback.

4. **Partial view detection** prevents edits outside the region the model actually read.

5. **Multiple match detection** with helpful count messages guides the model toward unique matches.

6. **The guardrail is faster than no guardrail** because it eliminates the read → fail → read → retry cycle.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Defense in Depth
**Question:** The lesson describes a "belt-and-suspenders" approach with three layers: system prompt guidance, readFileState check, and instructive error messages. Explain why all three are needed — what failure mode does each layer catch that the others miss?

[View Answer](../../answers/07-file-operations/answer-70.md#exercise-1)

### Exercise 2 — External Modification Detector
**Challenge:** Write a `checkForExternalModification(filePath: string, readEntry: ReadFileEntry, currentMtime: number, readCurrentContent: () => Promise<string>)` function that implements the two-tier check: fast mtime comparison, then content comparison fallback. Return `{ modified: boolean, reason?: string }`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-70.md#exercise-2)

### Exercise 3 — Partial View Validation
**Challenge:** Write `validateEditWithinView(readEntry: ReadFileEntry, oldString: string)` that checks whether the `old_string` falls within the portion of the file that was actually read (when `offset`/`limit` were used). Throw a descriptive error if the edit targets content outside the viewed range.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-70.md#exercise-3)

### Exercise 4 — Full Validation Pipeline
**Challenge:** Combine all validation steps into a single `validateEdit` function that checks: (1) file has been read, (2) no external modifications, (3) edit is within viewed range, (4) old_string found in file, (5) match is unique. Chain them in order and return the validated file content for replacement.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-70.md#exercise-4)

---

## What's Next

When an edit succeeds, the agent needs to show the user what changed. Lesson 71 covers the **diff and patch generation** system that produces human-readable diffs from string replacements.
