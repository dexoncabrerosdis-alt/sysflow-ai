# Lesson 63: Context Collapse

## A Different Strategy: Progressive Reduction

Autocompact is binary — either the conversation is intact, or it's summarized. There's no middle ground. Context collapse introduces a **progressive** approach: reduce the conversation incrementally, in stages, preserving more detail than a full summary while still freeing significant space.

Think of it like file compression with adjustable quality. Autocompact is like converting a 50MB photo to a 100KB thumbnail — you get massive space savings but lose all detail. Context collapse is like reducing that photo from 50MB to 20MB, then to 8MB, then to 3MB — each step losing some quality but staying much closer to the original.

## How Collapses Work

Context collapse works by identifying message segments that can be reduced and staging those reductions:

```typescript
interface ContextCollapse {
  segmentStart: number;   // start index in messages array
  segmentEnd: number;     // end index in messages array
  collapsedContent: string;  // replacement content
  tokensFreed: number;    // estimated savings
  stage: number;          // which reduction stage this belongs to
}
```

A collapse replaces a range of messages with a shorter version — not a full-conversation summary, but a compressed version of just that segment. For example:

```
Original (5 messages, 8,000 tokens):
  Assistant: "Let me read the test file to understand the test structure..."
  Tool(Read): [500 lines of test file content]
  Assistant: "I see the tests use Jest with a custom matcher. Let me check the matcher..."
  Tool(Read): [200 lines of matcher file content]
  Assistant: "Got it. The matcher validates against a JSON schema..."

Collapsed (1 message, 400 tokens):
  "[Collapsed: Read tests/auth.test.ts and tests/matchers/schema.ts.
   Tests use Jest with custom JSON schema matcher.]"
```

The collapsed version preserves the *what* (which files were read, what was learned) while discarding the *raw content* (full file listings, verbose analysis).

## Staging: Progressive Reduction

Collapses are grouped into stages. Each stage is more aggressive than the last:

```typescript
enum CollapseStage {
  STAGE_1 = 1,  // Collapse old tool read/search results
  STAGE_2 = 2,  // Collapse old tool call + response pairs
  STAGE_3 = 3,  // Collapse old assistant reasoning blocks
}

function identifyCollapsesByStage(
  messages: Message[]
): Map<CollapseStage, ContextCollapse[]> {
  const stages = new Map<CollapseStage, ContextCollapse[]>();

  // Stage 1: Old tool results only (similar to microcompact but grouped)
  stages.set(CollapseStage.STAGE_1, findOldToolResults(messages));

  // Stage 2: Full tool call + result pairs
  stages.set(CollapseStage.STAGE_2, findOldToolPairs(messages));

  // Stage 3: Assistant reasoning blocks between tool calls
  stages.set(CollapseStage.STAGE_3, findOldReasoningBlocks(messages));

  return stages;
}
```

**Stage 1** is gentlest — it only collapses tool result content, similar to microcompact but with slightly better summaries. **Stage 2** removes both the tool call and its result, replacing them with a note about what happened. **Stage 3** goes further, collapsing the model's own reasoning text between tool calls.

## applyCollapsesIfNeeded(): Projection Before Autocompact

The key to context collapse is that it's applied as a **projection** — the collapses are staged (planned) but not committed to the actual messages until needed:

```typescript
function applyCollapsesIfNeeded(
  messages: Message[],
  model: ModelId,
  state: CollapseState
): { projectedMessages: Message[]; tokensFreed: number } {
  const currentTokens = estimateTokenCount(messages);
  const threshold = getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS;

  if (currentTokens < threshold) {
    return { projectedMessages: messages, tokensFreed: 0 };
  }

  // Determine how many collapse stages are needed
  let projectedMessages = structuredClone(messages);
  let totalFreed = 0;

  for (const stage of [CollapseStage.STAGE_1, CollapseStage.STAGE_2, CollapseStage.STAGE_3]) {
    const collapses = state.stagedCollapses.get(stage) ?? [];

    for (const collapse of collapses) {
      applyCollapse(projectedMessages, collapse);
      totalFreed += collapse.tokensFreed;
    }

    // Check if we've freed enough
    const projectedTokens = currentTokens - totalFreed;
    if (projectedTokens < threshold) {
      break;  // This many stages is sufficient
    }
  }

  // Stage the collapses (don't commit yet)
  state.pendingCollapses = totalFreed > 0;

  return { projectedMessages, tokensFreed: totalFreed };
}
```

The function projects what the messages would look like after collapsing, without actually modifying them. This projection is used for the API call, while the original messages remain intact in case the collapses need to be adjusted.

## recoverFromOverflow(): Committing Staged Collapses

When a 413 error occurs, the staged collapses are committed — "drained" — to recover:

```typescript
function recoverFromOverflow(
  messages: Message[],
  state: CollapseState
): { tokensFreed: number } {
  if (!state.pendingCollapses) {
    return { tokensFreed: 0 };
  }

  let totalFreed = 0;

  // Apply all staged collapses to the actual messages
  for (const [stage, collapses] of state.stagedCollapses) {
    for (const collapse of collapses) {
      // Actually mutate the messages array
      const freed = commitCollapse(messages, collapse);
      totalFreed += freed;
    }
  }

  // Clear the staged collapses
  state.stagedCollapses.clear();
  state.pendingCollapses = false;

  return { tokensFreed: totalFreed };
}
```

This is the Phase 1 of reactive compact (Lesson 62). Draining staged collapses is fast because the collapse content was pre-computed during staging — there's no API call needed, just array manipulation.

## The collapse_drain_retry Flow

When collapses are drained during reactive compact, the flow looks like:

```
API call with projected messages
        │
        ▼
   413 error
        │
        ▼
  Drain staged collapses
  (commit projections to actual messages)
        │
        ▼
  Retry API call
  (now with committed collapses — actual tokens match projection)
        │
        ▼
  continue_reason: "collapse_drain_retry"
```

The `collapse_drain_retry` continue reason tells the agent loop that this retry is recovering from a context overflow, not a normal tool-use continuation.

## Relationship with Autocompact

Context collapse and autocompact serve similar goals but work differently. When context collapse is enabled, it takes priority:

```typescript
function shouldAutoCompact(
  tokenCount: number,
  model: ModelId,
  options: AutocompactOptions
): boolean {
  // When context collapse is enabled, suppress autocompact
  // Collapse handles reduction incrementally
  if (options.contextCollapseEnabled) {
    return false;
  }

  // ... normal autocompact logic
}
```

Why suppress autocompact? Because collapse and autocompact would interfere with each other:

- Collapse stages reductions progressively
- Autocompact rewrites everything at once
- If both run, autocompact would destroy the carefully staged collapses

The hierarchy is:

```
Context Collapse ENABLED:
  1. Stage collapses progressively
  2. Project collapsed messages for API calls
  3. On 413: drain collapses (fast recovery)
  4. If still not enough: fall back to full compaction (reactive compact Phase 2)

Context Collapse DISABLED:
  1. Autocompact when near threshold
  2. On 413: reactive compact (full compaction)
```

## resetContextCollapse on Post-Compact Cleanup

When full compaction eventually happens (either through autocompact or reactive compact Phase 2), the collapse state is reset:

```typescript
function resetContextCollapse(state: AgentState): void {
  state.contextCollapse = {
    stagedCollapses: new Map(),
    pendingCollapses: false,
    lastCollapseStage: 0,
    collapsedSegments: new Set(),
  };
}
```

After a full compaction, the entire conversation has been replaced by a summary. The old collapse stages, pending reductions, and tracked segments are all irrelevant. Starting fresh allows the collapse system to begin staging new reductions as the post-compaction conversation grows.

## A Worked Example

Let's trace through a real scenario with context collapse:

```
Turn 1-10: Normal conversation, 60K tokens
  → No action needed (well under threshold)

Turn 11-20: Growing, 120K tokens
  → Stage 1 collapses identified: 5 old tool results (est. 25K savings)
  → Not yet needed — under threshold

Turn 21-25: Approaching limit, 165K tokens
  → applyCollapsesIfNeeded():
    Stage 1: collapse 5 old tool results → saves 25K → projected 140K
    → 140K < 171K threshold → Stage 1 sufficient
  → API call uses projected messages (140K tokens)
  → Call succeeds ✓

Turn 26-30: Still growing, 175K tokens (with Stage 1 applied)
  → applyCollapsesIfNeeded():
    Stage 1: already applied
    Stage 2: collapse 8 old tool pairs → saves 30K → projected 145K
    → 145K < 171K threshold → Stage 2 sufficient
  → API call uses projected messages (145K tokens)
  → Call succeeds ✓

Turn 31: Big tool result pushes to 190K
  → applyCollapsesIfNeeded():
    Stage 1 + 2: already applied
    Stage 3: collapse reasoning blocks → saves 15K → projected 175K
    → 175K > 171K threshold → All stages insufficient!
  → API call with projected messages (175K tokens)
  → API returns 413! (estimation was off)
  → recoverFromOverflow(): drain all staged collapses → actually commit
  → Full compaction fallback → summarize to 15K tokens
  → Retry succeeds ✓
```

## Advantages Over Pure Autocompact

Context collapse has several advantages:

1. **Gradual quality degradation** — instead of a sudden jump from full detail to summary, detail is reduced progressively
2. **Faster recovery** — draining pre-staged collapses is faster than generating a new summary
3. **Better cache behavior** — collapsed segments can be at the end of the cache prefix, preserving earlier cached content
4. **More predictable** — the agent knows exactly how much each collapse stage will save

The trade-off is complexity. Context collapse requires tracking stages, managing projections vs. commits, and coordinating with autocompact. This is why it's feature-gated — not all configurations use it.

## Key Takeaways

1. **Context collapse is progressive** — reduces context in stages, preserving detail longer
2. **Collapses are staged, then committed** — projections first, actual mutations on 413
3. **Three stages of increasing aggression** — tool results → tool pairs → reasoning blocks
4. **Suppresses autocompact** — when collapse is enabled, it handles context reduction instead
5. **Fast 413 recovery** — draining pre-staged collapses is faster than generating a summary
6. **Reset on full compaction** — when the conversation is fully summarized, collapse state starts fresh

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Progressive vs Binary
**Question:** Explain the photo compression analogy from this lesson in your own words. When would progressive reduction (context collapse) be preferable to binary summarization (autocompact)? Give a specific scenario where each strategy wins.

[View Answer](../../answers/06-context-management/answer-63.md#exercise-1)

### Exercise 2 — Collapse Stage Identifier
**Challenge:** Write a function `identifyCollapseStage(message: Message)` that classifies a message into one of the three collapse stages (or "none" if it's not collapsible). Stage 1: old tool results. Stage 2: old tool call + result pairs. Stage 3: old assistant reasoning blocks. Use message properties `role`, `toolName`, `age`, and `hasToolCall`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-63.md#exercise-2)

### Exercise 3 — Projection System
**Challenge:** Implement `applyCollapsesIfNeeded` that takes messages, a token threshold, and staged collapses grouped by stage. It should apply stages progressively (1, then 2, then 3) until the projected token count drops below the threshold. Return the projected messages and tokens freed.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-63.md#exercise-3)

### Exercise 4 — Collapse vs Autocompact Interaction
**Question:** Why does enabling context collapse suppress autocompact? What specific problem would occur if both ran simultaneously? Trace through a scenario where both fire at the same time to illustrate the conflict.

[View Answer](../../answers/06-context-management/answer-63.md#exercise-4)

---

*Previous: [Lesson 62 — Reactive Compact](62-reactive-compact.md) · Next: [Lesson 64 — Snip](64-snip.md)*
