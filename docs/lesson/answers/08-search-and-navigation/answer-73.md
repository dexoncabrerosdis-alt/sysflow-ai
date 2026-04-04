# Answers: Lesson 73 — GrepTool (Ripgrep)

## Exercise 1
**Question:** What are the three output modes of GrepTool and when would you use each one during a typical refactoring task?

**Answer:** The three output modes are `content` (default), `files_with_matches`, and `count`. During a refactoring task — say renaming a function — you'd use `count` first to gauge scope ("this function appears in 15 files — this is a big rename"). Then use `files_with_matches` to get the list of affected files without cluttering context with every matching line. Finally, use `content` mode with context lines on specific files to see the actual code around each usage before making edits.

---

## Exercise 2
**Challenge:** Write GrepTool calls that find all `async function` declarations in TypeScript files, showing 2 lines of context after each match. Then write a second call that counts how many files contain async functions.

**Answer:**
```typescript
// Find all async function declarations with 2 lines of context after
GrepTool({
  pattern: "async function \\w+",
  glob: "*.ts",
  "-A": 2,
})

// Count how many files contain async functions
GrepTool({
  pattern: "async function \\w+",
  glob: "*.ts",
  output_mode: "count",
})
```
**Explanation:** The first call uses `"-A": 2` to show 2 lines after each match, which reveals the function's parameters and opening logic. The `glob: "*.ts"` restricts to TypeScript files. The second call uses `output_mode: "count"` to return just file-level counts, which is useful for understanding how widespread async functions are before deciding on a refactoring strategy.

---

## Exercise 3
**Challenge:** Implement an `buildRipgrepArgs` function that takes a `GrepInput` object and returns an array of command-line arguments for ripgrep.

**Answer:**
```typescript
interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  head_limit?: number;
  offset?: number;
  "-B"?: number;
  "-A"?: number;
  "-C"?: number;
  "-i"?: boolean;
  multiline?: boolean;
}

function buildRipgrepArgs(input: GrepInput): string[] {
  const args: string[] = [];

  args.push("--regexp", input.pattern);

  switch (input.output_mode) {
    case "files_with_matches":
      args.push("--files-with-matches");
      break;
    case "count":
      args.push("--count");
      break;
    default:
      args.push("--line-number", "--column");
      break;
  }

  if (input["-B"]) args.push("-B", String(input["-B"]));
  if (input["-A"]) args.push("-A", String(input["-A"]));
  if (input["-C"]) args.push("-C", String(input["-C"]));
  if (input["-i"]) args.push("--ignore-case");

  if (input.multiline) {
    args.push("--multiline", "--multiline-dotall");
  }

  if (input.glob) args.push("--glob", input.glob);

  args.push("--glob", "!.git/**");
  args.push("--", input.path || ".");

  return args;
}
```
**Explanation:** The function maps each GrepInput field to the corresponding ripgrep CLI flag. The `output_mode` switch handles the three modes differently — content mode needs `--line-number` and `--column` while the others use their own flags. The `.git` exclusion is always applied via `--glob "!.git/**"`. The `--` separator before the path prevents the path from being interpreted as a flag.

---

## Exercise 4
**Challenge:** Write a GrepTool call using multiline mode to find TypeScript interface definitions containing `createdAt`. Then write a `processGrepOutput` function with pagination.

**Answer:**
```typescript
// Multiline search for interfaces with createdAt
GrepTool({
  pattern: "interface \\w+ \\{[\\s\\S]*?createdAt",
  multiline: true,
  glob: "*.ts",
})

// Pagination processor
function processGrepOutput(
  rawOutput: string,
  headLimit: number,
  offset: number
): string {
  const lines = rawOutput.split("\n").filter((l) => l.length > 0);

  const afterOffset = lines.slice(offset);

  const limited =
    headLimit > 0 ? afterOffset.slice(0, headLimit) : afterOffset;

  let output = limited.join("\n");

  if (afterOffset.length > limited.length) {
    const remaining = afterOffset.length - limited.length;
    output +=
      `\n\n... ${remaining} more results. ` +
      `Use offset=${offset + headLimit} to see more.`;
  }

  return output;
}
```
**Explanation:** The multiline GrepTool call uses `[\s\S]*?` (non-greedy match of any character including newlines) to span from the interface opening brace to the `createdAt` field. The `processGrepOutput` function first applies the offset to skip already-seen results, then caps at `head_limit`. When truncated, it appends a notice with the exact `offset` value needed for the next page, guiding the model toward pagination.
