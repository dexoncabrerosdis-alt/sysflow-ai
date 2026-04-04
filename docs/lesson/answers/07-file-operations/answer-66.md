# Answers: Lesson 66 — Reading Files

## Exercise 1
**Question:** Explain how FileReadTool handles four file types differently.

**Answer:** **`.ts` (text):** Content is returned with 6-character right-aligned line numbers (`     1|code here`). Full source text is preserved, making it easy for the model to reference specific lines for later editing. **`.png` (image):** The file is read as a binary buffer, base64-encoded, and returned as an image content block with the appropriate MIME type. The model can "see" the image via multimodal capabilities, but the encoding is expensive in token cost. **`.pdf`:** Text is extracted page by page, with `offset`/`limit` reinterpreted as page numbers instead of line numbers. Formatting and images within the PDF are lost; only text content is preserved. **`.ipynb` (notebook):** The JSON structure is parsed and rendered as cell-by-cell output with headers like `--- Cell 0 [code] ---`. Cell source is shown as plain text. Metadata, execution counts, and cell outputs are omitted to reduce noise.

---

## Exercise 2
**Challenge:** Write a `formatTextContent` function.

**Answer:**

```typescript
function formatTextContent(content: string, startLine: number = 1): string {
  const lines = content.split("\n");
  const effectiveStart = startLine >= 0 ? startLine : Math.max(1, lines.length + startLine + 1);

  return lines
    .map((line, i) => {
      const lineNum = String(effectiveStart + i).padStart(6, " ");
      return `${lineNum}|${line}`;
    })
    .join("\n");
}
```

**Explanation:** The function handles both positive (1-indexed from start) and negative (counting from end) start lines. Negative values are converted to their positive equivalent, matching Python slice semantics. The 6-character padding keeps alignment consistent for files up to 999,999 lines.

---

## Exercise 3
**Challenge:** Implement a `ReadFileStateCache` class.

**Answer:**

```typescript
interface ReadFileEntry {
  content: string;
  mtime: number;
  readTime: number;
  offset?: number;
  limit?: number;
}

class ReadFileStateCache {
  private cache: Map<string, ReadFileEntry> = new Map();

  recordRead(
    filePath: string,
    content: string,
    mtime: number,
    offset?: number,
    limit?: number
  ): void {
    this.cache.set(filePath, {
      content,
      mtime,
      readTime: Date.now(),
      offset,
      limit,
    });
  }

  hasBeenRead(filePath: string): boolean {
    return this.cache.has(filePath);
  }

  getEntry(filePath: string): ReadFileEntry | null {
    return this.cache.get(filePath) ?? null;
  }

  clear(): void {
    this.cache.clear();
  }
}
```

**Explanation:** The cache maps file paths to their read state, including modification time for staleness detection and optional offset/limit for tracking partial reads. The `hasBeenRead` method provides the fast check that FileEditTool uses as its primary guardrail.

---

## Exercise 4
**Challenge:** Write a `validateFileSize` function with instructive error messages.

**Answer:**

```typescript
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateFileSize(
  filePath: string,
  stats: { size: number }
): void {
  if (stats.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File ${filePath} is ${formatBytes(stats.size)}, which exceeds ` +
      `the maximum readable size of ${formatBytes(MAX_FILE_SIZE_BYTES)}. ` +
      `Use the offset and limit parameters to read a portion of the file. ` +
      `For example: Read({ file_path: "${filePath}", offset: 1, limit: 100 }) ` +
      `to read the first 100 lines.`
    );
  }
}
```

**Explanation:** The error message follows the "error messages as prompts" pattern — it doesn't just report the failure, it teaches the model exactly how to fix the problem. Including a concrete example with the actual file path makes it easy for the model to adapt the suggestion.
