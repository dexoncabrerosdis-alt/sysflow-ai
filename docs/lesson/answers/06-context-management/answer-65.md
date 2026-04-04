# Answers: Lesson 65 — Full Compaction Pipeline

## Exercise 1
**Question:** List all six context management layers in order with their properties.

**Answer:**

| Layer | Name | Timing | Always Active? | Trigger |
|-------|------|--------|---------------|---------|
| 1 | Tool Result Budget | Before API call (at tool execution) | Yes | Every tool call |
| 2 | Snip | Before API call | Feature-gated (HISTORY_SNIP) | Near context capacity |
| 3 | Microcompact | Before API call | Yes | Every turn (lightweight) |
| 4 | Context Collapse | Before API call | Feature-gated | Near warning threshold; suppresses Layer 5 |
| 5 | Autocompact | Before API call | Yes (unless L4 enabled) | Token count exceeds warning threshold (171K for 200K model) |
| 6 | Reactive Compact | After API call | Yes | API returns 413 error |

---

## Exercise 2
**Challenge:** Write a `runContextPipeline` function.

**Answer:**

```typescript
interface PipelineConfig {
  messages: Message[];
  model: { contextWindow: number; maxOutput: number };
  contextCollapseEnabled: boolean;
  snipEnabled: boolean;
  snipState: any;
  collapseState: any;
  autocompactState: any;
}

interface PipelineResult {
  messages: Message[];
  events: string[];
}

async function runContextPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const { messages, model, contextCollapseEnabled, snipEnabled } = config;
  const events: string[] = [];
  const effectiveWindow = model.contextWindow - model.maxOutput;
  const warningThreshold = effectiveWindow - 13_000;

  // Layer 2: Snip
  if (snipEnabled) {
    const snipResult = snipCompactIfNeeded(messages, warningThreshold);
    if (snipResult.snipped) {
      events.push(`snip: ${snipResult.tokensFreed} tokens freed`);
    }
  }

  // Layer 3: Microcompact
  const mcResult = cachedMicroCompact(messages);
  if (mcResult.cacheEdits.length > 0) {
    events.push(`microcompact: ${mcResult.cacheEdits.length} results cleared`);
  }

  // Layer 4: Context Collapse (if enabled, suppresses Layer 5)
  if (contextCollapseEnabled) {
    const collapseResult = applyCollapsesIfNeeded(messages, warningThreshold, config.collapseState);
    if (collapseResult.tokensFreed > 0) {
      events.push(`collapse: ${collapseResult.tokensFreed} tokens projected freed`);
    }
  } else {
    // Layer 5: Autocompact
    const tokenCount = estimateTokenCount(messages);
    if (tokenCount >= warningThreshold) {
      const compacted = await autoCompactIfNeeded(messages, config.autocompactState);
      if (compacted) {
        events.push(`autocompact: conversation summarized`);
      }
    }
  }

  return { messages, events };
}
```

**Explanation:** The function runs layers in order with proper interaction — snip first, then microcompact, then either collapse or autocompact (never both). The events array provides an audit trail of which layers activated.

---

## Exercise 3
**Challenge:** Define a `ContextManagementEvent` union type and `logEvent` function.

**Answer:**

```typescript
type ContextManagementEvent =
  | { type: "tool_result_budgeted"; tool: string; original: number; budgeted: number }
  | { type: "snip"; tokensFreed: number; messagesRemoved: number }
  | { type: "microcompact"; resultsCleared: number; tokensFreed: number }
  | { type: "collapse_staged"; stage: number; tokensProjected: number }
  | { type: "autocompact_complete"; method: string; tokensFreed: number }
  | { type: "reactive_compact_complete"; method: string; tokensFreed: number };

function logEvent(event: ContextManagementEvent): string {
  switch (event.type) {
    case "tool_result_budgeted":
      return `[L1 Budget] ${event.tool}: ${event.original} → ${event.budgeted} chars`;
    case "snip":
      return `[L2 Snip] Removed ${event.messagesRemoved} messages, freed ${event.tokensFreed} tokens`;
    case "microcompact":
      return `[L3 Microcompact] Cleared ${event.resultsCleared} results, freed ${event.tokensFreed} tokens`;
    case "collapse_staged":
      return `[L4 Collapse] Stage ${event.stage} projected to free ${event.tokensProjected} tokens`;
    case "autocompact_complete":
      return `[L5 Autocompact] ${event.method}: freed ${event.tokensFreed} tokens`;
    case "reactive_compact_complete":
      return `[L6 Reactive] ${event.method}: freed ${event.tokensFreed} tokens`;
  }
}
```

**Explanation:** The discriminated union uses the `type` field for exhaustive pattern matching. Each log line includes the layer number for quick identification and the key metric (tokens freed or chars budgeted).

---

## Exercise 4
**Question:** Trace through a session growing from 5K to 195K tokens over 35 turns.

**Answer:** For a 200K model with 16K output reserve and 13K buffer: effective window = 184K, warning threshold = 171K, blocking threshold = 184K.

- **Turns 1-15 (~5K to ~80K):** Only Layer 3 (microcompact) is active each turn, clearing old tool results. No other layers needed.
- **~Turn 20 (~120K):** Microcompact continues clearing old results but can't keep up with growth.
- **~Turn 25 (~171K):** Layer 5 (autocompact) triggers at the warning threshold. Conversation is summarized to ~18K tokens.
- **Turns 26-33 (~18K to ~160K):** Microcompact active again. Context rebuilds from the summary.
- **~Turn 34 (~171K):** Autocompact triggers again, summarizes to ~20K.
- **If estimation error at any point pushes past 184K:** Layer 6 (reactive compact) fires after a 413 error, performing emergency recovery.

---

## Exercise 5
**Challenge:** Implement an `AgentContextState` class.

**Answer:**

```typescript
class AgentContextState {
  messages: Message[] = [];
  tokenCount: number = 0;
  lastCompactionTime: number = 0;
  compactionCount: number = 0;

  // Layer states
  snipState = { lastSnipTime: 0 };
  microcompactState = { trackedResults: new Map<number, boolean>() };
  collapseEnabled: boolean = false;
  collapseState = {
    stagedCollapses: new Map<number, any[]>(),
    pendingCollapses: false,
  };
  autocompactState = {
    consecutiveFailures: 0,
    temporaryThresholdReduction: 0,
    turnsSinceLastCompact: 0,
  };

  resetAfterCompaction(): void {
    // Reset microcompact — old messages no longer exist
    this.microcompactState.trackedResults.clear();

    // Reset collapse state — staged projections are invalid
    this.collapseState.stagedCollapses.clear();
    this.collapseState.pendingCollapses = false;

    // Reset autocompact tracking
    this.autocompactState.turnsSinceLastCompact = 0;
    this.autocompactState.temporaryThresholdReduction = 0;

    // Update compaction metadata
    this.lastCompactionTime = Date.now();
    this.compactionCount++;

    // Recalculate token count from current messages
    this.tokenCount = this.messages.reduce(
      (sum, m) => sum + Math.ceil(m.content.length * 0.25),
      0
    );
  }
}
```

**Explanation:** The `resetAfterCompaction` method clears all stale state that referenced pre-compaction messages. The token count is recalculated from the new (compacted) messages rather than relying on the old count minus estimated savings, ensuring accuracy.
