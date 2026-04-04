# Lesson 99: Event-Driven Architecture

## Why Events, Not Callbacks

Most software you've written probably uses a request-response pattern: call a function, get a result. That works when you have one consumer. But Claude Code has many consumers — the CLI needs to render text, the web UI needs to stream JSON, the SDK needs to yield objects, and telemetry needs to record metrics. All from the same operation.

Callbacks don't scale here. If `queryLoop` accepted a callback for every event type, you'd get:

```typescript
queryLoop({
  onText: (text) => { /* ... */ },
  onToolUse: (tool) => { /* ... */ },
  onError: (err) => { /* ... */ },
  onPermission: (req) => { /* ... */ },
  onTokenUsage: (usage) => { /* ... */ },
  // 20 more callbacks...
})
```

This creates tight coupling. Every new event type requires changing the function signature. Every consumer must be wired up at call time. Testing requires mocking every callback.

Events solve this by inverting the relationship: the producer emits events into a stream, and consumers subscribe independently.

## The Async Generator as Event Bus

Claude Code's event system isn't built on EventEmitter or RxJS. It uses a language primitive: **async generators**. The `query()` function is an async generator that yields `StreamEvent` objects:

```typescript
async function* query(
  userMessage: MessageParam,
  options: QueryOptions
): AsyncGenerator<StreamEvent> {
  // Set up the conversation
  const messages = buildMessages(userMessage, options);
  
  // Enter the agent loop
  for await (const event of queryLoop(messages, options)) {
    // Each iteration of the loop yields events to the consumer
    yield event;
  }
}
```

This is the core insight: **the async generator IS the event bus**. There's no separate pub/sub system, no event emitter, no message queue. The generator lazily produces events, and the consumer pulls them at its own pace.

## StreamEvent Types

Every event flowing through the system is a discriminated union — a tagged type where the `type` field determines the shape:

```typescript
type StreamEvent =
  | { type: "assistant_text"; content: string }
  | { type: "tool_use"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: ToolResult }
  | { type: "permission_request"; tool: string; input: Record<string, unknown> }
  | { type: "permission_response"; granted: boolean }
  | { type: "turn_complete"; usage: TokenUsage }
  | { type: "error"; error: AgentError }
  | { type: "api_request"; model: string; tokens: number }
  | { type: "api_response"; status: number; duration: number }
  | { type: "message_start"; messageId: string }
  | { type: "message_delta"; delta: ContentBlockDelta }
  | { type: "content_block_start"; index: number; block: ContentBlock }
  | { type: "content_block_delta"; index: number; delta: ContentBlockDelta }
  | { type: "content_block_stop"; index: number };
```

The discriminated union pattern means TypeScript can narrow the type in a switch statement:

```typescript
for await (const event of query(message, options)) {
  switch (event.type) {
    case "assistant_text":
      // TypeScript knows: event.content is string
      process.stdout.write(event.content);
      break;
    case "tool_use":
      // TypeScript knows: event.tool is string, event.input exists
      console.log(`Using tool: ${event.tool}`);
      break;
    case "error":
      // TypeScript knows: event.error is AgentError
      console.error(event.error.message);
      break;
  }
}
```

No type casting. No runtime checks. The compiler guarantees correctness.

## How Consumers Subscribe

Every consumer uses the same pattern — `for await...of`:

```typescript
// CLI consumer: render to terminal
async function runCLI(message: string) {
  const events = query(
    { role: "user", content: message },
    { model: "claude-sonnet-4-20250514", maxTurns: 10 }
  );

  for await (const event of events) {
    switch (event.type) {
      case "assistant_text":
        renderMarkdown(event.content);
        break;
      case "tool_use":
        showToolSpinner(event.tool);
        break;
      case "tool_result":
        displayToolOutput(event.result);
        break;
      case "turn_complete":
        showTokenUsage(event.usage);
        break;
    }
  }
}
```

The consumer only handles the events it cares about. Unknown event types are silently ignored. This is critical for forward compatibility — new event types can be added without breaking existing consumers.

## Multiple Consumers: One Core, Many Faces

The same event stream powers radically different interfaces:

```typescript
// CLI: Rich terminal rendering with React Ink
async function cliConsumer(events: AsyncGenerator<StreamEvent>) {
  for await (const event of events) {
    dispatch({ type: "STREAM_EVENT", event }); // Feed React state
  }
}

// Web UI: Server-Sent Events over HTTP
async function webConsumer(events: AsyncGenerator<StreamEvent>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for await (const event of events) {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(data));
      }
      controller.close();
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

// SDK: Yield objects for programmatic use
async function* sdkConsumer(
  events: AsyncGenerator<StreamEvent>
): AsyncGenerator<StreamEvent> {
  for await (const event of events) {
    yield event; // Pass through — let the caller decide
  }
}

// Telemetry: Silent observer that records metrics
async function telemetryConsumer(events: AsyncGenerator<StreamEvent>) {
  const metrics: TelemetryData = { toolCalls: 0, tokens: 0, errors: 0 };
  
  for await (const event of events) {
    switch (event.type) {
      case "tool_use":
        metrics.toolCalls++;
        break;
      case "turn_complete":
        metrics.tokens += event.usage.total;
        break;
      case "error":
        metrics.errors++;
        break;
    }
  }
  
  await reportMetrics(metrics);
}
```

Notice: the core `query()` function doesn't know about any of these consumers. It doesn't know if it's powering a CLI, a web app, or a test harness. It just yields events.

## Event-Driven vs Request-Response

Here's the architectural difference visualized:

```
REQUEST-RESPONSE (traditional):
┌──────────┐     call      ┌──────────┐
│  Client   │ ────────────→ │  Server   │
│           │ ←──────────── │           │
└──────────┘    response    └──────────┘
  One caller, one response, tightly coupled.

EVENT-DRIVEN (Claude Code):
                            ┌──────────┐
                       ┌───→│   CLI    │
┌──────────┐  events   │    └──────────┘
│  query() │ ──────────┤    ┌──────────┐
│  (core)  │  stream   ├───→│  Web UI  │
└──────────┘           │    └──────────┘
                       │    ┌──────────┐
                       ├───→│   SDK    │
                       │    └──────────┘
                       │    ┌──────────┐
                       └───→│ Telemetry│
                            └──────────┘
  One producer, many consumers, loosely coupled.
```

## Composability Through Events

Events enable middleware-style composition. You can transform, filter, or augment the event stream:

```typescript
async function* withLogging(
  events: AsyncGenerator<StreamEvent>
): AsyncGenerator<StreamEvent> {
  for await (const event of events) {
    console.log(`[${new Date().toISOString()}] ${event.type}`);
    yield event; // Pass through unchanged
  }
}

async function* filterSensitive(
  events: AsyncGenerator<StreamEvent>
): AsyncGenerator<StreamEvent> {
  for await (const event of events) {
    if (event.type === "tool_result" && event.tool === "ReadFile") {
      yield { ...event, result: redact(event.result) };
    } else {
      yield event;
    }
  }
}

// Compose: query → logging → filtering → consumer
const raw = query(message, options);
const logged = withLogging(raw);
const safe = filterSensitive(logged);

for await (const event of safe) {
  handleEvent(event);
}
```

Each transformer is a pure function from `AsyncGenerator<StreamEvent>` to `AsyncGenerator<StreamEvent>`. They compose like Unix pipes.

## Backpressure for Free

Async generators have built-in backpressure. The producer only runs when the consumer calls `next()`. If the CLI is slow to render, the generator pauses. If the web consumer disconnects, iteration stops. No buffer overflow. No dropped events. No explicit flow control code.

```typescript
for await (const event of query(message, options)) {
  // The generator is PAUSED while this block executes.
  // If this takes 5 seconds, the producer waits 5 seconds.
  await slowRender(event);
  // Only after this iteration completes does the generator resume.
}
```

This is why async generators beat EventEmitter for streaming — EventEmitter has no backpressure. Events fire whether or not anyone is ready for them.

## Separation of Concerns

The event-driven architecture enforces clean boundaries:

| Layer | Responsibility | Knows About Events? |
|-------|---------------|---------------------|
| `queryLoop` | Agent loop, tool execution, API calls | **Producer** — yields events |
| `StreamEvent` | Event type definitions | **Contract** — shared types |
| CLI (`REPL.tsx`) | Terminal rendering | **Consumer** — reads events |
| Web (`stream.ts`) | HTTP streaming | **Consumer** — reads events |
| SDK (`QueryEngine`) | Programmatic API | **Consumer** — reads events |
| Telemetry | Metrics collection | **Consumer** — reads events |

No layer reaches into another. The query loop doesn't import React. The CLI doesn't import HTTP. They communicate only through the event stream.

## Key Takeaways

1. **Async generators ARE the event bus** — no framework needed
2. **Discriminated unions** make events type-safe and exhaustive
3. **`for await...of`** is the universal subscription mechanism
4. **Backpressure is automatic** — producers pause when consumers are slow
5. **Composability** comes from generator-to-generator transforms
6. **Separation of concerns** is enforced by the producer/consumer boundary
7. **Forward compatibility** — new event types don't break existing consumers

This architecture is why Claude Code can be a CLI, a web app, an SDK, and a telemetry pipeline — all from the same core loop. The event stream is the universal interface.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Async Generators vs EventEmitter
**Question:** Explain two specific advantages that async generators provide over Node's EventEmitter for streaming agent events. Why does backpressure matter in a coding agent that executes shell commands?

[View Answer](../../answers/12-architecture-and-advanced/answer-99.md#exercise-1)

### Exercise 2 — Build an Event Middleware Pipeline
**Challenge:** Implement three async generator middleware functions that compose together: `withTimestamps` (adds a `timestamp` field to every event), `withRateLimiting` (drops `assistant_text` events if more than 100 arrive within 1 second), and `withErrorRecovery` (catches errors from the upstream generator, yields an error event, and continues). Then compose all three around a mock event source.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-99.md#exercise-2)

### Exercise 3 — Discriminated Union Exhaustiveness
**Challenge:** Write a `handleEvent` function that accepts a `StreamEvent` (use a simplified union with at least 5 event types) and uses a `switch` statement with an exhaustiveness check in the `default` case. The function should return a string description of the event. Use TypeScript's `never` type to guarantee that adding a new event type to the union causes a compile-time error if the switch isn't updated.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-99.md#exercise-3)

### Exercise 4 — Multi-Consumer Tee
**Challenge:** Implement an `teeEventStream` function that takes a single `AsyncGenerator<StreamEvent>` and returns two independent `AsyncGenerator<StreamEvent>` iterators that each receive every event. This is the core problem of broadcasting one async generator to multiple consumers. Handle the case where one consumer is slower than the other by buffering events.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-99.md#exercise-4)

### Exercise 5 — Event-Driven Telemetry Collector
**Challenge:** Build a `TelemetryCollector` class that consumes a `StreamEvent` async generator and tracks: total tool calls by tool name, total tokens used, total errors, average turn duration (time between `message_start` and `turn_complete`), and a timeline of events with timestamps. Expose a `getSummary()` method that returns a structured report. The collector must not block the event stream — it should process events as a passthrough middleware.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-99.md#exercise-5)
