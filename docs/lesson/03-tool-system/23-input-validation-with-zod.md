# Lesson 23: Input Validation with Zod

## Why Validate Tool Inputs?

The model is generating JSON arguments for your tools. But models aren't perfect—
they can produce malformed JSON, missing required fields, wrong types, or values
outside expected ranges. If you pass garbage to `fs.readFile()` or `child_process.exec()`,
bad things happen.

Claude Code validates **every single tool input** with Zod before execution. No
exceptions. This is the first line of defense between the model's intentions and
your filesystem.

## What Is Zod?

Zod is a TypeScript-first schema validation library. It lets you define a schema
once and get:

1. **Runtime validation** — check if data matches the schema
2. **Type inference** — TypeScript types derived from the schema automatically
3. **Descriptive errors** — human-readable messages when validation fails
4. **JSON Schema conversion** — for sending to the model API

```typescript
import { z } from "zod";

const UserSchema = z.object({
  name: z.string(),
  age: z.number().min(0).max(150),
  email: z.string().email(),
});

// TypeScript infers: { name: string; age: number; email: string }
type User = z.infer<typeof UserSchema>;
```

## Core Zod Types

Here are the types you'll encounter in Claude Code tool schemas:

### Primitives

```typescript
z.string()               // any string
z.number()               // any number (int or float)
z.boolean()              // true or false
z.null()                 // only null
z.undefined()            // only undefined
```

### Strings with constraints

```typescript
z.string().min(1)                // non-empty string
z.string().max(1000)             // capped length
z.string().regex(/^[a-z]+$/)     // pattern match
z.string().describe("The path")  // adds description for model
```

### Numbers with constraints

```typescript
z.number().int()          // integers only
z.number().positive()     // > 0
z.number().min(1)         // >= 1
z.number().max(100)       // <= 100
```

### Optional and default

```typescript
z.string().optional()              // string | undefined
z.number().default(10)             // defaults to 10 if missing
z.boolean().optional().default(false)
```

### Objects

```typescript
z.object({
  name: z.string(),
  count: z.number().optional(),
  verbose: z.boolean().default(false),
})
```

### Arrays

```typescript
z.array(z.string())               // string[]
z.array(z.number()).min(1)         // non-empty number array
z.array(z.object({ id: z.string() }))  // array of objects
```

### Enums

```typescript
z.enum(["read", "write", "execute"])   // one of these values
z.literal("always")                     // exactly this value
```

### Unions

```typescript
z.union([z.string(), z.number()])       // string | number
```

## The `.describe()` Method

This is critically important for tool schemas. The description you pass to
`.describe()` gets converted into the JSON Schema's `description` field, which
the model sees when deciding how to use the tool.

```typescript
z.object({
  file_path: z.string()
    .describe("The absolute path of the file to read"),
  offset: z.number()
    .optional()
    .describe("The line number to start reading from. 1-indexed."),
  limit: z.number()
    .optional()
    .describe("Max number of lines to read. Omit to read entire file."),
})
```

The model will see this as:

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "The absolute path of the file to read"
    },
    "offset": {
      "type": "number",
      "description": "The line number to start reading from. 1-indexed."
    },
    "limit": {
      "type": "number",
      "description": "Max number of lines to read. Omit to read entire file."
    }
  },
  "required": ["file_path"]
}
```

Good `.describe()` text directly improves tool usage quality.

## `safeParse` vs `parse`

Zod provides two ways to validate:

### `parse` — Throws on failure

```typescript
const schema = z.object({ name: z.string() });

schema.parse({ name: "Alice" });    // returns { name: "Alice" }
schema.parse({ name: 42 });         // THROWS ZodError
schema.parse({});                    // THROWS ZodError
```

### `safeParse` — Returns a result object

```typescript
const result = schema.safeParse({ name: "Alice" });
// { success: true, data: { name: "Alice" } }

const result2 = schema.safeParse({ name: 42 });
// { success: false, error: ZodError }
```

**Claude Code uses `safeParse` exclusively.** Why? Because a thrown exception would
crash the tool execution pipeline. With `safeParse`, validation failures are handled
gracefully—turned into helpful error messages sent back to the model.

```typescript
const parsed = tool.inputSchema.safeParse(input);

if (!parsed.success) {
  return {
    type: "tool_result",
    tool_use_id: toolUseBlock.id,
    content: formatZodValidationError(parsed.error, tool),
    is_error: true,
  };
}

// Safe to proceed with parsed.data
const result = await tool.call(parsed.data, context);
```

## Real Tool Schemas

### GrepTool

```typescript
inputSchema: z.object({
  pattern: z.string().describe(
    "The regex pattern to search for in file contents"
  ),
  path: z.string().optional().describe(
    "The directory to search in. Defaults to the current working directory."
  ),
  include: z.string().optional().describe(
    "File glob pattern to include (e.g., '*.ts', '*.py')"
  ),
})
```

This schema tells the model: "Give me a regex pattern (required), and optionally
a directory path and file filter." The model learns from the descriptions that
`pattern` is a regex, `path` is a directory, and `include` is a glob.

### FileReadTool

```typescript
inputSchema: z.object({
  file_path: z.string().describe(
    "The absolute path of the file to read"
  ),
  offset: z.number().optional().describe(
    "The line number to start reading from (1-indexed). Negative values count from end."
  ),
  limit: z.number().optional().describe(
    "The number of lines to read. If not provided, reads the entire file."
  ),
})
```

### BashTool

```typescript
inputSchema: z.object({
  command: z.string().describe(
    "The bash command to execute"
  ),
  timeout: z.number().optional().describe(
    "Timeout in milliseconds. Default is 120000 (2 minutes)."
  ),
  working_directory: z.string().optional().describe(
    "The directory to execute the command in"
  ),
})
```

### FileWriteTool

```typescript
inputSchema: z.object({
  file_path: z.string().describe(
    "The absolute path of the file to write"
  ),
  content: z.string().describe(
    "The content to write to the file"
  ),
  create_directories: z.boolean().optional().describe(
    "Create parent directories if they don't exist. Defaults to true."
  ),
})
```

## What Happens When Validation Fails

When `safeParse` returns `success: false`, Claude Code calls `formatZodValidationError`
to create a helpful error message for the model:

```typescript
function formatZodValidationError(error: z.ZodError, tool: Tool): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.join(".");
    return `  - ${path}: ${issue.message}`;
  });

  return [
    `Input validation failed for tool "${tool.name}":`,
    ...issues,
    "",
    "Expected schema:",
    JSON.stringify(zodToJsonSchema(tool.inputSchema), null, 2),
  ].join("\n");
}
```

Example output the model receives:

```
Input validation failed for tool "Read":
  - file_path: Required
  - offset: Expected number, received string

Expected schema:
{
  "type": "object",
  "properties": {
    "file_path": { "type": "string" },
    "offset": { "type": "number" },
    "limit": { "type": "number" }
  },
  "required": ["file_path"]
}
```

This is sent back as a `tool_result` with `is_error: true`. The model sees exactly
what it did wrong and the full schema, so it can correct itself on the next attempt.
In practice, models almost always fix validation errors on retry.

## Zod to JSON Schema Conversion

The Anthropic API expects tool schemas in JSON Schema format, not Zod. Claude Code
converts Zod schemas at startup:

```typescript
import { zodToJsonSchema } from "zod-to-json-schema";

function toolToAPIFormat(tool: Tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema, {
      $refStrategy: "none",
    }),
  };
}
```

This means you write your schema once in Zod and get both runtime validation
and API-compatible JSON Schema automatically.

## Key Takeaways

1. **Zod validates every tool input** before execution—no exceptions
2. Use `z.object()`, `z.string()`, `z.number()`, `z.boolean()`, and `.optional()`
   for tool schemas
3. `.describe()` adds documentation the model sees—write clear descriptions
4. **`safeParse` over `parse`** — never throw, always handle gracefully
5. Validation errors are sent back to the model with the full schema so it can retry
6. Zod schemas are auto-converted to JSON Schema for the API

## What's Next

Now that you understand how tools are defined and validated, let's see how
`buildTool()` simplifies tool creation with sensible defaults.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — safeParse vs parse

**Question:** Explain why Claude Code uses `safeParse` exclusively instead of `parse`. What would happen in the tool execution pipeline if `parse` were used and the model sent invalid input?

[View Answer](../../answers/03-tool-system/answer-23.md#exercise-1)

### Exercise 2 — Build a SearchReplace Schema

**Challenge:** Write a Zod schema for a `SearchReplace` tool with these fields: `file_path` (required string), `search` (required non-empty string), `replace` (required string, can be empty), `case_sensitive` (optional boolean, default `true`), and `max_replacements` (optional positive integer). Add `.describe()` to every field.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-23.md#exercise-2)

### Exercise 3 — Manual JSON Schema Translation

**Challenge:** Given this Zod schema, write the equivalent JSON Schema object by hand (the JSON the model would see in the API request):

```typescript
z.object({
  query: z.string().describe("SQL query to execute"),
  database: z.enum(["primary", "replica"]).describe("Target database"),
  timeout: z.number().min(100).max(30000).optional().describe("Timeout in ms"),
})
```

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-23.md#exercise-3)

### Exercise 4 — Error Formatting

**Challenge:** Write a function `formatValidationError(error: z.ZodError): string` that takes a `ZodError` and returns a human-readable error message. Test it by creating a schema, calling `safeParse` with intentionally bad input, and formatting the resulting error.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-23.md#exercise-4)

### Exercise 5 — Describe Quality Matters

**Question:** Compare these two `.describe()` values for a `path` field and explain which is better for model usage and why: (a) `"The path"` vs (b) `"Absolute path to the directory to search. Defaults to the project root if not provided."`

[View Answer](../../answers/03-tool-system/answer-23.md#exercise-5)

---

*Module 03: The Tool System — Lesson 23 of 35*
