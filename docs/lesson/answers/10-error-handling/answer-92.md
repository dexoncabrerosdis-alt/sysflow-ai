# Answers: Lesson 92 — Circuit Breakers

## Exercise 1
**Challenge:** Implement the full `CircuitBreaker` with all state transitions.

**Answer:**
```typescript
type CircuitState = "closed" | "open" | "half-open";

class CircuitBreaker {
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private state: CircuitState = "closed";

  constructor(
    private readonly threshold: number,
    private readonly resetTimeMs: number
  ) {}

  canAttempt(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.resetTimeMs) {
        this.state = "half-open";
        return true;
      }
      return false;
    }

    // half-open allows exactly one test attempt
    return false;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      this.state = "open"; // half-open failure → back to open
    } else if (this.consecutiveFailures >= this.threshold) {
      this.state = "open"; // threshold exceeded → trip open
    }
  }

  getState(): { state: CircuitState; failures: number } {
    return { state: this.state, failures: this.consecutiveFailures };
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.state = "closed";
  }
}

// Tests
function testCircuitBreaker() {
  // Test: closed → open
  const cb = new CircuitBreaker(3, 1000);
  console.assert(cb.canAttempt() === true, "Should start closed");
  cb.recordFailure();
  cb.recordFailure();
  console.assert(cb.getState().state === "closed", "Still closed at 2 failures");
  cb.recordFailure();
  console.assert(cb.getState().state === "open", "Should be open at 3 failures");
  console.assert(cb.canAttempt() === false, "Should block in open state");

  // Test: open → half-open (simulate timeout)
  const cb2 = new CircuitBreaker(2, 50);
  cb2.recordFailure();
  cb2.recordFailure();
  console.assert(cb2.getState().state === "open");

  setTimeout(() => {
    console.assert(cb2.canAttempt() === true, "Should allow after timeout");
    console.assert(cb2.getState().state === "half-open");

    // Test: half-open → closed (success)
    cb2.recordSuccess();
    console.assert(cb2.getState().state === "closed");
    console.assert(cb2.getState().failures === 0);

    // Test: half-open → open (failure)
    const cb3 = new CircuitBreaker(2, 50);
    cb3.recordFailure();
    cb3.recordFailure();
    setTimeout(() => {
      cb3.canAttempt(); // transitions to half-open
      cb3.recordFailure();
      console.assert(cb3.getState().state === "open", "Should go back to open");
      console.log("All circuit breaker tests passed.");
    }, 60);
  }, 60);
}
```

**Explanation:** The state machine handles four transitions: closed→open (failures hit threshold), open→half-open (timeout elapsed on `canAttempt()`), half-open→closed (success), and half-open→open (failure). The `canAttempt()` method both checks and transitions the state, which is the standard circuit breaker pattern.

---

## Exercise 2
**Challenge:** Build a `CircuitBreakerRegistry`.

**Answer:**
```typescript
interface BreakerConfig {
  threshold: number;
  resetTimeMs: number;
}

interface RegistryMetrics {
  totalBreakers: number;
  openBreakers: string[];
  closedBreakers: string[];
  halfOpenBreakers: string[];
  totalFailures: number;
}

class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private configs = new Map<string, BreakerConfig>();

  getOrCreate(name: string, config?: BreakerConfig): CircuitBreaker {
    if (!this.breakers.has(name)) {
      const cfg = config ?? { threshold: 5, resetTimeMs: 60_000 };
      this.breakers.set(name, new CircuitBreaker(cfg.threshold, cfg.resetTimeMs));
      this.configs.set(name, cfg);
    }
    return this.breakers.get(name)!;
  }

  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  reset(name: string): boolean {
    const breaker = this.breakers.get(name);
    if (breaker) {
      breaker.reset();
      return true;
    }
    return false;
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  getOpenBreakers(): string[] {
    return [...this.breakers.entries()]
      .filter(([_, b]) => b.getState().state === "open")
      .map(([name]) => name);
  }

  getMetrics(): RegistryMetrics {
    const open: string[] = [];
    const closed: string[] = [];
    const halfOpen: string[] = [];
    let totalFailures = 0;

    for (const [name, breaker] of this.breakers) {
      const state = breaker.getState();
      totalFailures += state.failures;
      switch (state.state) {
        case "open": open.push(name); break;
        case "closed": closed.push(name); break;
        case "half-open": halfOpen.push(name); break;
      }
    }

    return {
      totalBreakers: this.breakers.size,
      openBreakers: open,
      closedBreakers: closed,
      halfOpenBreakers: halfOpen,
      totalFailures,
    };
  }
}
```

**Explanation:** The registry provides a central point for managing all circuit breakers. `getOrCreate` uses lazy initialization with configurable defaults. `getOpenBreakers()` enables alerting on systemic failures. `getMetrics()` gives a dashboard-ready overview of all breaker states.

---

## Exercise 3
**Challenge:** Implement `SlidingWindowCircuitBreaker`.

**Answer:**
```typescript
class SlidingWindowCircuitBreaker {
  private failures: number[] = []; // timestamps of failures
  private state: CircuitState = "closed";
  private lastStateChange = 0;

  constructor(
    private readonly threshold: number,
    private readonly windowMs: number,
    private readonly resetTimeMs: number
  ) {}

  private evictOld(): void {
    const cutoff = Date.now() - this.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
  }

  canAttempt(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      if (Date.now() - this.lastStateChange >= this.resetTimeMs) {
        this.state = "half-open";
        this.lastStateChange = Date.now();
        return true;
      }
      return false;
    }

    return false; // half-open: one attempt already in progress
  }

  recordSuccess(): void {
    this.state = "closed";
    this.lastStateChange = Date.now();
  }

  recordFailure(): void {
    this.failures.push(Date.now());
    this.evictOld();

    if (this.state === "half-open") {
      this.state = "open";
      this.lastStateChange = Date.now();
      return;
    }

    if (this.failures.length >= this.threshold) {
      this.state = "open";
      this.lastStateChange = Date.now();
    }
  }

  getFailureCount(): number {
    this.evictOld();
    return this.failures.length;
  }

  getState(): { state: CircuitState; recentFailures: number; windowMs: number } {
    this.evictOld();
    return {
      state: this.state,
      recentFailures: this.failures.length,
      windowMs: this.windowMs,
    };
  }
}
```

**Explanation:** Instead of counting consecutive failures, the sliding window tracks failure timestamps and evicts entries older than the window. This means 3 failures spread across 60 seconds (with successes in between) can still trip the breaker — catching intermittent failures that consecutive counting would miss. The window auto-cleans on every operation.

---

## Exercise 4
**Challenge:** Integrate retry and circuit breaker together.

**Answer:**
```typescript
class CircuitBreakerOpenError extends Error {
  constructor(public readonly breakerState: { state: CircuitState; failures: number }) {
    super(`Circuit breaker is open after ${breakerState.failures} failures`);
  }
}

async function callWithRetryAndBreaker<T>(
  breaker: CircuitBreaker,
  operation: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  if (!breaker.canAttempt()) {
    throw new CircuitBreakerOpenError(breaker.getState());
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      breaker.recordSuccess();
      return result;
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
    }
  }

  breaker.recordFailure();
  throw lastError!;
}

// Test scenario
async function testRetryAndBreaker() {
  const breaker = new CircuitBreaker(2, 200);
  let serviceUp = false;
  let callCount = 0;

  const callService = async (): Promise<string> => {
    callCount++;
    if (!serviceUp) throw new Error("Service down");
    return "ok";
  };

  // Phase 1: service is down, retries exhaust, breaker records failure
  try { await callWithRetryAndBreaker(breaker, callService, 2); } catch {}
  console.assert(breaker.getState().failures === 1);

  // Phase 2: second failure trips the breaker
  try { await callWithRetryAndBreaker(breaker, callService, 2); } catch {}
  console.assert(breaker.getState().state === "open");

  // Phase 3: breaker is open, calls fail fast
  try {
    await callWithRetryAndBreaker(breaker, callService, 2);
  } catch (e) {
    console.assert(e instanceof CircuitBreakerOpenError, "Should fail fast");
  }

  // Phase 4: after cooldown, half-open test succeeds
  serviceUp = true;
  await new Promise((r) => setTimeout(r, 250));
  const result = await callWithRetryAndBreaker(breaker, callService, 2);
  console.assert(result === "ok");
  console.assert(breaker.getState().state === "closed");

  console.log("Retry + breaker integration test passed.");
}
```

**Explanation:** The breaker check happens BEFORE retries begin — if the breaker is open, the call fails fast without any retry attempts. When all retries exhaust, `recordFailure()` increments the breaker's counter. This prevents burning retry budgets on a service that's clearly down.

---

## Exercise 5
**Question:** Trace a single API call through all seven error handling systems.

**Answer:**
1. **Error Philosophy (Lesson 86):** The agent initiates an API call. The error philosophy dictates that this call goes through recovery infrastructure rather than a bare try/catch.

2. **withRetry (Lesson 87):** The call is wrapped in `withRetry`. The first attempt returns HTTP 429 (rate limited). `withRetry` classifies this as retryable, yields a status message ("Retrying in 2s..."), sleeps with backoff, and tries again. The second attempt succeeds.

3. **Max Output Token Recovery (Lesson 88):** The response comes back with `stop_reason: "max_tokens"` — it's truncated. The recovery system withholds the error from the user, escalates `max_tokens` from 4096 to 16384, and retries. Still truncated. It sends a continuation prompt, and the model finishes its response. The continuation is stitched onto the original.

4. **Context Overflow Recovery (Lesson 89):** The continuation prompt plus the stitched response push the conversation past the context limit. The next API call fails with a 413. Stage 1 (context collapse) removes 5 old tool call pairs. Still too large. Stage 2 (reactive compaction) summarizes the oldest 30 messages into a 200-token summary. Context is now at 60% capacity.

5. **Streaming Errors (Lesson 90):** The compacted request streams successfully — no streaming error occurs this time. But the infrastructure is ready: if the stream had died mid-response, synthetic tool results would have been created for any orphaned tool_use blocks.

6. **Abort System (Lesson 91):** Throughout this entire sequence, every operation is connected to the session's abort hierarchy. If the user pressed Ctrl+C at any point — during retry sleep, during continuation, during compaction — the abort signal would cascade and cleanly terminate everything.

7. **Circuit Breaker (Lesson 92):** The autocompact circuit breaker records the successful compaction (Stage 2 succeeded). If compaction had failed three times in a row, the breaker would trip open and prevent further compaction attempts for 60 seconds, avoiding a token-burning loop.

The key insight is that these systems are layered, not sequential — multiple systems can be active simultaneously for a single logical operation, each handling its specific failure mode.
