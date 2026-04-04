# Lesson 7: Request-Response vs Streaming

## Introduction

In the previous lessons, you learned that an agent sends messages to an LLM API and gets responses back. But *how* does that response arrive? Does it come all at once, like downloading a photo? Or piece by piece, like watching a live video?

Both approaches exist, and they have very different implications for building agents. In this lesson, you'll learn about **request-response** and **streaming** — and why streaming is the preferred approach for AI coding agents.

---

## Request-Response: Wait for the Full Answer

The simplest approach is **request-response**: you send a prompt, wait, and get the complete answer all at once.

```
┌────────┐                    ┌────────┐
│ Client │───── request ─────▶│ Server │
│        │                    │        │
│        │                    │ (model │
│        │    (waiting...)    │  is    │
│        │                    │  think-│
│        │                    │  ing)  │
│        │                    │        │
│        │◀── full response ──│        │
└────────┘                    └────────┘
```

In code, this looks like what we've seen in previous lessons:

```typescript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Explain recursion in 3 sentences." }],
  }),
});

// This line blocks until the ENTIRE response is ready
const data = await response.json();
console.log(data.content[0].text);
```

### The Problem with Waiting

LLMs generate text token by token (as you learned in Lesson 3). For a long response, this can take **seconds or even minutes**. With request-response, you see nothing until the entire response is finished.

Imagine waiting 30 seconds for an agent to respond, with no indication of what it's doing. Is it thinking? Is it stuck? Is the connection broken? You have no idea.

For chatbots, this creates a bad user experience. For agents, it's even worse — the agent might be generating a long plan, and you'd want to see it unfold in real time.

---

## Streaming: Get the Answer Piece by Piece

**Streaming** solves this problem. Instead of waiting for the full response, you receive it **token by token** as the model generates it.

```
┌────────┐                    ┌────────┐
│ Client │───── request ─────▶│ Server │
│        │                    │        │
│        │◀── "Recursion" ────│ (gen-  │
│        │◀── " is"     ─────│  erat-  │
│        │◀── " when"   ─────│  ing)   │
│        │◀── " a"      ─────│        │
│        │◀── " function"────│        │
│        │◀── " calls"  ─────│        │
│        │◀── " itself" ─────│        │
│        │◀── "."       ─────│        │
│        │◀── [DONE]    ─────│        │
└────────┘                    └────────┘
```

You see each piece as it arrives. The text appears to "type itself out" in real time — the same effect you see in ChatGPT or Claude's web interface.

---

## Why Streaming Matters for Agents

Streaming isn't just about user experience (though that matters too). For agents, streaming enables two important capabilities:

### 1. Show Progress in Real Time

When an agent is working on a task, you want to see what it's thinking:

```
Agent: "Let me look at the project structure first..."
       [reading files...]
       "I see. The bug is in the authentication module."
       "Fixing src/auth/login.ts..."
       [editing file...]
       "Done! Here's what I changed..."
```

Without streaming, you'd see nothing for 30 seconds, then get a wall of text. With streaming, you see each step unfold in real time.

### 2. Start Processing Early

When the model streams a `tool_use` block, the agent can start preparing to execute the tool before the full response is complete. For example:

```
Stream received so far:
  { "type": "tool_use", "name": "read_file", "input": { "path": "src/

(still streaming the path...)
```

The agent already knows a file read is coming. Some systems can begin resolving the file path or checking permissions while the rest of the response streams in. This is called **early processing** and it can make agents noticeably faster.

### 3. Detect and Handle Errors Quickly

If something goes wrong during generation (the model starts producing nonsensical output, or hits a rate limit), streaming lets the system detect and react to it immediately — rather than waiting for the full response and then discovering the problem.

---

## Server-Sent Events (SSE) Basics

Most LLM APIs use a protocol called **Server-Sent Events (SSE)** for streaming. SSE is a simple standard where the server sends a series of text events over an HTTP connection.

Each event looks like this:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-20250514"}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Recursion"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" is"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" when"}}
```

Each `content_block_delta` event carries a small piece of text. Your code listens for these events and assembles them into the full response.

The key events in the Anthropic streaming API:

| Event                  | What it means                          |
| ---------------------- | -------------------------------------- |
| `message_start`        | A new response is beginning            |
| `content_block_start`  | A new content block is starting (text or tool_use) |
| `content_block_delta`  | A piece of content (a few tokens)      |
| `content_block_stop`   | A content block is complete            |
| `message_stop`         | The entire response is complete        |

---

## Code Example: Consuming a Stream

Here's how to consume a streaming response from the Anthropic API:

```typescript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    stream: true, // <-- This enables streaming!
    messages: [{ role: "user", content: "Write a haiku about coding." }],
  }),
});

// Read the stream
const reader = response.body.getReader();
const decoder = new TextDecoder();

let fullText = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  const lines = chunk.split("\n");

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = JSON.parse(line.slice(6));

    if (data.type === "content_block_delta") {
      const text = data.delta.text;
      fullText += text;
      process.stdout.write(text); // Print each piece in real time
    }
  }
}

console.log("\n\nFull response:", fullText);
```

The key difference from request-response is `stream: true` in the request body. Instead of getting one big JSON response, you get a stream of small events that you process as they arrive.

---

## Comparing the Two Approaches

| Aspect                | Request-Response          | Streaming                    |
| --------------------- | ------------------------- | ---------------------------- |
| **Response delivery** | All at once               | Token by token               |
| **User experience**   | Wait, then see everything | See text appear in real time |
| **Time to first token**| Slow (wait for full response) | Fast (first token arrives quickly) |
| **Error detection**   | After full response       | During generation            |
| **Complexity**        | Simple                    | More complex to implement    |
| **Protocol**          | Standard HTTP             | Server-Sent Events (SSE)     |

---

## How Claude Code Uses Streaming

Claude Code uses streaming for its real-time feedback experience. When you give it a task, you see its reasoning and actions appear live in your terminal:

```
you> Add error handling to the API routes

Claude: I'll review the current routes first.

  Reading src/routes/api.ts...

  I can see 5 API routes without try-catch blocks.
  Let me add error handling to each one.

  Editing src/routes/api.ts...

  Done! I've added try-catch blocks with proper error responses
  to all 5 routes.
```

Each line appears as the model generates it. The "Reading..." and "Editing..." lines appear as tool calls are made. This real-time feedback is only possible because of streaming.

Under the hood, Claude Code processes the stream to:

1. **Display text** as it arrives (the model's reasoning)
2. **Detect tool_use blocks** as they start streaming (to prepare for execution)
3. **Execute tools** as soon as the tool_use block is complete
4. **Render a live UI** showing the agent's current state (using React Ink, which we'll cover in Lesson 9)

---

## When to Use Which Approach

For most agent development, you'll want streaming. But here's a simple guide:

**Use request-response when:**
- You're building a simple script or prototype
- You don't need real-time feedback
- You want the simplest possible code

**Use streaming when:**
- You're building an interactive agent (like Claude Code)
- You want real-time progress updates
- You need to start processing before the full response arrives
- Response times could be long (more than a few seconds)

---

## Summary

- **Request-response** sends a prompt and waits for the complete answer. Simple but slow to show results.
- **Streaming** delivers the answer token by token in real time using Server-Sent Events (SSE).
- Streaming lets agents **show progress**, **process early**, and **detect errors quickly**.
- To enable streaming with the Anthropic API, add `stream: true` to your request.
- **Claude Code uses streaming** to provide real-time feedback as it works on your tasks.

---

> **Key Takeaway**
>
> Streaming transforms the agent experience from "wait and hope" to "watch it work." By receiving tokens as they're generated, the agent can show real-time progress, start processing early, and give you confidence that something is actually happening. This is why every production AI agent uses streaming.

---

---

## Practice Exercises

> **Remember**: Write your answers in your notebook first, then check below.

### Exercise 1 — Two Approaches
**Question:** What is the key difference between request-response and streaming when getting data from an LLM API?

[View Answer](../../answers/01-foundations/answer-07.md#exercise-1)

### Exercise 2 — Why Streaming for Agents?
**Question:** Name and briefly explain two reasons why streaming is important for AI coding agents (beyond just user experience).

[View Answer](../../answers/01-foundations/answer-07.md#exercise-2)

### Exercise 3 — Server-Sent Events
**Question:** What is SSE (Server-Sent Events), and what does a `content_block_delta` event represent in the Anthropic streaming API?

[View Answer](../../answers/01-foundations/answer-07.md#exercise-3)

### Exercise 4 — Code Challenge: Enable Streaming
**Challenge:** Given the following non-streaming API call, modify it to enable streaming. What single property do you need to add to the request body?

```typescript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello!" }],
  }),
});
```

Write your solution in your IDE first, then check:

[View Answer](../../answers/01-foundations/answer-07.md#exercise-4)

---

*Next up: [Lesson 8 — What Makes a Good Agent](./08-what-makes-a-good-agent.md), where you'll learn the qualities that separate a great agent from a frustrating one.*
