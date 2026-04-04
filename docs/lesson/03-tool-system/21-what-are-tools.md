# Lesson 21: What Are Tools?

## The Model's Hands

In Modules 01 and 02, you learned how an AI coding agent works at its core: the
agentic loop queries the model, streams back a response, and loops until the task
is done. But there's a critical piece we glossed over—**how does the model actually
do things?**

A language model, on its own, can only produce text. It can't read files, run
commands, search the web, or write code to disk. It's like a brilliant architect
who can describe every detail of a building but has no hands to pick up a hammer.

**Tools are the hands.**

A tool is a function that the AI can ask the host application to execute on its
behalf. When the model decides it needs to read a file, it doesn't magically access
the filesystem—it emits a structured request saying "please call the `Read` tool
with this file path," and the agent runtime executes that function and returns the
result.

## The tool_use → tool_result Cycle

Every tool interaction follows a two-step protocol defined by the Anthropic API:

```
┌──────────┐    tool_use block     ┌──────────────┐
│          │ ───────────────────▶  │              │
│  Model   │                       │  Agent       │
│          │ ◀───────────────────  │  Runtime     │
└──────────┘    tool_result block  └──────────────┘
```

### Step 1: The Model Emits `tool_use`

When the model decides to use a tool, it includes a `tool_use` content block in
its response:

```json
{
  "type": "tool_use",
  "id": "toolu_01A2B3C4D5",
  "name": "Read",
  "input": {
    "file_path": "/home/user/project/src/index.ts",
    "offset": 1,
    "limit": 50
  }
}
```

This is **not** a function call in the traditional sense. The model is producing
structured JSON output that conforms to a schema it was told about. It's declaring
its *intent* to use a tool.

### Step 2: The Runtime Executes and Returns `tool_result`

The agent runtime receives this block, finds the matching tool, validates the input,
executes the function, and sends the result back as a `tool_result` message:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A2B3C4D5",
      "content": "1|import express from 'express';\n2|import { router } from './routes';\n3|\n4|const app = express();\n5|app.use(router);\n..."
    }
  ]
}
```

The model then sees this result in its context and can use it to make decisions,
generate more text, or call more tools.

### Step 3: Loop

This is the same agentic loop from Lesson 05. The model may respond with more text,
more tool calls, or both. A single assistant turn can contain **multiple** tool_use
blocks—we'll explore how these are orchestrated later in this module.

## A Concrete Example

Let's trace a real interaction. The user asks: *"What's in my package.json?"*

```
Turn 1 — Assistant response:
  [text]    "Let me read your package.json."
  [tool_use] { name: "Read", input: { file_path: "package.json" } }

Turn 2 — User message (injected by runtime):
  [tool_result] { tool_use_id: "toolu_...", content: "{\n  \"name\": \"my-app\"..." }

Turn 3 — Assistant response:
  [text]    "Your package.json defines a project called 'my-app' with..."
```

The model never touched the filesystem. The runtime did. But from the user's
perspective, the AI "read the file."

## How Tools Extend the Model

Without tools, a language model is limited to what's in its training data and the
current conversation context. Tools blow this open:

| Capability         | Without Tools         | With Tools                     |
|--------------------|-----------------------|--------------------------------|
| Read files         | Only if pasted in     | Any file on disk               |
| Write files        | Suggest code in chat  | Actually create/edit files     |
| Run commands       | Suggest commands      | Execute and see output         |
| Search codebase    | Guess from context    | Grep, glob, find precisely     |
| Browse the web     | Rely on training data | Fetch live pages               |
| Manage tasks       | Verbal promises       | Structured todo tracking       |

## The Analogy: A Chef and Their Kitchen

Think of the model as a chef who can plan any recipe. Tools are the kitchen
equipment:

- **Read** is opening the pantry to see what ingredients are available
- **Write** is plating the finished dish
- **Bash** is the stove and oven—where transformations happen
- **Grep** is the label maker—finding exactly what you need quickly
- **WebFetch** is calling a supplier for ingredients you don't have

The chef decides *what* to cook and *when* to use each piece of equipment. The
kitchen doesn't act on its own. But without the kitchen, the chef is just someone
standing in an empty room describing food.

## What the Model Sees

When you define tools for a model, they're described in the API request. The model
receives a tool list as part of the system prompt:

```typescript
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 4096,
  tools: [
    {
      name: "Read",
      description: "Read a file from the filesystem",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file" },
          offset: { type: "number", description: "Line to start reading from" },
          limit: { type: "number", description: "Number of lines to read" },
        },
        required: ["file_path"],
      },
    },
    // ... more tools
  ],
  messages: conversationHistory,
});
```

The model uses the `name`, `description`, and `input_schema` to decide:
1. **Which** tool to use for the current task
2. **What** arguments to pass
3. **When** to use a tool vs. just responding with text

The quality of tool descriptions directly affects how well the model uses them.
We'll explore this further when we cover prompt engineering in a later module.

## Multiple Tools in One Turn

The model can request multiple tools in a single response:

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Let me check both files." },
    { "type": "tool_use", "id": "toolu_1", "name": "Read", "input": { "file_path": "package.json" } },
    { "type": "tool_use", "id": "toolu_2", "name": "Read", "input": { "file_path": "tsconfig.json" } }
  ]
}
```

The runtime must handle all of them and return all results:

```json
{
  "role": "user",
  "content": [
    { "type": "tool_result", "tool_use_id": "toolu_1", "content": "{ ... }" },
    { "type": "tool_result", "tool_use_id": "toolu_2", "content": "{ ... }" }
  ]
}
```

How Claude Code decides whether to run these in parallel or sequentially is one of
the most interesting parts of the tool system—covered in Lessons 28 and 29.

## Key Takeaways

1. **Tools are functions** the model can request the runtime to execute
2. The protocol is `tool_use` (model → runtime) → `tool_result` (runtime → model)
3. Tools transform a text-only model into an agent that can **act** in the world
4. The model chooses tools based on their **name**, **description**, and **schema**
5. Multiple tool calls can happen in a single turn

## What's Next

Now that you understand *what* tools are, let's look at *how* they're built.
In the next lesson, we'll dissect the anatomy of a tool definition—every property,
every method, and how they fit together.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Two-Step Protocol

**Question:** Describe the `tool_use` → `tool_result` cycle in your own words. What role does each participant (model, runtime) play, and why is `tool_use` **not** a traditional function call?

[View Answer](../../answers/03-tool-system/answer-21.md#exercise-1)

### Exercise 2 — Trace a Tool Interaction

**Challenge:** A user asks: *"Delete all `.log` files in my project."* Write the complete sequence of `tool_use` and `tool_result` JSON blocks (at least 2 turns) that an agent might produce. Include realistic `id` fields and content.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-21.md#exercise-2)

### Exercise 3 — Multiple Tools in One Turn

**Challenge:** Write a single assistant response (as JSON) that contains a text block and **three** `tool_use` blocks — one `Grep`, one `Read`, and one `Glob` — all in the same turn. Then write the corresponding `tool_result` user message with all three results.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-21.md#exercise-3)

### Exercise 4 — Tools as Capabilities

**Question:** Using the "chef and kitchen" analogy from the lesson, explain what would happen if you removed the `Grep` tool from an agent. How would the agent's behavior change when asked to find a specific function in a large codebase?

[View Answer](../../answers/03-tool-system/answer-21.md#exercise-4)

---

*Module 03: The Tool System — Lesson 21 of 35*
