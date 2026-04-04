# Lesson 106: Feature Flags

## The Deployment Problem

You've built a new context management strategy. It works in testing. But you're shipping to millions of users. If it has a subtle bug — say it drops important context 1% of the time — you can't just push a fix. Users are mid-session. Deployments take time. Rollbacks are disruptive.

Feature flags solve this by decoupling **deployment** from **release**. Code ships with the flag disabled. You turn it on for 1% of users. Monitor. Increase to 10%. Monitor. Roll to 100%. If something breaks, flip the flag — instant rollback, no deployment needed.

## Compile-Time Flags: feature()

Claude Code uses compile-time feature flags via Bun's bundler:

```typescript
import { feature } from "bun:bundle";

function manageContext(messages: MessageParam[]): MessageParam[] {
  if (feature("CONTEXT_COLLAPSE")) {
    return collapseOldContext(messages);
  } else {
    return truncateOldMessages(messages);
  }
}
```

When `CONTEXT_COLLAPSE` is `false` at build time, the bundler replaces `feature("CONTEXT_COLLAPSE")` with `false`. Then dead code elimination removes the entire `if` branch:

```typescript
// After bundling with CONTEXT_COLLAPSE=false:
function manageContext(messages) {
  return truncateOldMessages(messages);
}
```

The `collapseOldContext` function and all its imports are removed from the bundle entirely. The binary is smaller. There's no runtime cost for disabled features.

## How feature() Works Under the Hood

The `bun:bundle` module provides compile-time constants:

```typescript
// Build script
import { build } from "bun";

await build({
  entrypoints: ["./src/cli.tsx"],
  outdir: "./dist",
  define: {
    'feature("CONTEXT_COLLAPSE")': "true",
    'feature("HISTORY_SNIP")': "true",
    'feature("CACHED_MICROCOMPACT")': "false",
    'feature("KAIROS")': "false",
    'feature("PROACTIVE")': "true",
  },
});
```

Each `feature()` call is replaced with its literal boolean value at build time. The bundler's tree-shaker then removes unreachable code paths. This is the same technique used for `process.env.NODE_ENV === "production"` in React.

## Runtime Flags via Environment Variables

Not everything can be compile-time. Some flags need to change without rebuilding:

```typescript
interface RuntimeFlags {
  VERBOSE_LOGGING: boolean;
  MAX_RETRIES: number;
  EXPERIMENTAL_TOOLS: boolean;
  STREAMING_BATCH_SIZE: number;
}

function getRuntimeFlags(): RuntimeFlags {
  return {
    VERBOSE_LOGGING:
      process.env.CLAUDE_CODE_VERBOSE === "true",

    MAX_RETRIES:
      parseInt(process.env.CLAUDE_CODE_MAX_RETRIES ?? "3"),

    EXPERIMENTAL_TOOLS:
      process.env.CLAUDE_CODE_EXPERIMENTAL_TOOLS === "true",

    STREAMING_BATCH_SIZE:
      parseInt(process.env.CLAUDE_CODE_STREAMING_BATCH_SIZE ?? "1"),
  };
}
```

Runtime flags are checked at execution time. They can be set per-invocation:

```bash
CLAUDE_CODE_VERBOSE=true claude "debug this issue"
CLAUDE_CODE_MAX_RETRIES=5 claude "deploy to production"
```

## Compile-Time vs Runtime: When to Use Each

| Compile-Time (`feature()`) | Runtime (env vars) |
|---|---|
| Major feature rollouts | Per-session tweaks |
| Dead code elimination needed | User-configurable behavior |
| Binary size matters | Dynamic adjustment needed |
| Security-sensitive features | Debugging and diagnostics |

## GrowthBook Overrides for A/B Testing

For progressive rollout and experimentation, Claude Code integrates with GrowthBook:

```typescript
import { GrowthBook } from "@growthbook/growthbook";

async function initFeatureFlags(userId: string): Promise<FeatureFlags> {
  const gb = new GrowthBook({
    apiHost: "https://cdn.growthbook.io",
    clientKey: GROWTHBOOK_CLIENT_KEY,
    attributes: {
      id: userId,
      version: VERSION,
      platform: process.platform,
      plan: getUserPlan(userId), // free, pro, enterprise
    },
  });

  await gb.loadFeatures();

  return {
    contextCollapse: gb.isOn("context-collapse"),
    historySnip: gb.isOn("history-snip"),
    proactiveMode: gb.isOn("proactive-mode"),
    cachedMicrocompact: gb.isOn("cached-microcompact"),
    kairosScheduling: gb.isOn("kairos-scheduling"),
    parallelToolCalls: gb.isOn("parallel-tool-calls"),
  };
}
```

GrowthBook evaluates flags based on user attributes. A flag can be:
- **Off** for everyone
- **On for 10%** of users (random hash-based split)
- **On for enterprise** users only
- **On for specific user IDs** (internal testing)
- **A/B tested** with metric tracking

## Real Feature Flag Examples

Here are actual feature flags from the Claude Code codebase and what they control:

```typescript
// PROACTIVE: Agent proactively suggests actions
if (feature("PROACTIVE")) {
  systemPrompt += PROACTIVE_INSTRUCTIONS;
  tools.push(ProactiveSuggestionTool);
}

// KAIROS: Intelligent scheduling for background tasks
if (feature("KAIROS")) {
  const scheduler = new KairosScheduler();
  scheduler.scheduleBackgroundIndexing(cwd);
}

// CONTEXT_COLLAPSE: Summarize old messages instead of truncating
if (feature("CONTEXT_COLLAPSE")) {
  messages = await collapseContext(messages, {
    targetTokens: maxContextTokens * 0.7,
    preserveRecent: 5,
  });
}

// HISTORY_SNIP: Remove tool results from old turns to save context
if (feature("HISTORY_SNIP")) {
  messages = snipToolResults(messages, {
    keepRecent: 3,
    replaceWith: "[tool result snipped for context management]",
  });
}

// CACHED_MICROCOMPACT: Use cached compaction for repeated prompts
if (feature("CACHED_MICROCOMPACT")) {
  const cached = await compactionCache.get(messageHash);
  if (cached) {
    messages = cached;
  } else {
    messages = await compactMessages(messages);
    await compactionCache.set(messageHash, messages);
  }
}
```

## Feature Flag Lifecycle

A feature flag goes through distinct phases:

```
1. DEVELOPMENT
   feature("NEW_THING") = false in all builds
   Code is written behind the flag
   
2. INTERNAL TESTING
   feature("NEW_THING") = true in dev builds
   GrowthBook: on for employee user IDs
   
3. PROGRESSIVE ROLLOUT
   feature("NEW_THING") = true in production builds
   GrowthBook: 1% → 5% → 25% → 50% → 100%
   Metrics monitored at each stage
   
4. GENERAL AVAILABILITY
   feature("NEW_THING") = true in all builds
   GrowthBook: removed (always on)
   
5. CLEANUP
   Remove the feature() check from code
   Remove the old code path
   The feature is now just "how things work"
```

## Combining Compile-Time and Runtime

Some features use both layers:

```typescript
function shouldUseParallelTools(): boolean {
  // Compile-time gate: is the feature included in this build?
  if (!feature("PARALLEL_TOOL_CALLS")) {
    return false;
  }

  // Runtime gate: is it enabled for this user?
  const flags = getRuntimeFlags();
  if (!flags.PARALLEL_TOOL_CALLS) {
    return false;
  }

  // GrowthBook gate: is the user in the rollout group?
  const gb = getGrowthBook();
  return gb.isOn("parallel-tool-calls");
}
```

Three layers of control:
1. **Compile-time**: Is the code even in the binary?
2. **Runtime env var**: Has the user opted in?
3. **GrowthBook**: Is the server-side flag on for this user?

## Feature Flags in the Build Pipeline

```typescript
// build.ts — the build script generates flag values

const featureFlags = {
  PROACTIVE: true,
  KAIROS: process.env.BUILD_CHANNEL === "canary",
  CONTEXT_COLLAPSE: true,
  HISTORY_SNIP: true,
  CACHED_MICROCOMPACT: process.env.BUILD_CHANNEL !== "stable",
  PARALLEL_TOOL_CALLS: false,
};

const define = Object.fromEntries(
  Object.entries(featureFlags).map(
    ([key, value]) => [`feature("${key}")`, String(value)]
  )
);

await Bun.build({
  entrypoints: ["./src/cli.tsx"],
  outdir: "./dist",
  define,
});

console.log("Build flags:", featureFlags);
```

Different build channels get different flags:
- **Canary**: Everything enabled — early adopters get new features first
- **Beta**: Most features enabled — wider testing
- **Stable**: Only proven features — maximum reliability

## Anti-Patterns

```typescript
// BAD: Feature flag that's never cleaned up (flag debt)
if (feature("THING_FROM_2024")) {
  // This has been true for a year. Remove the flag.
}

// BAD: Business logic inside a flag check
if (feature("NEW_PRICING")) {
  price = calculateNewPrice(plan);
  applyDiscount(price, user);
  sendInvoice(price, user);
  logPriceChange(price);
} else {
  price = calculateOldPrice(plan);
  sendInvoice(price, user);
}
// Should be: extract both paths into separate functions

// BAD: Nested feature flags
if (feature("A")) {
  if (feature("B")) {
    if (feature("C")) {
      // Combinatorial explosion — impossible to test all states
    }
  }
}
```

## Key Takeaways

1. **Compile-time flags** (`feature()`) enable dead code elimination — disabled features aren't in the binary
2. **Runtime flags** (env vars) allow per-session configuration without rebuilding
3. **GrowthBook** enables progressive rollout: 1% → 10% → 100% with metrics
4. **Feature flag lifecycle**: development → testing → rollout → GA → cleanup
5. **Build channels** (canary/beta/stable) get different flag defaults
6. **Flags decouple deployment from release** — ship code safely, enable gradually
7. **Clean up flags** after full rollout to avoid technical debt

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Compile-Time vs Runtime Flags
**Question:** Explain the difference between compile-time feature flags (`feature()`) and runtime flags (environment variables). Why would you use compile-time flags for a major feature rollout but runtime flags for debugging? What happens to dead code behind a `false` compile-time flag during bundling?

[View Answer](../../answers/12-architecture-and-advanced/answer-106.md#exercise-1)

### Exercise 2 — Build a Feature Flag System
**Challenge:** Implement a `FeatureFlagManager` class that supports three layers of flags: compile-time (simulated as a static `Record<string, boolean>` passed to the constructor), runtime (read from environment variables), and remote (fetched from a mock API endpoint). The `isEnabled` method should check all three layers in priority order: remote overrides runtime overrides compile-time. Include a `getAllFlags()` method that returns the merged state of all flags, and a `refresh()` method that re-fetches remote flags.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-106.md#exercise-2)

### Exercise 3 — Progressive Rollout Simulator
**Challenge:** Implement a `ProgressiveRollout` class that simulates percentage-based feature flag rollout. Given a user ID and a rollout percentage (0-100), it should deterministically decide whether the flag is on for that user (using a hash, not random). The same user ID + flag name should always get the same result. Implement `isEnabled(userId, flagName, percentage)` and write tests proving: (1) the same user always gets the same result, (2) roughly the right percentage of a 1000-user sample gets the flag, (3) 0% means nobody, 100% means everybody.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-106.md#exercise-3)

### Exercise 4 — Feature Flag Build Pipeline
**Challenge:** Write a build script function that generates compile-time flag `define` entries for Bun/esbuild. It should accept a build channel (`"canary"`, `"beta"`, `"stable"`), read a flag configuration that specifies which channels each flag is enabled for, and output the `define` object. Include at least 5 flags with different channel configurations. Add a validation step that warns if any flag has been enabled in stable for more than 90 days (simulated with a `enabledSinceDate` field).

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-106.md#exercise-4)

### Exercise 5 — Feature Flag Lifecycle Manager
**Challenge:** Build a `FlagLifecycleManager` that tracks the lifecycle state of each flag: `development` → `testing` → `rollout` → `ga` → `cleanup_needed`. Implement: `createFlag(name, description)`, `advanceStage(name)` (moves to next lifecycle stage), `getStaleFlags()` (returns flags in `ga` stage for more than 30 days — candidates for cleanup), `generateCleanupReport()` (produces a markdown report of all flags needing cleanup with code locations). Use the lifecycle stages from the lesson. Include persistence to a JSON file.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-106.md#exercise-5)
