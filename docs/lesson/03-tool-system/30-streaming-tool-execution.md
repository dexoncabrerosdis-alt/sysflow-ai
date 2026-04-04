# Lesson 30: Streaming Tool Execution

## The Latency Problem

In the standard flow from Lesson 29, tool execution starts after the model finishes
its entire response. But model responses can take seconds to generate. If the model
emits a `Read` tool call early in its response, then spends 3 more seconds generating
text, you're wasting 3 seconds of wall time.

What if you could start executing tools *while the model is still generating?*

That's exactly what `StreamingToolExecutor` does.

## The Insight

Remember from Module 02: the model's response streams token by token. As it streams,
tool_use blocks appear incrementally. Once a complete tool_use block has arrived—the
name, id, and full input JSON—you have everything you need to start executing it.
You don't need to wait for the rest of the response.

```
Model streaming: "Let me check... " [tool_use: Read(a.ts)] " and also " [tool_use: Read(b.ts)] " ..."
                                     ▲                                   ▲
                                     │ Start Read(a.ts)                  │ Start Read(b.ts)
                                     │ immediately                       │ immediately
```

## StreamingToolExecutor

Here's the core interface:

```typescript
class StreamingToolExecutor {
  private tools: Map<string, Tool>;
  private context: ToolContext;
  private queue: Array<{
    block: ToolUseBlock;
    promise: Promise<ToolResult> | null;
    result: ToolResult | null;
    started: boolean;
  }>;
  private aborted: boolean;

  constructor(tools: Map<string, Tool>, context: ToolContext) {
    this.tools = tools;
    this.context = context;
    this.queue = [];
    this.aborted = false;
  }

  addTool(block: ToolUseBlock): void { /* ... */ }
  getCompletedResults(): ToolResult[] { /* ... */ }
  async getRemainingResults(): Promise<ToolResult[]> { /* ... */ }
  discard(): void { /* ... */ }
}
```

## `addTool()`: Called as Tools Stream In

Every time the streaming parser detects a complete tool_use block, it calls
`addTool()`:

```typescript
addTool(block: ToolUseBlock): void {
  const entry = {
    block,
    promise: null as Promise<ToolResult> | null,
    result: null as ToolResult | null,
    started: false,
  };

  this.queue.push(entry);
  this.processQueue();
}
```

This pushes the tool onto the queue and triggers processing.

## `processQueue()`: Deciding What to Execute

The queue processor checks each pending tool and decides if it can start:

```typescript
private processQueue(): void {
  for (const entry of this.queue) {
    if (entry.started || this.aborted) continue;

    if (this.canExecuteTool(entry.block)) {
      entry.started = true;
      entry.promise = this.executeAndCapture(entry);
    }
  }
}

private canExecuteTool(block: ToolUseBlock): boolean {
  const tool = this.tools.get(block.name);
  if (!tool) return true;  // unknown tools execute immediately (will error)

  // Concurrency-safe tools can start immediately
  if (isConcurrencySafeForInput(tool, block.input)) {
    return true;
  }

  // Unsafe tools can only start if no other tools are currently running
  const anyRunning = this.queue.some(
    (e) => e.started && e.result === null
  );
  return !anyRunning;
}
```

The key logic: **safe tools start immediately; unsafe tools wait for all running
tools to complete first.**

## `executeAndCapture()`: Running the Tool

```typescript
private async executeAndCapture(
  entry: QueueEntry
): Promise<ToolResult> {
  try {
    const result = await executeSingleTool(
      entry.block,
      this.tools,
      this.context
    );
    entry.result = result;

    // Check for sibling abort
    if (this.shouldAbortSiblings(result)) {
      this.abortSiblings(entry);
    }

    // Process more queue items that might be unblocked
    this.processQueue();

    return result;
  } catch (error) {
    const errorResult = {
      tool_use_id: entry.block.id,
      content: `Error: ${error.message}`,
      is_error: true,
    };
    entry.result = errorResult;
    this.processQueue();
    return errorResult;
  }
}
```

After a tool completes, it calls `processQueue()` again—this might unblock unsafe
tools that were waiting.

## `getCompletedResults()`: Yielding Finished Results in Order

This is called periodically by the streaming loop to pick up results:

```typescript
getCompletedResults(): ToolResult[] {
  const results: ToolResult[] = [];

  // Yield results in order — only if all preceding tools are also done
  while (this.queue.length > 0 && this.queue[0].result !== null) {
    results.push(this.queue[0].result);
    this.queue.shift();
  }

  return results;
}
```

The critical detail: results are yielded **in order**. If tool 1 is still running
but tool 2 is done, tool 2's result is NOT yielded yet. This preserves the
ordering contract from Lesson 29.

```
Queue state:
  [Tool1: running] [Tool2: done] [Tool3: done] [Tool4: running]
                     ↑ can't yield yet — Tool1 isn't done

After Tool1 completes:
  [Tool1: done] [Tool2: done] [Tool3: done] [Tool4: running]
   ↑ yield      ↑ yield       ↑ yield        ↑ can't yield yet
```

## `getRemainingResults()`: After Stream Ends

Once the model finishes streaming, we need to wait for all remaining tools:

```typescript
async getRemainingResults(): Promise<ToolResult[]> {
  // Wait for all started tools to complete
  const pendingPromises = this.queue
    .filter((e) => e.promise !== null)
    .map((e) => e.promise);

  await Promise.all(pendingPromises);

  // Process any remaining unstarted tools
  this.processQueue();

  // Wait again for newly started tools
  while (this.queue.some((e) => e.started && e.result === null)) {
    await Promise.all(
      this.queue.filter((e) => e.promise).map((e) => e.promise)
    );
    this.processQueue();
  }

  // Collect all remaining results
  return this.queue
    .filter((e) => e.result !== null)
    .map((e) => e.result!);
}
```

## Sibling Abort

If a Bash tool encounters a critical error (non-zero exit code, for example), it
can abort sibling tools that haven't started yet:

```typescript
private shouldAbortSiblings(result: ToolResult): boolean {
  // Bash errors may invalidate subsequent tools
  return result.is_error && result.metadata?.toolName === "Bash";
}

private abortSiblings(errorEntry: QueueEntry): void {
  for (const entry of this.queue) {
    if (entry === errorEntry) continue;
    if (!entry.started) {
      entry.result = {
        tool_use_id: entry.block.id,
        content: "Aborted: sibling tool failed",
        is_error: true,
      };
    }
  }
  this.aborted = true;
}
```

Why? If `npm install` fails, there's no point running `npm test` next. The model
will see the error and re-plan.

## `discard()`: The Fallback Escape

If the streaming response encounters a fatal error (API disconnect, invalid JSON),
the executor can discard all pending work:

```typescript
discard(): void {
  this.aborted = true;
  for (const entry of this.queue) {
    if (!entry.started) {
      entry.result = {
        tool_use_id: entry.block.id,
        content: "Discarded: stream interrupted",
        is_error: true,
      };
    }
  }
}
```

## Integration with the Streaming Loop

Here's how the StreamingToolExecutor fits into the agent's main loop:

```typescript
async function* processStreamingResponse(stream: AsyncIterable<StreamEvent>) {
  const executor = new StreamingToolExecutor(tools, context);

  for await (const event of stream) {
    if (event.type === "content_block_stop" && event.content_block.type === "tool_use") {
      // Complete tool_use block arrived — add to executor
      executor.addTool(event.content_block);
    }

    // Periodically check for completed results
    const completed = executor.getCompletedResults();
    for (const result of completed) {
      yield result;
    }
  }

  // Stream is done — get all remaining results
  const remaining = await executor.getRemainingResults();
  for (const result of remaining) {
    yield result;
  }
}
```

## Timing Example

Without streaming execution:

```
Model generates: ████████████████████ (5 seconds)
Tool execution:                       ████████ (3 seconds)
Total:                                         8 seconds
```

With streaming execution:

```
Model generates: ████████████████████ (5 seconds)
Tool execution:      ████████         (3 seconds, started at second 2)
Total:                        ██████  6 seconds (saved 2 seconds)
```

The savings depend on how early in the stream tool calls appear. If the model
emits a tool call in its first content block, execution overlaps maximally with
the remaining generation.

## Key Takeaways

1. `StreamingToolExecutor` starts tools before the model finishes generating
2. `addTool()` is called as each tool_use block completes during streaming
3. Safe tools start immediately; unsafe tools wait for running tools to finish
4. Results are yielded **in order**, even if later tools finish first
5. Sibling abort: Bash errors can cancel pending sibling tools
6. `discard()` handles stream interruptions gracefully
7. Real-world latency improvement: overlapping generation and execution

## What's Next

Tools can fail in many ways: validation errors, permission denials, runtime
exceptions. How does Claude Code handle these failures and communicate them
back to the model? That's tool error handling.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Latency Insight

**Question:** What latency problem does `StreamingToolExecutor` solve? Draw a timeline comparison showing how streaming execution overlaps model generation with tool execution.

[View Answer](../../answers/03-tool-system/answer-30.md#exercise-1)

### Exercise 2 — Implement canExecuteTool

**Challenge:** Implement the `canExecuteTool(block)` method for a `StreamingToolExecutor`. Safe tools can start immediately. Unsafe tools can only start when no other tools are currently running. Unknown tools should be allowed to execute immediately (they'll error during execution).

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-30.md#exercise-2)

### Exercise 3 — Implement getCompletedResults

**Challenge:** Implement `getCompletedResults()` that returns completed results **in order**. If tool 1 is still running but tool 2 is done, tool 2's result must NOT be returned yet. Drain from the front of the queue while results are available.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-30.md#exercise-3)

### Exercise 4 — Sibling Abort

**Question:** What is "sibling abort," when does it trigger, and why is it specifically tied to Bash errors? Give a concrete example where aborting siblings prevents wasted work.

[View Answer](../../answers/03-tool-system/answer-30.md#exercise-4)

---

*Module 03: The Tool System — Lesson 30 of 35*
