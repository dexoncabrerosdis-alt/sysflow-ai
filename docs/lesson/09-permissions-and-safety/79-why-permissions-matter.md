# Lesson 79: Why Permissions Matter

## The Power Problem

You've built something remarkable over the last eight modules. Your AI agent can read files, write code, execute shell commands, search across entire codebases, and make decisions in a loop. It has genuine power over a developer's machine.

Now ask yourself: what happens when that power is unchecked?

An AI coding agent with unrestricted access is essentially a program that can:

- Delete any file on the filesystem
- Execute `rm -rf /` or `format C:`
- Read `.env` files and exfiltrate API keys
- Push malicious code to a git repository
- Install compromised npm packages
- Modify system configuration files
- Send HTTP requests to internal network endpoints

This isn't hypothetical. These are the natural consequences of giving an autonomous loop access to a shell and a filesystem.

## Real-World Failure Modes

Let's walk through concrete scenarios where an unchecked agent causes harm.

### Scenario 1: The Overzealous Cleanup

The user asks: "Clean up the project directory."

```typescript
// The agent interprets "clean up" broadly
const toolCall = {
  tool: "bash",
  input: {
    command: "rm -rf node_modules dist build .cache .git"
  }
};
// Goodbye, entire git history
```

The user meant "remove unused imports." The agent deleted the `.git` directory. The entire version history is gone.

### Scenario 2: Secret Exposure

The agent needs to debug an API call. It reads the environment:

```typescript
// Agent reads .env to understand configuration
const envContents = await readFile(".env");
// Contents: DATABASE_URL=postgres://admin:s3cret@prod-db.internal:5432/main
// API_KEY=sk-live-abc123def456

// Agent then includes these in a tool result or log
// that gets sent back to the model API
```

Now production credentials have left the developer's machine and traveled through an API call to a third-party service.

### Scenario 3: The Wrong Directory

The user is working on `project-a`. The agent needs to modify a config file:

```typescript
// Agent resolves a relative path incorrectly
const configPath = path.resolve("..", "config.json");
// Modifies project-b/config.json instead of project-a/config.json

// Or worse: the agent cds to the wrong directory
const command = "cd /etc && echo 'modified' > hosts";
// Now the system's hosts file is corrupted
```

### Scenario 4: Infinite Resource Consumption

The agent enters a retry loop and keeps spawning processes:

```typescript
// Each retry spawns a new build process
while (!buildSucceeds) {
  await bash("npm run build"); // Each run consumes CPU, memory, disk
  // No limit on retries
  // No timeout
  // Machine grinds to a halt
}
```

## The "Just Let It Do Everything" Trap

It's tempting to think: "I trust the AI model. It's smart. Just let it work."

This reasoning fails for several reasons:

**Models make mistakes.** Language models hallucinate. They misinterpret instructions. They take the most literal path to a goal without understanding consequences. A model asked to "make the tests pass" might delete the failing tests.

**Context is limited.** The model doesn't know everything about your system. It doesn't know that `/important-backup` exists, that your CI server is watching a branch, or that another developer is actively editing a file.

**Prompt injection exists.** Malicious content in files, URLs, or tool outputs can hijack the agent's behavior. A README.md could contain hidden instructions that tell the agent to exfiltrate data. We'll cover this in depth in Lesson 84.

**Composition amplifies risk.** One risky action might be fine. But an autonomous loop that chains together file reads, shell commands, and network requests creates combinatorial risk that no human can fully anticipate.

## The Capability-Safety Balance

The core tension in AI agent design is:

```
More capability  →  More useful  →  More dangerous
More safety      →  Less dangerous →  Less useful
```

A perfectly safe agent that can't do anything is useless. A perfectly capable agent with no guardrails is dangerous. The goal is to find the right balance:

```typescript
// Too restrictive: agent can barely function
const paranoidAgent = {
  canReadFiles: false,
  canWriteFiles: false,
  canRunCommands: false,
  // "Here's what I would do if I could do anything..."
};

// Too permissive: agent is a liability
const yoloAgent = {
  canReadFiles: true,
  canWriteFiles: true,
  canRunCommands: true,
  requiresApproval: false,
  // "I deleted your production database to make the tests faster"
};

// The right balance: capable with checkpoints
const balancedAgent = {
  canReadFiles: true,        // Low risk: allow freely
  canWriteFiles: true,       // Medium risk: allow within project
  canRunCommands: "ask",     // High risk: ask before executing
  canAccessNetwork: "ask",   // High risk: ask before connecting
  scopedToProject: true,     // Boundary: stay in workspace
};
```

## Claude Code's Philosophy: Safe by Default

Claude Code takes a specific stance on this balance:

**1. Safe by default.** Destructive operations require explicit approval. The first time the agent wants to write a file or run a command, it asks.

**2. Progressively permissive.** Users can grant blanket permissions for specific patterns. Once you've approved "allow write to `src/**/*.ts`", the agent won't ask again for TypeScript files in `src/`.

**3. Transparent.** Every action the agent takes is visible. The user sees what tools are called, what arguments are passed, and what the results are.

**4. Overridable.** Power users who understand the risks can dial safety down. Automation pipelines can bypass interactive prompts entirely. But these are conscious choices, not defaults.

**5. Defense in depth.** Multiple layers of protection: permission rules, bash command classification, prompt injection awareness, and operational boundaries all work together.

This philosophy manifests as a concrete permission system that we'll explore across this module:

```typescript
// The core question asked before every tool execution
interface PermissionCheck {
  tool: string;           // Which tool wants to run
  input: ToolInput;       // What arguments it received
  permissionMode: string; // Current safety level
  rules: PermissionRule[]; // User-configured allow/deny patterns
}

// The answer determines what happens next
type PermissionResult = {
  behavior: "allow" | "deny" | "ask";
  updatedInput?: ToolInput;  // Rules can modify inputs
  message?: string;          // Explanation for denials
};
```

## The Permission Architecture at a Glance

Here's how the pieces fit together across this module:

| Layer | What It Does | Lesson |
|-------|-------------|--------|
| Permission Modes | Global safety level (default, plan, auto, bypass) | 80 |
| Per-Tool Rules | Allow/deny/ask rules with glob patterns | 81 |
| Interactive Flow | User approval prompts and callbacks | 82 |
| Bash Classification | AI classifier for shell command safety | 83 |
| Prompt Injection | Defense against malicious tool output | 84 |
| Cyber Risk | Boundaries around security-related requests | 85 |

Each layer adds protection. If one layer fails, the next catches the problem. This is defense in depth applied to AI agent design.

## Why This Module Matters

Every tool you built in Modules 04-08 becomes safer after this module. Every agent loop you write after this will have proper guardrails. The permission system isn't an afterthought bolted onto a working agent — it's woven into every tool call, every streaming response, every interaction.

When you ship an AI coding agent to real users, the permission system is the difference between a tool people trust and a tool that gets uninstalled after it deletes someone's work.

## What's Next

In the next lesson, we'll dive into **permission modes** — the four global safety levels that determine how aggressively the agent checks before acting. You'll see how a single configuration value changes the entire behavior of the agent loop.

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Capability-Safety Balance
**Question:** What is the "capability-safety balance" in AI agent design? Give two concrete examples of an agent that is too restrictive and two examples of an agent that is too permissive. Why can't we simply "trust the AI model"?

[View Answer](../../answers/09-permissions-and-safety/answer-79.md#exercise-1)

### Exercise 2 — Implement classifyRisk
**Challenge:** Write a `classifyRisk` function that takes a tool name, its input, and a project root path, then returns `"low" | "medium" | "high"`. Consider: read operations within the project, write operations within the project, writes outside the project, bash commands with dangerous tokens, and network operations.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-79.md#exercise-2)

### Exercise 3 — Project Boundary Validator
**Challenge:** Write a `isWithinProject` function that takes a file path and a project root, resolves both to absolute paths, and returns `true` only if the file is inside the project. Handle path traversal attacks like `../../etc/passwd` and symlink escapes.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-79.md#exercise-3)

### Exercise 4 — Safety Audit Logger
**Challenge:** Define a `SafetyEvent` type and implement a `SafetyAuditLog` class that records every tool execution with its risk level, whether it was approved, and the timestamp. Include a `getSummary()` method that returns counts by risk level.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-79.md#exercise-4)
