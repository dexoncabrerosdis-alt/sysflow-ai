# Lesson 37: Streaming API Responses

## What You'll Learn

In the previous lesson, you made a blocking API call — the program freezes until
the model finishes generating its entire response. For a 2,000-token response, that
could be 10-15 seconds of dead silence. In this lesson, you'll learn how streaming
works at the protocol level and how Claude Code consumes streams in practice.

## Why Streaming Matters

A coding agent without streaming is unusable:

- **User experience** — the user sees nothing for 10+ seconds, assumes it's broken
- **Tool execution** — you can't start executing tools until you see the complete
  tool_use block, but you can show progress text immediately
- **Stall detection** — you can't tell if the API is hung unless you're watching
  the stream in real time
- **Memory** — buffering a massive response is wasteful when you can process
  incrementally

## Enabling Streaming

Add `stream: true` to your API call:

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
    stream: true,
    messages: [{ role: "user", content: "Write a quicksort in Python." }],
  }),
});
```

Instead of a JSON body, the response is now a **Server-Sent Events** (SSE) stream.

## Server-Sent Events (SSE)

SSE is a simple text protocol. Each event has a type and JSON data, separated by
newlines:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_01...","model":"claude-sonnet-4-20250514",...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Here"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"'s a"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" quicksort"}}
```

Each `event:` line tells you the type. Each `data:` line is a JSON payload. Blank
lines separate events. That's the entire protocol.

## The Event Lifecycle

A complete streamed response goes through these events in order:

```
message_start          → The message object (id, model, usage)
  content_block_start  → A new content block begins (text or tool_use)
    content_block_delta  → Incremental content (repeated many times)
    content_block_delta
    ...
  content_block_stop   → This content block is complete
  content_block_start  → Another block begins (if multiple)
    content_block_delta
    ...
  content_block_stop
message_delta          → Final message metadata (stop_reason, usage)
message_stop           → Stream is complete
```

For tool calls, the deltas look different:

```
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01...","name":"Read","input":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"_path\":\"/src"}}
```

The tool input arrives as partial JSON fragments that you accumulate and parse once
`content_block_stop` fires.

## Reading a Stream with the SDK

The Anthropic SDK wraps SSE parsing for you:

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const stream = client.messages.stream({
  model: "claude-sonnet-4-20250514",
  max_tokens: 4096,
  messages: [{ role: "user", content: "Write a quicksort." }],
});

for await (const event of stream) {
  switch (event.type) {
    case "content_block_start":
      console.log("New block:", event.content_block.type);
      break;

    case "content_block_delta":
      if (event.delta.type === "text_delta") {
        process.stdout.write(event.delta.text);
      }
      break;

    case "message_stop":
      console.log("\nDone.");
      break;
  }
}
```

The `stream` object is an async iterable — you consume it with `for await...of`.

## Raw Stream Access with `.withResponse()`

Claude Code doesn't use the high-level stream helpers. It needs raw access to the
underlying HTTP response for custom error handling and stall detection. The pattern
uses `withResponse()` on the beta API:

```typescript
const apiCall = anthropic.beta.messages.create(
  {
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    stream: true,
    messages,
    tools,
    betas: ["interleaved-thinking-2025-05-14"],
  },
  { signal: abortController.signal }
);

const response = apiCall.withResponse();
```

The `.withResponse()` method gives you both the parsed stream and the raw HTTP
response. This lets Claude Code:

1. Read the response status code before consuming the body
2. Attach custom abort controllers for timeout handling
3. Access headers (like `retry-after`) on error responses

## Processing the Stream: Accumulating State

As deltas arrive, you need to accumulate them into complete content blocks. Here's
the pattern Claude Code uses:

```typescript
interface StreamState {
  currentBlocks: Anthropic.ContentBlock[];
  inputJsonBuffers: Map<number, string>;
  stopReason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

function processEvent(state: StreamState, event: StreamEvent): void {
  switch (event.type) {
    case "content_block_start":
      state.currentBlocks[event.index] = event.content_block;
      if (event.content_block.type === "tool_use") {
        state.inputJsonBuffers.set(event.index, "");
      }
      break;

    case "content_block_delta":
      if (event.delta.type === "text_delta") {
        const block = state.currentBlocks[event.index];
        if (block.type === "text") {
          block.text += event.delta.text;
        }
      } else if (event.delta.type === "input_json_delta") {
        const buf = state.inputJsonBuffers.get(event.index) ?? "";
        state.inputJsonBuffers.set(event.index, buf + event.delta.partial_json);
      }
      break;

    case "content_block_stop": {
      const block = state.currentBlocks[event.index];
      if (block.type === "tool_use") {
        const json = state.inputJsonBuffers.get(event.index) ?? "{}";
        block.input = JSON.parse(json);
      }
      break;
    }

    case "message_delta":
      state.stopReason = event.delta.stop_reason;
      Object.assign(state.usage, event.usage);
      break;
  }
}
```

Key insight: tool input JSON arrives in fragments. You **cannot** parse it until
`content_block_stop`. Attempting to parse partial JSON is a common source of bugs.

## Stall Detection

What happens if the API stops sending events mid-stream? The connection stays open
but nothing arrives. Without detection, the agent hangs forever.

Claude Code implements stall detection with a rolling timer:

```typescript
const STALL_TIMEOUT_MS = 30_000;

async function* readStreamWithStallDetection(
  stream: AsyncIterable<StreamEvent>,
  abortController: AbortController
): AsyncGenerator<StreamEvent> {
  let stallTimer: NodeJS.Timeout;

  const resetTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      abortController.abort(new Error("Stream stalled for 30s"));
    }, STALL_TIMEOUT_MS);
  };

  resetTimer();

  try {
    for await (const event of stream) {
      resetTimer();
      yield event;
    }
  } finally {
    clearTimeout(stallTimer);
  }
}
```

Every time an event arrives, the 30-second timer resets. If 30 seconds pass with no
event, the abort controller kills the connection. The retry system (Lesson 42) then
kicks in to retry the request.

## Turning a Stream into an Async Generator

In Modules 02-03, you built agent loops using async generators that yield messages.
The streaming API feeds directly into that pattern: text deltas become
`assistant_text` yields, `content_block_stop` for tool_use becomes `tool_call`
yields, and `message_stop` becomes `turn_complete`. Each SSE event maps to a
message in your agent's internal stream.

## Key Takeaways

1. `stream: true` switches from JSON response to Server-Sent Events
2. Events follow a lifecycle: `message_start` → `content_block_start` → deltas → `content_block_stop` → `message_stop`
3. Tool input arrives as partial JSON fragments — only parse on `content_block_stop`
4. `.withResponse()` gives raw HTTP access for custom error handling
5. Stall detection uses a 30-second rolling timer that aborts the connection
6. The stream feeds directly into your async generator agent loop

## Next Lesson

You've seen how streaming works at the protocol level. Next, you'll see how Claude
Code wraps all of this into a single API service — `claude.ts` — that handles
retries, recording, and parameter building on top of the raw stream.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The SSE Event Lifecycle
**Question:** List the SSE event types in order for a complete streamed response that contains one text block and one tool_use block. What event signals that it's safe to parse the tool's input JSON?

[View Answer](../../answers/04-model-integration/answer-37.md#exercise-1)

### Exercise 2 — Accumulate Text Deltas
**Challenge:** Write a function `accumulateTextFromStream(events: StreamEvent[]): string` that processes an array of SSE events and returns the fully assembled text. Only accumulate `text_delta` deltas from `content_block_delta` events.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-37.md#exercise-2)

### Exercise 3 — Why Parse JSON Only on Stop?
**Question:** Why must you wait until `content_block_stop` to parse tool input JSON from the stream? What would happen if you tried to `JSON.parse()` each `input_json_delta` as it arrives?

[View Answer](../../answers/04-model-integration/answer-37.md#exercise-3)

### Exercise 4 — Stall Detection Timer
**Challenge:** Write a `StallDetector` class that takes a timeout in milliseconds and an `AbortController`. It should have a `reset()` method (called on each event) and a `start()` method. If `reset()` isn't called within the timeout, it aborts the controller.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-37.md#exercise-4)

### Exercise 5 — Stream Consumer with the SDK
**Challenge:** Using the Anthropic SDK's `client.messages.stream()`, write a function that streams a response and prints each text delta to stdout in real time. Log "New block: [type]" when each content block starts.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-37.md#exercise-5)
