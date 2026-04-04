# Lesson 6: JSON Communication

## Introduction

In Lesson 5, you learned that agents use tools — the model outputs a `tool_use` request, the system executes it, and the result comes back. But how exactly are these requests and results structured? How does the model tell the system *which* tool to call and *what arguments* to pass?

The answer is **JSON** — the universal language of structured data. In this lesson, you'll learn why JSON is central to agent communication and how agents validate it.

---

## What Is JSON?

**JSON** (JavaScript Object Notation) is a way to represent structured data as text. It looks like this:

```json
{
  "name": "Alice",
  "age": 30,
  "languages": ["Python", "TypeScript", "Rust"],
  "isStudent": false
}
```

JSON has a few simple rules:

- **Objects** use curly braces `{}` and contain key-value pairs
- **Arrays** use square brackets `[]` and contain lists of values
- **Strings** use double quotes `""`
- **Numbers**, **booleans** (`true`/`false`), and **null** are written directly

That's it. JSON is simple enough for humans to read and structured enough for programs to parse. This is why it's the standard format for APIs, configuration files, and — crucially — **AI agent communication**.

---

## Why JSON for Agents?

When the model wants to call a tool, it needs to communicate three things:

1. **Which tool** to call (a name)
2. **What inputs** to provide (arguments)
3. **How to identify** this particular call (an ID)

Free-form text would be ambiguous. Consider:

```
I want to read the file at src/app.ts
```

A human can understand this, but a program would struggle to parse it reliably. What if the path has spaces? What if the model phrases it differently each time?

JSON solves this by being **structured and unambiguous**:

```json
{
  "type": "tool_use",
  "id": "call_001",
  "name": "read_file",
  "input": {
    "path": "src/app.ts"
  }
}
```

There's no ambiguity. The program knows exactly which tool to call (`read_file`) and what argument to use (`path: "src/app.ts"`).

---

## Tool Inputs as JSON Objects

Every tool has an **input schema** — a description of what inputs it expects. The model must produce JSON that matches this schema.

Here's a tool definition with its input schema:

```typescript
const readFileTool = {
  name: "read_file",
  description: "Read the contents of a file at the given path",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The file path to read",
      },
    },
    required: ["path"],
  },
};
```

When the model calls this tool, it produces:

```json
{
  "name": "read_file",
  "input": {
    "path": "src/app.ts"
  }
}
```

Here's a more complex example — a tool that edits a file:

```typescript
const editFileTool = {
  name: "edit_file",
  description: "Replace a string in a file with a new string",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The file to edit",
      },
      old_string: {
        type: "string",
        description: "The exact text to find and replace",
      },
      new_string: {
        type: "string",
        description: "The replacement text",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
};
```

The model would call it like this:

```json
{
  "name": "edit_file",
  "input": {
    "path": "src/app.ts",
    "old_string": "const x = 1;",
    "new_string": "const x = 42;"
  }
}
```

Structured, parseable, and unambiguous.

---

## Tool Outputs as JSON Objects

Tool results also come back as structured data:

```json
{
  "type": "tool_result",
  "tool_use_id": "call_001",
  "content": "import express from 'express';\n\nconst app = express();\napp.listen(3000);"
}
```

The `tool_use_id` links the result back to the original request, so the model knows which tool call this result belongs to. This is especially important when the model makes multiple tool calls at once (as we saw in Lesson 5).

For errors, the result includes an error flag:

```json
{
  "type": "tool_result",
  "tool_use_id": "call_001",
  "content": "Error: File not found: src/missing.ts",
  "is_error": true
}
```

The model sees this error and can decide what to do — maybe try a different path, or ask the user for clarification.

---

## How the Model Produces JSON

You might wonder: how does an LLM — which generates text token by token (Lesson 3) — produce valid JSON?

Modern LLMs are trained on huge amounts of JSON data, so they're quite good at producing it. But there's a risk: the model might produce *almost* valid JSON with a missing bracket or extra comma.

There are two approaches to handling this:

### Approach 1: Trust and Parse

Generate the JSON as text, then try to parse it:

```typescript
const toolInput = JSON.parse(rawModelOutput);
```

If it fails, you can ask the model to try again. This is simple but fragile.

### Approach 2: Structured Output (Preferred)

The API itself guarantees valid JSON. When you define tools using the API's tool format, the API constrains the model's output so it always produces valid JSON matching your schema. This is how Claude's API works — when the model outputs a `tool_use` block, the `input` field is guaranteed to be valid JSON.

```typescript
// The API response already gives you parsed, valid JSON
const toolCall = response.content.find((block) => block.type === "tool_use");
const input = toolCall.input; // Already a valid object, not a string
```

This is much more reliable than parsing raw text.

---

## Schema Validation: Making Sure the JSON Is Correct

Even with valid JSON, you need to check that it has the right *shape*. Does it have all required fields? Are the types correct? Is the path a string, not a number?

This is where **schema validation** comes in. A popular tool for this in TypeScript is **Zod**.

### What Is Zod?

Zod is a library that lets you define data shapes and validate data against them. Here's a simple example:

```typescript
import { z } from "zod";

// Define the expected shape
const ReadFileInput = z.object({
  path: z.string().describe("The file path to read"),
});

// Validate some data
const input = { path: "src/app.ts" };
const result = ReadFileInput.parse(input);
// ✓ Valid! result is { path: "src/app.ts" }

// What about bad data?
const badInput = { path: 123 };
ReadFileInput.parse(badInput);
// ✗ Throws: "Expected string, received number"
```

### Why This Matters for Agents

When the model produces a tool_use block, the agent needs to verify the input before executing the tool. You don't want to run a command that the model accidentally formed incorrectly.

Here's a more realistic example:

```typescript
import { z } from "zod";

const RunCommandInput = z.object({
  command: z.string().describe("The shell command to run"),
  timeout: z
    .number()
    .optional()
    .default(30000)
    .describe("Timeout in milliseconds"),
});

function executeRunCommand(rawInput: unknown) {
  // Validate the input
  const input = RunCommandInput.parse(rawInput);

  // Now we know input.command is a string
  // and input.timeout is a number (defaults to 30000)
  return runShellCommand(input.command, input.timeout);
}
```

Claude Code uses Zod extensively to validate tool inputs. Every tool has a Zod schema that defines exactly what inputs it expects. If the model produces something invalid, the error is caught immediately — before any potentially harmful action is taken.

---

## Summary

- **JSON** is a structured text format used for all agent communication.
- Tool **inputs** are JSON objects matching a defined schema (e.g., `{ "path": "src/app.ts" }`).
- Tool **outputs** are JSON objects containing the result and a reference ID.
- Modern APIs use **structured output** to guarantee the model produces valid JSON.
- **Zod** is a TypeScript library for validating that JSON data has the correct shape and types.
- JSON flows through every step of the agent cycle: messages, tool calls, results, and validation.

---

> **Key Takeaway**
>
> JSON is the universal language that agents, APIs, and tools all speak. The model produces JSON tool requests, the agent validates them with schemas (like Zod), executes the tool, and sends JSON results back. Mastering JSON is essential to understanding — and building — AI agents.

---

---

## Practice Exercises

> **Remember**: Write your answers in your notebook first, then check below.

### Exercise 1 — Why JSON?
**Question:** Why do AI agents use JSON for tool communication instead of plain text? What problem does JSON solve?

[View Answer](../../answers/01-foundations/answer-06.md#exercise-1)

### Exercise 2 — Input Schema
**Question:** What is an "input schema" for a tool, and what role does it play in the tool use cycle?

[View Answer](../../answers/01-foundations/answer-06.md#exercise-2)

### Exercise 3 — Zod Validation
**Question:** What is Zod, and why would an agent use it to validate tool inputs before executing a tool?

[View Answer](../../answers/01-foundations/answer-06.md#exercise-3)

### Exercise 4 — Code Challenge: Write a Zod Schema
**Challenge:** Write a Zod schema for a `search_files` tool that takes two inputs: a required `pattern` (string) and an optional `directory` (string that defaults to `"."`).

Write your solution in your IDE first, then check:

[View Answer](../../answers/01-foundations/answer-06.md#exercise-4)

---

*Next up: [Lesson 7 — Request-Response vs Streaming](./07-request-response-vs-streaming.md), where you'll learn the two ways to get data from an API and why streaming is critical for agents.*
