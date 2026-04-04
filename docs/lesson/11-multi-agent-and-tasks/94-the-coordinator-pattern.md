# Lesson 94 — The Coordinator Pattern: One Agent Directing Many

A single agent has one conversation, one context window, one thread of
execution. For large tasks — migrating a codebase, implementing a feature
across multiple services, running parallel investigations — this becomes a
bottleneck. The coordinator pattern breaks through it: one agent directs
multiple workers, each with their own context and tools.

## The Architecture

```
                     ┌──────────────┐
                     │  Coordinator │
                     │  (main agent)│
                     └──────┬───────┘
                            │
              ┌─────────────┼──────────────┐
              │             │              │
        ┌─────▼────┐  ┌────▼─────┐  ┌─────▼────┐
        │ Worker A  │  │ Worker B │  │ Worker C  │
        │ (agent)   │  │ (agent)  │  │ (agent)   │
        └──────────┘  └──────────┘  └──────────┘
```

The coordinator is not a special system. It is a regular agent with a modified
system prompt and three additional tools: `AgentTool` (spawn a worker),
`SendMessageTool` (continue a conversation with a worker), and `TaskStopTool`
(terminate a worker). The coordinator model sees the same kind of messages,
uses the same API — it just has different instructions and different tools.

## Activating Coordinator Mode

Coordinator mode is a configuration flag. When set, the agent loop loads
a different system prompt and adds the multi-agent tools:

```typescript
const CLAUDE_CODE_COORDINATOR_MODE = process.env.CLAUDE_CODE_COORDINATOR_MODE;

function buildSystemPrompt(mode: string | undefined): string {
  if (mode === "coordinator") {
    return getCoordinatorSystemPrompt();
  }
  return getDefaultSystemPrompt();
}

function buildToolSet(mode: string | undefined): Tool[] {
  const base = getBaseTools();
  if (mode === "coordinator") {
    return [...base, AgentTool, SendMessageTool, TaskStopTool];
  }
  return base;
}
```

## The Coordinator System Prompt

The coordinator prompt from `coordinatorMode.ts` is direct and specific. It
tells the model exactly what it is, what it should do, and what it should
avoid:

```markdown
You are a coordinator agent. Your job is to break down complex tasks and
delegate them to worker agents.

## Your Role

- Analyze the user's request and identify parallelizable subtasks
- Spawn worker agents for each subtask using the AgentTool
- Monitor workers and synthesize their results
- Report back to the user with a unified answer

## Rules

1. **Don't delegate trivial work.** If a task takes fewer than 3 tool calls
   to complete, do it yourself. Spawning a worker has overhead.

2. **Don't use one worker to check another.** Workers are peers, not
   reviewers. If you need verification, do it yourself or ask the user.

3. **Launch then inform.** When spawning workers, launch them first, then
   tell the user what you launched. Don't ask permission for each worker
   — act, then report.

4. **Keep workers focused.** Each worker should have a single, clear
   objective. Don't give a worker multiple unrelated tasks.

5. **Synthesize, don't relay.** When workers return results, combine them
   into a coherent answer. Don't just dump each worker's output.

6. **Handle failures gracefully.** If a worker fails, decide whether to
   retry, work around it, or report the failure to the user.

## What Workers Can Do

Workers are full agents. They can read files, write files, run commands,
search code — everything you can do. They run in their own conversation
with their own context window.

## What Workers Cannot Do

Workers cannot talk to the user. Only you can communicate with the user.
Workers cannot see each other or coordinate directly. All coordination
goes through you.
```

This prompt encodes hard-won lessons. Rule 1 prevents the overhead of spawning
agents for simple lookups. Rule 2 prevents infinite loops of agents checking
each other. Rule 3 keeps the interaction responsive — users see progress
immediately rather than waiting for the coordinator to ask permission.

## AgentTool: Spawning Workers

The `AgentTool` creates a new agent with its own conversation and context:

```typescript
const AgentTool = {
  name: "agent",
  description:
    "Spawn a worker agent to handle a subtask. The worker runs autonomously " +
    "with its own conversation and tools. Returns the worker's final result.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "Clear, specific instructions for the worker. Include all " +
          "context the worker needs — it cannot see your conversation.",
      },
      workingDirectory: {
        type: "string",
        description: "Directory the worker should operate in",
      },
      allowedTools: {
        type: "array",
        items: { type: "string" },
        description: "Optional: restrict which tools the worker can use",
      },
    },
    required: ["task"],
  },
};
```

When executed, the tool:

1. Creates a fresh conversation (empty message history)
2. Builds a system prompt for the worker (including environment details)
3. Adds the `task` as the first user message
4. Runs a full agent loop to completion
5. Returns the worker's final text response to the coordinator

```typescript
async function executeAgentTool(params: {
  task: string;
  workingDirectory?: string;
  allowedTools?: string[];
}): Promise<string> {
  const workerSystemPrompt = buildWorkerSystemPrompt(params.workingDirectory);
  const workerTools = params.allowedTools
    ? filterTools(allTools, params.allowedTools)
    : allTools;

  const workerMessages: Message[] = [
    { role: "user", content: params.task },
  ];

  // Run the worker's own agent loop
  const result = await runAgentLoop({
    systemPrompt: workerSystemPrompt,
    messages: workerMessages,
    tools: workerTools,
    cwd: params.workingDirectory ?? process.cwd(),
  });

  return result.finalResponse;
}
```

The worker has no knowledge of the coordinator's conversation. It receives only
the `task` string. This is why the coordinator prompt says "Include all context
the worker needs."

## SendMessageTool: Continuing a Conversation

Sometimes a worker finishes and you need follow-up. `SendMessageTool` sends
another message to an existing worker's conversation:

```typescript
const SendMessageTool = {
  name: "send_message",
  description:
    "Send a follow-up message to a running or completed worker agent. " +
    "Use this to provide additional instructions or ask for clarification.",
  parameters: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "ID of the worker agent to message",
      },
      message: {
        type: "string",
        description: "The message to send to the worker",
      },
    },
    required: ["agentId", "message"],
  },
};
```

This preserves the worker's full context. The worker sees the new message as a
continuation of its conversation and can pick up where it left off.

## TaskStopTool: Terminating Workers

If a worker is stuck, taking too long, or no longer needed:

```typescript
const TaskStopTool = {
  name: "task_stop",
  description: "Stop a running worker agent.",
  parameters: {
    type: "object",
    properties: {
      agentId: {
        type: "string",
        description: "ID of the worker agent to stop",
      },
      reason: {
        type: "string",
        description: "Why the worker is being stopped",
      },
    },
    required: ["agentId"],
  },
};
```

## A Coordinator in Action

Here is a realistic interaction for a multi-service migration:

```
User: "Migrate all API endpoints from Express to Fastify across the
       user-service, order-service, and notification-service."

Coordinator thinking:
  Three independent services. Each migration is self-contained.
  This is ideal for parallel workers.

Coordinator: [spawns Worker A]
  task: "Migrate all Express routes in /services/user-service to Fastify.
         Preserve all middleware behavior. Update tests. The service uses
         Express 4.x with body-parser and cors middleware."

Coordinator: [spawns Worker B]
  task: "Migrate all Express routes in /services/order-service to Fastify.
         Preserve all middleware behavior. Update tests. This service uses
         Express 4.x with authentication middleware in /middleware/auth.js."

Coordinator: [spawns Worker C]
  task: "Migrate all Express routes in /services/notification-service to
         Fastify. Preserve all middleware behavior. Update tests. This is
         a small service with 3 routes."

Coordinator → User:
  "I've launched three workers to handle the migration in parallel:
   - Worker A: user-service
   - Worker B: order-service
   - Worker C: notification-service
   Each will convert Express routes to Fastify and update tests.
   I'll synthesize results when they complete."

[Workers execute independently...]

Coordinator (after all workers complete):
  "Migration complete across all three services:
   - user-service: 12 routes migrated, 8 tests updated, all passing
   - order-service: 9 routes migrated, auth middleware adapted, 6 tests updated
   - notification-service: 3 routes migrated, 2 tests updated
   Total: 24 routes migrated. Run `npm test` in each service to verify."
```

## What You Have Learned

- The coordinator is a regular agent with a special system prompt and tools
- `AgentTool` spawns workers with independent conversations and context
- `SendMessageTool` continues an existing worker conversation
- `TaskStopTool` terminates workers that are stuck or unnecessary
- Coordinator rules prevent common pitfalls: trivial delegation, circular
  checking, and poor communication with the user
- Workers cannot see each other — all coordination flows through the parent
- The pattern works best for parallelizable, large, isolated subtasks

---

*Next lesson: the mechanics of sub-agents — how workers actually run.*

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — AgentTool Executor
**Challenge:** Implement `executeAgentTool()` that creates a worker system prompt, sets up a fresh conversation with the task as the first user message, runs a mock agent loop to completion, and returns the worker's final response string. Include `workingDirectory` and `allowedTools` support.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-94.md#exercise-1)

### Exercise 2 — Coordinator System Prompt
**Challenge:** Write a complete coordinator system prompt that encodes all six rules from the lesson. Then write a function that detects when the model is violating Rule 1 (delegating trivial work): given a task description, estimate its complexity and return whether delegation is appropriate.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-94.md#exercise-2)

### Exercise 3 — Worker Result Synthesizer
**Challenge:** Implement a `synthesizeWorkerResults()` function that takes an array of worker results (each with a worker name, task description, and result text) and produces a single coherent summary for the user. It should handle: all successes, partial failures, and all failures. Don't just concatenate — synthesize.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-94.md#exercise-3)

### Exercise 4 — Coordinator Rules
**Question:** Explain why Rule 2 ("don't use one worker to check another") is critical. Describe the specific failure mode that occurs when Worker A reviews Worker B's output, Worker B reviews Worker A's corrections, and this loop continues. How does this waste tokens?

[View Answer](../../answers/11-multi-agent-and-tasks/answer-94.md#exercise-4)

### Exercise 5 — Parallel Worker Orchestration
**Challenge:** Implement a `CoordinatorOrchestrator` that spawns N workers in parallel, collects their results, handles partial failures (retry failed workers up to once), and returns a combined result. Include a timeout that stops waiting after a configurable duration even if some workers haven't finished.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-94.md#exercise-5)
