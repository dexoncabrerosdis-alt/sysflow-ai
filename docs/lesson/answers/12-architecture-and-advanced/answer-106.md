# Answers: Lesson 106 — Feature Flags

## Exercise 1
**Question:** Explain the difference between compile-time and runtime feature flags. Why use compile-time for major rollouts but runtime for debugging? What happens to dead code behind a false compile-time flag?

**Answer:** Compile-time flags are replaced with literal `true`/`false` values during the build step (by the bundler's `define` option). The bundler then performs dead code elimination — any code branch behind a `false` flag is completely removed from the output binary. This means the code doesn't exist at runtime: no bytes in the bundle, no parsing cost, no execution cost. Runtime flags are checked at execution time via environment variables, so the code for both branches exists in the binary and the check happens on every invocation. Compile-time flags are ideal for major feature rollouts because: (1) disabled features add zero overhead, (2) security-sensitive features can be entirely absent from certain builds, and (3) binary size stays small. Runtime flags are ideal for debugging because: (1) you can toggle them per-session without rebuilding (`AGENT_VERBOSE=true agent`), (2) users can enable them immediately without waiting for a new build, and (3) they can be set dynamically in CI environments.

---

## Exercise 2
**Challenge:** Build a `FeatureFlagManager` with three-layer flag resolution.

**Answer:**

```typescript
interface RemoteFlags {
  [key: string]: boolean;
}

class FeatureFlagManager {
  private compileTimeFlags: Record<string, boolean>;
  private remoteFlags: Record<string, boolean> = {};
  private envPrefix: string;
  private remoteUrl: string;

  constructor(options: {
    compileTimeFlags: Record<string, boolean>;
    envPrefix?: string;
    remoteUrl?: string;
  }) {
    this.compileTimeFlags = options.compileTimeFlags;
    this.envPrefix = options.envPrefix ?? "FLAG_";
    this.remoteUrl = options.remoteUrl ?? "";
  }

  async refresh(): Promise<void> {
    if (!this.remoteUrl) return;

    try {
      const response = await fetch(this.remoteUrl);
      if (response.ok) {
        this.remoteFlags = await response.json();
      }
    } catch (error) {
      console.warn("Failed to fetch remote flags:", error);
    }
  }

  isEnabled(flagName: string): boolean {
    // Priority: remote > runtime > compile-time
    if (flagName in this.remoteFlags) {
      return this.remoteFlags[flagName];
    }

    const envValue = process.env[`${this.envPrefix}${flagName.toUpperCase()}`];
    if (envValue !== undefined) {
      return envValue === "true" || envValue === "1";
    }

    return this.compileTimeFlags[flagName] ?? false;
  }

  getAllFlags(): Record<string, { value: boolean; source: string }> {
    const allNames = new Set([
      ...Object.keys(this.compileTimeFlags),
      ...Object.keys(this.remoteFlags),
    ]);

    // Also check env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(this.envPrefix)) {
        allNames.add(key.slice(this.envPrefix.length).toLowerCase());
      }
    }

    const result: Record<string, { value: boolean; source: string }> = {};
    for (const name of allNames) {
      if (name in this.remoteFlags) {
        result[name] = { value: this.remoteFlags[name], source: "remote" };
      } else if (process.env[`${this.envPrefix}${name.toUpperCase()}`] !== undefined) {
        result[name] = { value: this.isEnabled(name), source: "runtime" };
      } else if (name in this.compileTimeFlags) {
        result[name] = { value: this.compileTimeFlags[name], source: "compile-time" };
      }
    }

    return result;
  }
}

// Usage
const flags = new FeatureFlagManager({
  compileTimeFlags: {
    context_collapse: true,
    parallel_tools: false,
    proactive: true,
  },
  remoteUrl: "https://flags.example.com/api/flags",
});

await flags.refresh();

if (flags.isEnabled("context_collapse")) {
  // This feature is active
}

console.log(flags.getAllFlags());
```

**Explanation:** The three layers mirror production systems: compile-time flags are baked into the build, runtime flags allow per-session overrides, and remote flags enable server-side control without redeployment. `isEnabled` checks in reverse priority order — remote first, then environment, then compile-time. `getAllFlags` merges all sources and reports which source determined each flag's value, useful for debugging. The `refresh` method re-fetches remote flags, enabling periodic polling or manual refresh in long-running sessions.

---

## Exercise 3
**Challenge:** Implement deterministic percentage-based progressive rollout.

**Answer:**

```typescript
class ProgressiveRollout {
  private hashToPercentage(userId: string, flagName: string): number {
    const input = `${flagName}:${userId}`;
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return Math.abs(hash) % 100;
  }

  isEnabled(userId: string, flagName: string, percentage: number): boolean {
    if (percentage <= 0) return false;
    if (percentage >= 100) return true;
    return this.hashToPercentage(userId, flagName) < percentage;
  }
}

// Tests
function testProgressiveRollout() {
  const rollout = new ProgressiveRollout();

  // Test 1: Same user always gets the same result (deterministic)
  const results = Array.from({ length: 100 }, () =>
    rollout.isEnabled("user-123", "my_feature", 50)
  );
  const allSame = results.every(r => r === results[0]);
  console.assert(allSame, "Deterministic: same result every time");

  // Test 2: Roughly correct percentage distribution
  const sampleSize = 10000;
  let enabledCount = 0;
  for (let i = 0; i < sampleSize; i++) {
    if (rollout.isEnabled(`user-${i}`, "test_feature", 30)) {
      enabledCount++;
    }
  }
  const actualPercentage = (enabledCount / sampleSize) * 100;
  console.assert(
    actualPercentage > 25 && actualPercentage < 35,
    `30% rollout: got ${actualPercentage.toFixed(1)}% (expected ~30%)`
  );

  // Test 3: 0% means nobody
  let zeroEnabled = false;
  for (let i = 0; i < 1000; i++) {
    if (rollout.isEnabled(`user-${i}`, "zero_feature", 0)) {
      zeroEnabled = true;
      break;
    }
  }
  console.assert(!zeroEnabled, "0% means nobody");

  // Test 4: 100% means everybody
  let allEnabled = true;
  for (let i = 0; i < 1000; i++) {
    if (!rollout.isEnabled(`user-${i}`, "full_feature", 100)) {
      allEnabled = false;
      break;
    }
  }
  console.assert(allEnabled, "100% means everybody");

  // Test 5: Different flags give different distributions
  const flagAResult = rollout.isEnabled("user-42", "feature_a", 50);
  const flagBResult = rollout.isEnabled("user-42", "feature_b", 50);
  // Note: These could be the same by chance, but the hash includes flag name
  // so the distribution is independent per flag

  console.log("All progressive rollout tests passed");
}

testProgressiveRollout();
```

**Explanation:** The hash function combines the flag name and user ID into a deterministic number between 0-99. This ensures: the same user always gets the same result for a given flag (deterministic), different flags produce independent distributions (because the flag name is part of the hash input), and the distribution is roughly uniform across users. The `% 100` maps the hash to a 0-99 range, and comparing against the percentage threshold determines inclusion. Edge cases (0% and 100%) are handled explicitly to avoid hash boundary issues.

---

## Exercise 4
**Challenge:** Write a build script that generates compile-time flag defines per build channel.

**Answer:**

```typescript
interface FlagConfig {
  name: string;
  description: string;
  channels: ("canary" | "beta" | "stable")[];
  enabledSinceDate?: string; // ISO date string
}

const FLAG_CONFIGS: FlagConfig[] = [
  {
    name: "CONTEXT_COLLAPSE",
    description: "Summarize old messages instead of truncating",
    channels: ["canary", "beta", "stable"],
    enabledSinceDate: "2025-01-15",
  },
  {
    name: "PARALLEL_TOOLS",
    description: "Execute independent tool calls in parallel",
    channels: ["canary", "beta"],
    enabledSinceDate: "2025-06-01",
  },
  {
    name: "PROACTIVE",
    description: "Agent proactively suggests actions",
    channels: ["canary", "beta", "stable"],
    enabledSinceDate: "2025-03-01",
  },
  {
    name: "KAIROS",
    description: "Intelligent background task scheduling",
    channels: ["canary"],
  },
  {
    name: "CACHED_MICROCOMPACT",
    description: "Cache compaction results for repeated prompts",
    channels: ["canary", "beta"],
    enabledSinceDate: "2025-08-15",
  },
];

type BuildChannel = "canary" | "beta" | "stable";

function generateFlagDefines(channel: BuildChannel): Record<string, string> {
  const defines: Record<string, string> = {};

  for (const flag of FLAG_CONFIGS) {
    const enabled = flag.channels.includes(channel);
    defines[`feature("${flag.name}")`] = String(enabled);
  }

  return defines;
}

function validateFlags(channel: BuildChannel): string[] {
  const warnings: string[] = [];
  const now = new Date();
  const STALE_THRESHOLD_DAYS = 90;

  for (const flag of FLAG_CONFIGS) {
    if (
      flag.channels.includes("stable") &&
      flag.enabledSinceDate
    ) {
      const enabledDate = new Date(flag.enabledSinceDate);
      const daysSinceEnabled = Math.floor(
        (now.getTime() - enabledDate.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (daysSinceEnabled > STALE_THRESHOLD_DAYS) {
        warnings.push(
          `⚠ Flag "${flag.name}" has been enabled in stable for ${daysSinceEnabled} days. ` +
          `Consider removing the flag and making it permanent.`
        );
      }
    }
  }

  return warnings;
}

// Build script
async function build(channel: BuildChannel) {
  const defines = generateFlagDefines(channel);
  const warnings = validateFlags(channel);

  if (warnings.length > 0) {
    console.log("Flag warnings:");
    warnings.forEach(w => console.log(`  ${w}`));
  }

  console.log(`Building ${channel} with flags:`);
  for (const [key, value] of Object.entries(defines)) {
    console.log(`  ${key} = ${value}`);
  }

  // await Bun.build({
  //   entrypoints: ["./src/cli.tsx"],
  //   outdir: "./dist",
  //   define: defines,
  // });
}

build("stable");
```

**Explanation:** Each flag configuration specifies which build channels it's enabled for. `generateFlagDefines` produces the `define` object that the bundler uses to replace `feature("FLAG_NAME")` calls with literal booleans. `validateFlags` catches stale flags — features that have been enabled in stable for more than 90 days should probably have their flag removed (the code made permanent). This prevents "flag debt" where old flags accumulate and make the codebase harder to understand. The channel hierarchy (canary → beta → stable) means canary users always get all features, beta gets most, and stable only gets proven ones.

---

## Exercise 5
**Challenge:** Build a `FlagLifecycleManager` with stage tracking, stale detection, and cleanup reports.

**Answer:**

```typescript
import * as fs from "fs";

type LifecycleStage = "development" | "testing" | "rollout" | "ga" | "cleanup_needed";

const STAGE_ORDER: LifecycleStage[] = [
  "development", "testing", "rollout", "ga", "cleanup_needed"
];

interface FlagRecord {
  name: string;
  description: string;
  stage: LifecycleStage;
  createdAt: string;
  stageChangedAt: string;
  codeLocations?: string[];
  history: Array<{ stage: LifecycleStage; timestamp: string }>;
}

class FlagLifecycleManager {
  private flags: Map<string, FlagRecord> = new Map();
  private storagePath: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    this.load();
  }

  createFlag(name: string, description: string, codeLocations?: string[]): void {
    if (this.flags.has(name)) {
      throw new Error(`Flag "${name}" already exists`);
    }

    const now = new Date().toISOString();
    this.flags.set(name, {
      name,
      description,
      stage: "development",
      createdAt: now,
      stageChangedAt: now,
      codeLocations,
      history: [{ stage: "development", timestamp: now }],
    });
    this.save();
  }

  advanceStage(name: string): LifecycleStage {
    const flag = this.flags.get(name);
    if (!flag) throw new Error(`Flag "${name}" not found`);

    const currentIndex = STAGE_ORDER.indexOf(flag.stage);
    if (currentIndex >= STAGE_ORDER.length - 1) {
      throw new Error(`Flag "${name}" is already at final stage: ${flag.stage}`);
    }

    const nextStage = STAGE_ORDER[currentIndex + 1];
    const now = new Date().toISOString();

    flag.stage = nextStage;
    flag.stageChangedAt = now;
    flag.history.push({ stage: nextStage, timestamp: now });

    this.save();
    return nextStage;
  }

  getStaleFlags(staleDays: number = 30): FlagRecord[] {
    const now = new Date();

    return [...this.flags.values()].filter(flag => {
      if (flag.stage !== "ga") return false;

      const changedAt = new Date(flag.stageChangedAt);
      const daysSinceGA = (now.getTime() - changedAt.getTime()) / (1000 * 60 * 60 * 24);
      return daysSinceGA > staleDays;
    });
  }

  generateCleanupReport(): string {
    const staleFlags = this.getStaleFlags();

    if (staleFlags.length === 0) {
      return "# Feature Flag Cleanup Report\n\nNo flags need cleanup. All clear!";
    }

    let report = "# Feature Flag Cleanup Report\n\n";
    report += `**Generated:** ${new Date().toISOString()}\n`;
    report += `**Flags needing cleanup:** ${staleFlags.length}\n\n`;

    for (const flag of staleFlags) {
      const daysSinceGA = Math.floor(
        (Date.now() - new Date(flag.stageChangedAt).getTime()) / (1000 * 60 * 60 * 24)
      );

      report += `## ${flag.name}\n\n`;
      report += `- **Description:** ${flag.description}\n`;
      report += `- **In GA for:** ${daysSinceGA} days\n`;
      report += `- **Created:** ${flag.createdAt}\n`;

      if (flag.codeLocations?.length) {
        report += `- **Code locations:**\n`;
        for (const loc of flag.codeLocations) {
          report += `  - \`${loc}\`\n`;
        }
      }

      report += `\n**Action:** Remove the \`feature("${flag.name}")\` checks and delete the old code path.\n\n`;
      report += `---\n\n`;
    }

    return report;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const data = JSON.parse(fs.readFileSync(this.storagePath, "utf-8"));
        this.flags = new Map(Object.entries(data));
      }
    } catch {
      this.flags = new Map();
    }
  }

  private save(): void {
    const data = Object.fromEntries(this.flags);
    fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2));
  }
}

// Usage
const manager = new FlagLifecycleManager("./flag-lifecycle.json");

manager.createFlag(
  "CONTEXT_COLLAPSE",
  "Summarize old context instead of truncating",
  ["src/context/manager.ts:45", "src/context/collapse.ts:12"]
);

manager.advanceStage("CONTEXT_COLLAPSE"); // → testing
manager.advanceStage("CONTEXT_COLLAPSE"); // → rollout
manager.advanceStage("CONTEXT_COLLAPSE"); // → ga

const report = manager.generateCleanupReport();
console.log(report);
```

**Explanation:** The lifecycle manager tracks each flag through its five stages with timestamps and history. `advanceStage` moves a flag to the next stage in the defined order and records the transition. `getStaleFlags` identifies flags that have been in `ga` (generally available) for more than the threshold, meaning the feature is fully rolled out and the flag guards can be removed. `generateCleanupReport` produces a markdown document listing each stale flag with its description, age, and code locations — this can be included in sprint planning or tech debt reviews. Persistence to a JSON file ensures the lifecycle state survives across sessions.
