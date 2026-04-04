# Lesson 35: Creating a Custom Tool

## Building from Scratch

You've learned every component of the tool system: the Tool interface, Zod schemas,
buildTool factory, the registry, concurrency flags, partitioning, execution,
error handling, hooks, and result processing. Now let's put it all together by
building a complete custom tool from scratch.

We'll build a **CountLines** tool that counts lines, words, and characters in a
file—think `wc` but as a first-class agent tool.

## Step 1: Define the Zod Schema

Start with what the tool needs as input:

```typescript
import { z } from "zod";

const CountLinesInputSchema = z.object({
  file_path: z.string().describe(
    "The absolute path of the file to analyze"
  ),
  count_words: z.boolean().optional().default(false).describe(
    "Also count words. Defaults to false."
  ),
  count_chars: z.boolean().optional().default(false).describe(
    "Also count characters. Defaults to false."
  ),
});

type CountLinesInput = z.infer<typeof CountLinesInputSchema>;
// { file_path: string; count_words: boolean; count_chars: boolean }
```

Design decisions:
- `file_path` is required—the tool can't do anything without it
- `count_words` and `count_chars` are optional with defaults—the primary use case
  is counting lines; extras are opt-in
- Every field has a `.describe()` so the model knows what to provide

## Step 2: Implement the `call()` Function

The core logic:

```typescript
import * as fs from "fs/promises";
import * as path from "path";
import { ToolContext } from "./Tool";

async function countLinesCall(
  input: CountLinesInput,
  context: ToolContext
): Promise<string> {
  const resolvedPath = path.resolve(context.options.cwd, input.file_path);

  const content = await fs.readFile(resolvedPath, "utf-8");
  const lines = content.split("\n");

  const results: string[] = [
    `Lines: ${lines.length}`,
  ];

  if (input.count_words) {
    const words = content.split(/\s+/).filter(Boolean).length;
    results.push(`Words: ${words}`);
  }

  if (input.count_chars) {
    results.push(`Characters: ${content.length}`);
  }

  results.push(`File: ${input.file_path}`);

  return results.join("\n");
}
```

Design decisions:
- Resolve the path relative to the working directory (handles relative paths)
- Return a simple, structured string—easy for the model to parse
- Include the filename in the output for clarity when multiple files are counted

## Step 3: Implement Input Validation

Beyond Zod's schema validation, add business logic checks:

```typescript
async function validateCountLinesInput(
  input: CountLinesInput
): Promise<{ valid: boolean; message?: string }> {
  if (!input.file_path) {
    return { valid: false, message: "file_path is required" };
  }

  if (input.file_path.includes("\0")) {
    return { valid: false, message: "file_path contains null bytes" };
  }

  // Check for path traversal attempts
  const normalized = path.normalize(input.file_path);
  if (normalized.includes("..") && path.isAbsolute(input.file_path)) {
    const resolved = path.resolve(input.file_path);
    if (resolved !== normalized) {
      return { valid: false, message: "Suspicious path traversal detected" };
    }
  }

  return { valid: true };
}
```

These checks catch things Zod can't express: null bytes in paths, path traversal
attacks, and other filesystem-specific concerns.

## Step 4: Set the Behavioral Flags

Think through each flag:

```typescript
const flags = {
  isReadOnly: true,
  // This tool only reads files — it never modifies anything.
  // This means: no permission prompt, auto-approved.

  isConcurrencySafe: true,
  // File reads are atomic. Multiple CountLines on different files
  // can safely run in parallel. Even on the same file, concurrent
  // reads don't conflict.

  isEnabled: true,
  // Always available. No platform or feature flag restrictions.

  maxResultSizeChars: 1_000,
  // Output is tiny — just a few numbers. 1K is more than enough.
};
```

## Step 5: Assemble with `buildTool()`

```typescript
import { buildTool, Tool } from "./Tool";

const CountLinesTool: Tool = buildTool({
  name: "CountLines",
  description: [
    "Count the number of lines in a file.",
    "Optionally also counts words and characters.",
    "Returns a summary with the counts.",
    "Use this when you need to know the size of a file",
    "without reading its full contents.",
  ].join(" "),

  aliases: ["wc", "LineCount"],

  inputSchema: CountLinesInputSchema,

  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 1_000,

  async call(input: CountLinesInput, context: ToolContext) {
    return countLinesCall(input, context);
  },

  async validateInput(input: CountLinesInput) {
    return validateCountLinesInput(input);
  },
});
```

What we're NOT setting (using defaults):
- `isEnabled` — defaults to `true`
- `checkPermissions` — defaults to always-allow (appropriate for a read-only tool)

## Step 6: Register in `tools.ts`

Add the tool to the master list:

```typescript
import { CountLinesTool } from "./tools/CountLinesTool";

function getAllBaseTools(): Tool[] {
  return [
    // File tools
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    NotebookEditTool,

    // Search tools
    GrepTool,
    GlobTool,

    // ... existing tools ...

    // Custom tools
    CountLinesTool,   // ← added here
  ];
}
```

That's it. The tool is now:
- Available to the model (it'll see the name, description, and schema)
- Validated on every call (Zod + custom validation)
- Concurrency-safe (can run in parallel with other reads)
- Size-limited (1K chars max result)
- Auto-approved (read-only, no permission prompt)

## Step 7: The Complete File

Here's the entire tool in one file:

```typescript
// tools/CountLinesTool.ts

import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { buildTool, Tool, ToolContext } from "../Tool";

const CountLinesInputSchema = z.object({
  file_path: z.string().describe(
    "The absolute path of the file to analyze"
  ),
  count_words: z.boolean().optional().default(false).describe(
    "Also count words. Defaults to false."
  ),
  count_chars: z.boolean().optional().default(false).describe(
    "Also count characters. Defaults to false."
  ),
});

type CountLinesInput = z.infer<typeof CountLinesInputSchema>;

export const CountLinesTool: Tool = buildTool({
  name: "CountLines",
  description:
    "Count the number of lines in a file. Optionally also counts words " +
    "and characters. Returns a summary with the counts. Use this when you " +
    "need to know the size of a file without reading its full contents.",

  aliases: ["wc", "LineCount"],
  inputSchema: CountLinesInputSchema,

  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 1_000,

  async validateInput(input: CountLinesInput) {
    if (!input.file_path) {
      return { valid: false, message: "file_path is required" };
    }
    if (input.file_path.includes("\0")) {
      return { valid: false, message: "file_path contains null bytes" };
    }
    return { valid: true };
  },

  async call(input: CountLinesInput, context: ToolContext): Promise<string> {
    const resolvedPath = path.resolve(context.options.cwd, input.file_path);

    let content: string;
    try {
      content = await fs.readFile(resolvedPath, "utf-8");
    } catch (error: any) {
      if (error.code === "ENOENT") {
        throw new Error(`File not found: ${input.file_path}`);
      }
      if (error.code === "EISDIR") {
        throw new Error(`Path is a directory, not a file: ${input.file_path}`);
      }
      throw error;
    }

    const lines = content.split("\n");
    const results: string[] = [`Lines: ${lines.length}`];

    if (input.count_words) {
      const words = content.split(/\s+/).filter(Boolean).length;
      results.push(`Words: ${words}`);
    }

    if (input.count_chars) {
      results.push(`Characters: ${content.length}`);
    }

    results.push(`File: ${input.file_path}`);
    return results.join("\n");
  },
});
```

## How the Model Uses It

Once registered, the model sees:

```json
{
  "name": "CountLines",
  "description": "Count the number of lines in a file. Optionally also counts words and characters...",
  "input_schema": {
    "type": "object",
    "properties": {
      "file_path": { "type": "string", "description": "The absolute path of the file to analyze" },
      "count_words": { "type": "boolean", "description": "Also count words. Defaults to false." },
      "count_chars": { "type": "boolean", "description": "Also count characters. Defaults to false." }
    },
    "required": ["file_path"]
  }
}
```

And uses it naturally:

```
User: "How big is my main source file?"

Model: [tool_use] CountLines({ file_path: "/home/user/project/src/index.ts", count_words: true, count_chars: true })

Result: "Lines: 342\nWords: 1847\nCharacters: 52903\nFile: src/index.ts"

Model: "Your main source file (src/index.ts) has 342 lines, 1,847 words, and about 53K characters."
```

## Testing the Tool

A good tool should be tested:

```typescript
import { CountLinesTool } from "./tools/CountLinesTool";

describe("CountLinesTool", () => {
  const mockContext = {
    options: { cwd: "/tmp/test" },
    abortSignal: new AbortController().signal,
  } as ToolContext;

  test("validates input schema", () => {
    const valid = CountLinesTool.inputSchema.safeParse({
      file_path: "/tmp/test.txt",
    });
    expect(valid.success).toBe(true);

    const invalid = CountLinesTool.inputSchema.safeParse({});
    expect(invalid.success).toBe(false);
  });

  test("counts lines correctly", async () => {
    // Write a test file
    await fs.writeFile("/tmp/test/sample.txt", "line1\nline2\nline3\n");

    const result = await CountLinesTool.call(
      { file_path: "/tmp/test/sample.txt", count_words: false, count_chars: false },
      mockContext
    );
    expect(result).toContain("Lines: 4");
  });

  test("counts words when requested", async () => {
    await fs.writeFile("/tmp/test/sample.txt", "hello world\nfoo bar baz\n");

    const result = await CountLinesTool.call(
      { file_path: "/tmp/test/sample.txt", count_words: true, count_chars: false },
      mockContext
    );
    expect(result).toContain("Words: 5");
  });

  test("handles missing files", async () => {
    await expect(
      CountLinesTool.call(
        { file_path: "/tmp/test/nope.txt", count_words: false, count_chars: false },
        mockContext
      )
    ).rejects.toThrow("File not found");
  });

  test("flags", () => {
    expect(CountLinesTool.isReadOnly).toBe(true);
    expect(CountLinesTool.isConcurrencySafe).toBe(true);
  });
});
```

## The Checklist

When creating a custom tool, verify:

- [ ] **Name** is PascalCase, concise, and unique
- [ ] **Description** explains what, when, and how (for the model)
- [ ] **inputSchema** has `.describe()` on every field
- [ ] **isReadOnly** is correct (does it modify anything?)
- [ ] **isConcurrencySafe** is correct (can it run in parallel?)
- [ ] **call()** handles errors gracefully (throws, doesn't crash)
- [ ] **validateInput()** catches things Zod can't (if needed)
- [ ] **maxResultSizeChars** is appropriate for the expected output
- [ ] Tool is registered in `getAllBaseTools()`
- [ ] Tests cover happy path, error cases, and edge cases

## Module Summary

Over these 15 lessons, you've learned:

1. **What tools are** and the tool_use → tool_result cycle (Lesson 21)
2. **The Tool interface** with all its properties (Lesson 22)
3. **Zod validation** for input schemas (Lesson 23)
4. **buildTool()** factory and defaults (Lesson 24)
5. **The tool registry** and how tools are assembled (Lesson 25)
6. **Read-only vs. write tools** and their implications (Lesson 26)
7. **Concurrency safety** flags and checks (Lesson 27)
8. **Tool partitioning** into batches (Lesson 28)
9. **Parallel execution** with semaphores and ordering (Lesson 29)
10. **Streaming execution** overlapping with generation (Lesson 30)
11. **Error handling** and self-correction (Lesson 31)
12. **Hooks** for extensibility (Lesson 32)
13. **Result processing** and size management (Lesson 33)
14. **All 40+ built-in tools** organized by category (Lesson 34)
15. **Creating custom tools** from scratch (Lesson 35)

The tool system is the bridge between the model's intelligence and the real world.
Without it, the model is just generating text. With it, the model is an agent.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Custom Tool Checklist

**Question:** List the 10-item checklist for creating a custom tool from the lesson. For each item, explain what goes wrong if you skip it.

[View Answer](../../answers/03-tool-system/answer-35.md#exercise-1)

### Exercise 2 — Build a GitStatus Tool

**Challenge:** Build a complete custom `GitStatus` tool using `buildTool()`. It should run `git status --porcelain` in a given directory (defaulting to cwd), parse the output into a structured format showing modified/added/deleted files, and return a human-readable summary. Include proper Zod schema, flags, validation, and error handling.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-35.md#exercise-2)

### Exercise 3 — Write Tests for CountLines

**Challenge:** Write a complete test suite for the `CountLinesTool` from the lesson. Cover: (a) schema validation (valid + invalid input), (b) counting lines correctly, (c) optional word and character counting, (d) error handling for missing files and directories, (e) behavioral flags are correct.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-35.md#exercise-3)

### Exercise 4 — Build a JsonValidate Tool

**Challenge:** Build a complete `JsonValidate` tool from scratch that validates whether a file contains valid JSON, and optionally checks it against a JSON Schema. Include: Zod input schema, call function, validateInput, error handling, and appropriate flags. Use `buildTool()`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-35.md#exercise-4)

### Exercise 5 — Flag Design Decisions

**Question:** For each of these custom tool ideas, determine the correct values for `isReadOnly`, `isConcurrencySafe`, `isEnabled`, and `maxResultSizeChars`. Explain each decision:
1. A tool that sends HTTP POST requests to an API
2. A tool that computes code complexity metrics by reading source files
3. A tool that monitors CPU usage in real-time for 10 seconds

[View Answer](../../answers/03-tool-system/answer-35.md#exercise-5)

---

*Module 03: The Tool System — Lesson 35 of 35*
