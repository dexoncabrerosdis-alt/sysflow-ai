# Answers: Lesson 64 — Snip

## Exercise 1
**Question:** Create a comparison table between snip and microcompact.

**Answer:**

| Aspect | Microcompact | Snip |
|--------|-------------|------|
| **What it removes** | Tool result content only | Entire messages |
| **Structure preserved** | Yes — tool_use + tool_result pairs remain | No — replaced with boundary marker |
| **Reversibility** | Content can be restored from disk | Messages permanently removed |
| **Token savings** | Moderate (content gone, structure overhead remains) | Maximum (everything gone) |
| **Risk level** | Low — model sees the call happened | Higher — model loses the entire interaction |
| **When it runs** | Every turn (lightweight, always active) | Only near context limits (aggressive, feature-gated) |

---

## Exercise 2
**Challenge:** Implement the `scoreSegment` function.

**Answer:**

```typescript
interface Message {
  role: string;
  content: string;
  timestamp: number;
  tokenCount: number;
}

interface SnipSegment {
  start: number;
  end: number;
  score: number;
}

const CLEARED_MARKER = "[Old tool result content cleared]";

function scoreSegment(
  messages: Message[],
  start: number,
  end: number
): SnipSegment {
  const segment = messages.slice(start, end);
  let score = 0;

  // Bigger segments are better (more tokens freed)
  const totalTokens = segment.reduce((sum, m) => sum + m.tokenCount, 0);
  score += totalTokens / 1000;

  // Older segments are better
  const oldestTimestamp = Math.min(...segment.map((m) => m.timestamp));
  const ageMinutes = (Date.now() - oldestTimestamp) / 60_000;
  score += ageMinutes / 60;

  // Tool-only segments (no user messages) are safer
  const hasUserMessages = segment.some((m) => m.role === "user");
  if (!hasUserMessages) score += 10;

  // Already-cleared results indicate low-value content
  const alreadyCleared = segment.filter(
    (m) => m.role === "tool" && m.content === CLEARED_MARKER
  );
  score += alreadyCleared.length * 2;

  return { start, end, score };
}
```

**Explanation:** The scoring function balances four factors. Token size provides the direct payoff of snipping. Age reflects the likelihood of the content being stale. The user-message penalty protects instructions from deletion. The already-cleared bonus favors segments that are mostly dead weight anyway.

---

## Exercise 3
**Challenge:** Write the `createSnipBoundary` function.

**Answer:**

```typescript
interface SnipBoundaryMessage {
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  metadata: {
    isSnipBoundary: boolean;
    snippedAt: number;
    messageCount: number;
    tokensFreed: number;
  };
}

function createSnipBoundary(
  messageCount: number,
  tokensFreed: number
): SnipBoundaryMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          `[${messageCount} messages removed from conversation history]`,
          `[${tokensFreed.toLocaleString()} tokens freed]`,
          `[Messages contained: tool calls and results from earlier in the session]`,
        ].join("\n"),
      },
    ],
    metadata: {
      isSnipBoundary: true,
      snippedAt: Date.now(),
      messageCount,
      tokensFreed,
    },
  };
}
```

**Explanation:** The boundary marker is structured as a user message so it integrates naturally into the conversation flow. The text content tells the model what was removed. The metadata fields enable downstream systems to detect snip boundaries and track cumulative token savings.

---

## Exercise 4
**Challenge:** Write a `validateSnipRequest` function.

**Answer:**

```typescript
interface SnipRequest {
  fromTurn: number;
  toTurn: number;
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

function validateSnipRequest(
  request: SnipRequest,
  messages: Message[]
): ValidationResult {
  const { fromTurn, toTurn } = request;
  const segment = messages.slice(fromTurn, toTurn + 1);

  // Check: cannot snip user messages
  const hasUserMessages = segment.some(
    (m) => m.role === "user" && !(m as any).metadata?.isCompactionBoundary
  );
  if (hasUserMessages) {
    return { valid: false, reason: "Cannot snip user messages" };
  }

  // Check: cannot snip the last 4 messages
  const recentThreshold = messages.length - 4;
  if (toTurn >= recentThreshold) {
    return { valid: false, reason: "Cannot snip recent messages" };
  }

  // Check: cannot snip across boundaries
  const hasBoundary = segment.some(
    (m) =>
      (m as any).metadata?.isCompactionBoundary ||
      (m as any).metadata?.isSnipBoundary
  );
  if (hasBoundary) {
    return { valid: false, reason: "Cannot snip across boundaries" };
  }

  return { valid: true };
}
```

**Explanation:** The three guards prevent the most dangerous snip scenarios: losing user instructions, removing context the model is actively using, and breaking the conversation structure at compaction points. Each rejection includes a clear reason for debugging and model feedback.
