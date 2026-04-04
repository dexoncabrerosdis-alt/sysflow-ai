# Lesson 65: The Full Compaction Pipeline

## Six Layers Working Together

Over the last nine lessons, we've examined each context management mechanism individually. Now let's see how they work together as a unified pipeline. This is the complete picture — the order of operations, the interactions between layers, and the decision logic that routes context through the right path.

## The Pipeline at a Glance

```
                        ┌─────────────────────────┐
                        │   User sends message /   │
                        │   Tool produces result   │
                        └────────────┬────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │  Layer 1: TOOL RESULT BUDGET     │
                    │  Cap individual tool results     │
                    │  before they enter context       │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │  Layer 2: SNIP                    │
                    │  Remove old message segments     │
                    │  if near capacity                │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │  Layer 3: MICROCOMPACT            │
                    │  Clear old tool result content   │
                    │  (cache-friendly)                │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │  Layer 4: CONTEXT COLLAPSE        │
                    │  Progressive staged reduction    │
                    │  (if enabled, suppresses L5)     │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │  Layer 5: AUTOCOMPACT             │
                    │  Proactive full summarization    │
                    │  (if not suppressed by L4)       │
                    └────────────────┬────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │         API CALL                  │
                    └────────────────┬────────────────┘
                                     │
                              success? ─── yes ──→ continue
                                     │
                                    413
                                     │
                    ┌────────────────▼────────────────┐
                    │  Layer 6: REACTIVE COMPACT        │
                    │  Emergency: drain collapses,     │
                    │  then full compaction,            │
                    │  then terminal error              │
                    └────────────────┬────────────────┘
                                     │
                              retry API call
```

## Layer-by-Layer Detail

### Layer 1: Tool Result Budget (Lesson 58)

**When**: Immediately when a tool produces output, before the result enters the message history.

**What**: Caps the result at `maxResultSizeChars` per tool (FileEdit=100K, Grep=20K, Shell=30K, etc.). Oversized results are truncated and persisted to disk.

**Why first**: If a single grep returns 500K characters, no amount of later compaction can save you. The budget prevents catastrophic single-result blowups.

```typescript
// This happens inside tool execution, before addToolResult()
const result = await tool.execute(input);
const budgeted = applyToolResultBudget(tool.name, result);
addToolResult(messages, toolCallId, budgeted.content);
```

**Frequency**: Every tool call. Always active. No feature gate.

---

### Layer 2: Snip (Lesson 64)

**When**: After tool results are added, during the pre-API-call phase.

**What**: Identifies and removes old message segments, replacing them with boundary markers. Frees the maximum possible tokens per segment.

**Why before microcompact**: Snip removes entire messages. If those messages are removed, microcompact doesn't need to process them. Running snip first reduces the work for subsequent layers.

```typescript
// Pre-API-call processing
const snipResult = snipCompactIfNeeded(messages, model, snipState);
if (snipResult.snipped) {
  // Messages have been physically removed
  // Token count is already reduced
}
```

**Frequency**: Only when near the context limit. Feature-gated (HISTORY_SNIP).

---

### Layer 3: Microcompact (Lesson 59)

**When**: After snip, during the pre-API-call phase. Runs on every turn.

**What**: Clears content of old tool results from compactable tools (Read, Grep, Glob, Edit, Write, Shell, WebFetch). Uses cached variant to preserve prompt cache.

**Why after snip**: Microcompact processes remaining messages that snip didn't remove. If snip already removed a segment, microcompact skips it. This avoids redundant work.

```typescript
// After snip, before API call
const { messages: compactedMessages, cacheEdits } = cachedMicroCompact(messages);
// compactedMessages = original messages (for cache compatibility)
// cacheEdits = edits to apply server-side
```

**Frequency**: Every turn. Always active (no feature gate). Lightweight.

---

### Layer 4: Context Collapse (Lesson 63)

**When**: After microcompact, during the pre-API-call phase. Only when enabled.

**What**: Stages progressive reductions in three levels — tool results, tool pairs, then reasoning blocks. Projects collapsed messages for the API call without committing.

**Why after microcompact**: Microcompact handles the simple cases (clearing old results). Context collapse handles the harder cases (compressing entire interaction segments). Running microcompact first means collapse only needs to address what microcompact couldn't.

**Interaction with Layer 5**: When context collapse is enabled, autocompact is suppressed. Collapse handles reduction itself, progressively.

```typescript
// After microcompact
if (contextCollapseEnabled) {
  const { projectedMessages, tokensFreed } = applyCollapsesIfNeeded(
    messages, model, collapseState
  );
  // Use projectedMessages for the API call
  // Actual messages are not yet mutated
}
```

**Frequency**: When approaching the context limit. Feature-gated.

---

### Layer 5: Autocompact (Lesson 60)

**When**: After microcompact (and after collapse projection if enabled), during the pre-API-call phase.

**What**: If the token count exceeds the warning threshold (effective window minus 13K buffer), summarizes the entire conversation. Two-phase: try session memory compaction first, then full compaction.

**Why after collapse**: If context collapse already brought the token count under the threshold, autocompact isn't needed. Autocompact only fires if the earlier layers weren't sufficient.

**Interaction with Layer 4**: Autocompact is suppressed when context collapse is enabled. They don't run simultaneously.

```typescript
// After microcompact and collapse (if applicable)
if (!contextCollapseEnabled) {
  yield* autoCompactIfNeeded(messages, model, autocompactState);
}
```

**Frequency**: When token count exceeds the warning threshold. Circuit breaker after 3 failures.

---

### Layer 6: Reactive Compact (Lesson 62)

**When**: After the API call returns a 413 error.

**What**: Three-phase recovery — (1) drain staged collapses, (2) full compaction, (3) terminal error.

**Why last**: Reactive compact is the emergency fallback. It only runs when all proactive measures (Layers 1-5) failed to keep the context within limits.

```typescript
try {
  const response = await callAPI(preparedMessages, model);
  // success — continue
} catch (error) {
  if (isPromptTooLong(error)) {
    yield* tryReactiveCompact(messages, model, error, state);
    // Retry the API call after compaction
  }
}
```

**Frequency**: Rare (~0.5% of conversations). No circuit breaker (must attempt recovery).

## The Query Loop: Where It All Connects

Here's the consolidated flow from the agent's query loop, showing where each layer plugs in:

```typescript
async function* queryLoop(
  messages: Message[],
  model: ModelId,
  state: AgentState
): AsyncGenerator<AgentEvent> {

  while (true) {
    // ── Layer 2: Snip ──
    const snipResult = snipCompactIfNeeded(
      messages, model, state.snip
    );
    if (snipResult.snipped) {
      yield { type: "snip", tokensFreed: snipResult.snipTokensFreed };
    }

    // ── Layer 3: Microcompact ──
    const { messages: mcMessages, cacheEdits } = cachedMicroCompact(messages);

    // ── Layer 4: Context Collapse (if enabled) ──
    let apiMessages = mcMessages;
    if (state.contextCollapseEnabled) {
      const collapse = applyCollapsesIfNeeded(messages, model, state.collapse);
      if (collapse.tokensFreed > 0) {
        apiMessages = collapse.projectedMessages;
      }
    }

    // ── Layer 5: Autocompact (if collapse not enabled) ──
    if (!state.contextCollapseEnabled) {
      yield* autoCompactIfNeeded(messages, model, state.autocompact);
      // messages may have been rewritten by compaction
      // Reapply microcompact on the new messages
      const recompacted = cachedMicroCompact(messages);
      apiMessages = recompacted.messages;
    }

    // ── Token check ──
    const tokenCount = estimateTokenCount(apiMessages);
    const warningState = calculateTokenWarningState(tokenCount, model);

    if (warningState.isAtBlockingLimit) {
      // Still too big after all proactive measures
      // This will be caught by reactive compact below
    }

    // ── API Call ──
    try {
      const response = await callAPI(apiMessages, model, cacheEdits);
      yield* processResponse(response, messages, state);

      // Check continue reason
      if (response.stopReason === "end_turn") break;
      // Otherwise, loop continues (tool_use, etc.)

    } catch (error) {
      if (isPromptTooLong(error)) {
        // ── Layer 6: Reactive Compact ──
        yield* tryReactiveCompact(messages, model, error, state);
        // Loop continues — retry the API call on next iteration
        continue;
      }
      throw error;
    }
  }
}
```

Note that Layer 1 (tool result budgets) isn't in this loop — it runs inside tool execution, before results are added to `messages`. By the time the query loop sees the messages, tool results are already budgeted.

## When Each Layer Kicks In

Here's a timeline showing which layers are active at different context sizes (for a 200K model):

```
Tokens:  0        50K       100K      150K      171K      184K    200K
         │         │         │         │         │         │        │
Layer 1: ████████████████████████████████████████████████████████████
         Always active (every tool call)

Layer 2: ─────────────────────────────────────────███████████████████
         Active near capacity (feature-gated)

Layer 3: ████████████████████████████████████████████████████████████
         Always active (every turn, lightweight)

Layer 4: ─────────────────────────────────────████████████████──────
         Active near threshold (feature-gated, suppresses L5)

Layer 5: ─────────────────────────────────────████████████████──────
         Active at warning threshold (unless L4 is enabled)

Layer 6: ─────────────────────────────────────────────────────██████
         Emergency only (after 413)
```

## Why Multiple Layers Are Needed

A single strategy can't handle all scenarios efficiently:

| Scenario | Best Layer | Why |
|----------|-----------|-----|
| Single grep returns 500K chars | Tool result budget | Stop it at the source |
| 30-turn conversation with stale results | Microcompact | Lightweight, preserves structure |
| 50-turn conversation approaching limit | Autocompact or Collapse | Need aggressive reduction |
| Long-abandoned exploration segment | Snip | Entire segment is dead weight |
| Estimation error causes 413 | Reactive compact | Emergency recovery needed |
| Gradual context growth on long task | Context collapse | Progressive, not all-or-nothing |

If you only had autocompact, you'd be summarizing constantly — losing useful detail before it's necessary. If you only had microcompact, you'd eventually run out of space because message structure still takes up room. If you only had tool budgets, the conversation would still grow unbounded.

The layered design means:
- **Most turns**: only Layer 1 and Layer 3 are active (cheap, fast)
- **Approaching limits**: Layer 4 or 5 kicks in (moderate cost)
- **Emergency**: Layer 6 handles it (expensive but necessary)
- **Rarely**: Layer 2 removes dead segments (targeted, impactful)

## The Information Preservation Hierarchy

Each layer trades off between space savings and information loss:

```
                Less info lost                More info lost
                ─────────────────────────────────────────────
Layer 1:        ▓░░░░░░░░░░░░░░░░░
Tool budget     (truncates one result)

Layer 3:        ░░░░▓▓░░░░░░░░░░░░
Microcompact    (clears old result content)

Layer 2:        ░░░░░░░▓▓▓░░░░░░░░
Snip            (removes message segments)

Layer 4:        ░░░░░░░░░░▓▓▓▓░░░░
Collapse        (progressive segment compression)

Layer 5:        ░░░░░░░░░░░░░░▓▓▓▓
Autocompact     (full conversation summarization)

Layer 6:        ░░░░░░░░░░░░░░░░▓▓▓
Reactive        (emergency, most aggressive)
```

The agent exhausts gentler strategies before resorting to more aggressive ones. This preserves the maximum amount of useful information at each point in the conversation.

## Cross-Layer State Management

The layers don't operate in complete isolation. They share state through the `AgentState` object:

```typescript
interface AgentState {
  messages: Message[];
  model: ModelId;

  // Layer 2
  snip: SnipState;

  // Layer 3
  microcompact: MicrocompactState;

  // Layer 4
  contextCollapseEnabled: boolean;
  collapse: CollapseState;

  // Layer 5
  autocompact: AutocompactState;

  // Cross-layer
  tokenCount: number;
  lastCompactionTime: number;
  compactionCount: number;
}
```

When one layer modifies messages, it affects all subsequent layers:
- Snip removes messages → microcompact has fewer messages to process
- Microcompact clears content → collapse/autocompact sees a lower token count
- Autocompact rewrites messages → all other state is reset (post-compact cleanup)
- Reactive compact may trigger any of the above as part of its recovery

## Observability: Tracking the Pipeline

Each layer emits events that are tracked for debugging and monitoring:

```typescript
type ContextManagementEvent =
  | { type: "tool_result_budgeted"; tool: string; original: number; budgeted: number }
  | { type: "snip"; tokensFreed: number; messagesRemoved: number }
  | { type: "microcompact"; resultsCleared: number; tokensFreed: number }
  | { type: "collapse_staged"; stage: number; tokensProjected: number }
  | { type: "collapse_drained"; tokensFreed: number }
  | { type: "autocompact_start"; tokenCount: number }
  | { type: "autocompact_complete"; method: string; tokensFreed: number }
  | { type: "reactive_compact_start"; reason: string }
  | { type: "reactive_compact_complete"; method: string; tokensFreed: number }
  | { type: "reactive_compact_terminal"; reason: string };
```

These events let you trace exactly what happened during a conversation:

```
Turn 1:  tool_result_budgeted (Read, 12000 → 12000, within budget)
Turn 5:  microcompact (3 results cleared, ~4200 tokens freed)
Turn 12: microcompact (5 results cleared, ~7800 tokens freed)
Turn 18: autocompact_start (168,000 tokens)
Turn 18: autocompact_complete (full_compact, 142,000 tokens freed)
Turn 30: microcompact (4 results cleared, ~5100 tokens freed)
Turn 35: tool_result_budgeted (Grep, 45000 → 20000, truncated)
```

## Putting It All Together: A Complete Session

Here's a realistic session showing when each layer activates:

```
Tokens   Event
──────   ─────
  5K     User: "Add dark mode to the app"
  8K     [L1] Read result budgeted (8K chars, within limit)
 15K     [L1] Grep result budgeted (35K → 20K chars, truncated)
 22K     Three more file reads
 35K     [L3] Microcompact: clear 2 old reads (saved ~5K)
 48K     More tool calls, edits, shell commands
 62K     [L3] Microcompact: clear 4 old results (saved ~12K)
 85K     Continued work — editing CSS files, running builds
100K     [L3] Microcompact: clear 6 old results (saved ~18K)
130K     Build failures, debugging cycle
155K     [L3] Microcompact: clear 5 old results (saved ~15K)
168K     [L5] Autocompact triggered (threshold: 171K)
 18K     Conversation summarized → continued working
 45K     More edits and testing after compaction
 78K     [L3] Microcompact: clear 3 old results (saved ~8K)
120K     Second round of heavy work
165K     [L5] Autocompact triggered again
 20K     Second summary → continued working
 35K     Final testing and cleanup
 38K     Task complete ✓

Total API tokens consumed: ~1.2M across 45 turns
Without context management: would have exceeded 200K at turn 25
```

The pipeline kept the conversation within bounds across 45 turns of work, with two autocompaction cycles and continuous microcompaction. The user experienced two brief pauses (~3 seconds each) for compaction. Everything else was transparent.

## Key Takeaways

1. **Six layers, ordered by aggressiveness** — tool budgets → snip → microcompact → collapse → autocompact → reactive compact
2. **Most turns use only Layers 1 and 3** — cheap, fast, always-on
3. **Layers interact through shared state** — each layer's output affects subsequent layers
4. **Progressive information loss** — gentler strategies are exhausted before aggressive ones
5. **The pipeline enables long sessions** — without it, complex tasks would fail after ~25 turns
6. **Observability is critical** — events from each layer enable debugging and tuning

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Layer Ordering
**Question:** List all six context management layers in order. For each, state whether it runs before or after the API call, whether it's always active or feature-gated, and what its primary trigger condition is.

[View Answer](../../answers/06-context-management/answer-65.md#exercise-1)

### Exercise 2 — Pipeline Orchestrator
**Challenge:** Write a `runContextPipeline` function that orchestrates the pre-API-call layers in order: snip, microcompact, context collapse (if enabled), and autocompact (if collapse is not enabled). It should accept a `PipelineConfig` and return `{ messages: Message[], events: string[] }` tracking which layers fired.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-65.md#exercise-2)

### Exercise 3 — Event Logger
**Challenge:** Define a `ContextManagementEvent` discriminated union type covering all six layers (tool_result_budgeted, snip, microcompact, collapse_staged, autocompact_complete, reactive_compact_complete). Then write a `logEvent(event: ContextManagementEvent)` function that produces a one-line human-readable log string for each event type.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-65.md#exercise-3)

### Exercise 4 — Scenario Trace
**Question:** Trace through a session where the agent starts at 5K tokens and grows to 195K over 35 turns. At which token counts do Layers 3, 5, and 6 activate (for a 200K model with 16K output reserve and 13K buffer)? Write out the key transition points and what happens at each.

[View Answer](../../answers/06-context-management/answer-65.md#exercise-4)

### Exercise 5 — Cross-Layer State
**Challenge:** Implement an `AgentContextState` class that holds the state for all six layers and provides a `resetAfterCompaction()` method that correctly resets all subsystem states. Include the token count recalculation.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-65.md#exercise-5)

---

*Previous: [Lesson 64 — Snip](64-snip.md)*

*This concludes Module 06: Context Management. Next up: Module 07.*
