# Lesson 38: The Claude API Service

## What You'll Learn

You've seen raw API calls and streaming at the protocol level. In a real agent,
you never call the API directly — you go through a service layer that handles
retries, parameter building, stream processing, and recording. In this lesson,
you'll study `claude.ts`, the central API service in Claude Code.

## Why a Service Layer?

Every API call needs the same boilerplate:

- Build parameters from the current context (model, system prompt, tools, messages)
- Wrap the call in retry logic
- Process the stream into usable content blocks
- Track costs and token usage
- Handle recording for debugging

Duplicating this across the codebase would be catastrophic. Instead, everything
flows through one function.

## The Public Entry Point: `queryModelWithStreaming()`

This is the function the agent loop calls. Here's its signature, simplified:

```typescript
async function* queryModelWithStreaming(
  messages: Message[],
  systemPrompt: string,
  tools: Tool[],
  model: string,
  maxTokens: number,
  options: {
    signal?: AbortSignal;
    enableCaching?: boolean;
    streamingVCR?: StreamingVCR;
  }
): AsyncGenerator<StreamMessage> {
  // 1. Build API parameters
  // 2. Call with retry
  // 3. Process stream
  // 4. Yield messages
}
```

It's an async generator — the same pattern you learned in Module 02. The agent loop
consumes it with `for await...of`, getting messages as they arrive.

## Step 1: Building API Parameters

Before making the call, parameters are assembled from multiple sources:

```typescript
function buildParams(
  messages: Message[],
  systemPrompt: string,
  tools: Tool[],
  model: string,
  maxTokens: number,
  enableCaching: boolean
): Anthropic.Beta.MessageCreateParams {
  const formattedMessages = normalizeMessagesForAPI(messages);
  const formattedTools = tools.map(toolToAPIFormat);

  const params: Anthropic.Beta.MessageCreateParams = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: formattedMessages,
    tools: formattedTools.length > 0 ? formattedTools : undefined,
    stream: true,
    betas: ["interleaved-thinking-2025-05-14"],
  };

  if (enableCaching) {
    applyCacheBreakpoints(params);
  }

  return params;
}
```

The `betas` array is noteworthy — it enables features like extended thinking that
aren't in the stable API yet. The `normalizeMessagesForAPI` function (Lesson 39)
transforms internal message types into the format the API expects.

## Step 2: The Retry Wrapper

The actual API call is wrapped in `withRetry`, which you'll study in depth in
Lesson 42. The key idea: `withRetry` is itself an async generator that yields
either stream events or error messages:

```typescript
async function* queryModelWithStreaming(
  messages: Message[],
  systemPrompt: string,
  tools: Tool[],
  model: string,
  maxTokens: number,
  options: QueryOptions
): AsyncGenerator<StreamMessage> {
  const params = buildParams(messages, systemPrompt, tools, model, maxTokens, options.enableCaching);

  const retryStream = withRetry(
    async (signal) => {
      const apiCall = anthropic.beta.messages.create(params, { signal });
      return apiCall.withResponse();
    },
    { maxRetries: 10, signal: options.signal }
  );

  for await (const event of retryStream) {
    if (event.type === "system_error") {
      yield event;
      continue;
    }
    // Process stream events...
  }
}
```

This creates a clean separation: the retry system handles transient failures,
and `queryModelWithStreaming` handles stream processing.

## Step 3: Processing the Stream

As events arrive, the service accumulates them into complete content blocks.
Here's the real processing logic, simplified:

```typescript
const contentBlocks: ContentBlock[] = [];
const inputJsonBuffers: Map<number, string> = new Map();
let messageId = "";
let stopReason: StopReason | null = null;
let usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };

for await (const event of retryStream) {
  switch (event.type) {
    case "message_start":
      messageId = event.message.id;
      usage = event.message.usage;
      break;

    case "content_block_start":
      contentBlocks[event.index] = event.content_block;
      if (event.content_block.type === "tool_use") {
        inputJsonBuffers.set(event.index, "");
      }
      break;

    case "content_block_delta":
      if (event.delta.type === "text_delta") {
        const block = contentBlocks[event.index];
        if (block.type === "text") {
          block.text += event.delta.text;
        }
        yield {
          type: "assistant_text_delta",
          text: event.delta.text,
        };
      } else if (event.delta.type === "input_json_delta") {
        const buffer = inputJsonBuffers.get(event.index) ?? "";
        inputJsonBuffers.set(event.index, buffer + event.delta.partial_json);
      }
      break;

    case "content_block_stop": {
      const block = contentBlocks[event.index];
      if (block.type === "tool_use") {
        const rawJson = inputJsonBuffers.get(event.index) ?? "{}";
        block.input = JSON.parse(rawJson);
        yield {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
      break;
    }

    case "message_delta":
      stopReason = event.delta.stop_reason;
      if (event.usage) {
        usage.output_tokens = event.usage.output_tokens;
      }
      break;

    case "message_stop":
      yield {
        type: "turn_complete",
        stopReason: stopReason ?? "end_turn",
        usage,
        messageId,
      };
      break;
  }
}
```

Two kinds of content blocks trigger yields:

- **Text deltas** yield immediately (the user sees text as it's generated)
- **Tool use blocks** yield only on `content_block_stop` (you need the complete
  parsed JSON input before executing the tool)

## The Streaming VCR: Record and Replay

Claude Code includes a recording system for debugging — the "streaming VCR."
It captures every event from the API so you can replay conversations:

```typescript
interface StreamingVCR {
  mode: "record" | "replay" | "off";
  events: StreamEvent[];
  filePath?: string;
}

async function* withVCR(
  vcr: StreamingVCR,
  makeCall: () => AsyncIterable<StreamEvent>
): AsyncGenerator<StreamEvent> {
  if (vcr.mode === "replay") {
    for (const event of vcr.events) {
      yield event;
    }
    return;
  }

  const stream = makeCall();
  for await (const event of stream) {
    if (vcr.mode === "record") {
      vcr.events.push(event);
    }
    yield event;
  }

  if (vcr.mode === "record" && vcr.filePath) {
    await writeFile(vcr.filePath, JSON.stringify(vcr.events));
  }
}
```

In record mode, every event is captured. In replay mode, the recorded events are
played back without making an API call. This is invaluable for debugging — you can
reproduce exact behavior without spending API credits.

## Detecting Tool Use Blocks

The service filters completed content blocks for `type === "tool_use"` and checks
`stopReason`. If `stop_reason` is `"tool_use"` and tool blocks exist, the agent
loop continues — execute the tools, append results, call again. If `"end_turn"` or
`"max_tokens"`, the loop stops.

## The Complete Flow

Here's how a single agent loop iteration flows through the service:

```
Agent Loop
  │
  ▼
queryModelWithStreaming(messages, system, tools, model)
  │
  ├── buildParams()          → Assemble API parameters
  │
  ├── withRetry()            → Wrap in retry logic
  │     │
  │     └── anthropic.beta.messages.create()  → Make API call
  │           │
  │           └── .withResponse()  → Get raw stream
  │
  ├── Process stream events  → Accumulate content blocks
  │     │
  │     ├── yield text deltas      → User sees text in real-time
  │     ├── yield tool_use blocks  → Agent loop executes tools
  │     └── yield turn_complete    → Loop knows to stop or continue
  │
  └── VCR recording          → Optionally save for replay
```

## Key Takeaways

1. `queryModelWithStreaming()` is the single entry point for all LLM calls
2. Parameters are built from context — model, system prompt, tools, messages
3. The retry wrapper is an async generator that yields errors alongside stream events
4. Text deltas are yielded immediately; tool_use blocks wait for `content_block_stop`
5. The streaming VCR enables record/replay for debugging
6. The service cleanly separates API mechanics from agent logic

## Next Lesson

The API expects messages in a specific format, but internally Claude Code uses
richer types. Next, you'll learn how `normalizeMessages()` bridges the gap between
internal message types and the API's expected format.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Service Layer Responsibilities
**Question:** Name five responsibilities that `queryModelWithStreaming()` handles so the agent loop doesn't have to. Why is centralizing these in one function important?

[View Answer](../../answers/04-model-integration/answer-38.md#exercise-1)

### Exercise 2 — Stream Processing Yields
**Question:** In the service layer's stream processing, text deltas are yielded immediately while tool_use blocks wait for `content_block_stop`. Explain why these two content types are handled differently.

[View Answer](../../answers/04-model-integration/answer-38.md#exercise-2)

### Exercise 3 — Build a Streaming VCR
**Challenge:** Implement a `StreamingVCR` class with three modes: `record`, `replay`, and `off`. In record mode, it captures events from an async iterable and saves them. In replay mode, it yields previously captured events. Write the class with `record(stream)` and `replay()` methods.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-38.md#exercise-3)

### Exercise 4 — Parameter Builder
**Challenge:** Write a `buildParams()` function that takes `messages`, `systemPrompt`, `tools`, `model`, and `maxTokens` and returns a properly structured API parameter object with `stream: true` and the `betas` array. Include conditional cache breakpoint application.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-38.md#exercise-4)
