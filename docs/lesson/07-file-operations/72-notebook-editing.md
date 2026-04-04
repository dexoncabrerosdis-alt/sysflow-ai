# Lesson 72: Notebook Editing — The NotebookEditTool

## Why Notebooks Are Special

Jupyter notebooks (`.ipynb` files) are JSON documents with a very specific structure. A simple notebook looks like this on disk:

```json
{
  "cells": [
    {
      "cell_type": "markdown",
      "metadata": {},
      "source": ["# My Notebook\n", "This is a data analysis notebook."]
    },
    {
      "cell_type": "code",
      "execution_count": 1,
      "metadata": {},
      "source": ["import pandas as pd\n", "df = pd.read_csv('data.csv')"],
      "outputs": [
        {
          "output_type": "execute_result",
          "data": { "text/plain": ["   col1  col2\n", "0     1     2"] }
        }
      ]
    }
  ],
  "metadata": {
    "kernelspec": {
      "display_name": "Python 3",
      "language": "python",
      "name": "python3"
    }
  },
  "nbformat": 4,
  "nbformat_minor": 5
}
```

This creates several problems for the standard FileEditTool:

1. **Cell source is an array of strings**, not a single string — each element is a line
2. **JSON syntax wraps everything** — quotes, brackets, commas
3. **Metadata and outputs** are interspersed with code — the model might accidentally match output text instead of source
4. **Cell boundaries matter** — editing "across" cells makes no sense

The NotebookEditTool handles all of these by working at the **cell level**.

---

## The Routing Decision

When FileEditTool receives an edit for a `.ipynb` file, it routes to NotebookEditTool:

```typescript
class FileEditTool extends Tool {
  async execute(input: EditInput): Promise<string> {
    const { file_path } = input;

    if (file_path.endsWith(".ipynb")) {
      return this.notebookEditTool.execute(input);
    }

    // Standard file edit logic...
  }
}
```

This routing is transparent to the model — it calls the same Edit tool with the same schema. The tool internally decides how to handle the edit based on the file extension.

---

## The NotebookEditTool Schema

NotebookEditTool extends the standard edit schema with notebook-specific fields:

```typescript
const notebookInputSchema = z.strictObject({
  file_path: z.string().describe("Path to the .ipynb file"),
  cell_index: z
    .number()
    .int()
    .nonnegative()
    .describe("The 0-based index of the cell to edit"),
  old_string: z
    .string()
    .describe("Text to find within the cell's source"),
  new_string: z
    .string()
    .describe("Replacement text"),
  cell_type: z
    .enum(["code", "markdown", "raw"])
    .optional()
    .describe("Cell type — used when creating new cells"),
});
```

The key addition is `cell_index` — it scopes the edit to a specific cell, preventing cross-cell matches and making the target unambiguous.

---

## Reading Notebooks: Cell-Level Display

Recall from Lesson 66 that FileReadTool formats notebooks as cell-by-cell output:

```
--- Cell 0 [markdown] ---
# My Notebook
This is a data analysis notebook.

--- Cell 1 [code] ---
import pandas as pd
df = pd.read_csv('data.csv')

--- Cell 2 [code] ---
df.describe()
```

This representation:
- Shows cell indices (0, 1, 2) that the model uses in `cell_index`
- Shows cell types (`markdown`, `code`) for context
- Renders the source as plain text, not JSON arrays
- Omits outputs and metadata (too noisy for the model)

---

## How Cell-Level Editing Works

### Step 1: Parse the Notebook

```typescript
async function parseNotebook(filePath: string): Promise<Notebook> {
  const raw = await fs.readFile(filePath, "utf-8");
  const notebook = JSON.parse(raw) as Notebook;

  // Validate structure
  if (!notebook.cells || !Array.isArray(notebook.cells)) {
    throw new ToolError(
      `${filePath} is not a valid Jupyter notebook (missing cells array)`
    );
  }

  return notebook;
}
```

### Step 2: Extract Cell Source

```typescript
function getCellSource(cell: NotebookCell): string {
  // Cell source can be a string or array of strings
  if (Array.isArray(cell.source)) {
    return cell.source.join("");
  }
  return cell.source;
}
```

The `.source` field in notebooks is an array of strings where each element is a line (including the trailing `\n`). Joining them gives the full source text that the model works with.

### Step 3: Apply the Edit

```typescript
async function executeNotebookEdit(input: NotebookEditInput): Promise<string> {
  const { file_path, cell_index, old_string, new_string } = input;
  const notebook = await parseNotebook(file_path);

  // Validate cell index
  if (cell_index >= notebook.cells.length) {
    throw new ToolError(
      `Cell index ${cell_index} is out of range. ` +
      `Notebook has ${notebook.cells.length} cells (0-${notebook.cells.length - 1}).`
    );
  }

  const cell = notebook.cells[cell_index];
  const source = getCellSource(cell);

  // Find and replace within this cell only
  const match = findActualString(source, old_string);
  if (!match.found) {
    throw new ToolError(
      `old_string not found in cell ${cell_index}. ` +
      `Read the notebook to verify cell contents.`
    );
  }

  // Apply replacement
  const newSource = source.replace(match.actualString, new_string);

  // Convert back to array format for the notebook JSON
  cell.source = newSource.split(/(?<=\n)/).map((line) => line);

  // Write the updated notebook
  await writeNotebook(file_path, notebook);

  return `Edited cell ${cell_index} in ${file_path}`;
}
```

### Step 4: Write Back as JSON

```typescript
async function writeNotebook(
  filePath: string,
  notebook: Notebook
): Promise<void> {
  // Preserve formatting: nbformat uses 1-space indent
  const json = JSON.stringify(notebook, null, 1);
  await writeTextContent(filePath, json + "\n");
}
```

The `JSON.stringify` with 1-space indent matches the convention used by Jupyter itself. This minimizes diff noise when the file is committed to version control.

---

## Creating New Cells

The model can also create new cells by providing a `cell_index` where the cell doesn't yet exist (or by using a special flag):

```typescript
function insertCell(
  notebook: Notebook,
  index: number,
  cellType: CellType,
  source: string
): void {
  const newCell: NotebookCell = {
    cell_type: cellType,
    metadata: {},
    source: source.split(/(?<=\n)/),
    ...(cellType === "code"
      ? { execution_count: null, outputs: [] }
      : {}),
  };

  notebook.cells.splice(index, 0, newCell);
}
```

Code cells need `execution_count` and `outputs` fields; markdown and raw cells don't. The function handles this structural difference.

---

## Why Not Just Use FileEditTool on Raw JSON?

You might think: "Notebooks are just JSON files — why not edit them with the regular file edit tool?" Here's why:

### Problem 1: Source Is an Array

The model would need to match JSON syntax:

```json
"source": ["import pandas as pd\n", "df = pd.read_csv('data.csv')"]
```

Instead of clean code:

```python
import pandas as pd
df = pd.read_csv('data.csv')
```

The model is much better at matching *code* than *JSON-encoded code*.

### Problem 2: Outputs and Metadata Interfere

A real notebook cell might have hundreds of lines of output data (images, tables, tracebacks). Finding `old_string` in the raw JSON could match output text instead of source code.

### Problem 3: JSON Structural Integrity

A small mistake in raw JSON editing — a missing comma, a wrong bracket — corrupts the entire notebook. Cell-level editing operates on the source text and re-serializes, so JSON integrity is maintained programmatically.

### Problem 4: Merge Conflicts

Git merges on notebook JSON are notoriously painful. Cell-level edits that only modify `.source` arrays produce cleaner diffs than whole-file JSON edits.

---

## Handling Edge Cases

### Empty Cells

```typescript
if (getCellSource(cell).trim() === "" && old_string.trim() === "") {
  // Both empty — just set the new content
  cell.source = new_string.split(/(?<=\n)/);
  return;
}
```

### Cell Type Conversion

Sometimes the model wants to convert a markdown cell to code or vice versa:

```typescript
if (input.cell_type && input.cell_type !== cell.cell_type) {
  cell.cell_type = input.cell_type;
  if (input.cell_type === "code") {
    cell.execution_count = null;
    cell.outputs = [];
  } else {
    delete cell.execution_count;
    delete cell.outputs;
  }
}
```

### Preserving Outputs

Editing a code cell's source doesn't clear its outputs. This is intentional — the user might want to keep existing outputs while fixing a typo. Clearing outputs would lose potentially expensive computation results.

```typescript
// Source is updated, but outputs remain untouched
cell.source = newSource.split(/(?<=\n)/);
// cell.outputs stays as-is
```

---

## The Notebook Editing Flow

```
Model calls Edit({ file_path: "analysis.ipynb", cell_index: 2, ... })
         │
         ▼
  ┌───────────────────┐
  │ Detect .ipynb      │ → Route to NotebookEditTool
  └────────┬──────────┘
         ▼
  ┌───────────────────┐
  │ Parse JSON         │ → Validate notebook structure
  └────────┬──────────┘
         ▼
  ┌───────────────────┐
  │ Extract cell source│ → Join source array → plain text
  └────────┬──────────┘
         ▼
  ┌───────────────────┐
  │ Find + replace     │ → Same normalization as FileEditTool
  └────────┬──────────┘
         ▼
  ┌───────────────────┐
  │ Split back to array│ → Reconstruct source array
  └────────┬──────────┘
         ▼
  ┌───────────────────┐
  │ Serialize JSON     │ → 1-space indent, trailing newline
  └────────┬──────────┘
         ▼
  ┌───────────────────┐
  │ Atomic write       │ → Same writeTextContent as FileWriteTool
  └────────────────────┘
```

---

## Key Takeaways

1. **Notebooks need cell-level editing** because their JSON structure makes raw string replacement fragile and error-prone.

2. **FileEditTool transparently routes** `.ipynb` files to NotebookEditTool — the model uses the same tool interface.

3. **Cell source** is converted from array-of-strings to plain text for matching, then back to array format for serialization.

4. **Outputs are preserved** — editing source doesn't clear computation results.

5. **JSON integrity is maintained** by the tool, not the model — the model works with clean source text while the tool handles serialization.

---

## Module 07 Summary

Over these seven lessons, we've covered the complete file operations system:

- **Reading** (Lesson 66): Type-aware, cached, concurrency-safe
- **Writing** (Lesson 67): Atomic writes, directory creation, encoding preservation
- **Edit model** (Lesson 68): old_string → new_string, uniqueness-enforced
- **String matching** (Lesson 69): Quote normalization, fuzzy fallbacks
- **Read-before-edit** (Lesson 70): The #1 guardrail against hallucinated edits
- **Diff generation** (Lesson 71): Structured patches for human review
- **Notebook editing** (Lesson 72): Cell-level edits for `.ipynb` files

Next, Module 08 explores how the agent **finds** the files it needs to read and edit — through grep, glob, web search, and code navigation.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Why Cell-Level Editing?
**Question:** The lesson gives four reasons why FileEditTool's raw string replacement doesn't work well on `.ipynb` files. Summarize each reason in one sentence and rank them from most to least impactful.

[View Answer](../../answers/07-file-operations/answer-72.md#exercise-1)

### Exercise 2 — Cell Source Extraction
**Challenge:** Write two functions: `getCellSource(cell: { source: string | string[] })` that converts the notebook cell source format (array of strings or single string) to plain text, and `sourceToCellFormat(source: string)` that converts plain text back to the array-of-strings format notebooks expect (splitting on newlines but keeping the `\n` at the end of each element).

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-72.md#exercise-2)

### Exercise 3 — Notebook Cell Editor
**Challenge:** Write an `executeNotebookEdit(notebook: Notebook, cellIndex: number, oldString: string, newString: string)` function that: validates the cell index, extracts the cell source, finds and replaces the string, converts back to cell format, and preserves existing outputs. Throw descriptive errors for invalid indices and missing matches.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-72.md#exercise-3)

### Exercise 4 — New Cell Insertion
**Challenge:** Write an `insertCell(notebook: Notebook, index: number, cellType: "code" | "markdown" | "raw", source: string)` function that creates a properly structured notebook cell. Code cells need `execution_count: null` and `outputs: []`; markdown and raw cells don't.

Write your solution in your IDE first, then check:

[View Answer](../../answers/07-file-operations/answer-72.md#exercise-4)

### Exercise 5 — Notebook Serialization
**Question:** Why does `writeNotebook` use `JSON.stringify(notebook, null, 1)` with 1-space indentation specifically? What problem would 2-space or 4-space indentation cause, and why does a trailing newline matter?

[View Answer](../../answers/07-file-operations/answer-72.md#exercise-5)
