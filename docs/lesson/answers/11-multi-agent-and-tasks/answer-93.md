# Answers: Lesson 93 — Plan Mode

## Exercise 1
**Challenge:** Implement `getAvailableTools()` with dynamic mode-switching tools.

**Answer:**
```typescript
interface Tool {
  name: string;
  description: string;
  isReadOnly: boolean;
}

const EnterPlanModeTool: Tool = {
  name: "enter_plan_mode",
  description: "Switch to plan mode for read-only exploration and planning.",
  isReadOnly: true,
};

const ExitPlanModeTool: Tool = {
  name: "exit_plan_mode",
  description: "Exit plan mode and return to full execution.",
  isReadOnly: true,
};

function getAvailableTools(allTools: Tool[], inPlanMode: boolean): Tool[] {
  const filtered = inPlanMode
    ? allTools.filter((tool) => tool.isReadOnly)
    : allTools;

  const modeTools = inPlanMode ? [ExitPlanModeTool] : [EnterPlanModeTool];

  return [...filtered, ...modeTools];
}

// Test
function testToolFiltering() {
  const tools: Tool[] = [
    { name: "read_file", description: "", isReadOnly: true },
    { name: "search", description: "", isReadOnly: true },
    { name: "glob", description: "", isReadOnly: true },
    { name: "grep", description: "", isReadOnly: true },
    { name: "list_dir", description: "", isReadOnly: true },
    { name: "git_log", description: "", isReadOnly: true },
    { name: "write_file", description: "", isReadOnly: false },
    { name: "shell", description: "", isReadOnly: false },
    { name: "edit_file", description: "", isReadOnly: false },
    { name: "delete_file", description: "", isReadOnly: false },
  ];

  const normalTools = getAvailableTools(tools, false);
  console.assert(normalTools.length === 11, "Normal: 10 tools + enter_plan_mode");
  console.assert(normalTools.some((t) => t.name === "enter_plan_mode"));
  console.assert(!normalTools.some((t) => t.name === "exit_plan_mode"));

  const planTools = getAvailableTools(tools, true);
  console.assert(planTools.length === 7, "Plan: 6 read-only + exit_plan_mode");
  console.assert(planTools.some((t) => t.name === "exit_plan_mode"));
  console.assert(!planTools.some((t) => t.name === "write_file"));

  console.log("Tool filtering tests passed.");
}
```

**Explanation:** In normal mode, all tools plus `enter_plan_mode` are available. In plan mode, only `isReadOnly: true` tools plus `exit_plan_mode` are returned. Write tools simply don't appear in the API request, making it impossible for the model to call them.

---

## Exercise 2
**Challenge:** Implement model routing with `MODEL_ALIASES`.

**Answer:**
```typescript
interface ModelRouting {
  default: string;
  plan: string;
  fast: string;
}

const MODEL_ALIASES: Record<string, ModelRouting> = {
  sonnet: {
    default: "claude-sonnet-4-20250514",
    plan: "claude-sonnet-4-20250514",
    fast: "claude-haiku-3-20250307",
  },
  opusplan: {
    default: "claude-sonnet-4-20250514",
    plan: "claude-opus-4-20250514",
    fast: "claude-haiku-3-20250307",
  },
  opus: {
    default: "claude-opus-4-20250514",
    plan: "claude-opus-4-20250514",
    fast: "claude-haiku-3-20250307",
  },
};

function resolveModelAlias(alias: string): ModelRouting {
  const routing = MODEL_ALIASES[alias];
  if (!routing) throw new Error(`Unknown model alias: ${alias}`);
  return routing;
}

function getRuntimeMainLoopModel(
  routing: ModelRouting,
  inPlanMode: boolean
): string {
  return inPlanMode ? routing.plan : routing.default;
}

// Tests
function testModelRouting() {
  const opusplan = resolveModelAlias("opusplan");

  const normalModel = getRuntimeMainLoopModel(opusplan, false);
  console.assert(normalModel === "claude-sonnet-4-20250514", "Normal should use Sonnet");

  const planModel = getRuntimeMainLoopModel(opusplan, true);
  console.assert(planModel === "claude-opus-4-20250514", "Plan should use Opus");

  const sonnet = resolveModelAlias("sonnet");
  console.assert(
    getRuntimeMainLoopModel(sonnet, true) === getRuntimeMainLoopModel(sonnet, false),
    "Sonnet alias should use same model in both modes"
  );

  console.log("Model routing tests passed.");
}
```

**Explanation:** The `opusplan` alias provides the key cost optimization: Sonnet (fast, cheap) for the 95% of tokens spent executing, Opus (slow, expensive, smart) for the 5% spent planning. The routing function simply checks the boolean flag and returns the appropriate model string.

---

## Exercise 3
**Challenge:** Implement the plan-mode-aware agent loop.

**Answer:**
```typescript
interface ConversationState {
  messages: { role: string; content: string }[];
  inPlanMode: boolean;
}

async function agentLoop(
  state: ConversationState,
  routing: ModelRouting,
  allTools: Tool[],
  callModel: (model: string, messages: any[], tools: Tool[]) => Promise<any>,
  executeTool: (name: string, params: any) => Promise<string>
): Promise<void> {
  while (true) {
    const model = getRuntimeMainLoopModel(routing, state.inPlanMode);
    const tools = getAvailableTools(allTools, state.inPlanMode);

    const response = await callModel(model, state.messages, tools);

    for (const toolCall of response.toolCalls ?? []) {
      if (toolCall.name === "enter_plan_mode") {
        state.inPlanMode = true;
        state.messages.push({
          role: "assistant",
          content: `Entering plan mode: ${toolCall.params.reason}`,
        });
        state.messages.push({
          role: "tool",
          content: "Plan mode active. Only read-only tools are available.",
        });
      } else if (toolCall.name === "exit_plan_mode") {
        state.inPlanMode = false;
        state.messages.push({
          role: "assistant",
          content: `Plan complete: ${toolCall.params.plan_summary}`,
        });
        state.messages.push({
          role: "tool",
          content: "Exited plan mode. All tools are now available.",
        });
      } else {
        const result = await executeTool(toolCall.name, toolCall.params);
        state.messages.push({ role: "tool", content: result });
      }
    }

    if (response.stopReason === "end_turn") break;
  }
}
```

**Explanation:** The loop re-evaluates both the model and the tool list on every iteration. Mode transitions happen via tool call handling — when the model calls `enter_plan_mode`, the state flips and the very next iteration uses the planning model with read-only tools. Confirmation messages keep the conversation history accurate.

---

## Exercise 4
**Question:** For each request, should the agent enter plan mode?

**Answer:**
- **(a) "Fix the typo in README.md line 3"** — No. This is a single-file, single-line change. Planning would add overhead without benefit.
- **(b) "Refactor the database layer to use connection pooling"** — Yes. This is an architectural change affecting multiple files with dependency implications. Planning identifies which modules depend on the current interface and the safest migration order.
- **(c) "Add a new /users API endpoint with CRUD operations"** — Yes. This involves creating routes, controllers, validation, database queries, and tests across multiple files. Planning maps out the file structure and interface design before writing code.
- **(d) "What does the config.ts file do?"** — No. This is a read-only question that only requires reading one file. No changes are planned, so plan mode adds nothing.
- **(e) "Migrate the frontend from JavaScript to TypeScript"** — Yes. This is a large-scale migration touching potentially every file. Planning identifies the dependency order, shared types to extract, and which files to migrate first to minimize build breakage.

---

## Exercise 5
**Challenge:** Write a `PlanModeCostAnalyzer`.

**Answer:**
```typescript
interface Operation {
  phase: "planning" | "execution";
  tokens: number;
}

interface CostAnalysis {
  opusCost: number;
  opusplanCost: number;
  savings: number;
  savingsPercent: number;
}

class PlanModeCostAnalyzer {
  private readonly SONNET_COST_PER_TOKEN = 1;
  private readonly OPUS_COST_PER_TOKEN = 3;

  analyze(operations: Operation[]): CostAnalysis {
    let planTokens = 0;
    let execTokens = 0;

    for (const op of operations) {
      if (op.phase === "planning") planTokens += op.tokens;
      else execTokens += op.tokens;
    }

    const totalTokens = planTokens + execTokens;

    // Opus: everything at Opus pricing
    const opusCost = totalTokens * this.OPUS_COST_PER_TOKEN;

    // Opusplan: planning at Opus, execution at Sonnet
    const opusplanCost =
      planTokens * this.OPUS_COST_PER_TOKEN +
      execTokens * this.SONNET_COST_PER_TOKEN;

    const savings = opusCost - opusplanCost;

    return {
      opusCost,
      opusplanCost,
      savings,
      savingsPercent: totalTokens > 0 ? (savings / opusCost) * 100 : 0,
    };
  }
}

// Example
const analyzer = new PlanModeCostAnalyzer();
const result = analyzer.analyze([
  { phase: "planning", tokens: 5000 },   // 5% planning
  { phase: "execution", tokens: 95000 }, // 95% execution
]);
// opusCost: 300000 (100K * 3)
// opusplanCost: 15000 + 95000 = 110000
// savings: 190000 (63% savings)
```

**Explanation:** With typical 5%/95% planning/execution splits, `opusplan` saves roughly 63% compared to running Opus for everything. The planning tokens still get Opus-level reasoning quality, while the bulk of execution tokens use the cheaper Sonnet model. The savings increase as the execution-to-planning ratio grows.
