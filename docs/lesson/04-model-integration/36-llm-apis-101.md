# Lesson 36: LLM APIs 101

## What You'll Learn

Every tool you've built so far — the agent loop, the streaming executor, the tool
registry — exists to serve one purpose: making calls to a large language model and
acting on what comes back. In this lesson, you'll learn exactly how those calls work
at the HTTP level before any SDK wraps them.

## The Anatomy of an LLM API Call

An LLM API is a plain HTTP POST endpoint. You send a JSON body describing what you
want. You get a JSON body back with the model's response. That's it.

Here's the minimum viable call to the Anthropic Messages API:

```typescript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [
      { role: "user", content: "What is 2 + 2?" }
    ],
  }),
});

const data = await response.json();
console.log(data);
```

Three required fields in the body:

| Field | Purpose |
|---|---|
| `model` | Which model to use (e.g. `claude-sonnet-4-20250514`) |
| `max_tokens` | Maximum tokens the model can generate |
| `messages` | The conversation history |

## The Messages Array

The `messages` array is the conversation. Each message has a `role` and `content`:

```typescript
const messages = [
  { role: "user", content: "Summarize this file for me." },
  { role: "assistant", content: "This file implements a retry system..." },
  { role: "user", content: "Now refactor it to use exponential backoff." },
];
```

Two roles matter for the messages array:

- **`user`** — what the human (or system) sends to the model
- **`assistant`** — what the model previously responded with

There's also a top-level `system` parameter (not inside `messages`) for the system
prompt — the persistent instructions that shape the model's behavior.

```typescript
const body = {
  model: "claude-sonnet-4-20250514",
  max_tokens: 8192,
  system: "You are a coding assistant. Be concise. Use TypeScript.",
  messages: [
    { role: "user", content: "Write a fibonacci function." }
  ],
};
```

## The Response: Content Blocks

The response isn't a flat string. It's structured as an array of **content blocks**.
This is critical — a single assistant response can contain multiple blocks of
different types:

```json
{
  "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-20250514",
  "content": [
    {
      "type": "text",
      "text": "I'll read the file first."
    },
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90lq917835lq9",
      "name": "Read",
      "input": { "file_path": "/src/index.ts" }
    }
  ],
  "stop_reason": "tool_use",
  "usage": {
    "input_tokens": 523,
    "output_tokens": 89
  }
}
```

The two content block types you'll see constantly:

- **`text`** — the model's natural language output
- **`tool_use`** — the model wants to call a tool (name + input)

When the model emits a `tool_use` block, `stop_reason` is `"tool_use"` instead of
`"end_turn"`. This is how you know the agent loop should execute a tool and continue
rather than present a final answer.

## Sending Tool Results Back

After executing a tool, you append the assistant's response and a `tool_result`
block to the conversation, then make another API call:

```typescript
messages.push(
  // The assistant's response (as-is from the API)
  {
    role: "assistant",
    content: [
      { type: "text", text: "I'll read the file first." },
      { type: "tool_use", id: "toolu_01A09q90qw90lq917835lq9", name: "Read", input: { file_path: "/src/index.ts" } },
    ],
  },
  // Your tool result
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_01A09q90qw90lq917835lq9",
        content: "export function main() { ... }",
      },
    ],
  }
);
```

The `tool_use_id` links the result back to the specific tool call. The API enforces
this — every `tool_use` must have a matching `tool_result` in the next user message.

## Authentication

The API key goes in the `x-api-key` header. You also need `anthropic-version` to
specify which API version you're targeting:

```typescript
const headers = {
  "Content-Type": "application/json",
  "x-api-key": process.env.ANTHROPIC_API_KEY!,
  "anthropic-version": "2023-06-01",
};
```

In Claude Code, the key can come from multiple sources — environment variable,
OAuth token, or a credential provider. The important thing is that it ends up in
this header on every request.

## The Anthropic SDK

Raw fetch works, but the official SDK handles serialization, error types, streaming,
and TypeScript types. Here's the same call with the SDK:

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const message = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 4096,
  system: "You are a coding assistant.",
  messages: [
    { role: "user", content: "What does this function do?" }
  ],
});

console.log(message.content);
// [{ type: "text", text: "This function..." }]
```

The SDK gives you typed responses — `message.content` is
`Array<TextBlock | ToolUseBlock>`, `message.stop_reason` is
`"end_turn" | "tool_use" | "max_tokens"`, and `message.usage` gives you token
counts.

## Declaring Tools

To let the model call tools, pass a `tools` array in the request. Each tool is a
JSON Schema describing the tool's name, description, and input parameters:

```typescript
const message = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 4096,
  messages,
  tools: [
    {
      name: "Read",
      description: "Read a file from disk and return its contents.",
      input_schema: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the file to read.",
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "Write",
      description: "Write content to a file, creating it if needed.",
      input_schema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to write to." },
          content: { type: "string", description: "Content to write." },
        },
        required: ["file_path", "content"],
      },
    },
  ],
});
```

This is where your Zod schemas from Module 02 connect to the API — you convert
them to JSON Schema and pass them here.

## The Full Agent Call Cycle

Putting it all together, a single agent loop iteration: call the API → check
`stop_reason` → if `"tool_use"`, extract tool blocks, execute them, append the
assistant message and tool results to the conversation, and call the API again.
If `"end_turn"`, present the final response. This recursive pattern is the
skeleton of every coding agent. The rest of this module fills in the real-world
complexity — streaming, retries, rate limits, fallbacks, and cost tracking.

## Key Takeaways

1. An LLM API call is an HTTP POST with `model`, `max_tokens`, and `messages`
2. Responses contain **content blocks** — `text` and `tool_use` are the two you care about
3. Every `tool_use` must get a matching `tool_result` in the next user message
4. The SDK gives you typed responses and handles the HTTP details
5. Tools are declared as JSON Schema in the request body
6. The agent loop is: call API → check stop_reason → execute tools → append results → call again

## Next Lesson

You've made a blocking API call — the program waits until the entire response is
generated before returning. For a coding agent that generates thousands of tokens
per response, that's unacceptable. In the next lesson, you'll learn how to stream
responses token by token using Server-Sent Events.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Three Required Fields
**Question:** What are the three required fields in the body of an Anthropic Messages API call, and what does each one control?

[View Answer](../../answers/04-model-integration/answer-36.md#exercise-1)

### Exercise 2 — Build a Minimal API Call
**Challenge:** Using the Anthropic SDK, write a function `askClaude(question: string): Promise<string>` that sends a single user message and returns the model's text response. Handle the case where the response contains no text blocks.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-36.md#exercise-2)

### Exercise 3 — Content Block Types
**Question:** When the model's response contains a `tool_use` content block, what is the `stop_reason` set to? How does the agent loop use this to decide whether to continue or present a final answer?

[View Answer](../../answers/04-model-integration/answer-36.md#exercise-3)

### Exercise 4 — Tool Result Round-Trip
**Challenge:** Write a function `sendToolResult(messages: any[], toolUseId: string, result: string): any[]` that appends the correct tool_result message structure to a conversation history. The function must return the updated messages array ready for the next API call.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-36.md#exercise-4)

### Exercise 5 — Declaring a Tool
**Challenge:** Write a tool declaration (JSON Schema format for the `tools` array) for a `ListFiles` tool that takes a `directory` (required string) and an optional `recursive` boolean parameter.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-36.md#exercise-5)
