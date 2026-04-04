# Answers: Lesson 37 — Streaming API Responses

## Exercise 1
**Question:** List the SSE event types in order for a complete streamed response that contains one text block and one tool_use block. What event signals that it's safe to parse the tool's input JSON?

**Answer:** The event order is: `message_start` → `content_block_start` (text) → multiple `content_block_delta` (text_delta) → `content_block_stop` → `content_block_start` (tool_use) → multiple `content_block_delta` (input_json_delta) → `content_block_stop` → `message_delta` → `message_stop`. The `content_block_stop` event for the tool_use block signals that all JSON fragments have been received and it's safe to parse the accumulated input JSON.

---

## Exercise 2
**Challenge:** Write a function `accumulateTextFromStream(events: StreamEvent[]): string` that processes an array of SSE events and returns the fully assembled text.

**Answer:**
```typescript
interface StreamEvent {
  type: string;
  index?: number;
  delta?: { type: string; text?: string };
}

function accumulateTextFromStream(events: StreamEvent[]): string {
  let text = "";

  for (const event of events) {
    if (
      event.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      event.delta.text
    ) {
      text += event.delta.text;
    }
  }

  return text;
}
```
**Explanation:** We filter for `content_block_delta` events with a `text_delta` type and concatenate their text fragments. Other delta types (like `input_json_delta` for tool input) are ignored since we only want text output.

---

## Exercise 3
**Question:** Why must you wait until `content_block_stop` to parse tool input JSON from the stream? What would happen if you tried to `JSON.parse()` each `input_json_delta` as it arrives?

**Answer:** Tool input JSON arrives as partial fragments — for example, `{"file` followed by `_path":"/src` followed by `/index.ts"}`. Each individual fragment is not valid JSON on its own. Calling `JSON.parse()` on a partial fragment would throw a `SyntaxError` every time. You must accumulate all `input_json_delta` fragments into a buffer string and only call `JSON.parse()` once `content_block_stop` fires, indicating the complete JSON has been received. This is a common source of bugs in stream consumers.

---

## Exercise 4
**Challenge:** Write a `StallDetector` class that takes a timeout in milliseconds and an `AbortController`. It should have a `reset()` method and a `start()` method.

**Answer:**
```typescript
class StallDetector {
  private timeoutMs: number;
  private abortController: AbortController;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(timeoutMs: number, abortController: AbortController) {
    this.timeoutMs = timeoutMs;
    this.abortController = abortController;
  }

  start(): void {
    this.reset();
  }

  reset(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.abortController.abort(
        new Error(`Stream stalled for ${this.timeoutMs}ms`)
      );
    }, this.timeoutMs);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
```
**Explanation:** Each call to `reset()` clears the existing timer and starts a new one. If the timer fires without being reset (meaning no events arrived), it aborts the connection via the `AbortController`. The `stop()` method cleans up when the stream ends normally.

---

## Exercise 5
**Challenge:** Using the Anthropic SDK's `client.messages.stream()`, write a function that streams a response and prints each text delta to stdout in real time.

**Answer:**
```typescript
import Anthropic from "@anthropic-ai/sdk";

async function streamResponse(prompt: string): Promise<void> {
  const client = new Anthropic();

  const stream = client.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  for await (const event of stream) {
    switch (event.type) {
      case "content_block_start":
        console.log(`New block: ${event.content_block.type}`);
        break;
      case "content_block_delta":
        if (event.delta.type === "text_delta") {
          process.stdout.write(event.delta.text);
        }
        break;
      case "message_stop":
        console.log("\nStream complete.");
        break;
    }
  }
}
```
**Explanation:** The SDK's `stream()` method returns an async iterable that yields typed events. We use `process.stdout.write()` instead of `console.log()` for text deltas to avoid adding newlines between fragments. The `content_block_start` event tells us what kind of block is beginning.
