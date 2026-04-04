# Answers: Lesson 30 — Streaming Tool Execution

## Exercise 1
**Question:** What latency problem does `StreamingToolExecutor` solve? Draw a timeline comparison.

**Answer:** Without streaming execution, the runtime waits for the model to finish its *entire* response before starting any tool execution. If the model emits a Read tool call at second 2 of a 5-second response, 3 seconds are wasted — the tool could have been running during the remaining generation time.

**Without streaming execution:**
```
Model generates: ████████████████████ (5 seconds)
                                     ↓ tools start here
Tool execution:                      ████████ (3 seconds)
Total wall time:                              8 seconds
```

**With streaming execution:**
```
Model generates: ████████████████████ (5 seconds)
                    ↑ tool_use detected at second 2
Tool execution:     ████████ (3 seconds, overlapped)
Total wall time:                     ██ 6 seconds (saved 2 seconds)
```

`StreamingToolExecutor` starts executing tools as soon as their complete `tool_use` block streams in. This overlaps generation and execution, reducing total wall time. The savings depend on how early in the stream tool calls appear — earlier tools benefit more from overlap.

---

## Exercise 2
**Challenge:** Implement `canExecuteTool()`.

**Answer:**

```typescript
type QueueEntry = {
  block: { id: string; name: string; input: unknown };
  started: boolean;
  result: ToolResult | null;
};

class StreamingToolExecutor {
  private tools: Map<string, Tool>;
  private queue: QueueEntry[];
  private aborted: boolean;

  canExecuteTool(block: { name: string; input: unknown }): boolean {
    const tool = this.tools.get(block.name);

    // Unknown tools execute immediately (they'll error during execution)
    if (!tool) {
      return true;
    }

    // Concurrency-safe tools can always start immediately
    if (isConcurrencySafeForInput(tool, block.input)) {
      return true;
    }

    // Unsafe tools can only start if NO other tools are currently running
    const anyRunning = this.queue.some(
      (entry) => entry.started && entry.result === null
    );
    return !anyRunning;
  }
}
```

**Explanation:** Three cases: (1) Unknown tools are let through — they'll fail with a "tool not found" error during execution, but there's no reason to block them. (2) Safe tools start immediately regardless of what else is running. (3) Unsafe tools check if any queue entry is both started (`started === true`) and not yet finished (`result === null`). If anything is running, the unsafe tool waits. After a running tool completes and calls `processQueue()`, the unsafe tool will be re-evaluated and can start.

---

## Exercise 3
**Challenge:** Implement `getCompletedResults()`.

**Answer:**

```typescript
type ToolResult = {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

type QueueEntry = {
  block: { id: string; name: string; input: unknown };
  promise: Promise<ToolResult> | null;
  result: ToolResult | null;
  started: boolean;
};

class StreamingToolExecutor {
  private queue: QueueEntry[] = [];

  getCompletedResults(): ToolResult[] {
    const results: ToolResult[] = [];

    // Drain from the FRONT of the queue — only while results are available
    while (this.queue.length > 0 && this.queue[0].result !== null) {
      results.push(this.queue[0].result!);
      this.queue.shift();
    }

    return results;
  }
}

// Example queue states:

// State: [done, done, running, done]
// getCompletedResults() → returns [result₁, result₂], queue becomes [running, done]
// (result₃ is done but blocked by the running entry ahead of it)

// State: [running, done, done, done]
// getCompletedResults() → returns [], queue unchanged
// (nothing can drain because the first entry isn't done)

// State: [done, done, done]
// getCompletedResults() → returns [result₁, result₂, result₃], queue becomes []
```

**Explanation:** The critical invariant is that results are yielded **in order**. The `while` loop drains entries from the front of the queue only as long as each front entry has a result. If the front entry is still running, no results are yielded — even if later entries are done. This preserves the ordering contract: the model receives results in the same order it requested tools. The `shift()` call removes yielded entries from the queue permanently.

---

## Exercise 4
**Question:** What is "sibling abort," when does it trigger, and why is it specifically tied to Bash errors?

**Answer:** Sibling abort is a mechanism where a failed tool cancels all other un-started tools in the same queue. When it triggers, every queue entry that hasn't started yet gets an immediate error result (`"Aborted: sibling tool failed"`) and the executor's `aborted` flag is set to `true`, preventing any new tools from starting.

It's specifically tied to Bash errors because shell commands can fundamentally change the environment in ways that invalidate subsequent operations. For example, if the model emits: `Bash("npm install")`, then `Bash("npm test")`, then `Bash("npm run build")` — and `npm install` fails with a dependency resolution error — there's no point running `npm test` or `npm run build`. They will certainly fail too, and running them wastes time, produces confusing cascading errors, and clutters the model's context with noise.

Other tool types (Read, Grep, Glob) don't trigger sibling abort because their failures are self-contained. A file-not-found error from Read doesn't mean Grep will fail — they're independent operations. But Bash commands often have sequential dependencies (install → test → build) where an early failure invalidates the entire chain.
