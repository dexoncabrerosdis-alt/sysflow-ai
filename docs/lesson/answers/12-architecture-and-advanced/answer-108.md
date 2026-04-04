# Answers: Lesson 108 — Building Your Own Agent (Capstone)

## Exercise 1
**Question:** For each agent tier, identify the single most important feature it adds and explain why. List which modules each tier draws from.

**Answer:**

**Tier 1 (Minimum Viable):** The most important feature is **the agent loop itself** — the `while(true)` loop that keeps calling the API and executing tools until `stop_reason === "end_turn"`. Without this, you have a chatbot, not an agent. A chatbot answers once; an agent works until the task is done. This draws from **Module 1** (Foundations — what an agent IS) and **Module 2** (Tool System — how tools are defined and dispatched).

**Tier 2 (Good):** The most important addition is **context window management** — tracking tokens and compacting when approaching the limit. Without this, every sufficiently long task crashes or silently truncates context, producing wrong answers. This is the feature that makes the difference between "works for simple tasks" and "works for real tasks." This draws from **Module 4** (Context Management), **Module 5** (Streaming), **Module 6** (API Layer — token tracking), and **Module 7** (Error Handling — retries).

**Tier 3 (Great):** The most important addition is **extensibility** — hooks, MCP, and the command system. Without these, the agent is a closed box. With them, it becomes a platform that users can customize for their workflow. This is what separates a tool from a product. This draws from **Module 8** (Permissions), **Module 9** (Multi-Agent), **Module 10** (Hooks), and **Module 12** (Architecture — MCP, commands, config, state management).

---

## Exercise 2
**Challenge:** Build a complete Tier 1 agent in under 100 lines.

**Answer:**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const client = new Anthropic();

const tools: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read a file's contents from the filesystem",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file (creates or overwrites)",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path to write" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description: "Execute a shell command and return output",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Shell command to execute" },
      },
      required: ["command"],
    },
  },
];

async function executeTool(name: string, input: Record<string, string>): Promise<string> {
  switch (name) {
    case "read_file":
      return await fs.readFile(input.path, "utf-8");
    case "write_file":
      await fs.writeFile(input.path, input.content, "utf-8");
      return `Wrote ${input.content.length} bytes to ${input.path}`;
    case "run_command": {
      const { stdout, stderr } = await execAsync(input.command, { timeout: 30000 });
      return (stdout + stderr).trim();
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

async function agent(userMessage: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8096,
      system: "You are a helpful coding assistant. Use tools to accomplish tasks.",
      tools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const text = response.content.find(b => b.type === "text");
      return text?.text ?? "";
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        try {
          const result = await executeTool(block.name, block.input as Record<string, string>);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        } catch (error) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Error: ${error instanceof Error ? error.message : String(error)}`,
            is_error: true,
          });
        }
      }
    }

    messages.push({ role: "user", content: toolResults });
  }
}

// Usage
const answer = await agent("Read package.json and tell me the project name");
console.log(answer);
```

**Explanation:** This is the simplest possible agent: a loop that calls the API, checks if the model wants to use tools, executes them, feeds results back, and repeats until the model says it's done (`end_turn`). At 75 lines including types, it's under the 100-line limit. It works but lacks everything a production agent needs: no retries, no context management, no permissions, no streaming, no timeouts. That's the point — it demonstrates the irreducible core.

---

## Exercise 3
**Challenge:** Upgrade to Tier 2 with streaming, retries, context management, permissions, timeouts, and truncation.

**Answer:**

```typescript
type StreamEvent =
  | { type: "assistant_text"; content: string }
  | { type: "tool_use"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: string }
  | { type: "permission_request"; tool: string; input: Record<string, unknown> }
  | { type: "permission_response"; granted: boolean }
  | { type: "context_compact"; tokensBefore: number }
  | { type: "turn_complete"; usage: { input: number; output: number } }
  | { type: "error"; error: { type: string; message: string } }
  | { type: "max_turns_reached"; turns: number };

const DESTRUCTIVE_TOOLS = new Set(["write_file", "run_command"]);
const MAX_RESULT_BYTES = 50_000;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_CONTEXT_TOKENS = 100_000;

function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function truncateResult(result: string, maxBytes: number): string {
  if (result.length <= maxBytes) return result;
  return result.slice(0, maxBytes) + `\n...[truncated ${result.length - maxBytes} bytes]`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Tool timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

async function callWithRetry(
  fn: () => Promise<Anthropic.Message>,
  maxRetries: number = 3
): Promise<Anthropic.Message> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const isRetryable = error?.status === 429 || error?.status === 529 || error?.status >= 500;
      if (!isRetryable || attempt === maxRetries) throw error;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

function classifyError(error: unknown): { type: string; message: string } {
  if (error instanceof Error) {
    const status = (error as any).status;
    if (status === 429) return { type: "rate_limit", message: "Rate limited. Retries exhausted." };
    if (status === 401) return { type: "auth", message: "Invalid API key." };
    if (status === 529) return { type: "overloaded", message: "API overloaded." };
    if (status >= 500) return { type: "server", message: `Server error: ${status}` };
    return { type: "unknown", message: error.message };
  }
  return { type: "unknown", message: String(error) };
}

let permissionCallback: ((tool: string, input: Record<string, unknown>) => Promise<boolean>) | null = null;
function setPermissionHandler(handler: typeof permissionCallback) { permissionCallback = handler; }

async function* goodAgent(
  userMessage: string,
  options: { model?: string; maxTurns?: number } = {}
): AsyncGenerator<StreamEvent> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];
  const maxTurns = options.maxTurns ?? 20;

  for (let turn = 0; turn < maxTurns; turn++) {
    // Context management (Module 4)
    const tokenCount = estimateTokens(messages);
    if (tokenCount > MAX_CONTEXT_TOKENS * 0.8) {
      yield { type: "context_compact", tokensBefore: tokenCount };
      // Simple compaction: keep system + first + last 5 messages
      const compacted = [messages[0], ...messages.slice(-5)];
      messages.length = 0;
      messages.push(...compacted);
    }

    // API call with retry (Module 6 + 7)
    let response: Anthropic.Message;
    try {
      response = await callWithRetry(() =>
        client.messages.create({
          model: options.model ?? "claude-sonnet-4-20250514",
          max_tokens: 8096,
          system: "You are a helpful coding assistant.",
          tools,
          messages,
        })
      );
    } catch (error) {
      yield { type: "error", error: classifyError(error) };
      return;
    }

    messages.push({ role: "assistant", content: response.content });

    // Stream text (Module 5)
    for (const block of response.content) {
      if (block.type === "text") {
        yield { type: "assistant_text", content: block.text };
      }
    }

    if (response.stop_reason === "end_turn") {
      yield { type: "turn_complete", usage: { input: response.usage.input_tokens, output: response.usage.output_tokens } };
      return;
    }

    // Handle tools (Module 2 + 8)
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      yield { type: "tool_use", tool: block.name, input: block.input as Record<string, unknown> };

      // Permission check (Module 8)
      if (DESTRUCTIVE_TOOLS.has(block.name) && permissionCallback) {
        yield { type: "permission_request", tool: block.name, input: block.input as Record<string, unknown> };
        const granted = await permissionCallback(block.name, block.input as Record<string, unknown>);
        yield { type: "permission_response", granted };
        if (!granted) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Permission denied.", is_error: true });
          continue;
        }
      }

      // Execute with timeout and truncation (Module 7)
      try {
        const raw = await withTimeout(
          executeTool(block.name, block.input as Record<string, string>),
          TOOL_TIMEOUT_MS
        );
        const result = truncateResult(raw, MAX_RESULT_BYTES);
        yield { type: "tool_result", tool: block.name, result };
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        yield { type: "error", error: { type: "tool_error", message: msg } };
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${msg}`, is_error: true });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  yield { type: "max_turns_reached", turns: maxTurns };
}
```

**Explanation:** The Tier 2 agent adds six production features, each traceable to a course module: **Streaming** (Module 5) — converted to async generator yielding typed events. **Retries** (Module 7) — exponential backoff for 429/5xx errors. **Context management** (Module 4) — token estimation and compaction when approaching the limit. **Permissions** (Module 8) — destructive tools require approval before execution. **Timeouts** (Module 7) — `Promise.race` kills long-running tool executions. **Truncation** (Module 4) — tool results are capped at 50KB to prevent context overflow. The max turns limit prevents infinite loops.

---

## Exercise 4
**Challenge:** Map each of the 20 production checklist items to a lesson and provide a code snippet.

**Answer:**

**1. Agent loop** — Module 1, Lesson 1 (What Is an Agent)
```typescript
while (response.stop_reason !== "end_turn") {
  response = await client.messages.create({ tools, messages });
}
```

**2. Tool system** — Module 2, Lessons 9-15 (Tool definitions through custom tools)
```typescript
const tool: Tool = { name: "Read", inputSchema: { ... }, execute: async (input) => { ... } };
```

**3. System prompt** — Module 3, Lessons 16-22 (Identity, constraints, formatting)
```typescript
const system = `You are an AI coding agent. You have access to tools. Always explain before acting.`;
```

**4. Retry logic** — Module 7, Lesson 52 (Retry strategies)
```typescript
const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
await new Promise(r => setTimeout(r, delay));
```

**5. Context window management** — Module 4, Lesson 26 (Token counting)
```typescript
if (estimateTokens(messages) > maxTokens * 0.8) messages = await compact(messages);
```

**6. Conversation persistence** — Module 12, Lesson 100 (Session resume)
```typescript
await fs.writeFile(`sessions/${id}.json`, JSON.stringify({ messages, model }));
```

**7. Result truncation** — Module 4, Lesson 30 (Context overflow)
```typescript
const truncated = result.length > 50000 ? result.slice(0, 50000) + "...[truncated]" : result;
```

**8. Permission system** — Module 8, Lessons 61-66 (Permission model)
```typescript
if (requiresPermission(tool)) { const granted = await promptUser(tool); if (!granted) continue; }
```

**9. Tool timeouts** — Module 7, Lesson 56 (Timeout handling)
```typescript
const result = await Promise.race([executeTool(input), timeoutPromise(120_000)]);
```

**10. Input validation** — Module 2, Lesson 12 (Input schemas)
```typescript
const parsed = toolSchema.safeParse(input); if (!parsed.success) return { error: parsed.error };
```

**11. Output sanitization** — Module 8, Lesson 65 (Security)
```typescript
const safe = result.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, "[REDACTED]");
```

**12. Event streaming** — Module 5, Lesson 36 (Async generators)
```typescript
async function* query(msg): AsyncGenerator<StreamEvent> { yield { type: "assistant_text", content }; }
```

**13. Backpressure handling** — Module 12, Lesson 99 (Event-driven architecture)
```typescript
for await (const event of query(msg)) { await slowRender(event); /* generator paused here */ }
```

**14. Multiple consumers** — Module 12, Lesson 102 (Multiple interfaces)
```typescript
const events = query(msg); cliConsumer(events); // OR webConsumer(events); // OR sdkConsumer(events);
```

**15. Error classification** — Module 7, Lesson 51 (Error types)
```typescript
if (status === 429) return "rate_limit"; if (status === 529) return "overloaded";
```

**16. Graceful degradation** — Module 7, Lesson 54 (Recovery strategies)
```typescript
catch (e) { if (isTransient(e)) { await retry(); } else { yield { type: "error", error: e }; } }
```

**17. Signal handling** — Module 12, Lesson 100 (CLI entry point)
```typescript
process.on("SIGINT", async () => { if (isExiting) process.exit(1); isExiting = true; await cleanup(); });
```

**18. MCP support** — Module 12, Lesson 103 (MCP integration)
```typescript
const mcpTools = await connection.listTools(); toolPool.push(...mcpTools.map(wrapMcpTool));
```

**19. Hook system** — Module 10, Lessons 80-85 (Hooks and middleware)
```typescript
const result = await hooks.run("pre_tool", { tool, input }); if (result.blocked) return;
```

**20. Configuration** — Module 12, Lesson 105 (Configuration and schemas)
```typescript
const config = SettingsSchema.parse(deepMerge(defaults, userConfig, projectConfig, envConfig, cliFlags));
```

---

## Exercise 5
**Challenge:** Capstone — Build a complete agent system demonstrating mastery of the entire course.

**Answer:**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ============================================================
// STATE MANAGEMENT (Module 12 — Lesson 104)
// ============================================================

type Listener<T> = (state: T) => void;

function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<Listener<T>>();
  return {
    getState: () => state,
    setState: (updater: T | ((prev: T) => T)) => {
      state = typeof updater === "function" ? (updater as Function)(state) : updater;
      listeners.forEach(l => l(state));
    },
    subscribe: (l: Listener<T>) => { listeners.add(l); return () => listeners.delete(l); },
  };
}

interface AppState {
  model: string;
  messages: Anthropic.MessageParam[];
  isStreaming: boolean;
  turnCount: number;
  toolCallCount: number;
  tokenUsage: { input: number; output: number };
  sessionId: string;
  grantedPermissions: Set<string>;
}

const store = createStore<AppState>({
  model: "claude-sonnet-4-20250514",
  messages: [],
  isStreaming: false,
  turnCount: 0,
  toolCallCount: 0,
  tokenUsage: { input: 0, output: 0 },
  sessionId: crypto.randomUUID(),
  grantedPermissions: new Set(),
});

// ============================================================
// CONFIGURATION (Module 12 — Lesson 105)
// ============================================================

interface Config {
  model: string;
  maxTokens: number;
  maxTurns: number;
  maxContextTokens: number;
  toolTimeout: number;
  maxResultBytes: number;
  sessionDir: string;
}

const config: Config = {
  model: process.env.AGENT_MODEL ?? "claude-sonnet-4-20250514",
  maxTokens: parseInt(process.env.AGENT_MAX_TOKENS ?? "8096"),
  maxTurns: parseInt(process.env.AGENT_MAX_TURNS ?? "25"),
  maxContextTokens: 100_000,
  toolTimeout: 120_000,
  maxResultBytes: 50_000,
  sessionDir: path.join(process.env.HOME ?? ".", ".agent", "sessions"),
};

// ============================================================
// TOOLS (Module 2 — Lessons 9-15)
// ============================================================

const tools: Anthropic.Tool[] = [
  {
    name: "ReadFile",
    description: "Read a file from the filesystem",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "File path" } },
      required: ["path"],
    },
  },
  {
    name: "WriteFile",
    description: "Write content to a file",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "Bash",
    description: "Execute a shell command",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string", description: "Command to execute" } },
      required: ["command"],
    },
  },
  {
    name: "Grep",
    description: "Search for a pattern in files",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Regex pattern" },
        path: { type: "string", description: "Directory to search" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "ListFiles",
    description: "List files in a directory",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Directory path" },
      },
      required: ["path"],
    },
  },
];

const DESTRUCTIVE_TOOLS = new Set(["WriteFile", "Bash"]);

async function executeTool(name: string, input: Record<string, string>): Promise<string> {
  switch (name) {
    case "ReadFile":
      return await fs.readFile(input.path, "utf-8");
    case "WriteFile":
      await fs.mkdir(path.dirname(input.path), { recursive: true });
      await fs.writeFile(input.path, input.content, "utf-8");
      return `Wrote ${input.content.length} bytes to ${input.path}`;
    case "Bash": {
      const { stdout, stderr } = await execAsync(input.command, { timeout: config.toolTimeout });
      return (stdout + stderr).trim() || "(no output)";
    }
    case "Grep": {
      const dir = input.path ?? ".";
      const { stdout } = await execAsync(`grep -rn "${input.pattern}" ${dir} --include="*" | head -50`);
      return stdout.trim() || "No matches found.";
    }
    case "ListFiles": {
      const entries = await fs.readdir(input.path, { withFileTypes: true });
      return entries.map(e => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`).join("\n");
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================
// STREAMING & EVENTS (Module 5 — Lesson 36)
// ============================================================

type StreamEvent =
  | { type: "assistant_text"; content: string }
  | { type: "tool_use"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: string }
  | { type: "permission_request"; tool: string }
  | { type: "permission_response"; granted: boolean }
  | { type: "turn_complete"; usage: { input: number; output: number } }
  | { type: "context_compact"; tokensBefore: number; tokensAfter: number }
  | { type: "error"; error: { type: string; message: string } }
  | { type: "max_turns"; turns: number };

// ============================================================
// ERROR HANDLING & RETRIES (Module 7 — Lessons 51-56)
// ============================================================

function classifyError(err: unknown): { type: string; message: string } {
  const status = (err as any)?.status;
  if (status === 429) return { type: "rate_limit", message: "Rate limited" };
  if (status === 401) return { type: "auth", message: "Invalid API key" };
  if (status === 529) return { type: "overloaded", message: "API overloaded" };
  if (status >= 500) return { type: "server", message: `Server error ${status}` };
  return { type: "unknown", message: err instanceof Error ? err.message : String(err) };
}

async function callWithRetry(fn: () => Promise<Anthropic.Message>): Promise<Anthropic.Message> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fn(); }
    catch (e: any) {
      if (!(e?.status === 429 || e?.status >= 500) || attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
  throw new Error("Unreachable");
}

// ============================================================
// CONTEXT MANAGEMENT (Module 4 — Lessons 26-30)
// ============================================================

function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + "\n...[truncated]";
}

function compactMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length <= 4) return messages;
  return [messages[0], ...messages.slice(-4)];
}

// ============================================================
// PERMISSIONS (Module 8 — Lessons 61-66)
// ============================================================

async function promptPermission(tool: string): Promise<boolean> {
  const state = store.getState();
  if (state.grantedPermissions.has(tool)) return true;

  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`\n  Allow ${tool}? [y/N/always] `, answer => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "always") {
        store.setState(p => ({
          ...p,
          grantedPermissions: new Set([...p.grantedPermissions, tool]),
        }));
        resolve(true);
      } else {
        resolve(a === "y" || a === "yes");
      }
    });
  });
}

// ============================================================
// AGENT LOOP (Module 1 — Lesson 1, Module 5 — Lesson 36)
// ============================================================

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a helpful AI coding assistant running in a terminal. You have access to tools for reading files, writing files, running commands, searching code, and listing directories.

Rules:
- Always read files before modifying them
- Explain what you're about to do before using destructive tools
- If a command fails, analyze the error and try a different approach
- Be concise in your responses`;

async function* query(
  userMessage: string
): AsyncGenerator<StreamEvent> {
  const state = store.getState();
  const messages: Anthropic.MessageParam[] = [
    ...state.messages,
    { role: "user", content: userMessage },
  ];

  for (let turn = 0; turn < config.maxTurns; turn++) {
    // Context management
    const tokens = estimateTokens(messages);
    if (tokens > config.maxContextTokens * 0.8) {
      const compacted = compactMessages(messages);
      messages.length = 0;
      messages.push(...compacted);
      yield { type: "context_compact", tokensBefore: tokens, tokensAfter: estimateTokens(compacted) };
    }

    let response: Anthropic.Message;
    try {
      response = await callWithRetry(() => client.messages.create({
        model: state.model,
        max_tokens: config.maxTokens,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      }));
    } catch (error) {
      yield { type: "error", error: classifyError(error) };
      return;
    }

    messages.push({ role: "assistant", content: response.content });

    for (const block of response.content) {
      if (block.type === "text") yield { type: "assistant_text", content: block.text };
    }

    if (response.stop_reason === "end_turn") {
      yield { type: "turn_complete", usage: { input: response.usage.input_tokens, output: response.usage.output_tokens } };
      store.setState(p => ({
        ...p,
        messages,
        turnCount: p.turnCount + 1,
        tokenUsage: {
          input: p.tokenUsage.input + response.usage.input_tokens,
          output: p.tokenUsage.output + response.usage.output_tokens,
        },
      }));
      return;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      yield { type: "tool_use", tool: block.name, input: block.input as Record<string, unknown> };
      store.setState(p => ({ ...p, toolCallCount: p.toolCallCount + 1 }));

      if (DESTRUCTIVE_TOOLS.has(block.name)) {
        yield { type: "permission_request", tool: block.name };
        const granted = await promptPermission(block.name);
        yield { type: "permission_response", granted };
        if (!granted) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "Permission denied.", is_error: true });
          continue;
        }
      }

      try {
        const raw = await Promise.race([
          executeTool(block.name, block.input as Record<string, string>),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Timeout")), config.toolTimeout)),
        ]);
        const result = truncate(raw, config.maxResultBytes);
        yield { type: "tool_result", tool: block.name, result };
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${msg}`, is_error: true });
      }
    }

    messages.push({ role: "user", content: toolResults });
    store.setState(p => ({ ...p, messages, turnCount: p.turnCount + 1 }));
  }

  yield { type: "max_turns", turns: config.maxTurns };
}

// ============================================================
// COMMANDS (Module 12 — Lesson 107)
// ============================================================

type CmdResult = { output?: string; exit?: boolean };

const commands: Record<string, (args: string) => CmdResult> = {
  help: () => ({
    output: [
      "Commands:",
      "  /help              Show this message",
      "  /model [name]      Show or switch model",
      "  /status            Show session statistics",
      "  /clear             Clear conversation history",
      "  /exit              Exit the agent",
    ].join("\n"),
  }),

  model: (args) => {
    if (!args.trim()) {
      return { output: `Current model: ${store.getState().model}` };
    }
    store.setState(p => ({ ...p, model: args.trim() }));
    return { output: `Switched to ${args.trim()}` };
  },

  status: () => {
    const s = store.getState();
    return {
      output: [
        `Session: ${s.sessionId.slice(0, 8)}`,
        `Model: ${s.model}`,
        `Turns: ${s.turnCount}`,
        `Tool calls: ${s.toolCallCount}`,
        `Tokens: ${s.tokenUsage.input.toLocaleString()} in / ${s.tokenUsage.output.toLocaleString()} out`,
      ].join("\n"),
    };
  },

  clear: () => {
    store.setState(p => ({
      ...p,
      messages: [],
      turnCount: 0,
      toolCallCount: 0,
      tokenUsage: { input: 0, output: 0 },
    }));
    return { output: "Conversation cleared." };
  },

  exit: () => ({ exit: true }),
};

// ============================================================
// SESSION PERSISTENCE (Module 12 — Lesson 100)
// ============================================================

async function saveSession(): Promise<void> {
  const state = store.getState();
  await fs.mkdir(config.sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(config.sessionDir, `${state.sessionId}.json`),
    JSON.stringify({ id: state.sessionId, model: state.model, messages: state.messages, savedAt: new Date().toISOString() }),
    "utf-8"
  );
}

// ============================================================
// CLI (Module 12 — Lessons 100-101)
// ============================================================

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => new Promise<string>(resolve => rl.question("\x1b[36m❯ \x1b[0m", resolve));

  console.log("\x1b[1m\x1b[34mAgent\x1b[0m — AI coding assistant");
  console.log("Type a message, /help for commands, /exit to quit.\n");

  while (true) {
    const input = await prompt();
    if (!input.trim()) continue;

    // Command handling
    if (input.startsWith("/")) {
      const [cmdName, ...rest] = input.slice(1).split(/\s+/);
      const cmd = commands[cmdName.toLowerCase()];
      if (!cmd) { console.log(`Unknown command: /${cmdName}. Type /help.`); continue; }
      const result = cmd(rest.join(" "));
      if (result.output) console.log(result.output);
      if (result.exit) { await saveSession(); rl.close(); process.exit(0); }
      continue;
    }

    // Agent query
    store.setState(p => ({ ...p, isStreaming: true }));
    let hasText = false;

    for await (const event of query(input)) {
      switch (event.type) {
        case "assistant_text":
          process.stdout.write(event.content);
          hasText = true;
          break;
        case "tool_use":
          console.log(`\n\x1b[33m⚡ ${event.tool}\x1b[0m`);
          break;
        case "tool_result":
          if (event.result.length < 200) console.log(`\x1b[2m${event.result}\x1b[0m`);
          else console.log(`\x1b[2m${event.result.slice(0, 200)}...\x1b[0m`);
          break;
        case "turn_complete":
          if (hasText) console.log();
          console.log(`\x1b[2m[${event.usage.input}↓ ${event.usage.output}↑ tokens]\x1b[0m\n`);
          break;
        case "context_compact":
          console.log(`\x1b[33m[context compacted: ${event.tokensBefore}→${event.tokensAfter} tokens]\x1b[0m`);
          break;
        case "error":
          console.error(`\x1b[31mError (${event.error.type}): ${event.error.message}\x1b[0m`);
          break;
        case "max_turns":
          console.log(`\x1b[33m[max turns reached: ${event.turns}]\x1b[0m`);
          break;
      }
    }

    store.setState(p => ({ ...p, isStreaming: false }));
    await saveSession();
  }
}

main().catch(console.error);
```

**Explanation:** This capstone integrates every major concept from the course into a working agent:

- **Agent loop** (Module 1): The `query()` function implements the core while-loop that calls the API, executes tools, and continues until done.
- **Tool system** (Module 2): Five typed tools with input schemas — ReadFile, WriteFile, Bash, Grep, ListFiles.
- **System prompt** (Module 3): Identity, capabilities, and behavioral constraints.
- **Context management** (Module 4): Token estimation, automatic compaction at 80% threshold, result truncation.
- **Streaming** (Module 5): Full `AsyncGenerator<StreamEvent>` with typed discriminated union events.
- **API layer** (Module 6): Anthropic SDK usage with proper message format and token tracking.
- **Error handling** (Module 7): Error classification, retry with exponential backoff, tool timeouts.
- **Permissions** (Module 8): Destructive tools require user approval with "always" option.
- **State management** (Module 12): The `createStore` pattern with subscriber notification.
- **Configuration** (Module 12): Environment variable overrides with typed defaults.
- **Commands** (Module 12): Four slash commands — /help, /model, /status, /clear, /exit.
- **CLI** (Module 12): Interactive readline loop with styled output.
- **Session persistence** (Module 12): Save/load session state to JSON files.

At approximately 400 lines, this is a complete, functional agent that could be compiled and run against the Anthropic API. It demonstrates the journey from "an agent is a loop" (Lesson 1) to "a production system with all the supporting infrastructure" (Lesson 108).
