# Lesson 14: The Query Function

Now that you understand async generators, we can look at Claude Code's actual agent loop. It lives in two functions: `query()` and `queryLoop()`. The first is a thin wrapper; the second is where the `while (true)` lives.

## The Two Functions

Claude Code's agent loop is split into two functions for a clean separation of concerns:

```typescript
// The outer function: handles completion and notifications
export async function* query(
  params: QueryParams
): AsyncGenerator<StreamEvent | Message, Terminal> {
  // ...setup...
  const terminal = yield* queryLoop(params, consumedCommandUuids);
  // ...cleanup, notification, and metrics...
  return terminal;
}

// The inner function: the actual while(true) loop
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[]
): AsyncGenerator<
  StreamEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  Terminal
> {
  // ...the real agent loop...
}
```

`query()` delegates to `queryLoop()` using `yield*` — a special syntax that forwards all yielded values from one generator through another. The consumer never knows there are two functions involved; they see a single stream of events.

Why the split? Because `query()` handles things that happen exactly once — setup before the loop and cleanup after it. The loop itself is isolated in `queryLoop()`.

## QueryParams: Everything the Loop Needs

Both functions take a `QueryParams` object that bundles every input the loop requires:

```typescript
interface QueryParams {
  // The conversation so far
  messages: Message[];

  // Instructions for the model
  systemPrompt: string;

  // Controls which tools are available
  canUseTool: (tool: Tool) => boolean;

  // Context about ongoing tool use
  toolUseContext: ToolUseContext;

  // Maximum iterations before forced stop
  maxTurns?: number;

  // Which model to use
  model?: string;

  // Token budget for the entire task
  taskBudgetTokens?: number;

  // Context about the current session
  sessionContext: SessionContext;

  // Hooks configuration (pre/post tool execution)
  hooks?: HooksConfig;

  // ... additional fields
}
```

The key fields:

**`messages`** — the conversation history. This is the same concept from Lesson 12: every previous user message, assistant response, and tool result. The loop appends to this as it runs.

**`systemPrompt`** — the instructions that tell Claude how to behave. This is rebuilt on every iteration (we'll see why in Lesson 20).

**`canUseTool`** — a function that determines whether a specific tool is available this turn. This is how Claude Code implements tool permissions: some tools require user approval, some are always allowed, some are disabled entirely.

**`maxTurns`** — the safety limit on loop iterations. Without this, a confused model could loop indefinitely.

## Inside query(): The Wrapper

The outer `query()` function is simpler than you might expect:

```typescript
export async function* query(
  params: QueryParams
): AsyncGenerator<StreamEvent | Message, Terminal> {
  const consumedCommandUuids: string[] = [];

  // Run the actual loop, forwarding all events
  const terminal = yield* queryLoop(params, consumedCommandUuids);

  // Post-loop work: analytics, notifications, cleanup
  if (terminal.reason === "completed") {
    await notifyCompletion(params);
  }

  trackLoopMetrics(terminal);

  return terminal;
}
```

The `yield*` on line 6 is doing the heavy lifting. It means "run `queryLoop()`, and whatever it yields, yield that from me too." From the consumer's perspective, events flow seamlessly.

When `queryLoop()` returns (with a `Terminal` value), `query()` catches that return value, does post-processing, and returns it as its own return value.

## Inside queryLoop(): The Real Loop

This is where the `while (true)` pattern from Lesson 11 becomes real code:

```typescript
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[]
): AsyncGenerator<
  StreamEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  Terminal
> {
  // Initialize state
  let state: State = {
    messages: [...params.messages],
    toolUseContext: params.toolUseContext,
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    // ... more fields
  };

  while (true) {
    // Signal: a new turn is starting
    yield { type: "stream_request_start" };

    // ---------- Pre-API work ----------
    // Apply tool result budget (trim large results)
    // Run compaction if context is growing large
    // Build the system prompt for this turn
    // Check token limits

    // ---------- Call the model ----------
    const { response, events } = await streamModelResponse(state);

    // Yield streaming events to consumers
    for (const event of events) {
      yield event;
    }

    // ---------- Process the response ----------
    const transition = await processResponse(state, response);

    // ---------- Branch: terminal or continue? ----------
    if (transition.type === "terminal") {
      // Yield any final messages
      for (const msg of transition.messages) {
        yield msg;
      }
      return transition.terminal; // Exit the loop
    }

    // It's a continue transition — execute tools, build next state
    for (const msg of transition.messages) {
      yield msg;
    }

    const toolResults = await executeTools(transition.toolCalls);

    for (const result of toolResults) {
      yield result;
    }

    // Build the next iteration's state
    state = buildNextState(state, transition, toolResults);
  }
}
```

This is a simplified view, but the structure is accurate. Compare it to our simple loop from Lesson 12:

| Simple Loop (Lesson 12) | queryLoop() |
|--------------------------|-------------|
| `const response = await client.messages.create(...)` | `streamModelResponse(state)` |
| `if (response.stop_reason === "end_turn")` | `if (transition.type === "terminal")` |
| `await executeTool(...)` | `await executeTools(transition.toolCalls)` |
| `messages.push(...)` | `state = buildNextState(...)` |
| `return text` | `return transition.terminal` |

Same pattern, more infrastructure.

## The yield* Delegation Pattern

The `yield*` syntax deserves special attention because Claude Code uses it heavily:

```typescript
// Without yield*: you manually forward events
async function* outer(): AsyncGenerator<Event> {
  const gen = inner();
  for await (const event of gen) {
    yield event; // Manually forwarding every event
  }
}

// With yield*: delegation handles it automatically
async function* outer(): AsyncGenerator<Event> {
  yield* inner(); // All events from inner() flow through
}
```

Both are equivalent, but `yield*` is cleaner and preserves the return value:

```typescript
async function* query(params: QueryParams): AsyncGenerator<StreamEvent, Terminal> {
  const terminal = yield* queryLoop(params, []); // Return value captured!
  return terminal;
}
```

Without `yield*`, you'd need to manually track when the inner generator is done and extract its return value using the iterator protocol. `yield*` does this automatically.

## The Function Signature Tells the Story

Look at the `queryLoop` signature one more time:

```typescript
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[]
): AsyncGenerator<
  StreamEvent | Message | TombstoneMessage | ToolUseSummaryMessage,
  Terminal
>
```

Reading the types alone tells you everything about the function's behavior:
- `async function*` — it's an async generator (produces events over time)
- `QueryParams` — it needs a conversation, system prompt, tools, and limits
- `StreamEvent | Message | TombstoneMessage | ToolUseSummaryMessage` — the types of events it yields
- `Terminal` — it returns a terminal reason when it stops

The types are the documentation. When you see a function signature like this, you know it's a long-running process that produces a stream of typed events and eventually stops with a status.

## How Consumers Use query()

Different parts of Claude Code consume the generator differently:

```typescript
// The CLI: renders events to the terminal
async function runCLI(params: QueryParams) {
  for await (const event of query(params)) {
    if (event.type === "stream_request_start") {
      renderSpinner();
    } else if ("content" in event) {
      renderMessage(event);
    }
    // ... handle other event types
  }
}

// The SDK (QueryEngine): collects messages and exposes them
async function runSDK(params: QueryParams) {
  const gen = query(params);
  let result = await gen.next();

  while (!result.done) {
    collectMessage(result.value);
    result = await gen.next();
  }

  const terminal = result.value; // The Terminal return value
  return { messages: getCollectedMessages(), reason: terminal.reason };
}
```

The same `query()` function powers the interactive CLI, the web interface, and the programmatic SDK. The async generator pattern makes this possible without the loop needing to know anything about its consumers.

---

**Key Takeaways**
- Claude Code's agent loop is split into `query()` (wrapper) and `queryLoop()` (the loop)
- `query()` handles one-time setup/cleanup; `queryLoop()` contains the `while (true)`
- `QueryParams` bundles everything the loop needs: messages, system prompt, tool permissions, limits
- `yield*` delegates from `query()` to `queryLoop()`, forwarding all events transparently
- The function signatures encode the full behavior: what goes in, what comes out over time, what's returned at the end
- Different consumers (CLI, web, SDK) all consume the same async generator differently

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook.

### Exercise 1 — Why Split into Two Functions?
**Question:** Why does Claude Code split the agent loop into `query()` and `queryLoop()` instead of putting everything in one function? What specific responsibilities does each function have?

[View Answer](../../answers/02-the-agent-loop/answer-14.md#exercise-1)

### Exercise 2 — Implement yield* Delegation
**Challenge:** Write two async generators: an `inner()` that yields numbers 1-3 and returns `"done"`, and an `outer()` that delegates to `inner()` using `yield*`, captures the return value, and yields it as a final number (e.g., the string length). Verify that consumers of `outer()` see all values from `inner()` seamlessly.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-14.md#exercise-2)

### Exercise 3 — QueryParams Design
**Question:** The `canUseTool` field in `QueryParams` is a function `(tool: Tool) => boolean` rather than a simple list of allowed tool names. Why is a function more powerful? Give two scenarios where a simple list would be insufficient.

[View Answer](../../answers/02-the-agent-loop/answer-14.md#exercise-3)

### Exercise 4 — Build a Mini query() Wrapper
**Challenge:** Create a simplified version of the `query()` / `queryLoop()` split. Write `queryLoop()` as an async generator that yields `string` events and returns `{ reason: string }`. Write `query()` as a wrapper that uses `yield*` to delegate, then logs the terminal reason before returning it. Test with a consumer.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-14.md#exercise-4)

### Exercise 5 — Reading Type Signatures
**Question:** Given this signature: `async function* process(config: Config): AsyncGenerator<Event | Log, Summary>` — without seeing the implementation, describe what this function does, what consumers receive during execution, and what they get when it finishes.

[View Answer](../../answers/02-the-agent-loop/answer-14.md#exercise-5)
