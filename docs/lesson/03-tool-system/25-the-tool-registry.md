# Lesson 25: The Tool Registry

## From Individual Tools to a Tool Pool

You've seen how individual tools are defined with `buildTool()`. But when Claude Code
starts up, it needs to assemble a complete list of all available tools, filter them
based on the current environment, and present them to the model. This is the job of
the **tool registry**.

## `getAllBaseTools()`: The Master List

At the bottom of `tools.ts`, there's a function that returns every built-in tool:

```typescript
function getAllBaseTools(): Tool[] {
  return [
    // File tools
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    NotebookEditTool,

    // Search tools
    GrepTool,
    GlobTool,

    // Shell tools
    BashTool,

    // Web tools
    WebFetchTool,
    WebSearchTool,

    // Agent tools
    AgentTool,

    // Task tools
    TodoWriteTool,

    // Utility tools
    AskUserQuestionTool,

    // ... and many more
  ];
}
```

This is a flat array—no hierarchy, no grouping. The categories in the comments are
for humans reading the code, not for the system.

## Conditional Inclusion

Some tools are only included under certain conditions. The `isEnabled` property
handles runtime toggling, but some tools are conditionally *constructed*:

```typescript
function getAllBaseTools(): Tool[] {
  const tools: Tool[] = [
    FileReadTool,
    FileWriteTool,
    GrepTool,
    GlobTool,
  ];

  // Platform-specific shell tool
  if (process.platform === "win32") {
    tools.push(PowerShellTool);
  } else {
    tools.push(BashTool);
  }

  // Feature-flagged tools
  if (featureFlags.isEnabled("web-search")) {
    tools.push(WebSearchTool);
  }

  if (featureFlags.isEnabled("web-fetch")) {
    tools.push(WebFetchTool);
  }

  // Agent capabilities
  if (config.enableSubAgents) {
    tools.push(AgentTool);
    tools.push(SendMessageTool);
    tools.push(ListPeersTool);
  }

  return tools;
}
```

This two-level approach (conditional inclusion + `isEnabled` flag) lets you:
- Completely omit tools that don't make sense in the environment
- Toggle tools on/off without removing their code

## `getTools()`: Filtering for the Current Session

`getAllBaseTools()` returns everything. `getTools()` filters it down to what's
actually available in the current session:

```typescript
function getTools(options: {
  isReplMode: boolean;
  permissionRules: PermissionRule[];
  featureFlags: FeatureFlags;
}): Tool[] {
  const allTools = getAllBaseTools();

  return allTools.filter((tool) => {
    // Must be enabled
    if (!tool.isEnabled) return false;

    // In REPL mode, only include certain tools
    if (options.isReplMode && !REPL_ALLOWED_TOOLS.has(tool.name)) {
      return false;
    }

    // Check if permission rules explicitly deny this tool
    if (isToolDenied(tool.name, options.permissionRules)) {
      return false;
    }

    return true;
  });
}
```

### REPL Mode

When Claude Code runs in a non-interactive context (like a CI pipeline or as a
sub-process), it uses a restricted set of tools:

```typescript
const REPL_ALLOWED_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "TodoWrite",
]);
```

No web browsing, no user questions, no sub-agents. Just the essentials.

### Permission Rules

Users can configure permission rules that deny specific tools entirely:

```json
{
  "permissions": {
    "deny": ["WebSearch", "WebFetch", "Bash"]
  }
}
```

These tools are filtered out before the model ever sees them.

## `assembleToolPool()`: Built-in + MCP Tools

Claude Code supports the Model Context Protocol (MCP), which allows external
servers to provide additional tools. The `assembleToolPool()` function merges
built-in tools with MCP tools:

```typescript
async function assembleToolPool(options: {
  builtInTools: Tool[];
  mcpServers: McpServer[];
}): Promise<Tool[]> {
  const { builtInTools, mcpServers } = options;

  // Gather MCP tools from all connected servers
  const mcpTools: Tool[] = [];
  for (const server of mcpServers) {
    const serverTools = await server.listTools();
    for (const mcpTool of serverTools) {
      mcpTools.push(wrapMcpTool(mcpTool, server));
    }
  }

  // Merge: built-in tools take priority over MCP tools with same name
  const toolMap = new Map<string, Tool>();

  for (const tool of mcpTools) {
    toolMap.set(tool.name, tool);
  }
  for (const tool of builtInTools) {
    toolMap.set(tool.name, tool);  // overwrites MCP if name collides
  }

  return Array.from(toolMap.values());
}
```

MCP tools are wrapped to conform to the same `Tool` interface:

```typescript
function wrapMcpTool(mcpTool: McpToolDefinition, server: McpServer): Tool {
  return buildTool({
    name: `mcp_${server.name}_${mcpTool.name}`,
    description: mcpTool.description,
    inputSchema: jsonSchemaToZod(mcpTool.inputSchema),
    isReadOnly: false,   // conservative default for external tools
    async call(input) {
      return await server.callTool(mcpTool.name, input);
    },
  });
}
```

Notice the namespaced name (`mcp_serverName_toolName`) to avoid collisions.

## Tool Sorting for Prompt Cache Stability

Here's a subtle but important detail. The order in which tools appear in the API
request matters—not for correctness, but for **caching**.

Anthropic's API caches prompt prefixes. If the tool list changes order between
requests, the cache is invalidated and you pay for re-processing the entire prompt.
Claude Code sorts tools deterministically:

```typescript
function sortToolsForCacheStability(tools: Tool[]): Tool[] {
  return [...tools].sort((a, b) => {
    // Built-in tools first, MCP tools second
    const aIsMcp = a.name.startsWith("mcp_");
    const bIsMcp = b.name.startsWith("mcp_");
    if (aIsMcp !== bIsMcp) return aIsMcp ? 1 : -1;

    // Within each group, alphabetical
    return a.name.localeCompare(b.name);
  });
}
```

This ensures the same set of tools always produces the same ordering, maximizing
cache hits and reducing costs.

## The Complete Flow

Here's the full journey from tool definitions to what the model sees:

```
Individual Tool Files (FileReadTool.ts, GrepTool.ts, ...)
         │
         ▼
  getAllBaseTools()          ← master list, conditional inclusion
         │
         ▼
     getTools()             ← filter by enabled, REPL mode, permissions
         │
         ▼
  assembleToolPool()        ← merge with MCP tools
         │
         ▼
  sortToolsForCache()       ← deterministic ordering
         │
         ▼
  toolToAPIFormat()         ← convert Zod → JSON Schema
         │
         ▼
  anthropic.messages.create({ tools: [...] })
```

## The Real Tool List

Here's a representative snapshot of the tools that `getAllBaseTools()` returns,
organized by category:

```typescript
// File Operations
FileReadTool,       // Read file contents
FileWriteTool,      // Write/create files
FileEditTool,       // Surgical text edits (search & replace)
NotebookEditTool,   // Edit Jupyter notebooks

// Search
GrepTool,           // Regex search across files
GlobTool,           // Find files by pattern

// Shell
BashTool,           // Execute bash/shell commands

// Web
WebFetchTool,       // Fetch URL content
WebSearchTool,      // Search the web

// Agent & Communication
AgentTool,          // Launch sub-agents
SendMessageTool,    // Message peer agents
ListPeersTool,      // List available peers

// Task Management
TodoWriteTool,      // Create/update task lists
TaskCreateTool,     // Create background tasks
TaskGetTool,        // Get task status
TaskUpdateTool,     // Update task input
TaskListTool,       // List all tasks
TaskOutputTool,     // Get task output
TaskStopTool,       // Stop a running task

// Planning
EnterPlanModeTool,  // Switch to plan mode
ExitPlanModeTool,   // Exit plan mode

// Utility
AskUserQuestionTool,  // Ask user for input
SkillTool,            // Execute skills
BriefTool,            // Toggle brief mode
ConfigTool,           // Read/modify config
SnipTool,             // Create code snippets
TerminalCaptureTool,  // Capture terminal state

// MCP
ListMcpResourcesTool,  // List MCP resources
ReadMcpResourceTool,   // Read MCP resource
```

## Tool Count and Context Impact

Each tool adds to the system prompt size. With 40+ built-in tools, the tool
definitions alone can consume thousands of tokens. This is one reason why:

1. Descriptions should be concise but complete
2. Input schemas should be minimal
3. Tools that aren't needed should be filtered out
4. Sorting order is stable for caching

## Key Takeaways

1. `getAllBaseTools()` is the master list of every built-in tool
2. `getTools()` filters by `isEnabled`, REPL mode, and permission rules
3. `assembleToolPool()` merges built-in and MCP tools
4. Tools are sorted deterministically for prompt cache stability
5. The full pipeline is: define → collect → filter → merge → sort → convert → send

## What's Next

Now that we understand how tools are registered, let's explore one of the most
important distinctions in the tool system: read-only vs. write tools.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Full Pipeline

**Question:** Describe the complete flow from individual tool files to what the model sees in the API request. Name each function in order and what it does.

[View Answer](../../answers/03-tool-system/answer-25.md#exercise-1)

### Exercise 2 — Implement getTools Filter

**Challenge:** Implement a `getTools()` function that takes an array of `Tool` objects and an options object with `isReplMode: boolean` and `deniedTools: string[]`. Filter out disabled tools, tools not in `REPL_ALLOWED_TOOLS` when in REPL mode, and explicitly denied tools. Return the filtered array.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-25.md#exercise-2)

### Exercise 3 — Implement assembleToolPool

**Challenge:** Write an `assembleToolPool()` function that merges a `builtInTools` array and an `mcpTools` array. Requirements: (a) built-in tools take priority when names collide, (b) MCP tool names are prefixed with `mcp_serverName_`, (c) return a flat array. Include a `wrapMcpTool()` helper.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-25.md#exercise-3)

### Exercise 4 — Cache-Stable Sorting

**Question:** Why does Claude Code sort tools deterministically before sending them to the API? What specific problem does this solve, and what would happen if tools were sent in random order?

[View Answer](../../answers/03-tool-system/answer-25.md#exercise-4)

---

*Module 03: The Tool System — Lesson 25 of 35*
