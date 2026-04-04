# Answers: Lesson 94 — The Coordinator Pattern

## Exercise 1
**Challenge:** Implement `executeAgentTool()` for spawning workers.

**Answer:**
```typescript
interface AgentToolParams {
  task: string;
  workingDirectory?: string;
  allowedTools?: string[];
}

interface Tool {
  name: string;
  execute: (input: unknown) => Promise<string>;
}

async function executeAgentTool(
  params: AgentToolParams,
  allTools: Tool[],
  runAgentLoop: (config: AgentLoopConfig) => Promise<{ finalResponse: string }>
): Promise<string> {
  const cwd = params.workingDirectory ?? process.cwd();

  const workerSystemPrompt = buildWorkerSystemPrompt(cwd);

  const workerTools = params.allowedTools
    ? allTools.filter((t) => params.allowedTools!.includes(t.name))
    : allTools;

  const workerMessages = [
    { role: "user" as const, content: params.task },
  ];

  const result = await runAgentLoop({
    systemPrompt: workerSystemPrompt,
    messages: workerMessages,
    tools: workerTools,
    cwd,
  });

  return result.finalResponse;
}

function buildWorkerSystemPrompt(cwd: string): string {
  return `You are a worker agent executing a specific task.

## Environment
- Working directory: ${cwd}
- Operating system: ${process.platform}
- Node.js: ${process.version}

## Rules
- Focus on completing your assigned task efficiently
- Do not ask the user questions — they cannot see your messages
- Make reasonable assumptions when facing ambiguity
- Document your assumptions in your final response
- Report what you did, what succeeded, and what failed`;
}

interface AgentLoopConfig {
  systemPrompt: string;
  messages: { role: string; content: string }[];
  tools: Tool[];
  cwd: string;
}
```

**Explanation:** The worker gets a fresh system prompt with environment details, a clean message history with only the task, and optionally restricted tools. The worker runs a complete agent loop and returns a single string — the coordinator never sees the worker's internal tool calls or reasoning.

---

## Exercise 2
**Challenge:** Write a coordinator system prompt and a trivial-work detector.

**Answer:**
```typescript
function getCoordinatorSystemPrompt(): string {
  return `You are a coordinator agent. Your job is to break down complex tasks and delegate them to worker agents.

## Your Role
- Analyze the user's request and identify parallelizable subtasks
- Spawn worker agents for each subtask using the agent tool
- Monitor workers and synthesize their results
- Report back to the user with a unified answer

## Rules

1. **Don't delegate trivial work.** If a task takes fewer than 3 tool calls to complete, do it yourself. Spawning a worker has overhead (system prompt, API latency, minimum token spend).

2. **Don't use one worker to check another.** Workers are peers, not reviewers. If you need verification, do it yourself or ask the user.

3. **Launch then inform.** Spawn workers first, then tell the user what you launched. Don't ask permission for each worker.

4. **Keep workers focused.** Each worker should have a single, clear objective. Don't give a worker multiple unrelated tasks.

5. **Synthesize, don't relay.** Combine worker results into a coherent answer. Don't dump raw output.

6. **Handle failures gracefully.** If a worker fails, decide whether to retry, work around it, or report the failure.`;
}

interface TaskComplexityEstimate {
  estimatedToolCalls: number;
  shouldDelegate: boolean;
  reason: string;
}

function estimateTaskComplexity(taskDescription: string): TaskComplexityEstimate {
  const indicators = {
    multiFile: /\b(across|multiple|all|every|each)\b.*\b(files?|modules?|services?|components?)\b/i,
    singleFile: /\b(in|fix|update|change)\b.*\b(the|this|one)\b.*\b(file|line|function|variable)\b/i,
    exploration: /\b(find|search|investigate|analyze|understand|explore)\b/i,
    simpleEdit: /\b(rename|typo|comment|import|delete line)\b/i,
    complexFeature: /\b(implement|add|create|build|migrate|refactor)\b.*\b(feature|system|module|service|api)\b/i,
  };

  if (indicators.simpleEdit.test(taskDescription)) {
    return { estimatedToolCalls: 2, shouldDelegate: false, reason: "Simple edit — fewer than 3 tool calls" };
  }

  if (indicators.singleFile.test(taskDescription) && !indicators.complexFeature.test(taskDescription)) {
    return { estimatedToolCalls: 3, shouldDelegate: false, reason: "Single-file change — borderline, do it yourself" };
  }

  if (indicators.multiFile.test(taskDescription) || indicators.complexFeature.test(taskDescription)) {
    return { estimatedToolCalls: 10, shouldDelegate: true, reason: "Multi-file or complex feature — good for delegation" };
  }

  return { estimatedToolCalls: 5, shouldDelegate: true, reason: "Moderate complexity — delegation appropriate" };
}
```

**Explanation:** The complexity estimator uses keyword heuristics to classify tasks. Simple edits and single-file changes stay with the coordinator. Multi-file operations and complex features get delegated. The 3-tool-call threshold matches the coordinator's Rule 1.

---

## Exercise 3
**Challenge:** Implement `synthesizeWorkerResults()`.

**Answer:**
```typescript
interface WorkerResult {
  workerName: string;
  task: string;
  result: string;
  success: boolean;
}

function synthesizeWorkerResults(results: WorkerResult[]): string {
  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);

  if (failures.length === results.length) {
    return buildAllFailedSummary(failures);
  }

  if (failures.length === 0) {
    return buildAllSuccessSummary(successes);
  }

  return buildPartialSuccessSummary(successes, failures);
}

function buildAllSuccessSummary(successes: WorkerResult[]): string {
  const lines = ["All tasks completed successfully:\n"];

  for (const r of successes) {
    const summary = extractKeyPoints(r.result);
    lines.push(`- **${r.task}**: ${summary}`);
  }

  const stats = extractStats(successes);
  if (stats) lines.push(`\n${stats}`);

  return lines.join("\n");
}

function buildPartialSuccessSummary(
  successes: WorkerResult[],
  failures: WorkerResult[]
): string {
  const lines = [
    `${successes.length} of ${successes.length + failures.length} tasks completed:\n`,
  ];

  lines.push("**Completed:**");
  for (const r of successes) {
    lines.push(`- ${r.task}: ${extractKeyPoints(r.result)}`);
  }

  lines.push("\n**Failed:**");
  for (const r of failures) {
    lines.push(`- ${r.task}: ${extractFailureReason(r.result)}`);
  }

  return lines.join("\n");
}

function buildAllFailedSummary(failures: WorkerResult[]): string {
  const lines = ["All tasks failed:\n"];
  for (const r of failures) {
    lines.push(`- ${r.task}: ${extractFailureReason(r.result)}`);
  }
  lines.push("\nConsider retrying with adjusted parameters or a different approach.");
  return lines.join("\n");
}

function extractKeyPoints(result: string): string {
  const sentences = result.split(/\.\s+/);
  return sentences.slice(0, 2).join(". ") + ".";
}

function extractFailureReason(result: string): string {
  const errorMatch = result.match(/(?:error|fail|unable|cannot)[:\s](.+?)(?:\.|$)/i);
  return errorMatch ? errorMatch[1].trim() : result.slice(0, 100);
}

function extractStats(results: WorkerResult[]): string | null {
  const allResults = results.map((r) => r.result).join(" ");
  const fileMatches = allResults.match(/\d+\s+(?:files?|routes?|tests?)/gi);
  return fileMatches ? `Summary: ${fileMatches.join(", ")}` : null;
}
```

**Explanation:** The synthesizer handles three scenarios (all success, partial, all failure) with different formatting. It extracts key points from verbose worker output rather than dumping everything. Statistics like file/route/test counts are pulled out for a quick overview.

---

## Exercise 4
**Question:** Why is Rule 2 ("don't use one worker to check another") critical?

**Answer:** When Worker A checks Worker B's output, it might find issues and make corrections. If Worker B then reviews those corrections, it may disagree and revert them or make different changes. This creates an infinite review loop where agents go back and forth, each consuming a full agent loop's worth of tokens (system prompt, API calls, tool executions) on every round. Since neither agent has authority over the other, there's no convergence mechanism — they can ping-pong indefinitely. A 3-round loop between two agents could easily burn 50K+ tokens on what amounts to two agents arguing about style preferences. The coordinator should be the single point of judgment: it reviews worker output itself and makes the final decision.

---

## Exercise 5
**Challenge:** Implement `CoordinatorOrchestrator` with parallel workers, retry, and timeout.

**Answer:**
```typescript
interface WorkerTask {
  id: string;
  task: string;
  workingDirectory?: string;
}

interface OrchestrationResult {
  completed: WorkerResult[];
  failed: WorkerResult[];
  timedOut: string[];
  totalDurationMs: number;
}

class CoordinatorOrchestrator {
  constructor(
    private executeWorker: (task: WorkerTask) => Promise<string>,
    private timeoutMs: number = 120_000,
    private maxRetries: number = 1
  ) {}

  async orchestrate(tasks: WorkerTask[]): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const completed: WorkerResult[] = [];
    const failed: WorkerResult[] = [];
    const timedOut: string[] = [];

    const workerPromises = tasks.map((task) =>
      this.runWorkerWithRetry(task)
    );

    const results = await Promise.race([
      Promise.allSettled(workerPromises),
      this.createTimeout(tasks.length),
    ]);

    for (let i = 0; i < tasks.length; i++) {
      const result = results[i];
      if (!result) {
        timedOut.push(tasks[i].id);
        continue;
      }

      if (result.status === "fulfilled") {
        completed.push({
          workerName: tasks[i].id,
          task: tasks[i].task,
          result: result.value,
          success: true,
        });
      } else {
        failed.push({
          workerName: tasks[i].id,
          task: tasks[i].task,
          result: result.reason?.message ?? "Unknown error",
          success: false,
        });
      }
    }

    return {
      completed,
      failed,
      timedOut,
      totalDurationMs: Date.now() - startTime,
    };
  }

  private async runWorkerWithRetry(task: WorkerTask): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.executeWorker(task);
      } catch (error) {
        lastError = error as Error;
        if (attempt < this.maxRetries) {
          console.log(`Worker ${task.id} failed, retrying...`);
        }
      }
    }

    throw lastError!;
  }

  private createTimeout(
    taskCount: number
  ): Promise<PromiseSettledResult<string>[]> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(new Array(taskCount).fill(undefined));
      }, this.timeoutMs);
    });
  }
}
```

**Explanation:** Workers run in parallel via `Promise.allSettled`, which captures both successes and failures without short-circuiting. `Promise.race` against a timeout ensures the coordinator doesn't wait forever. Failed workers get one retry before being recorded as failures. The result cleanly separates completed, failed, and timed-out tasks.
