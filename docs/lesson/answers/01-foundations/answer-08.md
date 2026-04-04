# Answers: Lesson 08 — What Makes a Good Agent?

## Exercise 1

**Question:** List all 7 qualities of a great AI agent from this lesson. For each one, write a single sentence describing what it means.

**Answer:**

1. **Reliability** — The agent handles errors gracefully, retries failed operations, and doesn't crash when unexpected things happen.
2. **Accuracy** — The agent reads before writing, follows existing code patterns, and validates that its changes are correct.
3. **Efficiency** — The agent minimizes API calls, uses parallel tool calls, and avoids redundant work to save time and cost.
4. **Safety** — The agent asks for permission before doing anything destructive and has guardrails to prevent harmful actions.
5. **Context Awareness** — The agent understands its environment (language, framework, project structure) before making decisions.
6. **Self-Correction** — The agent checks the results of its actions and fixes its own mistakes before declaring the task done.
7. **Transparency** — The agent shows its reasoning, displays what files it's reading/editing, and reports results honestly.

---

## Exercise 2

**Question:** Why does the lesson say "the orchestrator matters more than the model"? What does the orchestrator handle that the model cannot?

**Answer:** The model can only generate text and decide which tools to call — it's the "brain." But the orchestrator (the code wrapped around the model) handles everything else: retry logic for failed API calls, permission checks before dangerous operations, error recovery when tools fail, context window management, input validation with Zod, streaming UI rendering, and self-correction loops. Two agents using the same model can perform very differently because the orchestrator determines how reliably and safely the model's decisions are executed. A smart model with a bad orchestrator will make brilliant plans and then fail to execute them.

---

## Exercise 3

**Question:** A user asks an agent to "Add a login function to auth.ts." Describe how a *bad* agent would handle this vs how a *good* agent would handle it. Which qualities are demonstrated by the good agent?

**Answer:** A **bad agent** would immediately write a login function from scratch without reading the file first, potentially overwriting existing code, using the wrong import style, or breaking the file structure.

A **good agent** would: (1) Read `auth.ts` first to see existing code and patterns (**Accuracy**), (2) Check the project structure for related files like types or configs (**Context Awareness**), (3) Write a login function matching the existing style (**Accuracy**), (4) Explain what it's about to do (**Transparency**), (5) Run the linter or tests to verify (**Self-Correction**), and (6) Fix any issues that arise (**Reliability**). This demonstrates at least 5 of the 7 qualities working together.

---

## Exercise 4

**Challenge:** Write a TypeScript function `safeReadFile` that attempts to read a file, and if it fails, returns a helpful error message instead of crashing.

**Answer:**

```typescript
import * as fs from "fs/promises";

async function safeReadFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return `Error: File not found at "${filePath}". Check the path and try again.`;
    }
    if (err.code === "EACCES") {
      return `Error: Permission denied reading "${filePath}".`;
    }
    return `Error reading file "${filePath}": ${err.message}`;
  }
}
```

**Explanation:** This function wraps the file read in a try-catch block and returns user-friendly error messages for common failure cases (file not found, permission denied) instead of letting the program crash. This is exactly the kind of error handling a reliable agent orchestrator needs — the agent can read the error message and decide on a next step (like searching for the correct file path) rather than simply stopping.
