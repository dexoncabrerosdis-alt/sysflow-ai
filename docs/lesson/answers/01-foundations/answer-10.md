# Answers: Lesson 10 — Your First Tiny Agent

## Exercise 1

**Question:** Every agent needs three things to function. What are they, and what lesson from this module introduced each concept?

**Answer:** Every agent needs: (1) A **message array** — the conversation history that grows with each interaction, introduced in Lesson 4 (Messages and Conversations); (2) **Tool definitions** — functions the model can call to interact with the real world, introduced in Lesson 5 (What Is Tool Use?); and (3) **The agent loop** — the cycle of calling the model, executing tool calls, adding results, and repeating, introduced in Lesson 1 (What Is an AI Coding Agent?) as the Think → Act → Observe loop.

---

## Exercise 2

**Question:** The tiny agent and Claude Code follow the same core loop. Name at least four things that Claude Code adds on top of the basic loop that the tiny agent lacks.

**Answer:** Claude Code adds: (1) **Many more tools** — over 10 tools including write, edit, bash, and search, compared to the tiny agent's single `read_file` tool; (2) **Streaming** — real-time token delivery via SSE so you see the agent work live, rather than waiting for full responses; (3) **A permission system** — asking for user approval before running dangerous commands, instead of executing everything blindly; (4) **Error handling and retries** — graceful recovery from failures with exponential backoff, rather than basic try-catch; (5) **Context window management** — summarization and truncation to keep the conversation within token limits; and (6) **A rich terminal UI** — built with React Ink for formatted output, rather than simple `console.log`.

---

## Exercise 3

**Question:** In the tiny agent code, what are the two conditions that cause the agent loop to stop? Why are both important?

**Answer:** The two stop conditions are: (1) **The model responds with no tool_use blocks** — when the response contains only text, it means the model has completed its task and has a final answer to present. This is the normal "success" exit. (2) **The iteration count exceeds `maxIterations` (10)** — this is a safety guard that prevents the agent from looping forever if it gets stuck in a cycle of tool calls. Without this limit, a confused model could keep calling tools indefinitely, burning API credits and never finishing. Both conditions are important: one handles the happy path, the other prevents runaway behavior.

---

## Exercise 4

**Challenge:** Extend the tiny agent by adding a `write_file` tool.

**Answer:**

Tool definition to add to the `tools` array:

```typescript
{
  name: "write_file",
  description:
    "Write content to a file at the given path. Creates the file if it doesn't exist, or overwrites it if it does.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "The path of the file to write",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["path", "content"],
  },
}
```

Handler to add inside the `executeTool` function:

```typescript
if (name === "write_file") {
  try {
    await fs.writeFile(input.path, input.content, "utf-8");
    return `Successfully wrote ${input.content.length} characters to ${input.path}`;
  } catch (err: any) {
    return `Error writing file: ${err.message}`;
  }
}
```

**Explanation:** The tool definition follows the same pattern as `read_file`: a name, description, and input schema with required properties. The execute handler uses Node's `fs.writeFile` to write the content, wrapped in a try-catch for reliability. It returns a success message with the character count or an error message if writing fails. With this tool added, the agent can now both read and write files.

---

## Exercise 5

**Challenge:** Write loop termination logic with a warning at 80% of the iteration limit.

**Answer:**

```typescript
const maxIterations = 10;
const warningThreshold = Math.floor(maxIterations * 0.8);

while (iterations < maxIterations) {
  iterations++;

  if (iterations === warningThreshold) {
    console.warn(
      `⚠ Warning: Agent has used ${iterations}/${maxIterations} iterations. ` +
      `It may be running longer than expected.`
    );
  }

  console.log(`--- Agent loop iteration ${iterations} ---`);

  const response = await callModel(messages);
  // ... rest of the loop logic ...
}

if (iterations >= maxIterations) {
  console.error(`✗ Agent stopped: reached maximum of ${maxIterations} iterations.`);
  return "Stopped: too many iterations";
}
```

**Explanation:** The warning threshold is calculated as 80% of `maxIterations` (so iteration 8 out of 10). When the loop reaches that iteration, it prints a warning so the user knows the agent is consuming a lot of iterations and might not finish normally. The final guard after the loop provides a clear error message if the limit is actually reached. This is a small but practical improvement to the agent's transparency and reliability.
