# Lesson 55: The Prompt Assembly Pipeline

## From Parts to Whole

Over the past nine lessons, you've seen every component of a coding agent's system prompt: identity, rules, tool instructions, environment context, project memory, output style, and the static/dynamic caching split. Now it's time to see how they all come together in the **assembly pipeline** — the code that transforms configuration into a final, cache-optimized prompt array.

## The Priority Chain

Claude Code's prompt assembly follows a **priority chain** that determines which sections appear and in what order. Higher-priority sources can override lower-priority ones:

```
Highest Priority
  │
  ├── Override prompt       (from CLI flag or API parameter)
  ├── Coordinator prompt    (when running as a sub-agent)
  ├── Agent prompt          (the agent's own system prompt)
  ├── Proactive append      (proactive mode instructions)
  ├── Custom instructions   (from user config file)
  ├── Default prompt        (the standard section assembly)
  └── Append prompt         (appended by integrations)
  │
Lowest Priority
```

In code:

```typescript
interface SystemPromptConfig {
  override?: string;
  coordinatorPrompt?: string;
  agentPrompt?: string;
  proactiveAppend?: string;
  customInstructions?: string;
  appendPrompt?: string;
}

async function buildEffectiveSystemPrompt(
  config: SystemPromptConfig
): Promise<string> {
  // Override replaces everything
  if (config.override) {
    return config.override;
  }

  // Coordinator replaces the agent prompt
  if (config.coordinatorPrompt) {
    return config.coordinatorPrompt;
  }

  // Agent prompt replaces the default
  if (config.agentPrompt) {
    return config.agentPrompt;
  }

  // Default: build from sections
  let prompt = await buildDefaultSystemPrompt();

  // Layer on additions
  if (config.proactiveAppend) {
    prompt += "\n\n" + config.proactiveAppend;
  }

  if (config.customInstructions) {
    prompt += "\n\n" + config.customInstructions;
  }

  if (config.appendPrompt) {
    prompt += "\n\n" + config.appendPrompt;
  }

  return prompt;
}
```

### Why the Override Chain Exists

- **Override**: For testing. Pass `--system-prompt "Just say hello"` and the entire normal prompt is replaced.
- **Coordinator**: When Claude Code spawns sub-agents, the coordinator gives them a focused prompt for their specific task.
- **Agent**: For custom agent configurations that replace the standard behavior.
- **Proactive append**: Adds instructions for proactive behavior (file watching, automatic suggestions).
- **Custom instructions**: User-specified additions from a config file (not CLAUDE.md — that's in the default prompt).
- **Append**: Integration-level additions (IDE plugins, API wrappers).

## getSystemPrompt(): The Main Assembly Function

The core function that all callers use:

```typescript
async function getSystemPrompt(
  config: AgentConfig
): Promise<SystemPromptBlock[]> {
  const effectivePrompt = await buildEffectiveSystemPrompt(
    config.promptConfig
  );

  // If it's an override/coordinator/agent prompt, return as-is
  if (config.promptConfig.override ||
      config.promptConfig.coordinatorPrompt ||
      config.promptConfig.agentPrompt) {
    return [asSystemPrompt(effectivePrompt)];
  }

  // Otherwise, build the structured, cacheable prompt
  return buildStructuredPrompt(config);
}
```

## buildStructuredPrompt(): Parallel Section Loading

The real work happens here. Sections are resolved in parallel and assembled with the cache boundary:

```typescript
async function buildStructuredPrompt(
  config: AgentConfig
): Promise<SystemPromptBlock[]> {
  // === Phase 1: Resolve all sections in parallel ===
  const [
    identity,
    systemRules,
    doingTasks,
    toolInstructions,
    toneAndStyle,
    outputEfficiency,
    sessionGuidance,
    memory,
    envInfo,
    systemContext,
    userContext,
    language,
    outputStyle,
    mcpInstructions,
  ] = await Promise.all([
    // Static sections
    Promise.resolve(getSimpleIntroSection()),
    Promise.resolve(getSystemRulesSection()),
    Promise.resolve(getDoingTasksSection()),
    Promise.resolve(getUsingYourToolsSection(config.tools)),
    Promise.resolve(getSimpleToneAndStyleSection()),
    Promise.resolve(getOutputEfficiencySection()),

    // Dynamic sections (may involve I/O)
    Promise.resolve(getSessionGuidanceSection(config.session)),
    loadMemoryPrompt(config.projectRoot),
    computeSimpleEnvInfo(),
    getSystemContext(),
    getUserContext(config.projectRoot),
    Promise.resolve(getLanguageSection(config.language)),
    Promise.resolve(getOutputStyleConfig(config.outputStyle)),
    getMcpInstructions(config.mcpServers),
  ]);

  // === Phase 2: Assemble static block ===
  const staticContent = [
    identity,
    systemRules,
    doingTasks,
    toolInstructions,
    toneAndStyle,
    outputEfficiency,
  ].filter(Boolean).join("\n\n");

  // === Phase 3: Assemble dynamic block ===
  const dynamicContent = [
    sessionGuidance,
    memory,
    envInfo,
    systemContext,
    userContext,
    language,
    outputStyle,
    mcpInstructions,
  ].filter(Boolean).join("\n\n");

  // === Phase 4: Apply additions ===
  let finalDynamic = dynamicContent;

  if (config.promptConfig.proactiveAppend) {
    finalDynamic += "\n\n" + config.promptConfig.proactiveAppend;
  }
  if (config.promptConfig.customInstructions) {
    finalDynamic += "\n\n" + config.promptConfig.customInstructions;
  }
  if (config.promptConfig.appendPrompt) {
    finalDynamic += "\n\n" + config.promptConfig.appendPrompt;
  }

  // === Phase 5: Return as typed blocks ===
  return [
    {
      type: "text" as const,
      text: staticContent,
      cache_control: { type: "ephemeral" as const },
    },
    {
      type: "text" as const,
      text: finalDynamic,
    },
  ];
}
```

The `Promise.all` is critical for performance. Several dynamic sections involve filesystem reads or shell commands:

- `loadMemoryPrompt` reads CLAUDE.md files from disk
- `computeSimpleEnvInfo` may check OS details
- `getSystemContext` runs git commands
- `getUserContext` reads project files
- `getMcpInstructions` queries connected MCP servers

Running these in parallel means the total latency is the time of the *slowest* section, not the *sum* of all sections.

## asSystemPrompt(): The Type Wrapper

The API expects system prompt content in a specific format. `asSystemPrompt()` wraps raw strings:

```typescript
interface SystemPromptBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

function asSystemPrompt(
  content: string,
  cacheControl?: boolean
): SystemPromptBlock {
  const block: SystemPromptBlock = {
    type: "text",
    text: content,
  };

  if (cacheControl) {
    block.cache_control = { type: "ephemeral" };
  }

  return block;
}
```

This wrapper ensures type safety throughout the assembly pipeline. The API client receives `SystemPromptBlock[]`, not raw strings.

## The Complete Flow

Here's the end-to-end flow from config to API call:

```
AgentConfig
    │
    ▼
getSystemPrompt(config)
    │
    ├── Is there an override/coordinator/agent prompt?
    │   YES → return [asSystemPrompt(prompt)]
    │   NO  → continue
    │
    ▼
buildStructuredPrompt(config)
    │
    ├── Phase 1: Promise.all([...section generators])
    │   ├── getSimpleIntroSection()        → identity text
    │   ├── getSystemRulesSection()        → rules text
    │   ├── getDoingTasksSection()         → task methodology
    │   ├── getUsingYourToolsSection()     → tool guidance
    │   ├── getToneAndStyleSection()       → tone rules
    │   ├── getOutputEfficiencySection()   → conciseness rules
    │   ├── getSessionGuidanceSection()    → session state
    │   ├── loadMemoryPrompt()             → CLAUDE.md content
    │   ├── computeSimpleEnvInfo()         → CWD, platform, etc.
    │   ├── getSystemContext()             → git state
    │   ├── getUserContext()               → date, user prefs
    │   ├── getLanguageSection()           → language pref
    │   ├── getOutputStyleConfig()         → verbosity settings
    │   └── getMcpInstructions()           → MCP server instructions
    │
    ├── Phase 2: Join static sections
    │
    ├── Phase 3: Join dynamic sections
    │
    ├── Phase 4: Append proactive/custom/append instructions
    │
    └── Phase 5: Return SystemPromptBlock[]
         │
         ▼
    API Client receives:
    [
      { type: "text", text: "static...", cache_control: { type: "ephemeral" } },
      { type: "text", text: "dynamic..." }
    ]
```

## Testing the Assembly Pipeline

The pipeline is testable at multiple levels:

```typescript
describe("prompt assembly", () => {
  it("produces stable static content", () => {
    const prompt1 = buildStructuredPrompt(defaultConfig);
    const prompt2 = buildStructuredPrompt(defaultConfig);

    // Static blocks must be identical for caching
    expect(prompt1[0].text).toBe(prompt2[0].text);
  });

  it("includes all required sections", async () => {
    const blocks = await buildStructuredPrompt(defaultConfig);
    const fullText = blocks.map(b => b.text).join("\n");

    expect(fullText).toContain("interactive CLI agent");
    expect(fullText).toContain("System Rules");
    expect(fullText).toContain("Using Your Tools");
    expect(fullText).toContain("Tone and Style");
    expect(fullText).toContain("Output Efficiency");
  });

  it("applies override correctly", async () => {
    const config = {
      ...defaultConfig,
      promptConfig: { override: "Custom system prompt" },
    };
    const blocks = await getSystemPrompt(config);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("Custom system prompt");
  });

  it("sets cache_control on static block only", async () => {
    const blocks = await buildStructuredPrompt(defaultConfig);

    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it("includes MCP instructions when servers exist", async () => {
    const config = {
      ...defaultConfig,
      mcpServers: [{ name: "test", instructions: "Use test tool" }],
    };
    const blocks = await buildStructuredPrompt(config);
    const dynamicText = blocks[1].text;

    expect(dynamicText).toContain("Use test tool");
  });

  it("excludes MCP instructions when no servers", async () => {
    const config = { ...defaultConfig, mcpServers: [] };
    const blocks = await buildStructuredPrompt(config);
    const dynamicText = blocks[1].text;

    expect(dynamicText).not.toContain("MCP");
  });
});
```

## Performance Characteristics

The assembly pipeline runs on every turn of the agent loop. Its performance matters:

```typescript
async function benchmarkPromptAssembly(
  config: AgentConfig
): Promise<void> {
  const iterations = 100;
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    await buildStructuredPrompt(config);
  }

  const elapsed = performance.now() - start;
  const avgMs = elapsed / iterations;

  console.log(`Average prompt assembly: ${avgMs.toFixed(2)}ms`);
  // Target: < 50ms (I/O bound by git commands and file reads)
}
```

Typical performance:
- Static section generation: < 1ms (string concatenation)
- Memory loading: 2-10ms (file read)
- Git context: 10-30ms (shell command)
- Environment info: 1-5ms (OS queries)
- Total: 15-45ms per turn

## Putting It All Together: A Minimal Agent

Here's how the prompt assembly integrates with the agent loop you built in Module 02:

```typescript
async function runAgent(config: AgentConfig): Promise<void> {
  const messages: Message[] = [];
  const tools = prepareToolsForApi(config.tools);

  while (true) {
    const userInput = await getUserInput();
    if (!userInput) break;

    messages.push({ role: "user", content: userInput });

    // Assemble the system prompt (runs every turn)
    const systemBlocks = await getSystemPrompt(config);

    // Call the model
    const response = await callModel({
      model: config.model,
      system: systemBlocks,
      tools: tools,
      messages: messages,
    });

    // Process assistant response
    messages.push({ role: "assistant", content: response.content });

    // Handle tool calls
    const toolCalls = extractToolCalls(response);
    if (toolCalls.length > 0) {
      const results = await executeTools(toolCalls);
      messages.push({ role: "user", content: formatToolResults(results) });
      continue;
    }

    // Display the assistant's text response
    displayResponse(response);
  }
}
```

The system prompt is rebuilt every turn, but thanks to the static/dynamic split, the expensive static portion is cached at the API level. The dynamic portion reflects the latest environment state.

## Module 05 Recap

Over these 10 lessons, you've learned:

1. **System prompts** are the instruction manual that shapes all agent behavior (Lesson 46)
2. **Section architecture** makes prompts modular, testable, and cacheable (Lesson 47)
3. **Identity** sets the foundation — agent vs. assistant, domain, action bias (Lesson 48)
4. **Tool instructions** redirect the model from shell commands to dedicated tools (Lesson 49)
5. **Static vs. dynamic** split enables prompt caching (Lesson 50)
6. **Prompt caching** saves 50-60% on input token costs (Lesson 51)
7. **Environment context** gives the model awareness of CWD, OS, git state (Lesson 52)
8. **Project memory** (CLAUDE.md) lets users write persistent instructions (Lesson 53)
9. **Output style** controls verbosity, tone, and communication format (Lesson 54)
10. **Assembly pipeline** brings it all together with parallel loading and type safety (this lesson)

The system prompt is the most leveraged text in your entire agent. One sentence here influences thousands of model responses. In Module 06, you'll learn about **context management** — what happens when the conversation grows too long for the context window, and how compaction keeps the agent running across extended sessions.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Override Priority Chain
**Question:** List the seven levels of the prompt override chain from highest to lowest priority. For each level, explain a concrete scenario where that level would be the active one and why it takes precedence over lower levels.

[View Answer](../../answers/05-prompt-engineering/answer-55.md#exercise-1)

### Exercise 2 — Parallel Section Loading
**Question:** Why does `buildStructuredPrompt()` use `Promise.all()` to resolve sections in parallel? List four sections that involve I/O and explain why sequential loading would be significantly slower.

[View Answer](../../answers/05-prompt-engineering/answer-55.md#exercise-2)

### Exercise 3 — Build a Minimal Assembly Pipeline
**Challenge:** Write a `buildStructuredPrompt(config)` function that: (1) resolves static and dynamic sections in parallel, (2) joins each group, (3) appends custom instructions if present, and (4) returns a two-element `SystemPromptBlock[]` array with cache control on the first element.

Write your solution in your IDE first, then check:

[View Answer](../../answers/05-prompt-engineering/answer-55.md#exercise-3)

### Exercise 4 — Pipeline Test Suite
**Challenge:** Write three test cases for a prompt assembly pipeline: (1) verify static content is identical across two calls, (2) verify `cache_control` is set on the first block only, (3) verify an override prompt replaces all sections. Use pseudocode or your preferred test framework.

Write your solution in your IDE first, then check:

[View Answer](../../answers/05-prompt-engineering/answer-55.md#exercise-4)

### Exercise 5 — Performance Budgets
**Question:** The lesson states that prompt assembly should take less than 50ms. Which sections are the performance bottleneck and why? What techniques does Claude Code use to keep assembly fast?

[View Answer](../../answers/05-prompt-engineering/answer-55.md#exercise-5)
