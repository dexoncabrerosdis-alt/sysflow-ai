# Answers: Lesson 86 — Error Philosophy

## Exercise 1
**Question:** Classify these errors as recoverable or terminal, and explain why: 429 Too Many Requests, 401 Unauthorized, ENOSPC (disk full), network timeout, invalid JSON in model response, model refuses to respond.

**Answer:**
- **429 Too Many Requests** — Recoverable and retryable. The server is temporarily rate-limiting; waiting and retrying with backoff will succeed once the rate limit window resets.
- **401 Unauthorized** — Terminal. The API key is invalid or missing. Retrying with the same credentials will never succeed; user intervention is required.
- **ENOSPC (disk full)** — Terminal in practice. The agent cannot free disk space on its own. It could theoretically be recoverable if the agent can delete temporary files, but this is unreliable.
- **Network timeout** — Recoverable and retryable. Network issues are transient; retrying with a longer timeout or after a delay typically succeeds.
- **Invalid JSON in model response** — Recoverable and retryable. The model occasionally produces malformed output; a fresh API call usually returns valid JSON.
- **Model refuses to respond** — Recoverable but not directly retryable with the same prompt. The agent can modify the request (rephrase, reduce context) and try again, making this recoverable through a different strategy.

---

## Exercise 2
**Challenge:** Build a `RecoveryCascade` class that takes a list of recovery strategies and executes them in order until one succeeds.

**Answer:**
```typescript
interface RecoveryStrategy {
  name: string;
  execute: () => Promise<void>;
}

interface CascadeResult {
  success: boolean;
  strategyUsed?: string;
  totalTimeMs: number;
  attempts: { name: string; durationMs: number; succeeded: boolean; error?: string }[];
}

class RecoveryCascade {
  constructor(
    private strategies: RecoveryStrategy[],
    private maxTimeBudgetMs: number = 60_000
  ) {}

  async execute(): Promise<CascadeResult> {
    const startTime = Date.now();
    const attempts: CascadeResult["attempts"] = [];

    for (const strategy of this.strategies) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= this.maxTimeBudgetMs) {
        console.log(`Time budget exhausted (${elapsed}ms). Aborting cascade.`);
        break;
      }

      const attemptStart = Date.now();
      console.log(`Trying strategy: ${strategy.name}`);

      try {
        await strategy.execute();
        const duration = Date.now() - attemptStart;
        attempts.push({ name: strategy.name, durationMs: duration, succeeded: true });
        console.log(`Strategy "${strategy.name}" succeeded in ${duration}ms`);

        return {
          success: true,
          strategyUsed: strategy.name,
          totalTimeMs: Date.now() - startTime,
          attempts,
        };
      } catch (error) {
        const duration = Date.now() - attemptStart;
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ name: strategy.name, durationMs: duration, succeeded: false, error: message });
        console.log(`Strategy "${strategy.name}" failed after ${duration}ms: ${message}`);
      }
    }

    return {
      success: false,
      totalTimeMs: Date.now() - startTime,
      attempts,
    };
  }
}
```

**Explanation:** The class iterates through strategies in order, recording timing and success/failure for each. A total time budget check before each attempt prevents runaway cascades. The result object provides full diagnostics.

---

## Exercise 3
**Challenge:** Design an error taxonomy for an AI coding agent with at least 10 error types.

**Answer:**
```typescript
abstract class AgentError extends Error {
  abstract readonly code: string;
  abstract readonly recoverable: boolean;
  abstract readonly retryable: boolean;
}

class RateLimitError extends AgentError {
  code = "rate_limit";
  recoverable = true;
  retryable = true;
  constructor(public retryAfterMs: number) {
    super(`Rate limited. Retry after ${retryAfterMs}ms`);
  }
}

class AuthenticationError extends AgentError {
  code = "auth_failed";
  recoverable = false;
  retryable = false;
  constructor() { super("Authentication failed — invalid API key"); }
}

class ContextOverflowError extends AgentError {
  code = "context_overflow";
  recoverable = true;
  retryable = false; // compact first, then retry
  constructor(public currentTokens: number, public maxTokens: number) {
    super(`Context overflow: ${currentTokens}/${maxTokens} tokens`);
  }
}

class OutputTruncatedError extends AgentError {
  code = "output_truncated";
  recoverable = true;
  retryable = true;
  constructor() { super("Model output was truncated at max_tokens"); }
}

class ToolNotFoundError extends AgentError {
  code = "tool_not_found";
  recoverable = true;
  retryable = false;
  constructor(public toolName: string) { super(`Tool "${toolName}" not found`); }
}

class ToolExecutionError extends AgentError {
  code = "tool_exec_failed";
  recoverable = true;
  retryable = true;
  constructor(public toolName: string, message: string) {
    super(`Tool "${toolName}" failed: ${message}`);
  }
}

class FileNotFoundError extends AgentError {
  code = "file_not_found";
  recoverable = true;
  retryable = false;
  constructor(public filePath: string) { super(`File not found: ${filePath}`); }
}

class PermissionDeniedError extends AgentError {
  code = "permission_denied";
  recoverable = false;
  retryable = false;
  constructor(public resource: string) { super(`Permission denied: ${resource}`); }
}

class NetworkError extends AgentError {
  code = "network_error";
  recoverable = true;
  retryable = true;
  constructor(message: string) { super(`Network error: ${message}`); }
}

class ModelRefusalError extends AgentError {
  code = "model_refusal";
  recoverable = true;
  retryable = false; // need to rephrase
  constructor() { super("Model refused to generate a response"); }
}

class InvalidToolInputError extends AgentError {
  code = "invalid_tool_input";
  recoverable = true;
  retryable = false; // model must fix the input
  constructor(public toolName: string, public reason: string) {
    super(`Invalid input for tool "${toolName}": ${reason}`);
  }
}

class ServerError extends AgentError {
  code = "server_error";
  recoverable = true;
  retryable = true;
  constructor(public statusCode: number) {
    super(`Server error: HTTP ${statusCode}`);
  }
}

function recoverFromError(error: AgentError): { action: string; detail?: string } {
  if (error instanceof RateLimitError) return { action: "retry", detail: `wait ${error.retryAfterMs}ms` };
  if (error instanceof ContextOverflowError) return { action: "compact", detail: `reduce from ${error.currentTokens}` };
  if (error instanceof OutputTruncatedError) return { action: "escalate_tokens" };
  if (error instanceof ToolExecutionError) return { action: "report_to_model" };
  if (error instanceof FileNotFoundError) return { action: "report_to_model", detail: "suggest listing directory" };
  if (error instanceof NetworkError) return { action: "retry" };
  if (error instanceof ServerError) return { action: "retry" };
  if (error instanceof ModelRefusalError) return { action: "rephrase_request" };
  if (error instanceof InvalidToolInputError) return { action: "report_to_model" };
  if (!error.recoverable) return { action: "terminate", detail: error.message };
  return { action: "retry" };
}
```

**Explanation:** Each error class carries `recoverable` and `retryable` flags that the dispatch function uses to choose the right recovery strategy. The separation of "recoverable but not retryable" (like context overflow) from "recoverable and retryable" (like network errors) is critical.

---

## Exercise 4
**Challenge:** Implement `formatErrorForModel()` that formats any error as a structured tool result for model self-correction.

**Answer:**
```typescript
interface ToolResultForModel {
  tool_use_id: string;
  content: string;
  is_error: true;
}

function formatErrorForModel(
  error: unknown,
  toolUseId: string,
  context?: { toolName?: string; input?: unknown }
): ToolResultForModel {
  const errorType = classifyError(error);
  const message = error instanceof Error ? error.message : String(error);
  const suggestion = getSuggestion(errorType);

  let content = `Error Type: ${errorType}\n`;
  content += `Message: ${message}\n`;

  if (context?.toolName) {
    content += `Tool: ${context.toolName}\n`;
  }
  if (context?.input) {
    content += `Input: ${JSON.stringify(context.input, null, 2)}\n`;
  }

  content += `\nSuggested Recovery: ${suggestion}`;

  if (error instanceof Error && error.stack) {
    const relevantStack = error.stack.split("\n").slice(0, 3).join("\n");
    content += `\n\nStack (truncated):\n${relevantStack}`;
  }

  return { tool_use_id: toolUseId, content, is_error: true };
}

function classifyError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  if ("code" in error && (error as any).code === "ENOENT") return "file_not_found";
  if ("code" in error && (error as any).code === "EACCES") return "permission_denied";
  if (error.message.includes("timeout")) return "timeout";
  if (error.message.includes("EISDIR")) return "is_directory";
  return "execution_error";
}

function getSuggestion(errorType: string): string {
  const suggestions: Record<string, string> = {
    file_not_found: "Verify the path exists. Use list_directory or glob to find the correct file.",
    permission_denied: "The file exists but cannot be accessed. Try a different approach.",
    timeout: "The operation timed out. Try a simpler or smaller request.",
    is_directory: "The path is a directory. Use list_directory instead of read_file.",
    execution_error: "The tool failed. Review the input and try again with corrected parameters.",
    unknown_error: "An unexpected error occurred. Try an alternative approach.",
  };
  return suggestions[errorType] ?? suggestions.unknown_error;
}
```

**Explanation:** The function gives the model structured information: error type, message, the input that caused it, and a concrete suggestion for what to try next. This enables the model to self-correct rather than blindly retrying the same operation.

---

## Exercise 5
**Question:** A teammate proposes catching all tool errors and returning an empty string to the model so it "never crashes." Explain why this is worse.

**Answer:** Silent error swallowing (Principle 3) is the worst error-handling strategy for an AI agent. The model would receive empty strings and have no idea the tool failed — it might conclude a file is empty when it actually doesn't exist, or that a command produced no output when it actually crashed. Without error visibility, the model cannot self-correct (Principle 2), and every recovery cascade (Principle 5) becomes impossible because there's no error to cascade on. The result is silent, compounding failures: the model makes decisions on false data, those decisions cause more errors that also get swallowed, and the user sees a confident but completely wrong final result with no way to diagnose what went wrong.
