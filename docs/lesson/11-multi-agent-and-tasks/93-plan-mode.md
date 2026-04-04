# Lesson 93 — Plan Mode: Think Before You Act

The most expensive mistake an agent can make is charging ahead on a complex task
without understanding it first. A wrong architectural choice at step 2 can waste
hundreds of thousands of tokens by step 20. Plan mode gives the agent a way to
stop, think, and strategize — using a *better model* when it matters — before
committing to any changes.

## The Core Idea

Plan mode is not a separate system. It is a **tool the model can choose to
invoke**, just like reading a file or running a shell command. When the model
calls `EnterPlanModeTool`, the agent loop restricts the available toolset to
read-only operations. The model can explore the codebase, reason about
approaches, and talk through a strategy with the user — but it cannot write
files, run destructive commands, or make commits.

When it is ready to execute, the model calls `ExitPlanModeV2Tool` and regains
full capabilities.

```
Normal mode                Plan mode                 Normal mode
┌──────────┐   enter    ┌──────────────┐   exit   ┌──────────┐
│ All tools │──────────▶│ Read-only    │─────────▶│ All tools │
│ available │           │ tools only   │          │ available │
└──────────┘           │ Stronger     │          └──────────┘
                        │ model (opt.) │
                        └──────────────┘
```

## The Tool Definitions

The tools themselves are minimal. They carry no complex logic — their power
comes from how the agent loop responds to them.

```typescript
// EnterPlanModeTool — switches to planning state
const EnterPlanModeTool = {
  name: "enter_plan_mode",
  description:
    "Switch to plan mode. In plan mode, you can only use read-only tools " +
    "to explore the codebase and discuss strategy with the user. Use this " +
    "when facing complex tasks that benefit from upfront analysis.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Why you are entering plan mode",
      },
    },
    required: ["reason"],
  },
  isReadOnly: true,
};

// ExitPlanModeV2Tool — returns to full execution
const ExitPlanModeV2Tool = {
  name: "exit_plan_mode",
  description:
    "Exit plan mode and return to normal execution. Call this when you " +
    "have a clear plan and are ready to implement it.",
  parameters: {
    type: "object",
    properties: {
      plan_summary: {
        type: "string",
        description: "Brief summary of the plan you will execute",
      },
    },
    required: ["plan_summary"],
  },
  isReadOnly: true,
};
```

Notice both tools are marked `isReadOnly: true`. They are metadata signals, not
actions. The agent loop checks the current mode when assembling the tool list
for each turn:

```typescript
function getAvailableTools(allTools: Tool[], inPlanMode: boolean): Tool[] {
  if (inPlanMode) {
    return allTools.filter((tool) => tool.isReadOnly === true);
  }
  return allTools;
}
```

This is the enforcement mechanism. In plan mode, write tools simply do not
appear in the API request. The model cannot call what it cannot see.

## Model Routing: The "opusplan" Strategy

Here is where plan mode becomes genuinely powerful. The agent can use a
*stronger, more expensive model* during planning, then switch back to a
faster model for execution.

```typescript
type ModelAlias = "default" | "plan" | "fast";

interface ModelRouting {
  default: string;   // e.g. "claude-sonnet-4-20250514"
  plan: string;      // e.g. "claude-opus-4-20250514"
  fast: string;      // e.g. "claude-haiku-3-20250307"
}

function getRuntimeMainLoopModel(
  routing: ModelRouting,
  inPlanMode: boolean
): string {
  if (inPlanMode) {
    return routing.plan;
  }
  return routing.default;
}
```

The `"opusplan"` alias makes this concrete. When the user selects it:

- **Normal mode**: the agent uses Sonnet (fast, cheap, good enough for
  file edits and tool calls).
- **Plan mode**: the agent upgrades to Opus (slower, more expensive, but
  significantly better at complex reasoning and architecture).

```typescript
const MODEL_ALIASES: Record<string, ModelRouting> = {
  sonnet: {
    default: "claude-sonnet-4-20250514",
    plan: "claude-sonnet-4-20250514",
    fast: "claude-haiku-3-20250307",
  },
  opusplan: {
    default: "claude-sonnet-4-20250514",
    plan: "claude-opus-4-20250514",       // stronger model for planning
    fast: "claude-haiku-3-20250307",
  },
  opus: {
    default: "claude-opus-4-20250514",
    plan: "claude-opus-4-20250514",
    fast: "claude-haiku-3-20250307",
  },
};
```

This is an elegant cost/quality tradeoff. Opus-level reasoning for the 5% of
tokens spent planning. Sonnet-level speed for the 95% spent executing.

## Why Planning Helps

Consider a user request: *"Refactor the database layer to use connection
pooling."* Without planning, the agent might:

1. Open the first database file it finds
2. Start rewriting it
3. Discover halfway through that three other modules depend on the old interface
4. Attempt a fix that breaks the test suite
5. Spend 200K tokens recovering

With planning, the agent:

1. Enters plan mode
2. Reads the database module, the config system, and the test suite
3. Maps out which files need changes and in what order
4. Identifies the public interface it must preserve
5. Presents the plan to the user for approval
6. Exits plan mode and executes cleanly

The planning phase might cost 10K tokens. It saves 150K+ in wasted execution.

## The Model Chooses When to Plan

Plan mode is never forced. The system prompt *suggests* planning for complex
tasks, but the model decides:

```markdown
## Planning

For complex tasks, consider entering plan mode first to:
- Explore the relevant code before making changes
- Identify dependencies and potential issues
- Discuss your approach with the user
- Get approval before executing a large refactor

Use your judgment. Simple tasks (rename a variable, fix a typo) do not
need a plan. Complex tasks (new feature, architectural change, multi-file
refactor) usually benefit from one.
```

This is important. A rigid "always plan first" rule would slow down simple tasks.
A "never plan" rule would produce poor results on complex ones. Letting the
model decide — with guidance — gives the best of both worlds.

## The Mode State in the Agent Loop

The plan mode flag lives in the conversation state, not in the model's context
window. The agent loop tracks it:

```typescript
interface ConversationState {
  messages: Message[];
  inPlanMode: boolean;
  // ...
}

async function agentLoop(state: ConversationState): Promise<void> {
  while (true) {
    const model = getRuntimeMainLoopModel(routing, state.inPlanMode);
    const tools = getAvailableTools(allTools, state.inPlanMode);

    const response = await callModel(model, state.messages, tools);

    for (const toolCall of response.toolCalls) {
      if (toolCall.name === "enter_plan_mode") {
        state.inPlanMode = true;
        // Add confirmation message to conversation
        state.messages.push({
          role: "tool",
          content: "Entered plan mode. Only read-only tools available.",
        });
      } else if (toolCall.name === "exit_plan_mode") {
        state.inPlanMode = false;
        state.messages.push({
          role: "tool",
          content: "Exited plan mode. All tools available.",
        });
      } else {
        const result = await executeTool(toolCall);
        state.messages.push({ role: "tool", content: result });
      }
    }

    if (response.stopReason === "end_turn") break;
  }
}
```

The key insight: the loop **re-evaluates** the model and tool list on every
iteration. The moment the model enters plan mode, the next API call uses the
planning model and the read-only tool set. The moment it exits, the next call
reverts.

## Practical Patterns

**Pattern 1: Explore → Plan → Execute**
```
User: "Add WebSocket support to the API server"
Agent: [enters plan mode]
Agent: [reads server code, config, existing routes]
Agent: "Here's my plan: 1) Add ws dependency, 2) Create WebSocket handler
        module, 3) Mount on /ws path, 4) Add authentication middleware.
        The existing HTTP middleware can be reused. Shall I proceed?"
User: "Yes, go ahead."
Agent: [exits plan mode]
Agent: [implements the plan]
```

**Pattern 2: Mid-task Replan**
```
Agent: [working on feature, discovers unexpected complexity]
Agent: [enters plan mode]
Agent: "I found that the auth module uses a pattern I didn't expect.
        Let me revise my approach..."
Agent: [reads more code, adjusts strategy]
Agent: [exits plan mode, continues with revised plan]
```

**Pattern 3: User-requested Planning**
```
User: "Before you do anything, let me see your plan."
Agent: [enters plan mode]
Agent: [thorough analysis, presents options]
User: "Option B looks better. Go with that."
Agent: [exits plan mode, executes option B]
```

## What You Have Learned

- Plan mode is a tool the model invokes, not a forced workflow stage
- It restricts the agent to read-only tools, preventing premature changes
- Model routing lets the agent use a stronger model for planning
  (`opusplan` = Sonnet for execution, Opus for planning)
- The agent loop re-evaluates model and tool selection every iteration
- Planning saves tokens on complex tasks by avoiding wrong-path execution
- Users can also toggle plan mode externally as a safety mechanism

---

*Next lesson: the coordinator pattern — one agent directing many workers.*

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Tool Filtering by Mode
**Challenge:** Implement `getAvailableTools()` that filters the full tool list based on plan mode state. Each tool has an `isReadOnly` boolean property. In plan mode, only read-only tools are returned. Also add the `enter_plan_mode` and `exit_plan_mode` tools dynamically: `enter_plan_mode` should appear in normal mode, `exit_plan_mode` should appear in plan mode. Test with a tool list of 10 tools (6 read-only, 4 write).

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-93.md#exercise-1)

### Exercise 2 — Model Routing
**Challenge:** Implement `getRuntimeMainLoopModel()` and the `MODEL_ALIASES` configuration. Given a model alias string (like `"opusplan"`) and a boolean `inPlanMode`, return the correct model string. Support three aliases: `sonnet`, `opusplan`, and `opus`. Write tests that verify the `opusplan` alias uses Sonnet in normal mode and Opus in plan mode.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-93.md#exercise-2)

### Exercise 3 — Plan Mode Agent Loop
**Challenge:** Implement an agent loop that handles `enter_plan_mode` and `exit_plan_mode` tool calls. The loop must: track plan mode state, re-evaluate the model and tool list on each iteration, and add confirmation messages to the conversation when mode changes. Test the flow: normal → enter plan → read files → exit plan → write files.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-93.md#exercise-3)

### Exercise 4 — When to Plan
**Question:** For each of these user requests, state whether the agent should enter plan mode and explain why in 1-2 sentences: (a) "Fix the typo in README.md line 3", (b) "Refactor the database layer to use connection pooling", (c) "Add a new /users API endpoint with CRUD operations", (d) "What does the config.ts file do?", (e) "Migrate the frontend from JavaScript to TypeScript".

[View Answer](../../answers/11-multi-agent-and-tasks/answer-93.md#exercise-4)

### Exercise 5 — Cost Analysis
**Challenge:** Write a `PlanModeCostAnalyzer` that estimates the token cost of using `opusplan` vs `opus` for a session. Given a sequence of operations (each with a token count and whether it's planning or execution), calculate: total cost with each strategy, and the savings from using `opusplan`. Assume Opus costs 3x Sonnet per token.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-93.md#exercise-5)
