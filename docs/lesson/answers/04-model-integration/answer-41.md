# Answers: Lesson 41 — Model Selection and Routing

## Exercise 1
**Question:** Describe the three levels of the model selection priority chain in order from highest to lowest. Give a concrete scenario for each.

**Answer:** (1) **Runtime override** (highest) — The model changes mid-conversation based on runtime conditions. Scenario: the conversation has grown beyond 200K tokens, so the system automatically routes to a model better suited for large contexts. (2) **User-specified override** — The user explicitly chooses a model via CLI flag, environment variable, or settings file. Scenario: a developer runs `claude --model opus` because they're working on a complex architecture refactor that benefits from deeper reasoning. (3) **Tier-based default** (lowest) — The subscription tier determines the default model when nothing else overrides it. Scenario: a Pro user starts a new session without specifying a model, so the system defaults to `claude-sonnet-4-20250514`.

---

## Exercise 2
**Challenge:** Write a function `resolveModelAlias(input: string): string` that maps shorthand aliases to full model names.

**Answer:**
```typescript
function resolveModelAlias(input: string): string {
  const aliases: Record<string, string> = {
    opus: "claude-opus-4-20250514",
    sonnet: "claude-sonnet-4-20250514",
    haiku: "claude-haiku-3-20250307",
    best: "claude-opus-4-20250514",
  };

  const normalized = input.toLowerCase().trim();
  return aliases[normalized] ?? input;
}
```
**Explanation:** The function normalizes input to lowercase and trims whitespace for case-insensitive matching. Known aliases map to full model identifiers. The `best` alias always maps to the most capable model. Unknown inputs are returned as-is, allowing users to specify full model names directly (future-proofing for new models).

---

## Exercise 3
**Challenge:** Write a `getModelConfig` function that returns a configuration object for each model.

**Answer:**
```typescript
interface ModelConfig {
  modelName: string;
  maxOutputTokens: number;
  contextWindow: number;
  supportsExtendedThinking: boolean;
  supportsImages: boolean;
}

function getModelConfig(modelName: string): ModelConfig {
  const configs: Record<string, ModelConfig> = {
    "claude-opus-4-20250514": {
      modelName: "claude-opus-4-20250514",
      maxOutputTokens: 16384,
      contextWindow: 200_000,
      supportsExtendedThinking: true,
      supportsImages: true,
    },
    "claude-sonnet-4-20250514": {
      modelName: "claude-sonnet-4-20250514",
      maxOutputTokens: 16384,
      contextWindow: 200_000,
      supportsExtendedThinking: true,
      supportsImages: true,
    },
    "claude-haiku-3-20250307": {
      modelName: "claude-haiku-3-20250307",
      maxOutputTokens: 8192,
      contextWindow: 200_000,
      supportsExtendedThinking: false,
      supportsImages: true,
    },
  };

  return configs[modelName] ?? configs["claude-sonnet-4-20250514"];
}
```
**Explanation:** Each model has distinct capabilities — Haiku has a lower output token limit and doesn't support extended thinking. The fallback to Sonnet config for unknown models is defensive — it prevents crashes when a new model name appears that isn't in the lookup table yet.

---

## Exercise 4
**Question:** Why is the CLI flag given highest priority among user override sources? What use case does each level serve?

**Answer:** The CLI flag has highest priority because it's the most explicit and immediate — the user typed it right now for this specific session. It serves ad-hoc overrides: "I want Opus for this one complex task." Environment variables have second priority and serve automation use cases — CI/CD pipelines set `CLAUDE_MODEL=haiku` for cost efficiency across all runs. Settings files have lowest priority and serve persistent preferences — a developer who always prefers Opus sets it once in `~/.claude/settings.json` and doesn't need to specify it again. The ordering follows the principle of specificity: more specific (this invocation) beats more general (all invocations).
