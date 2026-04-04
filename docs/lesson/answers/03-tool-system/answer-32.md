# Answers: Lesson 32 — Tool Hooks

## Exercise 1
**Question:** Name the three hook types, describe when each runs, and explain what each can do.

**Answer:**

1. **Pre-Tool Hooks (`PreToolHook`)** — Run *after* schema and custom validation pass but *before* permission checks and execution. Result fields:
   - `updatedInput` — modify the tool's input before execution
   - `preventExecution` — block the tool from running entirely
   - `stopReason` — message to return when execution is prevented
   - `additionalContext` — inject extra messages the model will see
   - `overridePermission` — bypass or enforce the normal permission check

2. **Post-Tool Hooks (`PostToolHook`)** — Run *after* successful tool execution. Result fields:
   - `additionalContext` — inject follow-up guidance or status messages
   - `modifiedResult` — replace or alter the tool's return value

3. **Post-Failure Hooks (`PostFailureHook`)** — Run *after* a tool fails. Result fields:
   - `additionalContext` — inject context about the failure
   - `overrideResult` — provide a fallback result instead of the error
   - `shouldRetry` — trigger an automatic retry of the tool

---

## Exercise 2
**Challenge:** Write a pre-tool hook that enforces a file path allowlist.

**Answer:**

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
  overridePermission?: { allowed: boolean };
};

function createPathAllowlistHook(allowedPaths: string[]): PreToolHook {
  return async (toolName, input, context): Promise<PreHookResult> => {
    // Only apply to file-modifying tools
    if (toolName !== "Write" && toolName !== "Edit") {
      return {};
    }

    const typedInput = input as { file_path: string };
    const filePath = typedInput.file_path;

    // Resolve to absolute path for consistent comparison
    const resolved = require("path").resolve(context.options.cwd, filePath);

    // Check if the path falls under any allowed prefix
    const isAllowed = allowedPaths.some((allowed) => {
      const resolvedAllowed = require("path").resolve(context.options.cwd, allowed);
      return resolved.startsWith(resolvedAllowed);
    });

    if (!isAllowed) {
      return {
        preventExecution: true,
        stopReason:
          `File path "${filePath}" is outside the allowed directories.\n` +
          `Allowed paths: ${allowedPaths.join(", ")}\n` +
          `Please only modify files within the allowed directories.`,
      };
    }

    return {};
  };
}

// Usage:
const hook = createPathAllowlistHook(["src/", "tests/", "docs/"]);
// Write to "src/index.ts" → allowed
// Write to "node_modules/foo.js" → prevented
// Edit "config/secret.json" → prevented
```

**Explanation:** The hook factory takes an array of allowed path prefixes and returns a hook function. It only fires for Write and Edit tools. Paths are resolved to absolute to prevent bypass via relative paths. If the file is outside all allowed prefixes, `preventExecution: true` blocks the tool and the `stopReason` tells the model exactly which directories are allowed. Read tools are not blocked since they don't modify anything.

---

## Exercise 3
**Challenge:** Write a post-tool hook that logs file modifications.

**Answer:**

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

function createFileTrackingHook(threshold: number = 5): PostToolHook {
  const modifiedFiles = new Set<string>();

  return async (toolName, input, result, context): Promise<PostHookResult> => {
    // Track file modifications from Write and Edit tools
    if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
      const typedInput = input as { file_path?: string; notebook_path?: string };
      const filePath = typedInput.file_path ?? typedInput.notebook_path;

      if (filePath) {
        modifiedFiles.add(filePath);
      }
    }

    // When threshold is exceeded, remind model to test
    if (modifiedFiles.size >= threshold) {
      const fileList = Array.from(modifiedFiles).join(", ");
      return {
        additionalContext: [
          `You have modified ${modifiedFiles.size} files: ${fileList}. ` +
          `Consider running tests to verify your changes are correct ` +
          `before making more modifications.`,
        ],
      };
    }

    return {};
  };
}

// Usage:
const hook = createFileTrackingHook(3);
// After 3+ files modified, model sees: "You have modified 3 files: ..."
```

**Explanation:** The hook uses a closure to maintain a `Set<string>` of modified files across calls. It fires for Write, Edit, and NotebookEdit tools, extracting the file path from each. Once the modification count hits the threshold, it injects an `additionalContext` reminder. The Set ensures each file is counted once even if modified multiple times.

---

## Exercise 4
**Challenge:** Implement `runPreHooks()` that merges multiple hook results.

**Answer:**

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

    // Prevention is sticky — once prevented, stops the chain
    if (result.preventExecution) {
      mergedResult.preventExecution = true;
      mergedResult.stopReason = result.stopReason;
      break; // No point running more hooks
    }

    // Context accumulates — all hooks' messages are included
    if (result.additionalContext) {
      mergedResult.additionalContext = [
        ...(mergedResult.additionalContext ?? []),
        ...result.additionalContext,
      ];
    }

    // Permission override — last one wins
    if (result.overridePermission) {
      mergedResult.overridePermission = result.overridePermission;
    }
  }

  return mergedResult;
}
```

**Explanation:** The function iterates hooks in registration order. Four merge rules: (1) `updatedInput` chains — `currentInput` is updated and subsequent hooks see the modified input. (2) `preventExecution` is sticky — the first hook to prevent stops the chain via `break`. (3) `additionalContext` accumulates via array spread. (4) `overridePermission` uses last-write-wins — the final hook to set it determines the permission.

---

## Exercise 5
**Question:** Three pre-hooks scenario: Hook A normalizes paths, Hook B checks an allowlist, Hook C logs. What happens?

**Answer:**

**If Hook B approves:**
1. Hook A runs, normalizes `./src/../src/index.ts` to `src/index.ts`, returns `{ updatedInput: { file_path: "src/index.ts" } }`
2. Hook B runs with the **normalized** path `src/index.ts` (not the original), checks the allowlist, approves. Returns `{}`
3. Hook C runs with the **normalized** path `src/index.ts`, logs the operation. Returns `{ additionalContext: ["Logged: Write to src/index.ts"] }`

Final merged result: `{ updatedInput: { file_path: "src/index.ts" }, additionalContext: ["Logged: Write to src/index.ts"] }`

Hook C sees the path that Hook A normalized, because input updates chain.

**If Hook B prevents execution:**
1. Hook A runs, normalizes the path. Returns `{ updatedInput: ... }`
2. Hook B runs with the normalized path, rejects it. Returns `{ preventExecution: true, stopReason: "Path not allowed" }`
3. Hook C **does NOT run** — the `break` after prevention stops the loop

Final merged result: `{ updatedInput: ..., preventExecution: true, stopReason: "Path not allowed" }`

The key insight: prevention is sticky and terminates the hook chain. This prevents wasted work — if the tool won't execute, there's no point logging or doing further preprocessing.
