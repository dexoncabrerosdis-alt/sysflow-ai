# Answers: Lesson 15 — Stream Events and Yielding

## Exercise 1
**Question:** Name the four types that `queryLoop()` yields, and explain when each is used.

**Answer:**
1. **`StreamEvent`** — Raw streaming chunks from the Anthropic API (`content_block_start`, `content_block_delta`, `content_block_stop`, `message_start`, `message_delta`, `message_stop`). Yielded during the model's response generation. These are **ephemeral** — used for real-time rendering (showing text appearing character by character) but not stored in conversation history.

2. **`Message`** — Complete conversation messages (assistant responses or tool results). Yielded after streaming is complete and the full response is assembled. These are **canonical** — they are the authoritative records stored in conversation history and sent to the model in future iterations.

3. **`TombstoneMessage`** — Invalidation markers for previously yielded messages. Yielded when the loop decides to discard a response (e.g., during model fallback/escalation). **Ephemeral** — they instruct consumers to remove or grey out a previous message.

4. **`ToolUseSummaryMessage`** — Human-friendly summaries of tool execution (e.g., "Read 450 lines from src/index.ts" instead of dumping the whole file). Yielded after tool result messages. **Ephemeral** — for display purposes only, not part of the model's conversation.

---

## Exercise 2
**Challenge:** Write a CLI consumer function that processes all four event types.

**Answer:**
```typescript
type AgentEvent =
  | { type: "stream_request_start" }
  | { type: "content_block_delta"; delta?: { text?: string } }
  | { type: "content_block_start" | "content_block_stop" | "message_start" | "message_stop" }
  | { role: "assistant" | "user"; content: unknown }
  | { type: "tool_use_summary"; toolName: string; summary: string; duration: number }
  | { type: "tombstone"; originalMessage: unknown; reason: string };

async function cliConsumer(
  events: AsyncGenerator<AgentEvent, { reason: string }>
): Promise<void> {
  let result = await events.next();

  while (!result.done) {
    const event = result.value;

    if ("type" in event) {
      switch (event.type) {
        case "stream_request_start":
          process.stdout.write("\n--- New Turn ---\n");
          break;

        case "content_block_delta":
          if (event.delta?.text) {
            process.stdout.write(event.delta.text);
          }
          break;

        case "tool_use_summary":
          const e = event as { toolName: string; summary: string; duration: number };
          console.log(`\n  [${e.toolName}] ${e.summary} (${e.duration}ms)`);
          break;

        case "tombstone":
          console.log("\n  [message invalidated]");
          break;
      }
    }

    result = await events.next();
  }

  console.log(`\nLoop ended: ${result.value.reason}`);
}
```

**Explanation:** The consumer uses `process.stdout.write` for streaming text (no newline after each chunk) and `console.log` for discrete events. It uses the `.next()` protocol instead of `for await...of` so it can capture the `Terminal` return value at the end.

---

## Exercise 3
**Question:** What is the "yield contract" and why does the generator *return* (not yield) a `Terminal`?

**Answer:** The yield contract is the set of ordering guarantees between the loop and its consumers:

- Every iteration starts with `stream_request_start`
- Streaming events arrive in order, properly nested: `start → delta(s) → stop`
- Complete `Message` objects follow the streaming events for the same content
- `ToolUseSummaryMessage` follows the tool result `Message` it summarizes
- `TombstoneMessage` can appear at any point (invalidating a previous message)
- The generator ends by **returning** a `Terminal`, never by yielding one

The `Terminal` is returned rather than yielded because it's **metadata about the loop's termination**, not an event in the stream. If it were yielded, consumers would need to filter it out of the event stream and handle it specially. By returning it, the separation is enforced by the type system: yielded values are `StreamEvent | Message | ...` (things to display), while the return value is `Terminal` (status information). Consumers who need the terminal reason use `.next()` to detect `done === true`. Consumers who don't care (like a simple logger) just use `for await...of` and it's automatically excluded.

---

## Exercise 4
**Challenge:** Write `cliConsumer` and `sdkConsumer` for the same event stream.

**Answer:**
```typescript
type AgentEvent =
  | { type: "stream_request_start" }
  | { type: "content_block_delta"; text: string }
  | { type: "tool_use_summary"; toolName: string; summary: string }
  | { role: "assistant" | "user"; content: string };

type Terminal = { reason: string; turnCount: number };

async function cliConsumer(
  gen: AsyncGenerator<AgentEvent, Terminal>
): Promise<Terminal> {
  let result = await gen.next();

  while (!result.done) {
    const event = result.value;

    if ("type" in event) {
      if (event.type === "stream_request_start") {
        console.log("\n========== New Turn ==========");
      } else if (event.type === "content_block_delta") {
        process.stdout.write(event.text);
      } else if (event.type === "tool_use_summary") {
        console.log(`  -> ${event.toolName}: ${event.summary}`);
      }
    } else if ("role" in event) {
      // Complete message — just note it, text was already streamed
      console.log(`\n[${event.role} message recorded]`);
    }

    result = await gen.next();
  }

  console.log(`\nDone: ${result.value.reason} (${result.value.turnCount} turns)`);
  return result.value;
}

async function sdkConsumer(
  gen: AsyncGenerator<AgentEvent, Terminal>
): Promise<{ messages: AgentEvent[]; terminal: Terminal }> {
  const messages: AgentEvent[] = [];
  let result = await gen.next();

  while (!result.done) {
    const event = result.value;

    // Only collect complete Message objects, ignore streaming events
    if ("role" in event) {
      messages.push(event);
    }

    result = await gen.next();
  }

  return { messages, terminal: result.value };
}
```

**Explanation:** Both consumers process the exact same generator, but filter differently. The CLI consumer renders every event type for human consumption. The SDK consumer silently skips all `StreamEvent` and `ToolUseSummaryMessage` types, collecting only complete `Message` objects. This demonstrates the power of the event-based yield pattern: one producer, many consumers with different needs.

---

## Exercise 5
**Question:** Why does `stream_request_start` exist if it carries no data?

**Answer:** `stream_request_start` is a **structural signal** — it marks the boundary between loop iterations. Without it, consumers would have no way to know when one turn ends and another begins.

**CLI example:** The CLI uses it to print a separator line or show a "Thinking..." spinner between turns. Without it, the output from one tool execution and the next model response would run together with no visual break, making the output hard to follow.

**Web UI example:** A web interface uses it to create a new "turn card" or conversation bubble in the UI. Each `stream_request_start` triggers a new React component instance. Without it, the UI couldn't distinguish between "the model is still responding to the first API call" and "a new API call just started." All streaming text would appear in a single block instead of separate turn-by-turn responses.

The event is the loop's **heartbeat** — it doesn't carry information about *what* is happening, but it signals *that* a new cycle is beginning. Structural events like this are common in streaming protocols (think of HTTP chunk boundaries or WebSocket frame markers).
