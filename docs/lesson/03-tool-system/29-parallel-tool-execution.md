# Lesson 29: Parallel Tool Execution

## From Batches to Results

In Lesson 28, you learned how `partitionToolCalls()` groups tool calls into batches.
Now let's see how `runTools()` actually executes those batches—the orchestration
engine at the heart of Claude Code's tool system.

## `runTools()`: The Orchestrator

The main entry point iterates through batches and dispatches them:

```typescript
async function* runTools(
  toolUseBlocks: ToolUseBlock[],
  tools: Map<string, Tool>,
  context: ToolContext
): AsyncGenerator<ToolResult> {
  const batches = partitionToolCalls(toolUseBlocks, tools);

  // Queued context modifiers from parallel execution
  const pendingModifiers: ContextModifier[] = [];

  for (const batch of batches) {
    // Apply any pending context modifiers from previous batch
    for (const modifier of pendingModifiers) {
      modifier.apply(context);
    }
    pendingModifiers.length = 0;

    if (batch.isConcurrencySafe) {
      yield* runToolsConcurrently(batch.blocks, tools, context, pendingModifiers);
    } else {
      // Serial batches always have exactly one block
      yield* runToolsSerially(batch.blocks, tools, context);
    }
  }

  // Apply any remaining modifiers
  for (const modifier of pendingModifiers) {
    modifier.apply(context);
  }
}
```

This is an async generator—it yields `ToolResult` objects as tools complete. The
caller (the agentic loop from Module 02) can stream these results incrementally.

## Concurrent Execution

When a batch is concurrent-safe, all tools in it run simultaneously:

```typescript
async function* runToolsConcurrently(
  blocks: ToolUseBlock[],
  tools: Map<string, Tool>,
  context: ToolContext,
  pendingModifiers: ContextModifier[]
): AsyncGenerator<ToolResult> {
  const maxConcurrency = parseInt(
    process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY ?? "10"
  );

  // Create a semaphore to limit concurrency
  const semaphore = new Semaphore(maxConcurrency);

  // Launch all tools simultaneously
  const resultPromises = blocks.map(async (block) => {
    await semaphore.acquire();
    try {
      return await executeSingleTool(block, tools, context, pendingModifiers);
    } finally {
      semaphore.release();
    }
  });

  // Wait for all to complete, yield results in original order
  const results = await Promise.all(resultPromises);

  for (const result of results) {
    yield result;
  }
}
```

### Key Design Decisions

**Maximum concurrency of 10**: Even for concurrent-safe tools, there's a cap.
This prevents resource exhaustion—10 simultaneous file reads are fine; 100 might
overwhelm the filesystem.

```typescript
const maxConcurrency = parseInt(
  process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY ?? "10"
);
```

Users can override this with the `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` environment
variable for environments that can handle more (or need less).

**Results in original order**: Even though tools finish in arbitrary order,
`Promise.all` preserves the order of the input array. Results are yielded in the
same order the model requested them. This matters because the model may expect
results in a specific sequence.

**Semaphore pattern**: A semaphore controls access to a shared resource pool:

```typescript
class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}
```

## Serial Execution

Serial batches contain a single tool that runs alone:

```typescript
async function* runToolsSerially(
  blocks: ToolUseBlock[],
  tools: Map<string, Tool>,
  context: ToolContext
): AsyncGenerator<ToolResult> {
  for (const block of blocks) {
    const result = await executeSingleTool(block, tools, context);
    yield result;
  }
}
```

This is straightforward: execute one tool, yield the result, move to the next.

## The Single Tool Execution Pipeline

Both concurrent and serial paths call `executeSingleTool()`:

```typescript
async function executeSingleTool(
  block: ToolUseBlock,
  tools: Map<string, Tool>,
  context: ToolContext,
  pendingModifiers?: ContextModifier[]
): Promise<ToolResult> {
  const tool = tools.get(block.name);

  // 1. Unknown tool
  if (!tool) {
    return {
      tool_use_id: block.id,
      content: `Unknown tool: "${block.name}"`,
      is_error: true,
    };
  }

  // 2. Validate input
  const parsed = tool.inputSchema.safeParse(block.input);
  if (!parsed.success) {
    return {
      tool_use_id: block.id,
      content: formatZodValidationError(parsed.error, tool),
      is_error: true,
    };
  }

  // 3. Custom validation
  if (tool.validateInput) {
    const validation = await tool.validateInput(parsed.data);
    if (!validation.valid) {
      return {
        tool_use_id: block.id,
        content: validation.message,
        is_error: true,
      };
    }
  }

  // 4. Permission check
  if (tool.checkPermissions) {
    const permission = await tool.checkPermissions(parsed.data, context);
    if (!permission.allowed) {
      return {
        tool_use_id: block.id,
        content: `Permission denied: ${permission.reason}`,
        is_error: true,
      };
    }
  }

  // 5. Execute
  try {
    const result = await tool.call(parsed.data, context);
    return {
      tool_use_id: block.id,
      content: typeof result === "string" ? result : result.content,
    };
  } catch (error) {
    return {
      tool_use_id: block.id,
      content: `Tool execution error: ${error.message}`,
      is_error: true,
    };
  }
}
```

## Context Modifiers

Some tools modify the execution context (e.g., changing the working directory,
updating timestamps). During parallel execution, these modifications can't be
applied immediately—other tools are running with the old context.

The solution: **queue modifiers during parallel execution, apply them after**.

```typescript
// During concurrent execution, tools queue modifiers
function onContextModifier(modifier: ContextModifier, pendingModifiers?: ContextModifier[]) {
  if (pendingModifiers) {
    pendingModifiers.push(modifier);
  } else {
    modifier.apply(context);
  }
}

// After the concurrent batch completes, modifiers are applied in order
for (const modifier of pendingModifiers) {
  modifier.apply(context);
}
```

This ensures:
1. Parallel tools see a consistent context snapshot
2. Modifications are applied in the original order
3. The next batch sees all modifications from the previous batch

## Complete Execution Flow

Let's trace the full flow for our example from Lesson 28:

```
Tool calls: [Read(a.ts), Read(b.ts), Grep("TODO"), Edit(a.ts), Read(a.ts)]
Batches:    [{safe, [R,R,G]}, {unsafe, [E]}, {safe, [R]}]
```

```
Time ─────────────────────────────────────────────▶

Batch 1 (concurrent):
  Read(a.ts)  ████████░░░░░░░░  done → yield result₁
  Read(b.ts)  ██████░░░░░░░░░░  done → yield result₂
  Grep(TODO)  ████████████░░░░  done → yield result₃
              ▲ all start       ▲ all done, apply modifiers
              simultaneously

Batch 2 (serial):
              ░░░░░░░░░░░░░░░░ Edit(a.ts) ██████████ done → yield result₄

Batch 3 (concurrent, single item):
              ░░░░░░░░░░░░░░░░░░░░░░░░░░░ Read(a.ts) ████ done → yield result₅
```

Total time: batch 1 (slowest of 3) + batch 2 + batch 3.

Without partitioning (all serial): sum of all 5. The concurrent execution of
batch 1 saves roughly 2x the time of a single read.

## Error Handling in Parallel

When multiple tools run concurrently, errors in one don't cancel the others.
Each tool independently succeeds or fails:

```typescript
// Promise.all waits for ALL to complete, even if some throw
// But we catch errors inside executeSingleTool, so promises never reject
const results = await Promise.all(resultPromises);
```

This means after a concurrent batch, you might have:
- Result 1: success
- Result 2: error (file not found)
- Result 3: success

All three results are yielded. The model sees which tools succeeded and which
failed, and can decide what to do next.

## Configuration

The concurrency limit is configurable:

```bash
# Default: 10 concurrent tools
export CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=10

# Conservative: 3 concurrent tools
export CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=3

# Aggressive: 20 concurrent tools (fast SSD, lots of RAM)
export CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=20
```

In practice, 10 is a good default. Most concurrent batches have 2-5 tools, so the
limit rarely comes into play.

## Key Takeaways

1. `runTools()` iterates batches, dispatching concurrent or serial execution
2. Concurrent batches use `Promise.all` with a semaphore (max 10)
3. Results are always yielded in the model's original order
4. Context modifiers are queued during parallel execution, applied after
5. Errors in parallel tools don't cancel siblings
6. Concurrency limit is configurable via environment variable

## What's Next

So far, we've assumed the model finishes generating before tools start executing.
But what if we could start executing tools *while the model is still streaming*?
That's streaming tool execution—next lesson.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Context Modifiers

**Question:** What are context modifiers, why can't they be applied immediately during parallel execution, and how does the queuing system ensure correctness?

[View Answer](../../answers/03-tool-system/answer-29.md#exercise-1)

### Exercise 2 — Implement a Semaphore

**Challenge:** Implement the `Semaphore` class with `acquire()` and `release()` methods. `acquire()` returns a Promise that resolves when a permit is available. `release()` frees a permit or unblocks a waiting acquirer. Write a test that proves it limits concurrency to N.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-29.md#exercise-2)

### Exercise 3 — Implement runToolsConcurrently

**Challenge:** Implement `runToolsConcurrently()` that takes an array of tool blocks and executes them with a semaphore-limited concurrency of `maxConcurrency`. Use `Promise.all` to wait for all results and yield them in original order. Assume `executeSingleTool()` is already defined.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-29.md#exercise-3)

### Exercise 4 — Error Independence

**Question:** When three tools run concurrently and the second one fails, what happens to the first and third? How does `Promise.all` behave here, and what design choice prevents one failure from canceling siblings?

[View Answer](../../answers/03-tool-system/answer-29.md#exercise-4)

### Exercise 5 — Timing Analysis

**Challenge:** Given these tool execution times, calculate the total wall time with and without partitioning:

```
Read(a.ts)  — 100ms, safe
Read(b.ts)  — 150ms, safe
Grep(TODO)  — 200ms, safe
Edit(a.ts)  — 80ms,  unsafe
Read(a.ts)  — 100ms, safe
```

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-29.md#exercise-5)

---

*Module 03: The Tool System — Lesson 29 of 35*
