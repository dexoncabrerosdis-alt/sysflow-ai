# Answers: Lesson 87 — The withRetry System

## Exercise 1
**Challenge:** Implement `withRetry` as an async generator with exponential backoff, jitter, status yields, and `CannotRetryError` support.

**Answer:**
```typescript
const MAX_RETRIES = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 32_000;
const JITTER_FACTOR = 0.1;

class CannotRetryError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = "CannotRetryError";
  }
}

interface SystemAPIErrorMessage {
  type: "system";
  subtype: "api_error";
  message: string;
  retryIn: number;
}

function getRetryDelay(attempt: number, baseDelay: number): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, MAX_DELAY_MS);
  const jitter = cappedDelay * JITTER_FACTOR * (Math.random() * 2 - 1);
  return Math.max(0, cappedDelay + jitter);
}

async function* withRetry<T>(
  operation: () => Promise<T>,
  options: { maxRetries?: number; baseDelay?: number } = {}
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const baseDelay = options.baseDelay ?? BASE_DELAY_MS;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (error instanceof CannotRetryError) {
        throw error;
      }

      if (attempt === maxRetries) {
        throw lastError;
      }

      const delay = getRetryDelay(attempt, baseDelay);

      yield {
        type: "system",
        subtype: "api_error",
        message: `API error (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}. Retrying in ${Math.round(delay / 1000)}s...`,
        retryIn: delay,
      };

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

// Test with 60% failure rate
async function test() {
  let callCount = 0;
  const mockApi = async (): Promise<string> => {
    callCount++;
    if (Math.random() < 0.6) throw new Error("Transient failure");
    return "success";
  };

  const gen = withRetry(mockApi, { maxRetries: 5, baseDelay: 100 });
  let result: IteratorResult<SystemAPIErrorMessage, string>;
  do {
    result = await gen.next();
    if (!result.done) console.log(result.value.message);
  } while (!result.done);

  console.log(`Result: ${result.value} after ${callCount} calls`);
}
```

**Explanation:** The generator yields status messages during each retry wait, allowing callers to show progress. `CannotRetryError` short-circuits immediately since retrying would be pointless.

---

## Exercise 2
**Challenge:** Add `AbortSignal` support to `withRetry`.

**Answer:**
```typescript
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(resolve, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function* withRetryAbortable<T>(
  operation: () => Promise<T>,
  options: { maxRetries?: number; baseDelay?: number; signal?: AbortSignal } = {}
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const baseDelay = options.baseDelay ?? BASE_DELAY_MS;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (error instanceof CannotRetryError) throw error;
      if (attempt === maxRetries) throw lastError;

      const delay = getRetryDelay(attempt, baseDelay);

      yield {
        type: "system",
        subtype: "api_error",
        message: `API error (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}. Retrying in ${Math.round(delay / 1000)}s...`,
        retryIn: delay,
      };

      await abortableSleep(delay, options.signal ?? new AbortController().signal);
    }
  }

  throw lastError!;
}
```

**Explanation:** `abortableSleep` replaces the standard sleep with one that rejects on abort — clearing the timer immediately. The abort check at the top of each iteration prevents starting a new attempt after abort fires between retries.

---

## Exercise 3
**Challenge:** Implement configurable backoff strategies.

**Answer:**
```typescript
interface BackoffStrategy {
  getDelay(attempt: number, baseDelay: number): number;
}

class ExponentialBackoff implements BackoffStrategy {
  constructor(private maxDelay: number = MAX_DELAY_MS, private jitter: number = JITTER_FACTOR) {}

  getDelay(attempt: number, baseDelay: number): number {
    const delay = Math.min(baseDelay * Math.pow(2, attempt), this.maxDelay);
    return this.addJitter(delay);
  }

  private addJitter(delay: number): number {
    return Math.max(0, delay + delay * this.jitter * (Math.random() * 2 - 1));
  }
}

class LinearBackoff implements BackoffStrategy {
  constructor(private maxDelay: number = MAX_DELAY_MS, private jitter: number = JITTER_FACTOR) {}

  getDelay(attempt: number, baseDelay: number): number {
    const delay = Math.min(baseDelay * (attempt + 1), this.maxDelay);
    return Math.max(0, delay + delay * this.jitter * (Math.random() * 2 - 1));
  }
}

class ConstantBackoff implements BackoffStrategy {
  constructor(private jitter: number = JITTER_FACTOR) {}

  getDelay(_attempt: number, baseDelay: number): number {
    return Math.max(0, baseDelay + baseDelay * this.jitter * (Math.random() * 2 - 1));
  }
}

interface RetryOptionsV2 {
  maxRetries?: number;
  baseDelay?: number;
  backoff?: BackoffStrategy;
}

async function* withRetryV2<T>(
  operation: () => Promise<T>,
  options: RetryOptionsV2 = {}
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const baseDelay = options.baseDelay ?? BASE_DELAY_MS;
  const backoff = options.backoff ?? new ExponentialBackoff();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (error instanceof CannotRetryError) throw error;
      if (attempt === maxRetries) throw lastError;

      const delay = backoff.getDelay(attempt, baseDelay);
      yield {
        type: "system",
        subtype: "api_error",
        message: `Retry ${attempt + 1}/${maxRetries + 1}: ${lastError.message}. Waiting ${Math.round(delay / 1000)}s...`,
        retryIn: delay,
      };
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError!;
}
```

**Explanation:** The `BackoffStrategy` interface abstracts delay calculation, allowing callers to choose exponential (default), linear, or constant strategies. All three support jitter to prevent thundering herds.

---

## Exercise 4
**Challenge:** Create a `RetryMonitor` that tracks retry statistics.

**Answer:**
```typescript
interface RetryMetrics {
  totalAttempts: number;
  totalSuccesses: number;
  totalFailures: number;
  successRate: number;
  averageDelayMs: number;
  p99DelayMs: number;
  errorDistribution: Record<string, number>;
}

class RetryMonitor {
  private attempts = 0;
  private successes = 0;
  private failures = 0;
  private delays: number[] = [];
  private errorCounts: Record<string, number> = {};

  async executeWithMonitoring<T>(
    operation: () => Promise<T>,
    options: RetryOptionsV2 = {}
  ): Promise<T> {
    const gen = withRetryV2(operation, options);
    let result: IteratorResult<SystemAPIErrorMessage, T>;

    do {
      result = await gen.next();
      if (!result.done) {
        this.attempts++;
        this.delays.push(result.value.retryIn);
        const errorKey = this.extractErrorType(result.value.message);
        this.errorCounts[errorKey] = (this.errorCounts[errorKey] ?? 0) + 1;
      }
    } while (!result.done);

    this.attempts++;
    this.successes++;
    return result.value;
  }

  recordFailure(error: Error): void {
    this.failures++;
    const key = error.constructor.name;
    this.errorCounts[key] = (this.errorCounts[key] ?? 0) + 1;
  }

  getMetrics(): RetryMetrics {
    const sorted = [...this.delays].sort((a, b) => a - b);
    const p99Index = Math.floor(sorted.length * 0.99);
    return {
      totalAttempts: this.attempts,
      totalSuccesses: this.successes,
      totalFailures: this.failures,
      successRate: this.attempts > 0 ? this.successes / this.attempts : 0,
      averageDelayMs: sorted.length > 0
        ? sorted.reduce((a, b) => a + b, 0) / sorted.length
        : 0,
      p99DelayMs: sorted[p99Index] ?? 0,
      errorDistribution: { ...this.errorCounts },
    };
  }

  private extractErrorType(message: string): string {
    const match = message.match(/\d{3}/);
    return match ? `HTTP_${match[0]}` : "unknown";
  }
}
```

**Explanation:** The monitor wraps `withRetry` to intercept every yielded status message, recording delays and error types. The `getMetrics()` method computes aggregate statistics including a p99 delay for identifying tail-latency issues.

---

## Exercise 5
**Question:** Why is `withRetry` an async generator rather than a plain async function?

**Answer:** If `withRetry` were a plain `async function`, the caller would block for the entire retry sequence (up to ~3 minutes with default settings) with no visibility into what is happening. The user would see the agent freeze with no explanation — no attempt counts, no countdown timers, no error messages. The async generator pattern lets `withRetry` yield real-time status updates between attempts, which the UI layer can render as progress indicators, error messages, or retry countdowns. This transforms a long silent wait into an informative, interruptible process.
