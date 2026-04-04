# Lesson 19: The QueryEngine

So far, we've been looking at the agent loop from the inside — the `while (true)`, the state management, the yields. But external consumers don't interact with the generator directly. They use the **QueryEngine**: a class that wraps the agent loop and provides a clean API for submitting messages, reading results, and controlling execution.

## Why a Wrapper Class?

The `query()` generator is powerful but low-level. To use it, you need to:
- Construct the right `QueryParams`
- Consume the async generator correctly
- Track messages across multiple submissions
- Handle interruption
- Manage model selection

The `QueryEngine` class handles all of this, exposing a simple interface: send a message, get events back.

## The QueryEngine Class

Here's the structure:

```typescript
class QueryEngine {
  private config: QueryEngineConfig;
  private messages: Message[] = [];
  private currentGenerator: AsyncGenerator | null = null;
  private model: string;
  private readFileState: Map<string, FileReadState>;
  private abortController: AbortController | null = null;

  constructor(config: QueryEngineConfig) {
    this.config = config;
    this.model = config.model ?? "claude-sonnet-4-20250514";
    this.messages = [];
    this.readFileState = new Map();
  }

  // Submit a user message and get events back
  async *submitMessage(userMessage: string): AsyncGenerator<StreamEvent | Message> { ... }

  // Stop the current conversation
  interrupt(): void { ... }

  // Read current state
  getMessages(): Message[] { ... }
  getReadFileState(): Map<string, FileReadState> { ... }
  getModel(): string { ... }

  // Update configuration
  setModel(model: string): void { ... }
}
```

## QueryEngineConfig

The configuration object determines how the engine behaves:

```typescript
interface QueryEngineConfig {
  // Which model to use
  model?: string;

  // System prompt (or a function that builds it dynamically)
  systemPrompt: string | (() => string);

  // Maximum iterations per submitMessage call
  maxTurns?: number;

  // Token budget for each task
  taskBudgetTokens?: number;

  // Which tools are available
  tools?: Tool[];

  // Permission callback for tools that need approval
  onToolApproval?: (tool: ToolUse) => Promise<boolean>;

  // Hook configuration
  hooks?: HooksConfig;

  // Working directory for file operations
  cwd?: string;

  // Callback for events (alternative to consuming the generator)
  onEvent?: (event: StreamEvent | Message) => void;
}
```

Consumers configure behavior through this object rather than by modifying the loop internals. This is the boundary between "how the loop works" (internal) and "what the loop does" (external).

## submitMessage(): The Entry Point

This is the primary method. It takes a user message, runs the agent loop, and yields events:

```typescript
async *submitMessage(
  userMessage: string
): AsyncGenerator<StreamEvent | Message> {
  // Add the user message to history
  this.messages.push({
    role: "user",
    content: userMessage,
  });

  // Build params for the loop
  const params: QueryParams = {
    messages: this.messages,
    systemPrompt: typeof this.config.systemPrompt === "function"
      ? this.config.systemPrompt()
      : this.config.systemPrompt,
    canUseTool: this.buildToolFilter(),
    toolUseContext: this.getToolUseContext(),
    maxTurns: this.config.maxTurns,
    taskBudgetTokens: this.config.taskBudgetTokens,
    model: this.model,
    sessionContext: this.buildSessionContext(),
  };

  // Create abort controller for this run
  this.abortController = new AbortController();

  // Run the agent loop
  const generator = query(params);
  this.currentGenerator = generator;

  let result = await generator.next();

  while (!result.done) {
    const event = result.value;

    // Track messages internally
    if ("role" in event) {
      this.messages.push(event as Message);
    }

    // Update file read tracking
    if (isFileReadResult(event)) {
      this.updateReadFileState(event);
    }

    // Yield to consumer
    yield event;

    result = await generator.next();
  }

  // Loop ended — result.value is the Terminal
  const terminal = result.value;

  this.currentGenerator = null;
  this.abortController = null;
}
```

The key insight: `submitMessage()` is itself an async generator. It wraps `query()`, tracking messages and state as events flow through. The consumer gets events; the engine quietly maintains bookkeeping.

## interrupt(): Stopping a Running Conversation

When the user wants to stop (Ctrl+C in CLI, stop button in web), `interrupt()` is called:

```typescript
interrupt(): void {
  if (this.abortController) {
    this.abortController.abort();
  }
}
```

The abort signal propagates through the system:
1. `interrupt()` is called
2. The `AbortController` signals abort
3. Any in-flight API call is cancelled
4. Any running tool is interrupted
5. The loop detects the abort and returns a terminal with reason `"aborted_streaming"` or `"aborted_tools"`
6. `submitMessage()` sees `result.done === true` and exits

The abort controller pattern (standard Web API) ensures clean cancellation without leaving hanging promises or orphaned processes.

## Message Management

The `QueryEngine` maintains the full conversation history across multiple `submitMessage()` calls:

```typescript
// First interaction
engine.submitMessage("What files are in this project?");
// engine.messages: [user, assistant(list_dir), tool_result, assistant(answer)]

// Second interaction — continues the conversation
engine.submitMessage("Now read the README");
// engine.messages: [user, assistant, tool_result, assistant, user, assistant(read), tool_result, assistant]

// Access the full history
const allMessages = engine.getMessages();
```

Each `submitMessage()` call adds to the existing history. The model sees the entire conversation, so it has context from all previous interactions. This is how multi-turn conversations work — the engine persists state between submissions.

## Accessor Methods

The engine exposes read-only accessors for its internal state:

```typescript
// Get the full message history
getMessages(): Message[] {
  return [...this.messages]; // Returns a copy
}

// Get file read state — which files have been read, their contents
getReadFileState(): Map<string, FileReadState> {
  return new Map(this.readFileState); // Returns a copy
}

// Get the current model
getModel(): string {
  return this.model;
}
```

These return copies, not references. Consumers can't accidentally mutate the engine's internal state.

## setModel(): Runtime Model Switching

The model can be changed between submissions:

```typescript
setModel(model: string): void {
  this.model = model;
}
```

This is used when:
- The user explicitly requests a different model
- An automated system escalates from a fast model to a more capable one
- A fallback is needed because the current model is failing

The change takes effect on the next `submitMessage()` call — it doesn't affect a running loop.

## How the SDK Uses QueryEngine

Here's a typical SDK consumer:

```typescript
import { QueryEngine } from "@anthropic-ai/claude-code";

const engine = new QueryEngine({
  model: "claude-sonnet-4-20250514",
  systemPrompt: "You are a helpful coding assistant.",
  maxTurns: 30,
  tools: [readFileTool, writeFileTool, searchTool],
  cwd: "/home/user/project",
});

// Submit a task
const events: (StreamEvent | Message)[] = [];
for await (const event of engine.submitMessage("Fix the failing tests")) {
  events.push(event);

  // Optionally react to events in real time
  if (event.type === "content_block_delta") {
    process.stdout.write(event.delta?.text ?? "");
  }
}

// Get the final conversation state
const messages = engine.getMessages();
const lastMessage = messages[messages.length - 1];
console.log("Final response:", lastMessage.content);
```

The SDK consumer doesn't know or care about `queryLoop()`, state management, terminal reasons, or yield sequences. It submits a message, consumes events, and reads results. The `QueryEngine` handles everything else.

## QueryEngine vs. query(): Where the Boundary Is

```
┌─────────────────────────────────────────────┐
│  SDK Consumer / CLI / Web UI                │
│  - Submits messages                         │
│  - Receives events                          │
│  - Can interrupt                            │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │  QueryEngine                          │  │
│  │  - Manages message history            │  │
│  │  - Builds QueryParams                 │  │
│  │  - Tracks file reads                  │  │
│  │  - Handles model selection            │  │
│  │  - Manages abort controller           │  │
│  │                                       │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │  query() / queryLoop()          │  │  │
│  │  │  - The while(true) loop         │  │  │
│  │  │  - State management             │  │  │
│  │  │  - Tool execution               │  │  │
│  │  │  - Streaming                    │  │  │
│  │  │  - Compaction                   │  │  │
│  │  │  - Terminal/continue decisions  │  │  │
│  │  └─────────────────────────────────┘  │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

The `QueryEngine` is the API boundary. Everything below it is implementation detail. Everything above it is consumer code. If the loop internals change (new state fields, different compaction strategy, new terminal reasons), the `QueryEngine` API stays the same.

## Comparison: Our Simple Loop vs. QueryEngine

```typescript
// What we built in Lesson 12
async function agentLoop(userMessage: string): Promise<string> { ... }
// - Takes a string, returns a string
// - No state between calls
// - No interruption
// - No configuration

// What Claude Code ships
class QueryEngine {
  constructor(config: QueryEngineConfig) { ... }
  async *submitMessage(msg: string): AsyncGenerator<StreamEvent | Message> { ... }
  interrupt(): void { ... }
  getMessages(): Message[] { ... }
  setModel(model: string): void { ... }
}
// - Takes a config, yields events
// - Persistent state across calls
// - Clean interruption
// - Fully configurable
```

The fundamental operation is the same — submit a task, get a result through a loop. The `QueryEngine` adds the production-grade scaffolding that makes it usable by real applications.

---

**Key Takeaways**
- `QueryEngine` is the class that wraps the agent loop for external consumers
- `submitMessage()` is the entry point — it builds `QueryParams`, runs `query()`, and yields events
- The engine maintains conversation history across multiple `submitMessage()` calls
- `interrupt()` uses `AbortController` for clean cancellation of in-flight operations
- Accessor methods (`getMessages()`, `getModel()`) return copies to prevent external mutation
- The `QueryEngine` is the API boundary — consumers never interact with `query()` directly
- The relationship is: Consumer → QueryEngine → query() → queryLoop()

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook.

### Exercise 1 — The Layered Architecture
**Question:** Draw or describe the three-layer architecture of Claude Code's execution model: Consumer, QueryEngine, and query()/queryLoop(). What does each layer own, and why is the boundary between QueryEngine and query() important?

[View Answer](../../answers/02-the-agent-loop/answer-19.md#exercise-1)

### Exercise 2 — Build a Mini QueryEngine
**Challenge:** Implement a simplified `QueryEngine` class with: a `constructor` that takes a config (model, system prompt, maxTurns), a `submitMessage(msg)` async generator method that maintains message history across calls, a `getMessages()` method that returns a copy, and an `interrupt()` method using `AbortController`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-19.md#exercise-2)

### Exercise 3 — Why Return Copies?
**Question:** The accessor methods `getMessages()` and `getReadFileState()` return copies rather than references. Why? Give a concrete example of a bug that would occur if they returned references.

[View Answer](../../answers/02-the-agent-loop/answer-19.md#exercise-3)

### Exercise 4 — Interrupt Flow
**Challenge:** Write code that demonstrates the full interrupt flow: start a `submitMessage()` call, set a timer to call `interrupt()` after 2 seconds, and show how the generator terminates cleanly. Include the `AbortController` wiring.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-19.md#exercise-4)

### Exercise 5 — Multi-Turn Conversation State
**Question:** Explain what happens to the `messages` array inside `QueryEngine` across three `submitMessage()` calls. Why is it important that the engine persists messages between calls rather than starting fresh each time?

[View Answer](../../answers/02-the-agent-loop/answer-19.md#exercise-5)
