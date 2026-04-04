# Lesson 51: Prompt Caching

## What Is Prompt Caching?

Every time you call a model API, the provider must **tokenize** your prompt — convert text to tokens, compute position embeddings, and run the tokens through the model's attention mechanism. Prompt caching lets the provider **store the processed state** of a prompt prefix and reuse it on subsequent calls.

Think of it like compiled code: the first compilation is expensive, but subsequent runs reuse the compiled binary.

```
First API call:
  [Tokenize system prompt] → [Process 8,000 tokens] → 240ms
  [Tokenize messages]      → [Process 2,000 tokens] → 60ms
  Total processing: 300ms

Second API call (with caching):
  [Cache hit: system prompt] → [Reuse cached state] → ~0ms
  [Tokenize messages]        → [Process 2,500 tokens] → 75ms
  Total processing: 75ms (75% faster)
```

## The Three-Part Cache Key

Anthropic's prompt caching uses a **prefix-based** cache key. The cache matches when the beginning of the new request is identical to the beginning of a previous request. The key is composed of three parts:

```typescript
interface CacheKey {
  systemPrompt: string;   // The system-role content
  userContext: string;     // System-injected user context
  systemContext: string;   // System-injected system context
}
```

In practice, these map to the message structure sent to the API:

```typescript
const apiRequest = {
  model: "claude-sonnet-4-20250514",
  system: [
    {
      type: "text",
      text: staticSystemPrompt,
      cache_control: { type: "ephemeral" },  // cache breakpoint
    },
    {
      type: "text",
      text: dynamicSystemPrompt,
    },
  ],
  messages: [
    // conversation history...
  ],
};
```

The `cache_control: { type: "ephemeral" }` marker tells the API: "Cache everything up to and including this block. On future requests, if this prefix is identical, reuse the cached state."

## How Claude Code Structures for Caching

Claude Code's system prompt is designed from the ground up for caching. The static/dynamic boundary (Lesson 50) directly corresponds to where the cache breakpoint is placed:

```typescript
async function buildCacheablePrompt(
  config: AgentConfig
): Promise<AnthropicSystemBlock[]> {
  const { static: staticSections, dynamic: dynamicSections } =
    await resolveSystemPromptSections();

  const staticContent = staticSections.join("\n\n");
  const dynamicContent = dynamicSections.join("\n\n");

  return [
    {
      type: "text",
      text: staticContent,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: dynamicContent,
      // No cache_control — this part is always reprocessed
    },
  ];
}
```

The result is a two-block system prompt where the first block is cached and the second is fresh every turn.

## Cache Hit Requirements

For a cache hit to occur, the cached prefix must be **byte-identical**. Not "similar" — identical. One character difference and the entire cache is invalidated.

```typescript
// Turn 1: Cache MISS (first time, nothing cached)
system: "You are an interactive CLI agent..." // 6,000 tokens
// → Cached ✓

// Turn 2: Cache HIT (identical prefix)
system: "You are an interactive CLI agent..." // same bytes
// → Cache reused ✓, 90% discount

// Turn 3: Cache MISS (someone changed the static content)
system: "You are an interactive CLI agent. " // extra space!
// → Cache invalidated ✗, full price
```

This is why Claude Code is fanatical about determinism in static sections.

## Tool Sorting for Cache Stability

Tools are part of the API request and affect caching. If tool definitions are sent in a different order on different turns, the cache breaks. Claude Code sorts tools deterministically:

```typescript
function prepareToolsForApi(
  tools: ToolDefinition[]
): AnthropicToolBlock[] {
  // Sort alphabetically by name for cache stability
  const sorted = [...tools].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return sorted.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

// Without sorting:
// Turn 1: [FileRead, Bash, Grep] → hash A
// Turn 2: [Bash, FileRead, Grep] → hash B (cache miss!)

// With sorting:
// Turn 1: [Bash, FileRead, Grep] → hash X
// Turn 2: [Bash, FileRead, Grep] → hash X (cache hit!)
```

This seems trivial, but tools are often loaded from dynamic sources (MCP servers, plugins) where insertion order isn't guaranteed.

## The Savings Math

Let's quantify the impact with Anthropic's actual pricing tiers:

```
Standard input tokens:  $3.00 per million
Cached input tokens:    $0.30 per million  (90% discount)
Cache write tokens:     $3.75 per million  (25% premium on first use)
```

For a 30-turn session with a 10,000-token system prompt (7,000 static + 3,000 dynamic):

```typescript
function calculateCacheSavings(
  staticTokens: number,
  dynamicTokens: number,
  turns: number
): { withCache: number; withoutCache: number; savings: number } {
  const standardRate = 3.0;   // $ per million
  const cacheReadRate = 0.30; // $ per million
  const cacheWriteRate = 3.75; // $ per million

  // Without caching: all tokens at standard rate
  const withoutCache =
    turns * (staticTokens + dynamicTokens) * (standardRate / 1_000_000);

  // With caching:
  // Turn 1: static at write rate + dynamic at standard
  // Turns 2-N: static at read rate + dynamic at standard
  const withCache =
    1 * staticTokens * (cacheWriteRate / 1_000_000) +   // first turn: cache write
    (turns - 1) * staticTokens * (cacheReadRate / 1_000_000) +  // subsequent: cache read
    turns * dynamicTokens * (standardRate / 1_000_000);  // dynamic: always standard

  return {
    withoutCache: Math.round(withoutCache * 10000) / 10000,
    withCache: Math.round(withCache * 10000) / 10000,
    savings: Math.round((withoutCache - withCache) * 10000) / 10000,
  };
}

// Example: 7,000 static + 3,000 dynamic, 30 turns
const result = calculateCacheSavings(7000, 3000, 30);
// withoutCache: $0.90
// withCache:    $0.3523
// savings:     $0.5477 (61% reduction)
```

## Cache Invalidation: notifyCompaction

Sometimes the cache *has* to break. The most important case is **context compaction** — when the conversation gets too long and the agent summarizes it to fit within the context window (you'll learn about this in Module 06).

Compaction changes the message history, which means the cache prefix based on that history is no longer valid. Claude Code tracks this:

```typescript
let cacheBreakCount = 0;

function notifyCompaction(): void {
  cacheBreakCount++;
  log.info(
    `Cache break #${cacheBreakCount} due to compaction`
  );
}

// In the agent loop:
if (needsCompaction(messages)) {
  messages = await compactMessages(messages);
  notifyCompaction();
}
```

Cache breaks from compaction are expected and unavoidable. The system prompt's static prefix will still cache correctly — it's the conversation history portion that loses its cache.

## Multi-Level Caching Strategy

Claude Code actually uses multiple cache breakpoints, not just one:

```typescript
async function buildMultiLevelCache(
  config: AgentConfig,
  messages: Message[]
): Promise<ApiRequest> {
  const staticSystem = getStaticSections().join("\n\n");
  const dynamicSystem = (await getDynamicSections()).join("\n\n");

  return {
    system: [
      {
        type: "text",
        text: staticSystem,
        cache_control: { type: "ephemeral" },  // Breakpoint 1
      },
      {
        type: "text",
        text: dynamicSystem,
      },
    ],
    messages: [
      ...messages.slice(0, -1),
      // Breakpoint 2 could be on the last user context block
      {
        ...messages[messages.length - 1],
        cache_control: { type: "ephemeral" },
      },
    ],
  };
}
```

Breakpoint 1 caches the static system prompt. Breakpoint 2 can cache the conversation history up to the latest message, so that on retries or follow-ups, even the conversation history is cached.

## Implementation Checklist

When implementing prompt caching in your own agent:

```typescript
// 1. Separate static from dynamic content
const { static: s, dynamic: d } = classifySections(sections);

// 2. Sort all non-deterministic collections
const sortedTools = tools.sort((a, b) => a.name.localeCompare(b.name));

// 3. Place cache breakpoints on static content
const systemBlocks = [
  { type: "text", text: s.join("\n\n"), cache_control: { type: "ephemeral" } },
  { type: "text", text: d.join("\n\n") },
];

// 4. Verify cache stability
function verifyCacheStability(): boolean {
  const prompt1 = getStaticSections().join("\n\n");
  const prompt2 = getStaticSections().join("\n\n");
  return prompt1 === prompt2;  // Must be true
}

// 5. Track cache performance
function logCacheMetrics(response: ApiResponse): void {
  const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens } =
    response.usage;

  const cacheHitRate = cache_read_input_tokens /
    (input_tokens + cache_read_input_tokens + cache_creation_input_tokens);

  console.log(`Cache hit rate: ${(cacheHitRate * 100).toFixed(1)}%`);
}
```

## Common Caching Pitfalls

### 1. Timestamps in Static Sections

```typescript
// BREAKS CACHE: timestamp changes every call
const staticSection = `Agent v1.0 | Started ${new Date().toISOString()}`;

// FIX: Move timestamp to dynamic section
const dynamicSection = `Current time: ${new Date().toISOString()}`;
```

### 2. Randomized Content

```typescript
// BREAKS CACHE: tip changes every call
const tips = ["Tip: Use Grep!", "Tip: Read first!", "Tip: Test often!"];
const staticSection = tips[Math.floor(Math.random() * tips.length)];

// FIX: Either pick deterministically or move to dynamic
```

### 3. Unsorted Tool Definitions

```typescript
// BREAKS CACHE: Map iteration order not guaranteed
const tools = new Map();
tools.set("Grep", grepDef);
tools.set("FileRead", readDef);
// Convert to sorted array before sending
```

### 4. Environment Leaks into Static Sections

```typescript
// BREAKS CACHE: CWD might change
const staticSection = `You are in ${process.cwd()}`;

// FIX: CWD goes in dynamic section
```

## What's Next

Caching handles the **system prompt** portion of cost optimization. But the system prompt also needs to include real-time information about the environment. Lesson 52 covers **environment context** — how Claude Code injects CWD, git status, platform info, and other runtime data into the prompt.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Cache Hit Requirements
**Question:** What does "byte-identical prefix" mean for prompt caching? Give three specific examples of changes that would break the cache even though the prompt is "semantically identical."

[View Answer](../../answers/05-prompt-engineering/answer-51.md#exercise-1)

### Exercise 2 — Build a Cacheable Prompt
**Challenge:** Write a function `buildCacheablePrompt(staticContent: string, dynamicContent: string): SystemPromptBlock[]` that returns an array of two blocks — the first with `cache_control: { type: "ephemeral" }` and the second without.

Write your solution in your IDE first, then check:

[View Answer](../../answers/05-prompt-engineering/answer-51.md#exercise-2)

### Exercise 3 — Cache Savings Calculator
**Challenge:** Write a function `calculateCacheSavings(staticTokens: number, dynamicTokens: number, turns: number): {withCache: number, withoutCache: number, savings: number}` using Anthropic pricing ($3.00/M standard, $0.30/M cache read, $3.75/M cache write).

Write your solution in your IDE first, then check:

[View Answer](../../answers/05-prompt-engineering/answer-51.md#exercise-3)

### Exercise 4 — Tool Sorting for Cache Stability
**Question:** Why must tool definitions be sorted deterministically before being sent to the API? What happens to cache hit rates if tools arrive in different orders on different turns? Describe the fix.

[View Answer](../../answers/05-prompt-engineering/answer-51.md#exercise-4)
