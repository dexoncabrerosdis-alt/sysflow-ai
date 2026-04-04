# Answers: Lesson 25 — The Tool Registry

## Exercise 1
**Question:** Describe the complete flow from individual tool files to what the model sees in the API request.

**Answer:**
1. **Individual tool files** (e.g., `FileReadTool.ts`, `GrepTool.ts`) each export a `Tool` object created with `buildTool()`.
2. **`getAllBaseTools()`** collects every built-in tool into a flat array, with conditional inclusion for platform-specific and feature-flagged tools.
3. **`getTools()`** filters the master list: removes disabled tools (`isEnabled: false`), restricts to `REPL_ALLOWED_TOOLS` in REPL mode, and removes tools explicitly denied by permission rules.
4. **`assembleToolPool()`** merges the filtered built-in tools with MCP tools from connected external servers. Built-in tools take priority on name collisions.
5. **`sortToolsForCacheStability()`** sorts the merged list deterministically (built-in first alphabetically, then MCP alphabetically) to maximize Anthropic's prompt prefix cache hits.
6. **`toolToAPIFormat()`** converts each tool's Zod `inputSchema` to JSON Schema using `zodToJsonSchema`, producing `{ name, description, input_schema }` objects.
7. **`anthropic.messages.create({ tools: [...] })`** sends the converted tool list as part of the API request, where the model sees the names, descriptions, and schemas.

---

## Exercise 2
**Challenge:** Implement a `getTools()` function that filters tools based on enabled status, REPL mode, and denied tools.

**Answer:**

```typescript
type Tool = {
  name: string;
  isEnabled: boolean;
  [key: string]: unknown;
};

const REPL_ALLOWED_TOOLS = new Set([
  "Read", "Write", "Edit", "Bash", "Grep", "Glob", "TodoWrite",
]);

function getTools(
  allTools: Tool[],
  options: { isReplMode: boolean; deniedTools: string[] }
): Tool[] {
  const deniedSet = new Set(options.deniedTools);

  return allTools.filter((tool) => {
    if (!tool.isEnabled) return false;

    if (options.isReplMode && !REPL_ALLOWED_TOOLS.has(tool.name)) {
      return false;
    }

    if (deniedSet.has(tool.name)) return false;

    return true;
  });
}

// Example usage:
const allTools = [
  { name: "Read", isEnabled: true },
  { name: "Write", isEnabled: true },
  { name: "WebSearch", isEnabled: true },
  { name: "Debug", isEnabled: false },
  { name: "Bash", isEnabled: true },
];

// Normal mode, Bash denied:
getTools(allTools, { isReplMode: false, deniedTools: ["Bash"] });
// → [Read, Write, WebSearch]

// REPL mode:
getTools(allTools, { isReplMode: true, deniedTools: [] });
// → [Read, Write, Bash]  (WebSearch not in REPL_ALLOWED_TOOLS)
```

**Explanation:** Three filter stages in order: `isEnabled` check, REPL mode restriction, and explicit denial. Each is a simple boolean check. The `deniedSet` converts the array to a Set for O(1) lookups. Disabled tools (like Debug) are always removed regardless of mode.

---

## Exercise 3
**Challenge:** Write an `assembleToolPool()` function that merges built-in and MCP tools.

**Answer:**

```typescript
type Tool = {
  name: string;
  description: string;
  isReadOnly: boolean;
  call: (input: unknown) => Promise<string>;
  [key: string]: unknown;
};

type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type McpServer = {
  name: string;
  listTools(): Promise<McpToolDefinition[]>;
  callTool(name: string, input: unknown): Promise<string>;
};

function wrapMcpTool(mcpTool: McpToolDefinition, server: McpServer): Tool {
  return {
    name: `mcp_${server.name}_${mcpTool.name}`,
    description: mcpTool.description,
    isReadOnly: false,  // conservative default for external tools
    isConcurrencySafe: false,
    isEnabled: true,
    async call(input: unknown) {
      return await server.callTool(mcpTool.name, input);
    },
  };
}

async function assembleToolPool(
  builtInTools: Tool[],
  mcpServers: McpServer[]
): Promise<Tool[]> {
  const mcpTools: Tool[] = [];
  for (const server of mcpServers) {
    const serverTools = await server.listTools();
    for (const mcpTool of serverTools) {
      mcpTools.push(wrapMcpTool(mcpTool, server));
    }
  }

  // Built-in tools take priority on name collision
  const toolMap = new Map<string, Tool>();
  for (const tool of mcpTools) {
    toolMap.set(tool.name, tool);
  }
  for (const tool of builtInTools) {
    toolMap.set(tool.name, tool);  // overwrites MCP if same name
  }

  return Array.from(toolMap.values());
}
```

**Explanation:** MCP tools are wrapped with a namespaced name (`mcp_serverName_toolName`) to avoid collisions, conservative defaults (`isReadOnly: false`, `isConcurrencySafe: false`), and a `call()` that delegates to the MCP server. The merge uses a Map where built-in tools are inserted last, overwriting any MCP tools with the same name.

---

## Exercise 4
**Question:** Why does Claude Code sort tools deterministically before sending them to the API? What problem does this solve?

**Answer:** Anthropic's API caches prompt prefixes. The tool list is part of the prompt, so if the tool ordering changes between requests — even with the same tools — the cache is invalidated and the entire prompt must be re-processed, costing more tokens and adding latency. By sorting tools deterministically (built-in alphabetically first, then MCP alphabetically), the same set of tools always produces the exact same ordering. This maximizes cache hit rates across consecutive API requests in the same session. Without stable sorting, adding or removing a single MCP server connection could shuffle the entire tool list, invalidating the cache for all tools — including the unchanged built-in tools that make up the majority of the list. The cost savings from cache hits compound over an entire conversation.
