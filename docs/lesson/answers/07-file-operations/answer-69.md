# Answers: Lesson 69 — String Matching

## Exercise 1
**Question:** Why does the QUOTE_MAP include guillemets and prime marks?

**Answer:** Language models are trained on diverse text corpora that include French text (which uses guillemets for quotation), mathematical notation (which uses prime marks for derivatives like f′(x)), and typeset documentation where these characters appear naturally. When the model generates code, it sometimes "bleeds" these characters from its training data — especially when the conversation includes mathematical discussion, European-language content, or documentation excerpts. Including them in the normalization map ensures that even rare character substitutions don't cause edit failures.

---

## Exercise 2
**Challenge:** Write the `normalizeQuotes` function with test case.

**Answer:**

```typescript
const QUOTE_MAP: Record<string, string> = {
  "\u201C": '"',  // " left double curly
  "\u201D": '"',  // " right double curly
  "\u2018": "'",  // ' left single curly
  "\u2019": "'",  // ' right single curly
  "\u2033": '"',  // ″ double prime
  "\u2032": "'",  // ′ single prime
  "\u00AB": '"',  // « left guillemet
  "\u00BB": '"',  // » right guillemet
};

function normalizeQuotes(s: string): string {
  let result = s;
  for (const [curly, straight] of Object.entries(QUOTE_MAP)) {
    result = result.split(curly).join(straight);
  }
  return result;
}

// Test case:
const fileContent = 'const msg = "Hello, world";';
const modelSearch = 'const msg = \u201CHello, world\u201D;'; // curly quotes

// Without normalization:
console.log(fileContent.indexOf(modelSearch)); // -1 (FAIL)

// With normalization:
console.log(normalizeQuotes(fileContent).indexOf(normalizeQuotes(modelSearch))); // 0 (SUCCESS)
```

**Explanation:** The function iterates through all known Unicode quote variants and replaces each with its ASCII equivalent. The test case shows the exact scenario from the lesson — curly quotes in the model's output vs straight quotes in the file.

---

## Exercise 3
**Challenge:** Implement `findActualString` with two-attempt strategy.

**Answer:**

```typescript
interface MatchResult {
  found: boolean;
  actualString: string;
  index: number;
}

function findActualString(
  fileContent: string,
  searchString: string
): MatchResult {
  // Attempt 1: Exact match
  const exactIndex = fileContent.indexOf(searchString);
  if (exactIndex !== -1) {
    return { found: true, actualString: searchString, index: exactIndex };
  }

  // Attempt 2: Normalized match
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedContent = normalizeQuotes(fileContent);
  const normalizedIndex = normalizedContent.indexOf(normalizedSearch);

  if (normalizedIndex !== -1) {
    const actualString = fileContent.substring(
      normalizedIndex,
      normalizedIndex + searchString.length
    );
    return { found: true, actualString, index: normalizedIndex };
  }

  return { found: false, actualString: "", index: -1 };
}
```

**Explanation:** The critical detail is that when the normalized match succeeds, we extract the *actual characters from the file* at the matched position — not the normalized version. This means the replacement will operate on the real file content, preserving whatever quote style the file actually uses.

---

## Exercise 4
**Challenge:** Write `stripTrailingWhitespace` and `fuzzyEndingMatch`.

**Answer:**

```typescript
function stripTrailingWhitespace(s: string): string {
  return s
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

function fuzzyEndingMatch(
  fileContent: string,
  searchString: string
): number {
  const variants = [
    searchString,
    searchString + "\n",
    searchString.replace(/\n$/, ""),
  ];

  for (const variant of variants) {
    const index = fileContent.indexOf(variant);
    if (index !== -1) return index;
  }

  return -1;
}
```

**Explanation:** `stripTrailingWhitespace` processes each line independently, removing trailing spaces and tabs while preserving the line structure. `fuzzyEndingMatch` tries three variants of the search string — as-is, with a trailing newline appended, and with a trailing newline removed — to handle the common mismatch where the model includes/excludes a final newline differently from the file.

---

## Exercise 5
**Question:** Give a concrete example where normalizing indentation would cause a false match.

**Answer:**

```python
# File content:
class Outer:
    count = 0    # Instance counter (uses 4-space indent)

    class Inner:
        count = 0    # Separate counter (uses 8-space indent)
```

If the model sends `old_string = "count = 0"` intending to edit the `Inner` class's counter, and we normalized indentation by stripping leading whitespace, both `    count = 0` (line 2) and `        count = 0` (line 5) would match the same normalized string `"count = 0"`. The edit would ambiguously match line 2 (the `Outer` counter) instead of line 5 (the `Inner` counter), silently modifying the wrong variable. This is why normalization is limited to known model-produced distortions (curly quotes, trailing whitespace) and doesn't touch indentation.
