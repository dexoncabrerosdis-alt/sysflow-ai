# Lesson 95 — Sub-Agents: Autonomous Workers With Their Own Worlds

The previous lesson showed the coordinator directing workers from above. This
lesson goes inside the workers. How does a sub-agent get created? What does it
see? How does it run? How do results flow back?

## What a Sub-Agent Actually Is

A sub-agent is a complete agent loop running inside another agent's tool
execution. It has:

- Its own **system prompt** (built from environment details, not copied from
  the parent)
- Its own **message history** (starting empty — the task becomes the first
  user message)
- Its own **tool set** (potentially restricted by the parent)
- Its own **context window** (independent token budget)

It does *not* have:

- Access to the parent's conversation history
- Knowledge of other sub-agents running in parallel
- The ability to talk to the user directly

```typescript
interface SubAgent {
  id: string;
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  workingDirectory: string;
  status: "running" | "completed" | "failed" | "stopped";
  result?: string;
}
```

## Creating a Sub-Agent

When the coordinator calls `AgentTool`, the execution path creates a fully
isolated agent environment:

```typescript
async function createSubAgent(params: {
  task: string;
  workingDirectory?: string;
  allowedTools?: string[];
}): Promise<SubAgent> {
  const id = generateAgentId();
  const cwd = params.workingDirectory ?? process.cwd();

  // Build a system prompt with environment details
  const systemPrompt = enhanceSystemPromptWithEnvDetails(
    getBaseWorkerPrompt(),
    {
      cwd,
      os: process.platform,
      shell: process.env.SHELL ?? "bash",
      nodeVersion: process.version,
    }
  );

  // Filter tools if the parent restricted them
  const tools = params.allowedTools
    ? allTools.filter((t) => params.allowedTools!.includes(t.name))
    : allTools;

  return {
    id,
    systemPrompt,
    messages: [{ role: "user", content: params.task }],
    tools,
    workingDirectory: cwd,
    status: "running",
  };
}
```

## enhanceSystemPromptWithEnvDetails

This function is critical. A sub-agent spawned without environment context would
not know its operating system, working directory, or available commands. The
enhancement injects practical details:

```typescript
function enhanceSystemPromptWithEnvDetails(
  basePrompt: string,
  env: {
    cwd: string;
    os: string;
    shell: string;
    nodeVersion: string;
    gitBranch?: string;
    projectType?: string;
  }
): string {
  const envBlock = `
## Environment

- Working directory: ${env.cwd}
- Operating system: ${env.os}
- Shell: ${env.shell}
- Node.js: ${env.nodeVersion}
${env.gitBranch ? `- Git branch: ${env.gitBranch}` : ""}
${env.projectType ? `- Project type: ${env.projectType}` : ""}

## Important

You are a worker agent executing a specific task. Focus on completing
your assigned task efficiently. Do not ask the user questions — they
cannot see your messages. If you encounter ambiguity, make reasonable
assumptions and document them in your response.
`;

  return basePrompt + "\n" + envBlock;
}
```

The "do not ask the user questions" instruction is essential. Sub-agents that
try to clarify with the user will hang forever — their messages go to the
coordinator, not the user, and only after they complete.

## The Sub-Agent's Agent Loop

Once created, the sub-agent runs its own query loop. This is the same agent
loop from Lessons 3-5, just instantiated independently:

```typescript
async function runSubAgent(agent: SubAgent): Promise<string> {
  try {
    while (true) {
      const response = await callModel(
        getWorkerModel(),
        agent.systemPrompt,
        agent.messages,
        agent.tools
      );

      // Process tool calls
      for (const toolCall of response.toolCalls) {
        const result = await executeTool(toolCall, {
          cwd: agent.workingDirectory,
        });
        agent.messages.push(
          { role: "assistant", content: response.content, toolCalls: [toolCall] },
          { role: "tool", toolCallId: toolCall.id, content: result }
        );
      }

      // If the model stopped without tool calls, it is done
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

The sub-agent has full autonomy within its loop. It can read files, write
files, run shell commands, search code — anything in its tool set. It makes
its own decisions about what to do next, just like the top-level agent.

## How Results Flow Back

When a sub-agent completes, its final text response becomes the tool result
that the coordinator sees:

```typescript
// Inside the coordinator's agent loop
case "agent": {
  const agent = await createSubAgent(toolCall.params);
  const result = await runSubAgent(agent);

  // The coordinator sees this as a tool result
  return {
    toolCallId: toolCall.id,
    content: result,  // The sub-agent's final response text
  };
}
```

The coordinator receives a single string — the sub-agent's final message. It
does not see the sub-agent's internal tool calls, reasoning, or intermediate
steps. This is by design: the coordinator operates at a higher level of
abstraction.

```
Coordinator context window:
┌─────────────────────────────────────────────────┐
│ System prompt                                    │
│ User: "Migrate all services to Fastify"          │
│ Assistant: [calls agent tool for user-service]   │
│ Tool result: "Migrated 12 routes in              │
│   user-service. Updated auth middleware to use   │
│   Fastify hooks. All 8 tests passing."           │
│                                                  │
│ (The coordinator doesn't see the 47 tool calls   │
│  the worker made internally)                     │
└─────────────────────────────────────────────────┘
```

## Parallel Execution

A key advantage of sub-agents is parallelism. The coordinator can spawn
multiple workers and await them concurrently:

```typescript
async function executeParallelAgents(
  tasks: AgentTaskParams[]
): Promise<string[]> {
  const agents = await Promise.all(
    tasks.map((task) => createSubAgent(task))
  );

  // Run all agents in parallel
  const results = await Promise.all(
    agents.map((agent) => runSubAgent(agent))
  );

  return results;
}
```

Each sub-agent makes its own API calls, processes its own tool results, and
completes independently. Three workers running in parallel can finish a task
in roughly the time it takes one worker to handle the hardest subtask.

## Agent Swarms: Specialized Workers

For complex projects, you can create teams of specialized workers:

```typescript
interface AgentTeam {
  name: string;
  agents: SubAgent[];
  specializations: Map<string, string[]>; // agent ID → tool restrictions
}

function createSpecializedTeam(): AgentTeam {
  return {
    name: "migration-team",
    agents: [],
    specializations: new Map([
      ["researcher", ["read_file", "search", "glob", "grep"]],
      ["implementer", ["read_file", "write_file", "shell", "search"]],
      ["tester", ["read_file", "shell", "grep"]],
    ]),
  };
}
```

A researcher agent can explore the codebase but cannot modify it. An
implementer can read and write. A tester can read and run commands but not
edit files. The coordinator assigns tasks based on specialization.

## ListPeers: Team Awareness

In team configurations, a `ListPeersTool` lets agents discover their peers —
IDs, roles, and status. This is metadata only; agents cannot message each other
directly. All communication routes through the coordinator.

## Context Isolation: Feature, Not Bug

Why can't the sub-agent see the parent's conversation? The isolation is
deliberate:

- **Context efficiency**: each agent uses its full window for its own task
- **Fault isolation**: a hallucinating sub-agent cannot corrupt the parent's
  state — the coordinator just gets a bad result string and can retry
- **Parallelism safety**: concurrent agents cannot interfere with each other's
  reasoning (they share the filesystem, which requires care, but not state)
- **Security boundary**: restricted tool sets mean a research-only agent cannot
  accidentally delete files, even if it tries

Every sub-agent also pays fixed costs: 1,000–5,000 tokens for its system
prompt, 1–5 seconds of API latency, and a minimum token spend for its first
response. For a 3-tool-call task, this overhead may exceed the cost of the
coordinator doing the work itself — which is why the coordinator's first rule
is "don't delegate trivial work."

## What You Have Learned

- Sub-agents are complete, independent agent loops with their own context
- `enhanceSystemPromptWithEnvDetails` gives sub-agents the environment info
  they need to operate
- Sub-agents cannot see the parent's conversation or talk to the user
- Results flow back as a single string — the sub-agent's final response
- Parallel execution lets multiple sub-agents work simultaneously
- Specialized teams restrict different agents to different tool sets
- `ListPeers` provides team awareness without direct agent-to-agent communication
- Context isolation is a deliberate design choice for efficiency and safety

---

*Next lesson: the task management system — tracking work across agents.*

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Sub-Agent Factory
**Challenge:** Implement the full `createSubAgent()` function and `runSubAgent()` loop. The sub-agent should: receive a task, build its own system prompt with `enhanceSystemPromptWithEnvDetails`, run an agent loop using a mock `callModel` and `executeTool`, and return its final text response. Test with a task like "List all TypeScript files in src/".

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-95.md#exercise-1)

### Exercise 2 — Parallel Execution
**Challenge:** Implement `executeParallelAgents()` that spawns N sub-agents concurrently using `Promise.all`. Track the wall-clock time and compare it to sequential execution. Test with 3 tasks that each take ~1 second (simulated with a delay). Verify that parallel execution completes in ~1 second instead of ~3.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-95.md#exercise-2)

### Exercise 3 — Specialized Agent Teams
**Challenge:** Implement an `AgentTeam` system where different agent roles have different tool restrictions. Create three specializations: `researcher` (read-only tools), `implementer` (read + write tools), and `tester` (read + shell tools). Write a function that assigns a task to the correct specialization based on keywords.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-95.md#exercise-3)

### Exercise 4 — Context Isolation Tradeoffs
**Question:** Sub-agents cannot see the parent's conversation. Describe in 3-4 sentences: (a) a scenario where this isolation saves the agent from a bug, and (b) a scenario where this isolation causes a problem because the sub-agent lacks critical context the parent had. How would you handle scenario (b)?

[View Answer](../../answers/11-multi-agent-and-tasks/answer-95.md#exercise-4)

### Exercise 5 — Sub-Agent Cost Calculator
**Challenge:** Implement a `SubAgentCostCalculator` that estimates whether delegating a task to a sub-agent is cheaper than the coordinator doing it directly. Account for: the sub-agent's system prompt overhead (~2000 tokens), minimum API latency (1 second), and the task's estimated tool call count. The calculator should return "delegate" or "self" with a cost justification.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-95.md#exercise-5)
