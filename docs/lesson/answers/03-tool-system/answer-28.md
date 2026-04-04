# Answers: Lesson 28 — Tool Partitioning

## Exercise 1
**Question:** State the two rules of the partitioning algorithm. Why can't we reorder tools to maximize parallelism?

**Answer:** The two rules are:

1. **Consecutive safe tools coalesce.** If the current batch is concurrent-safe and the next tool is also safe, it's added to the same batch.
2. **Any unsafe tool starts a new batch.** An unsafe tool always gets its own single-tool batch, breaking any current run of safe tools.

Reordering to maximize parallelism is forbidden because the model's tool call order encodes *intent*. If the model emits `Read(a.ts)`, then `Edit(a.ts)`, then `Read(a.ts)`, it likely wants to: read the file, edit it, then read it again to verify the edit. Reordering the tools would break this read-edit-verify cycle — the second Read would see the pre-edit content instead of the post-edit content. The algorithm preserves the model's intended execution order while extracting parallelism only where it's safe (consecutive reads).

---

## Exercise 2
**Challenge:** Implement `partitionToolCalls()` from scratch.

**Answer:**

```typescript
type ToolUseBlock = {
  id: string;
  name: string;
  input: unknown;
};

type Tool = {
  name: string;
  isConcurrencySafe: boolean | ((input: unknown) => boolean);
  inputSchema: { safeParse: (input: unknown) => { success: boolean; data?: unknown } };
};

type Batch = {
  isConcurrencySafe: boolean;
  blocks: ToolUseBlock[];
};

function isConcurrencySafeForInput(tool: Tool, input: unknown): boolean {
  if (typeof tool.isConcurrencySafe === "boolean") {
    return tool.isConcurrencySafe;
  }
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) return false;
  return tool.isConcurrencySafe(parsed.data);
}

function partitionToolCalls(
  toolUseBlocks: ToolUseBlock[],
  tools: Map<string, Tool>
): Batch[] {
  const batches: Batch[] = [];
  let currentBatch: Batch | null = null;

  for (const block of toolUseBlocks) {
    const tool = tools.get(block.name);

    if (!tool) {
      // Unknown tool — treat as unsafe, isolated batch
      batches.push({ isConcurrencySafe: false, blocks: [block] });
      currentBatch = null;
      continue;
    }

    const isSafe = isConcurrencySafeForInput(tool, block.input);

    if (isSafe) {
      if (currentBatch?.isConcurrencySafe) {
        // Merge into current safe batch
        currentBatch.blocks.push(block);
      } else {
        // Start a new concurrent batch
        currentBatch = { isConcurrencySafe: true, blocks: [block] };
        batches.push(currentBatch);
      }
    } else {
      // Unsafe — always a new single-tool batch
      currentBatch = { isConcurrencySafe: false, blocks: [block] };
      batches.push(currentBatch);
    }
  }

  return batches;
}
```

**Explanation:** A single O(n) pass through the blocks. For each block: look up the tool, check if it's concurrency-safe, and either merge into the current safe batch or create a new batch. Unknown tools get their own unsafe batch and reset `currentBatch` to null. The algorithm never looks ahead or back — it's purely streaming.

---

## Exercise 3
**Challenge:** Trace the algorithm for the given tool sequence.

**Answer:**

```
Processing tool 1: Grep("TODO") — safe
  → No current batch → new Batch { safe: true, blocks: [Grep₁] }

Processing tool 2: Read("a.ts") — safe
  → Current batch is safe → merge: Batch { safe: true, blocks: [Grep₁, Read₂] }

Processing tool 3: Write("b.ts") — UNSAFE
  → New Batch { safe: false, blocks: [Write₃] }

Processing tool 4: Write("c.ts") — UNSAFE
  → New Batch { safe: false, blocks: [Write₄] }

Processing tool 5: Read("c.ts") — safe
  → Current batch is unsafe → new Batch { safe: true, blocks: [Read₅] }

Processing tool 6: Read("d.ts") — safe
  → Current batch is safe → merge: Batch { safe: true, blocks: [Read₅, Read₆] }

Processing tool 7: Bash("npm test") — UNSAFE
  → New Batch { safe: false, blocks: [Bash₇] }

Processing tool 8: Glob("*.ts") — safe
  → Current batch is unsafe → new Batch { safe: true, blocks: [Glob₈] }
```

**Result: 6 batches**

```
Batch 1: { safe: true,  blocks: [Grep₁, Read₂] }     — run in parallel
Batch 2: { safe: false, blocks: [Write₃] }             — run alone
Batch 3: { safe: false, blocks: [Write₄] }             — run alone
Batch 4: { safe: true,  blocks: [Read₅, Read₆] }      — run in parallel
Batch 5: { safe: false, blocks: [Bash₇] }              — run alone
Batch 6: { safe: true,  blocks: [Glob₈] }              — run alone (single item)
```

---

## Exercise 4
**Challenge:** Write test cases for edge cases.

**Answer:**

```typescript
describe("partitionToolCalls edge cases", () => {
  // (a) Empty array
  test("empty input returns empty batches", () => {
    const result = partitionToolCalls([], tools);
    expect(result).toEqual([]);
  });

  // (b) Single safe tool
  test("single safe tool → one safe batch", () => {
    const blocks = [{ id: "1", name: "Read", input: { file_path: "a.ts" } }];
    const result = partitionToolCalls(blocks, tools);
    expect(result).toEqual([
      { isConcurrencySafe: true, blocks: [blocks[0]] },
    ]);
  });

  // (c) Single unsafe tool
  test("single unsafe tool → one unsafe batch", () => {
    const blocks = [{ id: "1", name: "Write", input: { file_path: "a.ts", content: "" } }];
    const result = partitionToolCalls(blocks, tools);
    expect(result).toEqual([
      { isConcurrencySafe: false, blocks: [blocks[0]] },
    ]);
  });

  // (d) All safe tools → one batch
  test("all safe → single concurrent batch", () => {
    const blocks = [
      { id: "1", name: "Read", input: { file_path: "a.ts" } },
      { id: "2", name: "Read", input: { file_path: "b.ts" } },
      { id: "3", name: "Grep", input: { pattern: "TODO" } },
    ];
    const result = partitionToolCalls(blocks, tools);
    expect(result).toHaveLength(1);
    expect(result[0].isConcurrencySafe).toBe(true);
    expect(result[0].blocks).toHaveLength(3);
  });

  // (e) All unsafe tools → one batch per tool
  test("all unsafe → one batch per tool", () => {
    const blocks = [
      { id: "1", name: "Write", input: { file_path: "a.ts", content: "" } },
      { id: "2", name: "Write", input: { file_path: "b.ts", content: "" } },
      { id: "3", name: "Bash", input: { command: "echo hi" } },
    ];
    const result = partitionToolCalls(blocks, tools);
    expect(result).toHaveLength(3);
    expect(result.every((b) => !b.isConcurrencySafe)).toBe(true);
    expect(result.every((b) => b.blocks.length === 1)).toBe(true);
  });

  // (f) Alternating safe/unsafe → one batch per tool
  test("alternating → no merging possible", () => {
    const blocks = [
      { id: "1", name: "Read", input: { file_path: "a.ts" } },
      { id: "2", name: "Write", input: { file_path: "a.ts", content: "" } },
      { id: "3", name: "Read", input: { file_path: "a.ts" } },
    ];
    const result = partitionToolCalls(blocks, tools);
    expect(result).toHaveLength(3);
    expect(result[0].isConcurrencySafe).toBe(true);
    expect(result[1].isConcurrencySafe).toBe(false);
    expect(result[2].isConcurrencySafe).toBe(true);
  });
});
```

**Explanation:** Each edge case tests a different aspect: empty input (no crash), single items (both variants), homogeneous lists (max merging vs. no merging), and alternating (worst case for parallelism). These cover the algorithm's boundary conditions.
