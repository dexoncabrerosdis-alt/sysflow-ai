# Answers: Lesson 35 — Creating a Custom Tool

## Exercise 1
**Question:** List the 10-item checklist and explain what goes wrong if you skip each item.

**Answer:**

1. **Name is PascalCase, concise, and unique.** If not PascalCase, it breaks naming conventions and looks inconsistent. If not unique, it collides with another tool and one gets silently overwritten.

2. **Description explains what, when, and how.** If vague or missing, the model doesn't know when to use the tool or misuses it — calling it in wrong situations or with wrong intent.

3. **inputSchema has `.describe()` on every field.** Without descriptions, the model guesses at field semantics. It might pass a relative path when absolute is needed, or a filename when a directory is expected.

4. **isReadOnly is correct.** If a write tool is marked read-only, it bypasses permission checks entirely — the user is never asked before destructive operations. If a read tool is marked write, users get unnecessary prompts for safe operations.

5. **isConcurrencySafe is correct.** If an unsafe tool is marked safe, concurrent execution causes race conditions and data corruption. If a safe tool is marked unsafe, it runs serially when it could parallelize, reducing performance.

6. **call() handles errors gracefully.** If the call function throws unhandled exceptions, the error may crash the pipeline or produce unhelpful error messages that prevent the model from self-correcting.

7. **validateInput() catches what Zod can't.** Without custom validation, inputs like path traversal attacks (`../../etc/passwd`), null bytes, or semantically invalid combinations slip through schema validation.

8. **maxResultSizeChars is appropriate.** Too high floods the context window with one result, crowding out previous context. Too low truncates useful information. Missing entirely defaults to 30K, which may be wrong.

9. **Tool is registered in `getAllBaseTools()`.** If you forget this, the tool exists in code but the model never sees it. It silently does nothing.

10. **Tests cover happy path, errors, and edge cases.** Without tests, bugs hide until users hit them. Edge cases (empty input, huge files, permission denied) are especially common in tool execution.

---

## Exercise 2
**Challenge:** Build a complete `GitStatus` tool.

**Answer:**

```typescript
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { buildTool, Tool, ToolContext } from "../Tool";

const execFileAsync = promisify(execFile);

const GitStatusInputSchema = z.object({
  directory: z.string().optional().describe(
    "Directory to check git status in. Defaults to the current working directory."
  ),
  show_branch: z.boolean().optional().default(true).describe(
    "Include current branch name in the output. Defaults to true."
  ),
});

type GitStatusInput = z.infer<typeof GitStatusInputSchema>;

export const GitStatusTool: Tool = buildTool({
  name: "GitStatus",
  description:
    "Show the current Git status of a repository. Returns a structured " +
    "summary of modified, added, deleted, and untracked files, plus the " +
    "current branch name. Use this to understand what has changed before " +
    "committing or to verify changes after editing files.",

  aliases: ["git-status"],
  inputSchema: GitStatusInputSchema,

  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 10_000,

  async validateInput(input: GitStatusInput) {
    if (input.directory && input.directory.includes("\0")) {
      return { valid: false, message: "Directory path contains null bytes" };
    }
    return { valid: true };
  },

  async call(input: GitStatusInput, context: ToolContext): Promise<string> {
    const cwd = input.directory
      ? path.resolve(context.options.cwd, input.directory)
      : context.options.cwd;

    const results: string[] = [];

    // Get branch name
    if (input.show_branch) {
      try {
        const { stdout } = await execFileAsync(
          "git", ["branch", "--show-current"], { cwd }
        );
        results.push(`Branch: ${stdout.trim()}`);
      } catch {
        results.push("Branch: (detached HEAD or not a git repo)");
      }
    }

    // Get porcelain status
    try {
      const { stdout } = await execFileAsync(
        "git", ["status", "--porcelain=v1"], { cwd }
      );

      if (!stdout.trim()) {
        results.push("Status: Clean (no changes)");
        return results.join("\n");
      }

      const lines = stdout.trim().split("\n");
      const modified: string[] = [];
      const added: string[] = [];
      const deleted: string[] = [];
      const untracked: string[] = [];
      const other: string[] = [];

      for (const line of lines) {
        const status = line.substring(0, 2);
        const file = line.substring(3);

        if (status.includes("M")) modified.push(file);
        else if (status.includes("A")) added.push(file);
        else if (status.includes("D")) deleted.push(file);
        else if (status === "??") untracked.push(file);
        else other.push(`${status.trim()} ${file}`);
      }

      if (modified.length > 0) results.push(`Modified (${modified.length}): ${modified.join(", ")}`);
      if (added.length > 0) results.push(`Added (${added.length}): ${added.join(", ")}`);
      if (deleted.length > 0) results.push(`Deleted (${deleted.length}): ${deleted.join(", ")}`);
      if (untracked.length > 0) results.push(`Untracked (${untracked.length}): ${untracked.join(", ")}`);
      if (other.length > 0) results.push(`Other: ${other.join(", ")}`);

      results.push(`\nTotal changes: ${lines.length} files`);
    } catch (error: any) {
      throw new Error(`Not a git repository or git is not installed: ${error.message}`);
    }

    return results.join("\n");
  },
});
```

**Explanation:** The tool is read-only (git status doesn't modify anything) and concurrency-safe. It uses `git status --porcelain=v1` for machine-parseable output, then categorizes files into modified/added/deleted/untracked groups. The output is structured for easy model parsing. Error handling covers non-git directories and missing git installations.

---

## Exercise 3
**Challenge:** Write tests for the CountLinesTool.

**Answer:**

```typescript
import * as fs from "fs/promises";
import * as path from "path";
import { CountLinesTool } from "./tools/CountLinesTool";

const TEST_DIR = "/tmp/countlines-test";

const mockContext = {
  options: { cwd: TEST_DIR },
  abortSignal: new AbortController().signal,
} as ToolContext;

beforeAll(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe("CountLinesTool", () => {
  // (a) Schema validation
  describe("input schema", () => {
    test("accepts valid input with only file_path", () => {
      const result = CountLinesTool.inputSchema.safeParse({
        file_path: "/tmp/test.txt",
      });
      expect(result.success).toBe(true);
    });

    test("accepts valid input with all options", () => {
      const result = CountLinesTool.inputSchema.safeParse({
        file_path: "/tmp/test.txt",
        count_words: true,
        count_chars: true,
      });
      expect(result.success).toBe(true);
    });

    test("rejects missing file_path", () => {
      const result = CountLinesTool.inputSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    test("rejects wrong type for file_path", () => {
      const result = CountLinesTool.inputSchema.safeParse({ file_path: 42 });
      expect(result.success).toBe(false);
    });

    test("defaults count_words to false", () => {
      const result = CountLinesTool.inputSchema.safeParse({
        file_path: "/tmp/test.txt",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.count_words).toBe(false);
      }
    });
  });

  // (b) Line counting
  describe("counting lines", () => {
    test("counts lines in a simple file", async () => {
      await fs.writeFile(path.join(TEST_DIR, "simple.txt"), "a\nb\nc\n");
      const result = await CountLinesTool.call(
        { file_path: path.join(TEST_DIR, "simple.txt"), count_words: false, count_chars: false },
        mockContext
      );
      expect(result).toContain("Lines: 4");
    });

    test("counts single line (no newline)", async () => {
      await fs.writeFile(path.join(TEST_DIR, "single.txt"), "hello");
      const result = await CountLinesTool.call(
        { file_path: path.join(TEST_DIR, "single.txt"), count_words: false, count_chars: false },
        mockContext
      );
      expect(result).toContain("Lines: 1");
    });

    test("counts empty file as 1 line", async () => {
      await fs.writeFile(path.join(TEST_DIR, "empty.txt"), "");
      const result = await CountLinesTool.call(
        { file_path: path.join(TEST_DIR, "empty.txt"), count_words: false, count_chars: false },
        mockContext
      );
      expect(result).toContain("Lines: 1");
    });
  });

  // (c) Optional counting
  describe("word and character counting", () => {
    test("counts words when requested", async () => {
      await fs.writeFile(path.join(TEST_DIR, "words.txt"), "hello world\nfoo bar baz\n");
      const result = await CountLinesTool.call(
        { file_path: path.join(TEST_DIR, "words.txt"), count_words: true, count_chars: false },
        mockContext
      );
      expect(result).toContain("Words: 5");
      expect(result).not.toContain("Characters:");
    });

    test("counts characters when requested", async () => {
      await fs.writeFile(path.join(TEST_DIR, "chars.txt"), "abc");
      const result = await CountLinesTool.call(
        { file_path: path.join(TEST_DIR, "chars.txt"), count_words: false, count_chars: true },
        mockContext
      );
      expect(result).toContain("Characters: 3");
    });
  });

  // (d) Error handling
  describe("error handling", () => {
    test("throws for missing files", async () => {
      await expect(
        CountLinesTool.call(
          { file_path: path.join(TEST_DIR, "nope.txt"), count_words: false, count_chars: false },
          mockContext
        )
      ).rejects.toThrow("File not found");
    });

    test("throws for directories", async () => {
      await expect(
        CountLinesTool.call(
          { file_path: TEST_DIR, count_words: false, count_chars: false },
          mockContext
        )
      ).rejects.toThrow("directory");
    });
  });

  // (e) Behavioral flags
  describe("flags", () => {
    test("is read-only", () => {
      expect(CountLinesTool.isReadOnly).toBe(true);
    });

    test("is concurrency-safe", () => {
      expect(CountLinesTool.isConcurrencySafe).toBe(true);
    });

    test("is enabled", () => {
      expect(CountLinesTool.isEnabled).toBe(true);
    });

    test("has a reasonable max result size", () => {
      expect(CountLinesTool.maxResultSizeChars).toBeLessThanOrEqual(5000);
    });
  });
});
```

**Explanation:** The test suite covers five categories matching the challenge requirements. Schema tests validate both happy path and error cases for Zod parsing. Line counting tests handle normal files, single lines, and empty files. Optional counting verifies words and characters are only included when requested. Error handling tests expect specific error messages for missing files and directories. Flag tests verify the behavioral properties are set correctly.

---

## Exercise 4
**Challenge:** Build a `JsonValidate` tool from scratch.

**Answer:**

```typescript
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { buildTool, Tool, ToolContext } from "../Tool";

const JsonValidateInputSchema = z.object({
  file_path: z.string().describe(
    "Absolute path to the JSON file to validate"
  ),
  check_schema: z.boolean().optional().default(false).describe(
    "If true, also validates the JSON against a JSON Schema provided in schema_path"
  ),
  schema_path: z.string().optional().describe(
    "Path to a JSON Schema file to validate against. Required if check_schema is true."
  ),
});

type JsonValidateInput = z.infer<typeof JsonValidateInputSchema>;

export const JsonValidateTool: Tool = buildTool({
  name: "JsonValidate",
  description:
    "Validate whether a file contains valid JSON. Optionally checks the " +
    "JSON against a JSON Schema for structural validation. Returns a " +
    "detailed report of any issues found. Use this to verify configuration " +
    "files, API responses, or any JSON data.",

  aliases: ["ValidateJson", "CheckJson"],
  inputSchema: JsonValidateInputSchema,

  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 5_000,

  async validateInput(input: JsonValidateInput) {
    if (!input.file_path) {
      return { valid: false, message: "file_path is required" };
    }
    if (input.file_path.includes("\0")) {
      return { valid: false, message: "file_path contains null bytes" };
    }
    if (input.check_schema && !input.schema_path) {
      return {
        valid: false,
        message: "schema_path is required when check_schema is true",
      };
    }
    return { valid: true };
  },

  async call(input: JsonValidateInput, context: ToolContext): Promise<string> {
    const filePath = path.resolve(context.options.cwd, input.file_path);
    const results: string[] = [];

    // Read the file
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (error: any) {
      if (error.code === "ENOENT") {
        throw new Error(`File not found: ${input.file_path}`);
      }
      throw error;
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
      results.push("✓ Valid JSON");
      results.push(`  Type: ${Array.isArray(parsed) ? "array" : typeof parsed}`);
      if (typeof parsed === "object" && parsed !== null) {
        const keys = Object.keys(parsed as object);
        results.push(`  Top-level keys: ${keys.length}`);
        if (keys.length <= 10) {
          results.push(`  Keys: ${keys.join(", ")}`);
        }
      }
    } catch (error: any) {
      results.push("✗ Invalid JSON");
      results.push(`  Error: ${error.message}`);

      // Try to find the approximate error location
      const match = error.message.match(/position (\d+)/);
      if (match) {
        const pos = parseInt(match[1]);
        const lineNum = content.substring(0, pos).split("\n").length;
        results.push(`  Approximate location: line ${lineNum}`);
        const lines = content.split("\n");
        if (lineNum > 0 && lineNum <= lines.length) {
          results.push(`  Context: "${lines[lineNum - 1].trim()}"`);
        }
      }

      results.push(`\nFile: ${input.file_path}`);
      return results.join("\n");
    }

    // Optional JSON Schema validation
    if (input.check_schema && input.schema_path) {
      const schemaPath = path.resolve(context.options.cwd, input.schema_path);
      try {
        const schemaContent = await fs.readFile(schemaPath, "utf-8");
        const schema = JSON.parse(schemaContent);
        results.push(`\nSchema: ${input.schema_path}`);
        results.push("✓ Schema validation would require a JSON Schema library (e.g., ajv)");
        results.push(`  Schema type: ${schema.type ?? "unspecified"}`);
      } catch (error: any) {
        results.push(`\n✗ Could not load schema: ${error.message}`);
      }
    }

    results.push(`\nFile: ${input.file_path}`);
    results.push(`Size: ${content.length} characters`);
    return results.join("\n");
  },
});
```

**Explanation:** The tool is read-only and concurrency-safe since it only reads files and performs computation. `validateInput` catches the semantic constraint that `schema_path` is required when `check_schema` is true — something Zod alone can't express cleanly. The `call` function provides detailed error reports including line numbers for parse errors. The `maxResultSizeChars` is small (5K) since the output is a brief validation report.

---

## Exercise 5
**Question:** Determine the correct flags for each custom tool idea.

**Answer:**

**1. HTTP POST request tool:**
- `isReadOnly: false` — POST requests have side effects on the remote server (creating resources, triggering actions). Even though no local files change, the operation is not idempotent.
- `isConcurrencySafe: false` — Concurrent POSTs could create duplicate resources or trigger conflicting state changes. Conservative default is safer.
- `isEnabled: true` — Generally available, though could be feature-flagged if you want to restrict network access.
- `maxResultSizeChars: 30_000` — API responses vary widely; 30K is reasonable for most JSON responses.

**2. Code complexity metrics tool:**
- `isReadOnly: true` — Only reads source files and computes metrics; never modifies anything.
- `isConcurrencySafe: true` — Each computation is independent; reading multiple files for metrics doesn't conflict.
- `isEnabled: true` — Always useful, no restrictions needed.
- `maxResultSizeChars: 10_000` — Metrics output is structured data (function names, complexity scores) — moderately sized but not huge.

**3. CPU usage monitor (10 seconds):**
- `isReadOnly: true` — Only observes system state; doesn't modify anything.
- `isConcurrencySafe: false` — Although read-only, it runs for 10 seconds. Running multiple monitors simultaneously wastes resources and could skew measurements. The long execution time also makes it unsuitable for concurrent batches.
- `isEnabled: true` — Available on all platforms (though implementation varies).
- `maxResultSizeChars: 5_000` — Output is a small summary (average CPU, peak, per-core breakdown) — doesn't need much space.
