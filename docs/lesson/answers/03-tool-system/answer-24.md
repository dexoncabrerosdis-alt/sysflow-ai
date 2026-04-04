# Answers: Lesson 24 — The buildTool Factory

## Exercise 1
**Question:** What are the four `TOOL_DEFAULTS` values and why was each one chosen as the default?

**Answer:**
1. **`isEnabled: true`** — Tools should be available by default. It would be confusing to create a tool and have it silently missing because you forgot to enable it. You only set `false` for exceptional cases (feature flags, platform restrictions).
2. **`isConcurrencySafe: false`** — The safe default. If you forget this flag, the tool runs serially — possibly slower, but never causing race conditions. You must *explicitly opt in* to parallel execution, which forces you to think about whether it's actually safe.
3. **`isReadOnly: false`** — Also the safe default. If you forget this flag, the permission system treats the tool as a write tool that needs user approval. Better to over-prompt than to let a destructive tool slip through without permission checks.
4. **`checkPermissions: async () => ({ allowed: true })`** — Tools are allowed by default. Individual tools that need permission gating override this with their own logic. This avoids boilerplate for the many tools that don't need custom permission checks.

The guiding principle: when in doubt, default to the more restrictive (safer) option for safety-critical flags, and the more permissive option for availability flags.

---

## Exercise 2
**Question:** Explain the difference between `ToolDef` and `Tool`. Why does the system need two separate types?

**Answer:** `ToolDef` is what the developer writes — a partial definition where only `name`, `description`, `inputSchema`, and `call` are required, and everything else is optional. `Tool` is the complete object the system uses internally — all core fields like `isEnabled`, `isReadOnly`, and `isConcurrencySafe` are guaranteed to be present. The system needs two types because (a) developers shouldn't have to type out every property when defaults suffice, reducing boilerplate and errors, and (b) the runtime code that processes tools shouldn't have to check for `undefined` on every access. `buildTool()` is the bridge: it takes a `ToolDef` and returns a `Tool` by spreading `TOOL_DEFAULTS` first, then the definition's overrides on top. Fields you don't specify get filled by the defaults.

---

## Exercise 3
**Challenge:** Use `buildTool()` to create a `DirectorySize` tool.

**Answer:**

```typescript
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { buildTool, Tool, ToolContext } from "./Tool";

const DirectorySizeTool: Tool = buildTool({
  name: "DirectorySize",
  description:
    "Calculate the total size in bytes of all files in a directory. " +
    "Does not follow symlinks. Returns the total size and file count.",

  inputSchema: z.object({
    directory: z.string().describe("Absolute path to the directory to measure"),
    recursive: z.boolean().optional().default(true).describe(
      "Include subdirectories. Defaults to true."
    ),
  }),

  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 1_000,

  async call(input: { directory: string; recursive: boolean }, context: ToolContext) {
    const dir = path.resolve(context.options.cwd, input.directory);
    let totalSize = 0;
    let fileCount = 0;

    async function walk(dirPath: string): Promise<void> {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isFile()) {
          const stats = await fs.stat(fullPath);
          totalSize += stats.size;
          fileCount++;
        } else if (entry.isDirectory() && input.recursive) {
          await walk(fullPath);
        }
      }
    }

    await walk(dir);

    const sizeKB = (totalSize / 1024).toFixed(1);
    const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
    return `Directory: ${input.directory}\nFiles: ${fileCount}\nTotal size: ${totalSize} bytes (${sizeKB} KB / ${sizeMB} MB)`;
  },
});
```

**Explanation:** Only `isReadOnly`, `isConcurrencySafe`, and `maxResultSizeChars` are explicitly set — the rest use defaults. Since we read but never modify files, it's read-only and concurrency-safe. `isEnabled` defaults to `true`, and `checkPermissions` defaults to always-allow — both correct for a read-only tool.

---

## Exercise 4
**Challenge:** Write an enhanced `buildToolStrict()` factory with additional validations.

**Answer:**

```typescript
import { buildTool, ToolDef, Tool } from "./Tool";

function buildToolStrict(def: ToolDef): Tool {
  // Validate PascalCase name
  const pascalCaseRegex = /^[A-Z][a-zA-Z0-9]*$/;
  if (!pascalCaseRegex.test(def.name)) {
    throw new Error(
      `Tool name "${def.name}" must be PascalCase (e.g., "MyTool", "ReadFile")`
    );
  }

  // Validate description length
  if (def.description.length < 20) {
    throw new Error(
      `Tool "${def.name}" description must be at least 20 characters. ` +
      `Got ${def.description.length}: "${def.description}"`
    );
  }

  // Warn if read-only but not concurrency-safe
  if (def.isReadOnly === true && def.isConcurrencySafe === false) {
    console.warn(
      `Warning: Tool "${def.name}" is read-only but not marked concurrency-safe. ` +
      `Read-only tools are almost always safe to parallelize. ` +
      `Set isConcurrencySafe: true unless this tool has shared mutable state.`
    );
  }

  return buildTool(def);
}
```

**Explanation:** Three checks: PascalCase is enforced with a regex; description length catches lazy one-word descriptions; the read-only + not-concurrent-safe check is a *warning* (not an error) because there are rare valid cases (e.g., a read-only tool using a connection pool). The function delegates to the standard `buildTool()` after validation.

---

## Exercise 5
**Challenge:** Write out the complete `Tool` object that results from the given `buildTool` call.

**Answer:**

```typescript
{
  // From the definition (explicit overrides)
  name: "Ping",
  description: "Check if a host is reachable",
  inputSchema: z.object({ host: z.string() }),
  isReadOnly: true,
  call: async (input) => `Pong: ${input.host}`,

  // From TOOL_DEFAULTS (not overridden)
  isEnabled: true,
  isConcurrencySafe: false,
  checkPermissions: async () => ({ allowed: true }),

  // Not specified, no default — undefined
  aliases: undefined,
  maxResultSizeChars: undefined,
  validateInput: undefined,
}
```

**Explanation:** The spread `{ ...TOOL_DEFAULTS, ...definition }` means the definition's `isReadOnly: true` overrides the default `false`, while `isConcurrencySafe` stays at the default `false` since it wasn't specified. Note that `isConcurrencySafe` should probably be `true` for a read-only ping tool — this is exactly the kind of oversight that `buildToolStrict()` from Exercise 4 would catch.
