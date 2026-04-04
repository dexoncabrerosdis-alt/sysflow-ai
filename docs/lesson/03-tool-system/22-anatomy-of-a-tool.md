# Lesson 22: Anatomy of a Tool

## The Tool Type

Every tool in Claude Code implements a single TypeScript interface. Once you
understand this interface, you understand the contract that every tool must fulfill—
whether it reads files, runs shell commands, or fetches web pages.

Let's look at the `Tool` type from `Tool.ts`:

```typescript
type Tool = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  aliases?: string[];

  isEnabled: boolean;
  isReadOnly: boolean;
  isConcurrencySafe: boolean | ((input: unknown) => boolean);
  maxResultSizeChars?: number;

  call(
    input: unknown,
    context: ToolContext
  ): Promise<ToolResult | string>;

  validateInput?(input: unknown): Promise<ValidationResult>;
  checkPermissions?(
    input: unknown,
    context: ToolContext
  ): Promise<PermissionCheckResult>;
};
```

That's the whole thing. Let's break down every property.

## The Identity Properties

### `name: string`

The tool's unique identifier. This is what the model emits in the `tool_use` block
and what the runtime uses to look up the tool.

```typescript
name: "Read"          // file reading
name: "Write"         // file writing
name: "Bash"          // shell execution
name: "Grep"          // regex search
```

Names are concise, PascalCase, and describe the action. The model sees these names
directly, so clarity matters.

### `description: string`

A natural-language explanation of what the tool does, when to use it, and any
important constraints. This is injected into the model's context as part of the
tool definition.

```typescript
description: `Read the contents of a file from the local filesystem.
Returns the file content with line numbers prepended.
Use offset and limit for large files.
Binary files will return a notice instead of content.`
```

The description is arguably the most important property. It's the primary way the
model learns *when* to use a tool and *how* to use it correctly. A vague description
leads to misuse; a precise one leads to effective tool selection.

### `aliases?: string[]`

Alternative names the model might use. If the model emits a tool_use with an alias
instead of the canonical name, the runtime can still route it correctly.

```typescript
aliases: ["ReadFile", "FileRead", "cat"]
```

In practice, this is a safety net. Well-prompted models use the canonical name.

## The Schema

### `inputSchema: z.ZodType`

A Zod schema that defines and validates the tool's expected input. This serves
double duty:

1. It's converted to JSON Schema and sent to the model so it knows what arguments
   to provide
2. It's used at runtime to validate the model's actual input before execution

```typescript
inputSchema: z.object({
  file_path: z.string().describe("Absolute path to the file to read"),
  offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
  limit: z.number().optional().describe("Maximum number of lines to read"),
})
```

Every `.describe()` call becomes documentation the model can see. We'll dive deep
into Zod schemas in the next lesson.

## The Behavioral Flags

### `isEnabled: boolean`

Controls whether the tool is available at all. Disabled tools are excluded from
the tool list sent to the model. This is used for feature flags, environment-specific
tools, and conditional availability.

```typescript
isEnabled: true                    // always available
isEnabled: process.platform === "win32"  // Windows only
isEnabled: featureFlags.webSearch  // behind a feature flag
```

### `isReadOnly: boolean`

Declares whether the tool only reads state or also modifies it. This affects
permission checks, concurrency decisions, and safety guardrails.

```typescript
isReadOnly: true   // Read, Grep, Glob — these just look at things
isReadOnly: false  // Write, Bash, Edit — these change things
```

Read-only tools generally don't need user approval. Write tools often do.

### `isConcurrencySafe: boolean | ((input: unknown) => boolean)`

Declares whether the tool can safely run in parallel with other tools. This can
be a static boolean or a function that decides based on the specific input.

```typescript
isConcurrencySafe: true                        // always safe (Read, Grep)
isConcurrencySafe: false                       // never safe (Write)
isConcurrencySafe: (input) => !input.dangerous // depends on input
```

We'll explore concurrency in detail in Lessons 27-29.

### `maxResultSizeChars?: number`

Optional limit on the size of the tool result that gets sent back to the model.
Large results are truncated and the full content may be persisted to disk.

```typescript
maxResultSizeChars: 30_000   // typical for file reads
maxResultSizeChars: 80_000   // generous for search results
```

This prevents the model's context window from being overwhelmed by a single tool
result, like reading a 10,000-line file.

## The Methods

### `call(input, context): Promise<ToolResult | string>`

The core execution function. This is what runs when the model uses the tool.

```typescript
async call(input: { file_path: string; offset?: number; limit?: number }, context: ToolContext) {
  const content = await fs.readFile(input.file_path, "utf-8");
  const lines = content.split("\n");

  // Apply offset and limit
  const start = (input.offset ?? 1) - 1;
  const end = input.limit ? start + input.limit : lines.length;
  const slice = lines.slice(start, end);

  // Format with line numbers
  return slice.map((line, i) => `${start + i + 1}|${line}`).join("\n");
}
```

The `context` parameter provides access to the agent's environment:

```typescript
type ToolContext = {
  abortSignal: AbortSignal;
  readFileTimestamps: Map<string, number>;
  options: {
    cwd: string;
    tools: Tool[];
    maxThinkingTokens: number;
    // ... more
  };
};
```

The return value can be a simple string or a structured `ToolResult`:

```typescript
type ToolResult = {
  type: "tool_result";
  content: Array<TextBlock | ImageBlock>;
  metadata?: Record<string, unknown>;
};
```

### `validateInput?(input): Promise<ValidationResult>`

Optional custom validation beyond the Zod schema. Useful for business logic checks
that can't be expressed in a schema.

```typescript
async validateInput(input: { file_path: string }) {
  if (input.file_path.includes("..")) {
    return { valid: false, message: "Path traversal not allowed" };
  }
  if (!path.isAbsolute(input.file_path)) {
    return { valid: false, message: "Path must be absolute" };
  }
  return { valid: true };
}
```

### `checkPermissions?(input, context): Promise<PermissionCheckResult>`

Determines whether the tool is allowed to execute with the given input. This is
where Claude Code implements its permission system—asking the user for approval
before writing files or running commands.

```typescript
async checkPermissions(input: { command: string }, context: ToolContext) {
  const isAllowed = await context.permissionManager.check("Bash", input.command);
  if (!isAllowed) {
    return { allowed: false, reason: "User denied permission" };
  }
  return { allowed: true };
}
```

We'll cover the permission system in depth in a later module.

## A Complete Tool Definition

Let's put it all together. Here's a simplified but complete tool:

```typescript
import { z } from "zod";
import { Tool, ToolContext } from "./Tool";

const WordCountTool: Tool = {
  name: "WordCount",
  description: "Count the number of words in a file. Returns the word count as a number.",
  aliases: ["wc"],

  inputSchema: z.object({
    file_path: z.string().describe("Absolute path to the file"),
  }),

  isEnabled: true,
  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input: { file_path: string }, context: ToolContext) {
    const content = await fs.readFile(input.file_path, "utf-8");
    const words = content.split(/\s+/).filter(Boolean).length;
    return `Word count: ${words}`;
  },

  async validateInput(input: { file_path: string }) {
    if (!input.file_path) {
      return { valid: false, message: "file_path is required" };
    }
    return { valid: true };
  },
};
```

This tool:
- Has a clear name and description
- Defines its input with a Zod schema
- Is read-only (doesn't change anything)
- Is concurrency-safe (can run alongside other tools)
- Returns a simple string result
- Validates that a path was provided

## How the Pieces Fit Together

When the model emits `{ "name": "WordCount", "input": { "file_path": "/home/user/doc.txt" } }`:

1. **Lookup**: The runtime finds the tool by `name` (or `aliases`)
2. **Schema validation**: `inputSchema.safeParse(input)` checks the shape
3. **Custom validation**: `validateInput(input)` runs business logic checks
4. **Permission check**: `checkPermissions(input, context)` ensures it's allowed
5. **Execution**: `call(input, context)` does the actual work
6. **Result processing**: The return value is formatted into a `tool_result` block
7. **Size check**: If the result exceeds `maxResultSizeChars`, it's truncated

This pipeline runs for **every single tool call**, every time. The consistency is
what makes the system reliable.

## Key Takeaways

1. Every tool implements the same `Tool` interface
2. **name** + **description** + **inputSchema** tell the model *how* to use the tool
3. **isReadOnly** and **isConcurrencySafe** control safety and parallelism
4. **call()** is the actual execution; **validateInput()** and **checkPermissions()** gate it
5. The execution pipeline is: lookup → validate → permissions → execute → process result

## What's Next

The `inputSchema` property uses Zod, a schema validation library that's central
to how Claude Code ensures tool inputs are correct. Let's learn how it works.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Execution Pipeline

**Question:** List the 7 steps of the tool execution pipeline in order (from when the model emits a `tool_use` block to when the result is sent back). For each step, name which property or method of the `Tool` interface is involved.

[View Answer](../../answers/03-tool-system/answer-22.md#exercise-1)

### Exercise 2 — Build a LineCount Tool

**Challenge:** Define a complete `Tool` object (not using `buildTool`) for a `LineCount` tool that counts the number of lines in a file. Include all required properties: `name`, `description`, `inputSchema` (Zod), `isEnabled`, `isReadOnly`, `isConcurrencySafe`, and `call()`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-22.md#exercise-2)

### Exercise 3 — validateInput for Safety

**Challenge:** Write a `validateInput` function for a file-writing tool that rejects: (a) paths containing `..`, (b) paths targeting system directories like `/etc` or `/usr`, and (c) paths with null bytes. Return `{ valid: false, message: "..." }` with a specific message for each case.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-22.md#exercise-3)

### Exercise 4 — Flags Quiz

**Question:** For each of the following tools, state what `isReadOnly` and `isConcurrencySafe` should be and explain why: (a) a tool that fetches a URL, (b) a tool that appends to a log file, (c) a tool that runs `git status`.

[View Answer](../../answers/03-tool-system/answer-22.md#exercise-4)

### Exercise 5 — ToolContext Usage

**Challenge:** Write a `call()` function for a `ListFiles` tool that lists files in the current working directory. Use `context.options.cwd` to get the directory. Return the file list as a newline-separated string with file sizes.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-22.md#exercise-5)

---

*Module 03: The Tool System — Lesson 22 of 35*
