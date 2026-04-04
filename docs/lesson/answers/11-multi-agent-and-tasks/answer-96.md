# Answers: Lesson 96 — Task Management

## Exercise 1
**Challenge:** Implement the `TodoWriteTool` execution handler with merge support.

**Answer:**
```typescript
interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

class TodoStore {
  private todos = new Map<string, TodoItem>();

  execute(params: { todos: TodoItem[]; merge: boolean }): string {
    this.validate(params.todos);

    if (!params.merge) {
      this.todos.clear();
      for (const todo of params.todos) {
        this.todos.set(todo.id, { ...todo });
      }
      return `Created ${params.todos.length} todos.`;
    }

    // Merge: update by ID, preserve unmentioned items
    let updated = 0;
    let created = 0;

    for (const todo of params.todos) {
      if (this.todos.has(todo.id)) {
        const existing = this.todos.get(todo.id)!;
        this.todos.set(todo.id, {
          id: todo.id,
          content: todo.content ?? existing.content,
          status: todo.status ?? existing.status,
        });
        updated++;
      } else {
        this.todos.set(todo.id, { ...todo });
        created++;
      }
    }

    return `Merged: ${updated} updated, ${created} created. Total: ${this.todos.size} todos.`;
  }

  getAll(): TodoItem[] {
    return [...this.todos.values()];
  }

  private validate(todos: TodoItem[]): void {
    for (const todo of todos) {
      if (!todo.id) throw new Error("Todo missing required field: id");
      if (!todo.content) throw new Error(`Todo ${todo.id} missing required field: content`);
      if (!todo.status) throw new Error(`Todo ${todo.id} missing required field: status`);
      const validStatuses = ["pending", "in_progress", "completed", "cancelled"];
      if (!validStatuses.includes(todo.status)) {
        throw new Error(`Todo ${todo.id} has invalid status: ${todo.status}`);
      }
    }
  }
}

// Test
function testTodoStore() {
  const store = new TodoStore();

  // Create initial list
  store.execute({
    merge: false,
    todos: [
      { id: "1", content: "Read schema", status: "in_progress" },
      { id: "2", content: "Write migration", status: "pending" },
      { id: "3", content: "Run tests", status: "pending" },
    ],
  });
  console.assert(store.getAll().length === 3);

  // Merge update: complete item 1, start item 2
  store.execute({
    merge: true,
    todos: [
      { id: "1", content: "Read schema", status: "completed" },
      { id: "2", content: "Write migration", status: "in_progress" },
    ],
  });
  console.assert(store.getAll().length === 3); // item 3 preserved
  console.assert(store.getAll().find((t) => t.id === "1")!.status === "completed");
  console.assert(store.getAll().find((t) => t.id === "3")!.status === "pending");

  console.log("TodoStore tests passed.");
}
```

**Explanation:** The `merge: false` mode replaces the entire list (useful at task start). The `merge: true` mode updates only the specified IDs and preserves everything else (useful for progress updates). Validation ensures the model always provides required fields.

---

## Exercise 2
**Challenge:** Implement `TaskStateMachine` with valid transition enforcement.

**Answer:**
```typescript
type TaskState = "pending" | "in_progress" | "completed" | "failed" | "stopped";

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  pending: ["in_progress", "stopped"],
  in_progress: ["completed", "failed", "stopped"],
  completed: [],
  failed: [],
  stopped: [],
};

class TaskStateMachine {
  private _state: TaskState = "pending";

  get state(): TaskState {
    return this._state;
  }

  transition(newState: TaskState): void {
    const valid = VALID_TRANSITIONS[this._state];

    if (!valid.includes(newState)) {
      throw new Error(
        `Invalid transition: ${this._state} → ${newState}. ` +
        `Valid transitions from "${this._state}": ${valid.length > 0 ? valid.join(", ") : "none (terminal state)"}`
      );
    }

    this._state = newState;
  }

  getValidTransitions(): TaskState[] {
    return [...VALID_TRANSITIONS[this._state]];
  }

  isTerminal(): boolean {
    return VALID_TRANSITIONS[this._state].length === 0;
  }
}

// Test
function testStateMachine() {
  const sm = new TaskStateMachine();
  console.assert(sm.state === "pending");
  console.assert(sm.getValidTransitions().includes("in_progress"));

  sm.transition("in_progress");
  console.assert(sm.state === "in_progress");

  sm.transition("completed");
  console.assert(sm.isTerminal());

  // Invalid transition should throw
  try {
    sm.transition("in_progress");
    console.assert(false, "Should have thrown");
  } catch (e) {
    console.assert((e as Error).message.includes("Invalid transition"));
  }

  console.log("State machine tests passed.");
}
```

**Explanation:** The transition map defines exactly which state changes are legal. Terminal states (completed, failed, stopped) have no outgoing transitions. The `getValidTransitions()` method lets the UI show which actions are available for a given task.

---

## Exercise 3
**Challenge:** Implement `createAndAssignTask()` with non-blocking agent execution.

**Answer:**
```typescript
interface Task {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  state: TaskState;
  agentId?: string;
  createdAt: number;
  updatedAt: number;
  output?: string;
}

const tasks = new Map<string, Task>();
let taskCounter = 0;

async function createAndAssignTask(
  params: { subject: string; description: string; activeForm?: string },
  spawnAgent: (task: string) => Promise<string>
): Promise<Task> {
  const task: Task = {
    id: `task_${++taskCounter}`,
    subject: params.subject,
    description: params.description,
    activeForm: params.activeForm,
    state: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  tasks.set(task.id, task);

  // Start agent non-blocking
  task.state = "in_progress";
  task.updatedAt = Date.now();
  task.agentId = `agent_${taskCounter}`;

  spawnAgent(params.description)
    .then((result) => {
      task.state = "completed";
      task.output = result;
      task.updatedAt = Date.now();
    })
    .catch((error) => {
      task.state = "failed";
      task.output = error.message;
      task.updatedAt = Date.now();
    });

  return task;
}

function pollTaskStatus(taskId: string): {
  state: TaskState;
  activeForm?: string;
  output?: string;
  durationMs: number;
} | null {
  const task = tasks.get(taskId);
  if (!task) return null;

  return {
    state: task.state,
    activeForm: task.activeForm,
    output: task.output,
    durationMs: Date.now() - task.createdAt,
  };
}

function listTasks(filterState?: TaskState): Task[] {
  const all = [...tasks.values()];
  return filterState ? all.filter((t) => t.state === filterState) : all;
}
```

**Explanation:** The task is created and immediately linked to an agent. The agent runs asynchronously via a fire-and-forget promise (`.then`/`.catch`), so the coordinator doesn't block. The `pollTaskStatus` function lets the coordinator check progress at any time without waiting.

---

## Exercise 4
**Question:** TodoWriteTool or full task system for reviewing 15 GitHub issues?

**Answer:** The full task system is the right choice. With 15 issues to review, the agent should spawn sub-agents — at minimum one per "easy" issue to fix — and those sub-agents need structured lifecycle tracking (pending → in_progress → completed/failed). TodoWriteTool is a flat checklist with no agent integration, so the coordinator would have no way to monitor which fixes are running, which succeeded, and which failed. The full task system gives the user a dashboard-like view ("5 of 8 fixes complete, 1 failed, 2 running") and lets the coordinator use `task_stop` to cancel stuck workers. Additionally, `task_output` lets the coordinator retrieve each fix's detailed result without it cluttering the main conversation.

---

## Exercise 5
**Challenge:** Implement a text-based `TaskDashboard`.

**Answer:**
```typescript
class TaskDashboard {
  constructor(private tasks: Task[]) {}

  render(): string {
    const lines: string[] = [];

    lines.push("╔══════════════════════════════════════════════╗");
    lines.push("║            Task Progress Dashboard           ║");
    lines.push("╠══════════════════════════════════════════════╣");

    const completed = this.tasks.filter((t) => t.state === "completed").length;
    const total = this.tasks.length;
    const barWidth = 20;
    const filled = Math.round((completed / total) * barWidth);
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

    lines.push(`║ Progress: [${bar}] ${completed}/${total}        ║`);
    lines.push("╠══════════════════════════════════════════════╣");

    for (const task of this.tasks) {
      const icon = this.getStateIcon(task.state);
      const duration = this.formatDuration(Date.now() - task.createdAt);
      const description = task.activeForm ?? task.subject;
      const truncated = description.length > 30
        ? description.slice(0, 27) + "..."
        : description.padEnd(30);

      lines.push(`║ ${icon} ${truncated} ${duration.padStart(8)} ║`);
    }

    lines.push("╚══════════════════════════════════════════════╝");
    return lines.join("\n");
  }

  private getStateIcon(state: TaskState): string {
    switch (state) {
      case "pending": return "○";
      case "in_progress": return "◉";
      case "completed": return "✓";
      case "failed": return "✗";
      case "stopped": return "■";
    }
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  }
}
```

**Explanation:** The dashboard renders a box-drawing-character UI with a progress bar, state icons, task descriptions (using `activeForm` for human-readable status), and elapsed time. This gives the user an at-a-glance view of multi-agent progress without requiring them to read through conversation messages.
