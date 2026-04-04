# Lesson 108: Building Your Own Agent

## The Final Lesson

You've spent 107 lessons studying how a production AI coding agent works. You've seen the agent loop, the tool system, prompt engineering, context management, streaming, permissions, error handling, multi-agent orchestration, hooks, feature flags, and the event-driven architecture that ties it all together.

Now it's time to build one.

This lesson walks through three tiers of agent implementation — minimum viable, good, and great — and ends with a comprehensive checklist of everything a production agent needs.

## Tier 1: The Minimum Viable Agent

An agent is a loop. The simplest agent that actually works:

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const tools = [
  {
    name: "read_file",
    description: "Read a file from the filesystem",
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
    description: "Write content to a file",
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
    description: "Run a shell command",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Command to execute" },
      },
      required: ["command"],
    },
  },
];

async function executeTool(
  name: string,
  input: Record<string, string>,
): Promise<string> {
  switch (name) {
    case "read_file":
      return await fs.readFile(input.path, "utf-8");
    case "write_file":
      await fs.writeFile(input.path, input.content);
      return `Wrote ${input.content.length} bytes to ${input.path}`;
    case "run_command": {
      const { stdout, stderr } = await exec(input.command);
      return stdout + stderr;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

async function agent(userMessage: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  // The loop: keep going until the model stops calling tools
  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8096,
      tools,
      messages,
    });

    // Add assistant response to history
    messages.push({ role: "assistant", content: response.content });

    // If the model didn't use any tools, we're done
    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find(b => b.type === "text");
      return textBlock?.text ?? "";
    }

    // Execute each tool call and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const result = await executeTool(
          block.name,
          block.input as Record<string, string>,
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    // Add tool results to history and loop
    messages.push({ role: "user", content: toolResults });
  }
}

// Use it
const answer = await agent("Read package.json and tell me the version");
console.log(answer);
```

This is ~80 lines. It works. It can read files, write files, run commands, and loop until done. But it's fragile, unsafe, and limited.

## Tier 2: The Good Agent

Add the essential production features: retries, streaming, context management, and permissions.

```typescript
async function* goodAgent(
  userMessage: string,
  options: AgentOptions = {},
): AsyncGenerator<StreamEvent> {
  const messages: MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const maxTurns = options.maxTurns ?? 20;
  let turn = 0;

  while (turn < maxTurns) {
    turn++;

    // Context management: check if we need to compact
    const tokenCount = estimateTokens(messages);
    if (tokenCount > options.maxContextTokens * 0.8) {
      yield { type: "context_compact", tokensBefore: tokenCount };
      const compacted = await compactMessages(messages);
      messages.length = 0;
      messages.push(...compacted);
      yield {
        type: "context_compact_done",
        tokensAfter: estimateTokens(messages),
      };
    }

    // API call with retry logic
    let response: Anthropic.Message;
    try {
      response = await callWithRetry(
        () => client.messages.create({
          model: options.model ?? "claude-sonnet-4-20250514",
          max_tokens: 8096,
          system: buildSystemPrompt(options),
          tools: options.tools ?? defaultTools,
          messages,
          stream: false,
        }),
        { maxRetries: 3, backoff: "exponential" }
      );
    } catch (error) {
      yield { type: "error", error: classifyError(error) };
      return;
    }

    messages.push({ role: "assistant", content: response.content });

    // Stream text content
    for (const block of response.content) {
      if (block.type === "text") {
        yield { type: "assistant_text", content: block.text };
      }
    }

    if (response.stop_reason === "end_turn") {
      yield { type: "turn_complete", usage: response.usage };
      return;
    }

    // Handle tool calls with permissions
    const toolResults: ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      yield { type: "tool_use", tool: block.name, input: block.input };

      // Permission check
      if (requiresPermission(block.name, block.input)) {
        yield {
          type: "permission_request",
          tool: block.name,
          input: block.input,
        };

        const granted = await waitForPermission(block.name, block.input);
        yield { type: "permission_response", granted };

        if (!granted) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "Permission denied by user.",
            is_error: true,
          });
          continue;
        }
      }

      // Execute with timeout
      try {
        const result = await withTimeout(
          executeTool(block.name, block.input),
          options.toolTimeout ?? 120_000
        );
        yield { type: "tool_result", tool: block.name, result };
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: truncateResult(result, 50_000),
        });
      } catch (error) {
        yield { type: "tool_error", tool: block.name, error };
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: ${error.message}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  yield { type: "max_turns_reached", turns: maxTurns };
}
```

What we added:
- **Streaming events** via async generator
- **Retry logic** with exponential backoff
- **Context management** (compaction when approaching limits)
- **Permission checks** before dangerous tool executions
- **Tool timeouts** to prevent hung processes
- **Result truncation** to avoid context overflow
- **Max turns** to prevent infinite loops
- **Error classification** for meaningful error messages

## Tier 3: The Great Agent

Add the features that make an agent feel like a senior engineer: multi-agent, plan mode, hooks, and extensibility.

```typescript
class GreatAgent {
  private store: Store<AgentState>;
  private hooks: HookSystem;
  private toolPool: ToolPool;
  private mcpConnections: McpConnection[];

  constructor(options: GreatAgentOptions) {
    this.store = createStore(defaultAgentState);
    this.hooks = new HookSystem(options.hooks ?? []);
    this.toolPool = assembleToolPool(options.tools, options.mcpServers);
    this.mcpConnections = [];
  }

  async *query(
    userMessage: string,
    options?: QueryOptions
  ): AsyncGenerator<StreamEvent> {
    // Pre-query hooks
    const hookContext = { message: userMessage, state: this.store.getState() };
    const preResult = await this.hooks.run("pre_query", hookContext);
    if (preResult.blocked) {
      yield { type: "blocked", reason: preResult.reason };
      return;
    }

    // Plan mode: think before acting
    if (this.store.getState().mode === "plan") {
      yield* this.planThenExecute(userMessage, options);
      return;
    }

    // Normal mode: execute directly
    yield* this.executeQuery(userMessage, options);

    // Post-query hooks
    await this.hooks.run("post_query", {
      message: userMessage,
      state: this.store.getState(),
    });
  }

  private async *planThenExecute(
    userMessage: string,
    options?: QueryOptions
  ): AsyncGenerator<StreamEvent> {
    // Phase 1: Generate a plan (no tools allowed)
    yield { type: "plan_start" };
    const planEvents = this.executeQuery(
      `Create a detailed plan for: ${userMessage}\n` +
      `Do NOT execute anything yet. Just explain what you would do.`,
      { ...options, tools: [] }
    );

    let plan = "";
    for await (const event of planEvents) {
      if (event.type === "assistant_text") plan += event.content;
      yield event;
    }
    yield { type: "plan_complete", plan };

    // Phase 2: Ask for approval
    yield { type: "plan_approval_request", plan };
    const approved = await this.waitForApproval();

    if (!approved) {
      yield { type: "plan_rejected" };
      return;
    }

    // Phase 3: Execute the plan
    yield { type: "plan_execution_start" };
    yield* this.executeQuery(
      `Execute this plan:\n${plan}\n\nOriginal request: ${userMessage}`,
      options
    );
  }

  // Multi-agent: delegate subtasks to specialized agents
  private async *delegateToSubagent(
    task: string,
    type: "explorer" | "implementer" | "reviewer",
  ): AsyncGenerator<StreamEvent> {
    const subagent = new GreatAgent({
      ...this.getSubagentConfig(type),
      hooks: this.hooks,
    });

    yield { type: "subagent_start", task, agentType: type };

    for await (const event of subagent.query(task)) {
      yield { ...event, source: `subagent:${type}` };
    }

    yield { type: "subagent_complete", agentType: type };
  }

  private getSubagentConfig(type: string) {
    switch (type) {
      case "explorer":
        return {
          tools: [ReadTool, GrepTool, GlobTool],
          systemPrompt: "You are a code exploration specialist...",
        };
      case "implementer":
        return {
          tools: [ReadTool, WriteTool, BashTool],
          systemPrompt: "You are an implementation specialist...",
        };
      case "reviewer":
        return {
          tools: [ReadTool, GrepTool, BashTool],
          systemPrompt: "You are a code review specialist...",
        };
    }
  }
}
```

## Architecture Blueprint

Every component and how they connect:

```
┌─────────────────────────────────────────────────────────────┐
│                     INTERFACE LAYER                         │
│  ┌─────┐  ┌───────┐  ┌─────┐  ┌────┐                      │
│  │ CLI │  │Web UI │  │ SDK │  │ CI │                      │
│  └──┬──┘  └───┬───┘  └──┬──┘  └─┬──┘                      │
│     └─────────┼─────────┼───────┘                          │
│               ▼                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              EVENT STREAM (AsyncGenerator)            │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                         │                                  │
│  ┌──────────────────────▼───────────────────────────────┐  │
│  │                   CORE LAYER                          │  │
│  │                                                       │  │
│  │  ┌─────────────┐  ┌────────────┐  ┌───────────────┐  │  │
│  │  │ Query Loop  │  │  Prompt    │  │   Context     │  │  │
│  │  │ (agent loop)│  │  Builder   │  │   Manager     │  │  │
│  │  └──────┬──────┘  └────────────┘  └───────────────┘  │  │
│  │         │                                             │  │
│  │  ┌──────▼──────┐  ┌────────────┐  ┌───────────────┐  │  │
│  │  │   Tool      │  │  Permission│  │   Error       │  │  │
│  │  │   System    │  │  System    │  │   Handler     │  │  │
│  │  └──────┬──────┘  └────────────┘  └───────────────┘  │  │
│  │         │                                             │  │
│  │  ┌──────▼──────┐  ┌────────────┐  ┌───────────────┐  │  │
│  │  │   API       │  │  Retry     │  │   Feature     │  │  │
│  │  │   Client    │  │  Engine    │  │   Flags       │  │  │
│  │  └─────────────┘  └────────────┘  └───────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              EXTENSION LAYER                          │  │
│  │                                                       │  │
│  │  ┌─────────┐  ┌──────────┐  ┌───────────────────┐   │  │
│  │  │  MCP    │  │  Hooks   │  │  Commands/Plugins │   │  │
│  │  │ Servers │  │  System  │  │  System           │   │  │
│  │  └─────────┘  └──────────┘  └───────────────────┘   │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              INFRASTRUCTURE LAYER                     │  │
│  │                                                       │  │
│  │  ┌─────────┐  ┌──────────┐  ┌───────────┐           │  │
│  │  │  State  │  │  Config  │  │ Telemetry │           │  │
│  │  │  Store  │  │  System  │  │           │           │  │
│  │  └─────────┘  └──────────┘  └───────────┘           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## The Production Agent Checklist

Twenty things every production agent needs. Use this as your implementation guide:

### Core Loop
- [ ] **1. Agent loop** — while model requests tools, execute and continue
- [ ] **2. Tool system** — typed tools with input schemas and execute functions
- [ ] **3. System prompt** — identity, capabilities, constraints, formatting
- [ ] **4. Retry logic** — exponential backoff for transient API failures

### Context & Memory
- [ ] **5. Context window management** — track tokens, compact when near limit
- [ ] **6. Conversation persistence** — save/resume sessions across restarts
- [ ] **7. Result truncation** — large tool outputs must be truncated for context

### Safety & Permissions
- [ ] **8. Permission system** — gate destructive tools behind user approval
- [ ] **9. Tool timeouts** — kill tool executions that run too long
- [ ] **10. Input validation** — validate tool inputs before execution
- [ ] **11. Output sanitization** — prevent sensitive data from leaking

### Streaming & Events
- [ ] **12. Event streaming** — async generator yielding typed events
- [ ] **13. Backpressure handling** — producers pause when consumers are slow
- [ ] **14. Multiple consumers** — same event stream powers different interfaces

### Error Handling
- [ ] **15. Error classification** — distinguish overloaded, auth, rate limit, network
- [ ] **16. Graceful degradation** — continue on non-fatal errors, retry on transient ones
- [ ] **17. Signal handling** — SIGINT for graceful shutdown, double for force exit

### Extensibility
- [ ] **18. MCP support** — connect external tools via Model Context Protocol
- [ ] **19. Hook system** — pre/post tool execution, notification, policy hooks
- [ ] **20. Configuration** — validated schemas, multiple sources, environment variables

## Review: From "What Is an Agent?" to Building One

Here's the journey you've taken through this course:

| Module | What You Learned |
|--------|-----------------|
| 01 | What an agent IS — a loop, not a single call |
| 02 | Tool design — how tools are defined, dispatched, and executed |
| 03 | System prompts — identity, constraints, and formatting |
| 04 | Context management — fitting an infinite conversation into a finite window |
| 05 | Streaming — real-time output via async generators |
| 06 | The API layer — calling Claude, handling responses, managing tokens |
| 07 | Error handling — retries, classification, graceful degradation |
| 08 | Permissions — protecting users from destructive operations |
| 09 | Multi-agent — orchestrating multiple specialized agents |
| 10 | Hooks and middleware — extensibility without modifying core code |
| 11 | Testing and debugging — verifying agent behavior systematically |
| 12 | Architecture — how all the pieces fit into a production system |

## Where to Go from Here

You now understand how a production AI coding agent works at every level. Here's what you can do with this knowledge:

**Build your own agent.** Start with Tier 1. Get the loop working. Add features incrementally. Use the checklist.

**Contribute to open-source agents.** You understand the architecture. You can read the code, find bugs, add features, and review PRs.

**Extend Claude Code.** Write MCP servers for your tools. Create hooks for your workflow. Build custom commands for your team.

**Design agent systems.** The patterns here — event-driven architecture, tool abstraction, context management — apply to any agent, not just coding agents.

**Push the boundaries.** The field is young. There are unsolved problems in context management, multi-agent coordination, permission models, and agent reliability. You have the foundation to work on them.

The agent loop is simple. Everything around it is what makes it work in the real world. You now know both.

---

## Practice Exercises

> **Remember**: This is the **capstone lesson** — the final exercise of the entire course. These exercises tie together everything you've learned across all 12 modules. Exercise 5 is a comprehensive capstone project. Give it everything you've got.

### Exercise 1 — Agent Architecture Review
**Question:** The lesson describes three agent tiers: minimum viable, good, and great. For each tier, identify the single most important feature it adds over the previous tier and explain why that feature is the one that makes the biggest practical difference. Then list which modules from the course each tier draws knowledge from.

[View Answer](../../answers/12-architecture-and-advanced/answer-108.md#exercise-1)

### Exercise 2 — Build a Minimum Viable Agent
**Challenge:** Implement a complete Tier 1 agent from scratch. It must: (1) accept a user message, (2) call the Anthropic API with tools, (3) execute tool results and feed them back, (4) loop until `stop_reason === "end_turn"`, and (5) return the final text. Include at least 3 tools: `read_file`, `write_file`, and `run_command`. The entire implementation should be under 100 lines. Test it with a real prompt like "Read package.json and tell me the project name."

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-108.md#exercise-2)

### Exercise 3 — Add Production Features (Tier 2)
**Challenge:** Upgrade your Tier 1 agent to Tier 2 by converting it to an async generator that yields `StreamEvent` objects. Add: (1) retry logic with exponential backoff (max 3 retries), (2) context window management (estimate tokens, compact when above 80% threshold), (3) permission checks before executing `write_file` and `run_command`, (4) tool execution timeouts (120 second max), (5) result truncation (50KB max per tool result), and (6) a max turns limit. Each feature should correspond to concepts from specific earlier modules.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-108.md#exercise-3)

### Exercise 4 — The Production Checklist
**Challenge:** The lesson provides a 20-item production agent checklist. For each item, write one sentence explaining which lesson or module in the course taught that concept, and write a 2-3 line code snippet showing the core implementation pattern. This exercise tests your ability to connect architectural requirements to specific implementation techniques you've learned throughout the course.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-108.md#exercise-4)

### Exercise 5 — Capstone: Build a Complete Agent System
**Challenge:** This is the final exercise of the entire course. Build a **complete, production-quality agent system** that demonstrates mastery of every module. Your agent must include all of the following:

**Core (Modules 1-2):**
- Agent loop using async generator pattern
- At least 5 typed tools with input schemas (Read, Write, Bash, Grep, ListFiles)

**Prompt & Context (Modules 3-4):**
- System prompt with identity, capabilities, and constraints
- Context window tracking with automatic compaction at 80% threshold

**Streaming & API (Modules 5-6):**
- Full event streaming via `AsyncGenerator<StreamEvent>`
- Retry logic with exponential backoff and error classification

**Safety (Modules 7-8):**
- Error handling with classification (overloaded, rate_limit, auth, network)
- Permission system that gates destructive tools behind approval

**Advanced (Modules 9-12):**
- A command system with at least 4 slash commands (/help, /model, /status, /clear)
- State management using the `createStore` pattern
- Configuration loaded from a schema with defaults

**Integration:**
- A working CLI that reads user input, runs the agent, and displays results
- Session persistence (save/resume conversations)

Write the complete system. This should be 300-500 lines of TypeScript. It should compile and run.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-108.md#exercise-5)

---

*This concludes the course. Go build something.*
