# Answers: Lesson 99 — Event-Driven Architecture

## Exercise 1
**Question:** Explain two specific advantages that async generators provide over Node's EventEmitter for streaming agent events. Why does backpressure matter in a coding agent that executes shell commands?

**Answer:** First, async generators provide **automatic backpressure**: the producer only runs when the consumer calls `next()`, so if a consumer is slow to render or process, the generator pauses naturally. EventEmitter fires events regardless of whether listeners are ready, risking buffer overflow or dropped events. Second, async generators provide **lazy, pull-based evaluation**: events are only produced on demand, meaning no work is wasted generating events nobody consumes. With EventEmitter, events fire eagerly even if no listener is attached. Backpressure matters for a coding agent because shell commands can produce enormous stdout/stderr output — if the agent generates events faster than a consumer (like a terminal renderer or SSE stream) can process them, unbounded buffering could exhaust memory. Async generators naturally throttle the producer to match the consumer's pace.

---

## Exercise 2
**Challenge:** Implement three async generator middleware functions that compose together: `withTimestamps`, `withRateLimiting`, and `withErrorRecovery`. Then compose all three around a mock event source.

**Answer:**

```typescript
type StreamEvent =
  | { type: "assistant_text"; content: string }
  | { type: "tool_use"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: string }
  | { type: "turn_complete"; usage: { total: number } }
  | { type: "error"; error: { message: string } };

type TimestampedEvent = StreamEvent & { timestamp: number };

async function* withTimestamps(
  events: AsyncGenerator<StreamEvent>
): AsyncGenerator<TimestampedEvent> {
  for await (const event of events) {
    yield { ...event, timestamp: Date.now() };
  }
}

async function* withRateLimiting(
  events: AsyncGenerator<TimestampedEvent>,
  maxPerSecond: number = 100
): AsyncGenerator<TimestampedEvent> {
  let textEventTimes: number[] = [];

  for await (const event of events) {
    if (event.type === "assistant_text") {
      const now = Date.now();
      textEventTimes = textEventTimes.filter(t => now - t < 1000);

      if (textEventTimes.length >= maxPerSecond) {
        continue; // Drop this event
      }
      textEventTimes.push(now);
    }
    yield event;
  }
}

async function* withErrorRecovery(
  events: AsyncGenerator<TimestampedEvent>
): AsyncGenerator<TimestampedEvent> {
  try {
    for await (const event of events) {
      yield event;
    }
  } catch (error) {
    yield {
      type: "error",
      error: { message: error instanceof Error ? error.message : String(error) },
      timestamp: Date.now(),
    };
  }
}

// Compose the pipeline
async function* mockEventSource(): AsyncGenerator<StreamEvent> {
  yield { type: "assistant_text", content: "Hello" };
  yield { type: "tool_use", tool: "Read", input: { path: "file.ts" } };
  yield { type: "tool_result", tool: "Read", result: "file contents" };
  yield { type: "turn_complete", usage: { total: 500 } };
}

const raw = mockEventSource();
const timestamped = withTimestamps(raw);
const rateLimited = withRateLimiting(timestamped);
const safe = withErrorRecovery(rateLimited);

for await (const event of safe) {
  console.log(`[${event.timestamp}] ${event.type}`);
}
```

**Explanation:** Each middleware is a pure function from async generator to async generator. `withTimestamps` decorates every event with a timestamp. `withRateLimiting` tracks a sliding window of text event timestamps and drops excess events. `withErrorRecovery` wraps the iteration in a try/catch and converts thrown errors into error events. They compose by feeding each generator into the next, creating a pipeline analogous to Unix pipes.

---

## Exercise 3
**Challenge:** Write a `handleEvent` function with an exhaustiveness check using TypeScript's `never` type.

**Answer:**

```typescript
type StreamEvent =
  | { type: "assistant_text"; content: string }
  | { type: "tool_use"; tool: string }
  | { type: "tool_result"; tool: string; result: string }
  | { type: "turn_complete"; usage: { total: number } }
  | { type: "error"; error: { message: string } };

function assertNever(x: never): never {
  throw new Error(`Unhandled event type: ${JSON.stringify(x)}`);
}

function handleEvent(event: StreamEvent): string {
  switch (event.type) {
    case "assistant_text":
      return `Text: ${event.content.slice(0, 50)}`;
    case "tool_use":
      return `Tool call: ${event.tool}`;
    case "tool_result":
      return `Tool result from ${event.tool}: ${event.result.slice(0, 50)}`;
    case "turn_complete":
      return `Turn complete, ${event.usage.total} tokens used`;
    case "error":
      return `Error: ${event.error.message}`;
    default:
      return assertNever(event);
  }
}
```

**Explanation:** The `assertNever` function accepts a parameter of type `never`. After all cases in the union are handled in the `switch`, TypeScript narrows the remaining type to `never`. If someone adds a new variant to `StreamEvent` (e.g., `{ type: "permission_request"; ... }`) without adding a corresponding `case`, TypeScript will report a compile-time error because the new variant type is not assignable to `never`. This guarantees exhaustive handling at compile time.

---

## Exercise 4
**Challenge:** Implement a `teeEventStream` function that broadcasts one async generator to two independent consumers.

**Answer:**

```typescript
function teeEventStream<T>(
  source: AsyncGenerator<T>
): [AsyncGenerator<T>, AsyncGenerator<T>] {
  const bufferA: T[] = [];
  const bufferB: T[] = [];
  let resolveA: (() => void) | null = null;
  let resolveB: (() => void) | null = null;
  let done = false;
  let error: Error | null = null;

  // Background pump that reads from source and pushes to both buffers
  (async () => {
    try {
      for await (const event of source) {
        bufferA.push(event);
        bufferB.push(event);
        resolveA?.();
        resolveB?.();
      }
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    } finally {
      done = true;
      resolveA?.();
      resolveB?.();
    }
  })();

  async function* createConsumer(
    buffer: T[],
    getResolve: () => (() => void) | null,
    setResolve: (r: (() => void) | null) => void
  ): AsyncGenerator<T> {
    while (true) {
      while (buffer.length > 0) {
        yield buffer.shift()!;
      }

      if (done && buffer.length === 0) {
        if (error) throw error;
        return;
      }

      await new Promise<void>(resolve => setResolve(resolve));
      setResolve(null);
    }
  }

  const genA = createConsumer(
    bufferA,
    () => resolveA,
    (r) => { resolveA = r; }
  );

  const genB = createConsumer(
    bufferB,
    () => resolveB,
    (r) => { resolveB = r; }
  );

  return [genA, genB];
}

// Usage
async function* mockSource(): AsyncGenerator<StreamEvent> {
  yield { type: "assistant_text", content: "Hello" };
  yield { type: "turn_complete", usage: { total: 100 } };
}

const [streamA, streamB] = teeEventStream(mockSource());

// Consumer A: render to terminal
(async () => {
  for await (const event of streamA) {
    console.log("Terminal:", event.type);
  }
})();

// Consumer B: collect telemetry
(async () => {
  for await (const event of streamB) {
    console.log("Telemetry:", event.type);
  }
})();
```

**Explanation:** The core challenge is that an async generator can only be iterated once. The `teeEventStream` function starts a background pump that reads from the source and pushes each event into two separate buffers. Each consumer is an independent async generator that drains its own buffer, waiting via a promise when the buffer is empty. This allows consumers to proceed at different speeds — a slower consumer just accumulates more buffered events.

---

## Exercise 5
**Challenge:** Build a `TelemetryCollector` class that acts as passthrough middleware while collecting metrics.

**Answer:**

```typescript
interface TelemetrySummary {
  toolCallsByName: Record<string, number>;
  totalTokens: number;
  totalErrors: number;
  averageTurnDurationMs: number;
  timeline: Array<{ timestamp: number; type: string }>;
}

class TelemetryCollector {
  private toolCalls: Record<string, number> = {};
  private totalTokens = 0;
  private totalErrors = 0;
  private turnDurations: number[] = [];
  private currentTurnStart: number | null = null;
  private timeline: Array<{ timestamp: number; type: string }> = [];

  async *collect(
    events: AsyncGenerator<StreamEvent>
  ): AsyncGenerator<StreamEvent> {
    for await (const event of events) {
      const now = Date.now();
      this.timeline.push({ timestamp: now, type: event.type });

      switch (event.type) {
        case "tool_use":
          this.toolCalls[event.tool] = (this.toolCalls[event.tool] ?? 0) + 1;
          break;

        case "message_start":
          this.currentTurnStart = now;
          break;

        case "turn_complete":
          this.totalTokens += event.usage.total;
          if (this.currentTurnStart !== null) {
            this.turnDurations.push(now - this.currentTurnStart);
            this.currentTurnStart = null;
          }
          break;

        case "error":
          this.totalErrors++;
          break;
      }

      yield event; // Passthrough — don't modify or block
    }
  }

  getSummary(): TelemetrySummary {
    const avgDuration = this.turnDurations.length > 0
      ? this.turnDurations.reduce((a, b) => a + b, 0) / this.turnDurations.length
      : 0;

    return {
      toolCallsByName: { ...this.toolCalls },
      totalTokens: this.totalTokens,
      totalErrors: this.totalErrors,
      averageTurnDurationMs: Math.round(avgDuration),
      timeline: [...this.timeline],
    };
  }
}

// Usage
const collector = new TelemetryCollector();
const events = query(message, options);
const monitored = collector.collect(events);

for await (const event of monitored) {
  renderToTerminal(event); // Consumer still gets every event
}

console.log(collector.getSummary());
```

**Explanation:** The `TelemetryCollector` uses the passthrough middleware pattern — its `collect` method is an async generator that yields every event unchanged while recording metrics as a side effect. The class tracks tool calls by name using a frequency map, accumulates token counts from `turn_complete` events, counts errors, and measures turn durations using the time between `message_start` and `turn_complete`. The `getSummary` method returns a snapshot of all collected metrics. Because it yields events immediately, it adds negligible overhead to the event pipeline.
