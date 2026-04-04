# Answers: Lesson 72 — Notebook Editing

## Exercise 1
**Question:** Summarize and rank the four reasons cell-level editing is needed for notebooks.

**Answer:** Ranked by impact:

1. **JSON structural integrity** (most impactful) — A small mistake in raw JSON editing (missing comma, wrong bracket) corrupts the entire notebook. Cell-level editing handles serialization programmatically, making corruption impossible.
2. **Source is an array of strings** — Matching raw JSON like `["import pandas\n", "df = pd.read_csv..."]` is far harder than matching clean code. The model would need to generate JSON syntax alongside code, dramatically increasing error rates.
3. **Outputs and metadata interfere** — Raw JSON matching could accidentally match output text or metadata instead of source code, editing the wrong part of the cell.
4. **Merge conflicts** (least impactful, but still valuable) — Cell-level edits that only modify `.source` arrays produce cleaner git diffs than whole-file JSON modifications.

---

## Exercise 2
**Challenge:** Write `getCellSource` and `sourceToCellFormat`.

**Answer:**

```typescript
function getCellSource(cell: { source: string | string[] }): string {
  if (Array.isArray(cell.source)) {
    return cell.source.join("");
  }
  return cell.source;
}

function sourceToCellFormat(source: string): string[] {
  if (source === "") return [];

  // Split on newlines but keep the \n at the end of each segment
  const parts = source.split(/(?<=\n)/);

  return parts;
}
```

**Explanation:** `getCellSource` handles both formats (string and string array) that the notebook spec allows. `sourceToCellFormat` uses a lookbehind split `(?<=\n)` to split after each newline, keeping the `\n` character attached to the end of each resulting string. This matches the Jupyter convention where `["line1\n", "line2\n", "line3"]` — the last line may or may not have a trailing newline.

---

## Exercise 3
**Challenge:** Write an `executeNotebookEdit` function.

**Answer:**

```typescript
interface NotebookCell {
  cell_type: string;
  source: string | string[];
  metadata: Record<string, any>;
  outputs?: any[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, any>;
  nbformat: number;
  nbformat_minor: number;
}

function executeNotebookEdit(
  notebook: Notebook,
  cellIndex: number,
  oldString: string,
  newString: string
): string {
  // Validate cell index
  if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
    throw new Error(
      `Cell index ${cellIndex} is out of range. ` +
      `Notebook has ${notebook.cells.length} cells (0-${notebook.cells.length - 1}).`
    );
  }

  const cell = notebook.cells[cellIndex];
  const source = getCellSource(cell);

  // Find the old_string in the cell source
  const index = source.indexOf(oldString);
  if (index === -1) {
    throw new Error(
      `old_string not found in cell ${cellIndex}. ` +
      `Read the notebook to verify cell contents.`
    );
  }

  // Apply replacement
  const newSource = source.replace(oldString, newString);

  // Convert back to cell array format (preserving outputs)
  cell.source = sourceToCellFormat(newSource);
  // cell.outputs remains untouched

  return `Edited cell ${cellIndex} successfully`;
}
```

**Explanation:** The function validates the cell index with a helpful range message, extracts the source as plain text, performs the string replacement, and converts back to the array format. Outputs are explicitly preserved — editing source code doesn't clear potentially expensive computation results.

---

## Exercise 4
**Challenge:** Write an `insertCell` function.

**Answer:**

```typescript
function insertCell(
  notebook: Notebook,
  index: number,
  cellType: "code" | "markdown" | "raw",
  source: string
): void {
  const baseCell = {
    cell_type: cellType,
    metadata: {},
    source: sourceToCellFormat(source),
  };

  const newCell: NotebookCell =
    cellType === "code"
      ? { ...baseCell, execution_count: null, outputs: [] }
      : baseCell;

  // Clamp index to valid range
  const clampedIndex = Math.min(Math.max(0, index), notebook.cells.length);
  notebook.cells.splice(clampedIndex, 0, newCell);
}
```

**Explanation:** Code cells require `execution_count` and `outputs` fields per the notebook format spec; markdown and raw cells don't include them. The index is clamped to the valid range to prevent out-of-bounds errors — inserting at an index beyond the array length appends to the end.

---

## Exercise 5
**Question:** Why 1-space indentation and why a trailing newline?

**Answer:** Jupyter itself uses 1-space indentation when saving notebooks. Using 2-space or 4-space indentation would work functionally, but every line of the JSON would differ from what Jupyter produces. This means the first time a user opens and re-saves the notebook in Jupyter after an agent edit, every single line would show as changed in git diff — an enormous, noisy diff that obscures the actual code changes. The 1-space convention minimizes diff noise. The trailing newline matters because most text editors and POSIX tools expect files to end with a newline. Without it, `git diff` shows a `\ No newline at end of file` warning, and some tools may behave unexpectedly when concatenating or processing the file.
