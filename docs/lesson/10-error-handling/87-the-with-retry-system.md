# Lesson 87: The withRetry System

## The Core Retry Mechanism

Every API call in Claude Code goes through `withRetry()` — a generic retry wrapper that handles transient failures with exponential backoff. It's the first line of defense against the most common error: temporary API unavailability.

## The Function Signature

```typescript
async function* withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): AsyncGenerator<SystemMessage, T> {
  const maxRetries = options.maxRetries ?? CLAUDE_CODE_MAX_RETRIES;
  const baseDelay = options.baseDelay ?? BASE_DELAY_MS;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // Some errors should never be retried
      if (error instanceof CannotRetryError) {
        throw error;
      }

      // Fallback was triggered — different recovery path
      if (error instanceof FallbackTriggeredError) {
        throw error;
      }

      // Last attempt — give up
      if (attempt === maxRetries) {
        throw lastError;
      }

      // Calculate delay and wait
      const delay = getRetryDelay(attempt, baseDelay);

      // Yield a status message so the UI shows what's happening
      yield {
        type: "system",
        subtype: "api_error",
        message: `API error (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}. Retrying in ${Math.round(delay / 1000)}s...`,
        retryIn: delay,
      } satisfies SystemAPIErrorMessage;

      await sleep(delay);
    }
  }

  throw lastError!;
}
```

Notice that `withRetry` is an **async generator**, not a simple async function. This is crucial — it needs to yield status messages during the wait periods so the UI can show the user what's happening. Without this, the user would see the agent freeze for seconds with no explanation.

## Default Configuration

```typescript
const CLAUDE_CODE_MAX_RETRIES = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 32_000;
const JITTER_FACTOR = 0.1;
```

Ten retries with exponential backoff and a 32-second cap. This means the agent will keep trying for roughly 2+ minutes before giving up — long enough to survive most transient outages.

## Exponential Backoff with Jitter

The retry delay follows a classic pattern: exponential backoff with random jitter to prevent thundering herds.

```typescript
function getRetryDelay(attempt: number, baseDelay: number): number {
  // Exponential: 1s, 2s, 4s, 8s, 16s, 32s, 32s, 32s...
  const exponentialDelay = baseDelay * Math.pow(2, attempt);

  // Cap at maximum
  const cappedDelay = Math.min(exponentialDelay, MAX_DELAY_MS);

  // Add jitter: ±10% randomness
  const jitter = cappedDelay * JITTER_FACTOR * (Math.random() * 2 - 1);

  return Math.max(0, cappedDelay + jitter);
}
```

Here's the delay progression for the default configuration:

```
Attempt 0: ~1.0s   (1000 * 2^0)
Attempt 1: ~2.0s   (1000 * 2^1)
Attempt 2: ~4.0s   (1000 * 2^2)
Attempt 3: ~8.0s   (1000 * 2^3)
Attempt 4: ~16.0s  (1000 * 2^4)
Attempt 5: ~32.0s  (1000 * 2^5, capped)
Attempt 6: ~32.0s  (capped)
Attempt 7: ~32.0s  (capped)
Attempt 8: ~32.0s  (capped)
Attempt 9: ~32.0s  (capped)
Total:     ~179s   (~3 minutes of retrying)
```

Why jitter? Without it, if 100 agents hit the same API and all get rate-limited, they'd all retry at the exact same time, causing another spike. Jitter spreads the retries across a time window:

```
Without jitter:  |====|    |====|    |====|    (all retry together)
With jitter:     |==| |=| |===| |=| |==| |=|  (spread out)
```

## The SystemAPIErrorMessage

During retry waits, `withRetry` yields messages that the UI renders:

```typescript
interface SystemAPIErrorMessage {
  type: "system";
  subtype: "api_error";
  message: string;
  retryIn: number;
  attempt?: number;
  maxAttempts?: number;
  errorCode?: string;
}
```

In a terminal UI, this might render as:

```
⚠ API error (attempt 3/11): 429 Too Many Requests. Retrying in 4s...
```

In a web UI, it might show a countdown timer. The generator pattern gives the UI flexibility to render these states however it wants.

## The Retry Loop in Detail

Let's trace through a complete retry sequence:

```typescript
// The operation: call the Claude API
const operation = () => callClaudeAPI(messages, config);

// Using withRetry in the agent loop
const retryGenerator = withRetry(operation, {
  maxRetries: CLAUDE_CODE_MAX_RETRIES,
});

let result: ModelResponse;

while (true) {
  const { value, done } = await retryGenerator.next();

  if (done) {
    // Generator returned — we have the final result
    result = value as ModelResponse;
    break;
  }

  // Generator yielded — it's a status message during retry
  const statusMessage = value as SystemAPIErrorMessage;
  yield statusMessage; // Pass it to the UI
}

// result now contains the successful API response
```

The caller consumes both the intermediate status messages and the final result from the same generator. This is a clean pattern for operations that have both "in progress" and "done" states.

## CannotRetryError: Hard Stops

Some errors should never be retried because retrying won't help:

```typescript
class CannotRetryError extends Error {
  constructor(
    message: string,
    public readonly reason: CannotRetryReason,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = "CannotRetryError";
  }
}

type CannotRetryReason =
  | "authentication_failed"    // 401 — API key is wrong
  | "forbidden"                // 403 — Not authorized
  | "not_found"                // 404 — Endpoint doesn't exist
  | "invalid_request"          // 400 — Malformed request body
  | "model_not_available"      // Model doesn't exist
  | "context_length_exceeded"; // Need compaction, not retry
```

Usage in error classification:

```typescript
function classifyAPIError(error: APIError): void {
  switch (error.statusCode) {
    case 400:
      throw new CannotRetryError(
        "Invalid request — retrying won't help",
        "invalid_request",
        error
      );

    case 401:
      throw new CannotRetryError(
        "Authentication failed — check your API key",
        "authentication_failed",
        error
      );

    case 429:
      // Rate limit — retryable! Don't throw CannotRetryError
      break;

    case 500:
    case 502:
    case 503:
      // Server errors — retryable
      break;

    case 413:
      throw new CannotRetryError(
        "Request too large — need context compaction",
        "context_length_exceeded",
        error
      );
  }
}
```

## FallbackTriggeredError: Model Switching

When a primary model fails repeatedly or is unavailable, `withRetry` can signal that a fallback model should be used:

```typescript
class FallbackTriggeredError extends Error {
  constructor(
    message: string,
    public readonly fallbackModel: string,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = "FallbackTriggeredError";
  }
}
```

This error breaks out of the retry loop and tells the caller to switch models:

```typescript
async function callModelWithFallback(
  config: ModelConfig
): Promise<ModelResponse> {
  try {
    // Try primary model with retries
    return await consumeGenerator(
      withRetry(() => callAPI(config.primaryModel))
    );
  } catch (error) {
    if (error instanceof FallbackTriggeredError) {
      // Switch to fallback model
      return await consumeGenerator(
        withRetry(() => callAPI(error.fallbackModel))
      );
    }
    throw error;
  }
}
```

## Consuming the Generator

Since `withRetry` is a generator, you need a helper to consume it while forwarding status messages:

```typescript
async function* consumeRetryGenerator<T>(
  generator: AsyncGenerator<SystemMessage, T>
): AsyncGenerator<SystemMessage, T> {
  while (true) {
    const { value, done } = await generator.next();

    if (done) {
      return value as T;
    }

    yield value; // Forward status messages
  }
}

// Or if you don't need the intermediate messages:
async function consumeGenerator<T>(
  generator: AsyncGenerator<unknown, T>
): Promise<T> {
  while (true) {
    const { value, done } = await generator.next();
    if (done) return value as T;
    // Discard yielded values
  }
}
```

## Retry-Aware Error Handling

The `withRetry` system integrates with the broader error handling by respecting the `Retry-After` header from API responses:

```typescript
function getRetryDelay(
  attempt: number,
  baseDelay: number,
  retryAfterHeader?: string
): number {
  // If the server tells us when to retry, respect that
  if (retryAfterHeader) {
    const serverDelay = parseRetryAfter(retryAfterHeader);
    if (serverDelay > 0) {
      return serverDelay * 1000; // Convert to milliseconds
    }
  }

  // Otherwise, use exponential backoff
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, MAX_DELAY_MS);
  const jitter = cappedDelay * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.max(0, cappedDelay + jitter);
}

function parseRetryAfter(header: string): number {
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) return seconds;

  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    return Math.max(0, (date.getTime() - Date.now()) / 1000);
  }

  return 0;
}
```

## Summary

`withRetry` is the foundation of Claude Code's error resilience. By wrapping every API call in exponential backoff with jitter, it handles the most common failure mode (transient API errors) automatically. The generator pattern enables real-time status updates during waits. `CannotRetryError` prevents wasted retries on permanent failures. `FallbackTriggeredError` enables model switching when one endpoint is down. Together, these mechanisms make the agent robust against the flaky reality of distributed systems.

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Implementing withRetry
**Challenge:** Implement `withRetry` as an async generator that supports exponential backoff with jitter, yields `SystemAPIErrorMessage` status updates, and respects `CannotRetryError`. Test it with a mock API function that fails 60% of the time.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-87.md#exercise-1)

### Exercise 2 — Abort-Aware Retries
**Challenge:** Add an `AbortSignal` parameter to `withRetry`. When abort fires during a sleep, the sleep should reject immediately with an `AbortError`. When abort fires between attempts, no further retries should be attempted. Implement and test both scenarios.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-87.md#exercise-2)

### Exercise 3 — Configurable Backoff Strategies
**Challenge:** Implement a `BackoffStrategy` interface with three implementations: `ExponentialBackoff`, `LinearBackoff`, and `ConstantBackoff`. Modify `withRetry` to accept a strategy via the options parameter. Each strategy should support jitter.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-87.md#exercise-3)

### Exercise 4 — Retry Monitoring
**Challenge:** Create a `RetryMonitor` class that wraps `withRetry` and tracks statistics: total attempts, success rate, average delay, p99 delay, and error type distribution. Expose metrics via a `getMetrics()` method.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-87.md#exercise-4)

### Exercise 5 — Why Async Generator?
**Question:** `withRetry` is an async generator rather than a plain async function. Explain in 3-4 sentences what would be lost if it were a plain `async function` that simply returned the result after all retries. Consider the user experience during long retry sequences.

[View Answer](../../answers/10-error-handling/answer-87.md#exercise-5)
