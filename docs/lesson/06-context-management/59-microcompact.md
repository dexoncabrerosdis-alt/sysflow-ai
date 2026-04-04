# Lesson 59: Microcompact

## The Problem: Stale Tool Results

Imagine the agent reads a file at turn 3, edits it at turn 7, and reads it again at turn 10. The turn-3 version is now stale — the file has changed. But that old file content is still sitting in the conversation history, consuming tokens. The model will never need it again.

This pattern happens constantly. An agent working on a real task accumulates dozens of tool results — file reads, grep searches, glob listings, shell output — most of which become irrelevant within a few turns. Microcompact clears these stale results without disturbing the rest of the conversation.

## What Microcompact Does

Microcompact replaces old tool result content with a short placeholder:

```
Before microcompact:
  tool_result: "1|import React from 'react';\n2|import { useState } from 'react';\n
  3|\n4|export function Counter() {\n5|  const [count, setCount] = useState(0);\n
  6|  return (\n7|    <div>\n8|      <p>Count: {count}</p>\n9|      <button onClick={() =>
  setCount(c => c + 1)}>+</button>\n10|    </div>\n11|  );\n12|}"

After microcompact:
  tool_result: "[Old tool result content cleared]"
```

The message structure stays intact — the tool_use and tool_result pair remain in the conversation. Only the content of the tool_result is replaced. This preserves the flow of the conversation (the model can still see *that* a tool was called and what arguments were used) while freeing the tokens consumed by the result.

## Which Tools Are Compactable

Not all tool results should be cleared. Some results remain relevant throughout the conversation. Microcompact only targets tools whose results become stale:

```typescript
const COMPACTABLE_TOOLS = new Set([
  "Read",       // File contents change after edits
  "Grep",       // Search results are point-in-time
  "Glob",       // File listings are point-in-time
  "Edit",       // Edit diffs are informational, not needed later
  "Write",      // Write confirmations are transient
  "Shell",      // Command output is point-in-time
  "WebFetch",   // Web content is point-in-time
]);
```

Why these specific tools?

- **Read / Edit / Write**: File-related results go stale as soon as the file is modified again. The current state of the file is what matters, not historical versions.
- **Grep / Glob**: Search results are snapshots. If the codebase changes (or the agent just needs different information now), old search results are noise.
- **Shell**: Command output (test results, build logs) is relevant when debugging that specific failure. After the issue is resolved, the output is dead weight.
- **WebFetch**: Web content is a snapshot. Old fetches rarely need revisiting.

Tools that are NOT compactable include things like user messages and assistant responses — those contain the ongoing dialogue and task context that the model needs.

## Time-Based Trigger

Microcompact doesn't clear results immediately. It uses a time-based heuristic: if there's been an idle gap (time between tool calls) longer than a threshold, tool results from before that gap are candidates for clearing.

```typescript
interface MicrocompactOptions {
  messages: Message[];
  idleThresholdMs: number;
}

function findCompactableResults(
  messages: Message[],
  idleThresholdMs: number
): CompactableResult[] {
  const candidates: CompactableResult[] = [];
  let lastToolTimestamp: number | null = null;

  for (const message of messages) {
    if (message.role === "assistant" && hasToolUse(message)) {
      const currentTimestamp = message.timestamp;

      if (lastToolTimestamp !== null) {
        const gap = currentTimestamp - lastToolTimestamp;
        if (gap > idleThresholdMs) {
          // Everything before this gap is "old"
          // Mark prior tool results as compactable
          markPriorResultsCompactable(messages, currentTimestamp, candidates);
        }
      }

      lastToolTimestamp = currentTimestamp;
    }
  }

  return candidates;
}
```

The intuition: a long idle gap suggests the user went away, or the task shifted to a different phase. Tool results from before the gap are likely no longer relevant.

In practice, even without explicit time gaps, microcompact clears results that are "old enough" — results from many turns ago where the agent has clearly moved on to other work.

## The Core Algorithm

Here's the simplified core of microcompact:

```typescript
function microCompact(messages: Message[]): Message[] {
  const compacted = structuredClone(messages);

  for (let i = 0; i < compacted.length; i++) {
    const message = compacted[i];

    // Only process tool_result messages
    if (message.role !== "tool") continue;

    // Check if this tool result is compactable
    const toolUse = findMatchingToolUse(compacted, message.tool_use_id);
    if (!toolUse || !COMPACTABLE_TOOLS.has(toolUse.name)) continue;

    // Check if this result is old enough to compact
    if (!isOldEnough(message, compacted)) continue;

    // Already compacted? Skip
    if (message.content === CLEARED_MARKER) continue;

    // Clear the content
    message.content = "[Old tool result content cleared]";
  }

  return compacted;
}
```

The function walks through all messages, finds tool results from compactable tools that are old enough, and replaces their content with the cleared marker. It returns a new array — the original messages are not mutated (this is important for the cached variant, discussed next).

## Cached Microcompact: Preserving Prompt Cache

Here's where microcompact gets clever. Recall from Module 05 that prompt caching saves money by reusing previously cached prompt prefixes. If microcompact mutates messages in the middle of the conversation, it breaks the cache — the prefix no longer matches.

The solution: **cached microcompact** applies the clearing as `cache_edits` in the API request rather than mutating the local messages.

```typescript
function cachedMicroCompact(
  messages: Message[]
): { messages: Message[]; cacheEdits: CacheEdit[] } {
  const edits: CacheEdit[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "tool") continue;

    const toolUse = findMatchingToolUse(messages, message.tool_use_id);
    if (!toolUse || !COMPACTABLE_TOOLS.has(toolUse.name)) continue;
    if (!isOldEnough(message, messages)) continue;
    if (message.content === CLEARED_MARKER) continue;

    // Instead of mutating, emit a cache edit
    edits.push({
      messageIndex: i,
      field: "content",
      newValue: "[Old tool result content cleared]",
    });
  }

  // Return ORIGINAL messages (unmutated) + edits for the API
  return { messages, cacheEdits: edits };
}
```

The API receives the original messages (which match the cached prefix) plus a set of edits that modify specific tool results. The server applies the edits to the cached version, getting the benefit of both caching AND cleaned-up context.

```
Without cached microcompact:
  Turn N:   [sys][msg1][tool1=500 tokens][msg2][tool2=300 tokens][msg3]
  Turn N+1: [sys][msg1][tool1=CLEARED][msg2][tool2=CLEARED][msg3][msg4]
  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  Cache MISS — prefix changed because tool1 and tool2 were modified

With cached microcompact:
  Turn N:   [sys][msg1][tool1=500 tokens][msg2][tool2=300 tokens][msg3]
  Turn N+1: [sys][msg1][tool1=500 tokens][msg2][tool2=300 tokens][msg3][msg4]
            + cache_edits: [{idx:2, content: "CLEARED"}, {idx:4, content: "CLEARED"}]
  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  Cache HIT — prefix is identical, edits applied server-side
```

This is a significant optimization. Prompt cache hits can reduce costs by 90%. Naive microcompact would destroy the cache on every compaction. Cached microcompact gets both benefits — smaller effective context AND cache hits.

## What Microcompact Doesn't Do

It's important to understand microcompact's limitations:

1. **It doesn't remove messages** — the message structure (tool_use + tool_result pair) remains. Only the content is cleared. This means the conversation still grows in message count.

2. **It doesn't summarize** — unlike full compaction (Lesson 61), microcompact doesn't generate a summary of what was cleared. The information is simply gone from context.

3. **It doesn't touch non-tool content** — user messages, assistant text responses, and system prompts are never microcompacted.

4. **It's not always enough** — for very long conversations, clearing tool results alone may not free enough space. That's when autocompact and other strategies take over.

## How Much Does It Save?

In a typical 30-turn coding session, microcompact can reclaim 40-60% of the context. Here's a realistic example:

```
Turn  Tool              Result Size    After Microcompact
─────────────────────────────────────────────────────────
 1    Read (config.ts)      800 tok    → [cleared] (30 tok)
 2    Grep (imports)       1200 tok    → [cleared] (30 tok)
 3    Read (auth.ts)       2000 tok    → [cleared] (30 tok)
 4    Edit (auth.ts)        600 tok    → [cleared] (30 tok)
 5    Shell (npm test)     1500 tok    → [cleared] (30 tok)
 6    Read (auth.ts)       2100 tok    → [cleared] (30 tok)
 7    Edit (auth.ts)        400 tok    → [cleared] (30 tok)
 8    Shell (npm test)      300 tok    (recent — kept)
 9    Read (auth.test.ts)  1800 tok    (recent — kept)
10    Edit (auth.test.ts)   500 tok    (recent — kept)
─────────────────────────────────────────────────────────
Before: 11,200 tokens
After:   2,810 tokens  (75% reduction)
```

The older results (turns 1-7) are cleared; recent results (turns 8-10) are kept because the model might still reference them.

## Key Takeaways

1. **Microcompact clears old tool result content** — replaces it with a short placeholder
2. **Only compactable tools are targeted** — Read, Grep, Glob, Edit, Write, Shell, WebFetch
3. **Time-based and recency heuristics** decide what's "old enough" to clear
4. **Cached microcompact preserves prompt cache** — uses cache_edits instead of mutating messages
5. **It's lightweight and non-destructive** — message structure is preserved, only content is cleared
6. **Typically reclaims 40-60% of context** — the single most effective incremental optimization

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Compactable vs Non-Compactable
**Question:** The lesson lists Read, Grep, Glob, Edit, Write, Shell, and WebFetch as compactable tools. Why are user messages and assistant text responses NOT compactable? Give two specific reasons and a concrete example of what would go wrong if they were.

[View Answer](../../answers/06-context-management/answer-59.md#exercise-1)

### Exercise 2 — Implement microCompact
**Challenge:** Write a simplified `microCompact` function that takes an array of messages and returns a new array with old compactable tool results cleared. Each message has `{ role, toolName?, content, timestamp }`. Clear results older than a given `maxAgeMs` threshold for tools in the COMPACTABLE_TOOLS set.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-59.md#exercise-2)

### Exercise 3 — Cache-Friendly Microcompact
**Challenge:** Extend your solution from Exercise 2 to produce `cacheEdits` instead of mutating the messages array. Return `{ messages: Message[], cacheEdits: CacheEdit[] }` where each `CacheEdit` has `{ messageIndex: number, newValue: string }`. The original messages array must remain unchanged.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-59.md#exercise-3)

### Exercise 4 — Savings Calculator
**Challenge:** Write a function `estimateMicrocompactSavings(messages: Message[])` that calculates how many tokens microcompact would save. Assume each character is ~0.25 tokens and the cleared marker `"[Old tool result content cleared]"` is always 30 tokens.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-59.md#exercise-4)

---

*Previous: [Lesson 58 — Tool Result Budgets](58-tool-result-budgets.md) · Next: [Lesson 60 — Autocompact](60-autocompact.md)*
