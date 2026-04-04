# Lesson 102: Multiple Interfaces — One Core, Many Faces

## The Architecture Problem

You need to ship Claude Code as:

1. A **CLI** — interactive terminal with rich rendering
2. A **Web UI** — browser app with real-time streaming
3. An **SDK** — programmatic API for automation and integration
4. A **CI pipeline tool** — headless, non-interactive, JSON output

Four radically different interfaces. Same agent loop. Same tools. Same prompt engineering. How do you avoid writing four separate applications?

## The Answer: Shared Core, Separate Shells

Claude Code is structured as a core engine wrapped by thin interface layers:

```
┌─────────────────────────────────────────────┐
│                  Interfaces                  │
│                                             │
│  ┌─────────┐ ┌─────────┐ ┌──────────────┐  │
│  │   CLI   │ │ Web UI  │ │     SDK      │  │
│  │ cli.tsx │ │ Next.js │ │ QueryEngine  │  │
│  │ Ink/React│ │ React  │ │  .ts class   │  │
│  └────┬────┘ └────┬────┘ └──────┬───────┘  │
│       │           │             │           │
│       └───────────┼─────────────┘           │
│                   │                         │
│           ┌───────▼────────┐                │
│           │   query()      │                │
│           │  async gen     │                │
│           └───────┬────────┘                │
│                   │                         │
│           ┌───────▼────────┐                │
│           │  queryLoop()   │  ← Shared Core │
│           │  Agent loop    │                │
│           └───────┬────────┘                │
│                   │                         │
│    ┌──────────────┼──────────────┐          │
│    ▼              ▼              ▼          │
│ ┌──────┐   ┌──────────┐   ┌─────────┐     │
│ │Tools │   │  API     │   │ Context │     │
│ │System│   │  Client  │   │ Manager │     │
│ └──────┘   └──────────┘   └─────────┘     │
└─────────────────────────────────────────────┘
```

The boundary between "interface" and "core" is the `query()` function. Everything below `query()` is shared. Everything above it is interface-specific.

## Interface 1: The CLI

The CLI is the primary interface. It uses React Ink for terminal rendering:

```typescript
// cli.tsx + main.tsx → launches the REPL

async function launchRepl(opts: CLIOptions, settings: Settings) {
  render(
    <AppStateProvider settings={settings}>
      <App initialPrompt={opts.prompt} />
    </AppStateProvider>
  );
}

// Inside the REPL component
function REPL() {
  const handleSubmit = async (input: string) => {
    const events = query(
      { role: "user", content: input },
      { model: appState.model, tools: appState.tools }
    );

    // CLI-specific: feed events into React state for rendering
    for await (const event of events) {
      dispatch({ type: "STREAM_EVENT", event });
    }
  };

  return (
    <Box flexDirection="column">
      <MessageHistory messages={messages} />
      <StreamingMessage />
      <InputBox onSubmit={handleSubmit} />
      <StatusBar />
    </Box>
  );
}
```

The CLI's job: render events as rich terminal output with colors, boxes, spinners, and interactive prompts.

## Interface 2: The Web UI

The web interface is a Next.js application that streams events over HTTP:

```typescript
// web/app/api/chat/route.ts — API route

export async function POST(request: Request) {
  const { message, sessionId, model } = await request.json();

  const session = await loadSession(sessionId);

  const events = query(
    { role: "user", content: message },
    {
      model,
      messages: session.messages,
      tools: session.tools,
      permissions: session.permissions,
    }
  );

  // Web-specific: convert async generator to SSE stream
  const stream = eventsToSSEStream(events);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

The streaming adapter converts async generator events to Server-Sent Events:

```typescript
// web/lib/api/stream.ts

function eventsToSSEStream(
  events: AsyncGenerator<StreamEvent>
): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      try {
        for await (const event of events) {
          const payload = JSON.stringify(event);
          const sseMessage = `event: ${event.type}\ndata: ${payload}\n\n`;
          controller.enqueue(encoder.encode(sseMessage));
        }
      } catch (error) {
        const errorPayload = JSON.stringify({
          type: "error",
          error: { message: String(error) }
        });
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${errorPayload}\n\n`)
        );
      } finally {
        controller.close();
      }
    },

    cancel() {
      // Client disconnected — the async generator will be garbage collected
      // and any in-flight API requests will be aborted
    },
  });
}
```

On the client side, a React component consumes the SSE stream:

```typescript
// web/components/Chat.tsx

function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);

  const sendMessage = async (input: string) => {
    const response = await fetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: input, sessionId }),
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop()!; // Keep incomplete chunk

      for (const line of lines) {
        const match = line.match(/^event: (\w+)\ndata: (.+)$/s);
        if (match) {
          const event: StreamEvent = JSON.parse(match[2]);
          handleEvent(event);
        }
      }
    }
  };

  const handleEvent = (event: StreamEvent) => {
    switch (event.type) {
      case "assistant_text":
        setMessages(prev => appendToLastAssistant(prev, event.content));
        break;
      case "tool_use":
        setMessages(prev => addToolUseBlock(prev, event));
        break;
      case "tool_result":
        setMessages(prev => addToolResultBlock(prev, event));
        break;
    }
  };

  return (
    <div className="flex flex-col h-screen">
      <MessageList messages={messages} />
      <ChatInput onSubmit={sendMessage} />
    </div>
  );
}
```

## Interface 3: The SDK

The SDK provides a programmatic API for embedding Claude Code in other tools:

```typescript
// sdk/QueryEngine.ts

export class QueryEngine {
  private model: string;
  private tools: Tool[];
  private messages: MessageParam[];

  constructor(options: QueryEngineOptions) {
    this.model = options.model ?? "claude-sonnet-4-20250514";
    this.tools = options.tools ?? getDefaultTools();
    this.messages = [];
  }

  async *query(
    userMessage: string,
    options?: QueryOptions
  ): AsyncGenerator<StreamEvent> {
    const message: MessageParam = { role: "user", content: userMessage };
    this.messages.push(message);

    // Same query() function as CLI and Web
    const events = query(message, {
      model: this.model,
      messages: this.messages,
      tools: this.tools,
      maxTurns: options?.maxTurns ?? 10,
      allowedTools: options?.allowedTools ?? [],
    });

    for await (const event of events) {
      // Track messages for conversation continuity
      if (event.type === "turn_complete" && event.assistantMessage) {
        this.messages.push(event.assistantMessage);
      }
      yield event;
    }
  }

  // Convenience: collect all events and return final result
  async run(userMessage: string, options?: QueryOptions): Promise<RunResult> {
    let text = "";
    let toolResults: ToolResult[] = [];
    let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    for await (const event of this.query(userMessage, options)) {
      switch (event.type) {
        case "assistant_text":
          text += event.content;
          break;
        case "tool_result":
          toolResults.push(event);
          break;
        case "turn_complete":
          usage = event.usage;
          break;
      }
    }

    return { text, toolResults, usage };
  }
}
```

SDK usage looks like this:

```typescript
import { QueryEngine } from "@anthropic/claude-code-sdk";

const engine = new QueryEngine({
  model: "claude-sonnet-4-20250514",
  allowedTools: ["Read", "Write", "Bash"],
});

// Streaming usage
for await (const event of engine.query("Fix the failing tests")) {
  if (event.type === "assistant_text") {
    process.stdout.write(event.content);
  }
}

// Simple usage
const result = await engine.run("How many TODO comments are in the codebase?");
console.log(result.text);
```

## Interface 4: CI / Non-Interactive

The simplest interface — no UI at all:

```typescript
// Used when: echo "prompt" | claude --output-format json

async function runNonInteractive(opts: CLIOptions): Promise<void> {
  const events = query(
    { role: "user", content: opts.prompt },
    {
      model: opts.model,
      maxTurns: opts.maxTurns ?? 10,
      permissions: "auto-approve-all", // CI mode
    }
  );

  if (opts.outputFormat === "stream-json") {
    // Stream each event as a JSON line (NDJSON)
    for await (const event of events) {
      console.log(JSON.stringify(event));
    }
  } else {
    // Collect and output final result
    const result = await collectResult(events);
    console.log(JSON.stringify(result));
  }
}
```

## How Events Enable This

The key insight is that each interface only differs in how it **consumes** events:

| Interface | Consumes Events By... |
|-----------|----------------------|
| CLI | Feeding into React state → terminal rendering |
| Web UI | Serializing to SSE → HTTP streaming → browser React |
| SDK | Yielding through to the caller's `for await` loop |
| CI | Writing JSON to stdout |

The `query()` function doesn't know which interface is consuming its events. It doesn't import React, doesn't know about HTTP, doesn't know about JSON formatting. It just yields `StreamEvent` objects.

## Permissions Across Interfaces

Each interface handles permissions differently, but the mechanism is the same:

```typescript
// The core emits a permission_request event
yield { type: "permission_request", tool: "Write", input: { path: "..." } };

// CLI: shows an interactive prompt
<PermissionPrompt request={event} onResolve={handleResolve} />

// Web: sends to client, waits for WebSocket response
socket.emit("permission_request", event);
const response = await waitForSocketEvent("permission_response");

// SDK: calls the user-provided permission handler
const granted = await options.onPermissionRequest(event);

// CI: auto-approves based on allowedTools config
const granted = opts.allowedTools.includes(event.tool);
```

## Adding a New Interface

Because of this architecture, adding a new interface requires zero changes to the core. You just write a new consumer:

```typescript
// Hypothetical: Slack bot interface
async function handleSlackMessage(slackEvent: SlackMessageEvent) {
  const events = query(
    { role: "user", content: slackEvent.text },
    { model: "claude-sonnet-4-20250514", maxTurns: 5 }
  );

  let response = "";
  for await (const event of events) {
    if (event.type === "assistant_text") {
      response += event.content;
    }
  }

  await slack.chat.postMessage({
    channel: slackEvent.channel,
    text: response,
  });
}
```

Same `query()`. Same tools. Same agent loop. New interface in 15 lines.

## Key Takeaways

1. **One core, many faces** — `query()` is the universal boundary
2. **Interfaces are thin** — they only consume and present events
3. **The event system is the enabler** — no events, no multi-interface support
4. **SSE for web streaming** — async generator → ReadableStream → HTTP
5. **SDK is the simplest interface** — just re-yield the events
6. **Permissions are pluggable** — each interface provides its own resolution strategy
7. **New interfaces require zero core changes** — just write a new event consumer

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Interface Boundary Design
**Question:** Explain why the `query()` function is the "universal boundary" between interface code and core code. What would go wrong if the CLI component directly called `queryLoop()` or the API client? How does this boundary enforce separation of concerns?

[View Answer](../../answers/12-architecture-and-advanced/answer-102.md#exercise-1)

### Exercise 2 — Build an SSE Stream Adapter
**Challenge:** Implement an `eventsToSSEStream` function that converts an `AsyncGenerator<StreamEvent>` into a `ReadableStream` suitable for an HTTP response. Each event should be formatted as a Server-Sent Event with the event type on the `event:` line and JSON payload on the `data:` line. Handle errors by emitting an error event before closing the stream. Handle client disconnection by stopping iteration when the stream is cancelled.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-102.md#exercise-2)

### Exercise 3 — Build an SDK QueryEngine Class
**Challenge:** Implement a `QueryEngine` class that wraps the `query()` function for programmatic use. It should: maintain conversation history across calls, expose both a streaming `query()` method (async generator) and a convenience `run()` method (returns collected result), support configurable model and tool options, and allow resetting conversation history. Include TypeScript types for all inputs and outputs.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-102.md#exercise-3)

### Exercise 4 — Pluggable Permission Resolver
**Challenge:** Design and implement a `PermissionResolver` interface that works across all four interfaces (CLI, Web, SDK, CI). Implement four concrete resolvers: `InteractiveResolver` (prompts the user via stdin), `WebSocketResolver` (sends request over a WebSocket and waits for response), `CallbackResolver` (calls a user-provided async function), and `AutoApproveResolver` (approves tools from an allow-list, denies everything else). Write a `resolvePermission` function that accepts any resolver and a permission request.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-102.md#exercise-4)

### Exercise 5 — Build a New Interface: Discord Bot
**Challenge:** Using the "shared core, separate shell" pattern, implement a Discord bot interface for the agent. The bot should: listen for messages mentioning the bot, call `query()` with the message content, stream responses back to the Discord channel (batching updates to avoid rate limits), handle tool use events by showing an "executing tool..." status, and support a `!reset` command to clear conversation history per channel. Use the same `StreamEvent` types and `query()` function as all other interfaces.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-102.md#exercise-5)
