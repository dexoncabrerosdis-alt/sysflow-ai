# Answers: Lesson 102 — Multiple Interfaces

## Exercise 1
**Question:** Explain why the `query()` function is the "universal boundary" between interface code and core code. What would go wrong if the CLI component directly called `queryLoop()` or the API client? How does this boundary enforce separation of concerns?

**Answer:** The `query()` function is the universal boundary because it provides a single, stable API that produces a stream of typed events without any knowledge of how those events will be consumed. If the CLI directly called `queryLoop()` or the API client, it would create tight coupling: the CLI would need to understand the agent loop's internal state management, message formatting, tool dispatch, retry logic, and context management — all concerns that belong to the core. Any change to these internals would break the CLI, and every new interface (web, SDK, CI) would need to duplicate this coupling. The boundary enforces separation by establishing a contract: the core produces `StreamEvent` objects, and interfaces consume them. The core never imports React, HTTP libraries, or WebSocket code. Interfaces never import the API client, tool implementations, or context management. If you need to change how the agent loop works (add a new retry strategy, change context compaction), zero interface code changes. If you need a new interface (Slack bot, VS Code extension), zero core code changes.

---

## Exercise 2
**Challenge:** Implement an `eventsToSSEStream` function that converts an async generator to an SSE ReadableStream.

**Answer:**

```typescript
type StreamEvent = {
  type: string;
  [key: string]: unknown;
};

function eventsToSSEStream(
  events: AsyncGenerator<StreamEvent>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
          const payload = JSON.stringify(event);
          const sseMessage = `event: ${event.type}\ndata: ${payload}\n\n`;
          controller.enqueue(encoder.encode(sseMessage));
        }
      } catch (error) {
        const errorEvent = {
          type: "error",
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        };
        const errorPayload = `event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`;
        controller.enqueue(encoder.encode(errorPayload));
      } finally {
        controller.close();
      }
    },

    cancel() {
      // Client disconnected — return from the generator
      // The async generator will be garbage collected, and
      // any AbortController wired to the query will abort
      events.return(undefined);
    },
  });
}

// Usage in a Next.js/Hono/Express route
function handleChatRequest(request: Request): Response {
  const events = query(message, options);
  const stream = eventsToSSEStream(events);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
```

**Explanation:** The SSE format requires `event:` and `data:` lines separated by double newlines. The `start` method iterates the async generator and enqueues each formatted SSE message. Errors are caught and emitted as error events before the stream closes. The `cancel` method is called when the client disconnects (e.g., closes the browser tab) — it calls `events.return()` to signal the generator to stop, which propagates back through the middleware chain and eventually cancels any in-flight API requests.

---

## Exercise 3
**Challenge:** Build an SDK `QueryEngine` class with conversation history and streaming/convenience APIs.

**Answer:**

```typescript
interface QueryOptions {
  maxTurns?: number;
  allowedTools?: string[];
}

interface RunResult {
  text: string;
  toolResults: Array<{ tool: string; result: unknown }>;
  usage: { input: number; output: number };
}

interface QueryEngineOptions {
  model?: string;
  tools?: Tool[];
  systemPrompt?: string;
}

class QueryEngine {
  private model: string;
  private tools: Tool[];
  private systemPrompt: string;
  private messages: MessageParam[] = [];

  constructor(options: QueryEngineOptions = {}) {
    this.model = options.model ?? "claude-sonnet-4-20250514";
    this.tools = options.tools ?? getDefaultTools();
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  async *query(
    userMessage: string,
    options?: QueryOptions
  ): AsyncGenerator<StreamEvent> {
    const message: MessageParam = { role: "user", content: userMessage };
    this.messages.push(message);

    const events = query(message, {
      model: this.model,
      messages: [...this.messages],
      tools: this.tools,
      systemPrompt: this.systemPrompt,
      maxTurns: options?.maxTurns ?? 10,
      allowedTools: options?.allowedTools ?? [],
    });

    for await (const event of events) {
      if (event.type === "turn_complete" && event.assistantMessage) {
        this.messages.push(event.assistantMessage);
      }
      yield event;
    }
  }

  async run(userMessage: string, options?: QueryOptions): Promise<RunResult> {
    let text = "";
    const toolResults: Array<{ tool: string; result: unknown }> = [];
    let usage = { input: 0, output: 0 };

    for await (const event of this.query(userMessage, options)) {
      switch (event.type) {
        case "assistant_text":
          text += event.content;
          break;
        case "tool_result":
          toolResults.push({ tool: event.tool, result: event.result });
          break;
        case "turn_complete":
          usage = {
            input: usage.input + (event.usage?.input ?? 0),
            output: usage.output + (event.usage?.output ?? 0),
          };
          break;
      }
    }

    return { text, toolResults, usage };
  }

  resetHistory(): void {
    this.messages = [];
  }

  getHistory(): ReadonlyArray<MessageParam> {
    return [...this.messages];
  }
}

// Usage
const engine = new QueryEngine({ model: "claude-sonnet-4-20250514" });

// Streaming
for await (const event of engine.query("Read package.json")) {
  console.log(event.type);
}

// Convenience
const result = await engine.run("What is the project version?");
console.log(result.text);
```

**Explanation:** The `QueryEngine` wraps the core `query()` function and maintains conversation history as an instance field. The streaming `query()` method is an async generator that yields every event while tracking assistant messages for history continuity. The convenience `run()` method internally uses `query()` but collects all events into a structured result. History is maintained between calls so multi-turn conversations work naturally. `resetHistory()` allows starting fresh. The key insight is that the SDK is the thinnest possible interface — it just manages conversation state around the same `query()` function used by all other interfaces.

---

## Exercise 4
**Challenge:** Design a pluggable `PermissionResolver` interface with four implementations.

**Answer:**

```typescript
interface PermissionRequest {
  tool: string;
  input: Record<string, unknown>;
  description: string;
}

interface PermissionResolver {
  resolve(request: PermissionRequest): Promise<boolean>;
}

class InteractiveResolver implements PermissionResolver {
  async resolve(request: PermissionRequest): Promise<boolean> {
    const readline = await import("readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    return new Promise((resolve) => {
      rl.question(
        `Allow ${request.tool}? ${request.description} [y/N] `,
        (answer) => {
          rl.close();
          resolve(answer.toLowerCase() === "y");
        }
      );
    });
  }
}

class WebSocketResolver implements PermissionResolver {
  constructor(private socket: WebSocket) {}

  async resolve(request: PermissionRequest): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Permission request timed out"));
      }, 30000);

      const handler = (event: MessageEvent) => {
        const data = JSON.parse(event.data);
        if (data.type === "permission_response" && data.tool === request.tool) {
          clearTimeout(timeout);
          this.socket.removeEventListener("message", handler);
          resolve(data.granted);
        }
      };

      this.socket.addEventListener("message", handler);
      this.socket.send(JSON.stringify({
        type: "permission_request",
        ...request,
      }));
    });
  }
}

class CallbackResolver implements PermissionResolver {
  constructor(
    private callback: (request: PermissionRequest) => Promise<boolean>
  ) {}

  async resolve(request: PermissionRequest): Promise<boolean> {
    return this.callback(request);
  }
}

class AutoApproveResolver implements PermissionResolver {
  private allowList: Set<string>;

  constructor(allowedTools: string[]) {
    this.allowList = new Set(allowedTools);
  }

  async resolve(request: PermissionRequest): Promise<boolean> {
    return this.allowList.has(request.tool);
  }
}

// Unified resolution function
async function resolvePermission(
  resolver: PermissionResolver,
  request: PermissionRequest
): Promise<boolean> {
  try {
    return await resolver.resolve(request);
  } catch (error) {
    console.error(`Permission resolution failed: ${error}`);
    return false; // Deny on error
  }
}
```

**Explanation:** The `PermissionResolver` interface defines a single `resolve` method, keeping the contract minimal. Each implementation handles permissions differently: `InteractiveResolver` uses readline for terminal prompts, `WebSocketResolver` sends over a socket and waits with a timeout, `CallbackResolver` delegates to a user-provided function (most flexible for SDK usage), and `AutoApproveResolver` checks an allow-list (ideal for CI). The `resolvePermission` wrapper adds error handling — if resolution fails for any reason, it defaults to deny. This design means the core agent loop only knows about the `PermissionResolver` interface, never about specific UI mechanisms.

---

## Exercise 5
**Challenge:** Build a Discord bot interface using the shared core pattern.

**Answer:**

```typescript
import { Client, Events, GatewayIntentBits, TextChannel } from "discord.js";

class DiscordBotInterface {
  private client: Client;
  private channelHistories: Map<string, MessageParam[]> = new Map();
  private updateDebounceMs = 1000;

  constructor(private token: string) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;
      if (!message.mentions.has(this.client.user!)) return;

      const content = message.content
        .replace(/<@!?\d+>/g, "")
        .trim();

      if (content === "!reset") {
        this.channelHistories.delete(message.channelId);
        await message.reply("Conversation history cleared.");
        return;
      }

      await this.handleQuery(message.channel as TextChannel, content, message.channelId);
    });

    await this.client.login(this.token);
  }

  private async handleQuery(
    channel: TextChannel,
    userMessage: string,
    channelId: string
  ): Promise<void> {
    const history = this.channelHistories.get(channelId) ?? [];

    const events = query(
      { role: "user", content: userMessage },
      {
        model: "claude-sonnet-4-20250514",
        messages: history,
        maxTurns: 5,
        permissions: "auto-approve-readonly",
      }
    );

    let responseText = "";
    let lastUpdateTime = 0;
    let replyMessage = await channel.send("*Thinking...*");
    let currentToolName: string | null = null;

    for await (const event of events) {
      switch (event.type) {
        case "assistant_text":
          responseText += event.content;
          const now = Date.now();
          if (now - lastUpdateTime > this.updateDebounceMs) {
            await replyMessage.edit(
              responseText.slice(0, 2000) +
              (responseText.length > 2000 ? "\n...(truncated)" : "")
            );
            lastUpdateTime = now;
          }
          break;

        case "tool_use":
          currentToolName = event.tool;
          await replyMessage.edit(
            responseText + `\n*Executing ${event.tool}...*`
          );
          break;

        case "tool_result":
          currentToolName = null;
          break;

        case "turn_complete":
          if (event.assistantMessage) {
            history.push(
              { role: "user", content: userMessage },
              event.assistantMessage
            );
            this.channelHistories.set(channelId, history);
          }
          break;
      }
    }

    // Final update with complete response
    if (responseText) {
      await replyMessage.edit(
        responseText.slice(0, 2000) +
        (responseText.length > 2000 ? "\n...(truncated)" : "")
      );
    }
  }
}

// Usage
const bot = new DiscordBotInterface(process.env.DISCORD_TOKEN!);
await bot.start();
```

**Explanation:** The Discord bot follows the exact same "thin interface" pattern as the CLI, Web, and SDK. It calls the same `query()` function and consumes the same `StreamEvent` stream. The interface-specific logic is: listening for Discord mentions, debouncing message edits to avoid rate limits (Discord limits edit frequency), truncating responses to 2000 characters (Discord's message limit), tracking conversation history per channel, and showing tool execution status. The `!reset` command clears per-channel history. The core agent loop has no knowledge of Discord — it just yields events. This demonstrates the architecture's extensibility: a complete new interface in about 80 lines.
