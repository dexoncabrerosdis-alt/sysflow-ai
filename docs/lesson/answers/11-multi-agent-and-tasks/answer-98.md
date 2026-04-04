# Answers: Lesson 98 — Background Processing

## Exercise 1
**Challenge:** Implement a `BackgroundTaskManager` with shell and agent task types.

**Answer:**
```typescript
type TaskState = "running" | "completed" | "failed" | "stopped";
type TaskType = "LocalShellTask" | "LocalAgentTask";

interface BackgroundTask {
  id: string;
  type: TaskType;
  description: string;
  state: TaskState;
  startedAt: number;
  output: string[];
  tokenUsage: { input: number; output: number };
}

class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>();
  private taskCounter = 0;

  async startShellTask(
    command: string,
    description: string,
    executeCommand: (cmd: string) => Promise<{ stdout: string; exitCode: number }>
  ): Promise<string> {
    const id = `bg_${++this.taskCounter}`;
    const task: BackgroundTask = {
      id,
      type: "LocalShellTask",
      description,
      state: "running",
      startedAt: Date.now(),
      output: [],
      tokenUsage: { input: 0, output: 0 },
    };

    this.tasks.set(id, task);

    executeCommand(command)
      .then((result) => {
        task.output.push(result.stdout);
        task.state = result.exitCode === 0 ? "completed" : "failed";
      })
      .catch((error) => {
        task.output.push(`Error: ${error.message}`);
        task.state = "failed";
      });

    return id;
  }

  async startAgentTask(
    taskDescription: string,
    description: string,
    runAgent: (task: string) => Promise<string>
  ): Promise<string> {
    const id = `bg_${++this.taskCounter}`;
    const task: BackgroundTask = {
      id,
      type: "LocalAgentTask",
      description,
      state: "running",
      startedAt: Date.now(),
      output: [],
      tokenUsage: { input: 0, output: 0 },
    };

    this.tasks.set(id, task);

    runAgent(taskDescription)
      .then((result) => {
        task.output.push(result);
        task.state = "completed";
      })
      .catch((error) => {
        task.output.push(`Error: ${error.message}`);
        task.state = "failed";
      });

    return id;
  }

  poll(taskId: string): BackgroundTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  list(filterState?: TaskState): BackgroundTask[] {
    const all = [...this.tasks.values()];
    return filterState ? all.filter((t) => t.state === filterState) : all;
  }

  stop(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (task && task.state === "running") {
      task.state = "stopped";
      return true;
    }
    return false;
  }
}

// Test
async function testBackgroundManager() {
  const manager = new BackgroundTaskManager();

  const id = await manager.startShellTask(
    "sleep 2 && echo done",
    "Test shell task",
    async () => {
      await new Promise((r) => setTimeout(r, 2000));
      return { stdout: "done\n", exitCode: 0 };
    }
  );

  // Immediately: task is running
  const task = manager.poll(id);
  console.assert(task?.state === "running");

  // After completion: task is completed
  await new Promise((r) => setTimeout(r, 2500));
  const completed = manager.poll(id);
  console.assert(completed?.state === "completed");
  console.assert(completed?.output[0] === "done\n");

  console.log("Background task manager tests passed.");
}
```

**Explanation:** Tasks are started non-blocking via fire-and-forget promises. The manager tracks state transitions (running → completed/failed) and collects output. The `poll()` method gives the coordinator a snapshot of any task's current state without blocking.

---

## Exercise 2
**Challenge:** Implement token budget system and budgeted agent loop.

**Answer:**
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
  exhausted: boolean;
} {
  const input = Math.max(0, budget.maxInputTokens - budget.usedInputTokens);
  const output = Math.max(0, budget.maxOutputTokens - budget.usedOutputTokens);
  return { input, output, exhausted: input <= 0 || output <= 0 };
}

async function runBudgetedAgentLoop(
  task: string,
  budget: TaskBudget,
  callModel: (messages: any[], maxTokens: number) => Promise<{
    content: string;
    toolCalls: any[];
    stopReason: string;
    usage: { inputTokens: number; outputTokens: number };
  }>,
  executeTool: (name: string, params: any) => Promise<string>
): Promise<string> {
  const messages: any[] = [{ role: "user", content: task }];
  const completedSteps: string[] = [];

  while (true) {
    const remaining = taskBudgetRemaining(budget);

    if (remaining.exhausted) {
      return (
        `Task stopped: token budget exhausted.\n` +
        `Used: ${budget.usedInputTokens} input, ${budget.usedOutputTokens} output tokens.\n` +
        `Completed steps:\n${completedSteps.map((s) => `- ${s}`).join("\n")}`
      );
    }

    const maxOutputForCall = Math.min(4096, remaining.output);
    const response = await callModel(messages, maxOutputForCall);

    budget.usedInputTokens += response.usage.inputTokens;
    budget.usedOutputTokens += response.usage.outputTokens;

    for (const tc of response.toolCalls) {
      const result = await executeTool(tc.name, tc.params);
      messages.push({ role: "tool", content: result });
      completedSteps.push(`${tc.name}: ${result.slice(0, 50)}`);
    }

    if (response.stopReason === "end_turn" && response.toolCalls.length === 0) {
      return response.content;
    }
  }
}

// Test
async function testBudgetedLoop() {
  const budget: TaskBudget = {
    maxInputTokens: 50000,
    maxOutputTokens: 10000,
    usedInputTokens: 0,
    usedOutputTokens: 0,
  };

  let callCount = 0;
  const result = await runBudgetedAgentLoop(
    "Fix the bug",
    budget,
    async (_msgs, maxTokens) => {
      callCount++;
      return {
        content: callCount >= 6 ? "Bug fixed." : "Working...",
        toolCalls: callCount < 6 ? [{ name: "read_file", params: {} }] : [],
        stopReason: callCount >= 6 ? "end_turn" : "tool_use",
        usage: { inputTokens: 3000, outputTokens: 2000 },
      };
    },
    async () => "file contents"
  );

  // With 10K output budget and 2K per call, should stop at call 5
  if (callCount >= 6) {
    console.assert(result === "Bug fixed.");
  } else {
    console.assert(result.includes("budget exhausted"));
  }

  console.log(`Budgeted loop completed after ${callCount} calls.`);
}
```

**Explanation:** The budget check happens before every API call, preventing the agent from starting work it can't afford to finish. The `maxOutputForCall` is clamped to the remaining budget, and the loop returns a graceful summary when exhausted rather than crashing mid-operation.

---

## Exercise 3
**Challenge:** Implement `taskSummaryModule()`.

**Answer:**
```typescript
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function taskSummaryModule(
  taskOutput: string[],
  maxSummaryTokens: number = 500,
  summarize?: (text: string) => Promise<string>
): Promise<string> {
  const fullOutput = taskOutput.join("\n");
  const outputTokens = estimateTokens(fullOutput);

  if (outputTokens <= maxSummaryTokens) {
    return fullOutput;
  }

  if (summarize) {
    return await summarize(fullOutput);
  }

  // Fallback: extract key lines (first, last, and lines with important keywords)
  return extractiveSum(fullOutput, maxSummaryTokens);
}

function extractiveSum(text: string, maxTokens: number): string {
  const lines = text.split("\n");
  const important: string[] = [];

  // Always include first and last lines
  if (lines.length > 0) important.push(lines[0]);

  // Include lines with keywords
  const keywords = /\b(error|success|fail|complet|creat|modif|delet|total|result|summary)\b/i;
  for (const line of lines) {
    if (keywords.test(line) && !important.includes(line)) {
      important.push(line);
    }
    if (estimateTokens(important.join("\n")) >= maxTokens * 0.8) break;
  }

  if (lines.length > 0 && !important.includes(lines[lines.length - 1])) {
    important.push(lines[lines.length - 1]);
  }

  return important.join("\n");
}

// Test
async function testSummaryModule() {
  // Short output: returned as-is
  const short = await taskSummaryModule(["Fixed bug in line 42.", "Tests pass."]);
  console.assert(short === "Fixed bug in line 42.\nTests pass.");

  // Long output: summarized
  const longOutput = Array.from({ length: 100 }, (_, i) => `Step ${i}: processed file_${i}.ts`);
  longOutput.push("Total: 100 files processed. All tests passing.");

  const summary = await taskSummaryModule(longOutput, 100, async (text) => {
    return "Processed 100 files. All tests passing.";
  });
  console.assert(summary.length < 200);

  console.log("Summary module tests passed.");
}
```

**Explanation:** The module first checks if the output fits within the token budget — if so, no summarization is needed. For longer output, it delegates to a model-based summarizer. The extractive fallback selects lines containing important keywords as a cheap heuristic when no model is available.

---

## Exercise 4
**Challenge:** Implement `ProactiveTriggerSystem` with debouncing and approval.

**Answer:**
```typescript
interface ProactiveTrigger {
  event: "file_change" | "test_failure" | "lint_error";
  pattern?: string; // glob pattern for file events
  action: string;
  requireApproval: boolean;
}

interface QueuedAction {
  trigger: ProactiveTrigger;
  filePath?: string;
  timestamp: number;
  approved: boolean;
}

class ProactiveTriggerSystem {
  private triggers: ProactiveTrigger[] = [];
  private actionQueue: QueuedAction[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;

  constructor(debounceMs: number = 2000) {
    this.debounceMs = debounceMs;
  }

  register(trigger: ProactiveTrigger): void {
    this.triggers.push(trigger);
  }

  onEvent(
    event: ProactiveTrigger["event"],
    filePath?: string,
    onAction?: (action: QueuedAction) => void
  ): void {
    const matching = this.triggers.filter((t) => {
      if (t.event !== event) return false;
      if (t.pattern && filePath) {
        return this.matchGlob(filePath, t.pattern);
      }
      return true;
    });

    for (const trigger of matching) {
      const debounceKey = `${trigger.event}:${trigger.action}:${filePath ?? ""}`;

      // Clear existing debounce timer
      const existing = this.debounceTimers.get(debounceKey);
      if (existing) clearTimeout(existing);

      // Set new debounce timer
      const timer = setTimeout(() => {
        const action: QueuedAction = {
          trigger,
          filePath,
          timestamp: Date.now(),
          approved: !trigger.requireApproval,
        };

        if (trigger.requireApproval) {
          this.actionQueue.push(action);
        } else if (onAction) {
          onAction(action);
        }

        this.debounceTimers.delete(debounceKey);
      }, this.debounceMs);

      this.debounceTimers.set(debounceKey, timer);
    }
  }

  getPendingApprovals(): QueuedAction[] {
    return this.actionQueue.filter((a) => !a.approved);
  }

  approve(index: number): QueuedAction | null {
    const action = this.actionQueue[index];
    if (action) {
      action.approved = true;
      return action;
    }
    return null;
  }

  private matchGlob(filePath: string, pattern: string): boolean {
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
    );
    return regex.test(filePath);
  }
}

// Test
function testProactiveTriggers() {
  const system = new ProactiveTriggerSystem(100);

  system.register({
    event: "file_change",
    pattern: "src/*.ts",
    action: "run_tests",
    requireApproval: false,
  });

  system.register({
    event: "test_failure",
    action: "auto_fix",
    requireApproval: true,
  });

  const actions: QueuedAction[] = [];
  system.onEvent("file_change", "src/index.ts", (a) => actions.push(a));

  // Rapid events should be debounced
  system.onEvent("file_change", "src/index.ts", (a) => actions.push(a));
  system.onEvent("file_change", "src/index.ts", (a) => actions.push(a));

  setTimeout(() => {
    console.assert(actions.length === 1, "Debounce: only 1 action after 3 rapid events");

    system.onEvent("test_failure");
    console.assert(system.getPendingApprovals().length === 0, "Debounce not fired yet");

    setTimeout(() => {
      console.assert(system.getPendingApprovals().length === 1, "Test failure queued for approval");
      console.log("Proactive trigger tests passed.");
    }, 150);
  }, 150);
}
```

**Explanation:** Triggers are matched by event type and optional glob pattern. Debouncing prevents rapid-fire events (common with file watchers) from spawning multiple actions. The `requireApproval` flag queues actions for user confirmation rather than executing immediately — essential for destructive operations like auto-fixing code.

---

## Exercise 5
**Question:** Background processing risks and safeguards.

**Answer:** **(a)** A background agent with write access and no budget limit can enter a pathological loop: it encounters an error, attempts a fix that introduces a new error, attempts to fix that, and so on — each iteration consuming thousands of tokens and potentially corrupting more files. Without a budget, this loop runs until the API billing limit is hit, which could mean hundreds of dollars spent on an agent making a codebase progressively worse. **(b)** `taskBudgetRemaining` acts as a hard ceiling: the agent must check its budget before every API call, and when the budget is exhausted, the loop terminates with a summary of what it accomplished. This converts an unbounded risk into a predictable, controlled cost. **(c)** `PushNotificationTool` is critical for user trust because background agents are invisible by default — the user has no idea what's happening unless the agent actively reports. Notifications for important events (fixes applied, errors encountered, budget warnings) keep the user informed and in control. Without these safeguards, a background auto-fix agent could burn $50 in tokens, break 12 files, and the user would only discover it hours later when nothing compiles.
