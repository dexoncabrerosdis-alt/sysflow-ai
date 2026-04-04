# Answers: Lesson 103 — MCP Integration

## Exercise 1
**Question:** Explain the difference between MCP tools, resources, and prompts. Why are MCP tools namespaced as `mcp__serverName__toolName`? What problem would occur without namespacing if two MCP servers both exposed a tool called `query`?

**Answer:** MCP **tools** are executable actions the model can invoke (like calling a function — e.g., `query_db`, `deploy_app`). MCP **resources** are data the model can read (like files, database schemas, or API docs — referenced by URI). MCP **prompts** are reusable prompt templates the server provides to help the model use its tools effectively. Tools are namespaced as `mcp__serverName__toolName` to prevent collisions. Without namespacing, if a database server and a search server both exposed a tool called `query`, the agent would have two tools with the same name in its tool pool. The model couldn't distinguish between them, the tool dispatcher wouldn't know which server to route the call to, and the `Map<string, Tool>` lookup would overwrite one tool with the other. Namespacing ensures uniqueness: `mcp__database__query` and `mcp__search__query` are distinct tools with clear routing to their respective servers.

---

## Exercise 2
**Challenge:** Implement an `assembleToolPool` function that merges built-in and MCP tools with namespacing.

**Answer:**

```typescript
interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

interface Tool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
  source: "built-in" | "mcp";
  serverName?: string;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

interface McpConnection {
  serverName: string;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, input: Record<string, unknown>): Promise<unknown>;
}

interface ToolPool {
  tools: Tool[];
  byName: Map<string, Tool>;
}

async function assembleToolPool(
  builtInTools: Tool[],
  mcpConnections: McpConnection[]
): Promise<ToolPool> {
  const mcpTools: Tool[] = [];

  for (const connection of mcpConnections) {
    let serverTools: McpTool[];
    try {
      serverTools = await connection.listTools();
    } catch (error) {
      console.warn(
        `Failed to list tools from MCP server '${connection.serverName}': ${error}`
      );
      continue;
    }

    for (const tool of serverTools) {
      const namespacedName = `mcp__${connection.serverName}__${tool.name}`;

      mcpTools.push({
        name: namespacedName,
        description: `[${connection.serverName}] ${tool.description}`,
        inputSchema: tool.inputSchema,
        execute: async (input) => {
          return await connection.callTool(tool.name, input);
        },
        source: "mcp",
        serverName: connection.serverName,
      });
    }
  }

  // Built-in tools take priority — add them first to the Map
  const allTools = [...builtInTools, ...mcpTools];
  const byName = new Map<string, Tool>();

  for (const tool of builtInTools) {
    byName.set(tool.name, tool);
  }
  for (const tool of mcpTools) {
    if (!byName.has(tool.name)) {
      byName.set(tool.name, tool);
    }
  }

  return { tools: allTools, byName };
}
```

**Explanation:** The function iterates each MCP connection, lists its tools, and wraps each as a `Tool` with a namespaced name (`mcp__server__tool`). The `execute` closure captures the connection reference so tool calls are routed to the correct server. The `byName` Map is populated with built-in tools first, ensuring they take priority on any name collision. MCP tool descriptions are prefixed with the server name for clarity in the model's tool list. Errors from individual servers are caught and warned about without failing the entire assembly.

---

## Exercise 3
**Challenge:** Implement an `McpConnection` class with a full state machine.

**Answer:**

```typescript
type McpConnectionState =
  | { status: "connecting" }
  | { status: "connected" }
  | { status: "needs-auth"; authUrl: string; message: string }
  | { status: "error"; error: string }
  | { status: "disconnected" };

type StateChangeListener = (state: McpConnectionState) => void;

interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

class McpConnection {
  public state: McpConnectionState = { status: "disconnected" };
  public readonly serverName: string;
  private config: McpServerConfig;
  private transport: StdioTransport | null = null;
  private listeners = new Set<StateChangeListener>();

  constructor(config: McpServerConfig) {
    this.config = config;
    this.serverName = config.name;
  }

  onStateChange(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(newState: McpConnectionState): void {
    this.state = newState;
    this.listeners.forEach(fn => fn(newState));
  }

  async connect(timeoutMs: number = 10000): Promise<void> {
    this.setState({ status: "connecting" });

    try {
      const connectPromise = this.initializeTransport();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out")), timeoutMs)
      );

      await Promise.race([connectPromise, timeoutPromise]);
      this.setState({ status: "connected" });
    } catch (error) {
      if (isAuthError(error)) {
        this.setState({
          status: "needs-auth",
          authUrl: (error as AuthError).authUrl,
          message: `Server '${this.serverName}' requires authentication.`,
        });
      } else {
        this.setState({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async retryAfterAuth(): Promise<void> {
    if (this.state.status !== "needs-auth") {
      throw new Error("Can only retry from needs-auth state");
    }
    await this.connect();
  }

  async listTools(): Promise<McpTool[]> {
    this.assertConnected();
    return await this.transport!.request("tools/list", {});
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    this.assertConnected();
    return await this.transport!.request("tools/call", {
      name,
      arguments: input,
    });
  }

  disconnect(): void {
    this.transport?.close();
    this.transport = null;
    this.setState({ status: "disconnected" });
  }

  private assertConnected(): void {
    if (this.state.status !== "connected") {
      throw new Error(
        `MCP server '${this.serverName}' is not connected (status: ${this.state.status})`
      );
    }
  }

  private async initializeTransport(): Promise<void> {
    // Spawn the server process and establish JSON-RPC communication
    this.transport = new StdioTransport(this.config);
    await this.transport.initialize();
  }
}
```

**Explanation:** The connection state is a discriminated union with five variants. State transitions follow a strict pattern: `disconnected` → `connecting` → `connected`/`needs-auth`/`error`. The `connect` method uses `Promise.race` to implement a timeout. Auth errors transition to `needs-auth` with the auth URL, allowing the UI to display a prompt and call `retryAfterAuth()` after the user authenticates. `listTools()` and `callTool()` assert the connection is active before making requests. State change listeners enable reactive UI updates when the connection status changes.

---

## Exercise 4
**Challenge:** Build a simple MCP server with two tools.

**Answer:**

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "example-tools", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_weather",
      description: "Get current weather for a city",
      inputSchema: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "City name (e.g., 'San Francisco')",
          },
        },
        required: ["city"],
      },
    },
    {
      name: "search_docs",
      description: "Search documentation for a query",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query string",
          },
          limit: {
            type: "number",
            description: "Max results to return (default: 5)",
          },
        },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "get_weather": {
      if (!args?.city || typeof args.city !== "string") {
        return {
          content: [{ type: "text", text: "Error: 'city' parameter is required" }],
          isError: true,
        };
      }
      const weather = {
        city: args.city,
        temperature: Math.round(15 + Math.random() * 20),
        conditions: ["sunny", "cloudy", "rainy", "windy"][
          Math.floor(Math.random() * 4)
        ],
        humidity: Math.round(30 + Math.random() * 50),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(weather, null, 2) }],
      };
    }

    case "search_docs": {
      if (!args?.query || typeof args.query !== "string") {
        return {
          content: [{ type: "text", text: "Error: 'query' parameter is required" }],
          isError: true,
        };
      }
      const limit = typeof args.limit === "number" ? args.limit : 5;
      const results = Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
        title: `Documentation: ${args.query} (result ${i + 1})`,
        url: `https://docs.example.com/${args.query.replace(/\s+/g, "-")}/${i + 1}`,
        snippet: `This section covers ${args.query} in detail...`,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running on stdio");
}

main().catch(console.error);
```

**Explanation:** The server uses the official MCP SDK with stdio transport (communicating via stdin/stdout JSON-RPC). `ListToolsRequestSchema` handler returns tool definitions with JSON Schema input descriptions. `CallToolRequestSchema` handler dispatches by tool name, validates required parameters, and returns results in MCP's content format. Error cases return `isError: true` so the client knows the call failed. The server logs to stderr (not stdout) since stdout is the JSON-RPC transport channel. This server can be configured in Claude Code's config as `{ "command": "node", "args": ["server.js"] }`.

---

## Exercise 5
**Challenge:** Implement the delta MCP pattern for detecting added and removed tools.

**Answer:**

```typescript
interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolDelta {
  added: McpTool[];
  removed: string[];
  unchanged: number;
}

class McpConnectionWithDelta {
  private knownTools: Map<string, McpTool> = new Map();
  readonly serverName: string;

  constructor(serverName: string) {
    this.serverName = serverName;
  }

  async handleToolsChanged(
    fetchCurrentTools: () => Promise<McpTool[]>
  ): Promise<ToolDelta> {
    const currentTools = await fetchCurrentTools();
    const currentByName = new Map(currentTools.map(t => [t.name, t]));

    const added = currentTools.filter(t => !this.knownTools.has(t.name));
    const removed = [...this.knownTools.keys()].filter(
      name => !currentByName.has(name)
    );
    const unchanged = currentTools.length - added.length;

    // Update known tools
    this.knownTools = currentByName;

    return { added, removed, unchanged };
  }
}

function applyToolDelta(
  toolPool: ToolPool,
  delta: ToolDelta,
  serverName: string
): void {
  // Remove old tools
  for (const removedName of delta.removed) {
    const fullName = `mcp__${serverName}__${removedName}`;
    toolPool.tools = toolPool.tools.filter(t => t.name !== fullName);
    toolPool.byName.delete(fullName);
  }

  // Add new tools
  for (const addedTool of delta.added) {
    const fullName = `mcp__${serverName}__${addedTool.name}`;
    const tool: Tool = {
      name: fullName,
      description: `[${serverName}] ${addedTool.description}`,
      inputSchema: addedTool.inputSchema as ToolInputSchema,
      execute: async (input) => {
        // Route to the MCP server
        return await callMcpTool(serverName, addedTool.name, input);
      },
      source: "mcp",
      serverName,
    };
    toolPool.tools.push(tool);
    toolPool.byName.set(fullName, tool);
  }
}

// Test scenarios
async function testDelta() {
  const conn = new McpConnectionWithDelta("database");

  // Initial: 2 tools
  const delta1 = await conn.handleToolsChanged(async () => [
    { name: "query", description: "Run SQL", inputSchema: {} },
    { name: "schema", description: "Get schema", inputSchema: {} },
  ]);
  console.assert(delta1.added.length === 2, "Initial: 2 added");
  console.assert(delta1.removed.length === 0, "Initial: 0 removed");

  // Scenario 1: Server adds a tool
  const delta2 = await conn.handleToolsChanged(async () => [
    { name: "query", description: "Run SQL", inputSchema: {} },
    { name: "schema", description: "Get schema", inputSchema: {} },
    { name: "migrate", description: "Run migration", inputSchema: {} },
  ]);
  console.assert(delta2.added.length === 1, "S1: 1 added");
  console.assert(delta2.added[0].name === "migrate", "S1: migrate added");

  // Scenario 2: Server removes a tool
  const delta3 = await conn.handleToolsChanged(async () => [
    { name: "query", description: "Run SQL", inputSchema: {} },
    { name: "migrate", description: "Run migration", inputSchema: {} },
  ]);
  console.assert(delta3.removed.length === 1, "S2: 1 removed");
  console.assert(delta3.removed[0] === "schema", "S2: schema removed");

  // Scenario 3: Add and remove simultaneously
  const delta4 = await conn.handleToolsChanged(async () => [
    { name: "query", description: "Run SQL", inputSchema: {} },
    { name: "backup", description: "Backup DB", inputSchema: {} },
  ]);
  console.assert(delta4.added.length === 1, "S3: 1 added");
  console.assert(delta4.removed.length === 1, "S3: 1 removed");

  // Scenario 4: No change
  const delta5 = await conn.handleToolsChanged(async () => [
    { name: "query", description: "Run SQL", inputSchema: {} },
    { name: "backup", description: "Backup DB", inputSchema: {} },
  ]);
  console.assert(delta5.added.length === 0, "S4: 0 added");
  console.assert(delta5.removed.length === 0, "S4: 0 removed");
  console.assert(delta5.unchanged === 2, "S4: 2 unchanged");

  console.log("All delta tests passed");
}
```

**Explanation:** The `handleToolsChanged` method compares the current tool list from the server against the previously known tools stored in a `Map`. Tools present in the new list but not the old are "added"; tools in the old list but not the new are "removed". The `applyToolDelta` function mutates the `ToolPool` in place — removing deleted tools from both the array and Map, then adding new tools with proper namespacing and execution wrappers. The test scenarios cover all four cases: pure addition, pure removal, simultaneous add/remove, and no change.
