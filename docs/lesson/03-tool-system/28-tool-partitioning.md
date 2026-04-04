# Lesson 28: Tool Partitioning

## The Partitioning Problem

The model has emitted 5 tool calls in one turn. Some are reads (concurrency-safe),
some are writes (not safe). You can't just run them all in parallel, and you
shouldn't run them all serially. You need to figure out which groups can overlap.

This is the job of `partitionToolCalls()`.

## The Algorithm

The core idea: scan the list of tool calls left to right. Group consecutive
concurrency-safe calls into a single batch. Every unsafe call becomes its own batch.

```typescript
type Batch = {
  isConcurrencySafe: boolean;
  blocks: ToolUseBlock[];
};

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
      batches.push({
        isConcurrencySafe: false,
        blocks: [block],
      });
      currentBatch = null;
      continue;
    }

    const isSafe = isConcurrencySafeForInput(tool, block.input);

    if (isSafe) {
      // Can we merge into the current batch?
      if (currentBatch?.isConcurrencySafe) {
        currentBatch.blocks.push(block);
      } else {
        // Start a new concurrent batch
        currentBatch = { isConcurrencySafe: true, blocks: [block] };
        batches.push(currentBatch);
      }
    } else {
      // Unsafe — always a new batch, alone
      currentBatch = { isConcurrencySafe: false, blocks: [block] };
      batches.push(currentBatch);
    }
  }

  return batches;
}
```

## The Merge Rule

The rule is simple but important:

1. **Consecutive safe tools coalesce**: If the current batch is concurrent-safe and
   the next tool is also safe, add it to the same batch
2. **Any unsafe tool starts a new batch**: An unsafe tool always gets its own batch,
   and it breaks the current run of safe tools

This preserves the model's intended ordering while maximizing parallelism.

## Walkthrough: 5 Tool Calls

Let's trace through a realistic example. The model emits:

```
1. Read("src/index.ts")       — isConcurrencySafe: true
2. Read("src/utils.ts")       — isConcurrencySafe: true
3. Grep("TODO", "src/")       — isConcurrencySafe: true
4. Edit("src/index.ts", ...)  — isConcurrencySafe: false
5. Read("src/index.ts")       — isConcurrencySafe: true
```

Step-by-step partitioning:

```
Processing tool 1: Read (safe)
  → No current batch → create new Batch { safe: true, blocks: [Read₁] }

Processing tool 2: Read (safe)
  → Current batch is safe → merge: Batch { safe: true, blocks: [Read₁, Read₂] }

Processing tool 3: Grep (safe)
  → Current batch is safe → merge: Batch { safe: true, blocks: [Read₁, Read₂, Grep₃] }

Processing tool 4: Edit (UNSAFE)
  → Create new Batch { safe: false, blocks: [Edit₄] }

Processing tool 5: Read (safe)
  → Current batch is unsafe → create new Batch { safe: true, blocks: [Read₅] }
```

Result: **3 batches**

```
Batch 1: { isConcurrencySafe: true,  blocks: [Read₁, Read₂, Grep₃] }
Batch 2: { isConcurrencySafe: false, blocks: [Edit₄] }
Batch 3: { isConcurrencySafe: true,  blocks: [Read₅] }
```

Execution:
1. Read₁, Read₂, and Grep₃ run **simultaneously**
2. After all three complete, Edit₄ runs **alone**
3. After Edit₄ completes, Read₅ runs **alone** (it's in its own safe batch)

## Why Order Matters

You might wonder: why not reorder the calls to group all safe ones together?

```
// Hypothetical reordering:
[Read₁, Read₂, Grep₃, Read₅]  // all safe, one big batch
[Edit₄]                          // unsafe, alone
```

This would be more efficient (4 parallel instead of 3 + 1). But it violates the
model's intended order. The model emitted Read₅ *after* Edit₄ for a reason—
it likely wants to read the file *after* editing it to verify the changes.

Reordering could produce incorrect results if the model's logic depends on
execution order. So Claude Code preserves order strictly.

## Another Example: All Safe

```
1. Read("a.ts")    — safe
2. Read("b.ts")    — safe
3. Grep("TODO")    — safe
4. Glob("*.ts")    — safe
5. WebFetch(url)   — safe
```

Result: **1 batch**

```
Batch 1: { isConcurrencySafe: true, blocks: [all five] }
```

All five run simultaneously. Maximum parallelism.

## Another Example: All Unsafe

```
1. Write("a.ts", ...)    — unsafe
2. Edit("b.ts", ...)     — unsafe
3. Bash("npm install")   — unsafe
4. Write("c.ts", ...)    — unsafe
```

Result: **4 batches**

```
Batch 1: { isConcurrencySafe: false, blocks: [Write₁] }
Batch 2: { isConcurrencySafe: false, blocks: [Edit₂] }
Batch 3: { isConcurrencySafe: false, blocks: [Bash₃] }
Batch 4: { isConcurrencySafe: false, blocks: [Write₄] }
```

All four run one at a time. Maximum safety.

## Another Example: Alternating

```
1. Read("a.ts")          — safe
2. Edit("a.ts", ...)     — unsafe
3. Read("a.ts")          — safe
4. Edit("b.ts", ...)     — unsafe
5. Read("b.ts")          — safe
```

Result: **5 batches** (each a single tool)

```
Batch 1: { safe: true,  blocks: [Read₁] }
Batch 2: { safe: false, blocks: [Edit₂] }
Batch 3: { safe: true,  blocks: [Read₃] }
Batch 4: { safe: false, blocks: [Edit₄] }
Batch 5: { safe: true,  blocks: [Read₅] }
```

This is the worst case for parallelism, but it's the correct behavior—the model
is doing read-edit-verify cycles.

## Unknown Tools

If a tool_use block references a tool that doesn't exist in the registry:

```typescript
const tool = tools.get(block.name);
if (!tool) {
  batches.push({
    isConcurrencySafe: false,
    blocks: [block],
  });
  currentBatch = null;
  continue;
}
```

Unknown tools are treated as unsafe and isolated. This is conservative and
prevents any assumptions about tools we don't recognize. The actual error
("unknown tool") is handled later during execution.

## Visualizing the Algorithm

```
Input: [S, S, S, U, S, S, U, U, S]    (S=safe, U=unsafe)

Pass:   ───────────────────────────▶

Batch:  [S, S, S] [U] [S, S] [U] [U] [S]
         ╰─par─╯  ser  ╰par╯  ser ser  ser

Groups:    1        2    3     4   5    6
```

The algorithm is O(n) — a single pass through the tool calls. No sorting, no
backtracking, no lookahead.

## Edge Cases

### Empty Input

```typescript
partitionToolCalls([], tools)  // returns []
```

### Single Tool

```typescript
partitionToolCalls([readBlock], tools)
// returns [{ isConcurrencySafe: true, blocks: [readBlock] }]
```

### Tool With Dynamic Concurrency

```typescript
const tool = buildTool({
  name: "SmartWrite",
  isConcurrencySafe: (input: { file_path: string }) => {
    // Safe if writing to temp directory
    return input.file_path.startsWith("/tmp/");
  },
  // ...
});
```

For this tool, `isConcurrencySafeForInput()` runs the function with the parsed
input. Two SmartWrite calls to `/tmp/` would batch together; a call to `/src/`
would not.

## Key Takeaways

1. `partitionToolCalls()` groups tool calls into batches for execution
2. Consecutive safe tools are merged into concurrent batches
3. Unsafe tools always start their own batch
4. The model's intended order is **always preserved**
5. Unknown tools are treated as unsafe
6. The algorithm is a single O(n) pass

## What's Next

Batches are created. Now how are they actually executed? Let's look at `runTools()`
and the parallel execution engine.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Two Rules

**Question:** State the two rules of the partitioning algorithm. Why can't we reorder tool calls to maximize parallelism?

[View Answer](../../answers/03-tool-system/answer-28.md#exercise-1)

### Exercise 2 — Implement partitionToolCalls

**Challenge:** Implement the `partitionToolCalls()` function from scratch. It takes an array of tool use blocks and a Map of tool names to Tool objects, and returns an array of `Batch` objects (`{ isConcurrencySafe: boolean; blocks: ToolUseBlock[] }`). Handle unknown tools as unsafe.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-28.md#exercise-2)

### Exercise 3 — Trace the Algorithm

**Challenge:** Given these tool calls, determine the resulting batches by hand. Show your work step by step:

```
1. Grep("TODO")          — safe
2. Read("a.ts")          — safe
3. Write("b.ts", ...)    — unsafe
4. Write("c.ts", ...)    — unsafe
5. Read("c.ts")          — safe
6. Read("d.ts")          — safe
7. Bash("npm test")      — unsafe
8. Glob("*.ts")          — safe
```

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-28.md#exercise-3)

### Exercise 4 — Edge Cases

**Challenge:** Write test cases (input and expected output) for these edge cases of `partitionToolCalls`: (a) empty array, (b) single safe tool, (c) single unsafe tool, (d) all safe tools, (e) all unsafe tools, (f) alternating safe/unsafe.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-28.md#exercise-4)

---

*Module 03: The Tool System — Lesson 28 of 35*
