# Lesson 45: Cost Tracking

## What You'll Learn

Every API call costs money. An aggressive coding agent can make 20-50 API calls in
a single session, each with thousands of input tokens and hundreds of output tokens.
Without cost tracking, users have no visibility into spend until they check their
billing dashboard. In this lesson, you'll study how Claude Code tracks costs in
real time, per-model, with cache-aware pricing.

## Why Real-Time Cost Tracking?

A 30-minute session might make 35 API calls with a mix of Sonnet and Opus. Without
cost tracking, the user could spend $15 without realizing it. With tracking, they
see a running total and can stop early if cost exceeds their budget.

## The Cost Tracker State

The tracker accumulates costs across the entire session:

```typescript
interface SessionCosts {
  totalCostUSD: number;
  calls: CostEntry[];
  byModel: Map<string, ModelCostBreakdown>;
}

interface CostEntry {
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUSD: number;
  durationMs: number;
}

interface ModelCostBreakdown {
  model: string;
  totalCostUSD: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  callCount: number;
}
```

Every API call produces a `CostEntry`. The `byModel` map aggregates for per-model
reporting.

## `addToTotalSessionCost()`: Recording a Call

After each successful API call, the cost tracker records the result:

```typescript
const sessionCosts: SessionCosts = {
  totalCostUSD: 0,
  calls: [],
  byModel: new Map(),
};

function addToTotalSessionCost(
  model: string,
  usage: TokenUsage,
  durationMs: number
): void {
  const costUSD = calculateUSDCost(model, usage);

  const entry: CostEntry = {
    timestamp: Date.now(),
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    costUSD,
    durationMs,
  };

  sessionCosts.calls.push(entry);
  sessionCosts.totalCostUSD += costUSD;

  // Update per-model breakdown
  const existing = sessionCosts.byModel.get(model) ?? {
    model,
    totalCostUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    callCount: 0,
  };

  existing.totalCostUSD += costUSD;
  existing.totalInputTokens += entry.inputTokens;
  existing.totalOutputTokens += entry.outputTokens;
  existing.totalCacheCreationTokens += entry.cacheCreationTokens;
  existing.totalCacheReadTokens += entry.cacheReadTokens;
  existing.callCount += 1;

  sessionCosts.byModel.set(model, existing);
}
```

This is called from the stream processing code after `message_stop`:

```typescript
case "message_stop":
  addToTotalSessionCost(
    currentModel,
    accumulatedUsage,
    Date.now() - callStartTime
  );
  yield { type: "turn_complete", usage: accumulatedUsage };
  break;
```

## `calculateUSDCost()`: Per-Model Pricing

Different models have different prices, and different token types have different
rates. The pricing function encodes these:

```typescript
interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheCreationPerMillion: number;
  cacheReadPerMillion: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-20250514": {
    inputPerMillion: 15.00,
    outputPerMillion: 75.00,
    cacheCreationPerMillion: 18.75,
    cacheReadPerMillion: 1.50,
  },
  "claude-sonnet-4-20250514": {
    inputPerMillion: 3.00,
    outputPerMillion: 15.00,
    cacheCreationPerMillion: 3.75,
    cacheReadPerMillion: 0.30,
  },
  "claude-haiku-3-20250307": {
    inputPerMillion: 0.25,
    outputPerMillion: 1.25,
    cacheCreationPerMillion: 0.30,
    cacheReadPerMillion: 0.03,
  },
};

function calculateUSDCost(model: string, usage: TokenUsage): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    // Unknown model — use Sonnet pricing as a conservative estimate
    return calculateUSDCost("claude-sonnet-4-20250514", usage);
  }

  const inputCost =
    (usage.input_tokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost =
    (usage.output_tokens / 1_000_000) * pricing.outputPerMillion;
  const cacheCreationCost =
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
    pricing.cacheCreationPerMillion;
  const cacheReadCost =
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
    pricing.cacheReadPerMillion;

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}
```

Notice the cache economics: cache reads are **10x cheaper** than fresh input tokens.
For a coding agent that sends the same system prompt and tool definitions on every
call, caching saves 80%+ on input costs.

## Token Usage from the API

The API returns usage at two points in the stream: `message_start` carries input
token counts (including `cache_creation_input_tokens` and `cache_read_input_tokens`),
while `message_delta` at the end carries `output_tokens`. You accumulate both into
a `TokenUsage` object to calculate the full cost for that call.

## Persisting Costs to Disk

Session costs are saved to `~/.claude/costs/<sessionId>.json` as human-readable
JSON after every API call and on session exit. The file contains the full breakdown:
total cost, per-model aggregates, and individual call entries. This lets users
analyze spending patterns after a session ends.

## Cost Display in the CLI

Claude Code shows cost information in its status bar:

```typescript
function formatCostDisplay(): string {
  const cost = sessionCosts.totalCostUSD;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatUsageSummary(): string {
  const lines: string[] = [`Total cost: ${formatCostDisplay()}`, ""];

  for (const [model, breakdown] of sessionCosts.byModel) {
    const shortName = model.split("-").slice(0, 2).join("-");
    lines.push(`${shortName}: ${breakdown.callCount} calls, $${breakdown.totalCostUSD.toFixed(4)}`);
    lines.push(`  In: ${breakdown.totalInputTokens.toLocaleString()} | Out: ${breakdown.totalOutputTokens.toLocaleString()} | Cache: ${breakdown.totalCacheReadTokens.toLocaleString()}`);
  }

  return lines.join("\n");
}
```

A typical display:

```
Total cost: $0.48
claude-sonnet: 11 calls, $0.3891
  In: 523,400 | Out: 18,200 | Cache: 412,000
claude-opus: 1 calls, $0.0932
  In: 52,000 | Out: 3,400 | Cache: 48,000
```

## Integration with the Agent Loop

Cost tracking hooks into the stream processing — after every `message_stop`,
the cost is recorded and saved:

```typescript
async function* agentLoop(context: AgentContext) {
  const sessionId = crypto.randomUUID();

  while (true) {
    const callStart = Date.now();

    for await (const event of queryModelWithStreaming(/* ... */)) {
      yield event;

      if (event.type === "turn_complete") {
        addToTotalSessionCost(context.currentModel, event.usage, Date.now() - callStart);
        await saveCurrentSessionCosts(sessionId);
      }
    }

    if (!shouldContinue(context)) break;
  }

  await saveCurrentSessionCosts(sessionId);
}
```

Beyond tokens, Claude Code also tracks other billable operations like web search
requests. As new billable features launch, the tracker extends to accommodate them.

## Key Takeaways

1. Every API call records model, tokens (input/output/cache), cost, and duration
2. `calculateUSDCost()` applies per-model pricing with separate cache token rates
3. Cache reads are ~10x cheaper than fresh input — caching matters enormously
4. Costs persist to disk as JSON for post-session analysis
5. The CLI shows a running cost total with per-model breakdowns
6. Cost tracking enables budget-aware model selection

## Module Summary

Over these 10 lessons, you've built a complete picture of model integration:

- **API basics**: HTTP POST, content blocks, tool declarations
- **Streaming**: SSE protocol, event lifecycle, stall detection
- **Service layer**: parameter building, retry wrapping, stream processing
- **Message formatting**: normalization, tool result pairing, API compliance
- **Token counting**: estimation heuristics, context window management
- **Model selection**: priority chains, aliases, runtime switching
- **Retries**: exponential backoff, jitter, error classification
- **Rate limits**: 429 vs 529 handling, unattended mode, fast mode
- **Fallbacks**: mid-stream model switching, state recovery
- **Cost tracking**: per-call recording, cache-aware pricing, budget awareness

In the next module, you'll learn about prompt engineering — how the system prompt,
tool descriptions, and message formatting shape the model's behavior.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Calculate API Call Cost
**Challenge:** Write a function `calculateCost(model: string, usage: {input_tokens: number, output_tokens: number, cache_creation_input_tokens?: number, cache_read_input_tokens?: number}): number` that returns the cost in USD. Include pricing for Sonnet ($3/$15 per million input/output), Opus ($15/$75), and Haiku ($0.25/$1.25). Handle cache tokens at their respective rates.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-45.md#exercise-1)

### Exercise 2 — Cache Economics
**Question:** Explain why cache reads are ~10x cheaper than fresh input tokens. In a 20-turn session where the system prompt is 8,000 tokens, calculate the cost difference between caching and not caching (use Sonnet pricing).

[View Answer](../../answers/04-model-integration/answer-45.md#exercise-2)

### Exercise 3 — Session Cost Tracker
**Challenge:** Write a `SessionCostTracker` class that records API call costs and provides `addCall(model, usage, durationMs)`, `getTotalCost(): number`, and `getSummary(): string` methods. The summary should show per-model breakdowns.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-45.md#exercise-3)

### Exercise 4 — Cost Display Formatting
**Challenge:** Write a function `formatCost(costUSD: number): string` that formats a cost value for display. Costs below $0.01 should show 4 decimal places (e.g., `$0.0023`), costs at or above $0.01 should show 2 decimal places (e.g., `$0.48`).

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-45.md#exercise-4)

### Exercise 5 — Token Usage from Stream Events
**Question:** At which two points in the SSE stream does the API report token usage? What specific token counts does each point provide, and why are they reported at different times?

[View Answer](../../answers/04-model-integration/answer-45.md#exercise-5)
