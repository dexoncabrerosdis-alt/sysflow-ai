# Lesson 26: Read-Only vs. Write Tools

## The Fundamental Divide

Every tool in Claude Code falls into one of two categories:

- **Read-only tools**: observe the world without changing it
- **Write tools**: modify files, run commands, or alter state

This distinction, encoded in the `isReadOnly` flag, is one of the most consequential
design decisions in the tool system. It affects permissions, concurrency, safety
guardrails, and user trust.

## Why the Distinction Matters

Consider two scenarios:

**Scenario A**: The model reads your `package.json` to answer a question about
your dependencies. Harmless. Reversible (nothing changed). Safe to do without asking.

**Scenario B**: The model runs `rm -rf node_modules && npm install` to fix a
dependency issue. Potentially destructive. Time-consuming to undo. Should probably
ask first.

The `isReadOnly` flag is how the system knows the difference.

## Read-Only Tools

These tools observe but never modify:

```typescript
// FileReadTool
const FileReadTool = buildTool({
  name: "Read",
  description: "Read file contents from the filesystem",
  isReadOnly: true,
  isConcurrencySafe: true,
  // ...
});

// GrepTool
const GrepTool = buildTool({
  name: "Grep",
  description: "Search file contents with regex",
  isReadOnly: true,
  isConcurrencySafe: true,
  // ...
});

// GlobTool
const GlobTool = buildTool({
  name: "Glob",
  description: "Find files matching a pattern",
  isReadOnly: true,
  isConcurrencySafe: true,
  // ...
});

// WebFetchTool
const WebFetchTool = buildTool({
  name: "WebFetch",
  description: "Fetch content from a URL",
  isReadOnly: true,
  isConcurrencySafe: true,
  // ...
});

// ListPeersTool
const ListPeersTool = buildTool({
  name: "ListPeers",
  description: "List available peer agents",
  isReadOnly: true,
  isConcurrencySafe: true,
  // ...
});
```

Notice the pattern: read-only tools are almost always concurrency-safe too. If a
tool doesn't change anything, it can't interfere with other tools running at the
same time.

### Properties of Read-Only Tools

1. **No permission prompts**: The user is never asked "Allow Read on /src/index.ts?"
   because reading is inherently safe
2. **Concurrency-safe**: Can run in parallel with other read-only tools
3. **Idempotent**: Calling them twice with the same input produces the same result
4. **No undo needed**: Nothing to revert if the result is unexpected

## Write Tools

These tools modify state:

```typescript
// FileWriteTool
const FileWriteTool = buildTool({
  name: "Write",
  description: "Create or overwrite a file",
  isReadOnly: false,
  isConcurrencySafe: false,
  // ...
});

// FileEditTool
const FileEditTool = buildTool({
  name: "Edit",
  description: "Make surgical edits to a file",
  isReadOnly: false,
  isConcurrencySafe: false,
  // ...
});

// BashTool
const BashTool = buildTool({
  name: "Bash",
  description: "Execute a shell command",
  isReadOnly: false,
  isConcurrencySafe: false,
  // ...
});

// NotebookEditTool
const NotebookEditTool = buildTool({
  name: "NotebookEdit",
  description: "Edit a Jupyter notebook cell",
  isReadOnly: false,
  isConcurrencySafe: false,
  // ...
});

// TodoWriteTool
const TodoWriteTool = buildTool({
  name: "TodoWrite",
  description: "Create or update task items",
  isReadOnly: false,
  isConcurrencySafe: false,
  // ...
});
```

### Properties of Write Tools

1. **Permission checks**: The user may be prompted before execution
2. **Not concurrency-safe by default**: Writes can conflict with each other
3. **Side effects**: The world is different after execution
4. **May need undo**: File writes can be reverted, but command execution may not

## The Permission Cascade

The `isReadOnly` flag feeds into the permission system:

```typescript
async function shouldPromptUser(tool: Tool, input: unknown): Promise<boolean> {
  // Read-only tools never need permission
  if (tool.isReadOnly) {
    return false;
  }

  // Write tools check against permission rules
  const permResult = await tool.checkPermissions?.(input, context);
  if (permResult?.allowed) {
    return false;  // pre-approved by rules
  }

  // Not pre-approved — ask the user
  return true;
}
```

This creates a clean hierarchy:
1. Read-only tools → always allowed
2. Write tools with matching permission rules → auto-approved
3. Write tools without rules → prompt the user

## Gray Areas

Some tools don't fit neatly into read/write:

### Bash: The Chameleon

`Bash` is marked as `isReadOnly: false` because it *can* modify things. But many
bash commands are read-only: `ls`, `cat`, `git status`, `node --version`.

Claude Code handles this by making the permission check input-aware:

```typescript
const BashTool = buildTool({
  name: "Bash",
  isReadOnly: false,
  async checkPermissions(input: { command: string }, context) {
    // Some commands are always safe
    if (isReadOnlyCommand(input.command)) {
      return { allowed: true };
    }
    // Others need approval
    return context.permissionManager.check("Bash", input.command);
  },
});
```

### WebFetch: Read-Only But External

`WebFetch` is marked `isReadOnly: true` because it doesn't change local state.
But it sends network requests, which could theoretically have side effects on
external services (analytics tracking, rate limiting). The conservative choice
would be `isReadOnly: false`, but Claude Code prioritizes the local perspective.

### Agent: Creates Processes

The `Agent` tool spawns sub-agents—new processes that can themselves use write
tools. It's marked as a write tool because it creates entities that can modify
the filesystem.

## Practical Impact on User Experience

The read/write distinction directly affects how the agent *feels* to use:

### In "auto-approve read" mode (default):

```
User: "What testing framework does this project use?"

Agent: [internally]
  → Grep(pattern: "jest|mocha|vitest", path: "package.json")  ← auto-approved
  → Read(file_path: "jest.config.ts")                          ← auto-approved

Agent: "This project uses Jest with TypeScript support..."
```

No interruptions. The model reads freely, answers quickly.

### When writes are needed:

```
User: "Add a test for the login function"

Agent: [internally]
  → Read(file_path: "src/auth/login.ts")           ← auto-approved
  → Read(file_path: "src/auth/__tests__/")          ← auto-approved
  → Write(file_path: "src/auth/__tests__/login.test.ts", ...)
    → ⚠️ PERMISSION PROMPT: "Write to login.test.ts?"
  → [user approves]
  → Bash(command: "npm test -- login")
    → ⚠️ PERMISSION PROMPT: "Run npm test?"
```

The user is only interrupted for meaningful decisions.

## The Security Gradient

The read/write distinction creates a natural security gradient:

```
Most permissive                              Most restrictive
      │                                            │
      ▼                                            ▼
  Read tools    Read tools     Write tools    Write tools
  (familiar     (unfamiliar    (reversible)   (irreversible)
   files)        paths)
      │              │              │              │
  Auto-allow    Auto-allow    May prompt      Always prompt
```

This gradient balances productivity (no friction for safe operations) with safety
(gates on destructive operations).

## Categorizing All Tools

Here's the complete breakdown:

### Read-Only (`isReadOnly: true`)

| Tool              | What it reads                    |
|-------------------|----------------------------------|
| Read              | File contents                    |
| Grep              | File contents via regex search   |
| Glob              | Filesystem structure             |
| WebFetch          | Web page content                 |
| WebSearch         | Web search results               |
| ListPeers         | Available agents                 |
| TaskGet           | Task status                      |
| TaskList          | All tasks                        |
| TaskOutput        | Task output                      |
| ListMcpResources  | MCP resource list                |
| ReadMcpResource   | MCP resource content             |
| TerminalCapture   | Terminal state                   |
| Config (read)     | Configuration values             |

### Write (`isReadOnly: false`)

| Tool              | What it modifies                 |
|-------------------|----------------------------------|
| Write             | Creates/overwrites files         |
| Edit              | Surgically edits file content    |
| NotebookEdit      | Edits Jupyter notebook cells     |
| Bash              | Executes arbitrary commands      |
| Agent             | Spawns sub-agents                |
| SendMessage       | Communicates with peers          |
| TodoWrite         | Creates/updates task lists       |
| TaskCreate        | Creates background tasks         |
| TaskUpdate        | Modifies task input              |
| TaskStop          | Stops running tasks              |
| EnterPlanMode     | Changes agent mode               |
| ExitPlanMode      | Changes agent mode               |
| AskUserQuestion   | Prompts user (side effect)       |

## Key Takeaways

1. `isReadOnly` is the fundamental safety classification for tools
2. Read-only tools are auto-approved and concurrency-safe
3. Write tools need permission checks and run serially by default
4. Bash is a special case—marked write but input-aware permission checks
5. The distinction creates a natural security gradient: no friction for reading,
   deliberate gates for writing

## What's Next

We've touched on concurrency several times. Next, let's explore `isConcurrencySafe`
in depth—what it means, how it's checked, and why it matters for tool execution.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Permission Cascade

**Question:** What determines whether a tool needs a permission prompt? Describe the three-level hierarchy and give an example tool that falls into each level.

[View Answer](../../answers/03-tool-system/answer-26.md#exercise-1)

### Exercise 2 — Implement shouldPromptUser

**Challenge:** Implement the `shouldPromptUser()` function that takes a `Tool` and input, and returns `true` if the user should be prompted. Follow the three-level cascade: read-only tools never prompt, write tools with matching permission rules are auto-approved, and everything else prompts.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-26.md#exercise-2)

### Exercise 3 — The Bash Gray Area

**Question:** Why is Bash marked as `isReadOnly: false` even though many bash commands like `ls`, `cat`, and `git status` are read-only? How does Claude Code handle this tension between the static flag and the dynamic reality?

[View Answer](../../answers/03-tool-system/answer-26.md#exercise-3)

### Exercise 4 — Implement isReadOnlyCommand

**Challenge:** Write an `isReadOnlyCommand(command: string): boolean` function that returns `true` for safe, read-only bash commands. Handle common patterns: commands starting with `ls`, `cat`, `echo`, `git status`, `git log`, `node --version`, `pwd`, `which`, `whoami`. Be careful about commands that *start* with a safe word but do something dangerous (e.g., `cat > file.txt`).

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-26.md#exercise-4)

### Exercise 5 — Classify These Tools

**Challenge:** For each tool below, determine `isReadOnly` and whether it needs a permission prompt. Explain any gray areas:
1. A tool that checks if a port is open
2. A tool that sends a Slack message
3. A tool that reads environment variables
4. A tool that creates a Git branch
5. A tool that computes a file's hash (SHA-256)

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-26.md#exercise-5)

---

*Module 03: The Tool System — Lesson 26 of 35*
