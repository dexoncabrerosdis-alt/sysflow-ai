# Answers: Lesson 55 — Prompt Assembly Pipeline

## Exercise 1
**Question:** List the seven levels of the prompt override chain with scenarios.

**Answer:** From highest to lowest: (1) **Override prompt** — A developer passes `--system-prompt "Just say hello"` for testing. It replaces everything because it's the most explicit, intentional override. (2) **Coordinator prompt** — Claude Code spawns a sub-agent to handle a specific file search. The coordinator gives it a focused prompt like "You are a file search agent. Only use Grep and Glob tools." Overrides the agent's default because the coordinator has a specific task. (3) **Agent prompt** — A custom agent configuration replaces standard behavior, e.g., a security audit agent with specialized rules. Overrides the default because it's a purpose-built configuration. (4) **Proactive append** — When proactive mode is enabled, instructions like "Monitor file changes and suggest improvements" are appended. Added to the default, not replacing it. (5) **Custom instructions** — User config file adds "Always use TypeScript strict mode." Appended as user preferences. (6) **Default prompt** — The standard section assembly (identity + rules + tools + style + dynamic sections). The baseline when nothing overrides it. (7) **Append prompt** — An IDE plugin adds "Format output for VS Code terminal." Lowest priority, appended by integrations.

---

## Exercise 2
**Question:** Why use `Promise.all()` for section resolution? Which sections involve I/O?

**Answer:** `Promise.all()` resolves all sections concurrently, so the total assembly time equals the slowest section rather than the sum of all sections. Four sections involving I/O: (1) **`loadMemoryPrompt()`** — Reads CLAUDE.md files from disk (2-10ms per file). (2) **`getSystemContext()`** — Runs `git branch`, `git status`, and `git log` shell commands (10-30ms total). (3) **`computeSimpleEnvInfo()`** — May check OS details via system calls (1-5ms). (4) **`getMcpInstructions()`** — Queries connected MCP servers over IPC/network (variable latency). Sequential loading: 10 + 30 + 5 + variable ≈ 45+ ms. Parallel loading: max(10, 30, 5, variable) ≈ 30ms. The difference compounds over hundreds of turns in a session.

---

## Exercise 3
**Challenge:** Write a `buildStructuredPrompt` function with parallel loading and cache control.

**Answer:**
```typescript
interface AgentConfig {
  tools: string[];
  projectRoot: string;
  language?: string;
  customInstructions?: string;
}

interface SystemPromptBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

async function buildStructuredPrompt(
  config: AgentConfig
): Promise<SystemPromptBlock[]> {
  const [
    identity,
    rules,
    toolInstructions,
    toneAndStyle,
    efficiency,
    memory,
    envInfo,
    language,
  ] = await Promise.all([
    Promise.resolve(getIdentitySection()),
    Promise.resolve(getSystemRulesSection()),
    Promise.resolve(getToolInstructionsSection(config.tools)),
    Promise.resolve(getToneAndStyleSection()),
    Promise.resolve(getEfficiencySection()),
    loadMemoryPrompt(config.projectRoot),
    computeEnvInfo(),
    Promise.resolve(getLanguageSection(config.language)),
  ]);

  const staticContent = [identity, rules, toolInstructions, toneAndStyle, efficiency]
    .filter(Boolean)
    .join("\n\n");

  let dynamicContent = [memory, envInfo, language]
    .filter(Boolean)
    .join("\n\n");

  if (config.customInstructions) {
    dynamicContent += "\n\n" + config.customInstructions;
  }

  return [
    {
      type: "text",
      text: staticContent,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: dynamicContent,
    },
  ];
}

function getIdentitySection(): string { return "You are an interactive CLI agent..."; }
function getSystemRulesSection(): string { return "## System Rules\n\n..."; }
function getToolInstructionsSection(tools: string[]): string { return "## Tools\n\n..."; }
function getToneAndStyleSection(): string { return "## Tone\n\n..."; }
function getEfficiencySection(): string { return "## Efficiency\n\n..."; }
async function loadMemoryPrompt(root: string): Promise<string> { return ""; }
async function computeEnvInfo(): Promise<string> { return "## Environment\n\n..."; }
function getLanguageSection(lang?: string): string { return lang ? `Respond in ${lang}.` : ""; }
```
**Explanation:** All sections resolve in parallel via `Promise.all`. Static sections are joined and given `cache_control`. Dynamic sections are joined separately. Custom instructions are appended last since they're lowest priority among additions.

---

## Exercise 4
**Challenge:** Write three test cases for a prompt assembly pipeline.

**Answer:**
```typescript
describe("prompt assembly pipeline", () => {
  it("produces stable static content across calls", async () => {
    const result1 = await buildStructuredPrompt(defaultConfig);
    const result2 = await buildStructuredPrompt(defaultConfig);
    expect(result1[0].text).toBe(result2[0].text);
  });

  it("sets cache_control on first block only", async () => {
    const blocks = await buildStructuredPrompt(defaultConfig);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it("returns single block when override is provided", async () => {
    const config = {
      ...defaultConfig,
      promptConfig: { override: "Custom prompt for testing" },
    };
    const blocks = await getSystemPrompt(config);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("Custom prompt for testing");
    expect(blocks[0].cache_control).toBeUndefined();
  });
});
```
**Explanation:** Test 1 verifies cache stability — the static block must be byte-identical across calls or caching breaks. Test 2 verifies the cache control structure — only the first (static) block should have `cache_control`, the dynamic block should not. Test 3 verifies the override behavior — when an override is provided, it replaces all sections entirely with a single uncached block.

---

## Exercise 5
**Question:** Performance bottlenecks and optimization techniques.

**Answer:** The performance bottlenecks are the I/O-bound dynamic sections: (1) **Git context** (10-30ms) — runs shell commands like `git branch`, `git status`, and `git log`. This is typically the slowest section because it spawns child processes. (2) **Memory loading** (2-10ms) — reads CLAUDE.md files from disk. (3) **MCP instructions** (variable) — queries external MCP servers.

Claude Code uses three techniques to keep assembly fast: (1) **Parallel resolution** — `Promise.all` ensures all I/O happens concurrently, so total latency equals the slowest section (~30ms), not the sum (~45ms+). (2) **Memoization with TTL** — Platform info is cached forever (never changes), git status is cached for 5 seconds (changes infrequently), reducing redundant I/O on rapid successive turns. (3) **Static section pre-computation** — Static sections are pure string concatenation (<1ms) with no I/O, so they add negligible overhead. The result: typical assembly completes in 15-45ms per turn.
