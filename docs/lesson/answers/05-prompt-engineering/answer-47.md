# Answers: Lesson 47 — Prompt Structure

## Exercise 1
**Question:** Classify each section as static or dynamic and explain your reasoning.

**Answer:** (a) **Tool instructions → Static** — Available tools don't change mid-session. Once the agent starts, its tool set is fixed. (b) **Git branch name → Dynamic** — The user can switch branches between turns with `git checkout`. (c) **Identity statement → Static** — The agent's role and personality don't change during a conversation. (d) **CLAUDE.md content → Dynamic** — The user can edit CLAUDE.md between turns, and the agent should pick up the changes. (e) **MCP server instructions → Dynamic** — MCP servers can connect or disconnect during a session. (f) **Output efficiency rules → Static** — Rules like "don't repeat the user's question" are constant behavioral guidelines that never change mid-session.

---

## Exercise 2
**Challenge:** Write a `SectionRegistry` class with conditional inclusion and priority ordering.

**Answer:**
```typescript
type SectionGenerator = () => string | Promise<string>;

interface SectionConfig {
  name: string;
  generator: SectionGenerator;
  priority: number;
  condition?: () => boolean;
}

class SectionRegistry {
  private sections: SectionConfig[] = [];

  register(
    name: string,
    generator: SectionGenerator,
    options: { priority?: number; condition?: () => boolean } = {}
  ): void {
    this.sections.push({
      name,
      generator,
      priority: options.priority ?? 0,
      condition: options.condition,
    });
  }

  async resolveAll(): Promise<string[]> {
    const active = this.sections
      .filter((s) => !s.condition || s.condition())
      .sort((a, b) => a.priority - b.priority);

    const resolved = await Promise.all(
      active.map((s) => s.generator())
    );

    return resolved.filter(Boolean);
  }
}
```
**Explanation:** The registry stores section definitions with metadata. `resolveAll()` first filters out sections whose conditions are false, sorts by priority, then resolves all generators in parallel with `Promise.all`. Empty strings are filtered out. This allows async sections (file reads, git commands) to resolve concurrently while maintaining deterministic ordering.

---

## Exercise 3
**Question:** What is the purpose of the `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` marker?

**Answer:** The `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` serves two purposes: (1) **For the caching system** — It tells the API client exactly where to set the cache breakpoint. Everything before the marker is sent as a cacheable prefix with `cache_control: { type: "ephemeral" }`. Everything after is sent without cache control and is reprocessed every turn. This enables the 90% discount on cached static content. (2) **For developers debugging** — When you dump the system prompt during development, the marker creates a visible dividing line. You can immediately see which content is cached (above) and which is fresh (below), making it easy to verify that you haven't accidentally put dynamic content in the cached section (which would break caching).

---

## Exercise 4
**Question:** For each of the four benefits of section architecture, give a concrete example.

**Answer:** (1) **Cacheability** — The identity and rules sections produce identical text every turn. By placing them before the dynamic boundary, a 20-turn session pays full price for ~6,000 tokens once and 90% less for the remaining 19 turns, saving roughly 57% on system prompt costs. (2) **Testability** — Each section generator is a pure function. You can write unit tests like `expect(getSystemRulesSection()).toContain("NEVER reveal")` to verify specific behavioral rules exist without assembling the full prompt. (3) **Conditional inclusion** — MCP instructions only appear when `mcpServers.length > 0`. A user without MCP servers gets a leaner prompt with fewer tokens, preserving context window space for actual conversation. (4) **Override capability** — When Claude Code runs in coordinator mode (spawning sub-agents), the coordinator injects a focused `coordinatorPrompt` that replaces the default sections. The sub-agent gets task-specific instructions without inheriting the full general-purpose prompt.
