# Lesson 103: MCP Integration — Model Context Protocol

## What MCP Solves

Claude Code ships with built-in tools: Read, Write, Bash, Grep, and others. These cover general-purpose coding tasks. But what about your company's internal API? Your custom deployment tool? Your database query runner?

You could fork Claude Code and add tools. But then you're maintaining a fork. Every upstream update requires merging. Your tools are locked to one agent.

**Model Context Protocol (MCP)** solves this by defining a standard protocol for tools. MCP servers expose tools, resources, and prompts over a JSON-RPC transport. Any MCP-compatible agent can connect to any MCP server. Your tools work with Claude Code, with other agents, with any client.

## MCP Architecture

```
┌──────────────────────────────────────────────┐
│              Claude Code (MCP Client)        │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │          assembleToolPool()            │  │
│  │                                        │  │
│  │  Built-in Tools    MCP Tools           │  │
│  │  ┌──────────┐     ┌──────────────┐    │  │
│  │  │ Read     │     │ query_db     │    │  │
│  │  │ Write    │     │ deploy_app   │    │  │
│  │  │ Bash     │     │ check_ci     │    │  │
│  │  │ Grep     │     │ get_metrics  │    │  │
│  │  │ ...      │     │ ...          │    │  │
│  │  └──────────┘     └──────┬───────┘    │  │
│  └──────────────────────────┼────────────┘  │
│                             │                │
└─────────────────────────────┼────────────────┘
                              │ JSON-RPC
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │ DB Server│   │ CI Server│   │ Deploy   │
        │ (MCP)    │   │ (MCP)    │   │ Server   │
        └──────────┘   └──────────┘   └──────────┘
```

## MCP Server Configuration

Users configure MCP servers in their project or user settings:

```json
// .claude/config.json
{
  "mcpServers": {
    "database": {
      "command": "npx",
      "args": ["@company/db-mcp-server"],
      "env": {
        "DATABASE_URL": "postgresql://localhost:5432/mydb"
      }
    },
    "github": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-filesystem", "/data"]
    }
  }
}
```

Each entry specifies how to spawn the MCP server process. The agent starts these processes and communicates with them via stdin/stdout JSON-RPC.

## assembleToolPool: Merging Tool Sources

When the agent starts, it assembles all available tools from multiple sources:

```typescript
async function assembleToolPool(
  settings: Settings,
  mcpConnections: McpConnection[],
): Promise<ToolPool> {
  // 1. Built-in tools — always available
  const builtInTools = getBuiltInTools();

  // 2. MCP tools — from connected servers
  const mcpTools: Tool[] = [];
  for (const connection of mcpConnections) {
    const serverTools = await connection.listTools();
    for (const tool of serverTools) {
      mcpTools.push({
        name: `mcp__${connection.serverName}__${tool.name}`,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: async (input) => {
          return await connection.callTool(tool.name, input);
        },
        source: "mcp",
        serverName: connection.serverName,
      });
    }
  }

  // 3. Merge: built-in tools take priority
  return {
    tools: [...builtInTools, ...mcpTools],
    byName: new Map(
      [...builtInTools, ...mcpTools].map(t => [t.name, t])
    ),
  };
}
```

MCP tools are namespaced: `mcp__database__query_db`. This prevents name collisions between servers and with built-in tools.

## getMcpInstructions: Injecting Server Context

MCP servers can provide instructions that get injected into the system prompt:

```typescript
async function getMcpInstructions(
  mcpConnections: McpConnection[],
): Promise<string> {
  const instructions: string[] = [];

  for (const connection of mcpConnections) {
    const serverInfo = await connection.getServerInfo();

    if (serverInfo.instructions) {
      instructions.push(
        `## MCP Server: ${connection.serverName}\n\n` +
        serverInfo.instructions
      );
    }
  }

  if (instructions.length === 0) return "";

  return (
    "\n\n# Connected MCP Servers\n\n" +
    "The following external tool servers are connected. " +
    "Use their tools when relevant to the user's request.\n\n" +
    instructions.join("\n\n")
  );
}
```

This is injected into the system prompt so the model knows what MCP tools are available and how to use them:

```typescript
function buildSystemPrompt(settings: Settings, mcpInstructions: string): string {
  return BASE_SYSTEM_PROMPT + mcpInstructions;
}
```

## MCP Resources: ListMcpResources and ReadMcpResource

MCP servers can also expose **resources** — files, database schemas, API docs — that the agent can read:

```typescript
// Built-in tools for MCP resource access

const ListMcpResources: Tool = {
  name: "ListMcpResources",
  description: "List available resources from connected MCP servers",
  inputSchema: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "MCP server name to list resources from",
      },
    },
  },
  async execute({ server }, context) {
    const connection = context.mcpConnections.find(
      c => c.serverName === server
    );
    if (!connection) {
      return { error: `MCP server '${server}' not found` };
    }

    const resources = await connection.listResources();
    return {
      resources: resources.map(r => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    };
  },
};

const ReadMcpResource: Tool = {
  name: "ReadMcpResource",
  description: "Read a specific resource from an MCP server",
  inputSchema: {
    type: "object",
    properties: {
      server: { type: "string" },
      uri: { type: "string", description: "Resource URI to read" },
    },
    required: ["server", "uri"],
  },
  async execute({ server, uri }, context) {
    const connection = context.mcpConnections.find(
      c => c.serverName === server
    );
    if (!connection) {
      return { error: `MCP server '${server}' not found` };
    }

    const resource = await connection.readResource(uri);
    return { content: resource.contents };
  },
};
```

## MCP Auth Error Handling

Some MCP servers require authentication. When auth fails, the server returns a specific error state:

```typescript
type McpConnectionState =
  | { status: "connected" }
  | { status: "connecting" }
  | { status: "needs-auth"; authUrl: string; message: string }
  | { status: "error"; error: string }
  | { status: "disconnected" };

async function connectMcpServer(
  config: McpServerConfig,
): Promise<McpConnection> {
  const connection = new McpConnection(config);

  try {
    await connection.initialize();
    return connection;
  } catch (error) {
    if (isAuthError(error)) {
      connection.state = {
        status: "needs-auth",
        authUrl: error.authUrl,
        message: `Server '${config.name}' requires authentication. ` +
                 `Visit: ${error.authUrl}`,
      };
    } else {
      connection.state = {
        status: "error",
        error: String(error),
      };
    }
    return connection;
  }
}
```

The UI can display auth prompts and retry after the user authenticates:

```typescript
function McpAuthPrompt({ connection }: { connection: McpConnection }) {
  if (connection.state.status !== "needs-auth") return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow">
      <Text color="yellow">⚠ MCP Authentication Required</Text>
      <Text>{connection.state.message}</Text>
      <Text dimColor>Press Enter after authenticating to retry...</Text>
    </Box>
  );
}
```

## Delta MCP: Incremental Tool Updates

During a session, MCP servers can add or remove tools without restarting. This is called "delta MCP":

```typescript
class McpConnection {
  private tools: Map<string, McpTool> = new Map();

  async handleToolsChanged(): Promise<ToolDelta> {
    const currentTools = await this.listTools();
    const currentNames = new Set(currentTools.map(t => t.name));
    const previousNames = new Set(this.tools.keys());

    const added = currentTools.filter(t => !previousNames.has(t.name));
    const removed = [...previousNames].filter(n => !currentNames.has(n));

    // Update local cache
    this.tools.clear();
    for (const tool of currentTools) {
      this.tools.set(tool.name, tool);
    }

    return { added, removed };
  }
}

// In the agent loop, handle tool changes mid-conversation
async function handleMcpToolDelta(
  delta: ToolDelta,
  toolPool: ToolPool,
): Promise<ToolPool> {
  // Add new tools
  for (const tool of delta.added) {
    const wrappedTool = wrapMcpTool(tool);
    toolPool.tools.push(wrappedTool);
    toolPool.byName.set(wrappedTool.name, wrappedTool);
  }

  // Remove old tools
  for (const name of delta.removed) {
    const fullName = `mcp__${tool.serverName}__${name}`;
    toolPool.tools = toolPool.tools.filter(t => t.name !== fullName);
    toolPool.byName.delete(fullName);
  }

  return toolPool;
}
```

## Claude Code's MCP Server

Claude Code itself can run as an MCP server, exposing its tools to other agents:

```typescript
// mcp-server/index.ts

import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";

export async function runMcpServer(): Promise<void> {
  const server = new Server({
    name: "claude-code",
    version: VERSION,
  }, {
    capabilities: {
      tools: {},
      resources: {},
    },
  });

  // Expose Claude Code's built-in tools as MCP tools
  server.setRequestHandler("tools/list", async () => {
    const tools = getBuiltInTools();
    return {
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  server.setRequestHandler("tools/call", async (request) => {
    const tool = getBuiltInTools().find(t => t.name === request.params.name);
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);

    const result = await tool.execute(request.params.arguments);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

This means you can use Claude Code's file editing, bash execution, and search tools from any MCP client.

## How MCP Makes the Agent Extensible

The power of MCP is that it makes the agent extensible without changing core code:

```
Without MCP:
  Want new tools? → Fork the agent → Add tools → Maintain fork

With MCP:
  Want new tools? → Write an MCP server → Configure in settings → Done
```

MCP servers are:
- **Language-agnostic**: Write in Python, Go, Rust, JavaScript — anything
- **Transport-agnostic**: stdio, HTTP, WebSocket
- **Composable**: Connect multiple servers simultaneously
- **Shareable**: The same server works with any MCP client

## Key Takeaways

1. **MCP standardizes tool integration** — one protocol, any tool
2. **`assembleToolPool`** merges built-in and MCP tools into a unified pool
3. **Namespacing** (`mcp__server__tool`) prevents tool name collisions
4. **Server instructions** are injected into the system prompt automatically
5. **Resources** give the agent access to external data (schemas, docs, APIs)
6. **Auth handling** has a dedicated `needs-auth` state with retry flow
7. **Delta MCP** allows tools to change mid-session without restart
8. **Claude Code itself is an MCP server** — its tools are reusable by other agents

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — MCP Architecture Concepts
**Question:** Explain the difference between MCP tools, resources, and prompts. Why are MCP tools namespaced as `mcp__serverName__toolName`? What problem would occur without namespacing if two MCP servers both exposed a tool called `query`?

[View Answer](../../answers/12-architecture-and-advanced/answer-103.md#exercise-1)

### Exercise 2 — Build an MCP Tool Pool Assembler
**Challenge:** Implement an `assembleToolPool` function that merges built-in tools and MCP tools into a unified pool. Each MCP tool must be namespaced with the pattern `mcp__<serverName>__<toolName>`. Built-in tools take priority on name conflicts. The function should return a `ToolPool` with both an array of all tools and a `Map` for O(1) lookup by name. Include proper TypeScript types for `Tool`, `McpConnection`, and `ToolPool`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-103.md#exercise-2)

### Exercise 3 — MCP Connection State Machine
**Challenge:** Implement an `McpConnection` class with a full state machine: `connecting` → `connected`, `connecting` → `needs-auth`, `connecting` → `error`, and `connected` → `disconnected`. The class should: attempt connection with a timeout, handle auth errors by transitioning to `needs-auth` state with an auth URL, support retry after authentication, expose `listTools()` and `callTool()` methods that throw if not connected, and emit state change events. Use a discriminated union for the connection state.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-103.md#exercise-3)

### Exercise 4 — Build an MCP Server
**Challenge:** Implement a simple MCP server that exposes two tools: `get_weather` (accepts a city name, returns mock weather data) and `search_docs` (accepts a query string, returns mock documentation results). Use the `@modelcontextprotocol/sdk` server pattern with stdio transport. Include proper tool schemas with descriptions, input validation, and error handling for missing parameters.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-103.md#exercise-4)

### Exercise 5 — Delta MCP Tool Updates
**Challenge:** Implement the delta MCP pattern: a `handleToolsChanged` method on an `McpConnection` class that detects added and removed tools when a server's tool list changes mid-session. Then implement `applyToolDelta` that updates a `ToolPool` in place. Include tests with scenarios: (1) server adds a new tool, (2) server removes a tool, (3) server adds and removes simultaneously, (4) server returns the same tools (no change).

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-103.md#exercise-5)
