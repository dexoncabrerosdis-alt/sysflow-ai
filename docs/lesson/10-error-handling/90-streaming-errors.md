# Lesson 90: Streaming Errors

## The Real-Time Challenge

In Modules 05-06, you learned how streaming works: the model sends content incrementally, and the agent processes it as it arrives. But what happens when an error occurs **during** streaming? The response is half-received. Tool calls might be partially constructed. The UI has already shown content to the user.

Streaming errors are harder than batch errors because you can't simply discard the response and retry — the user has already seen part of it, and the system has already started processing it.

## Error Types During Streaming

### FallbackTriggeredError: Mid-Stream Model Switch

The most complex streaming error is when the primary model fails mid-response and the system needs to switch to a fallback:

```typescript
class FallbackTriggeredError extends Error {
  constructor(
    message: string,
    public readonly fallbackModel: string,
    public readonly partialResponse: ContentBlock[],
    public readonly originalError: Error
  ) {
    super(message);
    this.name = "FallbackTriggeredError";
  }
}
```

This can happen when:
- The primary model's server crashes mid-generation
- A network interruption cuts the stream
- The model hits an internal error after generating some content

```typescript
async function* handleFallbackDuringStream(
  error: FallbackTriggeredError,
  messages: Message[],
  config: ModelConfig
): AsyncGenerator<Message> {
  // Notify the user
  yield {
    type: "system",
    message: `Switching to fallback model due to: ${error.message}`,
  };

  // Discard partial response and retry with fallback
  const fallbackConfig = {
    ...config,
    model: error.fallbackModel,
  };

  const response = await callModel(fallbackConfig);
  yield* processResponse(response);
}
```

### Image Errors: Size and Resize Failures

When the model's response includes image references or tool calls that process images, two specific errors can occur:

```typescript
class ImageSizeError extends Error {
  constructor(
    public readonly imagePath: string,
    public readonly actualSize: number,
    public readonly maxSize: number
  ) {
    super(
      `Image ${imagePath} is ${actualSize} bytes, exceeds limit of ${maxSize}`
    );
    this.name = "ImageSizeError";
  }
}

class ImageResizeError extends Error {
  constructor(
    public readonly imagePath: string,
    public readonly reason: string
  ) {
    super(`Failed to resize image ${imagePath}: ${reason}`);
    this.name = "ImageResizeError";
  }
}
```

These are handled by converting the error into a text description that the model can work with:

```typescript
function handleImageError(
  error: ImageSizeError | ImageResizeError,
  toolUseId: string
): ToolResultMessage {
  if (error instanceof ImageSizeError) {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: `The image at ${error.imagePath} is too large ` +
            `(${Math.round(error.actualSize / 1024)}KB, limit is ` +
            `${Math.round(error.maxSize / 1024)}KB). ` +
            `Try using a smaller image or describing the image ` +
            `content in text instead.`,
          is_error: true,
        },
      ],
    };
  }

  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: `Failed to process image at ${error.imagePath}: ` +
          `${error.reason}. Try an alternative approach.`,
        is_error: true,
      },
    ],
  };
}
```

### Unknown Errors: Orphaned Tool Calls

The trickiest streaming error creates **orphaned tool_use blocks**. The model generates a `tool_use` block, but the stream dies before the tool result can be generated. The conversation history now has a tool_use without a matching tool_result, which violates the API's message format requirements.

```typescript
// The problem:
// Message history after a stream error:
[
  { role: "user", content: "Fix the bug in parser.ts" },
  { role: "assistant", content: [
    { type: "text", text: "I'll read the file first." },
    { type: "tool_use", id: "toolu_123", name: "read_file", input: { path: "parser.ts" } },
    // Stream died here — no tool_result was ever added
  ]},
  // API requires a tool_result for toolu_123 before the next message
]
```

The solution: create **synthetic tool_result blocks** for any orphaned tool_use:

```typescript
function createSyntheticToolResults(
  partialResponse: ContentBlock[]
): ToolResultMessage[] {
  const orphanedToolUses = partialResponse.filter(
    (block): block is ToolUseBlock =>
      block.type === "tool_use"
  );

  return orphanedToolUses.map((toolUse) => ({
    role: "user" as const,
    content: [
      {
        type: "tool_result" as const,
        tool_use_id: toolUse.id,
        content:
          "This tool call was not executed because the response " +
          "was interrupted by an error. The operation was not performed. " +
          "You may retry this tool call if still needed.",
        is_error: true,
      },
    ],
  }));
}
```

## The createAssistantAPIErrorMessage Pattern

When a streaming error occurs and the partial response needs to be preserved in the conversation, Claude Code creates a synthetic assistant error message:

```typescript
function createAssistantAPIErrorMessage(
  error: Error,
  partialContent: ContentBlock[]
): AssistantMessage {
  // Keep any complete text blocks from the partial response
  const preservedBlocks = partialContent.filter(
    (block) => block.type === "text" && block.text.length > 0
  );

  // Add an error indicator
  preservedBlocks.push({
    type: "text",
    text: `\n\n[Response interrupted: ${error.message}]`,
  });

  return {
    role: "assistant",
    content: preservedBlocks,
  };
}
```

This preserves what the model already generated (which might include useful analysis or partial code) while clearly marking the interruption point.

## Withholding Errors Until Recovery Decision

Not all streaming errors should be immediately surfaced. Some errors might be recoverable, and showing them prematurely causes unnecessary alarm:

```typescript
interface WithheldStreamError {
  error: Error;
  partialResponse: ContentBlock[];
  withheldAt: number;
  resolved: boolean;
}

class StreamErrorBuffer {
  private withheld: WithheldStreamError[] = [];

  withhold(error: Error, partial: ContentBlock[]): void {
    this.withheld.push({
      error,
      partialResponse: partial,
      withheldAt: Date.now(),
      resolved: false,
    });
  }

  resolve(index: number): void {
    if (this.withheld[index]) {
      this.withheld[index].resolved = true;
    }
  }

  getUnresolved(): WithheldStreamError[] {
    return this.withheld.filter((e) => !e.resolved);
  }

  flush(): WithheldStreamError[] {
    const unresolved = this.getUnresolved();
    this.withheld = [];
    return unresolved;
  }
}
```

The workflow:

```typescript
async function* handleStreamWithErrorBuffer(
  stream: AsyncIterable<StreamEvent>,
  config: ModelConfig
): AsyncGenerator<Message> {
  const errorBuffer = new StreamErrorBuffer();
  const contentBlocks: ContentBlock[] = [];

  try {
    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        // Accumulate content and yield to UI
        updateContentBlocks(contentBlocks, event);
        yield createDeltaMessage(event);
      }
    }
  } catch (error) {
    // Withhold the error — try recovery first
    errorBuffer.withhold(error, [...contentBlocks]);

    // Attempt recovery
    const recovered = await attemptStreamRecovery(
      error,
      contentBlocks,
      config
    );

    if (recovered) {
      errorBuffer.resolve(0);
      yield* recovered;
      return;
    }
  }

  // Flush any unresolved errors
  const unresolvedErrors = errorBuffer.flush();
  for (const withheld of unresolvedErrors) {
    yield createErrorMessage(
      `Stream error: ${withheld.error.message}`
    );

    // Generate synthetic tool results for orphaned calls
    const synthetics = createSyntheticToolResults(
      withheld.partialResponse
    );
    for (const synthetic of synthetics) {
      yield synthetic;
    }
  }
}
```

## Complete Streaming Error Handler

Putting it all together:

```typescript
async function* processStreamWithRecovery(
  stream: AsyncIterable<StreamEvent>,
  messages: Message[],
  config: ModelConfig
): AsyncGenerator<Message> {
  const contentBlocks: ContentBlock[] = [];

  try {
    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start":
          contentBlocks.push(initializeBlock(event));
          break;

        case "content_block_delta":
          updateBlock(contentBlocks, event);
          yield createIncrementalMessage(event);
          break;

        case "content_block_stop":
          finalizeBlock(contentBlocks, event);
          break;

        case "message_stop":
          // Clean completion
          return;

        case "error":
          throw new StreamError(event.error);
      }
    }
  } catch (error) {
    // Classify the error
    if (error instanceof FallbackTriggeredError) {
      yield* handleFallbackDuringStream(error, messages, config);
      return;
    }

    if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
      const lastToolUse = contentBlocks.findLast(
        (b) => b.type === "tool_use"
      );
      if (lastToolUse) {
        yield handleImageError(error, lastToolUse.id);
        return;
      }
    }

    // Unknown error — preserve what we have and clean up
    if (contentBlocks.length > 0) {
      yield createAssistantAPIErrorMessage(error, contentBlocks);

      const synthetics = createSyntheticToolResults(contentBlocks);
      for (const msg of synthetics) {
        yield msg;
      }
    }

    yield {
      type: "system",
      message: `Streaming error: ${error.message}. ` +
        `Partial response preserved. Attempting to continue...`,
    };
  }
}
```

## Summary

Streaming errors require special handling because the response is partially consumed when the error occurs. The key patterns are: FallbackTriggeredError for mid-stream model switching, synthetic tool results for orphaned tool_use blocks, error withholding for attempted recovery, and createAssistantAPIErrorMessage for preserving partial content. These mechanisms ensure the agent can recover from streaming failures without corrupting the conversation state.

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Synthetic Tool Results
**Challenge:** Implement `createSyntheticToolResults()` that scans a partial response's content blocks, finds all `tool_use` blocks, and generates matching synthetic `tool_result` messages marked as errors. Test with three cases: a partial response with zero tool_use blocks, one orphaned tool_use, and three orphaned tool_use blocks.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-90.md#exercise-1)

### Exercise 2 — Stream Error Simulator
**Challenge:** Build a `MockStream` class that yields content block events (text deltas and tool_use blocks) and can be configured to throw an error at a random point. Create a `StreamErrorSimulator` that runs the stream through your error handler and verifies the resulting conversation state is valid (no orphaned tool_use blocks, proper message format).

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-90.md#exercise-2)

### Exercise 3 — StreamErrorBuffer with Timeout
**Challenge:** Implement `StreamErrorBuffer` with auto-flush: if a withheld error isn't resolved within a configurable timeout (default 5 seconds), automatically flush it and return the unresolved errors. Use `setTimeout` and provide both `withhold()`, `resolve()`, and `onAutoFlush()` callback registration.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-90.md#exercise-3)

### Exercise 4 — Conversation State Validator
**Challenge:** Write a `validateConversationState()` function that checks conversation integrity after a streaming error. It should verify: (1) every `tool_use` in an assistant message has a matching `tool_result` in the following user message, (2) messages alternate correctly between user and assistant roles, (3) no content blocks are empty, and (4) the last message has valid structure.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-90.md#exercise-4)

### Exercise 5 — Orphaned Tool Calls
**Question:** Explain in 3-4 sentences why orphaned `tool_use` blocks are dangerous for the agent loop. What specific API error would occur if you tried to continue the conversation without adding synthetic tool results? Why is the synthetic result marked `is_error: true` rather than returning a fake success?

[View Answer](../../answers/10-error-handling/answer-90.md#exercise-5)
