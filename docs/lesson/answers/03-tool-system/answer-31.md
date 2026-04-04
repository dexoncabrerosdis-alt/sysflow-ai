# Answers: Lesson 31 — Tool Error Handling

## Exercise 1
**Question:** Name all 7 error categories. For each, give a concrete example and how the model should respond.

**Answer:**

1. **`validation`** — The model sent malformed input. Example: passing a number for `file_path` instead of a string. Model response: fix the input types and retry.

2. **`permission`** — The tool isn't allowed to execute. Example: trying to write to a file the user hasn't approved. Model response: inform the user or try a different approach that doesn't need the permission.

3. **`execution`** — The tool ran but failed. Example: `Read` on a file that doesn't exist (`ENOENT`). Model response: adapt — search for the correct file path with Glob, or try an alternative file.

4. **`unknown_tool`** — The model requested a tool that doesn't exist. Example: calling `Delete` when no such tool is registered. Model response: check the available tool list in the error message and use the correct tool name.

5. **`timeout`** — The tool took too long. Example: a Bash command running `npm install` exceeds the 120-second timeout. Model response: break the operation into smaller parts or increase the timeout parameter.

6. **`abort`** — Cancelled by the user or system. Example: the user presses Ctrl+C while a Bash command is running. Model response: acknowledge the cancellation and ask the user how to proceed.

7. **`internal`** — A bug in the tool system itself. Example: a null pointer exception in the tool's `call()` function. Model response: try a completely different approach since this tool is broken.

---

## Exercise 2
**Challenge:** Implement `classifyToolError()`.

**Answer:**

```typescript
import { z } from "zod";

type ToolErrorCategory =
  | "validation"
  | "permission"
  | "execution"
  | "unknown_tool"
  | "timeout"
  | "abort"
  | "internal";

type ErrorContext = {
  abortSignal?: AbortSignal;
};

class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

class TimeoutError extends Error {
  code = "ETIMEDOUT";
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

function classifyToolError(
  error: unknown,
  context: ErrorContext
): ToolErrorCategory {
  // Zod validation errors
  if (error instanceof z.ZodError) {
    return "validation";
  }

  // Permission denial
  if (error instanceof PermissionDeniedError) {
    return "permission";
  }

  // Timeout — check class and error code
  if (error instanceof TimeoutError) {
    return "timeout";
  }
  if (error && typeof error === "object" && "code" in error && error.code === "ETIMEDOUT") {
    return "timeout";
  }

  // Abort signal — user or system cancellation
  if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
    return "abort";
  }
  if (context.abortSignal?.aborted) {
    return "abort";
  }

  // Known tool execution errors (file not found, command failed, etc.)
  if (error instanceof ToolExecutionError) {
    return "execution";
  }

  // Anything else is an internal bug
  return "internal";
}
```

**Explanation:** The function checks error types from most specific to least specific. Zod errors are checked first (most distinctive), then custom error classes, then duck-typed checks (error codes, names) for cases where the original class isn't available. The abort signal is checked as a fallback even if the error itself isn't an AbortError. Everything else falls through to "internal."

---

## Exercise 3
**Challenge:** Implement `handleUnknownTool()` with fuzzy name matching.

**Answer:**

```typescript
type ToolResult = {
  tool_use_id: string;
  content: string;
  is_error: boolean;
};

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[a.length][b.length];
}

function findClosestMatch(name: string, available: string[]): string | null {
  let bestMatch: string | null = null;
  let bestDistance = Infinity;

  const nameLower = name.toLowerCase();

  for (const candidate of available) {
    const distance = levenshteinDistance(nameLower, candidate.toLowerCase());
    if (distance < bestDistance && distance <= 3) {
      bestDistance = distance;
      bestMatch = candidate;
    }
  }

  return bestMatch;
}

function handleUnknownTool(
  block: { id: string; name: string },
  availableTools: string[]
): ToolResult {
  const suggestion = findClosestMatch(block.name, availableTools);

  let message = `Unknown tool: "${block.name}".`;
  message += `\n\nAvailable tools: ${availableTools.join(", ")}`;

  if (suggestion) {
    message += `\n\nDid you mean "${suggestion}"?`;
  }

  return {
    tool_use_id: block.id,
    content: message,
    is_error: true,
  };
}

// Example:
handleUnknownTool(
  { id: "toolu_1", name: "Readd" },
  ["Read", "Write", "Edit", "Grep", "Glob", "Bash"]
);
// → "Unknown tool: "Readd".\n\nAvailable tools: Read, Write, Edit, Grep, Glob, Bash\n\nDid you mean "Read"?"
```

**Explanation:** The function includes three components: the error message naming the unknown tool, the full available tool list (so the model can see all options), and a "did you mean?" suggestion using Levenshtein distance (max 3 edits). The suggestion is *not* auto-applied — that would be dangerous since `Delete` and `Edit` are very different tools. The model must explicitly choose.

---

## Exercise 4
**Question:** How does the `is_error: true` flag affect model behavior? What if errors were returned without it?

**Answer:** The `is_error: true` flag is a semantic signal that tells the model "this tool call failed — the content is an error message, not a success result." When the model sees this flag, it knows to:
1. Interpret the content as a problem description rather than data
2. Adjust its approach — retry with corrected input, try a different tool, or report the issue
3. Not base further reasoning on the "result" as if it were valid data

Without the flag, the model would treat error messages as successful output. For example, if Read fails with "File not found: /src/indx.ts" and this is returned *without* `is_error: true`, the model might think the file literally contains the text "File not found: /src/indx.ts" and try to parse it as code, leading to nonsensical behavior. Or worse, it might tell the user "I found the file and it says File not found" — confusing the error message with actual content. The flag is the difference between the model understanding "I need to fix this" and the model thinking "task complete."

---

## Exercise 5
**Challenge:** Write a 4-turn error recovery sequence with a file path typo.

**Answer:**

```json
// Turn 1 — Model tries to edit with a typo
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "I'll fix the import statement." },
    {
      "type": "tool_use",
      "id": "toolu_01",
      "name": "Edit",
      "input": {
        "file_path": "src/compnents/Header.tsx",
        "old_string": "import { utils } from '../old-utils';",
        "new_string": "import { utils } from '../utils';"
      }
    }
  ]
}

// Turn 2 — Error: file not found
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01",
      "content": "Tool \"Edit\" failed:\nFile not found: src/compnents/Header.tsx\n\nYou may retry or try a different approach.",
      "is_error": true
    }
  ]
}

// Turn 3 — Model searches for the correct path
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Let me find the correct path." },
    {
      "type": "tool_use",
      "id": "toolu_02",
      "name": "Glob",
      "input": { "pattern": "src/**/Header.tsx" }
    }
  ]
}

// Turn 4 — Glob result
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_02",
      "content": "src/components/Header.tsx"
    }
  ]
}

// Turn 5 — Model retries with correct path
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Found it — the directory is 'components', not 'compnents'." },
    {
      "type": "tool_use",
      "id": "toolu_03",
      "name": "Edit",
      "input": {
        "file_path": "src/components/Header.tsx",
        "old_string": "import { utils } from '../old-utils';",
        "new_string": "import { utils } from '../utils';"
      }
    }
  ]
}

// Turn 6 — Success
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_03",
      "content": "Successfully edited src/components/Header.tsx"
    }
  ]
}
```

**Explanation:** The model recovers from a typo ("compnents") by using Glob to search for the correct path, then retries the edit with the right path. No human intervention needed — the model reads the error, diagnoses the problem, and self-corrects.
