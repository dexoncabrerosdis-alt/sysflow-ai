# Lesson 88: Max Output Token Recovery

## The Truncation Problem

Every API call to a language model has a `max_tokens` parameter that limits the response length. When the model's response reaches this limit, it gets cut off mid-sentence, mid-code-block, or mid-thought. The API signals this with `stop_reason: "max_tokens"` instead of the usual `stop_reason: "end_turn"`.

This is a problem for coding agents because truncated responses mean:
- Incomplete code that won't compile
- Half-written tool calls that can't be executed
- Cut-off explanations that leave the user confused
- Partial multi-step plans that lose critical later steps

Claude Code has a dedicated recovery system for this.

## Detecting Truncation

The model response includes a `stop_reason` that tells you why generation stopped:

```typescript
interface ModelResponse {
  content: ContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

function isResponseTruncated(response: ModelResponse): boolean {
  return response.stop_reason === "max_tokens";
}
```

## The Recovery Strategy

Claude Code uses a multi-attempt recovery strategy with escalating approaches:

```typescript
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

interface TokenRecoveryState {
  attempts: number;
  originalMaxTokens: number;
  escalatedMaxTokens: number;
}
```

### Attempt 1: Escalate the Token Limit

The first recovery strategy is simple: ask for more tokens.

```typescript
const DEFAULT_MAX_TOKENS = 4096;
const ESCALATED_MAX_TOKENS = 16384;

async function recoverFromTruncation(
  state: TokenRecoveryState,
  messages: Message[],
  config: ModelConfig
): Promise<RecoveryAction> {
  state.attempts++;

  if (state.attempts === 1) {
    // Strategy 1: Just give the model more room
    return {
      type: "escalate_tokens",
      maxTokens: ESCALATED_MAX_TOKENS,
      continueReason: "max_output_tokens_escalate",
    };
  }

  if (state.attempts <= MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    // Strategy 2+: Ask the model to continue
    return {
      type: "continue_generation",
      metaMessage: buildContinuationPrompt(messages),
      continueReason: "max_output_tokens_recovery",
    };
  }

  // All attempts exhausted
  return { type: "accept_truncated" };
}
```

Why does escalation work? Often the model's response is only slightly over the default limit. Bumping from 4096 to 16384 tokens gives it plenty of room to complete naturally.

### Attempt 2+: Continuation Prompts

If escalation wasn't enough, we ask the model to continue from where it left off:

```typescript
function buildContinuationPrompt(
  messages: Message[]
): string {
  return "Your previous response was cut off because it reached the " +
    "output token limit. Please continue exactly from where you left off. " +
    "Do not repeat any content you've already generated. " +
    "If you were in the middle of a code block, continue the code. " +
    "If you were in the middle of a tool call, complete the tool call.";
}
```

This continuation message is injected as a user message, and the model sees its own truncated response plus the instruction to continue:

```typescript
function buildContinuationMessages(
  originalMessages: Message[],
  truncatedResponse: ModelResponse,
  continuationPrompt: string
): Message[] {
  return [
    ...originalMessages,
    // The model's truncated response
    {
      role: "assistant",
      content: truncatedResponse.content,
    },
    // Our continuation instruction
    {
      role: "user",
      content: [{ type: "text", text: continuationPrompt }],
    },
  ];
}
```

## The Withheld Error Pattern

Here's a subtle design choice: when truncation is detected, the error is **withheld** rather than immediately reported. Why? Because the recovery might succeed, and the user doesn't need to know about an error that was seamlessly handled.

```typescript
interface WithheldError {
  type: "max_output_tokens";
  response: ModelResponse;
  withheldAt: number;
  resolved: boolean;
}

function isWithheldMaxOutputTokens(
  error: WithheldError
): boolean {
  return error.type === "max_output_tokens" && !error.resolved;
}

async function* handleTruncatedResponse(
  response: ModelResponse,
  messages: Message[],
  config: ModelConfig
): AsyncGenerator<Message> {
  const state: TokenRecoveryState = {
    attempts: 0,
    originalMaxTokens: config.maxTokens,
    escalatedMaxTokens: ESCALATED_MAX_TOKENS,
  };

  // Withhold the error — don't yield it to the UI yet
  const withheld: WithheldError = {
    type: "max_output_tokens",
    response,
    withheldAt: Date.now(),
    resolved: false,
  };

  let currentResponse = response;

  while (state.attempts < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    const recovery = await recoverFromTruncation(state, messages, config);

    if (recovery.type === "accept_truncated") break;

    try {
      if (recovery.type === "escalate_tokens") {
        // Retry the same request with more tokens
        currentResponse = await callModel({
          ...config,
          maxTokens: recovery.maxTokens,
        });
      } else {
        // Send continuation request
        const continuationMessages = buildContinuationMessages(
          messages,
          currentResponse,
          recovery.metaMessage
        );
        currentResponse = await callModel({
          ...config,
          messages: continuationMessages,
        });
      }

      // Check if the new response is also truncated
      if (!isResponseTruncated(currentResponse)) {
        withheld.resolved = true;
        yield* processResponse(currentResponse);
        return;
      }

      // Still truncated — loop continues
    } catch (error) {
      // Recovery failed — accept what we have
      break;
    }
  }

  // Recovery exhausted or failed — yield what we have
  if (!withheld.resolved) {
    yield {
      type: "system",
      message: "Response was truncated. Some content may be incomplete.",
    };
  }
  yield* processResponse(currentResponse);
}
```

## Continue Reasons

The recovery system tracks *why* the loop is continuing, which is useful for debugging and metrics:

```typescript
type ContinueReason =
  | "tool_use"                      // Normal: model wants to use a tool
  | "end_turn"                      // Normal: model finished
  | "max_output_tokens_escalate"    // Recovery: trying more tokens
  | "max_output_tokens_recovery"    // Recovery: continuation prompt
  | "context_overflow_compact"      // Recovery: compacting context
  | "user_interrupt";               // User interrupted

function logContinueReason(reason: ContinueReason): void {
  switch (reason) {
    case "max_output_tokens_escalate":
      console.log("Escalating max tokens due to truncation");
      break;
    case "max_output_tokens_recovery":
      console.log("Sending continuation prompt after truncation");
      break;
    default:
      break;
  }
}
```

## Stitching Responses Together

When the model continues from a truncated response, you need to stitch the pieces together:

```typescript
function stitchResponses(
  original: ModelResponse,
  continuation: ModelResponse
): ModelResponse {
  // Merge content blocks
  const lastOriginalBlock = original.content[original.content.length - 1];
  const firstContinuationBlock = continuation.content[0];

  let mergedContent: ContentBlock[];

  if (
    lastOriginalBlock.type === "text" &&
    firstContinuationBlock.type === "text"
  ) {
    // Merge text blocks — the truncation cut mid-text
    mergedContent = [
      ...original.content.slice(0, -1),
      {
        type: "text" as const,
        text: lastOriginalBlock.text + firstContinuationBlock.text,
      },
      ...continuation.content.slice(1),
    ];
  } else {
    // Different block types — just concatenate
    mergedContent = [...original.content, ...continuation.content];
  }

  return {
    content: mergedContent,
    stop_reason: continuation.stop_reason,
    usage: {
      input_tokens: original.usage.input_tokens + continuation.usage.input_tokens,
      output_tokens: original.usage.output_tokens + continuation.usage.output_tokens,
    },
  };
}
```

## Truncated Tool Calls

The trickiest truncation case is when the response is cut off mid-tool-call:

```typescript
// The model was generating this tool call:
{
  type: "tool_use",
  id: "toolu_abc123",
  name: "write_file",
  input: {
    path: "src/utils/helper.ts",
    content: "export function helper() {\n  const data = fetch..." 
    // TRUNCATED HERE — content is incomplete
  }
}
```

The incomplete JSON can't be parsed, and even if it could, the file content is partial. The continuation prompt needs to handle this:

```typescript
function buildToolCallContinuationPrompt(): string {
  return "Your previous response was cut off while generating a tool call. " +
    "Please generate the complete tool call from the beginning. " +
    "Do not try to continue the partial tool call — regenerate it entirely.";
}
```

Alternatively, the system can detect the incomplete tool call and ask the model to regenerate just that part:

```typescript
function detectIncompleteTool(response: ModelResponse): ToolUseBlock | null {
  if (response.stop_reason !== "max_tokens") return null;

  const lastBlock = response.content[response.content.length - 1];
  if (lastBlock.type === "tool_use") {
    // The last block being a tool_use with max_tokens stop_reason
    // means it might be incomplete
    try {
      // Try to validate the input JSON
      JSON.stringify(lastBlock.input);
      return null; // Valid JSON — probably complete
    } catch {
      return lastBlock; // Invalid JSON — definitely incomplete
    }
  }
  return null;
}
```

## Summary

Max output token recovery handles a common but tricky failure mode: the model running out of generation space. The three-attempt strategy (escalate tokens, then continuation prompts) recovers gracefully in most cases. The withheld error pattern avoids alarming users about errors that get resolved automatically. Response stitching maintains continuity when multiple generation calls are needed. And special handling for truncated tool calls prevents the agent from executing partial operations.

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Full Truncation Recovery
**Challenge:** Implement `handleTruncatedResponse` as an async generator that first tries token escalation (4096 → 16384), then up to 2 continuation prompts. Yield status messages to the UI. Test with mock responses that truncate mid-text, mid-code-block, and mid-tool-call.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-88.md#exercise-1)

### Exercise 2 — Response Stitching
**Challenge:** Write a `stitchResponses` function that merges an original response with a continuation. Handle all four combinations: text+text (merge strings), text+tool_use (concatenate blocks), tool_use+text (concatenate blocks), and chain multiple continuations together.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-88.md#exercise-2)

### Exercise 3 — Incomplete Tool Call Detection
**Challenge:** Implement `detectAndRecoverIncompleteTool()` that examines a truncated response, determines if the last block is an incomplete tool_use with invalid JSON, and builds the appropriate continuation prompt (either "continue the tool call" or "regenerate the tool call entirely").

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-88.md#exercise-3)

### Exercise 4 — The Withheld Error Pattern
**Question:** Explain in 3-4 sentences why truncation errors are "withheld" rather than immediately shown to the user. What would the user experience look like if every truncation was immediately surfaced as an error message?

[View Answer](../../answers/10-error-handling/answer-88.md#exercise-4)

### Exercise 5 — Truncation Metrics
**Challenge:** Implement a `TruncationTracker` class that records: how often truncation occurs, which recovery strategy (escalation vs continuation) succeeded, how many tokens were wasted on failed recovery attempts, and the truncation-to-recovery success ratio. Include a `shouldIncreaseDefaultMaxTokens()` method that recommends a higher default when truncation rate exceeds 20%.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-88.md#exercise-5)
