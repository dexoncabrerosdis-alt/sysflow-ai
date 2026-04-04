# Answers: Lesson 12 — A Simple Agent Loop

## Exercise 1
**Question:** In the `executeTool` function, errors are returned as strings rather than thrown as exceptions. Why is this design important for an agent loop? What would happen if tools threw exceptions instead?

**Answer:** Returning errors as strings is critical because the model needs to **see** error messages to adapt its behavior. If `read_file("nonexistent.ts")` returns `"Error reading file: ENOENT: no such file or directory"`, the model can react — it might try a different path, list the directory to find the correct filename, or tell the user the file doesn't exist. If the tool threw an exception instead, the entire agent loop would crash (or require try/catch wrappers that convert exceptions to messages anyway). The model would never learn what went wrong. Errors are data in an agent loop, not exceptional conditions — the model treats them as observations that inform its next action.

---

## Exercise 2
**Challenge:** Extend the agent loop by adding a `write_file` tool.

**Answer:**
```typescript
// Tool schema definition
const writeFileTool: Anthropic.Tool = {
  name: "write_file",
  description: "Write content to a file at the given path. Creates the file if it doesn't exist, overwrites if it does.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "The file path to write to",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["path", "content"],
  },
};

// Add to tools array
const tools: Anthropic.Tool[] = [
  // ...existing tools...
  writeFileTool,
];

// Add case to executeTool
async function executeTool(
  name: string,
  input: Record<string, string>
): Promise<string> {
  switch (name) {
    // ...existing cases...

    case "write_file":
      try {
        const dir = path.dirname(input.path);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(input.path, input.content, "utf-8");
        return `Successfully wrote ${input.content.length} characters to ${input.path}`;
      } catch (e) {
        return `Error writing file: ${(e as Error).message}`;
      }

    default:
      return `Unknown tool: ${name}`;
  }
}
```

**Explanation:** The schema tells the model what parameters to provide. The implementation creates parent directories if needed (a common robustness pattern), writes the file, and returns a success confirmation or error string. The error is returned as a string, not thrown, so the model can react to write failures.

---

## Exercise 3
**Question:** After an agent loop completes a 3-iteration task (list directory → read file → give answer), how many messages are in the `messages` array?

**Answer:** There are **6 messages** in the array:

1. `{ role: "user", content: "..." }` — the original user request
2. `{ role: "assistant", content: [tool_use: list_directory] }` — model's first response (iteration 1)
3. `{ role: "user", content: [tool_result: directory listing] }` — tool result from list_directory
4. `{ role: "assistant", content: [tool_use: read_file] }` — model's second response (iteration 2)
5. `{ role: "user", content: [tool_result: file contents] }` — tool result from read_file
6. `{ role: "assistant", content: [text: final answer] }` — model's final text response (iteration 3)

The pattern is: 1 initial user message + 2 messages per iteration (assistant response + tool result), except the final iteration which only adds 1 (the assistant's text-only response). Formula: `1 + (iterations_with_tools × 2) + 1 = 1 + (2 × 2) + 1 = 6`.

---

## Exercise 4
**Challenge:** Improve the loop's return type to distinguish success from limit-reached.

**Answer:**
```typescript
type AgentResult =
  | { type: "success"; response: string; iterations: number }
  | { type: "max_iterations"; iterations: number; partialResponse?: string };

async function agentLoop(userMessage: string): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let iterations = 0;
  const maxIterations = 20;

  while (iterations < maxIterations) {
    iterations++;

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text"
      );
      return {
        type: "success",
        response: textBlock?.text ?? "",
        iterations,
      };
    }

    // ... tool execution ...
  }

  const lastText = findLastTextBlock(messages);
  return {
    type: "max_iterations",
    iterations,
    partialResponse: lastText,
  };
}
```

**Explanation:** The discriminated union `AgentResult` forces consumers to check whether the loop succeeded or hit its limit. The `iterations` field lets consumers report "Completed in 5 turns" or "Stopped after 20 turns." The `partialResponse` on the limit case captures any text the model produced before being cut off, which is often still useful.

---

## Exercise 5
**Question:** What would need to change to execute tools in parallel? What are the benefits and risks?

**Answer:** To execute tools in parallel, replace the sequential `for` loop with `Promise.all`:

```typescript
const toolResults = await Promise.all(
  toolUseBlocks.map(async (toolUse) => {
    const result = await executeTool(toolUse.name, toolUse.input);
    return { type: "tool_result", tool_use_id: toolUse.id, content: result };
  })
);
messages.push({ role: "user", content: toolResults });
```

**Benefits:** Faster execution when the model calls multiple independent tools (e.g., reading three files simultaneously). A turn with 3 file reads taking 50ms each completes in ~50ms instead of ~150ms.

**Risks:** (1) Tools may have **dependencies** — the model might call `write_file` and `read_file` on the same file in one turn, where order matters. (2) **Resource contention** — parallel file writes could corrupt data. (3) **Error propagation** — if one tool fails, `Promise.all` rejects immediately, potentially losing results from other tools (use `Promise.allSettled` instead). Claude Code executes tools sequentially by default for safety, with parallel execution as an optimization for known-safe tool combinations.
