# Lesson 33: Tool Result Processing

## The Last Mile

A tool has executed and returned a result. Before that result reaches the model,
it goes through processing: size limits are enforced, large results are persisted,
previews are generated, and the result is formatted into the correct API shape.

This is the "last mile" of the tool execution pipeline.

## `processToolResultBlock`: The Processing Pipeline

```typescript
async function processToolResultBlock(
  toolResult: ToolResult,
  tool: Tool,
  context: ToolContext
): Promise<ProcessedToolResult> {
  let content = toolResult.content;

  // 1. Stringify if needed
  if (typeof content !== "string") {
    content = JSON.stringify(content);
  }

  // 2. Check size limits
  const maxChars = tool.maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE;
  if (content.length > maxChars) {
    content = await handleOversizedResult(content, maxChars, tool, context);
  }

  // 3. Format into API shape
  return mapToolResultToToolResultBlockParam(toolResult.tool_use_id, content, toolResult.is_error);
}
```

## Per-Tool `maxResultSizeChars`

Different tools have different size budgets:

```typescript
// Small results — simple outputs
const TodoWriteTool = buildTool({
  name: "TodoWrite",
  maxResultSizeChars: 5_000,
  // ...
});

// Medium results — file contents
const FileReadTool = buildTool({
  name: "Read",
  maxResultSizeChars: 30_000,
  // ...
});

// Large results — search across codebase
const GrepTool = buildTool({
  name: "Grep",
  maxResultSizeChars: 80_000,
  // ...
});

// Very large results — command output
const BashTool = buildTool({
  name: "Bash",
  maxResultSizeChars: 100_000,
  // ...
});
```

The default when not specified:

```typescript
const DEFAULT_MAX_RESULT_SIZE = 30_000;  // 30K characters
```

Why different limits? A `TodoWrite` result is a short confirmation. A `Grep` result
might list hundreds of matches across a codebase. Giving every tool the same budget
would either starve information-rich tools or flood the context with verbose outputs
from simple tools.

## Handling Oversized Results

When a result exceeds the limit, Claude Code doesn't just truncate:

```typescript
async function handleOversizedResult(
  content: string,
  maxChars: number,
  tool: Tool,
  context: ToolContext
): Promise<string> {
  // 1. Persist the full result to disk
  const resultPath = await persistResultToDisk(content, tool, context);

  // 2. Create a truncated preview
  const preview = content.slice(0, maxChars);

  // 3. Find a clean break point (don't cut mid-line)
  const lastNewline = preview.lastIndexOf("\n");
  const cleanPreview = lastNewline > 0
    ? preview.slice(0, lastNewline)
    : preview;

  // 4. Add metadata about the truncation
  return [
    cleanPreview,
    "",
    `<preview_truncated>`,
    `Full result (${content.length} chars) saved to: ${resultPath}`,
    `Showing first ${cleanPreview.length} of ${content.length} characters.`,
    `</preview_truncated>`,
  ].join("\n");
}
```

### Large Result Persistence

The full, untruncated result is saved to disk:

```typescript
async function persistResultToDisk(
  content: string,
  tool: Tool,
  context: ToolContext
): Promise<string> {
  const dir = path.join(context.options.cwd, ".claude", "tool-results");
  await fs.mkdir(dir, { recursive: true });

  const filename = `${tool.name}-${Date.now()}.txt`;
  const filepath = path.join(dir, filename);

  await fs.writeFile(filepath, content, "utf-8");
  return filepath;
}
```

This means:
- The model sees a useful preview (not garbage cut mid-word)
- The full result is accessible if needed (the model can `Read` the saved file)
- The context window isn't overwhelmed

### Preview Tags

The `<preview_truncated>` tags serve two purposes:

1. **Signal to the model**: "This is incomplete. There's more data available."
2. **Machine-parseable**: The model can extract the file path and read the full
   result if it needs more context.

```
Input validation error for tool "Read":
  ...first 30,000 characters of a 150,000 character file...

<preview_truncated>
Full result (150000 chars) saved to: .claude/tool-results/Read-1709234567890.txt
Showing first 30000 of 150000 characters.
</preview_truncated>
```

## `mapToolResultToToolResultBlockParam`

This function formats the processed result into the API's expected shape:

```typescript
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
```

The API expects `content` to be an array of content blocks, not a bare string.
This wrapper handles the conversion.

For tools that return images (like screenshot tools):

```typescript
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
```

## `addToolResult`: Adding to Conversation

After processing, the result is added to the conversation history:

```typescript
function addToolResult(
  messages: Message[],
  toolResults: ProcessedToolResult[]
): Message[] {
  // Tool results go in a "user" message (that's the API convention)
  const userMessage: Message = {
    role: "user",
    content: toolResults.map((result) => ({
      type: "tool_result",
      tool_use_id: result.tool_use_id,
      content: result.content,
      ...(result.is_error ? { is_error: true } : {}),
    })),
  };

  return [...messages, userMessage];
}
```

Multiple tool results from the same turn go into a single user message:

```json
{
  "role": "user",
  "content": [
    { "type": "tool_result", "tool_use_id": "toolu_1", "content": "..." },
    { "type": "tool_result", "tool_use_id": "toolu_2", "content": "..." },
    { "type": "tool_result", "tool_use_id": "toolu_3", "content": "..." }
  ]
}
```

## GrowthBook Overrides for A/B Testing

Claude Code uses GrowthBook (a feature flag / A/B testing platform) to experiment
with result processing parameters:

```typescript
async function getMaxResultSize(tool: Tool): Promise<number> {
  // Check for experimental overrides
  const override = await growthbook.getFeatureValue(
    `tool-result-size-${tool.name}`,
    null
  );

  if (override !== null) {
    return override as number;
  }

  return tool.maxResultSizeChars ?? DEFAULT_MAX_RESULT_SIZE;
}
```

This allows the team to test different size limits in production:
- Does giving Grep 100K instead of 80K improve task success rates?
- Does limiting Read to 20K reduce context window pressure?

The A/B test runs transparently—users don't see the experiment, but the metrics
reveal which settings work better.

## The Complete Result Processing Flow

```
tool.call() returns result
       │
       ▼
  Is result a string?
  ├─ Yes → use as-is
  └─ No → JSON.stringify
       │
       ▼
  Check content.length vs maxResultSizeChars
  ├─ Under limit → continue
  └─ Over limit:
       ├─ Persist full result to disk
       ├─ Truncate at clean line break
       └─ Add <preview_truncated> tags
       │
       ▼
  mapToolResultToToolResultBlockParam()
  → { type: "tool_result", tool_use_id, content: [{ type: "text", text }] }
       │
       ▼
  addToolResult() → append to messages array as user message
```

## Practical Implications

### For context window management

Tool results are the single largest consumer of context window tokens. A model
that reads 10 files might consume 300K characters of context just from tool
results. Size limits prevent any single result from dominating.

### For cost

Longer context = more tokens = higher API costs. Processing results to fit within
budgets directly reduces costs per interaction.

### For model reasoning

Paradoxically, too much information can degrade model performance. A 100K-character
grep result makes it harder for the model to find the relevant lines than a 10K
preview focused on the most relevant matches.

## Key Takeaways

1. Tool results are processed before reaching the model: sized, truncated, formatted
2. `maxResultSizeChars` varies per tool—search tools get more, simple tools get less
3. Oversized results are persisted to disk with a preview sent to the model
4. `<preview_truncated>` tags signal incomplete results and provide the full path
5. All results are formatted into the `tool_result` API shape
6. A/B testing via GrowthBook allows experimentation with processing parameters

## What's Next

We've now covered the entire tool system from definition to execution to result
processing. Let's take a tour of all the built-in tools that ship with Claude Code.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Per-Tool Size Budgets

**Question:** Why do different tools have different `maxResultSizeChars` values? Give three specific examples of tools with different budgets and explain why each value is appropriate.

[View Answer](../../answers/03-tool-system/answer-33.md#exercise-1)

### Exercise 2 — Implement handleOversizedResult

**Challenge:** Implement the `handleOversizedResult()` function that: (a) saves the full result to disk at `.claude/tool-results/`, (b) truncates at the last newline before the limit, (c) adds `<preview_truncated>` tags with metadata. Return the processed string.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-33.md#exercise-2)

### Exercise 3 — Implement mapToolResultToToolResultBlockParam

**Challenge:** Implement the function that converts a processed tool result string and metadata into the API-ready `ToolResultBlockParam` format. Handle both text results and error results (with `is_error` flag). Also write a variant that handles image results with base64-encoded data.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-33.md#exercise-3)

### Exercise 4 — Preview Tags Purpose

**Question:** What are `<preview_truncated>` tags and why do they exist? How might the model use the information in these tags to access the full result? What would happen if truncation occurred silently without any tags?

[View Answer](../../answers/03-tool-system/answer-33.md#exercise-4)

---

*Module 03: The Tool System — Lesson 33 of 35*
