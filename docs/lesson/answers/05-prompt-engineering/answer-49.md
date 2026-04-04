# Answers: Lesson 49 — Tool Instructions

## Exercise 1
**Question:** Why do models default to Bash without tool instructions? List four problems this causes.

**Answer:** Models default to Bash because their training data is full of shell commands for every file operation — `cat` for reading, `sed` for editing, `grep` for searching. Shell is the universal tool in the training corpus. The four problems: (1) **No structured output** — `cat` returns raw text, but FileRead returns content with line numbers for precise referencing. (2) **No safety rails** — `sed -i` modifies files with no undo or validation, while FileEdit can verify exact matches before applying changes. (3) **No parallelism** — Shell commands execute sequentially in one terminal, but dedicated tool calls can run in parallel within a single API response, dramatically reducing round trips. (4) **Inconsistent formatting** — Shell output varies across platforms (GNU vs BSD tools), breaking cross-platform compatibility, while dedicated tools return consistently formatted results.

---

## Exercise 2
**Challenge:** Write a tool redirect table for a system prompt.

**Answer:**
```markdown
Instead of using Bash with these commands, use the dedicated tools:

| Instead of...              | Use...     | Why                         |
|---------------------------|------------|------------------------------|
| cat file.txt              | FileRead   | Structured output with line numbers |
| head -n 50 file.txt      | FileRead   | Line range support built in  |
| sed -i 's/old/new/' file | FileEdit   | Safe, validated replacements |
| echo "content" > file    | FileWrite  | Atomic file creation         |
| grep -r "pattern" src/   | Grep       | Structured, filterable results |
| find . -name "*.ts"      | Glob       | Fast, cross-platform file discovery |
| cat << 'EOF' > file      | FileWrite  | Clean, single-operation creation |
| awk '{...}' file          | FileEdit   | Precise, targeted replacements |
```
**Explanation:** Each row redirects a common shell pattern to a dedicated tool and explains the benefit. The "Why" column is essential — without it, the model might ignore the instruction when it seems more natural to use the shell.

---

## Exercise 3
**Question:** Give three parallelizable and three sequential tool call combinations.

**Answer:** **Parallelizable (independent operations):** (1) Reading `package.json`, `tsconfig.json`, and `README.md` simultaneously — none depends on the others. (2) Searching for `TODO` comments and `FIXME` comments in parallel — independent searches. (3) Running `npm test` and `npm run lint` at the same time — independent validation steps.

**Sequential (dependency chains):** (1) Read a file → Edit the file — you must know the current contents before you can specify what to replace. (2) Create a directory → Write a file in it — the directory must exist before you can create a file inside it. (3) Run `npm install` → Run `npm test` — tests depend on installed dependencies. The dependency in each case is that step 2 requires output or side effects from step 1 to succeed.

---

## Exercise 4
**Challenge:** Write a dynamic `getToolInstructions` function with conditional sections.

**Answer:**
```typescript
function getToolInstructions(availableTools: string[]): string {
  const tools = new Set(availableTools);
  const sections: string[] = [];

  sections.push(`## Using Your Tools

Follow these rules when using tools:
1. Always prefer dedicated tools over Bash commands.
2. Check that all required parameters are provided before calling.
3. If a tool call fails, read the error and fix the issue before retrying.
4. Do NOT fabricate tool results — only reference actual outputs.`);

  if (tools.has("FileRead")) {
    sections.push(`### File Reading
- Use FileRead to read files. Do NOT use Bash with cat, head, or tail.
- FileRead returns content with line numbers for precise referencing.
- You can specify line ranges to read portions of large files.`);
  }

  if (tools.has("FileEdit")) {
    sections.push(`### File Editing
- Use FileEdit to modify files. Do NOT use Bash with sed, awk, or echo.
- FileEdit uses search-and-replace: provide exact old text and new text.
- Always read a file before editing so you know the exact content to match.`);
  }

  if (tools.has("Grep")) {
    sections.push(`### Code Search
- Use Grep for searching file contents. Do NOT use Bash with grep or rg.
- Grep supports regex patterns and file type filters.
- Use Grep before making changes to find all locations that need updating.`);
  }

  if (tools.has("Bash")) {
    sections.push(`### Bash Usage
When Bash IS appropriate: tests, builds, git operations, installs.
When Bash is NOT appropriate: reading files, editing files, searching code.
NEVER run destructive commands without user confirmation.`);
  }

  return sections.join("\n\n");
}
```
**Explanation:** Each section is only included when its corresponding tool exists. This keeps the prompt lean — a read-only agent that can only search code doesn't need FileEdit instructions cluttering its context window.

---

## Exercise 5
**Question:** Explain three common mistakes in tool instructions, with examples and fixes.

**Answer:** (1) **Instructions without tools** — The prompt says "Use FileEdit to modify files" but FileEdit was never registered. The model will generate `tool_use` blocks for FileEdit, which fail because the tool doesn't exist. Fix: dynamically generate instructions based on the actual registered tool set, as shown in Exercise 4. (2) **Ambiguous overlap** — "Use FileEdit for small changes. Use FileWrite for large changes." What counts as "large"? The model must guess, leading to inconsistent tool choice. Fix: define clear, non-overlapping criteria: "Use FileEdit to modify existing files (search and replace). Use FileWrite to create new files that don't exist yet." (3) **Too many rules** — 50 specific tool rules compete for the model's limited attention. The model may ignore critical rules while following minor ones. Fix: prioritize the rules that prevent the most common mistakes (e.g., "Don't use cat to read files" is high-impact) and keep the total section concise — ideally under 500 tokens.
