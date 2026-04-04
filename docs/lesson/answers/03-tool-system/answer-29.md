# Answers: Lesson 29 — Parallel Tool Execution

## Exercise 1
**Question:** What are context modifiers, why can't they be applied immediately during parallel execution, and how does the queuing system ensure correctness?

**Answer:** Context modifiers are changes that tools make to the shared execution context — for example, updating `readFileTimestamps` after reading a file, or changing the working directory. During parallel execution, multiple tools run simultaneously with a snapshot of the context. If one tool modified the context immediately, other concurrent tools might see partially-updated state, leading to inconsistencies.

The queuing system solves this by collecting modifiers during parallel execution (`pendingModifiers.push(modifier)`) and applying them *after* the entire concurrent batch completes. This ensures: (1) all tools in a batch see a consistent, frozen context snapshot, (2) modifications are applied in the original tool order (not in completion order), and (3) the next batch starts with a fully up-to-date context that reflects all changes from the previous batch. Serial batches don't need queuing — they apply modifiers immediately since only one tool is running.

---

## Exercise 2
**Challenge:** Implement a `Semaphore` class.

**Answer:**

```typescript
class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    if (permits <= 0) throw new Error("Permits must be positive");
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      // Hand the permit directly to the next waiter
      next();
    } else {
      this.permits++;
    }
  }
}

// Test: prove it limits concurrency to N
async function testSemaphore() {
  const sem = new Semaphore(2);
  let running = 0;
  let maxRunning = 0;

  const task = async (id: number) => {
    await sem.acquire();
    running++;
    maxRunning = Math.max(maxRunning, running);
    // Simulate work
    await new Promise((r) => setTimeout(r, 50));
    running--;
    sem.release();
  };

  await Promise.all([task(1), task(2), task(3), task(4), task(5)]);
  console.log(`Max concurrent: ${maxRunning}`); // Should print 2
  console.assert(maxRunning === 2, "Concurrency should be limited to 2");
}
```

**Explanation:** The semaphore tracks available permits. `acquire()` decrements if permits are available, or adds a resolver to the wait queue if not. `release()` either resolves the next waiter (transferring the permit) or increments the count. The test runs 5 tasks with a limit of 2 and verifies at most 2 ran simultaneously.

---

## Exercise 3
**Challenge:** Implement `runToolsConcurrently()`.

**Answer:**

```typescript
type ToolUseBlock = { id: string; name: string; input: unknown };
type ToolResult = { tool_use_id: string; content: string; is_error?: boolean };

async function* runToolsConcurrently(
  blocks: ToolUseBlock[],
  tools: Map<string, Tool>,
  context: ToolContext,
  maxConcurrency: number = 10
): AsyncGenerator<ToolResult> {
  const semaphore = new Semaphore(maxConcurrency);

  // Launch all tools simultaneously, limited by semaphore
  const resultPromises = blocks.map(async (block): Promise<ToolResult> => {
    await semaphore.acquire();
    try {
      return await executeSingleTool(block, tools, context);
    } catch (error) {
      return {
        tool_use_id: block.id,
        content: `Error: ${(error as Error).message}`,
        is_error: true,
      };
    } finally {
      semaphore.release();
    }
  });

  // Wait for all to complete — Promise.all preserves order
  const results = await Promise.all(resultPromises);

  // Yield results in original order
  for (const result of results) {
    yield result;
  }
}
```

**Explanation:** All tools are launched immediately (via `.map`), but the semaphore limits how many actually execute concurrently. `Promise.all` waits for all to finish and preserves the array order — even if tool 3 finishes before tool 1, the results array maintains `[result1, result2, result3]`. Each tool independently catches its own errors, so one failure doesn't cancel the others. Results are yielded in order via the generator.

---

## Exercise 4
**Question:** When three tools run concurrently and the second one fails, what happens to the first and third?

**Answer:** The first and third tools continue running normally and their results are returned as usual. This is by design — errors in one concurrent tool do NOT cancel siblings.

The key design choice is that `executeSingleTool()` catches all errors internally and returns a `ToolResult` with `is_error: true` instead of throwing. Since the promises never reject, `Promise.all` always resolves (it only rejects if a promise rejects). After the batch completes, the results might look like:

- Result 1: `{ content: "file contents...", is_error: false }`
- Result 2: `{ content: "File not found: xyz.ts", is_error: true }`
- Result 3: `{ content: "match found on line 42", is_error: false }`

All three results are yielded to the model, which sees that one tool failed and two succeeded. The model can then decide how to handle the failure — retry, use a different approach, or report the error — while still using the successful results.

---

## Exercise 5
**Challenge:** Calculate total wall time with and without partitioning.

**Answer:**

**Partitioning analysis:**
```
Read(a.ts) 100ms  — safe  ┐
Read(b.ts) 150ms  — safe  ├─ Batch 1 (concurrent): max(100, 150, 200) = 200ms
Grep(TODO) 200ms  — safe  ┘
Edit(a.ts)  80ms  — unsafe ─ Batch 2 (serial): 80ms
Read(a.ts) 100ms  — safe   ─ Batch 3 (concurrent, 1 item): 100ms
```

**With partitioning:** 200 + 80 + 100 = **380ms**

**Without partitioning (all serial):** 100 + 150 + 200 + 80 + 100 = **630ms**

**Savings:** 630 - 380 = 250ms (39.7% faster)

The savings come entirely from Batch 1, where three reads that would take 450ms serially complete in 200ms (the duration of the slowest). Batches 2 and 3 have single tools, so there's no additional parallel benefit.
