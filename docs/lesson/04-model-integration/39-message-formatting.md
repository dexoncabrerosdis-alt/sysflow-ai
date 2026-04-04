# Lesson 39: Message Formatting

## What You'll Learn

The Anthropic API expects messages in a rigid format — alternating `user` and
`assistant` roles, specific content block types, and tool_result blocks that pair
with tool_use blocks. Internally, an agent tracks much richer state. This lesson
covers the message formatting pipeline that bridges the gap.

## Internal vs. API Message Types

Claude Code defines its own message types that carry more information than the
API's format:

```typescript
interface UserMessage {
  role: "user";
  content: ContentBlockParam[];
  uuid: string;
}

interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  uuid: string;
  model: string;
  costUSD: number;
  durationMs: number;
  usage: TokenUsage;
}

interface SystemMessage {
  type: "system";
  content: string;
  uuid: string;
  level: "info" | "warning" | "error";
}
```

Each message has a UUID for tracking. Assistant messages carry metadata about cost,
model, and timing. System messages are internal-only — they never go to the API.
They're used for things like retry notifications or permission prompts.

## Content Block Types

The `content` field in messages isn't a string — it's an array of typed blocks.
Here are the types you'll encounter:

```typescript
type ContentBlockParam =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlockParam[] }
  | { type: "image"; source: ImageSource };

type ImageSource = {
  type: "base64";
  media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
};
```

A single message can contain multiple blocks. For example, an assistant message
might contain a text block followed by two tool_use blocks — the model explains
what it's about to do, then calls two tools in parallel.

## The Problem: Multi-Block Messages

Here's a real scenario that creates formatting issues. The model generates:

```typescript
const assistantMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "I'll read both files." },
    { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/a.ts" } },
    { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/b.ts" } },
  ],
};
```

You execute both tools and get results. But you need to send the results in a
single user message, and both must reference the correct tool_use_id:

```typescript
const userMessage = {
  role: "user",
  content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "file A contents" },
    { type: "tool_result", tool_use_id: "toolu_2", content: "file B contents" },
  ],
};
```

The API enforces strict ordering: messages must alternate user/assistant, and every
tool_use must have a tool_result in the immediately following user message.

## `normalizeMessages()`: Splitting Multi-Block Messages

Some internal operations can create messages that don't follow the alternation
rule. `normalizeMessages` fixes this by splitting and reordering:

```typescript
function normalizeMessages(messages: Message[]): Message[] {
  const result: Message[] = [];

  for (const message of messages) {
    if (message.type === "system") {
      continue;
    }

    const lastMessage = result[result.length - 1];

    if (lastMessage && lastMessage.role === message.role) {
      if (message.role === "user") {
        lastMessage.content = [...lastMessage.content, ...message.content];
      } else {
        result.push({
          role: "user",
          content: [{ type: "text", text: "[continued]" }],
          uuid: deriveUUID(message.uuid, "split-separator"),
        });
        result.push(message);
      }
    } else {
      result.push(message);
    }
  }

  return result;
}
```

When two consecutive assistant messages appear (which can happen after a fallback
or error recovery), a synthetic user message is inserted between them to maintain
alternation.

## `deriveUUID()`: Stable UUIDs for Split Messages

When splitting a message, you need new UUIDs for the synthetic pieces. But they
should be deterministic — the same input always produces the same UUID. This
prevents issues with message deduplication:

```typescript
import { v5 as uuidv5 } from "uuid";

const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function deriveUUID(parentUUID: string, suffix: string): string {
  return uuidv5(`${parentUUID}:${suffix}`, NAMESPACE);
}
```

UUID v5 is a hash-based UUID. Given the same parent UUID and suffix, it always
produces the same derived UUID. This means re-running normalization on the same
messages produces identical results.

## `normalizeMessagesForAPI()`: Final API Preparation

This is the last step before messages hit the API. It runs `normalizeMessages()`,
filters to only `user` and `assistant` roles, then maps each content block to its
API-compatible form — stripping internal fields like `uuid`, `model`, `costUSD`,
and `durationMs` that the API doesn't understand.

## `ensureToolResultPairing()`: The Safety Net

The API will reject your request if any `tool_use` block lacks a corresponding
`tool_result`. This can happen during error recovery, fallbacks, or aborted tool
executions. `ensureToolResultPairing` scans for orphaned tool_use blocks and
injects synthetic results:

```typescript
function ensureToolResultPairing(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  const result = [...messages];

  for (let i = 0; i < result.length; i++) {
    const message = result[i];
    if (message.role !== "assistant") continue;

    const toolUseBlocks = (message.content as Anthropic.ContentBlock[])
      .filter((b) => b.type === "tool_use");

    if (toolUseBlocks.length === 0) continue;

    const nextMessage = result[i + 1];
    const existingResults = new Set<string>();

    if (nextMessage?.role === "user") {
      for (const block of nextMessage.content as Anthropic.ContentBlockParam[]) {
        if (block.type === "tool_result") {
          existingResults.add(block.tool_use_id);
        }
      }
    }

    const missingResults = toolUseBlocks
      .filter((b) => !existingResults.has(b.id))
      .map((b) => ({
        type: "tool_result" as const,
        tool_use_id: b.id,
        content: "Tool execution was interrupted.",
        is_error: true,
      }));

    if (missingResults.length === 0) continue;

    if (nextMessage?.role === "user") {
      nextMessage.content = [
        ...(nextMessage.content as Anthropic.ContentBlockParam[]),
        ...missingResults,
      ];
    } else {
      result.splice(i + 1, 0, {
        role: "user",
        content: missingResults,
      });
    }
  }

  return result;
}
```

This is a safety net. In the happy path, every tool_use already has a result. But
agents operate in messy conditions — network failures, user aborts, fallback
triggers — and this function ensures the API never rejects you for missing pairs.

## The Complete Formatting Pipeline

Messages flow through these stages before reaching the API:

```
Internal Messages (UserMessage, AssistantMessage, SystemMessage)
    │
    ▼
normalizeMessages()
    │  - Filter out SystemMessages
    │  - Merge consecutive same-role messages
    │  - Insert separator messages for alternation
    │  - Generate stable UUIDs for splits
    │
    ▼
normalizeMessagesForAPI()
    │  - Strip internal fields (uuid, model, cost, etc.)
    │  - Convert to Anthropic.MessageParam format
    │
    ▼
ensureToolResultPairing()
    │  - Find orphaned tool_use blocks
    │  - Inject synthetic error results
    │
    ▼
API-ready messages → anthropic.messages.create()
```

## Why This Matters

Without this pipeline, you'd hit API errors constantly:

- Two consecutive assistant messages → `400 Bad Request`
- Missing tool_result → `400 Bad Request`
- Internal fields in content blocks → `400 Bad Request`

The formatting pipeline absorbs all the edge cases so the rest of the codebase
can work with rich, convenient message types without worrying about API
compatibility.

## Key Takeaways

1. Internal messages carry richer metadata (UUID, cost, model, timing) than API messages
2. Content is an array of typed blocks: text, tool_use, tool_result, image
3. `normalizeMessages()` ensures proper user/assistant alternation
4. `deriveUUID()` generates stable, deterministic UUIDs for split messages
5. `normalizeMessagesForAPI()` strips internal fields for API compliance
6. `ensureToolResultPairing()` injects synthetic results for orphaned tool_use blocks

## Next Lesson

Now that messages are formatted, you need to know if they'll fit. The API has token
limits, and exceeding them is an expensive error. Next, you'll learn how Claude Code
counts tokens without making API calls.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Internal vs. API Messages
**Question:** Name three fields that Claude Code's internal `AssistantMessage` type carries that the Anthropic API's message format does not accept. Why does the agent track these internally?

[View Answer](../../answers/04-model-integration/answer-39.md#exercise-1)

### Exercise 2 — Message Alternation Fix
**Challenge:** Write a `fixAlternation(messages: Array<{role: string, content: any[]}>): Array<{role: string, content: any[]}>` function that ensures messages strictly alternate between `user` and `assistant` roles. When two consecutive assistant messages appear, insert a synthetic user message with `[{ type: "text", text: "[continued]" }]` between them.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-39.md#exercise-2)

### Exercise 3 — Orphaned Tool Use Detection
**Challenge:** Write a function `findOrphanedToolUses(messages: any[]): string[]` that scans a message array and returns the IDs of any `tool_use` blocks in assistant messages that don't have corresponding `tool_result` blocks in the following user message.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-39.md#exercise-3)

### Exercise 4 — Why deriveUUID Uses v5
**Question:** Why does the message formatting pipeline use UUID v5 (hash-based) instead of UUID v4 (random) for split messages? What problem would random UUIDs cause if normalization runs multiple times on the same messages?

[View Answer](../../answers/04-model-integration/answer-39.md#exercise-4)

### Exercise 5 — The Complete Pipeline
**Question:** List the three stages of the message formatting pipeline in order and describe what each stage does. Why is `ensureToolResultPairing()` called last?

[View Answer](../../answers/04-model-integration/answer-39.md#exercise-5)
