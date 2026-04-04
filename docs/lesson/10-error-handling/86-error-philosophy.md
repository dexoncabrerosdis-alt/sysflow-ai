# Lesson 86: Error Philosophy

## Errors Are Normal

In traditional software, errors are exceptional. You write code for the happy path and add error handling for edge cases. In an AI coding agent, errors are **normal**. They happen constantly, predictably, and as part of healthy operation.

Why? Because the agent operates in an inherently uncertain environment:

- The model might generate invalid tool inputs
- API calls might hit rate limits or network failures
- The context window might overflow
- The user might interrupt mid-operation
- File operations might fail due to permissions or missing paths
- Shell commands might return non-zero exit codes

An agent that treats every error as a crash is an agent that barely works. Claude Code's error philosophy starts from a different premise: **expect errors, design for recovery**.

## The Five Principles

### Principle 1: Never Give Up on the First Failure

The most important principle. When something fails, try again before giving up:

```typescript
// Bad: single attempt, crash on failure
async function readFileOrDie(path: string): Promise<string> {
  const result = await fs.readFile(path, "utf-8");
  return result; // Throws on failure — agent loop crashes
}

// Good: retry with backoff
async function readFileWithRetry(path: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fs.readFile(path, "utf-8");
    } catch (error) {
      if (attempt === 2) throw error;
      await delay(100 * Math.pow(2, attempt));
    }
  }
  throw new Error("Unreachable");
}
```

But it goes deeper than simple retries. Different error types have different recovery strategies. A 429 (rate limit) needs a backoff. A 413 (payload too large) needs context reduction. A timeout needs a longer timeout or a simpler request. The agent has **multiple recovery paths for every error type**.

### Principle 2: The Model Should See Errors

When a tool fails, the error message goes back to the model as a tool result. This is by design — the model is often the best error handler:

```typescript
async function executeToolWithErrorRecovery(
  toolUse: ToolUseBlock,
  tool: Tool
): Promise<ToolResultMessage> {
  try {
    const result = await tool.execute(toolUse.input);
    return createToolResult(toolUse.id, result);
  } catch (error) {
    // Don't hide the error — send it to the model
    return createToolResult(toolUse.id, formatError(error), {
      is_error: true,
    });
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `Error: ${error.message}\n\nStack: ${error.stack}`;
  }
  return `Unknown error: ${String(error)}`;
}
```

The model sees the error and can reason about it:

```
Model: I'll read the configuration file.
Tool result: Error: ENOENT: no such file or directory, open 'config.yaml'

Model: The config file doesn't exist at config.yaml. Let me check
       if it's using a different name or location.
       [calls list_directory to find config files]
```

This is self-correction — the model adapts its approach based on error feedback. It's one of the most powerful capabilities of the agent loop.

### Principle 3: Silent Error Hiding Is Worse Than Loud Failure

Never swallow errors silently. A hidden error creates invisible bugs that are harder to diagnose than a visible crash:

```typescript
// TERRIBLE: silent swallow
async function tryReadFile(path: string): Promise<string> {
  try {
    return await fs.readFile(path, "utf-8");
  } catch {
    return ""; // Silently returns empty string
    // Caller has no idea the file wasn't read
    // Model might make decisions based on "empty" file
  }
}

// BAD: catch-all with generic message
async function tryReadFile(path: string): Promise<string> {
  try {
    return await fs.readFile(path, "utf-8");
  } catch {
    return "Something went wrong"; // Useless
  }
}

// GOOD: structured error with context
async function tryReadFile(path: string): Promise<ToolResult> {
  try {
    const content = await fs.readFile(path, "utf-8");
    return { success: true, content };
  } catch (error) {
    return {
      success: false,
      error: {
        type: classifyFileError(error),
        message: error.message,
        path,
        suggestion: getSuggestion(error),
      },
    };
  }
}

function classifyFileError(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case "ENOENT": return "file_not_found";
    case "EACCES": return "permission_denied";
    case "EISDIR": return "is_directory";
    case "EMFILE": return "too_many_open_files";
    default: return "unknown_file_error";
  }
}

function getSuggestion(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case "ENOENT":
      return "Check if the file path is correct. Use list_directory to see available files.";
    case "EACCES":
      return "The file exists but cannot be read. Check file permissions.";
    case "EISDIR":
      return "The path is a directory, not a file. Use list_directory instead.";
    default:
      return "Try the operation again or use an alternative approach.";
  }
}
```

### Principle 4: Structured Errors Enable Structured Recovery

Errors aren't just strings — they're typed values that drive recovery logic:

```typescript
// Error type hierarchy
class AgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean,
    public readonly retryable: boolean
  ) {
    super(message);
  }
}

class APIError extends AgentError {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryAfter?: number
  ) {
    super(
      message,
      `api_${statusCode}`,
      statusCode >= 500 || statusCode === 429, // Server errors and rate limits are recoverable
      statusCode >= 500 || statusCode === 429   // Same for retryable
    );
  }
}

class ContextOverflowError extends AgentError {
  constructor(
    public readonly currentTokens: number,
    public readonly maxTokens: number
  ) {
    super(
      `Context overflow: ${currentTokens} tokens exceeds ${maxTokens} limit`,
      "context_overflow",
      true,  // Recoverable via compaction
      false  // Don't retry the same request — compact first
    );
  }
}

class ToolExecutionError extends AgentError {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly toolInput: unknown
  ) {
    super(message, "tool_execution", true, true);
  }
}
```

The recovery system uses these types to choose the right strategy:

```typescript
async function recoverFromError(error: AgentError): Promise<RecoveryAction> {
  if (error instanceof APIError && error.statusCode === 429) {
    return {
      action: "retry",
      delay: error.retryAfter || calculateBackoff(),
    };
  }

  if (error instanceof ContextOverflowError) {
    return {
      action: "compact",
      targetTokens: error.maxTokens * 0.7,
    };
  }

  if (error instanceof ToolExecutionError) {
    return {
      action: "report_to_model",
      message: error.message,
    };
  }

  if (!error.recoverable) {
    return { action: "terminate", reason: error.message };
  }

  return { action: "retry", delay: 1000 };
}
```

### Principle 5: Cascading Recovery

When the first recovery strategy fails, try the next one. Each error type has a cascade of increasingly aggressive recovery options:

```typescript
interface RecoveryCascade {
  strategies: RecoveryStrategy[];
  currentIndex: number;
}

const API_ERROR_CASCADE: RecoveryCascade = {
  strategies: [
    { name: "retry_with_backoff", maxAttempts: 3 },
    { name: "switch_model", fallbackModel: "claude-haiku" },
    { name: "reduce_context", reductionFactor: 0.5 },
    { name: "terminate_gracefully" },
  ],
  currentIndex: 0,
};

async function executeWithCascade(
  operation: () => Promise<void>,
  cascade: RecoveryCascade
): Promise<void> {
  for (const strategy of cascade.strategies) {
    try {
      await applyStrategy(strategy, operation);
      return; // Success — exit cascade
    } catch (error) {
      console.log(`Strategy ${strategy.name} failed, trying next...`);
      continue;
    }
  }
  throw new Error("All recovery strategies exhausted");
}
```

## The Error Flow in the Agent Loop

Here's how errors flow through the complete agent loop:

```typescript
async function* agentLoop(config: AgentConfig): AsyncGenerator<Message> {
  let consecutiveErrors = 0;

  while (true) {
    try {
      // Call the model
      const response = await callModelWithRetry(config);
      consecutiveErrors = 0; // Reset on success

      // Process response
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const result = await executeToolSafely(block);
          yield result;
        }
        if (block.type === "text") {
          yield createTextMessage(block.text);
        }
      }

      if (response.stop_reason === "end_turn") break;
    } catch (error) {
      consecutiveErrors++;

      // After too many consecutive errors, stop
      if (consecutiveErrors >= 5) {
        yield createErrorMessage("Too many consecutive errors. Stopping.");
        break;
      }

      // Yield the error so the user sees it
      yield createErrorMessage(`Error: ${error.message}. Retrying...`);

      // Apply recovery
      const recovery = await recoverFromError(error);
      if (recovery.action === "terminate") break;
      if (recovery.delay) await delay(recovery.delay);
    }
  }
}
```

## Summary

Claude Code's error philosophy treats errors as first-class citizens in the agent loop. Errors are expected, visible, structured, and recoverable. The model participates in error recovery by seeing failures and adapting. Multiple recovery paths ensure the agent keeps working even when individual operations fail.

In the following lessons, we'll dive into the specific recovery systems: retries, token limit recovery, context overflow handling, streaming errors, abort management, and circuit breakers.

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Classifying Errors
**Question:** Classify these errors as recoverable or terminal, and explain why: 429 Too Many Requests, 401 Unauthorized, ENOSPC (disk full), network timeout, invalid JSON in model response, model refuses to respond.

[View Answer](../../answers/10-error-handling/answer-86.md#exercise-1)

### Exercise 2 — Recovery Cascade
**Challenge:** Build a `RecoveryCascade` class that takes a list of recovery strategies and executes them in order until one succeeds. Include logging, timing for each strategy, and a maximum total time budget that aborts the cascade if exceeded.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-86.md#exercise-2)

### Exercise 3 — Error Taxonomy
**Challenge:** Design an error taxonomy for an AI coding agent. Create at least 10 specific error classes extending a base `AgentError`, each with appropriate `recoverable` and `retryable` flags, plus a `recoverFromError()` function that dispatches on the error type.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-86.md#exercise-3)

### Exercise 4 — Model-Visible Error Formatting
**Challenge:** Implement the "model sees errors" pattern: create a `formatErrorForModel()` function that takes any error and returns a structured tool result with the error type, message, suggestions for recovery, and context. The output should give the model enough information to self-correct.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-86.md#exercise-4)

### Exercise 5 — Cascading Recovery vs Silent Failure
**Question:** A teammate proposes catching all tool errors and returning an empty string to the model so it "never crashes." Using Principles 3 and 5 from this lesson, explain in 3-5 sentences why this is worse than letting the error flow through the recovery cascade.

[View Answer](../../answers/10-error-handling/answer-86.md#exercise-5)
