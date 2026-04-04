# Answers: Lesson 39 — Message Formatting

## Exercise 1
**Question:** Name three fields that Claude Code's internal `AssistantMessage` type carries that the Anthropic API's message format does not accept. Why does the agent track these internally?

**Answer:** Three internal-only fields are: (1) `uuid` — a unique identifier for tracking and deduplication of messages, (2) `costUSD` — the dollar cost of that API call for real-time cost tracking, and (3) `durationMs` — how long the API call took for performance monitoring. The agent tracks these to provide session analytics (total cost, timing), enable message deduplication during normalization, and support debugging. These fields must be stripped before sending messages to the API, which would reject unknown fields.

---

## Exercise 2
**Challenge:** Write a `fixAlternation` function that ensures messages strictly alternate between `user` and `assistant` roles.

**Answer:**
```typescript
interface Message {
  role: string;
  content: any[];
}

function fixAlternation(messages: Message[]): Message[] {
  const result: Message[] = [];

  for (const message of messages) {
    const lastMessage = result[result.length - 1];

    if (lastMessage && lastMessage.role === message.role) {
      if (message.role === "user") {
        lastMessage.content = [...lastMessage.content, ...message.content];
      } else {
        result.push({
          role: "user",
          content: [{ type: "text", text: "[continued]" }],
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
**Explanation:** When two consecutive user messages appear, their content is merged into one message. When two consecutive assistant messages appear, a synthetic user message with `[continued]` is inserted between them. This ensures the API's strict alternation requirement is always satisfied.

---

## Exercise 3
**Challenge:** Write a function `findOrphanedToolUses(messages: any[]): string[]` that returns IDs of tool_use blocks without matching tool_result blocks.

**Answer:**
```typescript
function findOrphanedToolUses(messages: any[]): string[] {
  const orphanedIds: string[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;

    const toolUseBlocks = (msg.content || []).filter(
      (b: any) => b.type === "tool_use"
    );
    if (toolUseBlocks.length === 0) continue;

    const nextMsg = messages[i + 1];
    const existingResults = new Set<string>();

    if (nextMsg?.role === "user") {
      for (const block of nextMsg.content || []) {
        if (block.type === "tool_result") {
          existingResults.add(block.tool_use_id);
        }
      }
    }

    for (const toolUse of toolUseBlocks) {
      if (!existingResults.has(toolUse.id)) {
        orphanedIds.push(toolUse.id);
      }
    }
  }

  return orphanedIds;
}
```
**Explanation:** For each assistant message, we extract `tool_use` blocks and check if the following user message contains matching `tool_result` blocks (linked by ID). Any tool_use without a matching result is orphaned. These occur during error recovery, fallbacks, or aborted tool executions.

---

## Exercise 4
**Question:** Why does the message formatting pipeline use UUID v5 (hash-based) instead of UUID v4 (random) for split messages? What problem would random UUIDs cause if normalization runs multiple times?

**Answer:** UUID v5 is deterministic — given the same parent UUID and suffix, it always produces the same derived UUID. If the pipeline used random UUID v4, running normalization twice on the same messages would produce different UUIDs each time. This breaks message deduplication logic and could cause the system to treat the same synthetic split message as a different message on each pass. With UUID v5, re-running normalization is idempotent — the output is identical regardless of how many times it runs.

---

## Exercise 5
**Question:** List the three stages of the message formatting pipeline in order and describe what each stage does. Why is `ensureToolResultPairing()` called last?

**Answer:** The three stages are: (1) `normalizeMessages()` — filters out system messages, merges consecutive same-role messages, and inserts separator messages to maintain user/assistant alternation. (2) `normalizeMessagesForAPI()` — strips internal fields like `uuid`, `model`, `costUSD`, and `durationMs` that the API doesn't understand, converting to `Anthropic.MessageParam` format. (3) `ensureToolResultPairing()` — scans for orphaned `tool_use` blocks and injects synthetic error results. It's called last because it needs to operate on the final, API-formatted messages after all other transformations are complete — earlier stages might create or modify messages that affect which tool_uses are orphaned.
