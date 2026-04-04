# Answers: Lesson 68 — The File Edit Model

## Exercise 1
**Question:** Give one failure scenario for each of the first three approaches that string replacement avoids.

**Answer:** **Line-based:** The model reads a file, then edits line 50 (inserting 3 lines). It then tries to edit "line 80" — but line 80 has shifted to line 83. The edit hits the wrong code. String replacement targets content, not line numbers, so prior insertions don't affect it. **Diff/patch:** The model generates a unified diff but gets the `@@` hunk header line numbers wrong (e.g., `@@ -14,7 +14,8 @@` when it should be `+14,9`). The patch fails to apply. String replacement has no line number headers to get wrong. **Full rewrite:** The model rewrites a 200-line file but forgets to include lines 150-160 (a utility function it didn't "remember"). Those lines are silently deleted. String replacement only touches the matched region — everything else is preserved verbatim.

---

## Exercise 2
**Challenge:** Write the `applyEdit` function.

**Answer:**

```typescript
function applyEdit(
  fileContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): string {
  if (oldString.length === 0) {
    throw new Error(
      "old_string cannot be empty. To insert at a specific location, " +
      "include surrounding text in old_string and new_string."
    );
  }

  if (oldString === newString) {
    throw new Error(
      "old_string and new_string are identical. No changes needed."
    );
  }

  if (replaceAll) {
    if (!fileContent.includes(oldString)) {
      throw new Error("old_string not found in file.");
    }
    return fileContent.split(oldString).join(newString);
  }

  const index = fileContent.indexOf(oldString);
  if (index === -1) {
    throw new Error(
      "old_string not found in file. Make sure it matches exactly, " +
      "including whitespace and indentation."
    );
  }

  const secondIndex = fileContent.indexOf(oldString, index + 1);
  if (secondIndex !== -1) {
    let count = 2;
    let searchFrom = secondIndex + 1;
    while (fileContent.indexOf(oldString, searchFrom) !== -1) {
      count++;
      searchFrom = fileContent.indexOf(oldString, searchFrom) + 1;
    }
    throw new Error(
      `old_string appears ${count} times in the file. ` +
      `Include more surrounding context to make it unique, ` +
      `or use replace_all: true to replace all ${count} occurrences.`
    );
  }

  return (
    fileContent.substring(0, index) +
    newString +
    fileContent.substring(index + oldString.length)
  );
}
```

**Explanation:** The function validates inputs first (empty check, identity check), then branches on `replaceAll`. In single-match mode, it enforces uniqueness with a count of total occurrences for an informative error message. The replacement uses `substring` for clean string construction.

---

## Exercise 3
**Challenge:** Write exact old_string and new_string values for two sequential edits.

**Answer:**

Edit 1 — Add `async` to the handler:
```typescript
// old_string:
'app.get("/users", (req, res) => {\n  res.json(getUsers());\n});'

// new_string:
'app.get("/users", async (req, res) => {\n  res.json(await getUsers());\n});'
```

Edit 2 — Add cors import (after edit 1 has been applied):
```typescript
// old_string:
'import express from "express";\n\nconst app'

// new_string:
'import express from "express";\nimport cors from "cors";\n\nconst app'
```

**Explanation:** Each `old_string` includes enough context to be unique. Edit 1 captures the full handler. Edit 2 uses an insertion pattern — the surrounding context (`import express...` and `const app`) anchors the insertion point. Note that edit 2's `old_string` is still valid after edit 1 because edit 1 only modified code below the import section.

---

## Exercise 4
**Challenge:** Write a `findUniqueMatch` function.

**Answer:**

```typescript
function findUniqueMatch(
  content: string,
  searchString: string
): { index: number; isUnique: boolean; totalMatches: number } {
  const firstIndex = content.indexOf(searchString);

  if (firstIndex === -1) {
    return { index: -1, isUnique: false, totalMatches: 0 };
  }

  let totalMatches = 1;
  let searchFrom = firstIndex + 1;

  while (true) {
    const nextIndex = content.indexOf(searchString, searchFrom);
    if (nextIndex === -1) break;
    totalMatches++;
    searchFrom = nextIndex + 1;
  }

  return {
    index: firstIndex,
    isUnique: totalMatches === 1,
    totalMatches,
  };
}
```

**Explanation:** The function finds the first occurrence and then continues scanning for additional matches to get the total count. This allows the caller to provide a helpful error message like "appears 7 times" when the match isn't unique. The loop terminates when `indexOf` returns -1.
