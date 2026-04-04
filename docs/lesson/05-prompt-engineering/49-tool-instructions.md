# Lesson 49: Tool Instructions in the System Prompt

## The Gap Between "Has Tools" and "Uses Them Well"

In Module 03, you built a tool system with Zod schemas, execution handlers, and result formatting. You registered tools so the model *can* call them. But registration alone doesn't guarantee the model will use them *correctly*. That's what the tool instructions section solves.

The `getUsingYourToolsSection()` function generates prompt text that tells the model **how** to use its tools — which tool to pick for which task, what to avoid, and how to combine tools efficiently.

## The Problem: Models Take Shortcuts

Without explicit tool guidance, models default to the most general-purpose tool available — usually a shell/bash tool. Why? Because `bash` can do *everything*: read files, edit files, search code, run tests, install packages. The model learned this from training data full of shell commands.

```typescript
// Without tool instructions, the model does this:
// User: "Read the config file"
// Agent: Bash({ command: "cat config.json" })

// User: "Find all TODO comments"
// Agent: Bash({ command: "grep -r 'TODO' src/" })

// User: "Change the port to 8080"
// Agent: Bash({ command: "sed -i 's/3000/8080/' config.json" })
```

This is **wrong** for a coding agent. Here's why:

1. **No structured output** — `cat` returns raw text, FileRead returns structured content with line numbers
2. **No safety rails** — `sed -i` modifies files with no undo, FileEdit can validate changes
3. **No parallelism** — shell commands are sequential, dedicated tools can run in parallel
4. **Breaks caching** — tool results from dedicated tools are formatted consistently, enabling better context management

## The Tool Instructions Section

Here's what Claude Code's tool instructions look like:

```typescript
function getUsingYourToolsSection(
  availableTools: ToolDefinition[]
): string {
  const toolNames = availableTools.map(t => t.name);

  let section = `## Using Your Tools

You have access to a set of tools to help you complete tasks.
Follow these rules when using tools:

### General Tool Rules

1. ALWAYS prefer dedicated tools over Bash commands.
2. Check that all required parameters are provided
   before making a tool call.
3. If a tool call fails, read the error message carefully
   and fix the issue before retrying.
4. Do NOT fabricate tool calls or invent tool results.
   Only reference actual tool outputs.
`;

  if (toolNames.includes("FileRead")) {
    section += `
### File Reading
- Use FileRead to read files. Do NOT use Bash with
  cat, head, tail, or less.
- FileRead returns content with line numbers, making
  it easier to reference specific locations.
- You can specify line ranges to read portions of
  large files.
`;
  }

  if (toolNames.includes("FileEdit")) {
    section += `
### File Editing
- Use FileEdit to modify existing files. Do NOT use
  Bash with sed, awk, perl -i, or echo/cat with
  redirects to edit files.
- FileEdit uses a search-and-replace pattern: provide
  the old text and the new text.
- The old text must match EXACTLY — including
  whitespace and indentation.
- Always read a file before editing it, so you know
  the exact content to match.
`;
  }

  if (toolNames.includes("FileWrite")) {
    section += `
### File Creation
- Use FileWrite to create new files. Do NOT use Bash
  with heredoc (cat << 'EOF'), echo, or printf to
  create files.
- FileWrite takes a file path and the complete content.
- Prefer FileEdit for modifying existing files.
  Only use FileWrite for brand new files.
`;
  }

  if (toolNames.includes("Grep")) {
    section += `
### Code Search
- Use Grep for searching file contents. Do NOT use
  Bash with grep, rg, or ag.
- Grep supports regex patterns and file type filters.
- Use Grep before making changes to find all
  locations that need updating.
`;
  }

  if (toolNames.includes("Glob")) {
    section += `
### File Discovery
- Use Glob to find files by name patterns. Do NOT
  use Bash with find or ls -R.
- Glob supports standard glob patterns: *, **, ?, etc.
- Use Glob to discover project structure before
  diving into specific files.
`;
  }

  return section;
}
```

## The Command Mapping Table

At the core of tool instructions is a simple mapping: for each shell command a model might reach for, redirect it to the proper tool.

```typescript
const TOOL_REDIRECT_TABLE = `
Instead of using Bash with these commands, use the
dedicated tools:

| Instead of...        | Use...        | Why                    |
|----------------------|---------------|------------------------|
| cat file.txt         | FileRead      | Structured output      |
| head -n 20 file.txt  | FileRead      | Line range support     |
| sed -i 's/a/b/' f   | FileEdit      | Safe, reversible edits |
| echo "x" > file.txt  | FileWrite     | Atomic file creation   |
| grep -r "pattern"    | Grep          | Structured results     |
| find . -name "*.ts"  | Glob          | Fast file discovery    |
| cat << 'EOF' > f     | FileWrite     | Clean file creation    |
| awk '{...}' file     | FileEdit      | Precise replacements   |
`;
```

This table is included in the system prompt as plain text. The model reads it and adjusts its behavior accordingly.

## Parallel Tool Call Guidance

One of the most impactful tool instructions deals with **parallelism**. Models can issue multiple tool calls in a single response, but they need to be told when this is appropriate:

```typescript
const PARALLEL_TOOL_GUIDANCE = `
### Parallel Tool Calls

When you need to perform multiple INDEPENDENT operations,
issue them as parallel tool calls in a single response.

Examples of parallelizable operations:
- Reading multiple files at once
- Searching for different patterns simultaneously
- Running independent commands

Examples of NON-parallelizable operations:
- Reading a file, then editing it (edit depends on read)
- Creating a directory, then writing a file in it
- Running a build, then running tests on the output

GOOD (parallel — independent reads):
[tool_call: FileRead("src/auth.ts")]
[tool_call: FileRead("src/config.ts")]
[tool_call: FileRead("src/types.ts")]

BAD (sequential — should be parallel):
[tool_call: FileRead("src/auth.ts")]
// waits for result
[tool_call: FileRead("src/config.ts")]
// waits for result
[tool_call: FileRead("src/types.ts")]
`;
```

This guidance has real performance implications. Three parallel reads complete in one round trip; three sequential reads take three round trips. In a 20-step task, that's the difference between 20 and 60 API calls.

## Tool-Specific Behavioral Rules

Beyond the redirect table, certain tools need specific behavioral guidance:

```typescript
function getBashToolGuidance(): string {
  return `
### Bash Tool Usage

When Bash IS the right tool:
- Running tests: npm test, pytest, cargo test
- Installing dependencies: npm install, pip install
- Git operations: git status, git commit, git push
- Build commands: npm run build, make, cargo build
- Starting/stopping services

When Bash is NOT the right tool:
- Reading file contents (use FileRead)
- Editing files (use FileEdit)
- Searching code (use Grep)
- Finding files (use Glob)

Bash safety rules:
- NEVER run destructive commands without confirmation
  (rm -rf, DROP TABLE, format, etc.)
- NEVER pipe curl output to bash/sh
- Use --dry-run flags when available for risky operations
- Prefer non-interactive commands (avoid vim, nano, less)
`;
}
```

## How Tool Instructions Affect Model Behavior

Let's trace how these instructions change behavior in practice:

```typescript
// Without tool instructions:
// User: "Add error handling to the login function"
//
// Turn 1: Bash({ command: "cat src/auth.ts" })
// Turn 2: Bash({ command: "sed -i '42s/.*/  try {/' src/auth.ts" })
// Turn 3: Bash({ command: "sed -i '55a\\  } catch (e) { ... }' src/auth.ts" })
// Turn 4: Bash({ command: "cat src/auth.ts" })  // verify
//
// Problems: 4 turns, fragile sed commands, no structured editing

// With tool instructions:
// User: "Add error handling to the login function"
//
// Turn 1: FileRead({ path: "src/auth.ts" })     // read first
// Turn 2: FileEdit({                              // structured edit
//   path: "src/auth.ts",
//   old_text: "  const result = await db.query(sql);",
//   new_text: "  let result;\n  try {\n    result = await db.query(sql);\n  } catch (e) {\n    throw new AuthError('Login query failed', { cause: e });\n  }"
// })
//
// 2 turns, safe edit, clear intent
```

## Dynamic Tool Instructions

The tool instructions section adapts to what tools are actually available. If an agent is configured without Grep, the grep redirect instructions aren't included:

```typescript
function getUsingYourToolsSection(
  tools: ToolDefinition[]
): string {
  const sections: string[] = [getGeneralToolRules()];
  const names = new Set(tools.map(t => t.name));

  if (names.has("FileRead"))  sections.push(getFileReadGuidance());
  if (names.has("FileEdit"))  sections.push(getFileEditGuidance());
  if (names.has("FileWrite")) sections.push(getFileWriteGuidance());
  if (names.has("Grep"))      sections.push(getGrepGuidance());
  if (names.has("Glob"))      sections.push(getGlobGuidance());
  if (names.has("Bash"))      sections.push(getBashToolGuidance());

  sections.push(PARALLEL_TOOL_GUIDANCE);

  return sections.join("\n");
}
```

This conditional inclusion keeps the prompt lean. A read-only agent that can only search code doesn't need editing instructions cluttering its context.

## Testing Tool Instructions

Tool instructions are one of the most testable parts of a system prompt. You can verify them by checking model behavior on standardized inputs:

```typescript
describe("tool instruction effectiveness", () => {
  it("should use FileRead instead of cat", async () => {
    const response = await runAgent({
      systemPrompt: buildSystemPrompt(),
      userMessage: "Show me the contents of package.json",
    });

    const toolCalls = extractToolCalls(response);
    expect(toolCalls[0].name).toBe("FileRead");
    expect(toolCalls[0].name).not.toBe("Bash");
  });

  it("should parallelize independent reads", async () => {
    const response = await runAgent({
      systemPrompt: buildSystemPrompt(),
      userMessage: "Read both tsconfig.json and package.json",
    });

    const toolCalls = extractToolCalls(response);
    expect(toolCalls).toHaveLength(2);
    // Both should be in the same response (parallel)
    expect(toolCalls[0].name).toBe("FileRead");
    expect(toolCalls[1].name).toBe("FileRead");
  });
});
```

## Common Mistakes in Tool Instructions

### 1. Instructions Without Tools

```typescript
// Bug: referencing a tool that isn't registered
section += "Use FileEdit to modify files.";
// But FileEdit was never registered in the tool system
// The model will hallucinate tool calls that fail
```

### 2. Ambiguous Overlap

```typescript
// Which one should the model use?
"Use FileEdit for small changes."
"Use FileWrite for large changes."
// What counts as "large"? The model has to guess.

// Better:
"Use FileEdit to modify existing files (search and replace)."
"Use FileWrite to create new files that don't exist yet."
```

### 3. Too Many Rules

Models have finite attention. 50 specific tool rules compete with each other. Prioritize the rules that prevent the most common mistakes, and keep the total section concise.

## What's Next

You now understand how the identity section (Lesson 48) and tool instructions (this lesson) form the behavioral backbone of the system prompt. In Lesson 50, we'll examine the **static vs. dynamic split** in detail — why it exists, where the boundary falls, and how it enables prompt caching.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Why Models Default to Bash
**Question:** Without tool instructions, models tend to use the Bash/shell tool for everything — reading files, editing files, searching code. Explain why this happens and list four specific problems it causes in a coding agent.

[View Answer](../../answers/05-prompt-engineering/answer-49.md#exercise-1)

### Exercise 2 — Write a Tool Redirect Table
**Challenge:** Write a tool instructions section that maps at least 6 common shell commands to their dedicated tool equivalents. Format it as a markdown table suitable for inclusion in a system prompt, with columns for "Instead of...", "Use...", and "Why".

Write your solution in your IDE first, then check:

[View Answer](../../answers/05-prompt-engineering/answer-49.md#exercise-2)

### Exercise 3 — Parallel vs Sequential Tool Calls
**Question:** Give three examples of tool call combinations that should be parallelized and three that must be sequential. For each sequential example, explain the dependency that prevents parallelization.

[View Answer](../../answers/05-prompt-engineering/answer-49.md#exercise-3)

### Exercise 4 — Dynamic Tool Instructions
**Challenge:** Write a `getToolInstructions(availableTools: string[]): string` function that conditionally includes guidance sections only for tools that are actually registered. Include at least sections for FileRead, FileEdit, Grep, and Bash.

Write your solution in your IDE first, then check:

[View Answer](../../answers/05-prompt-engineering/answer-49.md#exercise-4)

### Exercise 5 — Common Mistakes in Tool Instructions
**Question:** The lesson lists three common mistakes in tool instructions: instructions without tools, ambiguous overlap, and too many rules. For each, explain why it degrades model behavior and give a concrete example of the problem and its fix.

[View Answer](../../answers/05-prompt-engineering/answer-49.md#exercise-5)
