# Lesson 40: Token Counting

## What You'll Learn

Every LLM has a context window — a maximum number of tokens it can process in a
single request. Exceed it and the API rejects your call. Stay well under it and
you're leaving capability on the table. In this lesson, you'll learn what tokens
are, why counting them is harder than it sounds, and how Claude Code estimates
counts without expensive API calls.

## What Are Tokens?

Tokens are the atomic units that language models process. They're not characters,
not words, not bytes — they're chunks that the model's tokenizer splits text into.

Some examples:

| Text | Tokens | Count |
|---|---|---|
| `hello` | `["hello"]` | 1 |
| `Hello, world!` | `["Hello", ",", " world", "!"]` | 4 |
| `function fibonacci(n)` | `["function", " fib", "onacci", "(", "n", ")"]` | 6 |
| `const x = 42;` | `["const", " x", " =", " ", "42", ";"]` | 6 |

The exact tokenization depends on the model's vocabulary. Different models use
different tokenizers, so the same text produces different token counts.

## Why Token Counting Matters

Token counts drive three critical decisions in a coding agent:

### 1. Context Window Limits
Each model has a maximum context size:

```typescript
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-20250514": 200_000,
  "claude-opus-4-20250514": 200_000,
  "claude-haiku-3-20250307": 200_000,
};
```

If `input_tokens + max_tokens > context_window`, the API returns an error.

### 2. Compaction Triggers
When the conversation grows too long, the agent needs to summarize older messages
to free up space. This is called compaction (covered in a later module). The
trigger is based on token count:

```typescript
const COMPACTION_THRESHOLD = 0.80;

function shouldCompact(estimatedTokens: number, contextWindow: number): boolean {
  return estimatedTokens > contextWindow * COMPACTION_THRESHOLD;
}
```

### 3. Cost Estimation
You're billed per token. Knowing the approximate input size helps predict cost
before making the call.

## The Exact Counting Problem

The "correct" way to count tokens is to use the model's actual tokenizer. The API
provides a `count_tokens` endpoint:

```typescript
const count = await anthropic.messages.countTokens({
  model: "claude-sonnet-4-20250514",
  messages: [{ role: "user", content: "Hello world" }],
  system: "You are a helpful assistant.",
});

console.log(count.input_tokens); // exact count
```

The problem: this is an API call. It has latency (100-500ms), it costs money, and
you'd need to make it before every real API call. For a fast-moving agent loop
that makes dozens of calls per session, this is unacceptable.

## The Estimation Approach

Claude Code uses a fast heuristic instead: **approximately 4 characters per token**.

```typescript
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
```

This is intentionally rough. Here's why it works well enough:

- English text averages 4-5 characters per token
- Code tends to be slightly more token-dense (3-4 characters per token)
- JSON and structured data run about 3-4 characters per token
- The estimate is used for thresholds and warnings, not exact billing

Being off by 20% is fine when you're comparing against a 200,000 token window.

## `tokenCountWithEstimation()`: The Real Implementation

The actual implementation handles the full message structure, not just raw text:

```typescript
function tokenCountWithEstimation(
  messages: Message[],
  systemPrompt: string,
  tools: Tool[]
): number {
  let totalChars = 0;

  totalChars += systemPrompt.length;

  for (const message of messages) {
    totalChars += estimateMessageChars(message);
  }

  totalChars += estimateToolsChars(tools);

  totalChars += messages.length * 4;

  return Math.ceil(totalChars / 4);
}

function estimateMessageChars(message: Message): number {
  let chars = 0;

  for (const block of message.content) {
    switch (block.type) {
      case "text":
        chars += block.text.length;
        break;

      case "tool_use":
        chars += block.name.length;
        chars += JSON.stringify(block.input).length;
        break;

      case "tool_result":
        if (typeof block.content === "string") {
          chars += block.content.length;
        } else {
          chars += JSON.stringify(block.content).length;
        }
        break;

      case "image":
        chars += estimateImageTokens(block.source) * 4;
        break;
    }
  }

  return chars;
}
```

Note the `messages.length * 4` line — each message has overhead tokens for role
markers and formatting that the model's tokenizer adds. The estimate accounts for
this with a flat per-message cost.

## Estimating Tool Definitions

Tool definitions count against your input tokens too. Each tool's JSON schema
adds to the context:

```typescript
function estimateToolsChars(tools: Tool[]): number {
  if (tools.length === 0) return 0;

  let chars = 0;
  for (const tool of tools) {
    chars += tool.name.length;
    chars += (tool.description ?? "").length;
    chars += JSON.stringify(tool.input_schema).length;
  }
  return chars;
}
```

With 20+ tools (which Claude Code registers), tool definitions alone can consume
5,000-10,000 tokens. This is why tool partitioning (Module 03) matters — sending
fewer tools saves tokens.

## Image Token Estimation

Images use a separate estimation model. The token count depends on image
dimensions:

```typescript
function estimateImageTokens(source: ImageSource): number {
  // Images are resized to fit within 1568x1568 before processing.
  // Token cost depends on the number of 32x32 tiles.
  // Rough estimate: a typical screenshot is ~1,600 tokens.
  return 1_600;
}
```

In practice, Claude Code uses a conservative flat estimate for images rather than
decoding the base64 to measure dimensions.

## The Effective Context Window

The usable context window is smaller than the model's stated maximum. You need
room for the model's response:

```typescript
function getEffectiveContextWindow(
  model: string,
  maxOutputTokens: number
): number {
  const contextWindow = MODEL_CONTEXT_WINDOWS[model] ?? 200_000;
  return contextWindow - maxOutputTokens;
}
```

If the model has a 200,000 token window and you set `max_tokens: 16384`, your
input budget is 183,616 tokens.

## Decision Points Based on Token Count

Claude Code uses token estimates at multiple decision points:

```typescript
function getTokenAction(
  estimatedTokens: number,
  contextWindow: number
): "ok" | "warn" | "compact" | "block" {
  const ratio = estimatedTokens / contextWindow;

  if (ratio < 0.60) {
    return "ok";
  }
  if (ratio < 0.80) {
    return "warn";
  }
  if (ratio < 0.95) {
    return "compact";
  }
  return "block";
}
```

| Ratio | Action | What Happens |
|---|---|---|
| < 60% | OK | Proceed normally |
| 60-80% | Warn | Show context usage warning |
| 80-95% | Compact | Trigger conversation summarization |
| > 95% | Block | Refuse to call API (would fail anyway) |

These thresholds are conservative. It's better to compact slightly early than to
hit a `400` error from exceeding the context window.

## Caching and Token Economics

The Anthropic API supports prompt caching. When the system prompt and tool
definitions haven't changed between calls (common in an agent loop), they can be
served from cache at ~10x lower cost. The token *count* is the same, but the
*cost* is dramatically lower. This is why the cost tracker (Lesson 45) tracks
cache creation and cache read tokens separately.

## Putting It Together

Token counting happens **before** every API call. It's the gatekeeper: estimate
tokens → check ratio against context window → decide whether to proceed, warn,
compact, or block. This keeps the agent within its limits without requiring an
expensive tokenizer API call.

## Key Takeaways

1. Tokens are the atomic units LLMs process — roughly 4 characters each for English/code
2. Exact counting requires an API call, so agents use estimation instead
3. Tool definitions consume significant tokens — 20 tools can use 5,000-10,000 tokens
4. The effective context window is the model maximum minus `max_tokens`
5. Token estimates drive compaction, warnings, and blocking decisions
6. Being roughly right is more valuable than being exactly right slowly

## Next Lesson

You know how to count tokens and build messages. But which model should you send
them to? Next, you'll learn how Claude Code selects between models — user
overrides, tier-based defaults, and mid-conversation model switching.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Why Estimate Instead of Count?
**Question:** The Anthropic API provides an exact `count_tokens` endpoint. Why does Claude Code use a rough "4 characters per token" heuristic instead? Under what circumstances would exact counting be worth the tradeoff?

[View Answer](../../answers/04-model-integration/answer-40.md#exercise-1)

### Exercise 2 — Token Action Thresholds
**Challenge:** Write a function `getTokenAction(estimatedTokens: number, contextWindow: number): "ok" | "warn" | "compact" | "block"` that implements the four-tier decision system: <60% → ok, 60-80% → warn, 80-95% → compact, >95% → block.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-40.md#exercise-2)

### Exercise 3 — Message Token Estimation
**Challenge:** Write a `estimateMessageTokens(message: {content: Array<{type: string, text?: string, name?: string, input?: unknown, content?: string}>}): number` function that estimates tokens for a single message by iterating through its content blocks and handling `text`, `tool_use`, and `tool_result` block types.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-40.md#exercise-3)

### Exercise 4 — Effective Context Window
**Question:** If a model has a 200,000 token context window and you set `max_tokens` to 16,384, what is the effective input budget? Why must you subtract `max_tokens` from the context window rather than just using the full window?

[View Answer](../../answers/04-model-integration/answer-40.md#exercise-4)

### Exercise 5 — Tool Definition Cost
**Challenge:** Write a function `estimateToolsTokens(tools: Array<{name: string, description: string, input_schema: object}>): number` that estimates how many tokens all tool definitions consume. Test it with a mock list of 5 tools and log the result.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-40.md#exercise-5)
