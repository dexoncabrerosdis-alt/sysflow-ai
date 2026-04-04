# Answers: Lesson 09 — Claude Code Architecture Overview

## Exercise 1

**Question:** Name all 5 layers of Claude Code's architecture in order (from entry point to tools), and describe the main responsibility of each layer in one sentence.

**Answer:**

1. **Entry Point (`cli.tsx`)** — Parses command-line arguments, sets up configuration, and launches the application.
2. **REPL (`main.tsx`)** — Handles the user interface (built with React Ink), reads user input, displays responses in real time, and manages the visual layout.
3. **Query Engine (`QueryEngine.ts`)** — Manages the conversation message array, handles context window limits, sends requests to the Claude API, and processes streamed responses.
4. **Agent Loop (`query.ts`)** — Implements the core Think → Act → Observe loop by calling the model, checking for tool_use blocks, executing tools, and repeating until the task is complete.
5. **Tools (`tools.ts`)** — Defines the available tools (read files, write files, run commands, etc.) with their schemas and execute functions — the agent's interface with your computer.

---

## Exercise 2

**Question:** What is the role of `prompts.ts` (the system prompt) in Claude Code's architecture? What kinds of information does it contain?

**Answer:** The system prompt in `prompts.ts` acts as the agent's "training manual" — it shapes every decision the model makes during a conversation. It contains: (1) the agent's identity ("You are Claude Code, an interactive CLI tool..."), (2) descriptions of all available tools, (3) behavioral rules (like "always read a file before editing it" and "ask permission before running dangerous commands"), and (4) environment information (operating system, current directory, project details). A well-written system prompt is one of the most important parts of a good agent.

---

## Exercise 3

**Question:** Trace the data flow when a user types "Fix the bug in app.ts" into Claude Code.

**Answer:** The flow is: (1) The user types the message in the terminal → (2) `cli.tsx` receives it and passes it to the app → (3) `main.tsx` shows the UI and passes the message to the Query Engine → (4) `QueryEngine.ts` adds the message to the conversation array, builds the API request (with system prompt, messages, and tool definitions), and sends it to the Claude API → (5) The Claude API streams back a response containing tool_use blocks → (6) `query.ts` (the agent loop) receives the response, executes the requested tools via `tools.ts` (e.g., reading app.ts) → (7) Tool results are added to the conversation and the model is called again → (8) This repeats until the model responds with plain text → (9) The final response flows back through QueryEngine to main.tsx and is displayed in the terminal.

---

## Exercise 4

**Challenge:** Write a tool definition for a `search_code` tool using Zod schema validation.

**Answer:**

```typescript
import { z } from "zod";

const searchCode = {
  name: "search_code",
  description:
    "Search for a text pattern across files in the project. Returns matching lines with file paths and line numbers.",
  inputSchema: z.object({
    pattern: z.string().describe("The text pattern to search for"),
    file_extension: z
      .string()
      .optional()
      .describe("Limit search to files with this extension (e.g., '.ts', '.py')"),
  }),
  async execute({ pattern, file_extension }: { pattern: string; file_extension?: string }) {
    const args = ["--line-number", pattern];
    if (file_extension) {
      args.push("--include", `*${file_extension}`);
    }
    const { stdout } = await exec(`grep -r ${args.join(" ")} .`);
    return stdout || "No matches found.";
  },
};
```

**Explanation:** The tool follows the same structure as the lesson examples: a `name` for identification, a `description` so the model knows when to use it, a Zod `inputSchema` that defines the required `pattern` string and the optional `file_extension` string, and an `execute` function that runs the actual search command. The Zod schema ensures the model provides valid inputs before the grep command runs.
