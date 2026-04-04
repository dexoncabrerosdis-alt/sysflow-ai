# Lesson 57: Token Budgets and Limits

## The Problem: How Much Room Is Left?

Before every API call, the agent must answer a critical question: *how many tokens can I send?* Get it wrong in either direction and bad things happen — waste capacity by sending too little, or get a 413 rejection by sending too much.

Claude Code tracks multiple budget dimensions and checks them before every model invocation. This lesson covers each one.

## Effective Context Window Size

The first calculation is straightforward: how large is the model's context window, minus the space reserved for the model's response?

```typescript
function getEffectiveContextWindowSize(model: ModelId): number {
  const contextWindow = getContextWindowSize(model);
  const maxOutputTokens = getMaxOutputTokens(model);
  return contextWindow - maxOutputTokens;
}
```

For a model with a 200K context window and 16K max output tokens, the effective window is 184K tokens. That's how much room the agent has for the system prompt, conversation history, tool definitions, and tool results combined.

This is not the model's hard limit — it's the *input* budget. The model needs the remaining tokens to generate its response. If you fill the window to 199K and leave only 1K for output, the model will produce truncated, low-quality responses.

```
┌──────────────────────────────────────────────────┐
│           Total Context Window (200K)             │
│                                                   │
│  ┌─────────────────────────────────┬────────────┐ │
│  │   Effective Input Window (184K) │ Output(16K)│ │
│  │   (your budget for messages)    │ (reserved) │ │
│  └─────────────────────────────────┴────────────┘ │
└──────────────────────────────────────────────────┘
```

## The Safety Buffer: AUTOCOMPACT_BUFFER_TOKENS

The effective window isn't the real budget either. Claude Code reserves an additional safety margin:

```typescript
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
```

Why 13K tokens? Token counting is imprecise. The agent estimates token counts using a fast tokenizer, but the estimate can be off by a few percent. The API's own token counting may differ slightly. System-injected content (like tool definitions) may vary. The 13K buffer absorbs these estimation errors.

The actual usable budget is:

```
Usable = ContextWindow - MaxOutput - AUTOCOMPACT_BUFFER_TOKENS
       = 200,000 - 16,000 - 13,000
       = 171,000 tokens
```

This is the threshold where the agent starts taking action to free space.

## Token Warning States

Claude Code doesn't just have a single "full" threshold. It uses a graduated warning system:

```typescript
function calculateTokenWarningState(
  tokenCount: number,
  model: ModelId
): TokenWarningState {
  const effectiveWindow = getEffectiveContextWindowSize(model);
  const warningThreshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;
  const blockingThreshold = effectiveWindow;

  if (tokenCount >= blockingThreshold) {
    return {
      level: "blocking",
      isAtBlockingLimit: true,
      tokenCount,
      effectiveWindow,
    };
  }

  if (tokenCount >= warningThreshold) {
    return {
      level: "warning",
      isAtBlockingLimit: false,
      tokenCount,
      effectiveWindow,
    };
  }

  return {
    level: "ok",
    isAtBlockingLimit: false,
    tokenCount,
    effectiveWindow,
  };
}
```

Three states:

| State | Condition | Action |
|-------|-----------|--------|
| `ok` | tokens < warningThreshold | Proceed normally |
| `warning` | tokens >= warningThreshold | Trigger autocompact |
| `blocking` | tokens >= effectiveWindow | Do NOT call the API |

The warning state triggers proactive compaction — the agent summarizes the conversation before it's too late. The blocking state is a hard stop — calling the API would almost certainly fail, so the agent doesn't even try.

```
0 tokens                                        200K tokens
│                                                    │
│  ← ok →  │← warning →│← blocking →│  ← output →  │
│           │           │            │               │
0         171K        184K         200K
           ↑            ↑
     autocompact    don't call API
      triggers
```

## Checking Before Every API Call

The token check happens before every model invocation. Here's the simplified flow:

```typescript
async function* queryModel(messages: Message[], model: ModelId) {
  // 1. Count tokens in the current conversation
  const tokenCount = estimateTokenCount(messages);

  // 2. Check warning state
  const warningState = calculateTokenWarningState(tokenCount, model);

  // 3. If at blocking limit, don't even try
  if (warningState.isAtBlockingLimit) {
    // Try to compact first
    const compacted = await tryCompact(messages);
    if (!compacted) {
      throw new Error("prompt_too_long: unable to reduce context size");
    }
    // Recount after compaction
    // ... continue with reduced messages
  }

  // 4. If at warning level, trigger autocompact
  if (warningState.level === "warning") {
    yield* autoCompactIfNeeded(messages, model);
  }

  // 5. Proceed with the API call
  const response = await callAPI(messages);
  // ...
}
```

This is the gatekeeper. Every turn through the agent loop passes through this check. The agent never blindly sends a request hoping it fits.

## Per-Task Token Budget

Beyond the per-request context window, Claude Code also tracks a per-task cumulative budget:

```typescript
interface TaskBudget {
  maxTokens: number;        // total tokens allowed for this task
  tokensUsed: number;       // tokens consumed so far
  taskBudgetRemaining: number;  // maxTokens - tokensUsed
}
```

The task budget limits the total tokens consumed across all API calls in a single task — not just one request. This prevents runaway loops where the agent keeps making API calls that individually fit the context window but collectively consume enormous resources.

```typescript
function checkTaskBudget(budget: TaskBudget): boolean {
  if (budget.taskBudgetRemaining <= 0) {
    // Task has exhausted its token budget
    // Agent must stop or ask for more budget
    return false;
  }
  return true;
}
```

When the task budget runs out, the agent stops and reports to the user. This is a safety mechanism — without it, a confused agent could loop indefinitely, racking up costs.

```
Task: "Refactor auth module"
Budget: 1,000,000 tokens total

Turn 1:  input 5K + output 2K  = 7K    (remaining: 993K)
Turn 2:  input 15K + output 3K = 18K   (remaining: 975K)
...
Turn 50: input 80K + output 4K = 84K   (remaining: 12K)
Turn 51: input 85K → BUDGET EXCEEDED   (remaining: 0)
  → Agent stops: "I've used the allocated token budget."
```

## Token Counting: Estimation vs. Reality

Token counting is an estimation problem. The actual token count is determined by the API server, but the agent needs to know *before* sending the request. Claude Code uses a client-side tokenizer to estimate:

```typescript
function estimateTokenCount(messages: Message[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text") {
        total += countTextTokens(block.text);
      } else if (block.type === "tool_result") {
        total += countTextTokens(block.content);
      } else if (block.type === "tool_use") {
        total += countTextTokens(JSON.stringify(block.input));
      } else if (block.type === "image") {
        total += estimateImageTokens(block);
      }
    }
  }
  // Add overhead for message structure, roles, etc.
  total += messages.length * MESSAGE_OVERHEAD_TOKENS;
  return total;
}
```

The estimate is deliberately conservative — it's better to overcount by a small margin than to undercount and hit a 413 error. The AUTOCOMPACT_BUFFER_TOKENS provides additional safety margin for estimation errors.

## How These Budgets Interact

The three budgets form a hierarchy:

```
┌─────────────────────────────────────────────┐
│  Task Budget (total tokens across all turns) │
│  ┌─────────────────────────────────────────┐ │
│  │  Context Window (per-request limit)     │ │
│  │  ┌───────────────────────────────────┐  │ │
│  │  │  Effective Window (minus output)  │  │ │
│  │  │  ┌─────────────────────────────┐  │  │ │
│  │  │  │  Usable (minus safety buf.) │  │  │ │
│  │  │  └─────────────────────────────┘  │  │ │
│  │  └───────────────────────────────────┘  │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

A request can fail any of these checks:
- **Usable window exceeded** → trigger autocompact
- **Effective window exceeded** → block the API call
- **Task budget exceeded** → stop the entire task

Each check produces a different response. The usable window check triggers graceful compaction. The effective window check triggers emergency measures. The task budget check terminates the task entirely.

## Real-World Numbers

For Claude with a 200K context window:

| Budget | Tokens | Roughly |
|--------|--------|---------|
| Total context window | 200,000 | ~150K words |
| Max output reserved | 16,000 | ~12K words |
| Effective window | 184,000 | ~138K words |
| Safety buffer | 13,000 | ~10K words |
| Usable input budget | 171,000 | ~128K words |

For comparison, a typical source file is 200-500 tokens. The agent can hold roughly 350-850 files in context simultaneously — which sounds like a lot until you consider that a real task involves reading files, searching, editing, running commands, and accumulating all of that history.

## Key Takeaways

1. **Effective window = context window minus reserved output** — always leave room for the model to respond
2. **AUTOCOMPACT_BUFFER_TOKENS (13K)** provides a safety margin for token count estimation errors
3. **Three warning states** — ok, warning (trigger compaction), blocking (don't call API)
4. **Token checks happen before every API call** — the agent never blindly sends a request
5. **Task budget limits cumulative usage** — prevents runaway loops across many turns
6. **Token counting is estimation** — conservative estimates plus safety buffers prevent 413 errors

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Budget Calculation
**Question:** For a model with a 128K context window and 8K max output tokens, calculate the effective window size, the usable input budget (after the 13K safety buffer), and the token count that would trigger the "blocking" state.

[View Answer](../../answers/06-context-management/answer-57.md#exercise-1)

### Exercise 2 — Token Warning State Machine
**Challenge:** Implement the `calculateTokenWarningState` function from scratch. It should accept `tokenCount`, `contextWindowSize`, and `maxOutputTokens`, and return an object with `level` ("ok" | "warning" | "blocking"), `isAtBlockingLimit`, and the computed thresholds. Use `AUTOCOMPACT_BUFFER_TOKENS = 13_000`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-57.md#exercise-2)

### Exercise 3 — Task Budget Tracker
**Challenge:** Write a `TaskBudgetTracker` class that tracks cumulative token usage across API calls. It should have methods `recordUsage(inputTokens: number, outputTokens: number)`, `getRemainingBudget(): number`, and `isExhausted(): boolean`. Initialize it with a `maxTokens` budget.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-57.md#exercise-3)

### Exercise 4 — Budget Hierarchy
**Question:** Explain why the three budgets (usable window, effective window, and task budget) form a hierarchy. What would go wrong if you only checked the task budget and ignored the per-request limits?

[View Answer](../../answers/06-context-management/answer-57.md#exercise-4)

---

*Previous: [Lesson 56 — Why Context Matters](56-why-context-matters.md) · Next: [Lesson 58 — Tool Result Budgets](58-tool-result-budgets.md)*
