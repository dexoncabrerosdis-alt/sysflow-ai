# Lesson 56: Why Context Matters

## The Fundamental Constraint

Every large language model has a fixed context window — a maximum number of tokens it can process in a single request. This is the hardest constraint in building an AI coding agent. Not latency, not cost, not model quality. **Context**.

When you use Claude Code to work on a real codebase, here's what gets packed into every API call:

```
┌─────────────────────────────────────────────┐
│ System prompt (~3,000 tokens)               │
├─────────────────────────────────────────────┤
│ Environment context (tools, rules, etc.)    │
├─────────────────────────────────────────────┤
│ Conversation history                        │
│   ├── User message 1                        │
│   ├── Assistant response 1                  │
│   ├── Tool call + result 1                  │
│   ├── Tool call + result 2                  │
│   ├── User message 2                        │
│   ├── Assistant response 2                  │
│   ├── Tool call + result 3                  │
│   │   ... (grows with every turn) ...       │
│   └── Tool call + result N                  │
├─────────────────────────────────────────────┤
│ Reserved for model output                   │
└─────────────────────────────────────────────┘
```

A model with a 200K context window sounds enormous. But consider a real task: "Refactor the authentication module to use JWT tokens." The agent might:

1. Read 5-10 files to understand the current auth system
2. Search for all references to the old auth pattern
3. Edit 8 files, reading each before and after
4. Run tests, read error output, fix issues
5. Read documentation files for the JWT library

Each file read might be 200-500 lines. Each tool result adds hundreds or thousands of tokens. After 30-40 tool calls, you've consumed 150K+ tokens of context — and the model still needs room to think and respond.

## The Desk Analogy

Think of context as a physical desk with limited surface area.

Your desk can hold a fixed number of papers. The system prompt is a reference manual that's always open. Each file you read is a printed document. Each tool result is a sticky note with findings. Each conversation turn is a page of notes.

At first, you have plenty of room. Read a file? Put it on the desk. Run a search? Add the results. But 30 minutes into a complex task, the desk is covered. You need to read a new file, but there's no room.

You have a few options:

- **Stack papers on top of each other** (overwrite old context — you lose access to it)
- **Summarize several documents into one page** (compaction — keep the gist, lose the details)
- **Throw away documents you probably won't need** (truncation — risky if you guess wrong)
- **Get a bigger desk** (use a model with a larger context window — expensive, has limits)

Claude Code uses all of these strategies. This module covers each one in detail.

## What Happens When Context Fills Up

When an agent doesn't manage context, three failure modes appear:

### 1. API Rejection (Hard Failure)

The model API returns an HTTP 413 error — the prompt is literally too long. The agent can't proceed at all.

```typescript
// The API call fails before the model even sees the prompt
try {
  const response = await callAPI(messages);
} catch (error) {
  if (error.status === 413) {
    // "prompt_too_long" — the request exceeded the model's limit
    // Without context management, this is terminal
  }
}
```

### 2. Degraded Output Quality (Soft Failure)

Even before hitting the hard limit, models produce worse output as context grows. With 180K tokens of context, the model may:

- Forget instructions from the system prompt
- Lose track of which files it already edited
- Repeat work it already did
- Miss important details buried in the middle of context (the "lost in the middle" problem)

### 3. Runaway Costs

Token usage directly drives cost. A conversation with 200K tokens of context costs roughly 100x more per turn than one with 2K tokens. Without management, agents spiral into expensive loops where each API call processes the entire bloated history.

```
Turn 1:  ~5K tokens  → $0.01
Turn 10: ~50K tokens → $0.10
Turn 30: ~180K tokens → $0.36
                        ─────
Total for 30 turns:     ~$4.70

With compaction at turn 15:
Turn 1:  ~5K tokens  → $0.01
Turn 15: ~90K tokens → $0.18
Turn 16: ~15K tokens → $0.03  ← compacted
Turn 30: ~80K tokens → $0.16
                        ─────
Total for 30 turns:     ~$1.80
```

## Context Management Is Memory Management

If you've written systems software, context management will feel familiar. It's memory management for an AI agent.

| Memory Management | Context Management |
|---|---|
| RAM limit | Context window size |
| malloc / free | Adding / removing messages |
| Garbage collection | Compaction & cleanup |
| Virtual memory / swap | Persisting results to disk |
| Stack overflow | Prompt too long (413) |
| Memory fragmentation | Scattered useful info across turns |
| Memory pools | Per-tool token budgets |

Just like a program needs to run within its memory budget, an agent needs to run within its context budget. And just like memory management, the best context management is invisible to the user — it happens automatically, behind the scenes.

## The Five Layers of Defense

Claude Code doesn't rely on a single context management strategy. It uses a layered approach, where each layer handles a different scenario:

```
Layer 1: Tool Result Budgets
  ↓ Cap individual results before they enter context
Layer 2: Snip
  ↓ Remove old message segments
Layer 3: Microcompact
  ↓ Clear old tool results in-place
Layer 4: Context Collapse
  ↓ Progressive staged reduction
Layer 5: Autocompact + Reactive Compact
  ↓ Summarize the entire conversation
```

Each layer is progressively more aggressive. Tool result budgets prevent individual results from being too large. Microcompact quietly clears stale results. Autocompact rewrites the conversation as a summary. Reactive compact is the emergency parachute when everything else fails.

This layered design means the agent rarely needs the aggressive strategies. Most of the time, budgets and microcompact keep things under control. The user never notices.

## Why Not Just Use a Bigger Context Window?

Models keep getting larger context windows — 200K, 1M, even 2M tokens. So why bother with context management at all?

Three reasons:

1. **Cost scales with context size.** Processing 1M tokens per API call is expensive, even if the model supports it. Context management keeps costs reasonable.

2. **Quality degrades with length.** Current models perform worse on very long contexts. A well-managed 50K context often produces better results than an unmanaged 200K context.

3. **Latency increases linearly.** More tokens = longer time-to-first-token. Users waiting 30 seconds for each response will abandon the tool.

Context management isn't a workaround for small windows. It's a fundamental requirement for building agents that are fast, cheap, and accurate.

## What's Ahead

This module walks through every context management mechanism in Claude Code:

- **Lesson 57**: Token budgets and limit checking
- **Lesson 58**: Per-tool result size caps
- **Lesson 59**: Microcompact — clearing old tool results
- **Lesson 60**: Autocompact — proactive conversation summarization
- **Lesson 61**: How compaction summaries are generated
- **Lesson 62**: Reactive compact — emergency recovery from 413 errors
- **Lesson 63**: Context collapse — progressive staged reduction
- **Lesson 64**: Snip — removing old message segments
- **Lesson 65**: The full compaction pipeline — how all layers work together

By the end, you'll understand how an agent can work on multi-hour tasks across thousands of files without running out of context. The techniques here are what separate a toy chatbot from a production coding agent.

## Key Takeaways

1. **Context is the hard constraint** — every token of system prompt, history, and tool results competes for the same fixed-size window
2. **Unmanaged context leads to failures** — API rejections, degraded quality, and runaway costs
3. **Context management is memory management** — the same principles of budgeting, garbage collection, and tiered storage apply
4. **Multiple layers are needed** — no single strategy handles all scenarios
5. **Even with large windows, management matters** — for cost, quality, and latency

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Desk Analogy Applied
**Question:** Using the desk analogy from this lesson, explain what happens when an agent reads 10 files, edits 5 of them, and then needs to read 3 more files — but context is 90% full. Which context management strategies would apply and in what order?

[View Answer](../../answers/06-context-management/answer-56.md#exercise-1)

### Exercise 2 — Context Budget Calculator
**Challenge:** Write a TypeScript function that takes a list of tool results (each with a `type` and `tokenCount`) and a `maxContextTokens` budget, and returns an object reporting: total tokens used, remaining budget, and a boolean `isOverBudget`. Include the system prompt overhead as a constant of 3000 tokens.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-56.md#exercise-2)

### Exercise 3 — Cost Projection
**Challenge:** Write a function `projectCosts(turns: number, avgTokensPerTurn: number, compactionAt: number)` that computes the total cost of a conversation with and without compaction. Assume each API call costs `$0.002` per 1K input tokens. When compaction fires at turn `compactionAt`, context drops to 15% of its current size.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-56.md#exercise-3)

### Exercise 4 — Failure Mode Identification
**Question:** A user reports that their agent "keeps repeating the same file edits and going in circles" during a long refactoring task. Which of the three failure modes described in this lesson is most likely the cause, and why? What context management layer would most directly address it?

[View Answer](../../answers/06-context-management/answer-56.md#exercise-4)

---

*Next: [Lesson 57 — Token Budgets and Limits](57-token-budgets-and-limits.md)*
