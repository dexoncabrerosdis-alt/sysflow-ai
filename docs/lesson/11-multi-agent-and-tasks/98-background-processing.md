# Lesson 98 — Background Processing: Work That Happens in Parallel

Not all agent work is interactive. Some tasks run in the background while the
user continues working — or even while the user is away. Background processing
covers long-running shell commands, autonomous agents, remote workers, and
proactive tasks that the agent initiates on its own.

## Background Task Types

The task system defines several concrete task types, each suited to a different
execution model:

```typescript
type BackgroundTaskType =
  | "LocalShellTask"        // Shell command running locally
  | "LocalAgentTask"        // Sub-agent running in the same process
  | "RemoteAgentTask"       // Agent running on a remote server
  | "InProcessTeammateTask" // Peer agent in coordinator mode
  | "WorkflowTask";         // Multi-step orchestrated workflow

interface BackgroundTask {
  id: string;
  type: BackgroundTaskType;
  description: string;
  state: "running" | "completed" | "failed" | "stopped";
  startedAt: number;
  output: string[];
  tokenUsage: { input: number; output: number };
}
```

Each type follows the same `BackgroundTask` interface but differs in what it
wraps:

| Type                    | What it wraps                              |
| ----------------------- | ------------------------------------------ |
| `LocalShellTask`        | A `spawn()` child process running locally  |
| `LocalAgentTask`        | A sub-agent loop in the same process       |
| `RemoteAgentTask`       | An API session on a remote server (polled) |
| `InProcessTeammateTask` | A peer agent with its own role/tools       |
| `WorkflowTask`          | A sequence of chained sub-tasks            |

Here is the simplest one — a shell command backgrounded so it does not block
the conversation:

```typescript
class LocalShellTask implements BackgroundTask {
  type = "LocalShellTask" as const;
  private process: ChildProcess;

  async start(command: string, cwd: string): Promise<void> {
    this.process = spawn("bash", ["-c", command], { cwd });
    this.state = "running";

    this.process.stdout?.on("data", (data) => {
      this.output.push(data.toString());
    });

    this.process.on("exit", (code) => {
      this.state = code === 0 ? "completed" : "failed";
    });
  }
}
```

And the agent-based version — what the coordinator spawns via `AgentTool`:

```typescript
class LocalAgentTask implements BackgroundTask {
  type = "LocalAgentTask" as const;
  private agent: SubAgent;

  async start(task: string, tools: Tool[]): Promise<void> {
    this.agent = await createSubAgent({
      task,
      allowedTools: tools.map((t) => t.name),
    });
    this.state = "running";

    runSubAgent(this.agent)
      .then((result) => {
        this.output.push(result);
        this.state = "completed";
      })
      .catch((error) => {
        this.output.push(`Error: ${error.message}`);
        this.state = "failed";
      });
  }
}
```

The remote, teammate, and workflow variants follow the same pattern — they
differ only in how they start execution and poll for completion.

## taskBudgetRemaining: Limiting Token Spend

Background tasks consume tokens without interactive oversight. Without limits,
a stuck sub-agent could burn through an entire API budget. The budget system
prevents this:

```typescript
interface TaskBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  usedInputTokens: number;
  usedOutputTokens: number;
}

function taskBudgetRemaining(budget: TaskBudget): {
  input: number;
  output: number;
} {
  return {
    input: Math.max(0, budget.maxInputTokens - budget.usedInputTokens),
    output: Math.max(0, budget.maxOutputTokens - budget.usedOutputTokens),
  };
}

function checkBudgetBeforeApiCall(
  budget: TaskBudget,
  estimatedTokens: { input: number; output: number }
): boolean {
  const remaining = taskBudgetRemaining(budget);
  return (
    remaining.input >= estimatedTokens.input &&
    remaining.output >= estimatedTokens.output
  );
}
```

The budget check happens before every API call in the background agent's loop:

```typescript
async function runBudgetedAgentLoop(
  agent: SubAgent,
  budget: TaskBudget
): Promise<string> {
  while (true) {
    const remaining = taskBudgetRemaining(budget);

    if (remaining.input <= 0 || remaining.output <= 0) {
      return "Task stopped: token budget exhausted. " +
             `Used ${budget.usedInputTokens} input, ` +
             `${budget.usedOutputTokens} output tokens.`;
    }

    const response = await callModel(
      getWorkerModel(),
      agent.systemPrompt,
      agent.messages,
      agent.tools,
      { maxTokens: Math.min(4096, remaining.output) }
    );

    // Track usage
    budget.usedInputTokens += response.usage.inputTokens;
    budget.usedOutputTokens += response.usage.outputTokens;

    // ... normal agent loop continues ...
  }
}
```

## taskSummaryModule: Summaries for Background Sessions

Background tasks can generate large amounts of output. When the coordinator
checks on a completed task, it needs a summary, not a raw dump:

```typescript
async function taskSummaryModule(
  taskOutput: string[],
  maxSummaryTokens: number = 500
): Promise<string> {
  const fullOutput = taskOutput.join("\n");

  if (estimateTokens(fullOutput) <= maxSummaryTokens) {
    return fullOutput;
  }

  // Use a fast model to summarize
  const summary = await callModel(
    getFastModel(),
    "Summarize this task output concisely. Focus on: what was done, " +
    "what succeeded, what failed, and any important details.",
    [{ role: "user", content: fullOutput }],
    [],
    { maxTokens: maxSummaryTokens }
  );

  return summary.content;
}
```

## Proactive/Autonomous Mode

The `PROACTIVE` feature flag enables the agent to initiate work without
explicit user requests:

```typescript
const PROACTIVE_MODE = hasFeatureFlag("PROACTIVE");

interface ProactiveConfig {
  enabled: boolean;
  triggers: ProactiveTrigger[];
  maxConcurrentTasks: number;
  requireApproval: boolean;
}

interface ProactiveTrigger {
  event: "file_change" | "test_failure" | "lint_error" | "schedule";
  pattern?: string;
  action: string;
}
```

In proactive mode, the agent watches for events (file changes, test failures,
lint errors, scheduled triggers) and responds — either requesting user approval
first or acting autonomously, depending on configuration.

## SleepTool: Pacing for Autonomous Agents

Autonomous agents that run indefinitely need to pace themselves. The
`SleepTool` introduces deliberate pauses:

```typescript
async function executeSleep(params: {
  durationMs: number;
  reason?: string;
}): Promise<string> {
  const maxSleep = 5 * 60 * 1000;
  const duration = Math.min(params.durationMs, maxSleep);
  await new Promise((resolve) => setTimeout(resolve, duration));
  return `Slept for ${duration}ms.`;
}
```

Without sleep, an autonomous agent would make an API call every loop iteration
— potentially hundreds per minute. Sleep lets it poll at a sane interval.

## PushNotificationTool: Alerting the User

Background and autonomous agents need a way to get the user's attention
when something important happens:

The `PushNotificationTool` takes a `title`, `body`, and `urgency` level
(low/normal/high). It tries IDE toast notifications first, falls back to
system notifications, and queues for the next user interaction if neither
is available.

## Putting It Together

Here is background processing in action:

```
User: "Watch for test failures and auto-fix them while I work."

Agent → enters proactive mode, starts file watcher, sleeps 30s

[User edits src/api/users.ts — introduces a type error]

File watcher triggers → Agent wakes
  → Runs `npm test` (LocalShellTask, background)
  → Sleeps 60s while tests run
  → Tests fail: 1 failure in getUserById

Agent → creates LocalAgentTask:
  "Fix the type error in src/api/users.ts:42. Error: Type 'string'
   is not assignable to type 'number'."
  → Sub-agent reads, fixes, re-runs tests → pass
  → Budget check: 45K tokens remaining

Agent → PushNotification:
  title: "Test fix applied"
  body: "Fixed type error in src/api/users.ts:42. Tests passing."

Agent → back to sleep, watching for next trigger
```

The user kept working the entire time. The agent detected the problem, fixed
it, verified the fix, and notified — all in the background.

## What You Have Learned

- Five background task types serve different execution models: local shell,
  local agent, remote agent, in-process teammate, and workflow
- `taskBudgetRemaining` prevents background tasks from consuming unlimited
  tokens
- `taskSummaryModule` compresses verbose task output for the coordinator
- Proactive mode lets agents initiate work based on file changes, test
  failures, and other triggers
- `SleepTool` paces autonomous agents to avoid wasteful rapid polling
- `PushNotificationTool` alerts users when background work needs attention
- Together, these systems enable agents that work continuously alongside
  the user, not just in response to explicit commands

---

*This concludes Module 11: Multi-Agent and Tasks.*

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Background Task Manager
**Challenge:** Implement a `BackgroundTaskManager` that supports registering, running, and polling `LocalShellTask` and `LocalAgentTask` types. It should: start tasks non-blocking, track their state, collect output, and support listing all tasks filtered by state. Test with a mock shell task that completes after 2 seconds.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-98.md#exercise-1)

### Exercise 2 — Token Budget System
**Challenge:** Implement `taskBudgetRemaining()` and a `BudgetedAgentLoop` that checks the budget before every API call. When the budget is exhausted, the loop should terminate gracefully with a summary of what was accomplished and how many tokens were used. Test with a budget of 10,000 output tokens and a mock model that uses ~2,000 per call.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-98.md#exercise-2)

### Exercise 3 — Task Summary Module
**Challenge:** Implement `taskSummaryModule()` that compresses verbose task output into a concise summary. If the output is under the token limit, return it as-is. If over the limit, use a mock summarizer. Test with both short output (under 500 tokens) and long output (over 2000 tokens).

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-98.md#exercise-3)

### Exercise 4 — Proactive Trigger System
**Challenge:** Implement a `ProactiveTriggerSystem` that watches for events (file changes, test failures, lint errors) and fires actions when patterns match. Support: registering triggers with glob patterns, debouncing rapid-fire events (e.g., multiple file saves), and an `requireApproval` mode that queues actions for user confirmation.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-98.md#exercise-4)

### Exercise 5 — Background Processing Risks
**Question:** Background agents can act without user oversight. Describe in 4-5 sentences: (a) the specific dangers of a background agent with write access and no budget limit, (b) how `taskBudgetRemaining` mitigates the cost danger, and (c) why `PushNotificationTool` is important for user trust. Give an example of a background agent going wrong without these safeguards.

[View Answer](../../answers/11-multi-agent-and-tasks/answer-98.md#exercise-5)
