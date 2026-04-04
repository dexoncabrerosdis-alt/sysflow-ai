# Answers: Lesson 95 — Sub-Agents

## Exercise 1
**Challenge:** Implement `createSubAgent()` and `runSubAgent()`.

**Answer:**
```typescript
interface SubAgent {
  id: string;
  systemPrompt: string;
  messages: { role: string; content: string }[];
  tools: string[];
  workingDirectory: string;
  status: "running" | "completed" | "failed";
  result?: string;
}

let agentCounter = 0;

function createSubAgent(params: {
  task: string;
  workingDirectory?: string;
  allowedTools?: string[];
}): SubAgent {
  const id = `agent_${++agentCounter}`;
  const cwd = params.workingDirectory ?? process.cwd();

  const systemPrompt = enhanceSystemPromptWithEnvDetails(
    "You are a worker agent. Complete the assigned task efficiently.",
    { cwd, os: process.platform, shell: process.env.SHELL ?? "bash" }
  );

  return {
    id,
    systemPrompt,
    messages: [{ role: "user", content: params.task }],
    tools: params.allowedTools ?? ["read_file", "write_file", "shell", "search", "glob"],
    workingDirectory: cwd,
    status: "running",
  };
}

function enhanceSystemPromptWithEnvDetails(
  base: string,
  env: { cwd: string; os: string; shell: string }
): string {
  return `${base}

## Environment
- Working directory: ${env.cwd}
- Operating system: ${env.os}
- Shell: ${env.shell}

## Important
You are a worker agent. Do not ask the user questions — they cannot see
your messages. Make reasonable assumptions and document them in your response.`;
}

async function runSubAgent(
  agent: SubAgent,
  callModel: (prompt: string, messages: any[], tools: string[]) => Promise<{
    content: string;
    toolCalls: { name: string; params: any }[];
    stopReason: string;
  }>,
  executeTool: (name: string, params: any) => Promise<string>
): Promise<string> {
  try {
    while (true) {
      const response = await callModel(
        agent.systemPrompt,
        agent.messages,
        agent.tools
      );

      for (const tc of response.toolCalls) {
        const result = await executeTool(tc.name, tc.params);
        agent.messages.push({ role: "assistant", content: response.content });
        agent.messages.push({ role: "tool", content: result });
      }

      if (response.stopReason === "end_turn" && response.toolCalls.length === 0) {
        agent.status = "completed";
        agent.result = response.content;
        return response.content;
      }
    }
  } catch (error) {
    agent.status = "failed";
    throw error;
  }
}
```

**Explanation:** `createSubAgent` builds an isolated agent with its own system prompt, message history (just the task), and tool set. `runSubAgent` runs the standard agent loop: call model, execute tools, repeat until `end_turn`. The agent has full autonomy within its loop but cannot see the parent's conversation.

---

## Exercise 2
**Challenge:** Implement parallel sub-agent execution with timing comparison.

**Answer:**
```typescript
async function executeParallelAgents(
  tasks: { task: string; cwd?: string }[],
  callModel: any,
  executeTool: any
): Promise<{ results: string[]; durationMs: number }> {
  const start = Date.now();

  const agents = tasks.map((t) =>
    createSubAgent({ task: t.task, workingDirectory: t.cwd })
  );

  const results = await Promise.all(
    agents.map((agent) => runSubAgent(agent, callModel, executeTool))
  );

  return { results, durationMs: Date.now() - start };
}

async function executeSequentialAgents(
  tasks: { task: string; cwd?: string }[],
  callModel: any,
  executeTool: any
): Promise<{ results: string[]; durationMs: number }> {
  const start = Date.now();
  const results: string[] = [];

  for (const t of tasks) {
    const agent = createSubAgent({ task: t.task, workingDirectory: t.cwd });
    const result = await runSubAgent(agent, callModel, executeTool);
    results.push(result);
  }

  return { results, durationMs: Date.now() - start };
}

// Test
async function testParallelVsSequential() {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const mockCallModel = async () => {
    await delay(1000); // simulate 1 second API call
    return { content: "Done.", toolCalls: [], stopReason: "end_turn" };
  };
  const mockExecuteTool = async () => "ok";

  const tasks = [
    { task: "Task A" },
    { task: "Task B" },
    { task: "Task C" },
  ];

  const parallel = await executeParallelAgents(tasks, mockCallModel, mockExecuteTool);
  const sequential = await executeSequentialAgents(tasks, mockCallModel, mockExecuteTool);

  console.log(`Parallel: ${parallel.durationMs}ms`);    // ~1000ms
  console.log(`Sequential: ${sequential.durationMs}ms`); // ~3000ms
  console.log(`Speedup: ${(sequential.durationMs / parallel.durationMs).toFixed(1)}x`);
}
```

**Explanation:** `Promise.all` runs all sub-agent loops concurrently. Each sub-agent makes its own independent API calls. With three 1-second tasks, parallel execution takes ~1 second (limited by the slowest task) while sequential takes ~3 seconds. The speedup scales with the number of independent subtasks.

---

## Exercise 3
**Challenge:** Implement specialized agent teams.

**Answer:**
```typescript
type AgentRole = "researcher" | "implementer" | "tester";

const ROLE_TOOLS: Record<AgentRole, string[]> = {
  researcher: ["read_file", "search", "glob", "grep", "list_dir"],
  implementer: ["read_file", "write_file", "edit_file", "shell", "search", "glob"],
  tester: ["read_file", "shell", "grep", "glob"],
};

interface AgentTeam {
  name: string;
  members: Map<AgentRole, SubAgent[]>;
}

function createTeam(name: string): AgentTeam {
  return {
    name,
    members: new Map([
      ["researcher", []],
      ["implementer", []],
      ["tester", []],
    ]),
  };
}

function assignRole(taskDescription: string): AgentRole {
  const lower = taskDescription.toLowerCase();

  const researchKeywords = ["find", "search", "analyze", "understand", "explore", "investigate", "list", "what", "how", "where"];
  const testKeywords = ["test", "verify", "check", "validate", "run tests", "ensure", "assert"];
  const implementKeywords = ["implement", "create", "write", "build", "add", "fix", "update", "refactor", "migrate", "modify"];

  const scores: Record<AgentRole, number> = { researcher: 0, implementer: 0, tester: 0 };

  for (const kw of researchKeywords) if (lower.includes(kw)) scores.researcher++;
  for (const kw of testKeywords) if (lower.includes(kw)) scores.tester++;
  for (const kw of implementKeywords) if (lower.includes(kw)) scores.implementer++;

  const entries = Object.entries(scores) as [AgentRole, number][];
  entries.sort((a, b) => b[1] - a[1]);

  return entries[0][1] > 0 ? entries[0][0] : "implementer";
}

function spawnSpecializedAgent(
  team: AgentTeam,
  task: string,
  role?: AgentRole
): SubAgent {
  const assignedRole = role ?? assignRole(task);
  const tools = ROLE_TOOLS[assignedRole];

  const agent = createSubAgent({ task, allowedTools: tools });
  team.members.get(assignedRole)!.push(agent);
  return agent;
}
```

**Explanation:** Each role maps to a specific tool subset. Researchers can explore but not modify. Implementers have full access. Testers can read and run commands but not edit. The `assignRole` function uses keyword scoring to automatically pick the right specialization, with `implementer` as the default.

---

## Exercise 4
**Question:** Context isolation tradeoffs.

**Answer:**
**(a) Isolation saves the agent:** A coordinator spawns Worker A to refactor module X and Worker B to refactor module Y. Worker A encounters a confusing error and starts hallucinating — generating incorrect code based on a misunderstood error message. Because Worker A's hallucination lives only in its own context, Worker B is completely unaffected and continues working correctly. The coordinator receives Worker A's bad output as a string, notices it doesn't make sense, and simply retries with a fresh worker. Without isolation, Worker A's hallucinated messages would have polluted the shared conversation and potentially confused Worker B too.

**(b) Isolation causes a problem:** The user tells the coordinator "the database password is in .env, not hardcoded — use process.env.DB_PASSWORD." The coordinator spawns a worker to update the database module, but forgets to include this instruction in the task description. The worker reads the database code, sees the hardcoded password, and leaves it in place because it has no knowledge of the user's preference. The fix: the coordinator must include ALL relevant context in the task string — it should have said "Update the database module to use connection pooling. Important: the user requires that the password comes from process.env.DB_PASSWORD, not hardcoded."

---

## Exercise 5
**Challenge:** Implement `SubAgentCostCalculator`.

**Answer:**
```typescript
interface CostEstimate {
  decision: "delegate" | "self";
  delegateCost: number;
  selfCost: number;
  reasoning: string;
}

class SubAgentCostCalculator {
  private readonly SYSTEM_PROMPT_OVERHEAD = 2000; // tokens
  private readonly MIN_RESPONSE_TOKENS = 500;
  private readonly TOKENS_PER_TOOL_CALL = 800; // avg input + output per tool round
  private readonly API_LATENCY_MS = 1000;
  private readonly COST_PER_TOKEN = 0.001; // arbitrary unit

  estimate(params: {
    estimatedToolCalls: number;
    taskComplexity: "simple" | "moderate" | "complex";
    canRunInParallel: boolean;
    coordinatorContextTokens: number;
  }): CostEstimate {
    const { estimatedToolCalls, canRunInParallel, coordinatorContextTokens } = params;

    // Cost of delegating to a sub-agent
    const subAgentInputTokens =
      this.SYSTEM_PROMPT_OVERHEAD +
      estimatedToolCalls * this.TOKENS_PER_TOOL_CALL;
    const subAgentOutputTokens =
      this.MIN_RESPONSE_TOKENS +
      estimatedToolCalls * 200;
    const delegateCost =
      (subAgentInputTokens + subAgentOutputTokens) * this.COST_PER_TOKEN;

    // Cost of coordinator doing it directly
    // The coordinator already has a large context — each tool call adds to it
    const selfInputPerCall = coordinatorContextTokens + this.TOKENS_PER_TOOL_CALL;
    const selfTotalInput = estimatedToolCalls * selfInputPerCall;
    const selfOutputTokens = estimatedToolCalls * 200;
    const selfCost = (selfTotalInput + selfOutputTokens) * this.COST_PER_TOKEN;

    // Decision logic
    if (estimatedToolCalls <= 2) {
      return {
        decision: "self",
        delegateCost,
        selfCost,
        reasoning: `Only ${estimatedToolCalls} tool calls — sub-agent overhead (${this.SYSTEM_PROMPT_OVERHEAD} tokens) exceeds the work`,
      };
    }

    if (canRunInParallel) {
      return {
        decision: "delegate",
        delegateCost,
        selfCost,
        reasoning: "Task can run in parallel — delegation provides wall-clock speedup",
      };
    }

    if (delegateCost < selfCost * 0.8) {
      return {
        decision: "delegate",
        delegateCost,
        selfCost,
        reasoning: `Sub-agent is cheaper: fresh context (${this.SYSTEM_PROMPT_OVERHEAD} base) vs coordinator's bloated context (${coordinatorContextTokens} tokens)`,
      };
    }

    return {
      decision: "self",
      delegateCost,
      selfCost,
      reasoning: "Costs are similar — avoiding delegation overhead",
    };
  }
}
```

**Explanation:** The calculator weighs the sub-agent's fixed overhead (system prompt) against the coordinator's growing context size. With a small coordinator context, self-execution is cheaper. But as the coordinator's context grows (common in long sessions), delegating to a fresh sub-agent with a clean 2K-token context becomes cheaper because each API call processes fewer input tokens. Parallelism always favors delegation due to wall-clock speedup.
