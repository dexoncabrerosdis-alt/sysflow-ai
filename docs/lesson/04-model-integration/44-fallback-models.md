# Lesson 44: Fallback Models

## What You'll Learn

In the previous lessons, you saw that 3 consecutive 529 errors trigger a
`FallbackTriggeredError`. But switching models mid-conversation isn't as simple as
changing a string. There's orphaned state to clean up, messages to patch, and
executors to rebuild. In this lesson, you'll study the fallback machinery.

## When Fallback Triggers

The chain of events:

```
API call → 529 Overloaded (consecutive: 1)
    ↓
retry with backoff
    ↓
API call → 529 Overloaded (consecutive: 2)
    ↓
retry with backoff
    ↓
API call → 529 Overloaded (consecutive: 3)
    ↓
throw FallbackTriggeredError("claude-sonnet-4-20250514", 3)
    ↓
caught by query layer → initiate fallback
```

The `withRetry` generator throws `FallbackTriggeredError`. The query layer —
the code that orchestrates the full API call lifecycle — catches it and starts
the fallback process.

## The Fallback Model Configuration

Each primary model has a designated fallback:

```typescript
interface FallbackConfig {
  primary: string;
  fallback: string;
  conditions: {
    maxConsecutive529: number;
    enabled: boolean;
  };
}

const FALLBACK_MAP: Record<string, FallbackConfig> = {
  "claude-sonnet-4-20250514": {
    primary: "claude-sonnet-4-20250514",
    fallback: "claude-sonnet-4-20250514", // Same family, different routing
    conditions: {
      maxConsecutive529: 3,
      enabled: true,
    },
  },
  "claude-opus-4-20250514": {
    primary: "claude-opus-4-20250514",
    fallback: "claude-sonnet-4-20250514",
    conditions: {
      maxConsecutive529: 3,
      enabled: true,
    },
  },
};

function getFallbackModel(primaryModel: string): string | null {
  const config = FALLBACK_MAP[primaryModel];
  if (!config || !config.conditions.enabled) return null;
  return config.fallback;
}
```

The fallback is typically a model from the same family or a less-loaded variant.
The exact routing may differ on the server side even if the model name looks
similar.

## The Fallback Process: Step by Step

When `FallbackTriggeredError` is caught, the query layer executes a multi-step
recovery process. Here's the real flow:

### Step 1: Determine the Fallback Model

```typescript
async function handleFallback(
  error: FallbackTriggeredError,
  context: QueryContext
): Promise<void> {
  const fallbackModel = getFallbackModel(error.failedModel);

  if (!fallbackModel) {
    throw new CannotRetryError(
      `No fallback available for ${error.failedModel}`,
      error
    );
  }

  context.currentModel = fallbackModel;
```

If no fallback is configured, the error becomes fatal.

### Step 2: Tombstone Orphaned Messages

When the stream fails mid-generation, there may be a partial assistant message —
some text was generated, maybe a tool_use block started, but nothing completed
cleanly. This partial message becomes a "tombstone":

```typescript
  if (context.partialAssistantMessage) {
    const tombstone: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: context.partialAssistantMessage.text +
            "\n\n[Response interrupted due to model unavailability]",
        },
      ],
      uuid: context.partialAssistantMessage.uuid,
      model: error.failedModel,
      costUSD: 0,
      durationMs: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    };

    context.messages.push(tombstone);
  }
```

The tombstone preserves any text the model had generated. It becomes part of the
conversation history so the fallback model has context about what was attempted.

### Step 3: Yield Missing Tool Results

If the failed response contained `tool_use` blocks that never got results (because
the stream died before tools could execute), you need synthetic results:

```typescript
  const orphanedToolUses = findOrphanedToolUses(context.messages);

  if (orphanedToolUses.length > 0) {
    const syntheticResults: ContentBlockParam[] = orphanedToolUses.map(
      (toolUse) => ({
        type: "tool_result" as const,
        tool_use_id: toolUse.id,
        content: "Tool execution was interrupted due to model fallback. " +
                 "The previous model became unavailable. Please retry this operation.",
        is_error: true,
      })
    );

    context.messages.push({
      role: "user",
      content: syntheticResults,
      uuid: crypto.randomUUID(),
    });
  }
```

These synthetic error results tell the fallback model what happened. The new model
can then decide to retry the tools or take a different approach.

### Step 4: Discard the Streaming Executor

The streaming executor from Module 03 is tied to the current API call. It's
processing events from a stream that no longer exists:

```typescript
  if (context.streamingExecutor) {
    context.streamingExecutor.abort();
    context.streamingExecutor = null;
  }
```

The old executor is aborted and discarded. A new one will be created when the
fallback model's response starts streaming.

### Step 5: Create a New Executor

```typescript
  context.streamingExecutor = new StreamingExecutor({
    tools: context.tools,
    signal: context.signal,
  });
```

The new executor is fresh — no residual state from the failed attempt.

### Step 6: Log and Warn

```typescript
  yield {
    type: "system",
    level: "warning",
    message: `Switched from ${error.failedModel} to ${fallbackModel} due to model overload.`,
    uuid: crypto.randomUUID(),
  };

  console.error(
    `[fallback] ${error.failedModel} → ${fallbackModel} after ${error.consecutiveOverloads} consecutive 529s`
  );
}
```

The user sees a warning. The logs record the event for debugging.

## The Complete Fallback Handler

Here's the full handler in context of the query function:

```typescript
async function* queryWithFallback(
  context: QueryContext
): AsyncGenerator<StreamMessage> {
  try {
    yield* queryModelWithStreaming(
      context.messages,
      context.systemPrompt,
      context.tools,
      context.currentModel,
      context.maxTokens,
      { signal: context.signal }
    );
  } catch (error) {
    if (error instanceof FallbackTriggeredError) {
      yield* handleFallback(error, context);

      // Retry with the fallback model
      yield* queryModelWithStreaming(
        context.messages,
        context.systemPrompt,
        context.tools,
        context.currentModel,  // Now set to fallback
        context.maxTokens,
        { signal: context.signal }
      );
    } else {
      throw error;
    }
  }
}
```

The `yield*` delegation means the caller sees a seamless stream — some messages
from the primary model, a system warning, then messages from the fallback model.

## Mid-Stream Fallback: The Hard Case

The trickiest scenario is when the fallback triggers mid-stream — the model has
already generated text and possibly started a tool call. Here's what the message
history looks like:

```
Before fallback:
  User: "Refactor the auth module"
  Assistant (partial): "I'll start by reading the current auth..."
  [STREAM DIES - 3x 529]

After fallback recovery:
  User: "Refactor the auth module"
  Assistant (tombstoned): "I'll start by reading the current auth...
    [Response interrupted due to model unavailability]"
  User (synthetic): [tool_result errors for any orphaned tool_uses]
  --- NEW API CALL with fallback model ---
  Assistant (fallback): "I'll continue with the refactoring..."
```

The fallback model sees the interrupted attempt and can pick up where the primary
model left off.

## Preventing Fallback Loops

What if the fallback model is also overloaded? A `MAX_FALLBACK_DEPTH` of 1
prevents infinite chains — try the primary, try one fallback, then surface the
error to the user.

## Recovering After Fallback

Fallback is per-call, not per-session. The next iteration of the agent loop
re-evaluates `getMainLoopModel()`, which resolves the primary model again. If
the primary has recovered, the next call goes back to it automatically.

## Key Takeaways

1. Fallback triggers after 3 consecutive 529 errors (configurable)
2. Each primary model has a designated fallback model
3. The recovery process: tombstone partial messages → inject synthetic tool_results → discard executor → create new executor → warn user
4. Mid-stream fallbacks preserve partial text as tombstones for context
5. Fallback depth is limited (default 1) to prevent infinite chains
6. Fallback is per-call — the next iteration tries the primary model again

## Next Lesson

You've seen how the system handles failures. But even successful calls cost money.
Every API request is billed by input and output tokens, and a busy coding agent can
run up significant costs. Next, you'll learn how Claude Code tracks and displays
costs in real time.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Five Steps of Fallback Recovery
**Question:** List the five steps of the fallback recovery process in order. For each step, explain what would go wrong if it were skipped.

[View Answer](../../answers/04-model-integration/answer-44.md#exercise-1)

### Exercise 2 — Fallback Config Map
**Challenge:** Write a `getFallbackModel(primary: string): string | null` function with a configuration map. Map Opus → Sonnet, Sonnet → Sonnet (same family, different routing), Haiku → null (no fallback). Include an `enabled` flag per entry.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-44.md#exercise-2)

### Exercise 3 — Tombstone a Partial Message
**Challenge:** Write a function `tombstonePartialMessage(partialText: string, failedModel: string): AssistantMessage` that creates a tombstoned assistant message from a partial response that was interrupted by a fallback trigger.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-44.md#exercise-3)

### Exercise 4 — Preventing Fallback Loops
**Question:** What prevents infinite fallback chains (Model A falls back to Model B, which falls back to Model A)? Describe the mechanism and explain why a `MAX_FALLBACK_DEPTH` of 1 is the right default.

[View Answer](../../answers/04-model-integration/answer-44.md#exercise-4)

### Exercise 5 — Inject Synthetic Tool Results
**Challenge:** Given an array of orphaned tool_use IDs, write a function `createSyntheticResults(toolUseIds: string[]): UserMessage` that generates a user message containing error `tool_result` blocks for each orphaned tool call.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-44.md#exercise-5)
