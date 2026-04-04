# Answers: Lesson 23 — Input Validation with Zod

## Exercise 1
**Question:** Explain why Claude Code uses `safeParse` exclusively instead of `parse`. What would happen if `parse` were used and the model sent invalid input?

**Answer:** `parse` throws a `ZodError` exception on validation failure, while `safeParse` returns a result object with `success: boolean` and either `data` or `error`. Claude Code uses `safeParse` because a thrown exception would crash the tool execution pipeline — the error would propagate up the call stack, potentially aborting the entire agent turn instead of gracefully handling a single tool failure. With `safeParse`, validation failures are caught inline, converted into a helpful error message, and sent back to the model as a `tool_result` with `is_error: true`. The model then sees exactly what it did wrong (with the full expected schema) and can correct itself on the next attempt. Using `parse` would turn a recoverable input mistake into a fatal crash.

---

## Exercise 2
**Challenge:** Write a Zod schema for a `SearchReplace` tool.

**Answer:**

```typescript
import { z } from "zod";

const SearchReplaceSchema = z.object({
  file_path: z.string().describe(
    "The absolute path of the file to perform search and replace on"
  ),
  search: z.string().min(1).describe(
    "The text to search for. Must not be empty."
  ),
  replace: z.string().describe(
    "The text to replace matches with. Can be empty to delete matches."
  ),
  case_sensitive: z.boolean().optional().default(true).describe(
    "Whether the search is case-sensitive. Defaults to true."
  ),
  max_replacements: z.number().int().positive().optional().describe(
    "Maximum number of replacements to make. Omit to replace all occurrences."
  ),
});

type SearchReplaceInput = z.infer<typeof SearchReplaceSchema>;
// { file_path: string; search: string; replace: string;
//   case_sensitive: boolean; max_replacements?: number }
```

**Explanation:** `search` uses `.min(1)` to prevent empty search strings. `replace` allows empty strings (for deletion). `case_sensitive` has `.default(true)` so the type after parsing is `boolean`, not `boolean | undefined`. `max_replacements` uses `.int().positive()` to ensure it's a whole number > 0. Every field has `.describe()` for the model.

---

## Exercise 3
**Challenge:** Convert the given Zod schema to equivalent JSON Schema.

**Answer:**

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "SQL query to execute"
    },
    "database": {
      "type": "string",
      "enum": ["primary", "replica"],
      "description": "Target database"
    },
    "timeout": {
      "type": "number",
      "minimum": 100,
      "maximum": 30000,
      "description": "Timeout in ms"
    }
  },
  "required": ["query", "database"]
}
```

**Explanation:** `z.string()` becomes `"type": "string"`. `z.enum(["primary", "replica"])` becomes `"type": "string"` with an `"enum"` array. `z.number().min(100).max(30000)` becomes `"type": "number"` with `"minimum"` and `"maximum"`. The `.optional()` on timeout means it's NOT in the `required` array. `.describe()` values become `"description"` fields.

---

## Exercise 4
**Challenge:** Write a `formatValidationError` function and test it.

**Answer:**

```typescript
import { z } from "zod";

function formatValidationError(error: z.ZodError): string {
  const lines: string[] = ["Validation failed:"];

  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";

    switch (issue.code) {
      case "invalid_type":
        lines.push(`  - "${path}": Expected ${issue.expected}, got ${issue.received}`);
        break;
      case "too_small":
        lines.push(`  - "${path}": Value is too small (minimum: ${issue.minimum})`);
        break;
      case "invalid_enum_value":
        lines.push(`  - "${path}": Must be one of: ${issue.options.join(", ")}`);
        break;
      default:
        lines.push(`  - "${path}": ${issue.message}`);
    }
  }

  return lines.join("\n");
}

// Test it:
const schema = z.object({
  name: z.string(),
  age: z.number().min(0),
  role: z.enum(["admin", "user"]),
});

const result = schema.safeParse({ name: 42, age: -5, role: "superuser" });
if (!result.success) {
  console.log(formatValidationError(result.error));
}
// Output:
// Validation failed:
//   - "name": Expected string, got number
//   - "age": Value is too small (minimum: 0)
//   - "role": Must be one of: admin, user
```

**Explanation:** The function iterates over `error.issues`, switches on the `code` property for specific formatting, and falls back to the generic `issue.message` for unhandled codes. The path is joined with dots for nested objects.

---

## Exercise 5
**Question:** Compare the two `.describe()` values and explain which is better for model usage.

**Answer:** Option (b) — `"Absolute path to the directory to search. Defaults to the project root if not provided."` — is vastly better. Option (a) `"The path"` tells the model almost nothing: what kind of path? Relative or absolute? File or directory? What happens if it's omitted? The model would have to guess, leading to mistakes like passing a relative path or a file path when a directory is expected. Option (b) answers all three questions: it's an absolute path, it's a directory, and it has a default behavior. This precision directly reduces tool usage errors. The `.describe()` text is the model's only documentation for how to use a field — the richer and more specific it is, the better the model will use the tool.
