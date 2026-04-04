# Lesson 12: A Simple Agent Loop

Let's build a working agent loop from scratch. By the end of this lesson, you'll have real code that calls a model, executes tools, manages history, and solves a multi-step task — exactly the pattern Claude Code uses, just without the complexity.

## Step 1: The Bare Minimum

The absolute simplest agent loop sends a message, gets a response, and checks if the model wants to use a tool:

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

async function agentLoop(userMessage: string) {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages,
    });

    // If the model stopped naturally, we're done
    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock?.text ?? "";
    }
  }
}
```

This loop runs but does nothing interesting — the model can't use any tools yet.

## Step 2: Define Tools

Tools are described as JSON schemas so the model knows what's available. Let's give our agent two tools: one to read files and one to list directory contents.

```typescript
const tools: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file at the given path",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "The file path to read",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description: "List files and folders in a directory",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "The directory path to list",
        },
      },
      required: ["path"],
    },
  },
];
```

## Step 3: Execute Tools

When the model decides to use a tool, we need to actually run it. Each tool call has a name, an input, and an ID we must reference in the result.

```typescript
import * as fs from "fs";
import * as path from "path";

async function executeTool(
  name: string,
  input: Record<string, string>
): Promise<string> {
  switch (name) {
    case "read_file":
      try {
        return fs.readFileSync(input.path, "utf-8");
      } catch (e) {
        return `Error reading file: ${(e as Error).message}`;
      }

    case "list_directory":
      try {
        const entries = fs.readdirSync(input.path, { withFileTypes: true });
        return entries
          .map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`)
          .join("\n");
      } catch (e) {
        return `Error listing directory: ${(e as Error).message}`;
      }

    default:
      return `Unknown tool: ${name}`;
  }
}
```

Notice that tools return strings, and errors are returned as strings too — not thrown. The model needs to see error messages so it can adapt.

## Step 4: The Complete Loop

Now we wire it all together. The critical part is the conversation history management: after the model responds, we add its response. After tools execute, we add the results. The model always sees the full history.

```typescript
async function agentLoop(userMessage: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const systemPrompt = `You are a helpful coding assistant. You can read files
and list directories to understand codebases. Always explore before answering
questions about code.`;

  let iterations = 0;
  const maxIterations = 20;

  while (iterations < maxIterations) {
    iterations++;
    console.log(`\n--- Iteration ${iterations} ---`);

    // THINK: Call the model with full conversation history
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    // Add assistant response to conversation history
    messages.push({ role: "assistant", content: response.content });

    // Check if the model is done (no tool use)
    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text"
      );
      return textBlock?.text ?? "";
    }

    // ACT: Extract and execute all tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      console.log(`  Tool: ${toolUse.name}(${JSON.stringify(toolUse.input)})`);

      const result = await executeTool(
        toolUse.name,
        toolUse.input as Record<string, string>
      );

      console.log(`  Result: ${result.slice(0, 100)}...`);

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    // OBSERVE: Add tool results to conversation history
    messages.push({ role: "user", content: toolResults });
  }

  return "Max iterations reached. Task may be incomplete.";
}
```

## Step 5: Run It

```typescript
async function main() {
  const answer = await agentLoop(
    "What files are in the current directory? Read the package.json if it exists."
  );

  console.log("\n=== Final Answer ===");
  console.log(answer);
}

main();
```

Here's what happens when this runs:

```
--- Iteration 1 ---
  Tool: list_directory({"path":"."})
  Result: [file] package.json
[file] tsconfig.json
[dir] src
[dir] node_modules...

--- Iteration 2 ---
  Tool: read_file({"path":"./package.json"})
  Result: {
  "name": "my-project",
  "version": "1.0.0",
  ...

--- Iteration 3 ---

=== Final Answer ===
The current directory contains:
- **package.json** — a Node.js project called "my-project" at version 1.0.0...
- **tsconfig.json** — TypeScript configuration
- **src/** — source code directory
- **node_modules/** — installed dependencies
...
```

Three iterations. The model listed the directory, found `package.json`, read it, then synthesized a final answer. That's the agent loop in action.

## The Conversation History is Everything

Let's look at what `messages` contains after the loop finishes:

```typescript
[
  // The original user request
  { role: "user", content: "What files are in the current directory?..." },

  // Model's first response: decided to list the directory
  { role: "assistant", content: [{ type: "tool_use", name: "list_directory", ... }] },

  // Tool result from listing
  { role: "user", content: [{ type: "tool_result", content: "[file] package.json\n..." }] },

  // Model's second response: decided to read package.json
  { role: "assistant", content: [{ type: "tool_use", name: "read_file", ... }] },

  // Tool result from reading
  { role: "user", content: [{ type: "tool_result", content: "{ \"name\": ..." }] },

  // Model's final response: the answer
  { role: "assistant", content: [{ type: "text", text: "The current directory contains..." }] },
]
```

Every model call includes the **entire** conversation up to that point. The model has full context of what it has already done, what it found, and what the original task was. This is how it stays coherent across multiple iterations.

## What This Loop Is Missing

Our simple loop works, but Claude Code's loop handles many things we've skipped:

| Our Loop | Claude Code |
|----------|-------------|
| Blocking API calls | Streaming responses |
| Returns a string | Yields events via async generator |
| Simple iteration counter | Multiple layers of limits |
| No state management | Rich state object rebuilt each iteration |
| Crash on errors | Graceful recovery and fallback |
| Tools run sequentially | Parallel tool execution with permission system |
| Entire history sent every time | Context compaction when history grows large |

These aren't cosmetic differences — they're what separates a toy from production software. We'll build up to each of these in the coming lessons.

## The Pattern You Should Remember

Strip away everything and the pattern is always the same:

```
1. Send messages + tools to model
2. Get response
3. If no tool use → done
4. Execute tools
5. Append results to messages
6. Go to 1
```

Step 3 is the branching point. The model decides whether to continue or stop. The agent framework just executes whatever the model decides. The intelligence is in the model; the loop is the scaffolding.

---

**Key Takeaways**
- An agent loop is ~50 lines of real code at its core
- Tools are defined as JSON schemas, executed as regular functions
- Conversation history grows with each iteration: assistant message, then tool results
- The model sees the full history every time, so it knows what it has already done
- `stop_reason === "end_turn"` (no tool use) is the signal that the model is finished
- The simple loop and Claude Code's loop share the same fundamental structure

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook.

### Exercise 1 — Why Return Errors as Strings?
**Question:** In the `executeTool` function, errors are returned as strings rather than thrown as exceptions. Why is this design important for an agent loop? What would happen if tools threw exceptions instead?

[View Answer](../../answers/02-the-agent-loop/answer-12.md#exercise-1)

### Exercise 2 — Add a New Tool
**Challenge:** Extend the agent loop from this lesson by adding a `write_file` tool. Define the tool schema (JSON), implement the `executeTool` case, and handle errors properly. Your tool should take `path` and `content` parameters.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-12.md#exercise-2)

### Exercise 3 — Message History Structure
**Question:** After an agent loop completes a 3-iteration task (list directory → read file → give answer), how many messages are in the `messages` array? List each message's `role` and describe its content.

[View Answer](../../answers/02-the-agent-loop/answer-12.md#exercise-3)

### Exercise 4 — Safety Limit Bug
**Challenge:** The loop in this lesson uses `while (iterations < maxIterations)` as a safety limit. But there's a subtle issue: if `maxIterations` is reached, it returns a generic string. Improve this by: (a) making the return type a discriminated union that distinguishes success from limit-reached, and (b) including the iteration count in the limit-reached case.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-12.md#exercise-4)

### Exercise 5 — Parallel Tool Execution
**Question:** The lesson's loop executes tools sequentially with a `for` loop. What would need to change to execute tools in parallel? What are the benefits and risks of parallel execution?

[View Answer](../../answers/02-the-agent-loop/answer-12.md#exercise-5)
