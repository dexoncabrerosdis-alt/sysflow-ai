# Answers: Lesson 45 — Cost Tracking

## Exercise 1
**Challenge:** Write a `calculateCost` function that returns the cost in USD with cache-aware pricing.

**Answer:**
```typescript
interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheCreationPerMillion: number;
  cacheReadPerMillion: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-20250514": {
    inputPerMillion: 15.0,
    outputPerMillion: 75.0,
    cacheCreationPerMillion: 18.75,
    cacheReadPerMillion: 1.5,
  },
  "claude-sonnet-4-20250514": {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheCreationPerMillion: 3.75,
    cacheReadPerMillion: 0.3,
  },
  "claude-haiku-3-20250307": {
    inputPerMillion: 0.25,
    outputPerMillion: 1.25,
    cacheCreationPerMillion: 0.3,
    cacheReadPerMillion: 0.03,
  },
};

function calculateCost(model: string, usage: TokenUsage): number {
  const pricing = PRICING[model] ?? PRICING["claude-sonnet-4-20250514"];

  const inputCost = (usage.input_tokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.outputPerMillion;
  const cacheCreateCost =
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
    pricing.cacheCreationPerMillion;
  const cacheReadCost =
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
    pricing.cacheReadPerMillion;

  return inputCost + outputCost + cacheCreateCost + cacheReadCost;
}
```
**Explanation:** Each token type has a different rate. Cache creation is slightly more expensive than standard input (25% premium), while cache reads are ~10x cheaper. For unknown models, we fall back to Sonnet pricing as a conservative estimate.

---

## Exercise 2
**Question:** Explain cache economics and calculate the cost difference for a 20-turn session with an 8,000-token system prompt using Sonnet.

**Answer:** Cache reads are cheaper because the API provider has already tokenized and pre-processed the prompt prefix. On subsequent calls, they can reuse that computed state instead of re-processing from scratch, saving both compute and latency. The savings are passed to the user. **Calculation:** Without caching: 20 turns × 8,000 tokens × ($3.00 / 1,000,000) = $0.48. With caching: Turn 1 cache write: 8,000 × ($3.75 / 1,000,000) = $0.03. Turns 2-20 cache reads: 19 × 8,000 × ($0.30 / 1,000,000) = $0.0456. Total with caching: $0.0756. **Savings: $0.404 (84% reduction)** on system prompt input costs alone.

---

## Exercise 3
**Challenge:** Write a `SessionCostTracker` class with per-model breakdowns.

**Answer:**
```typescript
interface CostEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  durationMs: number;
}

class SessionCostTracker {
  private calls: CostEntry[] = [];
  private byModel: Map<string, { cost: number; calls: number; inputTokens: number; outputTokens: number }> = new Map();

  addCall(
    model: string,
    usage: TokenUsage,
    durationMs: number
  ): void {
    const costUSD = calculateCost(model, usage);

    this.calls.push({
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      costUSD,
      durationMs,
    });

    const existing = this.byModel.get(model) ?? {
      cost: 0, calls: 0, inputTokens: 0, outputTokens: 0,
    };
    existing.cost += costUSD;
    existing.calls += 1;
    existing.inputTokens += usage.input_tokens;
    existing.outputTokens += usage.output_tokens;
    this.byModel.set(model, existing);
  }

  getTotalCost(): number {
    return this.calls.reduce((sum, c) => sum + c.costUSD, 0);
  }

  getSummary(): string {
    const total = this.getTotalCost();
    const lines: string[] = [`Total cost: $${total < 0.01 ? total.toFixed(4) : total.toFixed(2)}`];

    for (const [model, data] of this.byModel) {
      const shortName = model.split("-").slice(0, 2).join("-");
      lines.push(
        `${shortName}: ${data.calls} calls, $${data.cost.toFixed(4)} | ` +
        `In: ${data.inputTokens.toLocaleString()} | Out: ${data.outputTokens.toLocaleString()}`
      );
    }

    return lines.join("\n");
  }
}
```
**Explanation:** The tracker records every call and maintains per-model aggregates. The `getSummary()` method formats a human-readable breakdown showing call counts, costs, and token usage. Model names are shortened for display.

---

## Exercise 4
**Challenge:** Write a `formatCost` function with variable decimal precision.

**Answer:**
```typescript
function formatCost(costUSD: number): string {
  if (costUSD < 0.01) {
    return `$${costUSD.toFixed(4)}`;
  }
  return `$${costUSD.toFixed(2)}`;
}
```
**Explanation:** Sub-cent costs need more precision so the user can distinguish between $0.0023 and $0.0089. Once costs reach the cent level, two decimal places are standard and sufficient. This matches user expectations from typical financial displays.

---

## Exercise 5
**Question:** At which two points in the SSE stream does the API report token usage?

**Answer:** Token usage is reported at two points: (1) **`message_start`** — carries the input token counts, including `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`. These are known immediately because the API has already processed the entire input at this point. (2) **`message_delta`** (at the end of the stream) — carries `output_tokens`, the count of tokens the model generated. This can only be reported at the end because the output isn't known until the model finishes generating. You accumulate both into a single `TokenUsage` object to calculate the full cost for that call.
