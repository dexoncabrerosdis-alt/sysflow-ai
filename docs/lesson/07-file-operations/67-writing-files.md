# Lesson 67: Writing Files — FileWriteTool

## From Reading to Writing

Lesson 66 covered the read side. Now we tackle the inverse: **creating and overwriting files**. FileWriteTool is simpler than FileEditTool (which we'll cover next), but it handles the foundational concerns — atomic writes, directory creation, encoding, and keeping the read cache consistent.

---

## When Write vs Edit

The agent has two tools that modify file contents:

| Scenario | Tool | Why |
|----------|------|-----|
| Create a brand-new file | **FileWriteTool** | No existing content to diff against |
| Replace entire file contents | **FileWriteTool** | Full overwrite is simpler than a giant edit |
| Change a specific section | **FileEditTool** | Surgical replacement preserves surrounding code |
| Rename a variable across a file | **FileEditTool** (replace_all) | Targeted multi-match replacement |

The system prompt explicitly guides this choice:

```
When creating new files, use the Write tool.
When modifying existing files, use the Edit tool.
NEVER use Write to modify existing files — always use Edit instead.
```

This distinction prevents a common failure mode: the model "writes" an entire file when it only needed to change two lines, accidentally dropping content it hallucinated or forgot.

---

## The Zod Input Schema

```typescript
const inputSchema = z.strictObject({
  file_path: z
    .string()
    .describe("The absolute path to the file to write"),
  content: z
    .string()
    .describe("The content to write to the file"),
});
```

Intentionally minimal. No offset, no append mode, no encoding parameter. The tool does one thing: write this content to this path.

---

## Atomic Writes

A naive `fs.writeFile()` can leave corrupted files if the process crashes mid-write. FileWriteTool uses atomic writes:

```typescript
import { writeTextContent } from "../utils/file";

async function execute(input: { file_path: string; content: string }) {
  const { file_path, content } = input;

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(file_path), { recursive: true });

  // Atomic write: write to temp file, then rename
  await writeTextContent(file_path, content);

  // Update the read cache so subsequent edits are valid
  updateReadFileState(file_path, content);

  return `Successfully wrote to ${file_path}`;
}
```

The `writeTextContent` function implements the atomic pattern:

```typescript
async function writeTextContent(
  filePath: string,
  content: string
): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.tmp-${randomId()}`);

  try {
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, filePath); // Atomic on most filesystems
  } catch (err) {
    // Clean up temp file if rename fails
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}
```

The write-then-rename pattern guarantees that `filePath` either has the old content or the new content — never a partial write. The `rename` syscall is atomic on POSIX filesystems and nearly-atomic on NTFS.

---

## Directory Creation: The mkdir -p Pattern

When the model creates `src/components/Button/Button.tsx`, the `Button/` directory might not exist yet. FileWriteTool handles this silently:

```typescript
await fs.mkdir(path.dirname(file_path), { recursive: true });
```

The `recursive: true` flag mirrors `mkdir -p` — it creates all missing intermediate directories without failing if they already exist. This is important because:

1. The model shouldn't need to think about directory structure
2. Creating directories is not a separate "tool call" that costs a round trip
3. Failing with "ENOENT: no such file or directory" would waste a turn

---

## File Encoding and Line Ending Detection

Files in the wild use different encodings and line endings. When *overwriting* a file, FileWriteTool tries to preserve the original conventions:

```typescript
function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/(?<!\r)\n/g) || []).length;
  return crlfCount > lfCount ? "\r\n" : "\n";
}

function normalizeLineEndings(
  newContent: string,
  originalContent: string | null
): string {
  if (!originalContent) return newContent; // New file, use as-is

  const originalEnding = detectLineEnding(originalContent);
  const currentEnding = detectLineEnding(newContent);

  if (originalEnding !== currentEnding) {
    // Convert to match original file's convention
    return newContent.replace(
      currentEnding === "\r\n" ? /\r\n/g : /\n/g,
      originalEnding
    );
  }
  return newContent;
}
```

This prevents a common annoyance: the model generates content with `\n` line endings, but the project uses `\r\n` (Windows). Without normalization, every line would show as changed in git diff.

For encoding, the tool reads the existing file's BOM (Byte Order Mark) if present and preserves it:

```typescript
function detectBOM(buffer: Buffer): string | null {
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return "utf-8-bom";
  }
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return "utf-16le";
  }
  return null;
}
```

---

## Updating the readFileState

After a successful write, the tool must update the read cache. Otherwise, a subsequent edit would fail the "you haven't read this file" check:

```typescript
function updateReadFileState(filePath: string, content: string) {
  const stats = fs.statSync(filePath);
  readFileState.set(filePath, {
    content,
    mtime: stats.mtimeMs,
    readTime: Date.now(),
  });
}
```

This is a subtle but critical step. Consider this sequence:

```
1. Model calls Write("new-file.ts", "const x = 1;")
2. Model calls Edit("new-file.ts", old_string="x = 1", new_string="x = 2")
```

If Write didn't update readFileState, step 2 would fail with "you must read the file before editing." By treating a write as an implicit read, the agent can create-then-edit in a single turn.

---

## Create vs Overwrite Semantics

FileWriteTool has a nuanced safety check for overwrites:

```typescript
async function validateWrite(filePath: string, content: string) {
  const exists = await fileExists(filePath);

  if (exists) {
    // File already exists — check if we've read it
    const readEntry = readFileState.get(filePath);
    if (!readEntry) {
      // We haven't read it, but we're about to overwrite it
      // This is potentially dangerous — the system prompt warns against it
      console.warn(`Overwriting ${filePath} without reading it first`);
    }
  }
}
```

The system prompt reinforces this:

```
ALWAYS prefer editing existing files to creating new ones.
NEVER use Write to modify existing files — always use Edit instead.
```

This creates a layered defense: the prompt discourages overwrites, the tool warns about them, and the UI shows the user what changed for approval.

---

## Error Handling

FileWriteTool handles several failure modes:

```typescript
async function execute(input: WriteInput): Promise<string> {
  const { file_path, content } = input;

  try {
    // Validate the path is within allowed directories
    validatePath(file_path);

    // Create directories and write atomically
    await fs.mkdir(path.dirname(file_path), { recursive: true });
    await writeTextContent(file_path, content);
    updateReadFileState(file_path, content);

    const lineCount = content.split("\n").length;
    return `Successfully wrote ${lineCount} lines to ${file_path}`;

  } catch (err) {
    if (err.code === "EACCES") {
      throw new ToolError(
        `Permission denied writing to ${file_path}. ` +
        `Check file permissions or try a different location.`
      );
    }
    if (err.code === "ENOSPC") {
      throw new ToolError(`Disk full — cannot write to ${file_path}`);
    }
    throw err;
  }
}
```

Notice the return value includes a line count — this gives the model feedback that the write succeeded and how large the result was.

---

## The Full Write Flow

```
Model calls Write({ file_path, content })
         │
         ▼
  ┌──────────────────┐
  │ Validate path     │ → Reject paths outside workspace
  └───────┬──────────┘
         ▼
  ┌──────────────────┐
  │ mkdir -p parent   │ → Create missing directories
  └───────┬──────────┘
         ▼
  ┌──────────────────┐
  │ Detect encoding   │ → Preserve BOM and line endings if overwriting
  └───────┬──────────┘
         ▼
  ┌──────────────────┐
  │ Atomic write      │ → Write temp file, then rename
  └───────┬──────────┘
         ▼
  ┌──────────────────┐
  │ Update readState  │ → Cache content + mtime
  └───────┬──────────┘
         ▼
   Return success message
```

---

## Key Takeaways

1. **FileWriteTool creates new files; FileEditTool modifies existing ones.** The system prompt enforces this separation.

2. **Atomic writes** via write-then-rename prevent corrupted files from crashes or interruptions.

3. **Automatic directory creation** (`recursive: true`) eliminates a class of "directory doesn't exist" errors.

4. **Line ending preservation** prevents noisy git diffs when the model generates content with different line endings.

5. **The write updates readFileState**, so the model can immediately edit a file it just created.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Write vs Edit Decision
**Question:** For each scenario, state whether you'd use FileWriteTool or FileEditTool and why: (a) creating a new `README.md`, (b) changing a single import in an existing file, (c) generating a new test file from scratch, (d) updating a version number across an existing config file.

[View Answer](../../answers/07-file-operations/answer-67.md#exercise-1)

### Exercise 2 — Atomic Write Implementation
**Challenge:** Implement the `writeTextContent(filePath: string, content: string)` function using the write-to-temp-then-rename pattern. Use a random suffix for the temp file name. Include cleanup of the temp file if the rename fails.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-67.md#exercise-2)

### Exercise 3 — Line Ending Detection and Normalization
**Challenge:** Write two functions: `detectLineEnding(content: string)` that returns `"\n"` or `"\r\n"` based on which is more common, and `normalizeLineEndings(newContent: string, originalContent: string | null)` that converts the new content to match the original file's convention.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-67.md#exercise-3)

### Exercise 4 — Write-Then-Edit Sequence
**Challenge:** Write a `FileWriter` class that wraps the write operation and automatically updates a `ReadFileStateCache` (from Lesson 66) after writing. Demonstrate with a test showing that a file can be written and then immediately edited without an explicit read.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-67.md#exercise-4)

---

## What's Next

Lesson 68 introduces the **file edit model** — the `old_string → new_string` replacement pattern that makes FileEditTool robust to line number changes and concurrent modifications.
