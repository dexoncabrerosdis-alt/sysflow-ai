# Answers: Lesson 22 — Anatomy of a Tool

## Exercise 1
**Question:** List the 7 steps of the tool execution pipeline in order. For each step, name which property or method of the `Tool` interface is involved.

**Answer:**
1. **Lookup** — The runtime finds the tool by `name` (or `aliases`)
2. **Schema validation** — `inputSchema.safeParse(input)` validates the shape and types of the input
3. **Custom validation** — `validateInput(input)` runs business-logic checks beyond the schema
4. **Permission check** — `checkPermissions(input, context)` determines whether the tool is allowed to execute
5. **Execution** — `call(input, context)` performs the actual work
6. **Result processing** — The return value from `call()` is formatted into a `tool_result` block
7. **Size check** — If the result exceeds `maxResultSizeChars`, it's truncated

This pipeline runs identically for every tool call, which is what makes the system reliable and predictable.

---

## Exercise 2
**Challenge:** Define a complete `Tool` object for a `LineCount` tool that counts the number of lines in a file.

**Answer:**

```typescript
import { z } from "zod";
import * as fs from "fs/promises";
import { Tool, ToolContext } from "./Tool";

const LineCountTool: Tool = {
  name: "LineCount",
  description: "Count the number of lines in a file. Returns the line count as a number.",
  aliases: ["wc-l"],

  inputSchema: z.object({
    file_path: z.string().describe("Absolute path to the file to count lines in"),
  }),

  isEnabled: true,
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 500,

  async call(input: { file_path: string }, context: ToolContext) {
    const content = await fs.readFile(input.file_path, "utf-8");
    const lineCount = content.split("\n").length;
    return `Lines: ${lineCount}\nFile: ${input.file_path}`;
  },

  async validateInput(input: { file_path: string }) {
    if (!input.file_path) {
      return { valid: false, message: "file_path is required" };
    }
    if (!input.file_path.startsWith("/")) {
      return { valid: false, message: "file_path must be an absolute path" };
    }
    return { valid: true };
  },
};
```

**Explanation:** The tool is read-only (only reads files), concurrency-safe (reads don't conflict), and has a small `maxResultSizeChars` since the output is just a number and a path. The `validateInput` function adds a check that Zod can't express — ensuring the path is absolute.

---

## Exercise 3
**Challenge:** Write a `validateInput` function for a file-writing tool that rejects dangerous paths.

**Answer:**

```typescript
import * as path from "path";

async function validateInput(
  input: { file_path: string }
): Promise<{ valid: boolean; message?: string }> {
  const filePath = input.file_path;

  // Reject null bytes (filesystem injection attack)
  if (filePath.includes("\0")) {
    return { valid: false, message: "Path contains null bytes — possible injection attack" };
  }

  // Reject path traversal
  if (filePath.includes("..")) {
    return { valid: false, message: "Path traversal (..) is not allowed" };
  }

  // Reject system directories
  const systemDirs = ["/etc", "/usr", "/bin", "/sbin", "/boot", "/sys", "/proc"];
  const resolved = path.resolve(filePath);
  for (const dir of systemDirs) {
    if (resolved.startsWith(dir + "/") || resolved === dir) {
      return {
        valid: false,
        message: `Writing to system directory "${dir}" is not allowed`,
      };
    }
  }

  return { valid: true };
}
```

**Explanation:** Three layers of defense: null bytes catch low-level injection attempts, `..` blocks path traversal, and the system directory check prevents writes to critical OS locations. Each rejection returns a specific message so the model knows exactly what went wrong and can adjust.

---

## Exercise 4
**Question:** For each tool, state what `isReadOnly` and `isConcurrencySafe` should be and why.

**Answer:**
**(a) A tool that fetches a URL:**
- `isReadOnly: true` — It doesn't modify local state; it only retrieves remote data.
- `isConcurrencySafe: true` — Each HTTP request is independent; fetching two URLs simultaneously has no conflicts.

**(b) A tool that appends to a log file:**
- `isReadOnly: false` — It modifies the log file (writing new content).
- `isConcurrencySafe: false` — Two concurrent appends to the same file could interleave, producing garbled output. Even if targeting different files, the safest default is `false`.

**(c) A tool that runs `git status`:**
- `isReadOnly: false` — Even though `git status` itself is read-only, a general Bash tool must be marked write-capable since it *could* run destructive commands. The specific command is evaluated at permission-check time, not by the flag.
- `isConcurrencySafe: false` — Shell commands can have arbitrary side effects, so the safe default applies.

---

## Exercise 5
**Challenge:** Write a `call()` function for a `ListFiles` tool that lists files in the current working directory.

**Answer:**

```typescript
import * as fs from "fs/promises";
import * as path from "path";
import { ToolContext } from "./Tool";

async function call(
  input: { directory?: string },
  context: ToolContext
): Promise<string> {
  const targetDir = input.directory
    ? path.resolve(context.options.cwd, input.directory)
    : context.options.cwd;

  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  const lines: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name);
    if (entry.isFile()) {
      const stats = await fs.stat(fullPath);
      lines.push(`${entry.name}  (${stats.size} bytes)`);
    } else if (entry.isDirectory()) {
      lines.push(`${entry.name}/`);
    }
  }

  if (lines.length === 0) {
    return `Directory is empty: ${targetDir}`;
  }

  return `Files in ${targetDir}:\n${lines.join("\n")}`;
}
```

**Explanation:** The function resolves the directory relative to `context.options.cwd`, lists entries with `readdir`, and formats files with their sizes and directories with a trailing slash. Returning a clean, structured string makes it easy for the model to parse the output.
