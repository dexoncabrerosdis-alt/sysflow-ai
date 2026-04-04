# Answers: Lesson 91 — The Abort System

## Exercise 1
**Challenge:** Implement `createChildAbortController()` with parent-to-child cascade and cleanup.

**Answer:**
```typescript
function createChildAbortController(
  parentSignal: AbortSignal,
  reason?: string
): { controller: AbortController; cleanup: () => void } {
  const child = new AbortController();

  if (parentSignal.aborted) {
    child.abort(parentSignal.reason || reason);
    return { controller: child, cleanup: () => {} };
  }

  const onParentAbort = () => {
    child.abort(parentSignal.reason || reason);
  };

  parentSignal.addEventListener("abort", onParentAbort, { once: true });

  const cleanup = () => {
    parentSignal.removeEventListener("abort", onParentAbort);
  };

  return { controller: child, cleanup };
}

// Tests
function testAbortHierarchy() {
  // Test 1: parent abort cascades to child
  const parent = new AbortController();
  const { controller: child1, cleanup: c1 } = createChildAbortController(parent.signal);

  console.assert(!child1.signal.aborted, "Child should not be aborted initially");
  parent.abort("test_reason");
  console.assert(child1.signal.aborted, "Child should be aborted after parent aborts");
  console.assert(child1.signal.reason === "test_reason", "Reason should propagate");
  c1();

  // Test 2: child abort does NOT affect parent
  const parent2 = new AbortController();
  const { controller: child2, cleanup: c2 } = createChildAbortController(parent2.signal);

  child2.abort("child_reason");
  console.assert(child2.signal.aborted, "Child should be aborted");
  console.assert(!parent2.signal.aborted, "Parent should NOT be aborted by child");
  c2();

  // Test 3: sibling isolation
  const parent3 = new AbortController();
  const { controller: siblingA, cleanup: cA } = createChildAbortController(parent3.signal);
  const { controller: siblingB, cleanup: cB } = createChildAbortController(parent3.signal);

  siblingA.abort("sibling_a");
  console.assert(siblingA.signal.aborted, "Sibling A aborted");
  console.assert(!siblingB.signal.aborted, "Sibling B should NOT be affected");
  console.assert(!parent3.signal.aborted, "Parent should NOT be affected");
  cA();
  cB();

  console.log("All abort hierarchy tests passed.");
}
```

**Explanation:** The function listens for the parent's `abort` event and propagates it to the child. The returned `cleanup` function removes the listener to prevent memory leaks. The key asymmetry: parent → child cascades via the event listener, but child → parent has no such link.

---

## Exercise 2
**Challenge:** Build `ToolExecutionQueue` with abort at every stage.

**Answer:**
```typescript
interface ToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

interface ToolResult {
  toolCallId: string;
  content: string;
  isCancelled: boolean;
}

class ToolExecutionQueue {
  async executeAll(
    tools: ToolUseBlock[],
    parentSignal: AbortSignal,
    executeTool: (tool: ToolUseBlock, signal: AbortSignal) => Promise<string>
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const tool of tools) {
      // Check abort before starting each tool
      if (parentSignal.aborted) {
        results.push({
          toolCallId: tool.id,
          content: `Tool "${tool.name}" was cancelled before execution.`,
          isCancelled: true,
        });
        continue;
      }

      const { controller: childController, cleanup } =
        createChildAbortController(parentSignal, `tool_${tool.name}`);

      try {
        const result = await executeTool(tool, childController.signal);
        results.push({
          toolCallId: tool.id,
          content: result,
          isCancelled: false,
        });
      } catch (error) {
        const isAbort =
          error instanceof DOMException && error.name === "AbortError";
        results.push({
          toolCallId: tool.id,
          content: isAbort
            ? `Tool "${tool.name}" was cancelled during execution.`
            : `Tool "${tool.name}" failed: ${(error as Error).message}`,
          isCancelled: isAbort,
        });
      } finally {
        cleanup();
      }
    }

    return results;
  }
}

// Test all three abort scenarios
async function testQueue() {
  const queue = new ToolExecutionQueue();
  const tools: ToolUseBlock[] = [
    { id: "1", name: "read_file", input: {} },
    { id: "2", name: "write_file", input: {} },
    { id: "3", name: "shell", input: {} },
  ];

  // Scenario 1: abort before any tool starts
  const pre = new AbortController();
  pre.abort("user_cancel");
  const r1 = await queue.executeAll(tools, pre.signal, async () => "ok");
  console.assert(r1.every((r) => r.isCancelled), "All should be cancelled");

  // Scenario 2: abort during second tool
  const mid = new AbortController();
  let callCount = 0;
  const r2 = await queue.executeAll(tools, mid.signal, async (tool, signal) => {
    callCount++;
    if (callCount === 2) {
      mid.abort("mid_cancel");
      throw new DOMException("Aborted", "AbortError");
    }
    return `result_${tool.name}`;
  });
  console.assert(!r2[0].isCancelled, "First should succeed");
  console.assert(r2[1].isCancelled, "Second should be cancelled");
  console.assert(r2[2].isCancelled, "Third should be cancelled");

  console.log("All queue abort tests passed.");
}
```

**Explanation:** The queue checks abort before each tool, creates a child controller per tool for isolation, and ensures every tool gets either a result or a cancellation message in the output array. The `finally` block cleans up event listeners regardless of outcome.

---

## Exercise 3
**Challenge:** Implement the double-Ctrl+C pattern.

**Answer:**
```typescript
class GracefulAbortController {
  private _graceful = new AbortController();
  private _immediate = new AbortController();

  get gracefulSignal(): AbortSignal {
    return this._graceful.signal;
  }

  get immediateSignal(): AbortSignal {
    return this._immediate.signal;
  }

  requestGracefulStop(reason: string = "graceful_stop"): void {
    if (!this._graceful.signal.aborted) {
      this._graceful.abort(reason);
    }
  }

  forceStop(reason: string = "force_stop"): void {
    if (!this._graceful.signal.aborted) {
      this._graceful.abort(reason);
    }
    if (!this._immediate.signal.aborted) {
      this._immediate.abort(reason);
    }
  }

  get isGracefulStopping(): boolean {
    return this._graceful.signal.aborted && !this._immediate.signal.aborted;
  }

  get isForceStopping(): boolean {
    return this._immediate.signal.aborted;
  }
}

// SIGINT wiring
function setupInterruptHandler(): GracefulAbortController {
  const controller = new GracefulAbortController();
  let pressCount = 0;

  process.on("SIGINT", () => {
    pressCount++;
    if (pressCount === 1) {
      console.log("\nStopping after current operation... (Ctrl+C again to force)");
      controller.requestGracefulStop();
    } else {
      console.log("\nForce stopping.");
      controller.forceStop();
    }
  });

  return controller;
}

// Usage in a long-running operation
async function longOperation(controller: GracefulAbortController): Promise<void> {
  for (let i = 0; i < 100; i++) {
    // Check immediate abort — stop now
    if (controller.isForceStopping) {
      console.log("Force stopped at iteration", i);
      return;
    }

    // Check graceful abort — finish this iteration, then stop
    if (controller.isGracefulStopping) {
      console.log("Gracefully stopping after iteration", i);
      return;
    }

    await new Promise((r) => setTimeout(r, 100));
  }
}
```

**Explanation:** Two separate AbortControllers provide two levels of urgency. First Ctrl+C triggers `gracefulSignal` — the current operation can complete but no new operations start. Second Ctrl+C triggers `immediateSignal` — everything stops now. The `isGracefulStopping` check allows code to finish the current iteration cleanly.

---

## Exercise 4
**Question:** Draw the abort hierarchy and explain cascade order.

**Answer:**
```
Session AbortController
└── Query Loop AbortController
    └── Model Call AbortController
        └── Streaming AbortController
    ├── Tool Execution AbortController (file read)
    │   └── File Read AbortController
    └── Tool Execution AbortController (bash command)
        └── Bash Process AbortController
```

When the user presses Ctrl+C, the **Session AbortController** fires first. This cascades to the **Query Loop AbortController**, which cascades to **both** the Model Call/Streaming controller and the Tool Execution controllers simultaneously. The Streaming controller stops consuming the stream. The File Read controller cancels the file operation. The Bash Process controller sends SIGTERM to the child process. All cascade in a single synchronous propagation — the `abort` event fires on every descendant before any of them begin cleanup. The cleanup then happens concurrently across all aborted operations.

---

## Exercise 5
**Challenge:** Implement `AbortAuditLogger`.

**Answer:**
```typescript
interface AbortEvent {
  timestamp: number;
  reason: string;
  operation: string;
  cleanupDurationMs: number;
  resourcesLeaked: boolean;
  details?: string;
}

class AbortAuditLogger {
  private events: AbortEvent[] = [];

  async recordAbort(
    reason: string,
    operation: string,
    cleanupFn: () => Promise<void>
  ): Promise<void> {
    const start = Date.now();
    let leaked = false;

    try {
      await Promise.race([
        cleanupFn(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Cleanup timeout")), 5000)
        ),
      ]);
    } catch (error) {
      leaked = true;
    }

    this.events.push({
      timestamp: Date.now(),
      reason,
      operation,
      cleanupDurationMs: Date.now() - start,
      resourcesLeaked: leaked,
      details: leaked ? "Cleanup timed out after 5s" : undefined,
    });
  }

  generateReport(): string {
    const lines: string[] = ["=== Abort Audit Report ==="];
    lines.push(`Total abort events: ${this.events.length}`);

    const leaked = this.events.filter((e) => e.resourcesLeaked);
    lines.push(`Resources leaked: ${leaked.length}`);

    const avgCleanup =
      this.events.reduce((s, e) => s + e.cleanupDurationMs, 0) /
      (this.events.length || 1);
    lines.push(`Average cleanup time: ${avgCleanup.toFixed(0)}ms`);

    const byReason: Record<string, number> = {};
    for (const e of this.events) {
      byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;
    }
    lines.push("\nBy reason:");
    for (const [reason, count] of Object.entries(byReason)) {
      lines.push(`  ${reason}: ${count}`);
    }

    lines.push("\nBy operation:");
    const byOp: Record<string, number> = {};
    for (const e of this.events) {
      byOp[e.operation] = (byOp[e.operation] ?? 0) + 1;
    }
    for (const [op, count] of Object.entries(byOp)) {
      lines.push(`  ${op}: ${count}`);
    }

    if (leaked.length > 0) {
      lines.push("\n⚠ Leaked resources:");
      for (const e of leaked) {
        lines.push(`  ${new Date(e.timestamp).toISOString()} — ${e.operation}: ${e.details}`);
      }
    }

    return lines.join("\n");
  }
}
```

**Explanation:** The logger wraps cleanup functions with timing and timeout detection. A cleanup that takes longer than 5 seconds is marked as a resource leak. The report summarizes all aborts by reason and operation, highlights any leaks, and provides average cleanup times — directly useful for identifying which operations have slow or broken cleanup paths.
