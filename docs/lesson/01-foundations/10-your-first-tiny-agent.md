# Lesson 10: Your First Tiny Agent

## Introduction

You've spent 9 lessons learning the building blocks of AI coding agents. Now it's time to put them all together and **build one yourself**.

In this lesson, you'll build a minimal but fully functional agent in about 50 lines of TypeScript. It won't be as powerful as Claude Code, but it will follow the exact same pattern: a loop that calls a model, executes tools, and continues until the task is done.

---

## What We're Building

Our tiny agent will:

1. Accept a user message (like "What's in the README?")
2. Have access to one tool: `read_file`
3. Run the agent loop: call model → check for tool use → execute → repeat
4. Stop when the model responds with plain text (no more tool calls)

That's the same Think → Act → Observe loop from Lesson 1, implemented for real.

---

## The Three Components

Every agent needs three things:

1. **A message array** — the conversation history (Lesson 4)
2. **Tool definitions** — functions the model can call (Lesson 5)
3. **The agent loop** — call model → execute tools → repeat

Let's build all three. Here's the complete code:

```typescript
// tiny-agent.ts — A minimal AI coding agent
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs/promises";

const client = new Anthropic(); // Uses ANTHROPIC_API_KEY env variable

// ---------- Types ----------

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, string>;
}

type ContentBlock = TextBlock | ToolUseBlock;

interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[] | ToolResultBlock[];
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

// ---------- Tool Definition ----------

const tools: Anthropic.Tool[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file at the given path. Use this to inspect files on the local filesystem.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "The path of the file to read",
        },
      },
      required: ["path"],
    },
  },
];

async function executeTool(
  name: string,
  input: Record<string, string>
): Promise<string> {
  if (name === "read_file") {
    try {
      return await fs.readFile(input.path, "utf-8");
    } catch (err: any) {
      return `Error reading file: ${err.message}`;
    }
  }
  return `Unknown tool: ${name}`;
}

// ---------- Model Caller ----------

async function callModel(messages: Message[]) {
  return await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: "You are a helpful assistant. Use the read_file tool to read files when needed.",
    tools,
    messages,
  });
}

// ---------- Agent Loop ----------

async function runAgent(userMessage: string): Promise<string> {
  console.log(`\nUser: ${userMessage}\n`);

  const messages: Message[] = [{ role: "user", content: userMessage }];

  let iterations = 0;
  const maxIterations = 10;

  while (iterations < maxIterations) {
    iterations++;
    console.log(`--- Agent loop iteration ${iterations} ---`);

    const response = await callModel(messages);
    messages.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    // Print any text the model produced
    for (const block of response.content) {
      if (block.type === "text" && block.text) {
        console.log(`Agent: ${block.text}`);
      }
    }

    if (toolUseBlocks.length === 0) {
      console.log("\n--- Agent finished (no more tool calls) ---");
      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === "text"
      );
      return textBlock?.text ?? "Done (no text response)";
    }

    const toolResults: ToolResultBlock[] = [];
    for (const toolCall of toolUseBlocks) {
      console.log(`  → Calling ${toolCall.name}(${JSON.stringify(toolCall.input)})`);
      const result = await executeTool(toolCall.name, toolCall.input);
      console.log(`  ← Got ${result.length} characters`);

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return "Stopped: too many iterations";
}

// ---------- Main ----------

const userMessage = process.argv[2] ?? "Read the README.md file and summarize it.";
runAgent(userMessage).then((result) => {
  console.log(`\nFinal result:\n${result}`);
});
```

---

## Running the Agent

To run this agent, you would:

```bash
# 1. Install the Anthropic SDK
npm install @anthropic-ai/sdk

# 2. Set your API key
export ANTHROPIC_API_KEY="your-key-here"

# 3. Run the agent
npx tsx tiny-agent.ts "What's in the package.json file?"
```

And you'd see output like:

```
User: What's in the package.json file?

--- Agent loop iteration 1 ---
Agent: I'll read the package.json file for you.
  → Calling read_file({"path":"package.json"})
  ← Got 245 characters

--- Agent loop iteration 2 ---
Agent: Here's what's in your package.json:

- **Name**: my-project
- **Version**: 1.0.0
- **Dependencies**: express (4.18.2), zod (3.22.0)
- **Scripts**: start, test, build

--- Agent finished (no more tool calls) ---
```

The agent read the file using the tool, then summarized the contents. Two iterations of the loop, just like Claude Code would do (but simpler).

---

## How This Relates to Claude Code

Our tiny agent and Claude Code follow the **exact same pattern**. The difference is scale:

| Aspect             | Tiny Agent              | Claude Code                          |
| ------------------ | ----------------------- | ------------------------------------ |
| **Tools**          | 1 (read_file)           | 10+ (read, write, edit, bash, search, ...) |
| **UI**             | console.log             | React Ink terminal UI                 |
| **Error handling** | Basic try-catch         | Retries, fallbacks, graceful recovery |
| **Context mgmt**   | None (array grows forever) | Summarization, truncation, caching  |
| **Permissions**    | None                    | Full permission system                |
| **Streaming**      | No (request-response)   | Yes (SSE streaming)                   |
| **Max iterations** | 10                      | Configurable, much higher             |

But the **core loop is identical**:

```
1. Call the model with messages
2. If tool_use → execute → add results → loop
3. If text only → done
```

Everything else — the fancy UI, the permission system, the streaming, the error handling — is built around this core loop. That's the orchestrator (Lesson 8) doing its job.

---

## Extending the Tiny Agent

Want to make it more powerful? Add more tools: `list_directory`, `write_file`, `run_command`. Each tool you add gives the agent new capabilities. Add enough tools with a good system prompt, and you've got something that starts to look a lot like Claude Code.

---

## What You've Learned in This Module

Congratulations! You've completed the **Foundations** module. Here's everything you've learned:

| Lesson | Concept                    | Core Idea                                     |
| ------ | -------------------------- | --------------------------------------------- |
| 1      | What is an agent           | A loop that thinks, acts, and observes         |
| 2      | Terminal & CLI             | Text-based environment, perfect for AI         |
| 3      | LLMs                       | Text prediction machines, tokens, context      |
| 4      | Messages                   | Conversations as arrays, no memory between calls |
| 5      | Tool use                   | The concept that makes agents different from chatbots |
| 6      | JSON                       | Structured communication, validated with Zod   |
| 7      | Streaming                  | Real-time token delivery via SSE               |
| 8      | Good agent qualities       | 7 qualities, orchestrator > model              |
| 9      | Claude Code architecture   | 5 layers: Entry → REPL → Engine → Loop → Tools |
| 10     | Build a tiny agent         | ~100 lines of code, same pattern as the real thing |

You started knowing nothing about AI agents and now you understand every fundamental concept behind them. The rest of this course will go deeper into each layer, but the foundation is solid.

---

## Summary

- A minimal agent needs three things: a **message array**, **tool definitions**, and **the agent loop**.
- The loop is: call model → check for tool_use → execute tools → add results → repeat.
- Our tiny agent follows the **exact same pattern** as Claude Code, just with fewer tools and less orchestration.
- Adding more tools, better error handling, streaming, and a UI is what turns a tiny agent into a production agent.

---

> **Key Takeaway**
>
> An AI coding agent is simpler than you think. At its core, it's just a loop: call the model, execute any tool calls, feed the results back, and repeat. Everything else — the UI, permissions, streaming, error handling — is important but secondary. Once you understand this loop, you understand the beating heart of every AI coding agent, including Claude Code.

---

---

## Practice Exercises

> **Remember**: Write your answers in your notebook first, then check below.

### Exercise 1 — Three Components
**Question:** Every agent needs three things to function. What are they, and what lesson from this module introduced each concept?

[View Answer](../../answers/01-foundations/answer-10.md#exercise-1)

### Exercise 2 — Tiny vs Production
**Question:** The tiny agent and Claude Code follow the same core loop. Name at least four things that Claude Code adds on top of the basic loop that the tiny agent lacks.

[View Answer](../../answers/01-foundations/answer-10.md#exercise-2)

### Exercise 3 — The Stop Condition
**Question:** In the tiny agent code, what are the two conditions that cause the agent loop to stop? Why are both important?

[View Answer](../../answers/01-foundations/answer-10.md#exercise-3)

### Exercise 4 — Code Challenge: Add a Write File Tool
**Challenge:** Extend the tiny agent by adding a `write_file` tool. Write the tool definition (for the `tools` array) and the corresponding `executeTool` handler that writes content to a file path. The tool should accept `path` (string) and `content` (string) as inputs.

Write your solution in your IDE first, then check:

[View Answer](../../answers/01-foundations/answer-10.md#exercise-4)

### Exercise 5 — Code Challenge: Add a Max Iterations Guard
**Challenge:** The tiny agent has `maxIterations = 10` as a safety limit. Write a version of the loop termination logic that also prints a warning message when the agent reaches 80% of its iteration limit (iteration 8 of 10), so the user knows the agent is running long.

Write your solution in your IDE first, then check:

[View Answer](../../answers/01-foundations/answer-10.md#exercise-5)

---

*You've completed Module 01: Foundations! In the next module, we'll dive deeper into each component and start building more sophisticated agents.*
