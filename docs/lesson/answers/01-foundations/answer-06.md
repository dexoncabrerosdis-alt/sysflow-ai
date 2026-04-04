# Answers: Lesson 06 — JSON Communication

## Exercise 1

**Question:** Why do AI agents use JSON for tool communication instead of plain text? What problem does JSON solve?

**Answer:** Plain text is ambiguous — if the model says "I want to read the file at src/app.ts," a program would struggle to reliably parse the tool name and arguments, especially with varying phrasing, special characters, or edge cases. JSON solves this by providing a **structured and unambiguous** format. Every tool call is a clearly defined object with specific fields (`name`, `input`, `id`), making it trivial for the agent program to parse exactly which tool to call and what arguments to use.

---

## Exercise 2

**Question:** What is an "input schema" for a tool, and what role does it play in the tool use cycle?

**Answer:** An input schema is a description of what inputs a tool expects — the names of the fields, their types (string, number, etc.), and which ones are required. It plays two critical roles: first, it tells the model what data it needs to provide when calling the tool, so the model can produce correctly shaped JSON. Second, it enables validation — the agent can check the model's output against the schema to make sure all required fields are present and have the correct types before executing the tool.

---

## Exercise 3

**Question:** What is Zod, and why would an agent use it to validate tool inputs before executing a tool?

**Answer:** Zod is a TypeScript library for defining data shapes (schemas) and validating data against them. An agent uses Zod to verify that the JSON the model produces for a tool call has the correct structure — right fields, right types, required values present. This is important for safety and reliability: you don't want to execute a shell command with a missing or malformed argument. If validation fails, the error is caught immediately before any action is taken, preventing potentially harmful or broken tool executions.

---

## Exercise 4

**Challenge:** Write a Zod schema for a `search_files` tool that takes two inputs: a required `pattern` (string) and an optional `directory` (string that defaults to `"."`).

**Answer:**

```typescript
import { z } from "zod";

const SearchFilesInput = z.object({
  pattern: z.string().describe("The text pattern to search for"),
  directory: z
    .string()
    .optional()
    .default(".")
    .describe("The directory to search in (defaults to current directory)"),
});
```

**Explanation:** The schema uses `z.object()` to define an object with two properties. `pattern` is a required string (no `.optional()` modifier). `directory` is an optional string with a default value of `"."` (the current directory), so if the model omits it, the agent will search from the project root. The `.describe()` calls document each field's purpose for both developers and the model.
