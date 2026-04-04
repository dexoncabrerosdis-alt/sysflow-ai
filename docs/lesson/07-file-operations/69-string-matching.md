# Lesson 69: String Matching — Normalizing Quotes and Whitespace

## The Problem: Models and Curly Quotes

The `old_string → new_string` edit model from Lesson 68 depends on exact string matching. In theory, `indexOf(oldString)` is all you need. In practice, language models produce subtle character variations that break exact matches.

The #1 offender: **curly quotes**.

The file on disk contains:

```python
message = "Hello, world"
```

But the model generates:

```python
message = \u201cHello, world\u201d
```

Those are Unicode characters U+201C (`"`) and U+201D (`"`), called "smart quotes" or "curly quotes." Language models produce them because their training data includes rendered text, not just source code. The model doesn't even "know" it's generating a different character — both look like quotation marks.

This single issue caused enough failed edits that Claude Code built an entire normalization layer to handle it.

---

## The Solution Architecture

The matching pipeline has four stages:

```
old_string from model
        │
        ▼
┌─────────────────────┐
│ normalizeFileEditInput│ → Strip trailing whitespace, undo API sanitization
└──────────┬──────────┘
        ▼
┌─────────────────────┐
│ findActualString     │ → Try exact match, then normalized match
└──────────┬──────────┘
        ▼
┌─────────────────────┐
│ preserveQuoteStyle   │ → Rewrite new_string to match file's quote style
└──────────┬──────────┘
        ▼
    Apply replacement
```

Let's examine each stage.

---

## Stage 1: normalizeFileEditInput

Before any matching, the raw input from the model gets cleaned up:

```typescript
function normalizeFileEditInput(input: {
  old_string: string;
  new_string: string;
}): { old_string: string; new_string: string } {
  let { old_string, new_string } = input;

  // Strip trailing whitespace from each line
  // Models often add or drop trailing spaces
  old_string = stripTrailingWhitespace(old_string);
  new_string = stripTrailingWhitespace(new_string);

  // Undo API sanitization of special characters
  // Some API layers escape characters that shouldn't be escaped in code
  old_string = undoApiSanitization(old_string);
  new_string = undoApiSanitization(new_string);

  return { old_string, new_string };
}

function stripTrailingWhitespace(s: string): string {
  return s
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}
```

This handles a common source of mismatches: the model generates `"  const x = 1;  "` with trailing spaces, but the file has `"  const x = 1;"` without them. Rather than failing the edit, we normalize both sides.

---

## Stage 2: findActualString

This is the core matching function. It tries exact matching first, then falls back to normalized matching:

```typescript
function findActualString(
  fileContent: string,
  searchString: string
): { found: boolean; actualString: string; index: number } {
  // Attempt 1: Exact match
  const exactIndex = fileContent.indexOf(searchString);
  if (exactIndex !== -1) {
    return {
      found: true,
      actualString: searchString,
      index: exactIndex,
    };
  }

  // Attempt 2: Normalized match (curly quotes → straight quotes)
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedContent = normalizeQuotes(fileContent);
  const normalizedIndex = normalizedContent.indexOf(normalizedSearch);

  if (normalizedIndex !== -1) {
    // Found via normalization — extract the ACTUAL string from the file
    // (preserving the file's original characters)
    const actualString = fileContent.substring(
      normalizedIndex,
      normalizedIndex + searchString.length
    );
    return {
      found: true,
      actualString,
      index: normalizedIndex,
    };
  }

  return { found: false, actualString: "", index: -1 };
}
```

The key insight: when the normalized match succeeds, we don't use the normalized string. We extract the **actual characters from the file** at that position. This means the replacement operates on what the file really contains, not on our normalized version.

---

## The normalizeQuotes Function

```typescript
const QUOTE_MAP: Record<string, string> = {
  "\u201C": '"',  // " → "  (left double)
  "\u201D": '"',  // " → "  (right double)
  "\u2018": "'",  // ' → '  (left single)
  "\u2019": "'",  // ' → '  (right single)
  "\u2033": '"',  // ″ → "  (double prime)
  "\u2032": "'",  // ′ → '  (prime)
  "\u00AB": '"',  // « → "  (left guillemet)
  "\u00BB": '"',  // » → "  (right guillemet)
};

function normalizeQuotes(s: string): string {
  let result = s;
  for (const [curly, straight] of Object.entries(QUOTE_MAP)) {
    result = result.split(curly).join(straight);
  }
  return result;
}
```

Every Unicode quote variant gets mapped to its ASCII equivalent. This covers:

- Smart double quotes (`" "` → `"`)
- Smart single quotes (`' '` → `'`)
- Prime marks (`′ ″` → `' "`)
- Guillemets (`« »` → `"`)

---

## Stage 3: preserveQuoteStyle

After finding the match, we need to ensure the `new_string` uses the same quote style as the file:

```typescript
function preserveQuoteStyle(
  fileContent: string,
  oldString: string,
  newString: string
): string {
  // Detect the file's dominant quote style
  const straightDoubleCount = (fileContent.match(/"/g) || []).length;
  const straightSingleCount = (fileContent.match(/'/g) || []).length;

  // If the model sent curly quotes in new_string, convert to straight
  let result = newString;
  for (const [curly, straight] of Object.entries(QUOTE_MAP)) {
    result = result.split(curly).join(straight);
  }

  return result;
}
```

This prevents the model from introducing curly quotes into source code. Even if the model generated:

```
"Hello, world"
```

The written output will be:

```
"Hello, world"
```

---

## The Full Pipeline in Action

Let's trace a real example. File on disk (`config.py`):

```python
DATABASE_URL = "postgres://localhost:5432/mydb"
API_KEY = "sk-abc123"
```

Model sends this edit:

```json
{
  "old_string": "DATABASE_URL = \u201cpostgres://localhost:5432/mydb\u201d",
  "new_string": "DATABASE_URL = \u201cpostgres://prod-server:5432/mydb\u201d"
}
```

The model used curly quotes (`" "`) instead of straight quotes (`" "`).

**Step 1: normalizeFileEditInput**
- Strips trailing whitespace (none in this case)
- `old_string` and `new_string` preserved as-is (sanitization doesn't affect quotes)

**Step 2: findActualString**
- Exact match: `indexOf("DATABASE_URL = \u201cpostgres://...")` → **-1** (file has straight quotes)
- Normalize both: `"DATABASE_URL = \"postgres://..."` and file normalized similarly
- Normalized match: **found at index 0**
- Extract actual string from file: `"DATABASE_URL = \"postgres://localhost:5432/mydb\""`

**Step 3: preserveQuoteStyle**
- Convert curly quotes in `new_string` to straight: `"DATABASE_URL = \"postgres://prod-server:5432/mydb\""`

**Step 4: Apply replacement**
- Replace the actual string in the file with the style-preserved new string
- Result: `DATABASE_URL = "postgres://prod-server:5432/mydb"`

The edit succeeds despite the model generating wrong quote characters.

---

## Edge Case: Mixed Quote Styles

Some files legitimately use both quote styles:

```javascript
const message = "Hello, it's a beautiful day";
const template = `She said "hello"`;
```

The normalization only applies to the *matching* phase. The actual replacement preserves whatever the model explicitly wrote (after curly-to-straight conversion). The system doesn't try to enforce a single style across the file.

---

## Edge Case: Trailing Whitespace Differences

```typescript
// File has:
"function hello() {\n  return true;\n}\n"
//                                    ^ trailing newline

// Model sends old_string:
"function hello() {\n  return true;\n}"
//                                    ^ no trailing newline
```

The `stripTrailingWhitespace` normalization handles trailing spaces *within* lines, but not trailing newlines at the end of the string. For end-of-string differences, the matching uses a separate tolerance:

```typescript
function fuzzyEndingMatch(
  fileContent: string,
  searchString: string
): number {
  // Try with and without trailing newline
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

---

## Why Not Just Normalize Everything?

You might wonder: why not normalize all whitespace, all case, all characters? Because over-normalization causes **false matches**:

```python
count = 0    # Variable tracking count
count = 0    # Different variable in a different scope
```

If we normalized away indentation, these would match — and the edit would be ambiguous. The normalization layer only handles known, systematic distortions that models produce. It doesn't try to be "fuzzy search."

---

## Performance Consideration

Normalization adds overhead to every edit. For small files, this is negligible. For large files, normalizing the entire content could be slow:

```typescript
const MAX_NORMALIZE_SIZE = 1024 * 1024; // 1MB

function findActualString(fileContent: string, searchString: string) {
  // Fast path: exact match
  const exactIndex = fileContent.indexOf(searchString);
  if (exactIndex !== -1) {
    return { found: true, actualString: searchString, index: exactIndex };
  }

  // Slow path: normalize (skip for very large files)
  if (fileContent.length > MAX_NORMALIZE_SIZE) {
    return { found: false, actualString: "", index: -1 };
  }

  // ... normalization path
}
```

The exact match path (`indexOf`) runs first and is O(n). Normalization only triggers when exact matching fails.

---

## Key Takeaways

1. **Curly quotes are the #1 cause of edit failures** — language models produce them because their training data includes rendered text.

2. **normalizeQuotes()** maps all Unicode quote variants to ASCII equivalents for matching purposes.

3. **findActualString()** tries exact match first, then falls back to normalized matching — extracting the actual file characters at the match location.

4. **preserveQuoteStyle()** ensures the replacement string uses straight quotes even if the model generated curly ones.

5. **Normalization is conservative** — only known model-produced distortions are handled, not arbitrary fuzzy matching.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Quote Normalization Map
**Question:** Why does the `QUOTE_MAP` include guillemets (`« »`) and prime marks (`′ ″`) in addition to smart quotes? Under what circumstances would a language model produce these characters in code?

[View Answer](../../answers/07-file-operations/answer-69.md#exercise-1)

### Exercise 2 — Implement normalizeQuotes
**Challenge:** Write the `normalizeQuotes(s: string)` function that maps all Unicode quote variants to their ASCII equivalents. Include at least 6 mappings covering double quotes, single quotes, and prime marks. Then write a test case demonstrating a match that fails without normalization but succeeds with it.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-69.md#exercise-2)

### Exercise 3 — Full findActualString Pipeline
**Challenge:** Implement `findActualString(fileContent: string, searchString: string)` with the two-attempt strategy: exact match first, then normalized match. When the normalized match succeeds, extract the actual characters from the file at the matched position.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-69.md#exercise-3)

### Exercise 4 — Trailing Whitespace Normalization
**Challenge:** Write `stripTrailingWhitespace(s: string)` that removes trailing spaces/tabs from each line but preserves line structure. Then write `fuzzyEndingMatch(fileContent: string, searchString: string)` that tries matching with and without a trailing newline.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-69.md#exercise-4)

### Exercise 5 — Over-Normalization Trap
**Question:** The lesson warns against normalizing "too much." Give a concrete example where normalizing indentation (tabs vs spaces) would cause a false match that edits the wrong code. Show the file content, the old_string, and which of the two identical-looking lines would be incorrectly matched.

[View Answer](../../answers/07-file-operations/answer-69.md#exercise-5)

---

## What's Next

Matching the right string is only half the battle. Lesson 70 covers the **read-before-edit validation** — the system that prevents the model from editing files it has never seen, detecting external modifications, and handling partial views.
