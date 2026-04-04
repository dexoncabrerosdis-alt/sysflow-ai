# Lesson 8: What Makes a Good Agent?

## Introduction

You now understand the building blocks: LLMs generate text (Lesson 3), conversations are message arrays (Lesson 4), tools let the model take actions (Lesson 5), JSON is the communication format (Lesson 6), and streaming provides real-time feedback (Lesson 7).

But having the right building blocks doesn't guarantee a good result. You can have the best ingredients and still make a terrible meal. What separates a **great** AI coding agent from a frustrating one?

In this lesson, you'll learn the 7 qualities of a well-built agent — and why the orchestration layer matters more than the model itself.

---

## The 7 Qualities of a Great Agent

### 1. Reliability — Handles Errors and Retries

Things go wrong constantly. Files don't exist. Commands fail. API calls time out. Network connections drop.

A **bad agent** crashes when something unexpected happens:

```
User:  "Read the config file"
Agent: Tries to read config.json
       ERROR: File not found
Agent: "I encountered an error." (gives up)
```

A **good agent** anticipates failure and recovers:

```
User:  "Read the config file"
Agent: Tries to read config.json
       ERROR: File not found
Agent: Searches for config files → finds config.yaml
Agent: "I couldn't find config.json, but I found config.yaml.
        Here's its contents..."
```

Reliability means:
- Retrying failed API calls with exponential backoff
- Catching errors from tool execution and trying alternatives
- Not crashing when the model produces malformed output
- Handling edge cases like empty files, permission errors, or huge outputs

### 2. Accuracy — Reads Before Writing, Validates Results

A bad agent guesses. A good agent verifies.

**Bad agent:**

```
User:  "Add a login function to auth.ts"
Agent: Writes a login function from scratch
       (doesn't read the file first, overwrites existing code,
        uses wrong import style, breaks the file)
```

**Good agent:**

```
User:  "Add a login function to auth.ts"
Agent: Reads auth.ts first
       Sees the existing code style, imports, and patterns
       Writes a login function that matches the existing style
       Runs the linter to verify no errors were introduced
```

Accuracy means:
- Always reading a file before editing it
- Checking command output to confirm success
- Following existing code patterns and conventions
- Validating changes don't break anything

### 3. Efficiency — Does More with Less

Every API call costs money and takes time. A good agent minimizes waste.

**Bad agent:**

```
Step 1: Read file A
Step 2: Read file B
Step 3: Read file C
(3 separate API calls, one per file)
```

**Good agent:**

```
Step 1: Read files A, B, and C in parallel
(1 API call with 3 tool calls)
```

Efficiency means:
- Using parallel tool calls when possible (reading multiple files at once)
- Caching information it's already retrieved
- Not re-reading files that haven't changed
- Summarizing large outputs to save context window space

### 4. Safety — Asks Before Doing Anything Dangerous

An agent that can run commands on your computer is powerful — and potentially dangerous. A good agent has guardrails.

```
Agent: I need to run `rm -rf node_modules` to clean the build.
       May I proceed? [Yes / No]
```

Safety means:
- Asking permission before running destructive commands
- Having an allowlist of "safe" commands that don't need permission
- Never running commands that could damage the system without explicit approval
- Limiting the scope of what the agent can access (e.g., only the current project)

Claude Code has a built-in permission system. It categorizes actions into risk levels and asks for your approval when needed.

### 5. Context Awareness — Knows Its Environment

A good agent doesn't operate in a vacuum. It understands the project it's working in.

**Bad agent:**

```
User:  "Install the testing library"
Agent: Runs `pip install pytest`
       (but the project uses JavaScript, not Python)
```

**Good agent:**

```
User:  "Install the testing library"
Agent: Checks package.json → sees it's a JavaScript project using npm
       Checks existing devDependencies → sees vitest is partially set up
       Runs `npm install vitest` to complete the setup
```

Context awareness means:
- Detecting the programming language and framework
- Reading configuration files (package.json, tsconfig.json, .env, etc.)
- Understanding the project structure before making changes
- Knowing what tools and commands are available in the environment

### 6. Self-Correction — Detects and Fixes Its Own Mistakes

Even good agents make mistakes. What matters is what happens next.

**Bad agent:**

```
Agent: Edits src/app.ts
       Runs tests → 3 tests fail
Agent: "I've made the changes you requested."
       (doesn't even notice the failures)
```

**Good agent:**

```
Agent: Edits src/app.ts
       Runs tests → 3 tests fail
Agent: "I see 3 tests failing. Let me read the error messages..."
       Reads errors → identifies a typo in the edit
       Fixes the typo
       Runs tests again → all tests pass
Agent: "Done! I had to fix a small typo in my first edit.
        All tests pass now."
```

Self-correction means:
- Checking the results of every action
- Recognizing when something went wrong
- Attempting to fix errors before reporting "done"
- Being honest about what happened (transparency, which is #7)

### 7. Transparency — Shows What It's Doing

A good agent doesn't work in a black box. It shows you its reasoning and actions.

```
Agent: I'll start by reading the current implementation.
       📖 Reading src/auth/login.ts...
       I see the current login function doesn't handle expired tokens.
       📝 Editing src/auth/login.ts...
       Adding a token expiration check on line 34.
       🧪 Running tests to verify...
       ✅ All 12 tests pass.
       Done! I added an expiration check to the login function.
```

Transparency means:
- Explaining its plan before acting
- Showing which files it's reading and editing
- Displaying command output
- Reporting results honestly, including failures

---

## Why the Orchestrator Matters More Than the Model

Here's a surprising truth: **two agents using the same model can perform very differently**.

Why? Because the **orchestrator** — the code that wraps around the model — determines how the agent behaves. The model is the brain, but the orchestrator is the body, senses, and habits.

```
┌───────────────────────────────────────┐
│           ORCHESTRATOR                │
│  ┌─────────────────────────────────┐  │
│  │         LLM (the model)         │  │
│  │    Generates text & tool calls  │  │
│  └─────────────────────────────────┘  │
│                                       │
│  + Error handling & retries           │
│  + Permission system                  │
│  + Context management                 │
│  + Tool execution & validation        │
│  + Output formatting & streaming      │
│  + Self-correction loops              │
│  + Conversation management            │
└───────────────────────────────────────┘
```

The orchestrator is responsible for:

| Concern                | Model handles it? | Orchestrator handles it? |
| ---------------------- | ----------------- | ----------------------- |
| Generating text        | ✓                 |                         |
| Deciding which tool    | ✓                 |                         |
| Retry logic            |                   | ✓                       |
| Permission checks      |                   | ✓                       |
| Error recovery         |                   | ✓                       |
| Context window mgmt    |                   | ✓                       |
| Tool execution         |                   | ✓                       |
| Input validation       |                   | ✓                       |
| Streaming UI           |                   | ✓                       |

A smart model with a bad orchestrator will make brilliant plans and then fail to execute them. A good orchestrator with a decent model will reliably complete tasks, recover from errors, and keep the user informed.

**Claude Code's value isn't just the Claude model — it's the orchestrator built around it.**

---

## Bad Agent vs Good Agent: A Side-by-Side

Let's see all 7 qualities in action with a real scenario.

**Task:** "Fix the failing test in src/utils.test.ts"

### Bad Agent

```
1. Immediately tries to edit utils.test.ts (doesn't read it first)
2. Guesses what the fix should be
3. Makes an edit that introduces a syntax error
4. Doesn't run the tests to verify
5. Says "I've fixed the test" (even though it's now worse)
6. Doesn't show what it changed
```

**Problems:** No accuracy (didn't read first), no self-correction (didn't run tests), no transparency (didn't explain), no reliability (didn't handle the new error).

### Good Agent

```
1. Reads src/utils.test.ts to understand the test         (Accuracy)
2. Reads src/utils.ts to understand the implementation     (Context awareness)
3. Identifies the mismatch between test and implementation (Accuracy)
4. Explains the issue to the user                          (Transparency)
5. Asks: "Should I fix the test or the implementation?"    (Safety)
6. Makes the edit based on user choice                     (Accuracy)
7. Runs the tests                                          (Self-correction)
8. Tests pass → reports success with details               (Transparency)
   Tests fail → reads error, tries again                   (Reliability)
```

---

## Summary

- Great agents have 7 key qualities: **Reliability**, **Accuracy**, **Efficiency**, **Safety**, **Context Awareness**, **Self-Correction**, and **Transparency**.
- The **orchestrator** (the code around the model) matters more than the model itself.
- A good orchestrator adds error handling, permission systems, validation, and context management.
- The model decides *what* to do; the orchestrator ensures it's done *well*.

---

> **Key Takeaway**
>
> The model is the brain, but the orchestrator is everything else — the eyes, hands, and judgment. A great AI agent isn't just a great model; it's a great system built around a model. The qualities of reliability, accuracy, efficiency, safety, context awareness, self-correction, and transparency are what make the difference between an agent you trust and one you don't.

---

---

## Practice Exercises

> **Remember**: Write your answers in your notebook first, then check below.

### Exercise 1 — The 7 Qualities
**Question:** List all 7 qualities of a great AI agent from this lesson. For each one, write a single sentence describing what it means.

[View Answer](../../answers/01-foundations/answer-08.md#exercise-1)

### Exercise 2 — Orchestrator vs Model
**Question:** Why does the lesson say "the orchestrator matters more than the model"? What does the orchestrator handle that the model cannot?

[View Answer](../../answers/01-foundations/answer-08.md#exercise-2)

### Exercise 3 — Good vs Bad Agent
**Question:** A user asks an agent to "Add a login function to auth.ts." Describe how a *bad* agent would handle this vs how a *good* agent would handle it. Which qualities are demonstrated by the good agent?

[View Answer](../../answers/01-foundations/answer-08.md#exercise-3)

### Exercise 4 — Code Challenge: Error Recovery
**Challenge:** Write a TypeScript function `safeReadFile` that attempts to read a file, and if it fails, returns a helpful error message instead of crashing. This demonstrates the "reliability" quality of a good agent.

Write your solution in your IDE first, then check:

[View Answer](../../answers/01-foundations/answer-08.md#exercise-4)

---

*Next up: [Lesson 9 — Claude Code Architecture Overview](./09-claude-code-architecture-overview.md), where you'll see how a real-world agent puts all of these concepts together.*
