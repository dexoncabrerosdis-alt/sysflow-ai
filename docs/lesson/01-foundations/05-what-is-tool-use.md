# Lesson 5: What Is Tool Use?

## Introduction

In Lessons 1–4, you learned that an AI agent is powered by an LLM that generates text in a conversation format. But here's the problem: generating text alone doesn't let the model *do* anything. It can write code in a chat message, but it can't save that code to a file. It can suggest a command, but it can't run it.

**Tool use** is the concept that bridges this gap. It's what transforms a chatbot into an agent.

---

## The Key Concept: The Model Can Call Functions

Here's the big idea:

> Instead of just generating text, the model can output a structured **request to call a function**. The system running the model executes that function and sends the result back. Then the model continues.

This is called **tool use** (also known as "function calling").

For example, instead of saying *"you should read the file app.js"*, the model can output:

```json
{
  "type": "tool_use",
  "name": "read_file",
  "input": { "path": "src/app.js" }
}
```

This isn't a chat message — it's an **instruction** to the system: "Please run the `read_file` function with this input and give me the result."

The system (the agent program running on your computer) sees this, reads the file, and sends the contents back to the model. Then the model continues with full knowledge of what's in the file.

**This is what makes agents different from chatbots.**

---

## The Tool Use Cycle

Tool use follows a specific cycle with four steps:

```
┌──────────────┐
│   1. MODEL   │  Model generates a tool_use request
│   decides    │  "I want to call read_file"
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ 2. TOOL_USE  │  Model outputs structured data:
│   request    │  { name: "read_file", input: { path: "app.js" } }
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ 3. EXECUTION │  The agent program runs the function
│              │  → Actually reads app.js from disk
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ 4. TOOL_     │  Result is sent back to the model
│   RESULT     │  "const x = 1;\nconst y = 2;\n..."
└──────┬───────┘
       │
       ▼
┌──────────────┐
│   MODEL      │  Model continues with the result
│   continues  │  "I can see the code. The bug is on line 5..."
└──────────────┘
```

Let's walk through a complete example.

---

## Complete Example: A Calculator Tool

Let's say we give the model a simple tool called `calculator` that can do math. Here's how the entire interaction looks:

### Step 1: Define the Tool

First, we tell the model what tools are available:

```typescript
const tools = [
  {
    name: "calculator",
    description: "Performs basic arithmetic. Use this when you need to calculate something.",
    input_schema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "A math expression like '2 + 3' or '100 / 4'",
        },
      },
      required: ["expression"],
    },
  },
];
```

This tells the model: "You have a tool called `calculator`. It takes a math expression as input."

### Step 2: Send a Message

```typescript
const messages = [{ role: "user", content: "What is 1,547 × 382?" }];

const response = await callModel({ messages, tools });
```

### Step 3: Model Responds with tool_use

Instead of guessing the answer (which LLMs are notoriously bad at for large multiplications), the model responds:

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "I'll calculate that for you."
    },
    {
      "type": "tool_use",
      "id": "tool_abc123",
      "name": "calculator",
      "input": {
        "expression": "1547 * 382"
      }
    }
  ]
}
```

Notice: the assistant's response contains **both** text and a tool_use block. The model is saying "I want to use the calculator tool with this input."

### Step 4: System Executes the Tool

The agent program sees the `tool_use` block, runs the calculation, and gets the result: `590,954`.

### Step 5: Send the Result Back

```typescript
messages.push(
  // The assistant's message (including the tool_use block)
  assistantMessage,
  // The tool result
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool_abc123",
        content: "590954",
      },
    ],
  }
);

const nextResponse = await callModel({ messages, tools });
```

### Step 6: Model Continues

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "1,547 × 382 = 590,954"
    }
  ]
}
```

The model now has the correct answer and presents it to the user. No more guessing.

---

## How This Looks in the Messages Array

After the full interaction, the messages array looks like this:

```typescript
const messages = [
  // 1. User asks a question
  { role: "user", content: "What is 1,547 × 382?" },

  // 2. Model requests to use a tool
  {
    role: "assistant",
    content: [
      { type: "text", text: "I'll calculate that for you." },
      {
        type: "tool_use",
        id: "tool_abc123",
        name: "calculator",
        input: { expression: "1547 * 382" },
      },
    ],
  },

  // 3. System provides the tool result
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool_abc123",
        content: "590954",
      },
    ],
  },

  // 4. Model gives final answer
  { role: "assistant", content: "1,547 × 382 = 590,954" },
];
```

See how the tool_use and tool_result fit naturally into the messages array? They're just messages with special content types. The model sees the full history including its own tool requests and the results.

---

## Real Agent Tools

A calculator is a simple example, but real coding agents have much more powerful tools. Here are the kinds of tools Claude Code has:

| Tool             | What it does                         |
| ---------------- | ------------------------------------ |
| `read_file`      | Reads the contents of a file         |
| `write_file`     | Creates or overwrites a file         |
| `edit_file`      | Makes targeted edits to a file       |
| `run_command`    | Runs a terminal command              |
| `search_files`   | Searches for text across files       |
| `list_files`     | Lists files in a directory           |

Each tool follows the exact same pattern: the model outputs a `tool_use` block, the system executes it, and the result goes back to the model.

Each tool follows the same `tool_use` → execute → `tool_result` pattern we just saw with the calculator.

---

## The Agent Loop, Revisited

Remember the Think → Act → Observe loop from Lesson 1? Now you can see how it works mechanically:

```
THINK:    Model generates text explaining its reasoning
ACT:      Model outputs a tool_use block
OBSERVE:  System executes the tool and sends tool_result back
          Model reads the result and THINKs again...
```

The agent loop is just **repeated tool use**:

1. Call the model
2. If the response contains `tool_use` → execute the tools, add results, go to step 1
3. If the response is just text → we're done, show it to the user

That's the entire agent loop. We'll build one ourselves in Lesson 10.

---

## Summary

- **Tool use** lets the model call functions instead of just generating text.
- The cycle is: **model → tool_use → execution → tool_result → model**.
- Tools are defined with a **name**, **description**, and **input schema**.
- Tool calls and results are just **messages** in the conversation array.
- Real agents have tools for reading files, writing files, running commands, and more.
- The agent loop is just **repeated tool use** until the model responds with plain text.

---

> **Key Takeaway**
>
> Tool use is the single concept that makes an agent different from a chatbot. Without tools, the model can only talk. With tools, it can act. The tool use cycle — request, execute, return result — is the mechanical heart of every AI coding agent.

---

---

## Practice Exercises

> **Remember**: Write your answers in your notebook first, then check below.

### Exercise 1 — The Core Idea
**Question:** What is "tool use" and why is it the concept that transforms a chatbot into an agent?

[View Answer](../../answers/01-foundations/answer-05.md#exercise-1)

### Exercise 2 — The Tool Use Cycle
**Question:** Describe the four steps of the tool use cycle in order. What happens at each step?

[View Answer](../../answers/01-foundations/answer-05.md#exercise-2)

### Exercise 3 — Agent Loop Logic
**Question:** In the agent loop, how does the system decide whether to keep looping or stop? What signals "we're done"?

[View Answer](../../answers/01-foundations/answer-05.md#exercise-3)

### Exercise 4 — Code Challenge: Define a Tool
**Challenge:** Write a tool definition object (in TypeScript) for a tool called `list_files` that lists all files in a given directory. Include the `name`, `description`, and `input_schema` with a required `directory` property of type `string`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/01-foundations/answer-05.md#exercise-4)

---

*Next up: [Lesson 6 — JSON Communication](./06-json-communication.md), where you'll learn how tools communicate using structured data.*
