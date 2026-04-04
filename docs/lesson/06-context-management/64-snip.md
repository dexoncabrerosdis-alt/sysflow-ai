# Lesson 64: Snip

## Cutting Out Old Segments

Microcompact clears tool result *content* but keeps the message structure. Context collapse replaces segments with shorter versions. Snip takes a different approach: it **removes entire messages** from the conversation history, leaving a boundary marker where the removed segment was.

Snip is like tearing pages out of a notebook and leaving a sticky note that says "3 pages removed here." The information is completely gone — not summarized, not compressed, just deleted.

## When Snip Is Useful

Snip is most effective when there are clear segments of the conversation that are no longer relevant:

- **Early exploration that led nowhere** — the agent spent 10 turns investigating approach A, then switched to approach B. The approach-A turns are pure dead weight.
- **Resolved error loops** — the agent tried a fix, ran tests, saw a failure, tried another fix, ran tests again, and the tests finally passed. The intermediate failure cycles can be snipped.
- **Large context dumps** — the agent read 5 large files at the start to understand the codebase, then began working. The full file contents are now stale (the files have been edited since).

## snipCompactIfNeeded()

The snip mechanism checks whether old message segments should be removed:

```typescript
interface SnipResult {
  snipped: boolean;
  snipTokensFreed: number;
  boundaryMessage: Message | null;
}

function snipCompactIfNeeded(
  messages: Message[],
  model: ModelId,
  state: SnipState
): SnipResult {
  const tokenCount = estimateTokenCount(messages);
  const threshold = getSnipThreshold(model);

  // Only snip when we're approaching the limit
  if (tokenCount < threshold) {
    return { snipped: false, snipTokensFreed: 0, boundaryMessage: null };
  }

  // Find the best segment to snip
  const segment = findBestSnipSegment(messages, state);
  if (!segment) {
    return { snipped: false, snipTokensFreed: 0, boundaryMessage: null };
  }

  // Calculate tokens being freed
  const segmentTokens = estimateTokenCount(
    messages.slice(segment.start, segment.end)
  );

  // Remove the segment and insert a boundary marker
  const boundary = createSnipBoundary(segment, segmentTokens);
  messages.splice(
    segment.start,
    segment.end - segment.start,
    boundary
  );

  return {
    snipped: true,
    snipTokensFreed: segmentTokens,
    boundaryMessage: boundary,
  };
}
```

## Finding the Best Segment to Snip

Not all segments are equally good candidates for snipping. The selection algorithm considers:

```typescript
interface SnipSegment {
  start: number;
  end: number;
  score: number;  // higher = better candidate for removal
}

function findBestSnipSegment(
  messages: Message[],
  state: SnipState
): SnipSegment | null {
  const candidates: SnipSegment[] = [];

  // Look for contiguous blocks of old tool interactions
  let segmentStart: number | null = null;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    // Skip compaction boundaries and recent messages
    if (isCompactionBoundary(message)) continue;
    if (isRecentEnough(message, messages)) {
      if (segmentStart !== null) {
        candidates.push(scoreSegment(messages, segmentStart, i));
        segmentStart = null;
      }
      continue;
    }

    // Track old segments
    if (segmentStart === null) {
      segmentStart = i;
    }
  }

  if (segmentStart !== null) {
    candidates.push(scoreSegment(messages, segmentStart, messages.length));
  }

  // Return the highest-scoring candidate
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

function scoreSegment(
  messages: Message[],
  start: number,
  end: number
): SnipSegment {
  let score = 0;
  const segmentMessages = messages.slice(start, end);

  // Bigger segments are better candidates (more tokens freed)
  score += estimateTokenCount(segmentMessages) / 1000;

  // Older segments are better candidates
  score += getAge(segmentMessages) / 60_000;  // age in minutes

  // Segments with only tool calls (no user messages) are safer to remove
  const hasUserMessages = segmentMessages.some(m => m.role === "user");
  if (!hasUserMessages) score += 10;

  // Segments where tool results were already microcompacted are better
  const alreadyCleared = segmentMessages.filter(
    m => m.role === "tool" && m.content === "[Old tool result content cleared]"
  );
  score += alreadyCleared.length * 2;

  return { start, end, score };
}
```

The scoring favors large, old segments that contain only tool interactions (no user messages) and whose content has already been cleared by microcompact.

## The Snip Boundary Marker

When messages are removed, a boundary marker takes their place:

```typescript
function createSnipBoundary(
  segment: SnipSegment,
  tokensFreed: number
): Message {
  const messageCount = segment.end - segment.start;

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

The marker tells the model that content was removed and roughly what it contained. This prevents the model from being confused by apparent gaps in the conversation flow.

## Tracking: snipTokensFreed

The number of tokens freed by snipping is tracked and used by downstream token calculations:

```typescript
interface TokenAccounting {
  rawTokenCount: number;       // tokens in current messages
  microcompactSavings: number; // tokens saved by microcompact
  snipTokensFreed: number;     // tokens freed by snipping
  effectiveTokenCount: number; // what we report for budget checks
}

function getEffectiveTokenCount(accounting: TokenAccounting): number {
  return accounting.rawTokenCount;
  // snipTokensFreed is already reflected in rawTokenCount
  // (the messages were physically removed)
  // but we track it for metrics and debugging
}
```

Unlike microcompact (which clears content but keeps message structure, so some overhead remains), snip physically removes messages. The token savings are immediate and fully reflected in the message count.

## How Snip Differs from Microcompact

| Aspect | Microcompact | Snip |
|--------|-------------|------|
| **What it does** | Clears tool result content | Removes entire messages |
| **Message structure** | Preserved (tool_use + tool_result pairs remain) | Removed (replaced with boundary marker) |
| **Reversibility** | Content can theoretically be restored from disk | Messages are permanently removed |
| **Token savings** | Moderate (content gone, structure remains) | Maximum (everything gone) |
| **Model awareness** | Model sees "[Old tool result content cleared]" | Model sees "[N messages removed]" |
| **Risk** | Low (model still sees the call happened) | Higher (model loses the entire interaction) |
| **When it runs** | Every turn (lightweight) | Only near context limits (aggressive) |

Snip is strictly more aggressive than microcompact. It should only be used when microcompact hasn't freed enough space and the segment is clearly expendable.

## The SnipTool: Manual Snipping

In addition to automatic snipping, Claude Code provides a `SnipTool` that the model can invoke explicitly to manage its own context:

```typescript
const SnipTool = {
  name: "SnipHistory",
  description:
    "Remove a range of old messages from the conversation history " +
    "to free context space. Use when you notice the conversation is " +
    "very long and older messages are no longer relevant.",

  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Why these messages should be removed",
      },
      fromTurn: {
        type: "number",
        description: "Start turn number to remove (inclusive)",
      },
      toTurn: {
        type: "number",
        description: "End turn number to remove (inclusive)",
      },
    },
    required: ["reason", "fromTurn", "toTurn"],
  },

  async execute(input: SnipToolInput, context: ToolContext): Promise<string> {
    const { reason, fromTurn, toTurn } = input;

    // Validate the range
    if (fromTurn < 0 || toTurn >= context.messages.length) {
      return "Invalid turn range.";
    }
    if (fromTurn >= toTurn) {
      return "fromTurn must be less than toTurn.";
    }

    // Don't allow snipping recent messages
    const recentThreshold = context.messages.length - 4;
    if (toTurn >= recentThreshold) {
      return "Cannot snip recent messages. Only snip old, irrelevant segments.";
    }

    // Perform the snip
    const tokensFreed = estimateTokenCount(
      context.messages.slice(fromTurn, toTurn + 1)
    );

    const boundary = createSnipBoundary(
      { start: fromTurn, end: toTurn + 1 },
      tokensFreed
    );

    context.messages.splice(fromTurn, toTurn - fromTurn + 1, boundary);

    return `Snipped ${toTurn - fromTurn + 1} messages (${tokensFreed} tokens freed). Reason: ${reason}`;
  },
};
```

The SnipTool lets the model be an active participant in context management. If the model notices it's in a long conversation and remembers that an early exploration phase is irrelevant, it can snip those turns proactively.

## Feature Gate: HISTORY_SNIP

The SnipTool is behind a feature gate:

```typescript
function getAvailableTools(features: FeatureFlags): Tool[] {
  const tools = [...CORE_TOOLS];

  if (features.isEnabled("HISTORY_SNIP")) {
    tools.push(SnipTool);
  }

  // ... other feature-gated tools

  return tools;
}
```

Why gate it? Because giving the model the ability to delete conversation history is risky:

- The model might snip messages the user expects to be preserved
- Aggressive snipping could remove context the model needs later
- The interaction between manual snips and automatic compaction needs careful coordination

The feature gate allows the team to test snipping with a subset of users and measure its impact on task success rates before rolling it out broadly.

## Safety Constraints

Even when enabled, the SnipTool has guardrails:

```typescript
function validateSnipRequest(
  input: SnipToolInput,
  messages: Message[]
): ValidationResult {
  // Cannot snip user messages (only tool interactions)
  const segment = messages.slice(input.fromTurn, input.toTurn + 1);
  const hasUserMessages = segment.some(
    m => m.role === "user" && !m.metadata?.isCompactionBoundary
  );
  if (hasUserMessages) {
    return { valid: false, reason: "Cannot snip user messages" };
  }

  // Cannot snip the last N messages
  if (input.toTurn >= messages.length - 4) {
    return { valid: false, reason: "Cannot snip recent messages" };
  }

  // Cannot snip across compaction boundaries
  const hasBoundary = segment.some(
    m => m.metadata?.isCompactionBoundary || m.metadata?.isSnipBoundary
  );
  if (hasBoundary) {
    return { valid: false, reason: "Cannot snip across boundaries" };
  }

  return { valid: true };
}
```

These constraints prevent the model from:
- Deleting user messages (which would lose user instructions)
- Snipping recent context (which is likely still relevant)
- Snipping across compaction boundaries (which would break the conversation structure)

## Key Takeaways

1. **Snip removes entire messages** — more aggressive than microcompact, which only clears content
2. **Boundary markers replace removed segments** — the model knows content was removed
3. **Segment scoring selects the best candidates** — favoring large, old, tool-only segments
4. **snipTokensFreed tracks savings** — used for downstream budget calculations
5. **The SnipTool enables model-driven snipping** — the model can manage its own context
6. **Feature-gated with safety constraints** — prevents accidental deletion of important messages

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Snip vs Microcompact
**Question:** Create a comparison table between snip and microcompact covering: what each removes, whether message structure is preserved, reversibility, token savings magnitude, risk level, and when each runs in the pipeline.

[View Answer](../../answers/06-context-management/answer-64.md#exercise-1)

### Exercise 2 — Segment Scoring Algorithm
**Challenge:** Implement the `scoreSegment` function that scores a candidate segment for snipping. The score should consider: segment token size (bigger = better), age in minutes (older = better), whether it contains user messages (tool-only segments score +10), and count of already-cleared results (each adds +2).

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-64.md#exercise-2)

### Exercise 3 — Snip Boundary Marker
**Challenge:** Write the `createSnipBoundary` function that returns a message object with role "user", a text content block describing how many messages were removed and tokens freed, and metadata fields `isSnipBoundary`, `snippedAt`, `messageCount`, and `tokensFreed`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-64.md#exercise-3)

### Exercise 4 — Safety Validation
**Challenge:** Write a `validateSnipRequest` function that rejects snip requests that: (a) include user messages, (b) target the last 4 messages, or (c) span across compaction or snip boundaries. Return `{ valid: boolean, reason?: string }`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-64.md#exercise-4)

---

*Previous: [Lesson 63 — Context Collapse](63-context-collapse.md) · Next: [Lesson 65 — Full Compaction Pipeline](65-full-compaction-pipeline.md)*
