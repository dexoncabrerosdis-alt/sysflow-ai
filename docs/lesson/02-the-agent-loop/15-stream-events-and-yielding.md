# Lesson 15: Stream Events and Yielding

The agent loop yields events as it runs. These events are the **public interface** of the loop — the only thing consumers see. Understanding what events exist and when they're emitted is key to understanding how Claude Code communicates with its UI layers.

## The Event Types

The `queryLoop()` generator yields a union of several types:

```typescript
AsyncGenerator<
  StreamEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  Terminal
>
```

Let's break down each one.

### StreamEvent: Raw Streaming Chunks

When the model generates a response, it streams tokens incrementally. Each chunk becomes a `StreamEvent`:

```typescript
type StreamEvent = {
  type: "content_block_start"
       | "content_block_delta"
       | "content_block_stop"
       | "message_start"
       | "message_delta"
       | "message_stop";
  // ... payload depends on type
};
```

These map directly to the Anthropic streaming API events. They let the UI render text character by character as the model produces it, rather than waiting for the complete response.

A typical sequence looks like:

```
message_start          → "A new message is beginning"
content_block_start    → "A text block is starting"
content_block_delta    → "Here are some tokens: 'Let me '"
content_block_delta    → "'read the file'"
content_block_stop     → "That text block is complete"
content_block_start    → "A tool_use block is starting"
content_block_delta    → "Tool name: read_file, input building..."
content_block_stop     → "That tool_use block is complete"
message_stop           → "The message is complete"
```

The CLI uses these to show text appearing in real time. The web UI uses them to update React components. The SDK can either forward them or buffer them — the choice is the consumer's.

### Message: Complete Conversation Messages

After the streaming is done and the model's full response is assembled, the loop yields the complete `Message`:

```typescript
interface Message {
  role: "assistant" | "user";
  content: ContentBlock[];
  model?: string;
  // ...
}
```

Assistant messages contain the model's response. User-role messages in this context are tool results — remember, in the API protocol, tool results are sent as "user" messages.

These are the canonical records of the conversation. While `StreamEvent`s are ephemeral (useful for real-time rendering), `Message` objects are what get stored in conversation history.

### TombstoneMessage: Invalidated Messages

Sometimes a message needs to be retroactively invalidated. This happens when Claude Code switches models mid-conversation (for example, escalating from Haiku to Sonnet when a task turns out to be harder than expected):

```typescript
interface TombstoneMessage {
  type: "tombstone";
  originalMessage: Message;
  reason: string;
}
```

When a tombstone is yielded, it tells the consumer: "that previous message? Discard it. The model is being re-called with a different configuration." The UI can then remove or grey out the invalidated response.

### ToolUseSummaryMessage: Condensed Tool Output

When a tool produces a large result (like reading a very long file), the full result goes into the conversation history but would clutter the UI. A `ToolUseSummaryMessage` provides a human-friendly summary:

```typescript
interface ToolUseSummaryMessage {
  type: "tool_use_summary";
  toolName: string;
  summary: string;    // "Read 450 lines from src/index.ts"
  duration: number;   // How long the tool took to execute
}
```

The CLI renders these as compact one-liners instead of dumping the entire file contents to the terminal.

## The First Yield: stream_request_start

Every iteration of the loop begins by yielding a signal:

```typescript
while (true) {
  yield { type: "stream_request_start" };  // Always first

  // ... rest of the iteration
}
```

This event carries no data. Its purpose is purely structural — it tells consumers "a new API call is about to happen." The CLI uses this to show a spinner or separator. The web UI uses it to create a new "turn" in the conversation display.

It's the heartbeat of the loop. Every `stream_request_start` means another iteration is beginning.

## The Yield Sequence for One Iteration

Here's the complete sequence of events yielded during a single loop iteration where the model calls a tool:

```
1. { type: "stream_request_start" }     ← New turn starting

2. { type: "message_start", ... }        ← Model response streaming begins
3. { type: "content_block_start", ... }  ← Text block starting
4. { type: "content_block_delta", ... }  ← "I'll read the file..."
5. { type: "content_block_stop", ... }   ← Text block complete
6. { type: "content_block_start", ... }  ← Tool use block starting
7. { type: "content_block_delta", ... }  ← Tool input streaming
8. { type: "content_block_stop", ... }   ← Tool use block complete
9. { type: "message_stop", ... }         ← Model response complete

10. Message { role: "assistant", ... }   ← Complete assistant message

11. [tool executes — no yields during execution]

12. Message { role: "user", tool_result } ← Tool result message
13. ToolUseSummaryMessage { ... }         ← Human-readable summary
```

And for the **final** iteration where the model gives a text answer (no tool use):

```
1. { type: "stream_request_start" }
2-9. [streaming events for the text response]
10. Message { role: "assistant", ... }    ← The final answer
11. return Terminal { reason: "completed" } ← Generator ends
```

## How Consumers Process Events

Each consumer of the generator handles events according to its needs:

```typescript
// CLI: Real-time terminal rendering
async function consumeForCLI(params: QueryParams) {
  for await (const event of query(params)) {
    if (event.type === "stream_request_start") {
      printSeparator();
      showSpinner();
      continue;
    }

    if (event.type === "content_block_delta") {
      // Stream text to terminal character by character
      process.stdout.write(event.delta?.text ?? "");
      continue;
    }

    if (event.type === "tool_use_summary") {
      printToolSummary(event.toolName, event.summary, event.duration);
      continue;
    }

    if (event.type === "tombstone") {
      clearPreviousOutput();
      continue;
    }
  }
}
```

```typescript
// SDK: Collect messages, ignore streaming details
async function consumeForSDK(params: QueryParams) {
  const messages: Message[] = [];

  for await (const event of query(params)) {
    // Only care about complete messages
    if ("role" in event && (event.role === "assistant" || event.role === "user")) {
      messages.push(event as Message);
    }
    // Ignore all streaming events — we don't render a UI
  }

  return messages;
}
```

```typescript
// Web UI: Send events over a WebSocket for React rendering
async function consumeForWeb(params: QueryParams, ws: WebSocket) {
  for await (const event of query(params)) {
    // Forward everything — the frontend decides what to render
    ws.send(JSON.stringify(event));
  }
}
```

Three completely different behaviors from the same event stream. The agent loop yields uniformly; consumers filter selectively.

## Why This Design?

The event-based yield pattern gives Claude Code three important properties:

**1. Separation of concerns.** The loop doesn't know how events are displayed. It just produces them. The rendering logic lives entirely in the consumer.

**2. Testability.** You can test the loop by collecting all yielded events into an array and asserting on them. No mocking of UI components required.

**3. Multiple consumers simultaneously.** Nothing prevents you from consuming the same generator from multiple consumers (by tee-ing the event stream), or switching consumers mid-stream.

## The Contract

The yield sequence forms a contract between the loop and its consumers:

- Every iteration starts with `stream_request_start`
- Streaming events arrive in order, properly nested (start → delta → stop)
- Complete messages follow the streaming events for the same content
- Tool summaries follow tool result messages
- Tombstones can appear at any point (they invalidate a previous message)
- The generator ends by returning a `Terminal`, never by yielding one

If you're building a consumer, you can rely on this ordering. If you're modifying the loop, you must preserve it.

---

**Key Takeaways**
- The loop yields four types: `StreamEvent`, `Message`, `TombstoneMessage`, `ToolUseSummaryMessage`
- `stream_request_start` is yielded at the start of every iteration — it's the loop's heartbeat
- `StreamEvent`s enable real-time rendering; `Message`s are the canonical conversation records
- `TombstoneMessage` invalidates previous messages (used during model switching)
- `ToolUseSummaryMessage` provides human-readable tool execution summaries
- Different consumers (CLI, Web, SDK) filter the same event stream for their specific needs
- The yield ordering is a contract: consumers depend on it, the loop must preserve it

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook.

### Exercise 1 — Four Event Types
**Question:** Name the four types that `queryLoop()` yields, and explain when each is used. Which ones are ephemeral (for real-time display) and which are canonical (stored in history)?

[View Answer](../../answers/02-the-agent-loop/answer-15.md#exercise-1)

### Exercise 2 — Build an Event Consumer
**Challenge:** Write a CLI consumer function that processes the event stream from an agent loop. It should handle all four event types: show a spinner on `stream_request_start`, stream text character-by-character for `content_block_delta`, print a one-line summary for `ToolUseSummaryMessage`, and print `"[message invalidated]"` for `TombstoneMessage`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-15.md#exercise-2)

### Exercise 3 — The Yield Contract
**Question:** What is the "yield contract" between the loop and its consumers? List the ordering guarantees. Why is it important that the generator ends by *returning* a `Terminal` rather than *yielding* one?

[View Answer](../../answers/02-the-agent-loop/answer-15.md#exercise-3)

### Exercise 4 — SDK vs. CLI Consumer
**Challenge:** Write two consumers for the same `AsyncGenerator<AgentEvent, Terminal>` stream. The `cliConsumer` should print every event type to the console with appropriate formatting. The `sdkConsumer` should ignore all streaming events and only collect complete `Message` objects into an array, returning them when done.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-15.md#exercise-4)

### Exercise 5 — Why stream_request_start?
**Question:** The `stream_request_start` event carries no data. Why does it exist? What would consumers lose if it were removed? Give specific examples for both a CLI and web UI consumer.

[View Answer](../../answers/02-the-agent-loop/answer-15.md#exercise-5)
