# Lesson 34: Built-In Tools Overview

## The Full Toolkit

Claude Code ships with 40+ built-in tools that give the model a comprehensive
set of capabilities. Each tool is purpose-built for a specific task, following
the patterns we've covered in this module.

Let's take a guided tour through every category.

## File Tools

These tools interact with the local filesystem.

### Read

```typescript
{
  name: "Read",
  description: "Read file contents from the filesystem",
  inputSchema: z.object({
    file_path: z.string(),
    offset: z.number().optional(),    // start line (1-indexed)
    limit: z.number().optional(),     // max lines to read
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
}
```

The most-used tool. Returns file contents with line numbers prepended
(`1|import foo from 'bar';`). Handles binary files gracefully (returns a notice
instead of garbage). Supports partial reads with `offset` and `limit` for large
files.

### Write

```typescript
{
  name: "Write",
  description: "Create or overwrite a file",
  inputSchema: z.object({
    file_path: z.string(),
    content: z.string(),
    create_directories: z.boolean().optional(),
  }),
  isReadOnly: false,
  isConcurrencySafe: false,
}
```

Creates files or replaces their entire content. Can create parent directories
automatically. Used for new files; for modifying existing files, `Edit` is
preferred.

### Edit

```typescript
{
  name: "Edit",
  description: "Make surgical text replacements in a file",
  inputSchema: z.object({
    file_path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
  }),
  isReadOnly: false,
  isConcurrencySafe: false,
}
```

The precision file editing tool. Finds `old_string` in the file and replaces it
with `new_string`. The `old_string` must match exactly and uniquely—this prevents
accidental edits. Much safer than `Write` for modifying existing files because it
only changes the targeted section.

### NotebookEdit

```typescript
{
  name: "NotebookEdit",
  description: "Edit cells in a Jupyter notebook",
  inputSchema: z.object({
    notebook_path: z.string(),
    cell_index: z.number(),
    new_content: z.string(),
    cell_type: z.enum(["code", "markdown"]).optional(),
  }),
  isReadOnly: false,
  isConcurrencySafe: false,
}
```

Specialized tool for `.ipynb` files. Handles the JSON structure of notebook
files so the model doesn't have to think about cell boundaries, metadata,
or output sections.

## Search Tools

These tools find things in the codebase.

### Grep

```typescript
{
  name: "Grep",
  description: "Search file contents with regex patterns",
  inputSchema: z.object({
    pattern: z.string(),
    path: z.string().optional(),
    include: z.string().optional(),     // file glob filter
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
}
```

Powered by ripgrep under the hood—extremely fast regex search across entire
codebases. Returns matching lines with file paths and line numbers. The `include`
parameter lets the model search specific file types (e.g., `"*.ts"`).

### Glob

```typescript
{
  name: "Glob",
  description: "Find files matching a glob pattern",
  inputSchema: z.object({
    pattern: z.string(),
    path: z.string().optional(),
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
}
```

Finds files by name pattern. Used for discovering project structure, finding
specific files, and understanding what exists before reading or editing.

## Shell Tools

### Bash

```typescript
{
  name: "Bash",
  description: "Execute a bash command in the shell",
  inputSchema: z.object({
    command: z.string(),
    timeout: z.number().optional(),
    working_directory: z.string().optional(),
  }),
  isReadOnly: false,
  isConcurrencySafe: false,
}
```

The most powerful and most dangerous tool. Can run any shell command: build tools,
package managers, git, test runners, compilers, linters. Captures stdout and stderr.
Supports timeouts (default 120 seconds). Permission checks are strict here.

On Windows, this is replaced with **PowerShell**:

```typescript
{
  name: "PowerShell",
  description: "Execute a PowerShell command",
  inputSchema: z.object({
    command: z.string(),
    timeout: z.number().optional(),
  }),
}
```

## Web Tools

### WebFetch

```typescript
{
  name: "WebFetch",
  description: "Fetch content from a URL",
  inputSchema: z.object({
    url: z.string(),
    headers: z.record(z.string()).optional(),
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
}
```

Fetches web pages and returns their content as readable text (HTML is converted
to markdown). Useful for reading documentation, API references, and external
resources.

### WebSearch

```typescript
{
  name: "WebSearch",
  description: "Search the web for information",
  inputSchema: z.object({
    query: z.string(),
    num_results: z.number().optional(),
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
}
```

Performs web searches and returns summarized results with URLs. Used when the model
needs information beyond its training data or the local codebase.

### WebBrowser

```typescript
{
  name: "WebBrowser",
  description: "Browse a web page interactively",
  inputSchema: z.object({
    url: z.string(),
    action: z.enum(["navigate", "click", "type", "screenshot"]),
    selector: z.string().optional(),
    text: z.string().optional(),
  }),
  isReadOnly: false,
  isConcurrencySafe: false,
}
```

Full browser automation. Can navigate pages, interact with elements, fill forms,
and take screenshots. Used for testing web applications.

## Agent Tools

### Agent

```typescript
{
  name: "Agent",
  description: "Launch a sub-agent to handle a complex subtask",
  inputSchema: z.object({
    task: z.string(),
    tools: z.array(z.string()).optional(),
  }),
  isReadOnly: false,
  isConcurrencySafe: false,
}
```

Creates a child agent with its own conversation and tool access. The parent
agent delegates a subtask and receives the result. Used for parallelizing
complex work.

### SendMessage

```typescript
{
  name: "SendMessage",
  description: "Send a message to a peer agent",
  inputSchema: z.object({
    peer_id: z.string(),
    message: z.string(),
  }),
}
```

### ListPeers

```typescript
{
  name: "ListPeers",
  description: "List available peer agents",
  inputSchema: z.object({}),
  isReadOnly: true,
}
```

## Task Tools

These tools manage background tasks and structured work tracking.

### TodoWrite

```typescript
{
  name: "TodoWrite",
  description: "Create or update a structured task list",
  inputSchema: z.object({
    todos: z.array(z.object({
      id: z.string(),
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
    })),
    merge: z.boolean(),
  }),
}
```

Creates and maintains a visible task list. The model uses this to plan multi-step
work and show progress to the user.

### TaskCreate / TaskGet / TaskUpdate / TaskList / TaskOutput / TaskStop

```typescript
// TaskCreate — launch a background task
{
  name: "TaskCreate",
  inputSchema: z.object({
    description: z.string(),
    command: z.string(),
  }),
}

// TaskGet — check task status
{
  name: "TaskGet",
  inputSchema: z.object({ task_id: z.string() }),
  isReadOnly: true,
}

// TaskList — list all tasks
{
  name: "TaskList",
  inputSchema: z.object({}),
  isReadOnly: true,
}

// TaskOutput — get task output
{
  name: "TaskOutput",
  inputSchema: z.object({ task_id: z.string() }),
  isReadOnly: true,
}

// TaskStop — stop a running task
{
  name: "TaskStop",
  inputSchema: z.object({ task_id: z.string() }),
}
```

These enable long-running background work: start a build, check its progress,
read its output, stop it if needed.

## Planning Tools

### EnterPlanMode / ExitPlanMode

```typescript
{
  name: "EnterPlanMode",
  description: "Switch to collaborative planning mode",
  inputSchema: z.object({
    reason: z.string(),
  }),
}

{
  name: "ExitPlanMode",
  description: "Exit planning mode and return to execution",
  inputSchema: z.object({}),
}
```

Toggle between planning (read-only, discussion-focused) and execution modes.

## Utility Tools

### AskUserQuestion

```typescript
{
  name: "AskUserQuestion",
  description: "Ask the user a question and wait for their response",
  inputSchema: z.object({
    question: z.string(),
    options: z.array(z.string()).optional(),
  }),
}
```

Explicit user interaction. The model uses this when it needs clarification,
approval, or a decision from the user.

### Skill

```typescript
{
  name: "Skill",
  description: "Execute a predefined skill with specific instructions",
  inputSchema: z.object({
    skill_path: z.string(),
  }),
  isReadOnly: true,
}
```

### Brief

```typescript
{
  name: "Brief",
  description: "Toggle brief response mode on/off",
  inputSchema: z.object({
    enable: z.boolean(),
  }),
}
```

### Config

```typescript
{
  name: "Config",
  description: "Read or modify agent configuration",
  inputSchema: z.object({
    action: z.enum(["get", "set"]),
    key: z.string().optional(),
    value: z.unknown().optional(),
  }),
}
```

### Snip

```typescript
{
  name: "Snip",
  description: "Create a code snippet for reference",
  inputSchema: z.object({
    content: z.string(),
    language: z.string().optional(),
    title: z.string().optional(),
  }),
}
```

### TerminalCapture

```typescript
{
  name: "TerminalCapture",
  description: "Capture the current state of a terminal session",
  inputSchema: z.object({
    terminal_id: z.string().optional(),
  }),
  isReadOnly: true,
}
```

## MCP Tools

### ListMcpResources / ReadMcpResource

```typescript
{
  name: "ListMcpResources",
  description: "List resources from connected MCP servers",
  inputSchema: z.object({
    server: z.string().optional(),
  }),
  isReadOnly: true,
}

{
  name: "ReadMcpResource",
  description: "Read a specific MCP resource",
  inputSchema: z.object({
    uri: z.string(),
  }),
  isReadOnly: true,
}
```

Interface with external MCP (Model Context Protocol) servers to access
additional resources and data sources.

## Tool Usage Patterns

In practice, the model uses tools in characteristic patterns:

**Explore → Understand → Act → Verify**

```
1. Glob("src/**/*.ts")        — find relevant files
2. Read("src/index.ts")       — understand the code
3. Grep("handleRequest")      — find specific logic
4. Edit("src/index.ts", ...)  — make the change
5. Bash("npm test")           — verify it works
```

**Iterate on errors**

```
1. Edit("src/app.ts", ...)    — attempt a change
2. Bash("npm run build")      — build fails
3. Read("src/app.ts")         — re-read the file
4. Edit("src/app.ts", ...)    — fix the issue
5. Bash("npm run build")      — build succeeds
```

## Key Takeaways

1. 40+ tools organized into 8 categories cover the full development workflow
2. File tools (Read, Write, Edit) are the most frequently used
3. Search tools (Grep, Glob) power the model's ability to navigate code
4. Shell tools (Bash) provide the escape hatch for any operation
5. Web, Agent, Task, and Utility tools round out the capabilities
6. The model combines tools in patterns: explore → understand → act → verify

## What's Next

You've seen every built-in tool. Now let's build one from scratch. In the final
lesson, we'll create a custom tool step by step.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — The Explore-Understand-Act-Verify Pattern

**Question:** Describe the typical tool usage pattern and its four stages. Why does the model follow this pattern rather than jumping straight to writing code? Give a concrete example of the full cycle for the task "fix the broken import in App.tsx."

[View Answer](../../answers/03-tool-system/answer-34.md#exercise-1)

### Exercise 2 — Plan a Tool Sequence

**Challenge:** For the task *"Add a new API endpoint `/api/users/:id` that returns user data from the database"*, write the complete sequence of tool calls (name + input) an agent would make. Include at least 6 tool calls covering explore, understand, act, and verify stages.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-34.md#exercise-2)

### Exercise 3 — Classify 10 Tools

**Challenge:** For each tool below, state whether it's `isReadOnly: true` or `false`, whether it's `isConcurrencySafe: true` or `false`, and one sentence explaining why:
1. Read  2. Write  3. Grep  4. Bash  5. WebFetch
6. Edit  7. Glob  8. Agent  9. TodoWrite  10. WebSearch

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-34.md#exercise-3)

### Exercise 4 — Design Three New Tool Schemas

**Challenge:** Define Zod input schemas (with `.describe()` on every field) for three hypothetical new tools: (a) `GitDiff` — shows diff between two refs, (b) `JsonQuery` — extracts data from a JSON file using a JSONPath expression, (c) `ImageResize` — resizes an image file. Set appropriate `isReadOnly` and `isConcurrencySafe` flags for each.

Write your solution in your IDE first, then check:

[View Answer](../../answers/03-tool-system/answer-34.md#exercise-4)

---

*Module 03: The Tool System — Lesson 34 of 35*
