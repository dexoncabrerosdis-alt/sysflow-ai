# Lesson 42: The Retry System

## What You'll Learn

API calls fail. Networks drop, servers overload, rate limits kick in. A coding
agent that crashes on the first transient error is useless. In this lesson, you'll
study `withRetry` — the async generator at the heart of Claude Code's resilience
strategy.

## The Core Idea

`withRetry` wraps an API call in a loop that retries on failure. But it's not a
simple try/catch/retry — it's an **async generator** that yields status messages
during retries. The consumer (the agent loop) can show these messages to the user
while the system recovers.

## The Signature

```typescript
async function* withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: {
    maxRetries?: number;
    signal?: AbortSignal;
    onRetry?: (error: Error, attempt: number) => void;
  }
): AsyncGenerator<T | SystemAPIErrorMessage> {
  // ...
}
```

The function takes:
- `fn` — the async function to retry (makes the API call)
- `options.maxRetries` — how many times to try (default: 10)
- `options.signal` — an abort signal to cancel the whole thing
- `options.onRetry` — optional callback for logging

It yields either the successful result `T` or `SystemAPIErrorMessage` objects
during retries.

## The Retry Loop Structure

Here's the core loop, simplified from the real implementation:

```typescript
async function* withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: RetryOptions = {}
): AsyncGenerator<T | SystemAPIErrorMessage> {
  const maxRetries = options.maxRetries ?? 10;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const abortController = new AbortController();

    if (options.signal?.aborted) {
      throw options.signal.reason;
    }

    // Link parent abort signal to this attempt's controller
    const onParentAbort = () => abortController.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onParentAbort, { once: true });

    try {
      const result = await fn(abortController.signal);
      yield result;
      return; // Success — exit the generator
    } catch (error) {
      options.signal?.removeEventListener("abort", onParentAbort);

      if (error instanceof CannotRetryError) {
        throw error; // Explicit give-up
      }

      if (error instanceof FallbackTriggeredError) {
        throw error; // Let the caller switch models
      }

      if (attempt === maxRetries) {
        throw error; // Exhausted retries
      }

      const delay = getRetryDelay(attempt, error);

      yield {
        type: "system",
        level: "error",
        message: `API error (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}. Retrying in ${Math.round(delay / 1000)}s...`,
      } as SystemAPIErrorMessage;

      options.onRetry?.(error as Error, attempt);

      await sleep(delay);
    }
  }
}
```

The key behaviors:

1. **On success**: yield the result and return
2. **On retryable failure**: yield an error message, wait, try again
3. **On `CannotRetryError`**: immediately throw (some errors aren't worth retrying)
4. **On `FallbackTriggeredError`**: throw to the caller (switch to a different model)
5. **On max retries exhausted**: throw the last error

## Exponential Backoff with Jitter

The delay between retries isn't constant. It grows exponentially, with
randomization to prevent thundering herd problems:

```typescript
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 32_000;

function getRetryDelay(attempt: number, error?: Error): number {
  // Check for retry-after header
  if (error && hasRetryAfterHeader(error)) {
    const retryAfter = getRetryAfterMs(error);
    if (retryAfter > 0) return retryAfter;
  }

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 32s, 32s...
  const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, MAX_DELAY_MS);

  // Add jitter: ±25% randomization
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);

  return Math.round(cappedDelay + jitter);
}
```

The progression looks like:

| Attempt | Base Delay | With Jitter (range) |
|---|---|---|
| 0 | 1,000ms | 750–1,250ms |
| 1 | 2,000ms | 1,500–2,500ms |
| 2 | 4,000ms | 3,000–5,000ms |
| 3 | 8,000ms | 6,000–10,000ms |
| 4 | 16,000ms | 12,000–20,000ms |
| 5+ | 32,000ms | 24,000–40,000ms |

**Why jitter?** If 100 agents all get rate-limited at the same time and retry at
the exact same interval, they'll all retry together, get rate-limited again, and
create a self-reinforcing cycle. Jitter breaks the synchronization.

## `CannotRetryError`: When to Give Up

Some errors should not be retried. Invalid requests, authentication failures,
or content policy violations won't succeed no matter how many times you try:

```typescript
class CannotRetryError extends Error {
  constructor(
    message: string,
    public readonly originalError: Error
  ) {
    super(message);
    this.name = "CannotRetryError";
  }
}

function classifyError(error: Error): "retry" | "fatal" | "fallback" {
  if (error instanceof Anthropic.APIError) {
    switch (error.status) {
      case 400: return "fatal";   // Bad request — our fault
      case 401: return "fatal";   // Invalid API key
      case 403: return "fatal";   // Permission denied
      case 404: return "fatal";   // Model not found
      case 429: return "retry";   // Rate limited
      case 500: return "retry";   // Server error
      case 529: return "retry";   // Overloaded (may trigger fallback)
      default:  return "retry";
    }
  }

  if (error.message?.includes("ECONNRESET")) return "retry";
  if (error.message?.includes("ETIMEDOUT")) return "retry";
  if (error.message?.includes("fetch failed")) return "retry";

  return "retry"; // When in doubt, retry
}
```

The classification is defensive — when uncertain, retry. It's better to waste a few
seconds on a hopeless retry than to crash the agent on a transient network glitch.

## `FallbackTriggeredError`: The Model Switch Signal

When the API returns too many consecutive 529 (overloaded) errors, the retry system
gives up on the current model and signals a model switch:

```typescript
class FallbackTriggeredError extends Error {
  constructor(
    public readonly failedModel: string,
    public readonly consecutiveOverloads: number
  ) {
    super(`Model ${failedModel} overloaded (${consecutiveOverloads} consecutive 529s)`);
    this.name = "FallbackTriggeredError";
  }
}
```

This error propagates up to the query layer, which catches it and switches to a
fallback model (Lesson 44).

## Yielding Error Messages

The generator pattern lets `withRetry` communicate with the user during retries:

```typescript
// In the agent loop:
for await (const event of withRetry(makeApiCall, { maxRetries: 10 })) {
  if (isSystemErrorMessage(event)) {
    // Show to user: "API error (attempt 3/10): Rate limited. Retrying in 4s..."
    displaySystemMessage(event.message);
    continue;
  }

  // Process normal stream events
  processStreamEvent(event);
}
```

Without the generator pattern, the retry logic would be invisible — the user would
see nothing for 30+ seconds while the system silently retries. By yielding error
messages, the user sees exactly what's happening.

## The Full Retry Flow

```
withRetry(makeApiCall, { maxRetries: 10 })
    │
    ├── Attempt 0: makeApiCall()
    │     │
    │     └── 429 Rate Limited
    │           │
    │           ├── yield SystemAPIErrorMessage("Retrying in 1s...")
    │           └── sleep(1000 + jitter)
    │
    ├── Attempt 1: makeApiCall()
    │     │
    │     └── 529 Overloaded
    │           │
    │           ├── yield SystemAPIErrorMessage("Retrying in 2s...")
    │           └── sleep(2000 + jitter)
    │
    ├── Attempt 2: makeApiCall()
    │     │
    │     └── 200 OK
    │           │
    │           ├── yield streamEvents
    │           └── return (done)
    │
    (never reaches attempt 3)
```

## Composing with the Stream

In practice, `withRetry` wraps a function that returns a stream. The retry applies
to the initial connection — if the stream fails mid-way, the stall detection
(Lesson 37) handles that separately by aborting, which causes a new retry attempt.

Because `withRetry` is a pure async generator, it's highly testable — you can
inject a mock function that fails N times then succeeds, and assert both the
result and the yielded error messages.

## Key Takeaways

1. `withRetry` is an async generator — it yields error messages during retries
2. Default 10 retries with exponential backoff (1s → 32s cap) plus jitter
3. `CannotRetryError` for errors that should never be retried (400, 401, 403)
4. `FallbackTriggeredError` signals the caller to switch models
5. Jitter prevents thundering herd when many agents retry simultaneously
6. The generator pattern makes retry progress visible to the user

## Next Lesson

You've seen the retry loop and how it classifies errors. Next, you'll dive deeper
into rate limiting — the specific strategies for handling 429 and 529 responses,
persistent retry mode for background agents, and fast mode cooldowns.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Error Classification
**Question:** Classify each of these HTTP status codes as `"retry"`, `"fatal"`, or `"fallback"`: 400, 401, 429, 500, 529. For each, explain why that classification is appropriate.

[View Answer](../../answers/04-model-integration/answer-42.md#exercise-1)

### Exercise 2 — Exponential Backoff Calculator
**Challenge:** Write a function `getRetryDelay(attempt: number): number` that implements exponential backoff starting at 1 second, doubling each attempt, capped at 32 seconds, with ±25% random jitter. Return the delay in milliseconds.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-42.md#exercise-2)

### Exercise 3 — Why Jitter?
**Question:** Why does the retry system add random jitter to the delay instead of using exact exponential intervals? Describe the "thundering herd" problem and how jitter prevents it.

[View Answer](../../answers/04-model-integration/answer-42.md#exercise-3)

### Exercise 4 — Retry Generator
**Challenge:** Write a simplified `withRetry` async generator that takes a function `fn`, a `maxRetries` count, and yields either the successful result or error messages as `{type: "error", message: string}`. Use a simple 1-second delay between retries (no backoff needed for this exercise).

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-42.md#exercise-4)

### Exercise 5 — CannotRetryError vs FallbackTriggeredError
**Question:** What is the difference between `CannotRetryError` and `FallbackTriggeredError`? Give one scenario that would trigger each, and describe what the caller does when it catches each error type.

[View Answer](../../answers/04-model-integration/answer-42.md#exercise-5)
