# Answers: Lesson 27 — Concurrency Safety

## Exercise 1
**Question:** Why is `isConcurrencySafe` defaulted to `false`? What's the worst-case outcome of a false positive vs. a false negative?

**Answer:** The default is `false` because the consequences of the two mistakes are asymmetric:

- **False positive** (marking unsafe tool as safe): The tool runs in parallel with others, causing race conditions — two writes to the same file corrupt data, concurrent edits overwrite each other, shell commands interfere with each other. Bugs from race conditions are subtle, intermittent, and extremely hard to reproduce and debug. Data could be silently corrupted without anyone noticing.

- **False negative** (marking safe tool as unsafe): The tool runs serially instead of in parallel. The only cost is performance — operations take a bit longer than necessary. No data is corrupted, no bugs are introduced, correctness is preserved.

Since a false positive risks data corruption while a false negative only costs performance, the safe default is `false`. You must *explicitly opt in* to concurrency, which forces you to actively think about whether it's truly safe.

---

## Exercise 2
**Challenge:** Write a dynamic `isConcurrencySafe` function for a `DatabaseQuery` tool.

**Answer:**

```typescript
import { z } from "zod";
import { buildTool } from "./Tool";

const DatabaseQueryTool = buildTool({
  name: "DatabaseQuery",
  description: "Execute a SQL query against the database",

  inputSchema: z.object({
    query: z.string().describe("The SQL query to execute"),
    database: z.enum(["primary", "replica"]).optional()
      .default("primary").describe("Target database"),
  }),

  isReadOnly: false,

  isConcurrencySafe: (input: { query: string; database?: string }) => {
    const normalized = input.query.trim().toUpperCase();

    // SELECT queries are read-only and safe to parallelize
    if (normalized.startsWith("SELECT")) {
      return true;
    }

    // EXPLAIN and SHOW queries are safe
    if (normalized.startsWith("EXPLAIN") || normalized.startsWith("SHOW")) {
      return true;
    }

    // Queries targeting replica are always safe (replica is read-only)
    if (input.database === "replica") {
      return true;
    }

    // INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE — not safe
    return false;
  },

  async call(input) {
    // ... execute the query
    return "Query executed";
  },
});
```

**Explanation:** The function parses the SQL to determine query type. SELECT, EXPLAIN, and SHOW are pure reads — safe to parallelize. Anything targeting a read replica is also safe. Write operations (INSERT, UPDATE, DELETE, DROP) return `false`. The tool-level `isReadOnly` is `false` because it *can* write, but the dynamic check enables parallelism for the common read case.

---

## Exercise 3
**Challenge:** Implement `isConcurrencySafeForInput()`.

**Answer:**

```typescript
import { z } from "zod";

type Tool = {
  name: string;
  inputSchema: z.ZodType;
  isConcurrencySafe: boolean | ((input: unknown) => boolean);
};

function isConcurrencySafeForInput(tool: Tool, input: unknown): boolean {
  // Static boolean — return directly
  if (typeof tool.isConcurrencySafe === "boolean") {
    return tool.isConcurrencySafe;
  }

  // Dynamic function — validate input first
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    // Invalid input → treat as unsafe (conservative choice)
    return false;
  }

  // Call the function with validated, well-typed data
  return tool.isConcurrencySafe(parsed.data);
}

// Test cases:
const readTool = {
  name: "Read",
  inputSchema: z.object({ path: z.string() }),
  isConcurrencySafe: true,
};
console.log(isConcurrencySafeForInput(readTool, { path: "a.ts" })); // true

const dynamicTool = {
  name: "SmartWrite",
  inputSchema: z.object({ path: z.string() }),
  isConcurrencySafe: (input: { path: string }) => input.path.startsWith("/tmp/"),
};
console.log(isConcurrencySafeForInput(dynamicTool, { path: "/tmp/a.txt" })); // true
console.log(isConcurrencySafeForInput(dynamicTool, { path: "/src/a.ts" })); // false
console.log(isConcurrencySafeForInput(dynamicTool, { path: 42 }));          // false (invalid)
```

**Explanation:** The function handles two code paths. For booleans, it returns the value directly. For functions, it validates the input with `safeParse` first — if the input is malformed, it returns `false` (conservative). Only validated data is passed to the dynamic check function, ensuring it receives the expected types.

---

## Exercise 4
**Question:** Why not just check if two write tools target the same file? Give at least three reasons with examples.

**Answer:**

1. **Shell commands are opaque.** `Bash({ command: "npm install" })` — what files does this modify? It writes `node_modules/`, updates `package-lock.json`, and potentially modifies other files through postinstall scripts. You can't determine the affected files without actually running the command.

2. **Transitive dependencies exist.** Writing to `webpack.config.js` might trigger a file watcher that regenerates `dist/bundle.js`. Two tools might not touch the same file directly, but their downstream effects could conflict. The Write tool only knows about its immediate target, not the cascade of side effects.

3. **Tool interactions create ordering dependencies.** Tool A writes a config file, then Tool B runs a build that reads that config. Even though they touch different files, Tool B depends on Tool A's output being complete. Running them in parallel means B might read stale config.

4. **Filesystem semantics are complex.** On some systems, even reading a file updates its access timestamp (`atime`). Directory metadata changes when files are created inside it. Two "independent" writes to different files in the same directory both modify the directory's metadata.

The conservative approach (mark write tools as unsafe) is simpler, always correct, and the performance cost of serial execution is far less than the debugging cost of intermittent race condition bugs.
