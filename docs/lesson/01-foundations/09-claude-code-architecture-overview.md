# Lesson 9: Claude Code Architecture Overview

## Introduction

Over the past 8 lessons, you've learned the fundamental concepts: agents follow a Think → Act → Observe loop (Lesson 1), they live in the terminal (Lesson 2), they're powered by LLMs (Lesson 3), they communicate through message arrays (Lesson 4), they use tools (Lesson 5), they speak JSON (Lesson 6), they stream responses (Lesson 7), and the orchestrator is what makes them great (Lesson 8).

Now let's see how all of these concepts come together in a **real agent**. In this lesson, you'll get a high-level tour of Claude Code's architecture — the files, the data flow, and the tech stack.

---

## The Big Picture

Claude Code's architecture can be summarized in five layers:

```
┌─────────────────────────────────────────────────┐
│  1. ENTRY POINT                                 │
│     cli.tsx — parses arguments, starts the app   │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  2. REPL (Read-Eval-Print Loop)                 │
│     main.tsx — shows the UI, takes your input   │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  3. QUERY ENGINE                                │
│     QueryEngine.ts — manages the conversation   │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  4. AGENT LOOP                                  │
│     query.ts — calls the model, handles tools   │
└──────────────────────┬──────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│  5. TOOLS                                       │
│     tools.ts — reads files, runs commands, etc. │
└─────────────────────────────────────────────────┘
```

Let's walk through each layer.

---

## Layer 1: Entry Point — `cli.tsx`

When you type `claude` in your terminal, this is the first file that runs. Its job is simple:

1. **Parse command-line arguments** (flags like `--model`, `--verbose`, etc.)
2. **Set up configuration** (API keys, permissions, settings)
3. **Launch the main application**

Think of it as the front door. You walk in, someone checks your ID, and you're directed to the right room.

```
Terminal command:  claude "fix the bug in app.ts"
                       │
                       ▼
                   cli.tsx
                   ├── Parse arguments
                   ├── Load config
                   └── Start the app → main.tsx
```

---

## Layer 2: REPL — `main.tsx`

**REPL** stands for **Read-Eval-Print Loop** — a common pattern where the program:

1. **Reads** your input
2. **Evaluates** it (processes it)
3. **Prints** the result
4. **Loops** back to read more input

`main.tsx` implements this loop with a visual user interface built using **React Ink** (more on this below). It:

- Shows you the prompt where you type your messages
- Displays the agent's responses in real time (using streaming from Lesson 7)
- Handles keyboard shortcuts and commands
- Manages the visual layout (tool results, progress indicators, etc.)

When you type a message and press Enter, `main.tsx` passes your message to the next layer: the Query Engine.

---

## Layer 3: Query Engine — `QueryEngine.ts`

The Query Engine is the **conversation manager**. Remember from Lesson 4 that a conversation is an array of messages? The Query Engine is responsible for that array.

It handles:

- **Adding messages** to the conversation (your input, the model's output, tool results)
- **Managing the context window** (making sure the message array doesn't exceed the token limit)
- **Sending requests** to the Claude API
- **Processing responses** (parsing the streamed response into structured data)

Think of the Query Engine as a secretary: it keeps the meeting notes (conversation history), manages the schedule (API calls), and handles communication (sending/receiving messages).

```
Your message: "Fix the bug in app.ts"
        │
        ▼
QueryEngine
├── Adds your message to the conversation array
├── Prepares the API request (model, system prompt, messages, tools)
├── Sends request to Claude API
├── Receives and processes the streamed response
└── Returns the model's response to the agent loop
```

---

## Layer 4: Agent Loop — `query.ts`

This is the **heart of the agent** — the Think → Act → Observe loop you learned about in Lesson 1.

The agent loop does exactly what we described in Lesson 5:

1. **Call the model** (via the Query Engine)
2. **Check the response** — does it contain `tool_use` blocks?
3. **If yes**: execute the tools, add results to conversation, go to step 1
4. **If no**: the task is done, return the final response

Here's a simplified version of how it works:

```typescript
async function agentLoop(userMessage: string) {
  // Add the user's message
  conversation.push({ role: "user", content: userMessage });

  while (true) {
    // Step 1: Call the model
    const response = await queryEngine.send(conversation);

    // Step 2: Add the model's response
    conversation.push({ role: "assistant", content: response.content });

    // Step 3: Check for tool use
    const toolCalls = response.content.filter(
      (block) => block.type === "tool_use"
    );

    if (toolCalls.length === 0) {
      // No tool calls — we're done!
      break;
    }

    // Step 4: Execute each tool and collect results
    const results = [];
    for (const toolCall of toolCalls) {
      const result = await executeTool(toolCall.name, toolCall.input);
      results.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: result,
      });
    }

    // Step 5: Add tool results and loop back
    conversation.push({ role: "user", content: results });
  }
}
```

This loop keeps running until the model responds with plain text (no tool calls), which signals that it has finished the task.

---

## Layer 5: Tools — `tools.ts`

Tools are the **hands of the agent** — they're how it interacts with your computer. Each tool is a function with:

- A **name** (e.g., `read_file`)
- A **description** (tells the model what the tool does)
- An **input schema** (defines the expected inputs, validated with Zod from Lesson 6)
- An **execute function** (the actual code that runs)

Here are some of the key tools in Claude Code:

```typescript
// Simplified tool definitions

const readFile = {
  name: "Read",
  description: "Read the contents of a file",
  inputSchema: z.object({
    file_path: z.string(),
  }),
  async execute({ file_path }) {
    return await fs.readFile(file_path, "utf-8");
  },
};

const writeFile = {
  name: "Write",
  description: "Write content to a file (creates or overwrites)",
  inputSchema: z.object({
    file_path: z.string(),
    content: z.string(),
  }),
  async execute({ file_path, content }) {
    await fs.writeFile(file_path, content, "utf-8");
    return "File written successfully";
  },
};

const runCommand = {
  name: "Bash",
  description: "Run a shell command",
  inputSchema: z.object({
    command: z.string(),
  }),
  async execute({ command }) {
    const result = await exec(command);
    return result.stdout + result.stderr;
  },
};
```

The tools are where the agent's power comes from. Without tools, it's just a chatbot. With tools, it can do real work.

---

## The System Prompt — `prompts.ts`

Remember the system message from Lesson 4? Claude Code has a carefully crafted system prompt that tells the model:

- **What it is**: "You are Claude Code, an interactive CLI tool..."
- **What tools it has**: descriptions of every available tool
- **How to behave**: rules about reading before editing, asking permission, etc.
- **What environment it's in**: the operating system, current directory, project info

The system prompt is like the agent's training manual. It shapes every decision the model makes. A well-written system prompt is one of the most important parts of a good agent.

---

## The Tech Stack

Claude Code is built with modern tools:

| Technology       | What it's used for                                    |
| ---------------- | ----------------------------------------------------- |
| **Bun**          | JavaScript/TypeScript runtime (faster alternative to Node.js) |
| **TypeScript**   | The programming language (JavaScript with types)       |
| **React Ink**    | Renders the terminal UI (like React, but for the terminal) |
| **Zod**          | Validates tool inputs (as we saw in Lesson 6)          |

**Bun** is a fast JavaScript runtime — it starts faster than Node.js, making the CLI feel instant. **React Ink** lets you build terminal UIs with React patterns (formatted output, progress indicators, colors). **TypeScript** adds type checking to catch bugs early. **Zod** validates tool inputs (as we saw in Lesson 6) to prevent malformed data from causing issues.

---

## How Data Flows Through the System

Here's the complete flow when you give Claude Code a task like "Add error handling to the API routes":

```
YOU type your request
  → cli.tsx receives it, starts the app
    → main.tsx shows UI, passes message to Query Engine
      → QueryEngine.ts builds message array, sends to Claude API
        → Claude API streams a response with tool_use blocks
          → query.ts (agent loop) executes the tools via tools.ts
            → Tools read/edit files, run commands on your computer
          → Results go back to the model, loop repeats
        → Model eventually responds with text (no more tool calls)
      → QueryEngine.ts returns the final response
    → main.tsx displays the result in your terminal
```

Every concept from this module appears in this flow: the **terminal** (Lesson 2), the **LLM** (Lesson 3), **messages** (Lesson 4), **tool use** (Lesson 5), **JSON** (Lesson 6), **streaming** (Lesson 7), and the **orchestrator qualities** (Lesson 8).

---

## Summary

- Claude Code has 5 layers: **Entry Point** → **REPL** → **Query Engine** → **Agent Loop** → **Tools**
- `cli.tsx` starts the app, `main.tsx` handles the UI, `QueryEngine.ts` manages conversations, `query.ts` runs the agent loop, and `tools.ts` defines the tools.
- The **system prompt** in `prompts.ts` shapes how the agent behaves.
- The tech stack is **Bun** (runtime), **TypeScript** (language), **React Ink** (terminal UI), and **Zod** (validation).
- Data flows from your input, through the layers, to the Claude API, through tools, and back to your terminal.

---

> **Key Takeaway**
>
> Claude Code is not one monolithic program — it's a pipeline of specialized layers, each handling a specific concern. The entry point handles startup, the REPL handles UI, the Query Engine handles conversations, the agent loop handles tool execution, and the tools handle interaction with your computer. Understanding this layered architecture is the key to understanding any AI coding agent.

---

---

## Practice Exercises

> **Remember**: Write your answers in your notebook first, then check below.

### Exercise 1 — The Five Layers
**Question:** Name all 5 layers of Claude Code's architecture in order (from entry point to tools), and describe the main responsibility of each layer in one sentence.

[View Answer](../../answers/01-foundations/answer-09.md#exercise-1)

### Exercise 2 — The System Prompt
**Question:** What is the role of `prompts.ts` (the system prompt) in Claude Code's architecture? What kinds of information does it contain?

[View Answer](../../answers/01-foundations/answer-09.md#exercise-2)

### Exercise 3 — Data Flow
**Question:** Trace the data flow when a user types "Fix the bug in app.ts" into Claude Code. Start from the user's input and describe how it moves through each layer.

[View Answer](../../answers/01-foundations/answer-09.md#exercise-3)

### Exercise 4 — Code Challenge: Simple Tool Definition
**Challenge:** Following the structure shown in the lesson's `tools.ts` examples, write a tool definition for a `search_code` tool that searches for a text pattern across files. It should accept `pattern` (required string) and `file_extension` (optional string) as inputs, and use a Zod schema for validation.

Write your solution in your IDE first, then check:

[View Answer](../../answers/01-foundations/answer-09.md#exercise-4)

---

*Next up: [Lesson 10 — Your First Tiny Agent](./10-your-first-tiny-agent.md), where you'll build a working agent from scratch in ~50 lines of code!*
