# Lesson 32: Tool Hooks

## Intercepting Tool Execution

The tool execution pipeline from Lesson 31 is clean: validate → check permissions →
execute → return result. But what if you need to:

- Inject extra context before a tool runs?
- Modify the tool's input on the fly?
- Prevent a tool from running based on custom logic?
- Append guidance after a tool completes?
- Handle specific error patterns specially?

This is what **tool hooks** provide—extension points that let you intercept and
modify tool execution without changing the tools themselves.

## The Three Hook Types

Claude Code supports three types of hooks:

```typescript
type ToolHooks = {
  preToolExecution?: PreToolHook[];
  postToolExecution?: PostToolHook[];
  postToolFailure?: PostFailureHook[];
};
```

### 1. Pre-Tool Hooks

Run **before** the tool executes, after validation passes:

```typescript
type PreToolHook = (
  toolName: string,
  input: unknown,
  context: ToolContext
) => Promise<PreHookResult>;

type PreHookResult = {
  updatedInput?: unknown;
  preventExecution?: boolean;
  stopReason?: string;
  additionalContext?: string[];
  overridePermission?: PermissionCheckResult;
};
```

### 2. Post-Tool Hooks

Run **after** the tool executes successfully:

```typescript
type PostToolHook = (
  toolName: string,
  input: unknown,
  result: ToolResult,
  context: ToolContext
) => Promise<PostHookResult>;

type PostHookResult = {
  additionalContext?: string[];
  modifiedResult?: ToolResult;
};
```

### 3. Post-Failure Hooks

Run **after** the tool fails:

```typescript
type PostFailureHook = (
  toolName: string,
  input: unknown,
  error: unknown,
  context: ToolContext
) => Promise<PostFailureHookResult>;

type PostFailureHookResult = {
  additionalContext?: string[];
  overrideResult?: ToolResult;
  shouldRetry?: boolean;
};
```

## Pre-Tool Hook: `PreHookResult` in Detail

The pre-hook result is the most powerful. Let's examine each field:

### `updatedInput`

Modify the tool's input before execution:

```typescript
const normalizePathsHook: PreToolHook = async (toolName, input, context) => {
  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    const typedInput = input as { file_path: string };
    return {
      updatedInput: {
        ...typedInput,
        file_path: path.resolve(context.options.cwd, typedInput.file_path),
      },
    };
  }
  return {};
};
```

This hook converts relative paths to absolute paths before any file tool executes.

### `preventExecution`

Stop the tool from running entirely:

```typescript
const readOnlyModeHook: PreToolHook = async (toolName, input, context) => {
  const tool = context.options.tools.find((t) => t.name === toolName);
  if (tool && !tool.isReadOnly) {
    return {
      preventExecution: true,
      stopReason: "Agent is in read-only mode. Write operations are disabled.",
    };
  }
  return {};
};
```

When `preventExecution` is true, the tool never runs. The `stopReason` is sent
back to the model as the tool result.

### `additionalContext`

Inject context messages that the model will see:

```typescript
const fileChangeWarningHook: PreToolHook = async (toolName, input, context) => {
  if (toolName === "Edit") {
    const typedInput = input as { file_path: string };
    const lastRead = context.readFileTimestamps.get(typedInput.file_path);
    const currentMtime = (await fs.stat(typedInput.file_path)).mtimeMs;

    if (lastRead && currentMtime > lastRead) {
      return {
        additionalContext: [
          `Warning: ${typedInput.file_path} has been modified since you last read it. ` +
          "Consider reading it again before editing.",
        ],
      };
    }
  }
  return {};
};
```

Additional context is appended to the conversation. The tool still executes, but
the model receives extra information.

### `overridePermission`

Bypass or enforce the normal permission check:

```typescript
const trustedDirectoryHook: PreToolHook = async (toolName, input, context) => {
  if (toolName === "Write") {
    const typedInput = input as { file_path: string };
    if (typedInput.file_path.startsWith("/tmp/sandbox/")) {
      return {
        overridePermission: { allowed: true },
      };
    }
  }
  return {};
};
```

This auto-approves writes to a trusted sandbox directory.

## Post-Tool Hook: Injecting Follow-Up Context

Post-tool hooks run after successful execution:

```typescript
const editVerificationHook: PostToolHook = async (toolName, input, result, context) => {
  if (toolName === "Edit") {
    return {
      additionalContext: [
        "Remember to verify your edit by reading the file or running tests.",
      ],
    };
  }
  return {};
};
```

A more sophisticated example—tracking file modifications:

```typescript
const fileTrackingHook: PostToolHook = async (toolName, input, result, context) => {
  if (toolName === "Write" || toolName === "Edit") {
    const typedInput = input as { file_path: string };
    context.modifiedFiles.add(typedInput.file_path);

    if (context.modifiedFiles.size > 5) {
      return {
        additionalContext: [
          `You have modified ${context.modifiedFiles.size} files so far: ` +
          Array.from(context.modifiedFiles).join(", ") +
          ". Consider running tests to verify your changes.",
        ],
      };
    }
  }
  return {};
};
```

## Post-Failure Hook: Error Recovery

Post-failure hooks can transform errors or trigger retries:

```typescript
const autoRetryHook: PostFailureHook = async (toolName, input, error, context) => {
  if (toolName === "WebFetch" && error.code === "ECONNRESET") {
    return {
      shouldRetry: true,
      additionalContext: [
        "Network connection was reset. Retrying automatically.",
      ],
    };
  }
  return {};
};
```

Or provide a fallback result:

```typescript
const fallbackHook: PostFailureHook = async (toolName, input, error, context) => {
  if (toolName === "Read" && error.code === "ENOENT") {
    return {
      overrideResult: {
        tool_use_id: context.toolUseId,
        content: `File does not exist: ${input.file_path}. ` +
          "Use Glob to search for the correct path.",
      },
    };
  }
  return {};
};
```

## Hook Execution Order

Hooks run in a specific sequence within the tool pipeline:

```
1. Schema validation (Zod safeParse)
2. Custom validateInput()
3. ▶ PRE-TOOL HOOKS ◀
   - updatedInput applied
   - preventExecution checked
   - overridePermission applied
   - additionalContext queued
4. Permission check (unless overridden)
5. Tool execution (call())
   ├─ Success → ▶ POST-TOOL HOOKS ◀
   │             - additionalContext queued
   │             - modifiedResult applied
   └─ Failure → ▶ POST-FAILURE HOOKS ◀
                 - shouldRetry checked
                 - overrideResult applied
                 - additionalContext queued
6. Result processing
```

## Multiple Hooks

Multiple hooks of the same type run in registration order. Their results are
merged:

```typescript
async function runPreHooks(
  hooks: PreToolHook[],
  toolName: string,
  input: unknown,
  context: ToolContext
): Promise<PreHookResult> {
  let mergedResult: PreHookResult = {};
  let currentInput = input;

  for (const hook of hooks) {
    const result = await hook(toolName, currentInput, context);

    // Input updates chain — each hook sees the previous hook's changes
    if (result.updatedInput !== undefined) {
      currentInput = result.updatedInput;
      mergedResult.updatedInput = currentInput;
    }

    // Prevention is sticky — once prevented, stays prevented
    if (result.preventExecution) {
      mergedResult.preventExecution = true;
      mergedResult.stopReason = result.stopReason;
      break;  // no point running more hooks
    }

    // Context accumulates
    if (result.additionalContext) {
      mergedResult.additionalContext = [
        ...(mergedResult.additionalContext ?? []),
        ...result.additionalContext,
      ];
    }

    // Last permission override wins
    if (result.overridePermission) {
      mergedResult.overridePermission = result.overridePermission;
    }
  }

  return mergedResult;
}
```

Key behaviors:
- **Input updates chain**: each hook sees changes from previous hooks
- **Prevention is sticky**: if any hook prevents execution, it's prevented
- **Context accumulates**: all hooks' context messages are included
- **Permission override**: last one wins

## Real-World Hook Examples

### Auto-formatting after writes

```typescript
const autoFormatHook: PostToolHook = async (toolName, input, result, context) => {
  if (toolName === "Write" && input.file_path.endsWith(".ts")) {
    try {
      await exec(`prettier --write "${input.file_path}"`);
      return {
        additionalContext: ["File was auto-formatted with Prettier."],
      };
    } catch {
      return {};
    }
  }
  return {};
};
```

### Rate limiting web requests

```typescript
let lastFetchTime = 0;

const rateLimitHook: PreToolHook = async (toolName, input, context) => {
  if (toolName === "WebFetch") {
    const now = Date.now();
    const elapsed = now - lastFetchTime;
    if (elapsed < 1000) {
      await sleep(1000 - elapsed);
    }
    lastFetchTime = Date.now();
  }
  return {};
};
```

## Key Takeaways

1. Hooks intercept tool execution at three points: pre, post-success, post-failure
2. Pre-hooks can modify input, prevent execution, override permissions, and add context
3. Post-hooks can modify results and inject follow-up guidance
4. Post-failure hooks can trigger retries or provide fallback results
5. Multiple hooks compose: input changes chain, context accumulates, prevention is sticky
6. Hooks enable extensibility without modifying individual tools

## What's Next

After a tool executes, its result needs to be processed—sized, possibly truncated,
and formatted for the model. Let's look at tool result processing.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Three Hook Types

**Question:** Name the three hook types, describe when each runs in the pipeline, and explain what each can do (what fields does its result type contain?).

[View Answer](../../answers/03-tool-system/answer-32.md#exercise-1)

### Exercise 2 — Path Allowlist Hook

**Challenge:** Write a pre-tool hook that enforces a file path allowlist. The hook should: (a) only apply to Write and Edit tools, (b) check if the `file_path` starts with any path in an `allowedPaths` array, (c) prevent execution with a clear message if the path is outside the allowlist.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-32.md#exercise-2)

### Exercise 3 — File Modification Logger

**Challenge:** Write a post-tool hook that logs all file modifications. Track modified files in a `Set<string>`, and when the count exceeds a threshold, inject an `additionalContext` message reminding the model to run tests.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-32.md#exercise-3)

### Exercise 4 — Implement runPreHooks

**Challenge:** Implement the `runPreHooks()` function that runs an array of pre-hooks and merges their results. Follow these rules: input updates chain (each hook sees previous changes), prevention is sticky (once prevented, stays prevented), context accumulates (all messages included), and the last permission override wins.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-32.md#exercise-4)

### Exercise 5 — Hook Composition Scenario

**Question:** Three pre-hooks are registered for the Write tool: Hook A normalizes paths, Hook B checks an allowlist (may prevent execution), and Hook C logs the operation. If Hook A modifies the path and Hook B approves, what does Hook C see as input? If Hook B prevents execution, does Hook C run? Explain the merge semantics.

[View Answer](../../answers/03-tool-system/answer-32.md#exercise-5)

---

*Module 03: The Tool System — Lesson 32 of 35*
