# Lesson 24: The buildTool Factory

## The Problem: Boilerplate

If you define tools using the raw `Tool` type from Lesson 22, every tool needs to
specify every property—even the ones that are almost always the same. Most tools
are enabled. Most tools aren't concurrency-safe. Most tools don't override the
default permission check.

Writing all that out for 40+ tools is tedious and error-prone. Worse, if you forget
to set `isEnabled: true`, your tool silently disappears.

## The Solution: `buildTool()`

Claude Code provides a factory function called `buildTool()` that merges your
partial tool definition with a set of sensible defaults:

```typescript
function buildTool(definition: ToolDef): Tool {
  return {
    ...TOOL_DEFAULTS,
    ...definition,
  };
}
```

That's the core idea—spread defaults, then spread your overrides.

## TOOL_DEFAULTS

Here are the default values that every tool starts with:

```typescript
const TOOL_DEFAULTS = {
  isEnabled: true,
  isConcurrencySafe: false,
  isReadOnly: false,
  checkPermissions: async () => ({ allowed: true }),
};
```

Let's unpack each:

### `isEnabled: true`

Tools are enabled by default. You only set `isEnabled: false` when a tool should
be conditionally available (feature flag, platform-specific, etc.).

### `isConcurrencySafe: false`

The **safe default**. If you forget to mark a tool as concurrency-safe, it won't
run in parallel with other tools—which might be slower but can't cause race
conditions. You opt *in* to concurrency, not out.

### `isReadOnly: false`

Also the safe default. If you forget to mark a tool as read-only, the permission
system will treat it as a write tool that needs approval. Better to be overly
cautious than to accidentally let a destructive operation slip through.

### `checkPermissions: async () => ({ allowed: true })`

By default, a tool is allowed to execute. Individual tools override this when they
need permission checks (file writes, command execution, etc.).

## ToolDef vs Tool

The types are related but different:

```typescript
// What you write — partial, minimal
type ToolDef = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  call(input: unknown, context: ToolContext): Promise<ToolResult | string>;

  // All optional — defaults fill these in
  aliases?: string[];
  isEnabled?: boolean;
  isReadOnly?: boolean;
  isConcurrencySafe?: boolean | ((input: unknown) => boolean);
  maxResultSizeChars?: number;
  validateInput?(input: unknown): Promise<ValidationResult>;
  checkPermissions?(input: unknown, context: ToolContext): Promise<PermissionCheckResult>;
};

// What the system uses — complete, every field present
type Tool = Required<Pick<ToolDef,
  "name" | "description" | "inputSchema" | "call" |
  "isEnabled" | "isReadOnly" | "isConcurrencySafe"
>> & Partial<Pick<ToolDef,
  "aliases" | "maxResultSizeChars" | "validateInput" | "checkPermissions"
>>;
```

Think of it as:
- **`ToolDef`**: the blueprint you write (partial)
- **`Tool`**: the complete object the system uses (all required fields guaranteed)

## Using buildTool in Practice

### A Minimal Tool

```typescript
const GlobTool = buildTool({
  name: "Glob",
  description: "Find files matching a glob pattern",
  inputSchema: z.object({
    pattern: z.string().describe("Glob pattern to match"),
    path: z.string().optional().describe("Directory to search in"),
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input) {
    const matches = await glob(input.pattern, { cwd: input.path });
    return matches.join("\n");
  },
});
```

After `buildTool`, this becomes:

```typescript
{
  name: "Glob",
  description: "Find files matching a glob pattern",
  inputSchema: /* the Zod schema */,
  isEnabled: true,                              // ← from defaults
  isReadOnly: true,                             // ← from definition
  isConcurrencySafe: true,                      // ← from definition
  checkPermissions: async () => ({ allowed: true }), // ← from defaults
  call: /* the function */,
}
```

### A Write Tool with Permissions

```typescript
const FileWriteTool = buildTool({
  name: "Write",
  description: "Write content to a file on the filesystem",
  inputSchema: z.object({
    file_path: z.string().describe("Absolute path to write to"),
    content: z.string().describe("Content to write"),
  }),
  // isReadOnly defaults to false — correct for a write tool
  // isConcurrencySafe defaults to false — correct, file writes shouldn't race
  async checkPermissions(input, context) {
    return context.permissionManager.check("Write", input.file_path);
  },
  async call(input) {
    await fs.writeFile(input.file_path, input.content, "utf-8");
    return `Successfully wrote ${input.content.length} characters to ${input.file_path}`;
  },
});
```

Notice: we didn't set `isReadOnly` or `isConcurrencySafe`. The defaults (`false`)
are exactly what we want for a write tool.

### A Platform-Specific Tool

```typescript
const PowerShellTool = buildTool({
  name: "PowerShell",
  description: "Execute a PowerShell command",
  inputSchema: z.object({
    command: z.string().describe("The PowerShell command to run"),
  }),
  isEnabled: process.platform === "win32",
  async call(input) {
    return execSync(`powershell -Command "${input.command}"`).toString();
  },
});
```

On macOS or Linux, this tool simply won't appear in the tool list.

### A Feature-Flagged Tool

```typescript
const WebSearchTool = buildTool({
  name: "WebSearch",
  description: "Search the web for information",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
  }),
  isEnabled: featureFlags.isEnabled("web-search"),
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input) {
    return await searchWeb(input.query);
  },
});
```

## The Full buildTool Implementation

Here's a more complete version of `buildTool` with additional processing:

```typescript
function buildTool(def: ToolDef): Tool {
  const tool: Tool = {
    ...TOOL_DEFAULTS,
    ...def,
  };

  // Freeze the schema to prevent accidental mutation
  Object.freeze(tool.inputSchema);

  // Validate the tool definition itself
  if (!tool.name || typeof tool.name !== "string") {
    throw new Error("Tool must have a name");
  }
  if (!tool.description || typeof tool.description !== "string") {
    throw new Error(`Tool "${tool.name}" must have a description`);
  }
  if (!tool.inputSchema) {
    throw new Error(`Tool "${tool.name}" must have an inputSchema`);
  }
  if (typeof tool.call !== "function") {
    throw new Error(`Tool "${tool.name}" must have a call function`);
  }

  return tool;
}
```

This validates that the tool definition itself is well-formed at registration time,
not at runtime when a user is waiting.

## Why This Pattern Matters

The factory pattern gives you:

1. **Consistency**: Every tool has the same set of properties, guaranteed
2. **Safe defaults**: Forget a flag? The safe option is used
3. **Brevity**: Simple tools need very little code
4. **Discoverability**: Reading a tool definition tells you only what's *different*
   from the defaults
5. **Maintainability**: Changing a default in one place affects all tools

This is a common pattern in any system with many similar objects. Express middleware,
React components, database models—they all use some form of "defaults + overrides."

## Pattern Comparison

Without `buildTool`:

```typescript
const MyTool = {
  name: "MyTool",
  description: "Does something",
  inputSchema: z.object({ input: z.string() }),
  isEnabled: true,              // have to remember this
  isReadOnly: true,
  isConcurrencySafe: true,
  checkPermissions: async () => ({ allowed: true }),  // have to remember this
  async call(input) { return "result"; },
};
```

With `buildTool`:

```typescript
const MyTool = buildTool({
  name: "MyTool",
  description: "Does something",
  inputSchema: z.object({ input: z.string() }),
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input) { return "result"; },
});
```

Fewer lines, fewer chances for mistakes, clearer intent.

## Key Takeaways

1. `buildTool()` merges your definition with `TOOL_DEFAULTS`
2. Defaults are **safe**: disabled concurrency, non-read-only, permissive permissions
3. `ToolDef` is what you write (partial); `Tool` is what the system uses (complete)
4. Platform checks and feature flags go in `isEnabled`
5. The pattern eliminates boilerplate and enforces consistency

## What's Next

Individual tools are built. Now how do they get organized into the pool of
available tools? Let's explore the tool registry.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Default Safety Philosophy

**Question:** What are the four `TOOL_DEFAULTS` values and why was each one chosen as the default? Explain the "safe default" principle that guides these choices.

[View Answer](../../answers/03-tool-system/answer-24.md#exercise-1)

### Exercise 2 — ToolDef vs Tool

**Question:** Explain the difference between `ToolDef` and `Tool`. Why does the system need two separate types? What happens to the `ToolDef` fields you don't specify?

[View Answer](../../answers/03-tool-system/answer-24.md#exercise-2)

### Exercise 3 — Build a DirectorySize Tool

**Challenge:** Use `buildTool()` to create a `DirectorySize` tool that calculates the total size (in bytes) of all files in a given directory. Set appropriate flags for a read-only, concurrency-safe tool. Only specify properties that differ from the defaults.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-24.md#exercise-3)

### Exercise 4 — Enhanced buildTool

**Challenge:** Write an enhanced `buildToolStrict()` factory that wraps `buildTool()` and adds these validations: (a) name must be PascalCase, (b) description must be at least 20 characters, (c) if `isReadOnly` is true then `isConcurrencySafe` must also be true (warn if not). Throw descriptive errors for violations.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-24.md#exercise-4)

### Exercise 5 — Defaults Expansion

**Challenge:** Given this `buildTool` call, write out the complete `Tool` object that results, showing every property including those filled by defaults:

```typescript
const MyTool = buildTool({
  name: "Ping",
  description: "Check if a host is reachable",
  inputSchema: z.object({ host: z.string() }),
  isReadOnly: true,
  async call(input) { return `Pong: ${input.host}`; },
});
```

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-24.md#exercise-5)

---

*Module 03: The Tool System — Lesson 24 of 35*
