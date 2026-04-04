# Lesson 73: GrepTool — Searching File Contents with Ripgrep

## The Need for Content Search

In Module 07, we learned how to read, write, and edit files — but only when the agent already knows *which* file to target. In real coding tasks, the agent often needs to find things first:

- "Where is the `handleAuth` function defined?"
- "Which files import the `Database` class?"
- "Find all TODO comments in the codebase"

This is what GrepTool does. It wraps **ripgrep** (`rg`) — one of the fastest code search tools ever built — and exposes it to the agent through a structured Zod schema.

---

## The Zod Input Schema

```typescript
const inputSchema = z.strictObject({
  pattern: z
    .string()
    .describe("Regular expression pattern to search for"),
  path: z
    .string()
    .optional()
    .describe(
      "Directory or file to search in. Defaults to the current working directory."
    ),
  glob: z
    .string()
    .optional()
    .describe(
      'File glob pattern to filter (e.g., "*.ts", "*.{js,jsx}")'
    ),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .optional()
    .default("content")
    .describe(
      "content: show matching lines. " +
      "files_with_matches: show only file paths. " +
      "count: show match counts per file."
    ),
  head_limit: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(250)
    .describe("Maximum number of results to return. 0 for unlimited."),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(0)
    .describe("Number of results to skip (for pagination)"),
  "-B": z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Lines of context before each match"),
  "-A": z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Lines of context after each match"),
  "-C": z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Lines of context before AND after each match"),
  "-i": z
    .boolean()
    .optional()
    .default(false)
    .describe("Case-insensitive search"),
  multiline: z
    .boolean()
    .optional()
    .default(false)
    .describe("Enable multiline matching (pattern can span lines)"),
});
```

This is one of the richest schemas in the toolset. Let's break down why each field exists.

---

## Safety Properties

```typescript
export class GrepTool extends Tool {
  get isConcurrencySafe(): boolean {
    return true;  // Searches don't modify anything
  }

  get isReadOnly(): boolean {
    return true;  // Pure read operation
  }
}
```

Like FileReadTool, GrepTool is both concurrency-safe and read-only. The agent can run multiple grep searches in parallel — for example, searching for a function definition and its usages simultaneously.

---

## The Ripgrep Backend

GrepTool doesn't implement its own search algorithm. It shells out to `rg` (ripgrep), which is:

- **Fast**: Uses memory-mapped I/O and SIMD-accelerated regex
- **Smart**: Respects `.gitignore` automatically
- **Safe**: Skips binary files by default

```typescript
async function executeGrep(input: GrepInput): Promise<string> {
  const args: string[] = [];

  // Core pattern
  args.push("--regexp", input.pattern);

  // Output mode
  switch (input.output_mode) {
    case "files_with_matches":
      args.push("--files-with-matches");
      break;
    case "count":
      args.push("--count");
      break;
    default: // "content"
      args.push("--line-number");
      args.push("--column");
      break;
  }

  // Context lines
  if (input["-B"]) args.push("-B", String(input["-B"]));
  if (input["-A"]) args.push("-A", String(input["-A"]));
  if (input["-C"]) args.push("-C", String(input["-C"]));

  // Case sensitivity
  if (input["-i"]) args.push("--ignore-case");

  // Multiline
  if (input.multiline) {
    args.push("--multiline");
    args.push("--multiline-dotall");
  }

  // File glob filter
  if (input.glob) args.push("--glob", input.glob);

  // VCS directory exclusion
  args.push("--glob", "!.git/**");

  // Search path
  args.push("--", input.path || ".");

  const result = await execFile("rg", args);
  return result.stdout;
}
```

### VCS Directory Exclusion

Note the `--glob "!.git/**"` argument. The tool explicitly excludes version control directories. Without this, searching for a string might return thousands of matches from `.git/objects/` — compressed object files that happen to contain the search string.

Ripgrep already respects `.gitignore` by default, so `node_modules/`, `dist/`, and other ignored directories are automatically excluded.

---

## Output Modes

### Content Mode (Default)

Shows matching lines with file paths and line numbers:

```
src/auth/handler.ts:42:  async function handleAuth(request: Request) {
src/auth/handler.ts:43:    const token = request.headers.get("Authorization");
src/middleware/auth.ts:15:  // handleAuth is called from middleware
```

### Files With Matches Mode

Shows only file paths (one per line):

```
src/auth/handler.ts
src/middleware/auth.ts
src/tests/auth.test.ts
```

This is useful when the model needs to know *which files* contain something, then read specific ones.

### Count Mode

Shows match counts per file:

```
src/auth/handler.ts:3
src/middleware/auth.ts:1
src/tests/auth.test.ts:7
```

Useful for understanding the scope of a change — "this function is referenced in 15 files" tells the model whether a rename is simple or complex.

---

## Context Lines: -B, -A, -C

Context lines are crucial for understanding matches. Finding `return null;` alone tells you nothing — but with 3 lines of context:

```typescript
// GrepTool({ pattern: "return null", "-C": 3 })

src/auth/handler.ts
40-  async function validateToken(token: string) {
41-    if (!token) {
42:      return null;
43-    }
44-    const decoded = jwt.verify(token, SECRET);
45-    return decoded;
```

Now the model can see the function name, the condition, and the surrounding logic. The `-C 3` flag maps directly to ripgrep's context flag.

The `-B` (before) and `-A` (after) flags allow asymmetric context — useful when you need to see the function signature (before) but not much after the match.

---

## Case Sensitivity and Multiline

### Case-Insensitive Search

```typescript
// Find "error", "Error", "ERROR", etc.
GrepTool({ pattern: "error", "-i": true })
```

### Multiline Patterns

Standard regex matches within single lines. Multiline mode lets patterns span lines:

```typescript
// Find struct definitions with a specific field
GrepTool({
  pattern: "struct Config \\{[\\s\\S]*?timeout",
  multiline: true,
})
```

This would match:

```rust
struct Config {
    host: String,
    port: u16,
    timeout: Duration,
}
```

Multiline mode enables `--multiline --multiline-dotall` in ripgrep, making `.` match newlines and allowing patterns to cross line boundaries.

---

## Processing the Output

After ripgrep returns results, the tool processes them for the model:

```typescript
function processGrepOutput(
  rawOutput: string,
  headLimit: number,
  offset: number,
  outputMode: string
): string {
  const lines = rawOutput.split("\n").filter((l) => l.length > 0);

  // Apply offset (skip first N results)
  const afterOffset = lines.slice(offset);

  // Apply head_limit (cap results)
  const limited =
    headLimit > 0 ? afterOffset.slice(0, headLimit) : afterOffset;

  // Build output with truncation notice
  let output = limited.join("\n");

  if (afterOffset.length > limited.length) {
    output += `\n\n... ${afterOffset.length - limited.length} more results. ` +
      `Use offset=${offset + headLimit} to see more.`;
  }

  return output;
}
```

The "more results" notice is important — it tells the model there's more data available and exactly how to get it (using `offset`). We'll explore this pagination system in detail in Lesson 76.

---

## Real-World Usage Patterns

### Finding Function Definitions

```typescript
GrepTool({
  pattern: "function handleAuth\\(",
  glob: "*.ts",
})
```

### Finding All Imports of a Module

```typescript
GrepTool({
  pattern: "from ['\"]@/utils/auth['\"]",
  output_mode: "files_with_matches",
})
```

### Finding Configuration Values

```typescript
GrepTool({
  pattern: "DATABASE_URL|DB_HOST|DB_PORT",
  glob: "*.{env,yaml,json,toml}",
})
```

### Counting Test Coverage

```typescript
GrepTool({
  pattern: "it\\(|test\\(|describe\\(",
  output_mode: "count",
  glob: "*.test.*",
})
```

---

## Error Handling

```typescript
async function execute(input: GrepInput): Promise<string> {
  try {
    const output = await executeGrep(input);
    return processGrepOutput(output, input.head_limit, input.offset, input.output_mode);
  } catch (err) {
    if (err.exitCode === 1) {
      // ripgrep exit code 1 = no matches found
      return "No matches found.";
    }
    if (err.exitCode === 2) {
      // ripgrep exit code 2 = error (bad pattern, etc.)
      throw new ToolError(
        `Invalid search pattern: ${err.stderr}. ` +
        `Make sure the pattern is valid regex.`
      );
    }
    throw err;
  }
}
```

Ripgrep uses exit codes meaningfully: 0 = matches found, 1 = no matches, 2 = error. The tool translates these into appropriate responses — "No matches found" for code 1, a helpful error for code 2.

---

## Key Takeaways

1. **GrepTool wraps ripgrep** — one of the fastest code search tools, with automatic `.gitignore` respect and binary file skipping.

2. **Three output modes** serve different needs: content for understanding, files_with_matches for targeting, count for scoping.

3. **Context lines (-B/-A/-C)** provide surrounding code that helps the model understand matches in context.

4. **Multiline mode** enables cross-line pattern matching for structural searches.

5. **Concurrency-safe and read-only** — the agent can run multiple searches in parallel.

6. **Pagination** via `head_limit` and `offset` handles large result sets (covered in depth in Lesson 76).

---

## What's Next

GrepTool searches file *contents*. But sometimes the agent needs to find files by *name* — "find all test files," "find package.json." That's what GlobTool does, and it's the subject of Lesson 74.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Three Output Modes
**Question:** What are the three output modes of GrepTool and when would you use each one during a typical refactoring task?

[View Answer](../../answers/08-search-and-navigation/answer-73.md#exercise-1)

### Exercise 2 — Find All Async Functions
**Challenge:** Write GrepTool calls that find all `async function` declarations in TypeScript files, showing 2 lines of context after each match. Then write a second call that counts how many files contain async functions.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-73.md#exercise-2)

### Exercise 3 — Build a Ripgrep Argument Builder
**Challenge:** Implement an `buildRipgrepArgs` function that takes a `GrepInput` object and returns an array of command-line arguments for ripgrep. Handle all fields: pattern, output_mode, context lines (-B/-A/-C), case sensitivity, multiline, glob filter, and .git exclusion.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-73.md#exercise-3)

### Exercise 4 — Multiline Struct Search
**Challenge:** Write a GrepTool call using multiline mode that finds all TypeScript interface definitions that contain a `createdAt` field. Then write a `processGrepOutput` function that applies `offset` and `head_limit` to raw output and appends a "more results" notice when truncated.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-73.md#exercise-4)
