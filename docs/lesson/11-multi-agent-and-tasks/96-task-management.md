# Lesson 96 — Task Management: Tracking Work Across Agents

Sub-agents run and return results. But who tracks which tasks are pending, which
are running, which failed? The task management system provides a structured layer
on top of raw agent execution — giving both the model and the user visibility
into what is happening.

## Two Levels of Task Tracking

Claude Code offers two levels of task management:

1. **TodoWriteTool** — lightweight, flat task lists for simple tracking
2. **Full task system** — structured tasks with states, outputs, and lifecycle
   management (TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool,
   TaskOutputTool, TaskStopTool)

Most interactions use TodoWriteTool. The full task system activates for
multi-agent workflows where tasks map to actual running sub-agents.

## TodoWriteTool: The Simple Path

The `TodoWriteTool` manages a flat list of work items. It is the agent's
equivalent of a scratch-pad checklist:

```typescript
const TodoWriteTool = {
  name: "todo_write",
  description:
    "Create or update a task list to track progress on complex work. " +
    "Use this for multi-step tasks where tracking helps ensure " +
    "completeness.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique ID for the todo" },
            content: { type: "string", description: "Description of the task" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
            },
          },
          required: ["id", "content", "status"],
        },
      },
      merge: {
        type: "boolean",
        description:
          "If true, merge with existing todos by ID. If false, replace all.",
      },
    },
    required: ["todos", "merge"],
  },
};
```

Usage is straightforward. The model creates a list at the start of complex work,
then updates items as it progresses:

```typescript
// Step 1: Model creates initial todo list
{
  name: "todo_write",
  params: {
    merge: false,
    todos: [
      { id: "1", content: "Read existing database schema", status: "in_progress" },
      { id: "2", content: "Design new migration", status: "pending" },
      { id: "3", content: "Write migration script", status: "pending" },
      { id: "4", content: "Update model definitions", status: "pending" },
      { id: "5", content: "Run and verify migration", status: "pending" },
    ],
  },
}

// Step 2: After completing item 1
{
  name: "todo_write",
  params: {
    merge: true,
    todos: [
      { id: "1", content: "Read existing database schema", status: "completed" },
      { id: "2", content: "Design new migration", status: "in_progress" },
    ],
  },
}
```

The `merge: true` flag is key. It updates specific items by ID without
replacing the entire list. The model only sends the items that changed.

## The Full Task System

For multi-agent workflows, the full task system provides richer semantics:

### TaskCreateTool

Creates a structured task that can be associated with a running agent:

```typescript
const TaskCreateTool = {
  name: "task_create",
  description:
    "Create a new task. Tasks represent units of work that can be " +
    "assigned to agents, tracked, and monitored.",
  parameters: {
    type: "object",
    properties: {
      subject: {
        type: "string",
        description: "Short title for the task",
      },
      description: {
        type: "string",
        description: "Detailed description of what the task involves",
      },
      activeForm: {
        type: "string",
        description:
          "Present-tense verb phrase describing the work " +
          "(e.g., 'migrating user service to Fastify')",
      },
    },
    required: ["subject", "description"],
  },
};
```

The `activeForm` field is a UX detail that matters. It provides a
human-readable status string: instead of "Task 3: in_progress," the user sees
"Task 3: migrating user service to Fastify."

The prompt in `TaskCreateTool/prompt.ts` instructs the model:

```markdown
When creating tasks, follow these guidelines:

- **subject**: A concise title (3-8 words). Example: "Migrate user-service routes"
- **description**: Include all context the assigned agent needs. The agent
  cannot see your conversation, so be specific about:
  - What files/directories to work in
  - What the expected outcome is
  - Any constraints or requirements
  - Related context from the conversation
- **activeForm**: Use present participle. Examples:
  - "migrating Express routes to Fastify"
  - "adding WebSocket support to API server"
  - "fixing authentication middleware bug"

Tasks start in `pending` state. Use TaskUpdateTool to change state as work
progresses.
```

### Task States

Tasks follow a simple state machine:

```
                 ┌──────────┐
     create ───▶│  pending  │
                 └────┬─────┘
                      │ start
                 ┌────▼──────┐
                 │in_progress │──────────┐
                 └────┬───────┘          │
                      │                  │ error
              ┌───────┴────────┐    ┌────▼───┐
              │                │    │ failed  │
         ┌────▼─────┐    ┌────▼──┐ └─────────┘
         │completed  │    │stopped│
         └──────────┘    └───────┘
```

```typescript
type TaskState = "pending" | "in_progress" | "completed" | "failed" | "stopped";

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
```

### CRUD Operations

The remaining tools follow a predictable pattern — each takes a `taskId` and
performs a single operation:

| Tool             | Purpose                                  | Key params                 |
| ---------------- | ---------------------------------------- | -------------------------- |
| `task_get`       | Retrieve a task by ID                    | `taskId`                   |
| `task_update`    | Change state or attach output            | `taskId`, `state`, `output`|
| `task_list`      | List tasks, optionally filtered by state | `state` (optional)         |
| `task_output`    | Get the full output of a completed task  | `taskId`                   |
| `task_stop`      | Stop a running task and its agent        | `taskId`, `reason`         |

## Tasks + Agents: The Connection

The task system bridges the gap between abstract work items and running agents.
When a coordinator creates a task and assigns it to an agent:

```typescript
async function createAndAssignTask(
  taskParams: TaskCreateParams,
  agentParams: AgentCreateParams
): Promise<{ task: Task; agent: SubAgent }> {
  // Create the task record
  const task: Task = {
    id: generateTaskId(),
    subject: taskParams.subject,
    description: taskParams.description,
    activeForm: taskParams.activeForm,
    state: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // Create and start the agent
  const agent = await createSubAgent({
    task: taskParams.description,
    ...agentParams,
  });

  // Link them
  task.agentId = agent.id;
  task.state = "in_progress";
  task.updatedAt = Date.now();

  // Run the agent (non-blocking)
  runSubAgent(agent).then((result) => {
    task.state = "completed";
    task.output = result;
    task.updatedAt = Date.now();
  }).catch((error) => {
    task.state = "failed";
    task.output = error.message;
    task.updatedAt = Date.now();
  });

  return { task, agent };
}
```

Now the coordinator can poll with `task_list` to check progress and call
`task_output` to retrieve results — instead of blocking until each agent
completes.

## Why Tasks Matter

Task tracking helps the **model** and the **user** simultaneously:

For the model: tasks act as a memory aid (the list persists even when earlier
messages get truncated), a progress signal (preventing re-done work), and a
failure recovery mechanism (a `failed` state is visible and actionable rather
than silently lost).

For the user: tasks provide visibility into what the agent is doing, progress
estimation ("3 of 5 complete"), control (stop specific tasks), and an audit
trail of what happened and why.

## Choosing Between TodoWrite and Full Tasks

| Consideration       | TodoWriteTool          | Full task system         |
| ------------------- | ---------------------- | ------------------------ |
| Complexity          | Flat checklist         | Structured with states   |
| Agent integration   | None                   | Linked to sub-agents     |
| Best for            | Single-agent planning  | Multi-agent coordination |
| Overhead            | Minimal                | Moderate                 |
| User visibility     | List in conversation   | Dashboard-like tracking  |

The model should use TodoWriteTool for most work. The full task system is for
multi-agent scenarios where tasks represent actual running processes.

## What You Have Learned

- TodoWriteTool provides simple checklist-style task tracking
- The full task system (Create/Get/Update/List/Output/Stop) manages
  structured tasks with states and lifecycle
- Tasks link to sub-agents, bridging abstract work items and running processes
- Task states follow a clear machine: pending → in_progress → completed/failed
- The `activeForm` field provides human-readable status descriptions
- Tasks help both the model (memory, progress tracking) and the user
  (visibility, control, auditability)
- TodoWriteTool suits single-agent work; full tasks suit multi-agent workflows

---

*Next lesson: the skill system — reusable patterns that extend agent capabilities.*

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — TodoWriteTool Implementation
**Challenge:** Implement the `TodoWriteTool` execution handler. It must support: creating a new list (`merge: false`), merging updates into an existing list (`merge: true` — update by ID, preserve unmentioned items), and validating that all required fields (`id`, `content`, `status`) are present. Store todos in a simple in-memory map.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-96.md#exercise-1)

### Exercise 2 — Task State Machine
**Challenge:** Implement a `TaskStateMachine` class that enforces valid task state transitions. The valid transitions are: pending → in_progress, in_progress → completed, in_progress → failed, in_progress → stopped, and pending → stopped. Reject invalid transitions (e.g., completed → in_progress) with a descriptive error. Include a `getValidTransitions()` method.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-96.md#exercise-2)

### Exercise 3 — Task-Agent Bridge
**Challenge:** Implement `createAndAssignTask()` that creates a task record, spawns a sub-agent, links them, and monitors the agent's lifecycle (updating task state when the agent completes or fails). Use non-blocking execution so the coordinator can continue while the task runs. Include a `pollTaskStatus()` function.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-96.md#exercise-3)

### Exercise 4 — TodoWrite vs Full Tasks
**Question:** A user asks the agent to "review all 15 open GitHub issues and fix the easy ones." Should the agent use TodoWriteTool or the full task system? Explain your reasoning in 3-4 sentences, considering: the number of sub-tasks, whether sub-agents would help, and what level of tracking the user needs.

[View Answer](../../answers/11-multi-agent-and-tasks/answer-96.md#exercise-4)

### Exercise 5 — Task Dashboard
**Challenge:** Implement a `TaskDashboard` class that renders a text-based progress view of all tasks. It should show: task subject, activeForm (present-tense description), state with visual indicators, duration, and a progress bar (e.g., "3/5 complete"). Include a `render()` method that returns a formatted string suitable for terminal display.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-96.md#exercise-5)
