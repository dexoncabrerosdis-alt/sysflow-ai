# Lesson 41: Model Selection and Routing

## What You'll Learn

A real coding agent doesn't hardcode a model name. It picks the right model based
on user preferences, subscription tiers, runtime conditions, and even conversation
length. In this lesson, you'll study the model selection pipeline in Claude Code —
a priority chain that resolves a model name from multiple competing sources.

## Why Multiple Models?

Different models have different strengths:

| Model | Strengths | Tradeoffs |
|---|---|---|
| `claude-opus-4-20250514` | Deep reasoning, complex architecture | Slower, more expensive |
| `claude-sonnet-4-20250514` | Great balance of speed and quality | Default for most tasks |
| `claude-haiku-3-20250307` | Very fast, cheap | Less capable on hard tasks |

An agent wants to use the cheapest model that can handle the current task. For
simple file reads, Haiku is fine. For complex refactoring, you want Opus.

## The Selection Priority Chain

Claude Code resolves the model through a priority chain. The first source that
returns a value wins:

```typescript
function getMainLoopModel(): string {
  // Priority 1: Runtime override (mid-conversation switching)
  const runtime = getRuntimeMainLoopModel();
  if (runtime) return runtime;

  // Priority 2: User-specified model (CLI flag, env var, settings)
  const userSpecified = getUserSpecifiedModelSetting();
  if (userSpecified) return parseUserSpecifiedModel(userSpecified);

  // Priority 3: Tier-based default
  return getDefaultMainLoopModel();
}
```

Let's examine each level.

## Priority 3: Tier-Based Defaults — `getDefaultMainLoopModel()`

The lowest priority. Every user has a subscription tier that determines their
default model:

```typescript
type SubscriptionTier = "free" | "pro" | "team" | "enterprise";

function getDefaultMainLoopModel(): string {
  const tier = getCurrentSubscriptionTier();

  switch (tier) {
    case "free":
      return "claude-sonnet-4-20250514";
    case "pro":
      return "claude-sonnet-4-20250514";
    case "team":
      return "claude-sonnet-4-20250514";
    case "enterprise":
      return "claude-sonnet-4-20250514";
    default:
      return "claude-sonnet-4-20250514";
  }
}
```

Right now every tier defaults to Sonnet. But the infrastructure exists so that
different tiers can be routed to different models — for example, a future where
free users default to Haiku.

## Priority 2: User Overrides — `getUserSpecifiedModelSetting()`

Users can override the default at three levels. The function checks them in order:

```typescript
function getUserSpecifiedModelSetting(): string | undefined {
  // Source 1: CLI flag (--model opus)
  const cliModel = getCliFlag("model");
  if (cliModel) return cliModel;

  // Source 2: Environment variable
  const envModel = process.env.CLAUDE_MODEL;
  if (envModel) return envModel;

  // Source 3: Settings file (~/.claude/settings.json)
  const settingsModel = getSettings().model;
  if (settingsModel) return settingsModel;

  return undefined;
}
```

The CLI flag has highest priority — it's the most explicit. Environment variables
are next (useful for CI/CD). Settings files are last (persistent preference).

## Parsing Model Aliases — `parseUserSpecifiedModel()`

Users don't want to type `claude-opus-4-20250514`. They want to type `opus`.
The parser resolves aliases to full model names:

```typescript
function parseUserSpecifiedModel(input: string): string {
  const aliases: Record<string, string> = {
    "opus":      "claude-opus-4-20250514",
    "sonnet":    "claude-sonnet-4-20250514",
    "haiku":     "claude-haiku-3-20250307",
  };

  const lowered = input.toLowerCase().trim();

  if (aliases[lowered]) {
    return aliases[lowered];
  }

  // If it's not an alias, assume it's a full model name
  return input;
}
```

Some special aliases trigger more than just model selection:

```typescript
function parseUserSpecifiedModel(input: string): string {
  const lowered = input.toLowerCase().trim();

  switch (lowered) {
    case "opus":
      return "claude-opus-4-20250514";

    case "sonnet":
      return "claude-sonnet-4-20250514";

    case "haiku":
      return "claude-haiku-3-20250307";

    case "best":
      return "claude-opus-4-20250514";

    default:
      return input;
  }
}
```

The `best` alias always maps to the most capable model available. This future-
proofs user configurations — when a better model ships, `best` automatically
updates.

## Priority 1: Runtime Switching — `getRuntimeMainLoopModel()`

The most interesting level. The model can change mid-conversation based on
runtime conditions:

```typescript
function getRuntimeMainLoopModel(): string | undefined {
  // Condition 1: Context window exceeding a threshold
  const estimatedTokens = getCurrentEstimatedTokens();
  if (estimatedTokens > 200_000) {
    return getLargeContextModel();
  }

  return undefined;
}
```

### Context Length Switching

When a conversation exceeds 200K tokens, some models handle it better than others.
The runtime switcher can route to a model with a larger effective context window:

```typescript
function getLargeContextModel(): string {
  return "claude-sonnet-4-20250514";
}
```

### Plan Mode Switching

Claude Code has a "plan mode" where the model reasons through a problem before
acting. Users can configure separate models for code and plan modes — e.g., Opus
for planning (better reasoning) and Sonnet for coding (faster execution).

## The Model Configuration Object

In practice, model selection returns more than just a name. It returns a
configuration object:

```typescript
interface ModelConfig {
  modelName: string;
  maxOutputTokens: number;
  contextWindow: number;
  supportsExtendedThinking: boolean;
  supportsImages: boolean;
  supportsPrefill: boolean;
}

function getModelConfig(modelName: string): ModelConfig {
  const configs: Record<string, ModelConfig> = {
    "claude-opus-4-20250514": {
      modelName: "claude-opus-4-20250514",
      maxOutputTokens: 16384,
      contextWindow: 200_000,
      supportsExtendedThinking: true,
      supportsImages: true,
      supportsPrefill: true,
    },
    "claude-sonnet-4-20250514": {
      modelName: "claude-sonnet-4-20250514",
      maxOutputTokens: 16384,
      contextWindow: 200_000,
      supportsExtendedThinking: true,
      supportsImages: true,
      supportsPrefill: true,
    },
    "claude-haiku-3-20250307": {
      modelName: "claude-haiku-3-20250307",
      maxOutputTokens: 8192,
      contextWindow: 200_000,
      supportsExtendedThinking: false,
      supportsImages: true,
      supportsPrefill: true,
    },
  };

  return configs[modelName] ?? configs["claude-sonnet-4-20250514"];
}
```

This configuration drives downstream decisions — `max_tokens` in the API call,
whether to enable extended thinking, and the effective context window for token
counting.

## How It All Connects

Here's the complete flow from "I need a model" to "here's the API call":

```
getMainLoopModel()
    │
    ├── getRuntimeMainLoopModel()    ← Context > 200K? Plan mode?
    │     │
    │     └── (returns model or undefined)
    │
    ├── getUserSpecifiedModelSetting() ← CLI flag? Env var? Settings?
    │     │
    │     └── parseUserSpecifiedModel()  ← "opus" → "claude-opus-4-20250514"
    │
    └── getDefaultMainLoopModel()      ← Tier-based fallback
          │
          └── "claude-sonnet-4-20250514"

    ▼
getModelConfig(resolvedModel)
    │
    ▼
{
  modelName: "claude-sonnet-4-20250514",
  maxOutputTokens: 16384,
  contextWindow: 200_000,
  ...
}
    │
    ▼
queryModelWithStreaming(..., modelConfig.modelName, modelConfig.maxOutputTokens)
```

## Testing Model Selection

Because model selection is a pure function chain with no side effects, it's highly
testable — inject a CLI flag and assert it overrides the tier default, clear all
overrides and verify the fallback, set an alias and confirm it resolves correctly.

## Key Takeaways

1. Model selection is a priority chain: runtime → user override → tier default
2. Users specify models via CLI flags, environment variables, or settings files
3. Aliases like `opus`, `sonnet`, `haiku`, `best` resolve to full model names
4. Runtime switching handles context length thresholds and plan mode
5. Model config includes capabilities (extended thinking, images, context window)
6. The selection chain is pure functions — easy to test, easy to extend

## Next Lesson

You've selected a model and made a call. But what happens when the call fails?
Networks drop, APIs return errors, rate limits hit. Next, you'll learn about the
retry system — the async generator that absorbs transient failures so the agent
loop doesn't have to.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Priority Chain
**Question:** List the three levels of the model selection priority chain from highest to lowest priority. Give a concrete example of when each level would provide the model name.

[View Answer](../../answers/04-model-integration/answer-41.md#exercise-1)

### Exercise 2 — Model Alias Parser
**Challenge:** Write a function `resolveModelAlias(input: string): string` that maps short aliases (`"opus"`, `"sonnet"`, `"haiku"`, `"best"`) to their full model names. If the input isn't a known alias, return it unchanged. Handle case-insensitivity and leading/trailing whitespace.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-41.md#exercise-2)

### Exercise 3 — Model Config Lookup
**Challenge:** Write a `getModelConfig(modelName: string)` function that returns an object with `maxOutputTokens`, `contextWindow`, `supportsExtendedThinking`, and `supportsImages` fields. Include configs for Opus, Sonnet, and Haiku, with Sonnet as the default fallback.

Write your solution in your IDE first, then check:

[View Answer](../../answers/04-model-integration/answer-41.md#exercise-3)

### Exercise 4 — Why Pure Functions?
**Question:** The lesson says the model selection chain is "pure functions — easy to test, easy to extend." Why is it important that model selection has no side effects? How would you unit test the priority chain to verify that a CLI flag overrides the tier default?

[View Answer](../../answers/04-model-integration/answer-41.md#exercise-4)
