# Lesson 52: Environment Context

## Why the Model Needs to Know Where It Is

A coding agent doesn't operate in a vacuum. It runs in a specific directory, on a specific OS, with a specific shell. The model needs this information to generate correct commands, understand file paths, and interpret tool results.

Without environment context, the model guesses — and guesses wrong:

```typescript
// Without environment context:
// User: "Run the tests"
// Agent: Bash({ command: "npm test" })
// But it's a Python project in /home/user/flask-app!

// With environment context:
// System prompt includes: CWD: /home/user/flask-app
// Agent reads directory, sees pytest.ini
// Agent: Bash({ command: "pytest" })
```

## computeSimpleEnvInfo()

This function gathers basic environment data and formats it for injection into the system prompt:

```typescript
function computeSimpleEnvInfo(): string {
  const info: string[] = [];

  // Working directory
  info.push(`Working directory: ${process.cwd()}`);

  // Platform
  const platformMap: Record<string, string> = {
    darwin: "macOS",
    linux: "Linux",
    win32: "Windows",
  };
  const platform = platformMap[process.platform] || process.platform;
  info.push(`Platform: ${platform}`);

  // Shell
  const shell = process.env.SHELL || process.env.COMSPEC || "unknown";
  info.push(`Shell: ${shell}`);

  // OS version (when available)
  const osVersion = getOsVersion();
  if (osVersion) {
    info.push(`OS version: ${osVersion}`);
  }

  // Model info
  info.push(`Model: ${getModelName()}`);
  info.push(`Knowledge cutoff: ${getKnowledgeCutoff()}`);

  // Date
  info.push(`Today's date: ${formatDate(new Date())}`);

  return `## Environment\n\n${info.join("\n")}`;
}
```

The output looks like:

```
## Environment

Working directory: /home/user/my-project
Platform: Linux
Shell: /bin/bash
OS version: Ubuntu 22.04
Model: claude-sonnet-4-20250514
Knowledge cutoff: April 2025
Today's date: 2025-07-15
```

## Why Each Field Matters

### Working Directory

The most critical piece. It determines how the model interprets relative paths, which project it thinks it's in, and what tools/frameworks it expects to find.

```typescript
// CWD: /home/user/react-app
// Model sees this and knows:
// - Likely a React/Node project
// - npm/yarn commands are relevant
// - src/ probably contains components
// - package.json should exist

// CWD: /home/user/django-api
// Model adjusts:
// - Python project
// - manage.py commands
// - requirements.txt or pyproject.toml
// - apps/ or api/ directory structure
```

### Platform and Shell

Platform determines command syntax. The same task requires different commands on different OSes:

```typescript
// Platform: macOS, Shell: /bin/zsh
// → sed -i '' 's/old/new/' file    (BSD sed)
// → open http://localhost:3000      (macOS open)
// → brew install package

// Platform: Linux, Shell: /bin/bash
// → sed -i 's/old/new/' file        (GNU sed)
// → xdg-open http://localhost:3000   (Linux open)
// → apt install package

// Platform: Windows, Shell: powershell
// → (Get-Content file) -replace 'old','new'
// → Start-Process http://localhost:3000
// → winget install package
```

Without platform info, the model defaults to Linux conventions, which fail on macOS and Windows.

### Knowledge Cutoff

This tells the model the boundary of its training data:

```typescript
// Knowledge cutoff: April 2025
// User: "How do I use the new React 20 feature?"
//
// Without cutoff info:
//   Model might fabricate an answer about React 20
//
// With cutoff info:
//   Model knows to say "My knowledge cutoff is April 2025.
//   Let me check the documentation for you." → uses tools
```

### Current Date

Prevents the model from confusing "now" with its training cutoff. Essential for time-sensitive operations like checking if certificates are expired, interpreting "last week" in git logs, or understanding release dates.

## getSystemContext(): Git State

Beyond basic environment info, Claude Code injects **git context** — the current state of version control:

```typescript
async function getSystemContext(): Promise<string> {
  const parts: string[] = [];

  // Git branch
  const branch = await execQuiet("git branch --show-current");
  if (branch) {
    parts.push(`Git branch: ${branch.trim()}`);
  }

  // Git status summary
  const status = await execQuiet("git status --porcelain");
  if (status) {
    const lines = status.trim().split("\n");
    const modified = lines.filter(l => l.startsWith(" M")).length;
    const added = lines.filter(l => l.startsWith("A ")).length;
    const untracked = lines.filter(l => l.startsWith("??")).length;

    const summary = [
      modified && `${modified} modified`,
      added && `${added} staged`,
      untracked && `${untracked} untracked`,
    ].filter(Boolean).join(", ");

    parts.push(`Git status: ${summary || "clean"}`);
  }

  // Recent commits for context
  const log = await execQuiet(
    "git log --oneline -5 --no-decorate"
  );
  if (log) {
    parts.push(`Recent commits:\n${log.trim()}`);
  }

  return parts.join("\n");
}
```

This gives the model awareness of:

```
Git branch: feature/add-auth
Git status: 3 modified, 1 untracked
Recent commits:
  a1b2c3d Add password hashing
  d4e5f6g Create user model
  g7h8i9j Initial auth scaffold
  j0k1l2m Update dependencies
  m3n4o5p Fix linting errors
```

With this context, when the user says "commit my changes", the model knows there are 3 modified files and 1 untracked file. It can make an informed commit message based on recent commit style.

## getUserContext(): CLAUDE.md Content

The third context function loads user-defined project instructions:

```typescript
async function getUserContext(
  projectRoot: string
): Promise<string> {
  const parts: string[] = [];

  // Current date (for the model's awareness)
  parts.push(`Current date: ${formatDate(new Date())}`);

  // CLAUDE.md content (project memory)
  const claudeMd = await loadClaudeMdContent(projectRoot);
  if (claudeMd) {
    parts.push(`## Project Instructions (CLAUDE.md)\n\n${claudeMd}`);
  }

  return parts.join("\n\n");
}
```

We'll cover CLAUDE.md in depth in Lesson 53. For now, know that it's a file users create to give the agent persistent, project-specific instructions.

## Memoization and Cache Invalidation

Environment context functions are called on every turn, but some data (like platform, shell) never changes during a session. Claude Code uses memoization to avoid redundant work:

```typescript
class MemoizedContextProvider {
  private cache: Map<string, { value: string; timestamp: number }> = new Map();

  async get(
    key: string,
    producer: () => Promise<string>,
    ttlMs: number
  ): Promise<string> {
    const cached = this.cache.get(key);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < ttlMs) {
      return cached.value;
    }

    const value = await producer();
    this.cache.set(key, { value, timestamp: now });
    return value;
  }
}

const contextCache = new MemoizedContextProvider();

async function getEnvironmentContext(): Promise<string> {
  // Platform info: cache forever (never changes)
  const platform = await contextCache.get(
    "platform",
    async () => computePlatformInfo(),
    Infinity
  );

  // Git status: cache for 5 seconds (changes with user actions)
  const gitStatus = await contextCache.get(
    "git_status",
    async () => getGitStatus(),
    5000
  );

  // CWD: no cache (can change between turns)
  const cwd = process.cwd();

  return [platform, `CWD: ${cwd}`, gitStatus].join("\n");
}
```

The TTL values reflect how often each piece of data actually changes:

| Data | TTL | Rationale |
|------|-----|-----------|
| Platform/OS | Infinity | Never changes in a session |
| Shell | Infinity | Never changes in a session |
| Model name | Infinity | Fixed at session start |
| CWD | 0 (no cache) | Can change any turn (`cd`) |
| Git branch | 5s | Changes on checkout |
| Git status | 5s | Changes on any file operation |
| Date/time | 0 (no cache) | Changes every second |

## Parallel Context Loading

Multiple context sources are loaded in parallel for efficiency:

```typescript
async function loadAllContext(
  config: AgentConfig
): Promise<ContextBundle> {
  const [envInfo, systemContext, userContext] = await Promise.all([
    computeSimpleEnvInfo(),
    getSystemContext(),
    getUserContext(config.projectRoot),
  ]);

  return { envInfo, systemContext, userContext };
}
```

Each function independently reads from the filesystem or runs shell commands. `Promise.all` ensures they execute concurrently rather than sequentially, reducing the latency of prompt assembly.

## Formatting Context for the Prompt

Raw context data needs to be formatted for LLM consumption. The model reads natural language better than structured data:

```typescript
function formatContextForPrompt(ctx: ContextBundle): string {
  const sections: string[] = [];

  sections.push(`## Environment Information

${ctx.envInfo}`);

  if (ctx.systemContext) {
    sections.push(`## Repository State

${ctx.systemContext}`);
  }

  if (ctx.userContext) {
    sections.push(ctx.userContext);
  }

  return sections.join("\n\n");
}
```

Using markdown headers (`##`) helps the model identify and attend to specific sections. Without structure, context blends together and the model may miss important details.

## Context Budget

Environment context competes with other prompt content for the model's context window. Keep it lean:

```typescript
function trimContextToFit(
  context: string,
  maxTokens: number
): string {
  const estimated = estimateTokens(context);

  if (estimated <= maxTokens) return context;

  // Prioritize: CWD > branch > status > commits
  const lines = context.split("\n");
  const priorities = [
    (l: string) => l.startsWith("Working directory"),
    (l: string) => l.startsWith("Git branch"),
    (l: string) => l.startsWith("Platform"),
    (l: string) => l.startsWith("Git status"),
    (l: string) => l.startsWith("Recent commits"),
  ];

  let trimmed: string[] = [];
  for (const check of priorities) {
    const matching = lines.filter(check);
    const newEstimate = estimateTokens(
      [...trimmed, ...matching].join("\n")
    );
    if (newEstimate <= maxTokens) {
      trimmed.push(...matching);
    }
  }

  return trimmed.join("\n");
}
```

## What's Next

Environment context tells the model about the runtime world. But there's another source of context that comes from the *user*: **project memory**. In Lesson 53, we'll look at how CLAUDE.md files let users inject persistent, per-project instructions into the system prompt.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Why Each Context Field Matters
**Question:** Explain how the model's behavior would differ when responding to "Run the tests" if the environment context said `CWD: /home/user/react-app, Platform: macOS` versus `CWD: /home/user/django-api, Platform: Linux`. Trace through the model's tool choices for each scenario.

[View Answer](../../answers/05-prompt-engineering/answer-52.md#exercise-1)

### Exercise 2 — Build computeSimpleEnvInfo()
**Challenge:** Write a `computeSimpleEnvInfo(): string` function that gathers working directory, platform (mapped to human-readable names), shell, and current date. Format the output as a markdown section with a `## Environment` header.

Write your solution in your IDE first, then check:

[View Answer](../../answers/05-prompt-engineering/answer-52.md#exercise-2)

### Exercise 3 — Memoization with TTL
**Challenge:** Write a `MemoizedCache` class with a `get(key: string, producer: () => Promise<string>, ttlMs: number): Promise<string>` method. Cache entries should expire after their TTL. Demonstrate how different data types (platform vs. git status) should use different TTLs.

Write your solution in your IDE first, then check:

[View Answer](../../answers/05-prompt-engineering/answer-52.md#exercise-3)

### Exercise 4 — Context Budget Prioritization
**Question:** When environment context exceeds the token budget, which fields should be kept and which can be dropped? Order these from highest to lowest priority and explain your reasoning: git status, recent commits, working directory, platform, git branch.

[View Answer](../../answers/05-prompt-engineering/answer-52.md#exercise-4)
