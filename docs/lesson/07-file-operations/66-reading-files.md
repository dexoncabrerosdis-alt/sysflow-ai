# Lesson 66: Reading Files — The Most-Used Tool

## Why FileReadTool Is Tool #1

If you profile a real coding agent session, one tool dominates every other: **file reading**. Before the agent can edit code, it must read it. Before it can answer questions, it must read context. Before it can run tests, it must understand what to test. FileReadTool is the foundation everything else builds on.

In this lesson, we'll examine exactly how Claude Code's FileReadTool works — its schema, its safety properties, how it handles different file types, and the caching layer that prevents redundant reads.

---

## The Zod Input Schema

```typescript
const inputSchema = z.strictObject({
  file_path: z
    .string()
    .describe("The absolute path to the file to read"),
  offset: z
    .number()
    .int()
    .optional()
    .describe(
      "Line offset to start reading from. Positive values are 1-indexed " +
      "from the start. Negative values count backwards from end (-1 = last line)."
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max number of lines to read from the offset"),
});
```

Three optional parameters control partial reads — critical for large files that would overwhelm the context window. The `offset` parameter supports negative indexing: `-1` reads from the last line, `-50` reads the last 50 lines. This mirrors Python's slice semantics that the model already understands.

---

## Safety Properties

FileReadTool declares two important properties:

```typescript
export class FileReadTool extends Tool {
  get isConcurrencySafe(): boolean {
    return true;  // Multiple reads can run simultaneously
  }

  get isReadOnly(): boolean {
    return true;  // Never modifies files
  }
}
```

Why do these matter? Recall from Module 06 that the agent loop can run multiple tool calls in parallel when the model requests them. `isConcurrencySafe: true` means the orchestrator won't serialize reads — the agent can read five files simultaneously. `isReadOnly: true` means reads never need user permission (which we'll explore in Module 09).

---

## How Different File Types Are Handled

FileReadTool doesn't just dump raw bytes. It detects the file type and processes accordingly:

### Text Files: Line-Numbered Output

For regular text files (`.ts`, `.py`, `.md`, `.json`, etc.), the tool prepends line numbers:

```typescript
function formatTextContent(content: string, offset: number): string {
  const lines = content.split("\n");
  const startLine = offset || 1;
  return lines
    .map((line, i) => {
      const lineNum = String(startLine + i).padStart(6, " ");
      return `${lineNum}|${line}`;
    })
    .join("\n");
}
```

Output looks like:

```
     1|import { z } from "zod";
     2|import { Tool } from "../Tool";
     3|
     4|export class FileReadTool extends Tool {
     5|  name = "Read";
```

Line numbers are essential — when the model later needs to edit a file, it can reference specific line ranges. The 6-character padding keeps alignment clean for files up to 999,999 lines.

### Images: Base64 Encoding

When the path points to an image (`.png`, `.jpg`, `.gif`, `.webp`, `.svg`), FileReadTool returns it as a base64-encoded content block:

```typescript
if (isImageFile(filePath)) {
  const imageBuffer = await fs.readFile(filePath);
  const base64 = imageBuffer.toString("base64");
  const mimeType = getMimeType(filePath);
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mimeType,
      data: base64,
    },
  };
}
```

This lets multimodal models actually *see* the image — useful for UI bugs, screenshot comparisons, or understanding diagram files.

### PDFs: Page-Range Extraction

PDFs get special treatment with page-range support:

```typescript
if (isPdfFile(filePath)) {
  const pdfBuffer = await fs.readFile(filePath);
  const text = await extractPdfText(pdfBuffer, {
    startPage: offset,
    maxPages: limit,
  });
  return formatTextContent(text, 1);
}
```

The `offset` and `limit` parameters are reinterpreted as page numbers for PDFs. This prevents loading a 500-page PDF into context when you only need page 3.

### Jupyter Notebooks: Structured Cell Output

`.ipynb` files are JSON internally, but the tool renders them as readable cell-by-cell output:

```typescript
if (isNotebookFile(filePath)) {
  const notebook = JSON.parse(content);
  return notebook.cells
    .map((cell: NotebookCell, index: number) => {
      const cellType = cell.cell_type; // "code", "markdown", "raw"
      const source = cell.source.join("");
      return `--- Cell ${index} [${cellType}] ---\n${source}`;
    })
    .join("\n\n");
}
```

This gives the model structured understanding of notebook flow without exposing raw JSON with execution counts, metadata, and output blobs.

---

## The maxSizeBytes Limit

Files can be enormous. A minified JavaScript bundle might be 10MB. A database dump could be gigabytes. FileReadTool enforces a hard limit:

```typescript
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

async function validateFileSize(filePath: string): Promise<void> {
  const stats = await fs.stat(filePath);
  if (stats.size > MAX_FILE_SIZE_BYTES) {
    throw new ToolError(
      `File ${filePath} is ${formatBytes(stats.size)}, which exceeds ` +
      `the maximum readable size of ${formatBytes(MAX_FILE_SIZE_BYTES)}. ` +
      `Use offset and limit to read a portion of the file.`
    );
  }
}
```

When a file exceeds the limit, the error message teaches the model to use `offset`/`limit` for partial reads. This is an example of **error messages as prompts** — guiding the model toward correct behavior rather than just failing.

---

## The readFileState Cache

Every file read is recorded in a shared state object called `readFileState`:

```typescript
interface ReadFileEntry {
  content: string;
  mtime: number;      // File modification time at read
  readTime: number;   // When the agent read it
  offset?: number;    // Partial read start
  limit?: number;     // Partial read length
}

const readFileState: Map<string, ReadFileEntry> = new Map();
```

After every successful read:

```typescript
async function executeRead(filePath: string, offset?: number, limit?: number) {
  const content = await fs.readFile(filePath, "utf-8");
  const stats = await fs.stat(filePath);

  readFileState.set(filePath, {
    content,
    mtime: stats.mtimeMs,
    readTime: Date.now(),
    offset,
    limit,
  });

  return formatOutput(content, offset, limit);
}
```

Why does this matter? The **FileEditTool** (Lesson 70) checks `readFileState` before allowing edits. If you haven't read a file, you can't edit it. This prevents the single most common agent failure: **hallucinated edits to files the model has never seen**.

The `mtime` field catches a subtler problem: the file changed on disk between reading and editing. Maybe the user saved manually, or another tool modified it. The edit validation compares the current `mtime` against the stored value.

---

## Putting It Together: A Real Read Flow

Here's what happens when the model calls `Read({ file_path: "/src/utils.ts" })`:

1. **Path validation** — Resolve to absolute, check it exists, check permissions
2. **Size check** — Reject files over `maxSizeBytes`
3. **Type detection** — Is it text? Image? PDF? Notebook?
4. **Content loading** — Read with appropriate strategy
5. **Formatting** — Add line numbers, apply offset/limit
6. **Cache update** — Store in `readFileState` with mtime
7. **Return** — Formatted content goes back to the model

```
Model requests Read("/src/utils.ts")
         │
         ▼
  ┌─────────────┐
  │ Validate path│ → ToolError if not found
  └──────┬──────┘
         ▼
  ┌─────────────┐
  │ Check size   │ → ToolError if > 10MB
  └──────┬──────┘
         ▼
  ┌─────────────┐
  │ Detect type  │ → text / image / pdf / notebook
  └──────┬──────┘
         ▼
  ┌─────────────┐
  │ Read + format│ → Line numbers for text
  └──────┬──────┘
         ▼
  ┌─────────────┐
  │ Update cache │ → readFileState.set(...)
  └──────┬──────┘
         ▼
     Return to model
```

---

## Key Takeaways

1. **FileReadTool is the most-called tool** in any agent session — reading is a prerequisite for editing, testing, and understanding.

2. **Concurrency-safe and read-only** — multiple reads can run in parallel without permission checks.

3. **Type-aware processing** — text gets line numbers, images get base64 encoding, PDFs support page ranges, notebooks render as cells.

4. **Size limits with helpful errors** — the error message itself teaches the model to use partial reads.

5. **The readFileState cache** — every read is recorded, enabling the edit validation system we'll study in Lesson 70.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — File Type Routing
**Question:** Explain how FileReadTool handles these four file types differently: `.ts`, `.png`, `.pdf`, `.ipynb`. For each, describe the output format and what information is preserved or lost.

[View Answer](../../answers/07-file-operations/answer-66.md#exercise-1)

### Exercise 2 — Line Number Formatter
**Challenge:** Write a `formatTextContent(content: string, startLine: number)` function that prepends right-aligned, 6-character-padded line numbers separated by `|` to each line. Handle the case where `startLine` could be negative (counting from end).

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-66.md#exercise-2)

### Exercise 3 — ReadFileState Cache
**Challenge:** Implement a `ReadFileStateCache` class with methods: `recordRead(filePath: string, content: string, mtime: number, offset?: number, limit?: number)`, `hasBeenRead(filePath: string): boolean`, and `getEntry(filePath: string): ReadFileEntry | null`. Include the full `ReadFileEntry` interface.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-66.md#exercise-3)

### Exercise 4 — Size Guard with Instructive Errors
**Challenge:** Write a `validateFileSize(filePath: string, stats: { size: number })` function that throws a descriptive error if the file exceeds 10MB. The error message should suggest using `offset` and `limit` for partial reads, following the "error messages as prompts" pattern.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-66.md#exercise-4)

---

## What's Next

Now that we understand how files are read, Lesson 67 covers the other direction: **writing files** with FileWriteTool. You'll see atomic writes, encoding detection, and how the readFileState cache gets updated when new content is written.
