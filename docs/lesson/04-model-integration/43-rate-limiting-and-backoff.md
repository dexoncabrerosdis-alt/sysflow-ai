# Lesson 43: Rate Limiting and Backoff

## What You'll Learn

The retry system from the previous lesson handles generic errors. But rate limiting
requires specific strategies — the API tells you *when* to come back via headers,
and different HTTP status codes mean different things. In this lesson, you'll learn
how Claude Code handles 429 (rate limited) and 529 (overloaded) responses, plus
specialized retry modes for background agents and fast-mode users.

## Two Kinds of "Slow Down"

The Anthropic API uses two status codes to tell you to back off:

| Code | Meaning | Your Fault? | Recovery Strategy |
|---|---|---|---|
| **429** | Rate limited | Yes — you're sending too many requests | Wait for `retry-after`, then retry |
| **529** | Overloaded | No — the server is under heavy load | Retry with backoff, maybe switch models |

This distinction matters because the appropriate response is different for each.

## Handling 429: Rate Limited

A 429 response means you've exceeded your per-minute or per-day request quota. The
response includes a `retry-after` header telling you exactly how long to wait:

```typescript
function handle429(error: Anthropic.APIError): number {
  const retryAfter = error.headers?.["retry-after"];

  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    // retry-after can also be an HTTP date
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      return Math.max(0, date.getTime() - Date.now());
    }
  }

  // No header — use default backoff
  return 60_000; // 1 minute is a safe default for rate limits
}
```

The `retry-after` header is the authority. If it says wait 30 seconds, wait 30
seconds. Don't try to be clever and retry sooner — you'll just get another 429.

Integrating this into the retry delay:

```typescript
function getRetryDelay(attempt: number, error?: Error): number {
  if (error instanceof Anthropic.APIError && error.status === 429) {
    return handle429(error);
  }

  if (error instanceof Anthropic.APIError && error.status === 529) {
    return handle529(attempt, error);
  }

  // Default exponential backoff for other errors
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const capped = Math.min(exponential, MAX_DELAY_MS);
  const jitter = capped * 0.25 * (Math.random() * 2 - 1);
  return Math.round(capped + jitter);
}
```

## Handling 529: Overloaded

A 529 means the server is too busy to handle your request right now. Unlike 429,
this isn't about your quota — it's about overall system load. The key difference:
consecutive 529s might mean the model is genuinely unavailable for an extended
period.

```typescript
let consecutive529Count = 0;
const MAX_CONSECUTIVE_529 = 3;

function handle529(attempt: number, error: Anthropic.APIError): number {
  consecutive529Count++;

  if (consecutive529Count >= MAX_CONSECUTIVE_529) {
    // Three in a row — this model is probably down
    throw new FallbackTriggeredError(
      currentModel,
      consecutive529Count
    );
  }

  // Aggressive backoff for overloaded servers
  const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt + 1), MAX_DELAY_MS);
  const jitter = delay * 0.5 * Math.random();
  return Math.round(delay + jitter);
}

function resetOn200() {
  consecutive529Count = 0;
}
```

The consecutive counter is the critical piece. A single 529 is normal — the server
had a brief spike. Three in a row means the model is overwhelmed, and you should
switch to a fallback model instead of continuing to pile on.

## The Interaction Between 429 and 529

Here's how a realistic failure sequence might play out:

```
Call 1 → 200 OK        (consecutive529 = 0)
Call 2 → 529 Overloaded (consecutive529 = 1, backoff 2s)
Call 3 → 200 OK        (consecutive529 = 0, reset)
Call 4 → 429 Rate Limited (wait retry-after: 30s)
Call 5 → 200 OK
Call 6 → 529 Overloaded (consecutive529 = 1, backoff 2s)
Call 7 → 529 Overloaded (consecutive529 = 2, backoff 4s)
Call 8 → 529 Overloaded (consecutive529 = 3, FALLBACK!)
```

The 429 at call 4 doesn't increment the 529 counter. The 200 at call 3 resets it.
Only consecutive 529s count.

## Persistent Retry Mode for Background Agents

When Claude Code runs as a background agent (e.g., in CI/CD or batch processing),
there's no human watching. The `UNATTENDED_RETRY` mode changes the retry behavior:

```typescript
interface RetryConfig {
  maxRetries: number;
  maxDelayMs: number;
  shouldFallback: boolean;
}

function getRetryConfig(mode: "interactive" | "unattended"): RetryConfig {
  if (mode === "unattended") {
    return {
      maxRetries: Infinity,
      maxDelayMs: 120_000,  // Cap at 2 minutes between retries
      shouldFallback: false, // Don't switch models, just keep waiting
    };
  }

  return {
    maxRetries: 10,
    maxDelayMs: 32_000,
    shouldFallback: true,
  };
}
```

In unattended mode:

- **Unlimited retries** — the agent waits as long as it takes
- **Higher delay cap** — up to 2 minutes between attempts (servers need time to recover)
- **No fallback** — the user configured a specific model for a reason; don't switch

This makes sense for overnight batch jobs. You'd rather wait 10 minutes for the
model to become available than switch to a less capable model.

The retry loop adapts:

```typescript
async function* withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: RetryOptions = {}
): AsyncGenerator<T | SystemAPIErrorMessage> {
  const config = getRetryConfig(options.mode ?? "interactive");
  const maxRetries = options.maxRetries ?? config.maxRetries;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn(new AbortController().signal);
      yield result;
      return;
    } catch (error) {
      if (!config.shouldFallback && error instanceof FallbackTriggeredError) {
        // In unattended mode, swallow the fallback and keep retrying
        yield {
          type: "system",
          level: "warning",
          message: `Model overloaded but fallback disabled. Continuing to retry...`,
        };
        continue;
      }

      if (attempt === maxRetries) throw error;

      const delay = Math.min(
        getRetryDelay(attempt, error as Error),
        config.maxDelayMs
      );

      yield {
        type: "system",
        level: "error",
        message: `API error (attempt ${attempt + 1}): ${(error as Error).message}. Retrying in ${Math.round(delay / 1000)}s...`,
      };

      await sleep(delay);
    }
  }
}
```

## Fast Mode: Overage Detection and Cooldown

Claude Code's "fast mode" uses a higher-throughput tier that costs more. When the
user has exceeded their fast-mode budget, the system needs to detect this and
either fall back to the standard tier or cool down:

```typescript
interface UsageTracker {
  fastModeRequestsThisMinute: number;
  fastModeBudgetExhausted: boolean;
  cooldownUntil: number | null;
}

function shouldUseFastMode(tracker: UsageTracker): boolean {
  if (tracker.fastModeBudgetExhausted) {
    return false;
  }

  if (tracker.cooldownUntil && Date.now() < tracker.cooldownUntil) {
    return false;
  }

  return true;
}

function handleFastModeOverage(tracker: UsageTracker): void {
  tracker.fastModeBudgetExhausted = true;
  tracker.cooldownUntil = Date.now() + 60_000; // 1 minute cooldown
}
```

When the API returns a specific error indicating overage, the tracker disables fast
mode and sets a cooldown period. After the cooldown, it tries fast mode again.

## Error Classification Revisited

With rate-limit handling in place, the full classifier maps: network errors →
retry with backoff, 429 → retry with `retry-after`, 529 → retry or fallback based
on consecutive count, 400/401/403/404 → fatal, 500/502/503 → retry with backoff.
When in doubt, retry.

## Rate Limit Headers Worth Tracking

The API sends headers beyond `retry-after`: `anthropic-ratelimit-requests-remaining`,
`anthropic-ratelimit-tokens-remaining`, and their corresponding reset times.
Proactive agents could use these to throttle themselves *before* hitting 429 — if
`requestsRemaining` is 2, slow down instead of firing off 5 parallel calls.

## Key Takeaways

1. **429** = you're sending too much → respect `retry-after`, wait, retry
2. **529** = server is overloaded → exponential backoff, fallback after 3 consecutive
3. Unattended mode: unlimited retries, no fallback, higher delay cap (2 min)
4. Fast mode tracks overage and enters a cooldown period when budget is exhausted
5. Rate limit headers provide proactive information about remaining quota
6. The consecutive 529 counter resets on any successful response

## Next Lesson

When 529 errors trigger a fallback, what actually happens? The model switches, but
the conversation state needs careful surgery — orphaned tool_use blocks need
results, streaming executors need replacing, and the user needs to know. Next, you'll
study the fallback system in detail.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — 429 vs 529
**Question:** Compare HTTP 429 and 529 responses: what does each mean, whose fault is it, and what is the correct recovery strategy for each? Why does the system track consecutive 529 counts but not consecutive 429 counts?

[View Answer](../../answers/04-model-integration/answer-43.md#exercise-1)

### Exercise 2 — Parse retry-after Header
**Challenge:** Write a function `parseRetryAfter(headerValue: string): number` that handles both formats of the `retry-after` header: an integer (seconds) and an HTTP date string. Return the delay in milliseconds. If parsing fails, return a default of 60,000ms.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-43.md#exercise-2)

### Exercise 3 — Consecutive 529 Tracker
**Challenge:** Write a `OverloadTracker` class with methods `record529()`, `recordSuccess()`, and `shouldFallback(maxConsecutive: number): boolean`. The tracker counts consecutive 529 errors and resets on any success.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-43.md#exercise-3)

### Exercise 4 — Unattended vs Interactive Mode
**Question:** How does the retry behavior differ between interactive mode and unattended mode? List three specific differences and explain why each makes sense for background/CI agents.

[View Answer](../../answers/04-model-integration/answer-43.md#exercise-4)

### Exercise 5 — Failure Sequence Analysis
**Question:** Given this sequence of API responses: `200, 529, 200, 429, 200, 529, 529, 529` — trace the state of the consecutive 529 counter after each call and identify at which call the fallback triggers.

[View Answer](../../answers/04-model-integration/answer-43.md#exercise-5)
