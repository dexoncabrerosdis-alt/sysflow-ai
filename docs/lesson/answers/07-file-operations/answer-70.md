# Answers: Lesson 70 — Read Before Edit

## Exercise 1
**Question:** Why are all three defense layers needed?

**Answer:** **System prompt** catches the common case: most of the time, the model follows instructions and reads before editing. But models sometimes ignore instructions, especially under complex multi-step reasoning. The system prompt alone has a ~15-20% failure rate for blind edits. **readFileState check** is the hard enforcement. Even when the model ignores the prompt, the tool rejects the edit programmatically. This catches 100% of cases where no read occurred. However, it doesn't help the model recover — it just fails. **Instructive error messages** provide the recovery path. When the hard check triggers, the error tells the model exactly what to do: "Use the Read tool to read the file first, then retry." Without this, the model might try a different (wrong) approach instead of simply reading the file. Each layer addresses a different gap: the prompt prevents most failures, the check catches the rest, and the error message ensures recovery.

---

## Exercise 2
**Challenge:** Write a `checkForExternalModification` function.

**Answer:**

```typescript
interface ReadFileEntry {
  content: string;
  mtime: number;
  readTime: number;
}

interface ModificationCheck {
  modified: boolean;
  reason?: string;
}

async function checkForExternalModification(
  filePath: string,
  readEntry: ReadFileEntry,
  currentMtime: number,
  readCurrentContent: () => Promise<string>
): Promise<ModificationCheck> {
  // Fast path: mtime hasn't changed
  if (currentMtime === readEntry.mtime) {
    return { modified: false };
  }

  // Fallback: mtime changed, but did content actually change?
  const currentContent = await readCurrentContent();

  if (currentContent !== readEntry.content) {
    return {
      modified: true,
      reason:
        `File ${filePath} was modified since last read ` +
        `(read at ${new Date(readEntry.readTime).toISOString()}, ` +
        `modified at ${new Date(currentMtime).toISOString()}). ` +
        `Please read it again before editing.`,
    };
  }

  // mtime changed but content is identical (e.g., touch command)
  return { modified: false };
}
```

**Explanation:** The two-tier check is efficient: the mtime comparison is a fast metadata check with no I/O. Only when mtimes differ does the function read the actual file content. This handles edge cases like `touch` (mtime changes, content doesn't) and coarse-grained filesystem timestamps (content changes, mtime appears identical).

---

## Exercise 3
**Challenge:** Write `validateEditWithinView`.

**Answer:**

```typescript
function validateEditWithinView(
  readEntry: ReadFileEntry,
  oldString: string
): void {
  // If the full file was read, no restrictions
  if (readEntry.offset === undefined && readEntry.limit === undefined) {
    return;
  }

  const viewedContent = readEntry.content;

  if (!viewedContent.includes(oldString)) {
    const startLine = readEntry.offset ?? 1;
    const endLine = startLine + (readEntry.limit ?? 0);

    throw new Error(
      `The old_string you're trying to replace was not in the portion ` +
      `of the file you read (lines ${startLine} to ${endLine}). ` +
      `Read the relevant section first, or read the entire file.`
    );
  }
}
```

**Explanation:** When the model uses `offset`/`limit` for partial reads, it only has a window into the file. This function checks that the edit target falls within that window. The error message tells the model exactly which lines it read, so it can adjust its next Read call to cover the target location.

---

## Exercise 4
**Challenge:** Combine all validation steps into a single `validateEdit` function.

**Answer:**

```typescript
async function validateEdit(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  readCache: ReadFileStateCache,
  readFile: (path: string) => Promise<string>,
  getFileMtime: (path: string) => Promise<number>
): Promise<string> {
  // Step 1: Must have been read
  const readEntry = readCache.getEntry(filePath);
  if (!readEntry) {
    throw new Error(
      `You must read the file before editing it. ` +
      `Use the Read tool to read ${filePath} first, then retry.`
    );
  }

  // Step 2: Check for external modifications
  const currentMtime = await getFileMtime(filePath);
  const modCheck = await checkForExternalModification(
    filePath, readEntry, currentMtime, () => readFile(filePath)
  );
  if (modCheck.modified) {
    throw new Error(modCheck.reason!);
  }

  // Step 3: Read current content
  const fileContent = await readFile(filePath);

  // Step 4: Partial view check
  validateEditWithinView(readEntry, oldString);

  // Step 5: Find the string (with normalization fallback)
  const match = findActualString(fileContent, oldString);
  if (!match.found) {
    throw new Error(
      `old_string not found in ${filePath}. ` +
      `Make sure it matches exactly. Use Read to verify file contents.`
    );
  }

  // Step 6: Uniqueness check
  if (!replaceAll) {
    const uniqueCheck = findUniqueMatch(fileContent, match.actualString);
    if (!uniqueCheck.isUnique) {
      throw new Error(
        `old_string appears ${uniqueCheck.totalMatches} times. ` +
        `Include more context to make it unique, or use replace_all: true.`
      );
    }
  }

  // All checks passed — return the file content for replacement
  return fileContent;
}
```

**Explanation:** The function chains all five validation steps in order from cheapest/most likely to fail to most expensive. Each step's error message follows the "error messages as prompts" pattern, giving the model a clear path to recovery. The function returns the validated file content, ready for the caller to apply the replacement.
