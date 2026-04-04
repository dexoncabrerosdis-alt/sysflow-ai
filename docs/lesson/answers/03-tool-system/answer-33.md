# Answers: Lesson 33 — Tool Result Processing

## Exercise 1
**Question:** Why do different tools have different `maxResultSizeChars` values? Give three examples.

**Answer:** Different tools produce fundamentally different output volumes, so a one-size-fits-all limit would either starve information-rich tools or flood the context with verbose outputs from simple tools.

1. **`TodoWrite` — 5,000 chars.** The output is a short confirmation message ("Task list updated with 3 items"). There's no reason to allocate a large budget — the result is always tiny.

2. **`Read` — 30,000 chars.** File contents can be large, but most useful files fit in 30K characters. This is enough for ~750 lines of code. Larger files should be read in chunks using `offset` and `limit`.

3. **`Grep` — 80,000 chars.** A codebase-wide regex search can match hundreds of files and thousands of lines. The model needs to see enough matches to make informed decisions, so the budget is generous. Even 80K may require truncation for broad searches.

The budgets also affect context window management and cost. Tool results are the single largest consumer of context tokens, so right-sizing budgets prevents any single result from dominating the conversation.

---

## Exercise 2
**Challenge:** Implement `handleOversizedResult()`.

**Answer:**

```typescript
import * as fs from "fs/promises";
import * as path from "path";

type Tool = {
  name: string;
  [key: string]: unknown;
};

type ToolContext = {
  options: { cwd: string };
};

async function handleOversizedResult(
  content: string,
  maxChars: number,
  tool: Tool,
  context: ToolContext
): Promise<string> {
  // 1. Persist the full result to disk
  const dir = path.join(context.options.cwd, ".claude", "tool-results");
  await fs.mkdir(dir, { recursive: true });

  const filename = `${tool.name}-${Date.now()}.txt`;
  const filepath = path.join(dir, filename);
  await fs.writeFile(filepath, content, "utf-8");

  // 2. Create a truncated preview
  const preview = content.slice(0, maxChars);

  // 3. Find a clean break point (don't cut mid-line)
  const lastNewline = preview.lastIndexOf("\n");
  const cleanPreview = lastNewline > 0 ? preview.slice(0, lastNewline) : preview;

  // 4. Add metadata about the truncation
  return [
    cleanPreview,
    "",
    "<preview_truncated>",
    `Full result (${content.length} chars) saved to: ${filepath}`,
    `Showing first ${cleanPreview.length} of ${content.length} characters.`,
    "</preview_truncated>",
  ].join("\n");
}

// Example usage:
// A 100K grep result with maxChars of 30K:
// → First 30K chars (cut at last newline) + metadata tag
// → Full 100K saved to .claude/tool-results/Grep-1709234567890.txt
```

**Explanation:** Four steps: (1) Save the full, untruncated result to disk using a timestamped filename. (2) Slice to the max character limit. (3) Find the last newline within the slice to avoid cutting mid-line — this ensures the preview contains only complete lines. (4) Append `<preview_truncated>` tags with the total size, saved path, and preview size. The model can later use Read to access the full file if needed.

---

## Exercise 3
**Challenge:** Implement `mapToolResultToToolResultBlockParam()`.

**Answer:**

```typescript
type ToolResultBlockParam = {
  type: "tool_result";
  tool_use_id: string;
  content: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } }>;
  is_error?: boolean;
};

// Text result variant
function mapToolResultToToolResultBlockParam(
  toolUseId: string,
  content: string,
  isError?: boolean
): ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [
      {
        type: "text",
        text: content,
      },
    ],
    ...(isError ? { is_error: true } : {}),
  };
}

// Image result variant
function mapImageResult(
  toolUseId: string,
  imageData: Buffer,
  mimeType: string
): ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: mimeType,
          data: imageData.toString("base64"),
        },
      },
    ],
  };
}

// Usage examples:
mapToolResultToToolResultBlockParam("toolu_1", "Lines: 42\nFile: index.ts");
// → { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "..." }] }

mapToolResultToToolResultBlockParam("toolu_2", "File not found: xyz.ts", true);
// → { type: "tool_result", tool_use_id: "toolu_2", content: [...], is_error: true }
```

**Explanation:** The API expects `content` as an array of content blocks, not a bare string. The text variant wraps the string in a `{ type: "text", text }` block. The `is_error` flag is spread conditionally — only included when `true` to keep the object clean. The image variant encodes binary data as base64 and specifies the MIME type.

---

## Exercise 4
**Question:** What are `<preview_truncated>` tags and why do they exist?

**Answer:** `<preview_truncated>` tags are XML-like markers appended to truncated tool results that serve two purposes:

1. **Signal to the model:** They tell the model "this result is incomplete — you're only seeing a preview." Without this signal, the model might treat the truncated result as the full output and draw incorrect conclusions. For example, if a Grep search found 500 matches but only the first 200 are shown, the model needs to know there are more.

2. **Machine-parseable metadata:** The tags contain the full result's file path and size. The model can extract the path (e.g., `.claude/tool-results/Grep-1709234567890.txt`) and use the Read tool to access specific sections of the full result. This creates a self-service mechanism — the model can dig deeper when the preview isn't enough.

If truncation occurred silently (no tags), the model would have no idea data was missing. It might: (a) make decisions based on incomplete data, (b) report to the user that "only N matches were found" when there were actually many more, (c) miss the correct result that happens to be beyond the truncation point. The tags transform a potentially misleading truncation into a transparent, actionable signal.
