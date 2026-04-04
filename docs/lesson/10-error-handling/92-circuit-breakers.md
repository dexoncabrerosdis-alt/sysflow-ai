# Lesson 92: Circuit Breakers

## The Infinite Retry Problem

In Lesson 87, you learned about `withRetry` — the system that retries failed operations. In Lesson 89, you learned about context compaction — the system that shrinks the conversation when it overflows. But what happens when these systems themselves fail repeatedly?

Consider autocompact: it detects context overflow, calls the model to generate a summary, and replaces old messages with the summary. But what if the summarization call itself fails? `withRetry` kicks in. But what if every retry also fails? The agent is stuck in a loop:

```
Context overflow → try compact → compact fails → retry compact → fails again →
retry compact → fails again → ... (burning tokens on every failed attempt)
```

This is where the **circuit breaker** pattern comes in.

## The Circuit Breaker Pattern

Borrowed from electrical engineering: when current surges too high, a circuit breaker trips to prevent damage. In software: when an operation fails too many times in a row, stop attempting it.

```typescript
class CircuitBreaker {
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private readonly threshold: number,
    private readonly resetTimeMs: number
  ) {}

  canAttempt(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      // Check if enough time has passed to try again
      if (Date.now() - this.lastFailureTime > this.resetTimeMs) {
        this.state = "half-open";
        return true; // Allow one test attempt
      }
      return false;
    }

    // half-open: one attempt is in progress
    return false;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= this.threshold) {
      this.state = "open";
    }
  }

  getState(): { state: string; failures: number; threshold: number } {
    return {
      state: this.state,
      failures: this.consecutiveFailures,
      threshold: this.threshold,
    };
  }
}
```

## Three States

The circuit breaker has three states:

```
  ┌──────────────────────────────────────────────────┐
  │                                                    │
  │   CLOSED ──(failures >= threshold)──► OPEN         │
  │     ▲                                   │          │
  │     │                                   │          │
  │   success                          (timeout)       │
  │     │                                   │          │
  │   HALF-OPEN ◄──────────────────────────┘           │
  │     │                                              │
  │     └──(failure)──► OPEN                           │
  │                                                    │
  └──────────────────────────────────────────────────┘
```

**Closed:** Normal operation. Attempts proceed. Failures increment the counter. When the counter hits the threshold, the breaker trips open.

**Open:** All attempts are blocked immediately without trying. After a cooldown period, transitions to half-open.

**Half-Open:** Allows one test attempt. If it succeeds, the breaker resets to closed. If it fails, the breaker goes back to open.

## The Autocompact Circuit Breaker

The most important circuit breaker in Claude Code protects the autocompact system:

```typescript
const AUTOCOMPACT_FAILURE_THRESHOLD = 3;
const AUTOCOMPACT_RESET_TIME_MS = 60_000; // 1 minute

const autocompactBreaker = new CircuitBreaker(
  AUTOCOMPACT_FAILURE_THRESHOLD,
  AUTOCOMPACT_RESET_TIME_MS
);

async function autocompactIfNeeded(
  messages: Message[],
  config: ModelConfig
): Promise<CompactResult | null> {
  const currentTokens = estimateTokens(messages);

  // Don't compact if under threshold
  if (currentTokens < config.compactThreshold) return null;

  // Check circuit breaker
  if (!autocompactBreaker.canAttempt()) {
    console.log(
      "Autocompact circuit breaker is open — skipping compaction. " +
      `(${autocompactBreaker.getState().failures} consecutive failures)`
    );
    return null;
  }

  try {
    const result = await performCompaction(messages, config);
    autocompactBreaker.recordSuccess(); // Reset on success
    return result;
  } catch (error) {
    autocompactBreaker.recordFailure(); // Increment failure count
    console.error("Autocompact failed:", error.message);
    return null;
  }
}
```

Why does autocompact need a circuit breaker? Because:

1. **Each compaction attempt costs tokens.** The summarization call uses the model, which costs money and time.
2. **Repeated failures indicate a systemic problem.** If compaction fails three times, something is fundamentally wrong — the model can't generate a good summary, the context is corrupted, or the API is down.
3. **Retrying indefinitely wastes resources.** Without the breaker, the agent would burn tokens on failed compaction attempts instead of doing useful work.

## Self-Healing on Success

The most elegant part of the circuit breaker pattern: it self-heals. When the breaker is in half-open state and an attempt succeeds, it resets completely:

```typescript
class SelfHealingCircuitBreaker extends CircuitBreaker {
  recordSuccess(): void {
    super.recordSuccess();
    // Log the recovery
    console.log(
      `Circuit breaker recovered after ${this.getState().failures} failures`
    );
  }
}
```

This means the circuit breaker is conservative (stops after a few failures) but optimistic (tries again after a cooldown and fully recovers on success).

## The General Pattern

The circuit breaker pattern works for any subsystem that can fail repeatedly:

```typescript
async function withCircuitBreaker<T>(
  breaker: CircuitBreaker,
  operation: () => Promise<T>,
  fallback?: () => T
): Promise<T | null> {
  if (!breaker.canAttempt()) {
    if (fallback) return fallback();
    return null;
  }

  try {
    const result = await operation();
    breaker.recordSuccess();
    return result;
  } catch (error) {
    breaker.recordFailure();
    if (fallback) return fallback();
    throw error;
  }
}
```

Usage across different subsystems:

```typescript
// Circuit breaker for MCP tool calls
const mcpBreaker = new CircuitBreaker(5, 30_000);
const mcpResult = await withCircuitBreaker(
  mcpBreaker,
  () => callMCPTool(server, tool, input),
  () => ({ error: "MCP server unavailable, trying alternative approach" })
);

// Circuit breaker for bash classifier
const classifierBreaker = new CircuitBreaker(3, 15_000);
const classification = await withCircuitBreaker(
  classifierBreaker,
  () => classifyBashCommand(command),
  () => ({ classification: "unknown", confidence: 0 })
);

// Circuit breaker for model API (per-model)
const modelBreakers = new Map<string, CircuitBreaker>();

function getModelBreaker(model: string): CircuitBreaker {
  if (!modelBreakers.has(model)) {
    modelBreakers.set(model, new CircuitBreaker(5, 60_000));
  }
  return modelBreakers.get(model)!;
}
```

## Circuit Breaker vs Retry

Circuit breakers and retries are complementary, not competing:

```
Request fails
    │
    ▼
withRetry (attempt 1, 2, 3... up to max)
    │
    ├─ Success → done
    │
    └─ All retries exhausted → failure
         │
         ▼
    Circuit breaker records failure
         │
         ├─ Under threshold → allow next request to try
         │
         └─ Over threshold → OPEN
              │
              ▼
         Block all attempts for cooldown period
              │
              ▼
         After cooldown → HALF-OPEN → allow one test
              │
              ├─ Test succeeds → CLOSED (normal operation)
              │
              └─ Test fails → OPEN (wait again)
```

Retries handle transient failures (one request might fail but the next succeeds). Circuit breakers handle systemic failures (the service is down and retrying won't help).

```typescript
async function callWithRetryAndBreaker<T>(
  breaker: CircuitBreaker,
  operation: () => Promise<T>,
  retryOptions: RetryOptions
): Promise<T> {
  // Circuit breaker check happens BEFORE retries
  if (!breaker.canAttempt()) {
    throw new CircuitBreakerOpenError(breaker.getState());
  }

  try {
    // Retries happen within the circuit breaker's scope
    const result = await withRetrySync(operation, retryOptions);
    breaker.recordSuccess();
    return result;
  } catch (error) {
    breaker.recordFailure();
    throw error;
  }
}

class CircuitBreakerOpenError extends Error {
  constructor(public readonly state: CircuitBreakerState) {
    super(
      `Circuit breaker is open after ${state.failures} consecutive failures. ` +
      `Next attempt allowed in ${state.resetTimeMs / 1000}s.`
    );
  }
}
```

## Monitoring Circuit Breaker State

In production, you want visibility into circuit breaker state:

```typescript
interface CircuitBreakerMetrics {
  name: string;
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  tripCount: number; // How many times it's tripped open
}

class MonitoredCircuitBreaker extends CircuitBreaker {
  private totalFailures = 0;
  private totalSuccesses = 0;
  private lastSuccessTime: number | null = null;
  private tripCount = 0;

  constructor(
    private readonly name: string,
    threshold: number,
    resetTimeMs: number
  ) {
    super(threshold, resetTimeMs);
  }

  recordFailure(): void {
    this.totalFailures++;
    const wasOpen = this.getState().state === "open";
    super.recordFailure();
    if (!wasOpen && this.getState().state === "open") {
      this.tripCount++;
      console.warn(
        `Circuit breaker "${this.name}" tripped open ` +
        `(trip #${this.tripCount}, ${this.totalFailures} total failures)`
      );
    }
  }

  recordSuccess(): void {
    this.totalSuccesses++;
    this.lastSuccessTime = Date.now();
    super.recordSuccess();
  }

  getMetrics(): CircuitBreakerMetrics {
    const state = this.getState();
    return {
      name: this.name,
      state: state.state as "closed" | "open" | "half-open",
      consecutiveFailures: state.failures,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      tripCount: this.tripCount,
    };
  }
}
```

## Module 10 Summary

Over these seven lessons, you've built a complete understanding of how an AI coding agent handles errors:

1. **Error philosophy** — errors are normal, visible, structured, and recoverable
2. **withRetry** — exponential backoff with jitter for transient failures
3. **Max output token recovery** — escalation and continuation for truncated responses
4. **Context overflow recovery** — three-stage cascade from collapse to compact to terminal
5. **Streaming errors** — mid-stream fallback, orphaned tool results, error withholding
6. **Abort system** — parent-child signal hierarchy, graceful shutdown at every level
7. **Circuit breakers** — preventing infinite retry loops on systemic failures

Together, these systems make the agent resilient against the messy reality of distributed systems, network failures, model limitations, and user interruptions. An agent without these systems works in demos. An agent with them works in production.

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Full Circuit Breaker
**Challenge:** Implement the complete `CircuitBreaker` class with all three states (closed, open, half-open) and proper transitions. Write tests that verify: closed → open (threshold exceeded), open → half-open (timeout elapsed), half-open → closed (success), and half-open → open (failure).

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-92.md#exercise-1)

### Exercise 2 — Circuit Breaker Registry
**Challenge:** Build a `CircuitBreakerRegistry` that manages named circuit breakers. It should support: creating/retrieving breakers by name, exposing aggregated metrics across all breakers, resetting individual breakers, and listing all breakers in open state for alerting.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-92.md#exercise-2)

### Exercise 3 — Sliding Window Breaker
**Challenge:** Implement a `SlidingWindowCircuitBreaker` that counts failures within the last N seconds rather than consecutive failures. This handles intermittent failures better. The window should automatically evict old entries, and the breaker should trip when the failure count within the window exceeds the threshold.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-92.md#exercise-3)

### Exercise 4 — Retry + Circuit Breaker Integration
**Challenge:** Implement `callWithRetryAndBreaker()` that combines `withRetry` and a `CircuitBreaker`. Create a test scenario: a service goes down, retries attempt and exhaust, the breaker trips open, subsequent calls fail fast, then after cooldown the half-open test succeeds and normal operation resumes.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-92.md#exercise-4)

### Exercise 5 — Full Error Handling Trace
**Question:** Trace a single API call through all seven error handling systems from this module. Starting from "agent calls the model API," describe what happens at each stage when: the first call gets a 429, the retry succeeds but the response is truncated, the continuation pushes context over the limit, and compaction triggers. Identify each system that activates and how they hand off to each other.

[View Answer](../../answers/10-error-handling/answer-92.md#exercise-5)
