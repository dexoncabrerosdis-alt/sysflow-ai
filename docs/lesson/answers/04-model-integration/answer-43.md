# Answers: Lesson 43 — Rate Limiting and Backoff

## Exercise 1
**Question:** Compare HTTP 429 and 529 responses from the Anthropic API.

**Answer:** **429 (Rate Limited):** This is your fault — you're sending too many requests for your quota. The recovery strategy is to respect the `retry-after` header, which tells you exactly how long to wait. The response includes `retry-after` (seconds or HTTP date), plus headers like `anthropic-ratelimit-requests-remaining` for proactive throttling. **529 (Overloaded):** This is not your fault — the server is under heavy load. The recovery strategy is exponential backoff, and if you receive 3 consecutive 529s, switch to a fallback model. There's no `retry-after` header because the server doesn't know when load will drop. The key difference: 429 has a predictable recovery time; 529 is unpredictable and may require a model switch.

---

## Exercise 2
**Challenge:** Write a function `parseRetryAfter(header: string): number` that parses the `retry-after` header into milliseconds.

**Answer:**
```typescript
function parseRetryAfter(header: string): number {
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }

  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }

  return 60_000;
}
```
**Explanation:** The `retry-after` header can be either an integer (seconds to wait) or an HTTP date (the time when you can retry). We try parsing as an integer first since it's more common. If that fails, we try parsing as a date and calculate the milliseconds until that time. The 60-second default is a safe fallback for rate limiting — it's long enough to let most quotas reset.

---

## Exercise 3
**Challenge:** Write a class `OverloadTracker` that counts consecutive 529 errors and triggers fallback after a threshold.

**Answer:**
```typescript
class OverloadTracker {
  private consecutiveCount: number = 0;
  private threshold: number;

  constructor(threshold: number = 3) {
    this.threshold = threshold;
  }

  recordOverload(): void {
    this.consecutiveCount++;
  }

  recordSuccess(): void {
    this.consecutiveCount = 0;
  }

  shouldFallback(): boolean {
    return this.consecutiveCount >= this.threshold;
  }

  getConsecutiveCount(): number {
    return this.consecutiveCount;
  }

  reset(): void {
    this.consecutiveCount = 0;
  }
}
```
**Explanation:** The tracker maintains a simple counter. Each 529 increments it; any success resets it to zero. When the counter reaches the threshold (default 3), `shouldFallback()` returns true, signaling that the model is likely down and the system should switch to a fallback. The reset on success is critical — a single 529 followed by a success is normal load variation, not an outage.

---

## Exercise 4
**Question:** How do retry configurations differ between interactive and unattended modes? List three differences.

**Answer:** (1) **Max retries** — Interactive mode uses 10 retries (user shouldn't wait indefinitely), while unattended mode uses unlimited retries (background jobs should keep trying until they succeed). (2) **Max delay cap** — Interactive mode caps delays at 32 seconds (user is watching), while unattended mode caps at 120 seconds (2 minutes), giving servers more time to recover. (3) **Fallback behavior** — Interactive mode enables fallback to alternate models (faster recovery for the user), while unattended mode disables fallback (the user configured a specific model for a reason — e.g., needing Opus for complex reasoning — and would rather wait than get a less capable result).

---

## Exercise 5
**Challenge:** Write a `FastModeTracker` class with budget tracking and cooldown.

**Answer:**
```typescript
class FastModeTracker {
  private budgetExhausted: boolean = false;
  private cooldownUntil: number | null = null;
  private cooldownMs: number;

  constructor(cooldownMs: number = 60_000) {
    this.cooldownMs = cooldownMs;
  }

  shouldUseFastMode(): boolean {
    if (this.budgetExhausted) {
      if (this.cooldownUntil && Date.now() >= this.cooldownUntil) {
        this.budgetExhausted = false;
        this.cooldownUntil = null;
        return true;
      }
      return false;
    }
    return true;
  }

  recordOverage(): void {
    this.budgetExhausted = true;
    this.cooldownUntil = Date.now() + this.cooldownMs;
  }

  getCooldownRemaining(): number {
    if (!this.cooldownUntil) return 0;
    return Math.max(0, this.cooldownUntil - Date.now());
  }
}
```
**Explanation:** When `recordOverage()` is called (the API signaled budget exhaustion), fast mode is disabled and a cooldown timer starts. `shouldUseFastMode()` checks both the exhaustion flag and whether the cooldown has elapsed. After the cooldown, fast mode automatically re-enables. This creates a self-healing cycle — try fast mode, back off when exhausted, try again after cooldown.
