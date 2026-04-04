# Lesson 27: Concurrency Safety

## The Concurrency Question

When the model requests multiple tools in a single turn, the runtime faces a
decision: run them one at a time, or run them simultaneously?

Running in parallel is faster. But running in parallel is also dangerous if the
tools interact with shared state. The `isConcurrencySafe` flag is how each tool
declares whether it's safe to run alongside others.

## The Problem: Race Conditions

Consider this scenario. The model requests two tool calls in one turn:

```json
[
  { "name": "Write", "input": { "file_path": "config.json", "content": "{\"v\": 1}" } },
  { "name": "Write", "input": { "file_path": "config.json", "content": "{\"v\": 2}" } }
]
```

If both run simultaneously, you have a classic race condition. Which write wins?
It depends on OS scheduling, disk I/O timing, and cosmic rays. The file could end
up with either value, or even corrupted data if the writes interleave.

Another scenario:

```json
[
  { "name": "Edit", "input": { "file_path": "app.ts", "old": "foo", "new": "bar" } },
  { "name": "Edit", "input": { "file_path": "app.ts", "old": "baz", "new": "qux" } }
]
```

Both edits read the file, compute the change, and write back. If they run in
parallel, the second edit might overwrite the first edit's changes.

## The Flag: `isConcurrencySafe`

Each tool declares its concurrency safety:

```typescript
type Tool = {
  // ...
  isConcurrencySafe: boolean | ((input: unknown) => boolean);
};
```

### Static Boolean

Most tools use a simple boolean:

```typescript
// Safe: reads never conflict
isConcurrencySafe: true    // Read, Grep, Glob, WebFetch

// Unsafe: writes can conflict
isConcurrencySafe: false   // Write, Edit, Bash, NotebookEdit
```

### Dynamic Function

Some tools' safety depends on the input:

```typescript
isConcurrencySafe: (input: { file_path: string }) => {
  // Writing to different files is safe
  // Writing to the same file is not
  // But we can't know at declaration time
  return true;  // simplified — real logic is more nuanced
}
```

In practice, the dynamic form is rare. Most tools are statically safe or unsafe.

## How Concurrency Safety Is Checked

When the runtime processes a batch of tool calls, it checks each tool's
concurrency safety:

```typescript
function isConcurrencySafeForInput(tool: Tool, input: unknown): boolean {
  if (typeof tool.isConcurrencySafe === "function") {
    // Dynamic check: validate input first, then check
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      return false;  // invalid input → treat as unsafe
    }
    return tool.isConcurrencySafe(parsed.data);
  }
  return tool.isConcurrencySafe;
}
```

Note the important detail: when `isConcurrencySafe` is a function, the input is
validated with `safeParse` first. This ensures the function receives well-typed
data, not raw model output.

## Categories of Tools

### Always Concurrency-Safe

These tools only read state and have no side effects:

```typescript
// File reading — reads are atomic on most filesystems
const FileReadTool = buildTool({
  name: "Read",
  isConcurrencySafe: true,
  isReadOnly: true,
  // ...
});

// Pattern search — read-only, stateless
const GrepTool = buildTool({
  name: "Grep",
  isConcurrencySafe: true,
  isReadOnly: true,
  // ...
});

// File search — read-only, stateless
const GlobTool = buildTool({
  name: "Glob",
  isConcurrencySafe: true,
  isReadOnly: true,
  // ...
});

// Web fetch — each request is independent
const WebFetchTool = buildTool({
  name: "WebFetch",
  isConcurrencySafe: true,
  isReadOnly: true,
  // ...
});
```

### Never Concurrency-Safe

These tools modify state and can conflict:

```typescript
// File writing — two writes to same file = race condition
const FileWriteTool = buildTool({
  name: "Write",
  isConcurrencySafe: false,
  isReadOnly: false,
  // ...
});

// File editing — read-modify-write cycle is not atomic
const FileEditTool = buildTool({
  name: "Edit",
  isConcurrencySafe: false,
  isReadOnly: false,
  // ...
});

// Shell commands — can have arbitrary side effects
const BashTool = buildTool({
  name: "Bash",
  isConcurrencySafe: false,
  isReadOnly: false,
  // ...
});
```

### The Correlation with Read-Only

There's a strong correlation between `isReadOnly` and `isConcurrencySafe`:

```
isReadOnly: true  → isConcurrencySafe: true   (almost always)
isReadOnly: false → isConcurrencySafe: false   (almost always)
```

But they're separate flags because the concepts are different:
- `isReadOnly` is about **what the tool does** (reads vs. modifies)
- `isConcurrencySafe` is about **whether it's safe to run in parallel**

A tool could theoretically be read-only but not concurrency-safe (e.g., if it
uses a connection pool with limited slots) or write but concurrency-safe (e.g.,
if it uses atomic operations with unique keys).

## Why Not Just Check If Tools Touch the Same File?

You might think: "Just check if two write tools target the same file. If they
target different files, run them in parallel."

This sounds reasonable but is fragile in practice:

1. **Shell commands are opaque**: `Bash({ command: "npm install" })` — what files
   does this touch? You can't know without running it.

2. **Transitive dependencies**: Writing `index.ts` might trigger a file watcher
   that regenerates `index.js`.

3. **Tool interactions**: Writing a config file, then running a build command that
   reads it — the order matters.

4. **Filesystem semantics**: On some systems, even reading a file updates its
   access timestamp.

The conservative approach (mark write tools as unsafe) is simpler and correct.
The performance cost of sequential execution is small compared to the debugging
cost of race conditions.

## Real-World Example

The model asks to read three files and then edit one:

```json
[
  { "name": "Read", "input": { "file_path": "src/a.ts" } },
  { "name": "Read", "input": { "file_path": "src/b.ts" } },
  { "name": "Read", "input": { "file_path": "src/c.ts" } },
  { "name": "Edit", "input": { "file_path": "src/a.ts", "old": "x", "new": "y" } }
]
```

Concurrency safety analysis:
- Read(a.ts) → `isConcurrencySafe: true`
- Read(b.ts) → `isConcurrencySafe: true`
- Read(c.ts) → `isConcurrencySafe: true`
- Edit(a.ts) → `isConcurrencySafe: false`

The partitioning algorithm (Lesson 28) uses this to create:
- **Batch 1** (concurrent): Read(a.ts), Read(b.ts), Read(c.ts)
- **Batch 2** (serial): Edit(a.ts)

The three reads happen simultaneously, then the edit runs alone. Best of both
worlds: parallel speed for reads, serial safety for writes.

## The Default Is Safety

Remember from Lesson 24: `TOOL_DEFAULTS.isConcurrencySafe = false`.

If you create a new tool and forget to set the flag, it defaults to `false` —
the tool will run serially. This is intentional: it's better to be slower than
to risk data corruption.

```typescript
// Forgot to set isConcurrencySafe
const MyTool = buildTool({
  name: "MyTool",
  description: "Does something",
  inputSchema: z.object({ input: z.string() }),
  async call(input) { /* ... */ },
});

// MyTool.isConcurrencySafe === false (safe default)
```

To enable concurrency, you must **explicitly opt in**:

```typescript
const MyTool = buildTool({
  name: "MyTool",
  description: "Does something",
  inputSchema: z.object({ input: z.string() }),
  isConcurrencySafe: true,  // explicitly declaring safety
  isReadOnly: true,
  async call(input) { /* ... */ },
});
```

## Key Takeaways

1. `isConcurrencySafe` declares whether a tool can run alongside other tools
2. It can be a boolean or a function that checks the specific input
3. Read-only tools are typically safe; write tools are typically not
4. The default is `false` — you opt *in* to concurrency
5. The conservative approach prevents race conditions at the cost of some speed
6. Input-based validation runs through `safeParse` before the dynamic check

## What's Next

Now that each tool knows if it's safe to parallelize, how does the runtime
actually partition a batch of tool calls into concurrent and serial groups?
That's the job of `partitionToolCalls()`.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Safe Default

**Question:** Why is `isConcurrencySafe` defaulted to `false`? What's the worst-case outcome of a false positive (marking unsafe as safe) vs. a false negative (marking safe as unsafe)?

[View Answer](../../answers/03-tool-system/answer-27.md#exercise-1)

### Exercise 2 — Dynamic Concurrency Check

**Challenge:** Write a dynamic `isConcurrencySafe` function for a `DatabaseQuery` tool. The function should return `true` for SELECT queries and `false` for INSERT, UPDATE, DELETE, and DROP queries. Parse the command string to determine the query type.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-27.md#exercise-2)

### Exercise 3 — Implement isConcurrencySafeForInput

**Challenge:** Implement the `isConcurrencySafeForInput(tool, input)` function that handles both the boolean and function forms of `isConcurrencySafe`. When it's a function, validate the input with `safeParse` first and return `false` for invalid input.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-27.md#exercise-3)

### Exercise 4 — Why Not File-Based Checking?

**Question:** The lesson asks: why not just check if two write tools target the same file? Give at least three concrete reasons why this approach is fragile in practice, with examples for each.

[View Answer](../../answers/03-tool-system/answer-27.md#exercise-4)

---

*Module 03: The Tool System — Lesson 27 of 35*
