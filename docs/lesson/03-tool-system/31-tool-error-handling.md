# Lesson 31: Tool Error Handling

## Errors Are Inevitable

Tools interact with the real world—filesystems, networks, processes. Things go
wrong. Files don't exist. Permissions are denied. Commands fail. Networks time out.
The model sends malformed input.

How an agent handles tool errors determines whether it recovers gracefully or
spirals into confusion. Claude Code's error handling is designed to give the model
the best possible chance of self-correcting.

## The Error Taxonomy

Not all errors are equal. Claude Code classifies them:

```typescript
type ToolErrorCategory =
  | "validation"      // bad input from the model
  | "permission"      // not allowed to execute
  | "execution"       // tool ran but failed
  | "unknown_tool"    // tool doesn't exist
  | "timeout"         // took too long
  | "abort"           // cancelled by user or system
  | "internal";       // bug in the tool system itself
```

Each category triggers different handling behavior.

## `classifyToolError`: Categorizing Errors

```typescript
function classifyToolError(error: unknown, context: ErrorContext): ToolErrorCategory {
  // Validation errors from Zod
  if (error instanceof z.ZodError) {
    return "validation";
  }

  // Permission denial
  if (error instanceof PermissionDeniedError) {
    return "permission";
  }

  // Timeout
  if (error instanceof TimeoutError || error.code === "ETIMEDOUT") {
    return "timeout";
  }

  // Abort signal
  if (error.name === "AbortError" || context.abortSignal?.aborted) {
    return "abort";
  }

  // File system errors, command failures, etc.
  if (error instanceof ToolExecutionError) {
    return "execution";
  }

  return "internal";
}
```

## Validation Errors: `formatZodValidationError`

When the model sends input that doesn't match the schema, the error message must
teach the model what went wrong:

```typescript
function formatZodValidationError(
  error: z.ZodError,
  tool: Tool
): string {
  const lines: string[] = [
    `Input validation error for tool "${tool.name}":`,
    "",
  ];

  for (const issue of error.issues) {
    const path = issue.path.length > 0
      ? issue.path.join(".")
      : "(root)";

    switch (issue.code) {
      case "invalid_type":
        lines.push(
          `  "${path}": Expected ${issue.expected}, got ${issue.received}`
        );
        break;
      case "unrecognized_keys":
        lines.push(
          `  Unexpected keys: ${issue.keys.join(", ")}`
        );
        break;
      case "invalid_enum_value":
        lines.push(
          `  "${path}": Must be one of: ${issue.options.join(", ")}`
        );
        break;
      default:
        lines.push(`  "${path}": ${issue.message}`);
    }
  }

  lines.push("");
  lines.push("Expected input schema:");
  lines.push(JSON.stringify(zodToJsonSchema(tool.inputSchema), null, 2));

  return lines.join("\n");
}
```

Example output:

```
Input validation error for tool "Edit":

  "file_path": Expected string, got number
  "old_string": Required

Expected input schema:
{
  "type": "object",
  "properties": {
    "file_path": { "type": "string", "description": "Path to the file" },
    "old_string": { "type": "string", "description": "Text to find" },
    "new_string": { "type": "string", "description": "Text to replace with" }
  },
  "required": ["file_path", "old_string", "new_string"]
}
```

This format is designed for the model. It tells it exactly:
1. Which fields are wrong and why
2. The full expected schema for reference

Models almost always fix validation errors on the next attempt.

## `buildSchemaNotSentHint`: Deferred Tool Schemas

Some tools use deferred schemas—their full schema isn't sent to the model upfront
to save tokens. When the model tries to use such a tool with wrong input, it gets
an extra hint:

```typescript
function buildSchemaNotSentHint(tool: Tool): string {
  return [
    `Note: The full schema for "${tool.name}" was not included in the initial`,
    "tool definitions to save context space. Here is the complete schema:",
    "",
    JSON.stringify(zodToJsonSchema(tool.inputSchema), null, 2),
    "",
    "Please retry with correct input matching this schema.",
  ].join("\n");
}
```

This handles the case where the model is "guessing" at a tool's interface because
it wasn't given the full schema.

## Unknown Tool Handling

When the model emits a tool_use for a tool that doesn't exist:

```typescript
function handleUnknownTool(block: ToolUseBlock, availableTools: string[]): ToolResult {
  const suggestion = findClosestMatch(block.name, availableTools);

  let message = `Unknown tool: "${block.name}". `;
  message += `Available tools: ${availableTools.join(", ")}`;

  if (suggestion) {
    message += `\n\nDid you mean "${suggestion}"?`;
  }

  return {
    tool_use_id: block.id,
    content: message,
    is_error: true,
  };
}
```

Important design choice: the error message includes the full list of available
tools. This prevents the model from repeatedly guessing wrong names.

**Note**: Claude Code does NOT silently convert an unknown tool name to the
closest match. That would be dangerous—`Delete` and `Edit` are very different
tools. Instead, it returns an error and lets the model choose.

## The `is_error` Flag

The Anthropic API supports an `is_error` flag on tool_result blocks:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_abc123",
  "content": "File not found: /home/user/nonexistent.ts",
  "is_error": true
}
```

When the model sees `is_error: true`, it knows something went wrong and can:
1. Retry with different input
2. Try a different approach
3. Report the error to the user
4. Ask the user for help

Without the flag, the model might interpret the error message as successful
output and produce nonsensical results.

## Error Flow Through the Pipeline

Here's the complete error handling flow:

```typescript
async function executeSingleTool(block: ToolUseBlock, tools, context): Promise<ToolResult> {
  // Stage 1: Tool lookup
  const tool = tools.get(block.name);
  if (!tool) {
    return handleUnknownTool(block, Array.from(tools.keys()));
  }

  // Stage 2: Schema validation
  const parsed = tool.inputSchema.safeParse(block.input);
  if (!parsed.success) {
    return {
      tool_use_id: block.id,
      content: formatZodValidationError(parsed.error, tool),
      is_error: true,
    };
  }

  // Stage 3: Custom validation
  if (tool.validateInput) {
    const validation = await tool.validateInput(parsed.data);
    if (!validation.valid) {
      return {
        tool_use_id: block.id,
        content: `Validation error: ${validation.message}`,
        is_error: true,
      };
    }
  }

  // Stage 4: Permission check
  if (tool.checkPermissions) {
    const perm = await tool.checkPermissions(parsed.data, context);
    if (!perm.allowed) {
      return {
        tool_use_id: block.id,
        content: `Permission denied: ${perm.reason}`,
        is_error: true,
      };
    }
  }

  // Stage 5: Execution
  try {
    const result = await tool.call(parsed.data, context);
    return {
      tool_use_id: block.id,
      content: typeof result === "string" ? result : result.content,
    };
  } catch (error) {
    const category = classifyToolError(error, { abortSignal: context.abortSignal });

    return {
      tool_use_id: block.id,
      content: formatErrorForModel(error, category, tool),
      is_error: true,
    };
  }
}
```

Errors are caught at every stage. No error can crash the pipeline.

## `formatErrorForModel`: Helpful Error Messages

Error messages for the model are different from error messages for humans:

```typescript
function formatErrorForModel(
  error: unknown,
  category: ToolErrorCategory,
  tool: Tool
): string {
  switch (category) {
    case "timeout":
      return [
        `Tool "${tool.name}" timed out after ${tool.timeout}ms.`,
        "Consider:",
        "- Breaking the operation into smaller parts",
        "- Using a different approach",
      ].join("\n");

    case "execution":
      return [
        `Tool "${tool.name}" failed:`,
        error.message,
        "",
        "You may retry or try a different approach.",
      ].join("\n");

    case "abort":
      return `Operation was cancelled.`;

    case "internal":
      return [
        `Internal error in tool "${tool.name}".`,
        "This is likely a bug. Please try a different approach.",
      ].join("\n");

    default:
      return `Error: ${error.message}`;
  }
}
```

The messages include **actionable guidance**—not just "it failed" but "here's what
you can do about it."

## How the Model Responds to Errors

After receiving a tool_result with `is_error: true`, the model typically:

1. **Reads the error message** to understand what went wrong
2. **Adjusts its approach** based on the error category:
   - Validation error → fix the input and retry
   - File not found → check the path, search for the right file
   - Permission denied → ask the user or try a different method
   - Command failure → analyze the output, fix the command
3. **Communicates** the issue to the user if it can't self-correct

This self-correction loop is one of the most powerful aspects of the agentic
architecture. The model doesn't just fail—it adapts.

## Error Recovery Example

```
Turn 1:
  Model: Edit({ file_path: "src/indx.ts", old: "foo", new: "bar" })
  Result: { is_error: true, content: "File not found: src/indx.ts" }

Turn 2:
  Model: Glob({ pattern: "src/ind*.ts" })
  Result: "src/index.ts"

Turn 3:
  Model: Edit({ file_path: "src/index.ts", old: "foo", new: "bar" })
  Result: "Successfully edited src/index.ts"
```

The model recovered from a typo by searching for the correct filename. No human
intervention required.

## Key Takeaways

1. Errors are classified into categories: validation, permission, execution, etc.
2. `formatZodValidationError` includes the full schema so the model can self-correct
3. Unknown tools get explicit error messages with the available tool list
4. The `is_error: true` flag tells the model something went wrong
5. Error messages include actionable guidance, not just failure descriptions
6. Models are remarkably good at self-correcting from tool errors

## What's Next

Beyond the standard execution pipeline, Claude Code supports hooks that can
intercept tool execution at multiple points. Let's explore the hook system.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Error Taxonomy

**Question:** Name all 7 error categories in Claude Code's `ToolErrorCategory` type. For each, give a concrete example of what would cause it and how the model should respond.

[View Answer](../../answers/03-tool-system/answer-31.md#exercise-1)

### Exercise 2 — Implement classifyToolError

**Challenge:** Implement the `classifyToolError(error, context)` function that categorizes an error into one of the 7 categories. Handle `ZodError`, `PermissionDeniedError`, `TimeoutError`, `AbortError`, `ToolExecutionError`, and fall through to `"internal"` for unknown errors.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-31.md#exercise-2)

### Exercise 3 — Implement handleUnknownTool

**Challenge:** Implement `handleUnknownTool()` that returns a helpful error when a tool doesn't exist. Include: the unknown name, the full list of available tools, and a "did you mean?" suggestion using Levenshtein distance to find the closest match.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-31.md#exercise-3)

### Exercise 4 — The is_error Flag

**Question:** How does the `is_error: true` flag on a `tool_result` affect model behavior? What would happen if errors were returned *without* this flag — how might the model misinterpret the result?

[View Answer](../../answers/03-tool-system/answer-31.md#exercise-4)

### Exercise 5 — Error Recovery Trace

**Challenge:** Write a complete 4-turn error recovery sequence where the model: (1) tries to edit a file with a typo in the path, (2) gets an error, (3) uses Glob to find the correct path, and (4) succeeds. Include full `tool_use` and `tool_result` JSON for each turn.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-31.md#exercise-5)

---

*Module 03: The Tool System — Lesson 31 of 35*
