# Lesson 4: Messages and Conversations

## Introduction

In Lesson 3, you learned that an LLM takes a prompt and produces a completion. But real conversations aren't just one question and one answer — they're a back-and-forth exchange. How does a model handle multi-turn conversations?

The answer is surprisingly simple: **a conversation is just an array of messages.** In this lesson, you'll learn how messages work, what roles are, and a crucial fact about how LLMs "remember" things.

---

## Chat Format: Messages with Roles

When you talk to an LLM through an API, you don't send a single block of text. You send an **array of messages**, where each message has a **role** and **content**.

There are three roles:

| Role          | Who's talking?  | Purpose                                          |
| ------------- | --------------- | ------------------------------------------------ |
| **system**    | The developer   | Sets the model's behavior, personality, and rules |
| **user**      | The human       | Asks questions or gives instructions              |
| **assistant** | The AI model    | The model's responses                             |

Think of it like a script for a play:

```
SYSTEM:    "You are a helpful coding assistant."
USER:      "What does the map() function do in JavaScript?"
ASSISTANT: "The map() function creates a new array by calling a
            function on each element of the original array..."
USER:      "Can you show me an example?"
ASSISTANT: "Sure! Here's an example..."
```

Each line has a role (who's speaking) and content (what they said).

---

## Conversations Are Arrays

In code, a conversation looks like this:

```typescript
const messages = [
  {
    role: "system",
    content: "You are a helpful coding assistant. Be concise.",
  },
  {
    role: "user",
    content: "What does the map() function do in JavaScript?",
  },
  {
    role: "assistant",
    content:
      "The map() function creates a new array by transforming each element of the original array using a callback function.",
  },
  {
    role: "user",
    content: "Show me an example.",
  },
];
```

When you send this array to the API, the model reads the entire conversation and generates the next assistant message.

```typescript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": "your-api-key",
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: "You are a helpful coding assistant. Be concise.",
    messages: [
      {
        role: "user",
        content: "What does the map() function do in JavaScript?",
      },
      {
        role: "assistant",
        content:
          "The map() function creates a new array by transforming each element using a callback function.",
      },
      {
        role: "user",
        content: "Show me an example.",
      },
    ],
  }),
});
```

> **Note:** In the Anthropic API, the `system` message is sent as a separate field (not inside the `messages` array). Other APIs like OpenAI include it in the messages array. The concept is the same either way.

The model will respond with something like:

```typescript
{
  role: "assistant",
  content: "Here's an example:\n\nconst numbers = [1, 2, 3];\nconst doubled = numbers.map(n => n * 2);\nconsole.log(doubled); // [2, 4, 6]"
}
```

---

## Why Order Matters

The model reads messages **in order**, from first to last. The order of messages affects the response because the model treats earlier messages as context for later ones.

Here's an example that shows why order matters:

```typescript
// Conversation A — user asks about Python
const messagesA = [
  { role: "user", content: "I'm writing Python code." },
  { role: "assistant", content: "Great! How can I help with your Python code?" },
  { role: "user", content: "How do I read a file?" },
];
// Model will respond with PYTHON file reading code

// Conversation B — user asks about JavaScript
const messagesB = [
  { role: "user", content: "I'm writing JavaScript code." },
  { role: "assistant", content: "Great! How can I help with your JavaScript code?" },
  { role: "user", content: "How do I read a file?" },
];
// Model will respond with JAVASCRIPT file reading code
```

The question "How do I read a file?" is the same in both conversations, but the model gives different answers because the earlier messages provide different context.

This matters for agents because the agent builds up a long message history over time. Every file it reads, every command it runs, every result it sees — it all goes into the messages array, influencing future decisions.

---

## The System Message

The **system message** is special. It sets the ground rules for the entire conversation. The model treats it as instructions from the developer, not from the user.

For Claude Code, the system message is something like:

```typescript
const systemMessage = `You are Claude Code, an AI coding agent.

You have access to tools that let you read files, write files,
run terminal commands, and search code.

Rules:
- Always read a file before editing it
- Ask for permission before running dangerous commands
- Explain what you're doing at each step`;
```

This system message shapes everything the agent does. It tells the model *what it is*, *what it can do*, and *how it should behave*. We'll explore this in much more detail when we look at Claude Code's architecture in Lesson 9.

---

## How the Model "Remembers" — It Doesn't

Here's one of the most important things to understand about LLMs:

**The model has no memory between API calls.**

Every time you send a request to the API, the model starts fresh. It doesn't remember the last conversation, the last question, or even that it talked to you before.

So how does it seem like it "remembers"? Because **you send the entire conversation history every time.**

```
API Call 1:
  Send:    [user: "Hi, I'm working on a React app"]
  Receive: [assistant: "Great! How can I help?"]

API Call 2:
  Send:    [user: "Hi, I'm working on a React app",
            assistant: "Great! How can I help?",
            user: "How do I add a button?"]
  Receive: [assistant: "Here's how to add a button in React..."]

API Call 3:
  Send:    [user: "Hi, I'm working on a React app",
            assistant: "Great! How can I help?",
            user: "How do I add a button?",
            assistant: "Here's how to add a button in React...",
            user: "Make it blue"]
  Receive: [assistant: "Add style={{color: 'blue'}} to your button..."]
```

Notice: every API call sends the **entire conversation** from the beginning. The model re-reads everything each time. This is why the context window (from Lesson 3) is so important — as the conversation grows, it takes up more and more of the available space.

### What This Means for Agents

An AI coding agent might make dozens or hundreds of API calls during a single task. Each time, it sends the full conversation history: your original request, every file it read, every command it ran, every result it observed.

This is why managing conversation history is one of the hardest parts of building an agent. The history grows quickly, and if it exceeds the context window, the agent has to make tough choices about what to keep and what to drop.

---

## Visualizing the Message Array

Here's how a typical agent conversation looks as a message array after a few steps:

```typescript
const messages = [
  // Your request
  { role: "user", content: "Fix the bug in src/app.ts" },

  // Agent decides to read the file
  {
    role: "assistant",
    content: "I'll read the file first to understand the issue.",
    // (plus a tool_use block — we'll cover this in Lesson 5!)
  },

  // Result of reading the file
  {
    role: "user",  // tool results come back as "user" role
    content: "// Contents of src/app.ts:\nconst x = 1;\nconst y = x + z; // z is not defined!\n...",
  },

  // Agent identifies the bug and fixes it
  {
    role: "assistant",
    content: "I found the bug: `z` is not defined on line 2. I'll fix it.",
    // (plus another tool_use block to edit the file)
  },

  // Result of the edit
  {
    role: "user",
    content: "File edited successfully.",
  },

  // Agent confirms completion
  {
    role: "assistant",
    content: "Fixed! The variable `z` was undefined. I changed line 2 to use a default value.",
  },
];
```

Every step the agent takes adds more messages to this array. The next API call will include *all* of these messages, so the model has full context of everything that happened.

---

## Summary

- Conversations are structured as **arrays of messages**, each with a **role** (`system`, `user`, `assistant`) and **content**.
- The **system message** sets the model's behavior and rules for the whole conversation.
- **Order matters** — the model reads messages sequentially, and earlier messages influence later responses.
- The model has **no memory** between API calls. You re-send the entire conversation each time.
- An agent's message array **grows with every action** it takes, which is why context window management is critical.

---

> **Key Takeaway**
>
> A conversation is just an array of messages with roles. The model doesn't "remember" anything — it re-reads the entire array on every API call. This simple fact explains both how agents maintain context (by keeping the full history) and why they struggle with very long tasks (the history eventually exceeds the context window).

---

---

## Practice Exercises

> **Remember**: Write your answers in your notebook first, then check below.

### Exercise 1 — The Three Roles
**Question:** Name the three message roles in the chat format and describe who or what each role represents.

[View Answer](../../answers/01-foundations/answer-04.md#exercise-1)

### Exercise 2 — No Memory
**Question:** LLMs have "no memory between API calls." If that's true, how does a conversation with an AI model appear to have continuity? What is actually happening behind the scenes?

[View Answer](../../answers/01-foundations/answer-04.md#exercise-2)

### Exercise 3 — System Message Purpose
**Question:** What is the purpose of the system message, and why is it especially important for an AI coding agent like Claude Code?

[View Answer](../../answers/01-foundations/answer-04.md#exercise-3)

### Exercise 4 — Why Order Matters
**Question:** Two conversations ask the exact same question — "How do I read a file?" — but get different answers. Explain why message order affects the model's response.

[View Answer](../../answers/01-foundations/answer-04.md#exercise-4)

---

*Next up: [Lesson 5 — What Is Tool Use](./05-what-is-tool-use.md), where you'll learn the concept that transforms a chatbot into an agent — the ability to call functions.*
