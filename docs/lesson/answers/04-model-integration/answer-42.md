# Answers: Lesson 42 — The Retry System

## Exercise 1
**Challenge:** Write a function `classifyError(status: number): "retry" | "fatal" | "fallback"`.

**Answer:**
```typescript
function classifyError(status: number): "retry" | "fatal" | "fallback" {
  switch (status) {
    case 400: return "fatal";
    case 401: return "fatal";
    case 403: return "fatal";
    case 404: return "fatal";
    case 429: return "retry";
    case 500: return "retry";
    case 502: return "retry";
    case 503: return "retry";
    case 529: return "fallback";
    default:  return "retry";
  }
}
```
**Explanation:** Fatal errors (400-level client errors) indicate our request is invalid — retrying won't help. Retry errors (429, 5xx) are transient — the server is temporarily unavailable or overloaded. The 529 (overloaded) maps to "fallback" because persistent overload suggests the model itself is unavailable and we should switch models. The default is "retry" — when in doubt, it's better to waste a retry attempt than to crash.

---

## Exercise 2
**Question:** Why is `withRetry` an async generator instead of a simple async function?

**Answer:** As an async generator, `withRetry` can yield status messages to the consumer during retries — "API error (attempt 3/10): Rate limited. Retrying in 4s..." The agent loop displays these to the user in real time, keeping them informed that the system is working through a temporary issue. A simple async function would be a black box — the user would see nothing for 30+ seconds while the system silently retries. The generator pattern turns invisible recovery into visible progress, which is critical for user trust in an interactive tool.

---

## Exercise 3
**Challenge:** Write a `getRetryDelay` function with exponential backoff and jitter.

**Answer:**
```typescript
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 32_000;

function getRetryDelay(attempt: number): number {
  const exponentialDelay = BASE_DELAY_MS * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, MAX_DELAY_MS);
  const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(cappedDelay + jitter);
}
```
**Explanation:** The base delay doubles each attempt: 1s → 2s → 4s → 8s → 16s → 32s (cap). Jitter adds ±25% randomization to prevent thundering herd — if 100 agents all get rate-limited simultaneously, jitter ensures they don't all retry at the exact same moment, which would cause another rate limit.

---

## Exercise 4
**Question:** Explain the difference between `CannotRetryError` and `FallbackTriggeredError`.

**Answer:** `CannotRetryError` signals that the error is permanent and no amount of retrying will fix it. Examples: (1) a 400 Bad Request because the message format is invalid, (2) a 401 because the API key is wrong. The caller should surface the error to the user. `FallbackTriggeredError` signals that the current model is overwhelmed but a different model might work. Examples: (1) three consecutive 529 overloaded responses from Opus, (2) persistent 529s during a high-traffic period. The caller should catch this, switch to a fallback model, and retry the request with the new model. The key difference: CannotRetry means "stop trying," while Fallback means "try differently."

---

## Exercise 5
**Challenge:** Write a simplified `withRetry` async generator.

**Answer:**
```typescript
type SystemError = { type: "system"; level: "error"; message: string };

async function* withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 10
): AsyncGenerator<T | SystemError> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      yield result;
      return;
    } catch (error) {
      const err = error as Error & { status?: number };
      const classification = classifyError(err.status ?? 0);

      if (classification === "fatal") {
        throw error;
      }

      if (classification === "fallback") {
        throw error;
      }

      if (attempt === maxRetries) {
        throw error;
      }

      const delay = getRetryDelay(attempt);

      yield {
        type: "system",
        level: "error",
        message: `API error (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}. Retrying in ${Math.round(delay / 1000)}s...`,
      };

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
```
**Explanation:** On success, the generator yields the result and returns (exits). On retryable failure, it yields an error message the caller can display, waits the backoff delay, then loops. Fatal and fallback errors are thrown immediately for the caller to handle. When retries are exhausted, the last error propagates up.
