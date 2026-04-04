# Lesson 91: The Abort System

## Why Abort Matters

An AI coding agent can be in the middle of many things: streaming a response, executing a shell command, reading a large file, calling an external API. When the user presses Ctrl+C or clicks "Stop," all of these operations need to halt cleanly. Not crash. Not leave partial files written. Not leave orphaned processes. Clean shutdown.

This is the abort system's job.

## AbortController: The Foundation

JavaScript's built-in `AbortController` is the primitive that powers the entire system:

```typescript
const controller = new AbortController();
const signal = controller.signal;

// Pass the signal to an async operation
const result = await fetch(url, { signal });

// Later, to cancel:
controller.abort("user_interrupt");

// The fetch will throw an AbortError
```

Claude Code extends this pattern with a hierarchy of controllers that propagate abort signals from parent to child operations.

## Parent-Child Abort Hierarchy

The key insight: aborting a parent should abort all children, but aborting a child shouldn't affect the parent or siblings.

```typescript
function createChildAbortController(
  parentSignal: AbortSignal,
  reason?: string
): AbortController {
  const child = new AbortController();

  // If parent aborts, abort the child too
  const onParentAbort = () => {
    child.abort(parentSignal.reason || reason);
  };

  if (parentSignal.aborted) {
    // Parent already aborted — immediately abort child
    child.abort(parentSignal.reason || reason);
  } else {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  // Clean up the listener when the child is garbage collected
  // (in practice, we track this manually)

  return child;
}
```

This creates a tree structure:

```
Session AbortController
├── Query Loop AbortController
│   ├── Model Call AbortController
│   ├── Tool Execution AbortController
│   │   ├── File Read AbortController
│   │   └── Bash Command AbortController
│   └── Permission Prompt AbortController
└── Background Task AbortController
```

Aborting the session controller cascades through every descendant. Aborting the tool execution controller only affects the current tool and its children.

## Abort Reasons

Different abort triggers require different cleanup behavior:

```typescript
type AbortReason =
  | "interrupt"      // User pressed Ctrl+C or Stop
  | "sibling_error"  // Another parallel operation failed
  | "discard"        // This result is no longer needed
  | "timeout"        // Operation exceeded time limit
  | "shutdown";      // Application is shutting down

function getAbortReason(signal: AbortSignal): AbortReason {
  return (signal.reason as AbortReason) || "interrupt";
}
```

Each reason triggers different cleanup logic:

```typescript
async function cleanupAfterAbort(
  reason: AbortReason,
  state: AgentState
): Promise<void> {
  switch (reason) {
    case "interrupt":
      // User-initiated: save state, yield partial results
      await savePartialState(state);
      break;

    case "sibling_error":
      // Parallel operation failed: clean up quietly
      await rollbackIfNeeded(state);
      break;

    case "discard":
      // Result not needed: clean up silently, no user notification
      break;

    case "timeout":
      // Operation too slow: yield timeout message
      await savePartialState(state);
      break;

    case "shutdown":
      // App closing: minimal cleanup, save critical state
      await saveMinimalState(state);
      break;
  }
}
```

## Abort During Streaming

When abort fires during a model response stream, the system needs to:
1. Stop consuming the stream
2. Drain any buffered content
3. Create synthetic tool results for orphaned tool_use blocks

```typescript
async function* handleStreamWithAbort(
  stream: AsyncIterable<StreamEvent>,
  signal: AbortSignal
): AsyncGenerator<Message> {
  const accumulatedBlocks: ContentBlock[] = [];

  try {
    for await (const event of stream) {
      // Check abort before processing each event
      if (signal.aborted) break;

      if (event.type === "content_block_delta") {
        updateContentBlocks(accumulatedBlocks, event);
        yield createDeltaMessage(event);
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      // Expected — abort was triggered
    } else {
      throw error; // Unexpected error — propagate
    }
  }

  // Post-abort cleanup: handle orphaned tool calls
  if (signal.aborted) {
    const orphanedTools = accumulatedBlocks.filter(
      (b): b is ToolUseBlock => b.type === "tool_use"
    );

    for (const toolUse of orphanedTools) {
      yield createSyntheticToolResult(
        toolUse.id,
        "Operation was cancelled by user."
      );
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && error.name === "AbortError"
  );
}
```

## Abort During Tool Execution

When tools are executing (especially bash commands), abort needs to:
1. Complete or kill the current operation
2. Stop any queued operations from starting
3. Clean up resources

```typescript
class ToolExecutionQueue {
  private queue: ToolExecution[] = [];
  private current: ToolExecution | null = null;

  async executeAll(
    tools: ToolUseBlock[],
    signal: AbortSignal
  ): Promise<ToolResultMessage[]> {
    const results: ToolResultMessage[] = [];

    for (const toolUse of tools) {
      // Check abort before starting each tool
      if (signal.aborted) {
        // Create cancellation results for remaining tools
        results.push(
          createCancelledToolResult(toolUse.id, "Cancelled by user")
        );
        continue;
      }

      // Execute with child abort controller
      const childController = createChildAbortController(signal);
      this.current = { toolUse, controller: childController };

      try {
        const result = await executeTool(
          toolUse,
          childController.signal
        );
        results.push(result);
      } catch (error) {
        if (isAbortError(error)) {
          results.push(
            createCancelledToolResult(toolUse.id, "Cancelled by user")
          );
        } else {
          results.push(
            createErrorToolResult(toolUse.id, error.message)
          );
        }
      }

      this.current = null;
    }

    return results;
  }
}
```

For bash commands specifically, abort needs to kill the child process:

```typescript
async function executeBashWithAbort(
  command: string,
  signal: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      signal, // Node.js supports passing AbortSignal to spawn
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed (exit ${code}): ${stderr}`));
      }
    });

    child.on("error", (error) => {
      if (isAbortError(error)) {
        reject(new AbortError("Bash command cancelled"));
      } else {
        reject(error);
      }
    });
  });
}
```

## MCP Connection Cleanup

When using MCP (Model Context Protocol) connections to external tool servers, abort needs to clean up those connections:

```typescript
interface MCPConnection {
  id: string;
  transport: Transport;
  signal: AbortSignal;
}

class MCPConnectionManager {
  private connections = new Map<string, MCPConnection>();

  async cleanup(reason: AbortReason): Promise<void> {
    const cleanupPromises = Array.from(this.connections.values()).map(
      async (conn) => {
        try {
          // Send cancellation notification to the MCP server
          await conn.transport.send({
            method: "notifications/cancelled",
            params: { reason },
          });

          // Close the transport
          await conn.transport.close();
        } catch {
          // Best-effort cleanup — don't fail if server is unresponsive
        }
      }
    );

    await Promise.allSettled(cleanupPromises);
    this.connections.clear();
  }
}
```

## Signal Propagation Pattern

The full signal propagation across the agent:

```typescript
class AgentSession {
  private sessionController = new AbortController();

  async run(): Promise<void> {
    // Register interrupt handler
    process.on("SIGINT", () => {
      this.sessionController.abort("interrupt");
    });

    try {
      await this.queryLoop(this.sessionController.signal);
    } catch (error) {
      if (isAbortError(error)) {
        console.log("Session ended by user.");
      } else {
        throw error;
      }
    }
  }

  private async queryLoop(parentSignal: AbortSignal): Promise<void> {
    while (!parentSignal.aborted) {
      const queryController = createChildAbortController(parentSignal);

      try {
        const userMessage = await getInput(queryController.signal);
        await this.processQuery(userMessage, queryController.signal);
      } catch (error) {
        if (isAbortError(error)) {
          // Abort during a query — restart the query loop
          continue;
        }
        throw error;
      }
    }
  }

  private async processQuery(
    message: string,
    parentSignal: AbortSignal
  ): Promise<void> {
    const modelController = createChildAbortController(parentSignal);

    const stream = callModelStreaming(message, modelController.signal);

    for await (const block of stream) {
      if (block.type === "tool_use") {
        const toolController = createChildAbortController(parentSignal);
        await executeTool(block, toolController.signal);
      }
    }
  }
}
```

## Graceful vs Immediate Abort

Sometimes you want to let the current operation finish before stopping. This is **graceful abort**:

```typescript
class GracefulAbortController {
  private immediate = new AbortController();
  private graceful = new AbortController();

  get immediateSignal(): AbortSignal {
    return this.immediate.signal;
  }

  get gracefulSignal(): AbortSignal {
    return this.graceful.signal;
  }

  requestGracefulStop(): void {
    this.graceful.abort("graceful_stop");
    // Don't abort immediate — let current operation finish
  }

  forceStop(): void {
    this.graceful.abort("force_stop");
    this.immediate.abort("force_stop");
  }
}

// Usage: first Ctrl+C = graceful, second Ctrl+C = force
let ctrlCCount = 0;
const controller = new GracefulAbortController();

process.on("SIGINT", () => {
  ctrlCCount++;
  if (ctrlCCount === 1) {
    console.log("Stopping after current operation... (Ctrl+C again to force)");
    controller.requestGracefulStop();
  } else {
    console.log("Force stopping.");
    controller.forceStop();
  }
});
```

## Summary

The abort system ensures clean shutdown at every level of the agent. `createChildAbortController` builds a parent-child hierarchy where abort cascades downward but not upward. Different abort reasons trigger different cleanup behaviors. During streaming, abort creates synthetic tool results for orphaned calls. During tool execution, abort kills child processes and cancels queued operations. MCP connections get proper cleanup notifications. The graceful/immediate pattern gives users control over how aggressively to stop.

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Child Abort Controller
**Challenge:** Implement `createChildAbortController()` that connects a child to a parent signal. The parent aborting must cascade to the child. The child aborting must NOT affect the parent or siblings. Include proper cleanup of the `abort` event listener. Write tests that verify both directions.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-91.md#exercise-1)

### Exercise 2 — Tool Execution Queue with Abort
**Challenge:** Build a `ToolExecutionQueue` class that executes an array of tool_use blocks sequentially. It must support abort at three points: before a tool starts (skip remaining tools), during execution (cancel current tool), and between tools (stop processing). Every tool must receive either a real result or a cancellation message. Test all three abort timing scenarios.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-91.md#exercise-2)

### Exercise 3 — Double Ctrl+C Pattern
**Challenge:** Implement a `GracefulAbortController` with two signals: `gracefulSignal` (first Ctrl+C — finish current operation, then stop) and `immediateSignal` (second Ctrl+C — kill everything now). Wire it to a SIGINT handler that counts presses. Test with a simulated long-running operation.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-91.md#exercise-3)

### Exercise 4 — Abort Hierarchy Tree
**Question:** Draw (in text/ASCII) the abort controller hierarchy for an agent that is: running a query loop, which has an active model call streaming a response, which triggered two parallel tool executions (a file read and a bash command). Label each controller. Then explain: if the user presses Ctrl+C, which controllers fire and in what order?

[View Answer](../../answers/10-error-handling/answer-91.md#exercise-4)

### Exercise 5 — Abort Audit Logger
**Challenge:** Implement an `AbortAuditLogger` that records every abort event with: timestamp, reason, which controller/operation was aborted, how long cleanup took, and whether any resources were leaked. Include a `generateReport()` method that summarizes all aborts in a session.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-91.md#exercise-5)
