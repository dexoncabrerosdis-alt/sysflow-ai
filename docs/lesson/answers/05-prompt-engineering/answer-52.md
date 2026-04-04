# Answers: Lesson 52 — Environment Context

## Exercise 1
**Question:** How would the model respond differently to "Run the tests" with different environment contexts?

**Answer:** With `CWD: /home/user/react-app, Platform: macOS`: The model recognizes a Node.js/React project by the directory name, expects a `package.json` with test scripts, and would call `Bash({ command: "npm test" })` or `Bash({ command: "yarn test" })`. On macOS, it knows BSD-flavored commands are available.

With `CWD: /home/user/django-api, Platform: Linux`: The model recognizes a Python/Django project, expects `pytest.ini` or `manage.py`, and would call `Bash({ command: "pytest" })` or `Bash({ command: "python manage.py test" })`. On Linux, it knows GNU tools and `apt` are available. Without any context, the model would guess (likely defaulting to `npm test` since JavaScript dominates its training data), which would fail on the Python project.

---

## Exercise 2
**Challenge:** Write a `computeSimpleEnvInfo()` function.

**Answer:**
```typescript
function computeSimpleEnvInfo(): string {
  const info: string[] = [];

  info.push(`Working directory: ${process.cwd()}`);

  const platformMap: Record<string, string> = {
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
  };
  info.push(`Platform: ${platformMap[process.platform] ?? process.platform}`);

  const shell = process.env.SHELL || process.env.COMSPEC || "unknown";
  info.push(`Shell: ${shell}`);

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  info.push(`Today's date: ${dateStr}`);

  return `## Environment\n\n${info.join("\n")}`;
}
```
**Explanation:** The function maps technical platform identifiers to human-readable names (the model understands "macOS" better than "darwin"). The shell environment variable differs between Unix (`SHELL`) and Windows (`COMSPEC`). The date is formatted in a human-readable style since the model processes natural language better than ISO timestamps.

---

## Exercise 3
**Challenge:** Write a `MemoizedCache` class with TTL-based expiration.

**Answer:**
```typescript
class MemoizedCache {
  private cache: Map<string, { value: string; timestamp: number }> =
    new Map();

  async get(
    key: string,
    producer: () => Promise<string>,
    ttlMs: number
  ): Promise<string> {
    const cached = this.cache.get(key);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < ttlMs) {
      return cached.value;
    }

    const value = await producer();
    this.cache.set(key, { value, timestamp: now });
    return value;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }
}

// Usage with different TTLs:
const cache = new MemoizedCache();

// Platform: cache forever (never changes in a session)
const platform = await cache.get("platform", getPlatformInfo, Infinity);

// Git status: cache for 5 seconds (changes with file operations)
const gitStatus = await cache.get("git_status", getGitStatus, 5000);

// CWD: no caching (can change every turn via `cd`)
const cwd = process.cwd(); // Always fresh, no cache
```
**Explanation:** The TTL reflects how often each piece of data actually changes. Platform and shell never change during a session (Infinity). Git status changes with user actions but not on every API call (5s TTL avoids running `git status --porcelain` repeatedly). CWD can change between any two turns, so it's never cached.

---

## Exercise 4
**Question:** Priority order for environment context fields when budget is exceeded.

**Answer:** From highest to lowest priority: (1) **Working directory** — Most critical. Without CWD, the model has no idea what project it's in, can't interpret relative paths, and can't choose appropriate tools or commands. (2) **Git branch** — Important for understanding what the user is working on (feature branch vs. main) and for generating appropriate commit messages. (3) **Platform** — Determines correct command syntax (GNU vs BSD tools, shell differences). Without it, the model defaults to Linux conventions which fail on macOS/Windows. (4) **Git status** — Useful for understanding uncommitted changes, but the model can always run `git status` itself if needed. (5) **Recent commits** — Nice context for commit style and recent history, but least essential — the model can query git log via a tool if needed. The principle: prioritize information the model cannot easily obtain itself through tool calls over information it can.
