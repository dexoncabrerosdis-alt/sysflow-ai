# Answers: Lesson 44 — Fallback Models

## Exercise 1
**Question:** List the five steps of the fallback recovery process in order. For each step, explain what would go wrong if it were skipped.

**Answer:** (1) **Determine the fallback model** — Without this, the system has no model to switch to and the error becomes fatal. (2) **Tombstone partial messages** — Without tombstoning, the fallback model has no context about what the previous model was attempting, leading to duplicated or contradictory work. (3) **Inject synthetic tool results** — Without these, orphaned `tool_use` blocks lack matching `tool_result` blocks, and the API will reject the next request with a 400 error. (4) **Discard the streaming executor** — Without discarding, the old executor continues trying to process events from a dead stream, causing errors or zombie state. (5) **Create a new executor and warn the user** — Without a new executor, there's nothing to process the fallback model's stream. Without the warning, the user doesn't know why the model changed, which erodes trust.

---

## Exercise 2
**Challenge:** Write a `getFallbackModel` function with a configuration map.

**Answer:**
```typescript
interface FallbackConfig {
  fallback: string;
  enabled: boolean;
}

const FALLBACK_MAP: Record<string, FallbackConfig> = {
  "claude-opus-4-20250514": {
    fallback: "claude-sonnet-4-20250514",
    enabled: true,
  },
  "claude-sonnet-4-20250514": {
    fallback: "claude-sonnet-4-20250514",
    enabled: true,
  },
  "claude-haiku-3-20250307": {
    fallback: "",
    enabled: false,
  },
};

function getFallbackModel(primary: string): string | null {
  const config = FALLBACK_MAP[primary];
  if (!config || !config.enabled) return null;
  return config.fallback;
}
```
**Explanation:** Opus falls back to Sonnet (less expensive, usually available). Sonnet falls back to Sonnet (same model family but potentially different server-side routing). Haiku has no fallback because it's already the cheapest model — there's nothing to fall back to. The `enabled` flag allows disabling fallback per model without removing the config.

---

## Exercise 3
**Challenge:** Write a function that creates a tombstoned assistant message from a partial response.

**Answer:**
```typescript
interface AssistantMessage {
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  model: string;
  costUSD: number;
  durationMs: number;
  usage: { input_tokens: number; output_tokens: number };
}

function tombstonePartialMessage(
  partialText: string,
  failedModel: string
): AssistantMessage {
  const tombstoneNote =
    "\n\n[Response interrupted due to model unavailability]";

  return {
    role: "assistant",
    content: [
      {
        type: "text",
        text: partialText + tombstoneNote,
      },
    ],
    model: failedModel,
    costUSD: 0,
    durationMs: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}
```
**Explanation:** The tombstone preserves whatever text the model had generated before the stream died, appending a note explaining the interruption. Cost and usage are zeroed because the interrupted call didn't complete. The fallback model will see this tombstoned message in the conversation history and can pick up where the previous model left off.

---

## Exercise 4
**Question:** What prevents infinite fallback chains? Describe the mechanism and explain why `MAX_FALLBACK_DEPTH` of 1 is correct.

**Answer:** A `MAX_FALLBACK_DEPTH` counter (default 1) prevents infinite chains. When a fallback is triggered, the depth counter increments. If the fallback model also triggers a fallback and the depth has reached the max, the system throws a fatal error instead of switching again. A depth of 1 is correct because: (1) if both the primary and fallback models are overloaded, a third model is unlikely to succeed either — it's probably a systemic issue. (2) Each fallback adds latency (tombstoning, synthetic results, new executor). (3) Multiple fallbacks create confusing conversation histories with multiple tombstones. It's better to surface the error clearly than to keep trying models that are all likely affected by the same outage.

---

## Exercise 5
**Challenge:** Write a function that generates a user message containing error tool_result blocks for orphaned tool calls.

**Answer:**
```typescript
interface UserMessage {
  role: "user";
  content: Array<{
    type: "tool_result";
    tool_use_id: string;
    content: string;
    is_error: boolean;
  }>;
}

function createSyntheticResults(toolUseIds: string[]): UserMessage {
  return {
    role: "user",
    content: toolUseIds.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content:
        "Tool execution was interrupted due to model fallback. " +
        "The previous model became unavailable. Please retry this operation.",
      is_error: true,
    })),
  };
}
```
**Explanation:** Each orphaned `tool_use` ID gets a `tool_result` block marked with `is_error: true`. The error message explains why the tool wasn't executed, giving the fallback model context to decide whether to retry the tool call or take a different approach. All results go in a single user message to maintain the alternation pattern.
