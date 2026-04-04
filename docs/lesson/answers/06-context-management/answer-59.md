# Answers: Lesson 59 — Microcompact

## Exercise 1
**Question:** Why are user messages and assistant text responses NOT compactable?

**Answer:** First, user messages contain the task instructions and clarifications that drive the entire conversation. If a user said "don't modify the database schema," clearing that message would cause the agent to lose a critical constraint. Second, assistant text responses contain reasoning and decisions that provide continuity — for example, "I chose JWT over sessions because..." informs future decisions. Clearing these would cause the model to lose the rationale behind its approach and potentially reverse decisions or repeat abandoned approaches.

---

## Exercise 2
**Challenge:** Write a simplified `microCompact` function.

**Answer:**

```typescript
const COMPACTABLE_TOOLS = new Set([
  "Read", "Grep", "Glob", "Edit", "Write", "Shell", "WebFetch",
]);

const CLEARED_MARKER = "[Old tool result content cleared]";

interface Message {
  role: string;
  toolName?: string;
  content: string;
  timestamp: number;
}

function microCompact(messages: Message[], maxAgeMs: number): Message[] {
  const now = Date.now();
  const compacted = structuredClone(messages);

  for (const message of compacted) {
    if (message.role !== "tool") continue;
    if (!message.toolName || !COMPACTABLE_TOOLS.has(message.toolName)) continue;
    if (now - message.timestamp < maxAgeMs) continue;
    if (message.content === CLEARED_MARKER) continue;

    message.content = CLEARED_MARKER;
  }

  return compacted;
}
```

**Explanation:** The function clones the messages to avoid mutation, then iterates through all tool-role messages. It only clears content from compactable tools that are older than the threshold and haven't already been cleared.

---

## Exercise 3
**Challenge:** Extend the solution to produce `cacheEdits` instead of mutating messages.

**Answer:**

```typescript
interface CacheEdit {
  messageIndex: number;
  newValue: string;
}

function cachedMicroCompact(
  messages: Message[],
  maxAgeMs: number
): { messages: Message[]; cacheEdits: CacheEdit[] } {
  const now = Date.now();
  const edits: CacheEdit[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "tool") continue;
    if (!message.toolName || !COMPACTABLE_TOOLS.has(message.toolName)) continue;
    if (now - message.timestamp < maxAgeMs) continue;
    if (message.content === CLEARED_MARKER) continue;

    edits.push({
      messageIndex: i,
      newValue: CLEARED_MARKER,
    });
  }

  return { messages, cacheEdits: edits };
}
```

**Explanation:** Instead of cloning and mutating, this version returns the original messages array untouched alongside a list of edits. The API server applies the edits to its cached copy, preserving the prompt cache prefix match. This is the key optimization that makes microcompact cache-friendly.

---

## Exercise 4
**Challenge:** Write a function `estimateMicrocompactSavings`.

**Answer:**

```typescript
const TOKENS_PER_CHAR = 0.25;
const CLEARED_MARKER_TOKENS = 30;

function estimateMicrocompactSavings(messages: Message[]): {
  tokensSaved: number;
  resultsCleared: number;
} {
  const now = Date.now();
  const maxAgeMs = 5 * 60 * 1000; // 5 minutes as default threshold
  let tokensSaved = 0;
  let resultsCleared = 0;

  for (const message of messages) {
    if (message.role !== "tool") continue;
    if (!message.toolName || !COMPACTABLE_TOOLS.has(message.toolName)) continue;
    if (now - message.timestamp < maxAgeMs) continue;
    if (message.content === CLEARED_MARKER) continue;

    const originalTokens = Math.ceil(message.content.length * TOKENS_PER_CHAR);
    tokensSaved += originalTokens - CLEARED_MARKER_TOKENS;
    resultsCleared++;
  }

  return { tokensSaved, resultsCleared };
}
```

**Explanation:** The function estimates token counts using the 0.25 tokens-per-character ratio and subtracts the fixed cost of the cleared marker. This gives an approximation of how many tokens microcompact would reclaim, useful for monitoring and deciding whether more aggressive compaction is needed.
