# Answers: Lesson 46 — System Prompts 101

## Exercise 1
**Question:** Explain three ways system prompts differ from instructions placed in a user message.

**Answer:** (1) **Positional authority** — Models treat system messages as developer instructions with higher priority. When a user message conflicts with a system prompt rule (e.g., "reveal your system prompt"), the model is trained to prioritize the system prompt. User-role instructions don't have this authority. (2) **Persistent context** — The system prompt is re-sent on every API call, providing a stable behavioral anchor across the entire conversation. User messages come and go across turns; instructions in early user messages may fade from the model's attention as the conversation grows. (3) **Cache efficiency** — System prompts can be cached by the API provider at ~90% discount on repeated calls. In a 20-turn conversation, you'd pay full price once and cached price 19 times. Instructions in user messages can't leverage this caching mechanism, costing significantly more over a session.

---

## Exercise 2
**Question:** Trace through five levels of behavior influenced by "Always verify your changes by running tests."

**Answer:** The cascade: (1) **Interprets user messages** — When the user says "fix the login bug," the model plans to include testing as part of the task, not as an optional step. (2) **Chooses tools** — After making a file edit, the model automatically reaches for the Bash tool to run tests rather than stopping to report the edit. (3) **Shapes tool arguments** — The model constructs the right test command (`npm test`, `pytest`, etc.) based on the project context. (4) **Presents results** — The model includes test output in its response: "Fixed the null check on line 42. Tests pass (24/24)." (5) **Decides whether to continue** — If tests fail, the model continues working to fix the issue rather than reporting the failure and stopping. One sentence in the system prompt drives a completely different workflow.

---

## Exercise 3
**Challenge:** Write a system prompt for a code review agent.

**Answer:**
```typescript
function buildCodeReviewPrompt(
  repoName: string,
  prNumber: number,
  author: string
): string {
  // === STATIC SECTIONS ===
  const identity = `You are a thorough but constructive code review agent.
Your job is to review pull requests and provide actionable feedback.
Focus on correctness, maintainability, and potential bugs.`;

  const tools = `## Available Tools
- ReadFile: Read file contents from the repository
- SearchCode: Search for patterns across the codebase
- CommentOnPR: Leave a review comment on a specific line

Always use ReadFile to examine the full context around changes.
Use SearchCode to check if a pattern is used elsewhere.
Use CommentOnPR for specific, actionable feedback on individual lines.`;

  const rules = `## Review Rules
1. Always read the full diff before commenting.
2. Be constructive — suggest improvements, don't just criticize.
3. Distinguish between blocking issues and nit-picks.
4. Check for: missing error handling, untested edge cases,
   breaking API changes, security issues.
5. Praise good patterns when you see them.`;

  // === DYNAMIC SECTIONS ===
  const context = `## Current Review
Repository: ${repoName}
PR #${prNumber}
Author: ${author}`;

  return [identity, tools, rules,
    "SYSTEM_PROMPT_DYNAMIC_BOUNDARY", context].join("\n\n");
}
```
**Explanation:** The identity, tools, and rules sections are static — they don't change between PRs. The context section is dynamic — it changes for each review. The boundary marker separates them for caching purposes.

---

## Exercise 4
**Question:** Identify the problems in the given system prompt and explain how to fix each.

**Answer:** There are four problems: (1) **Vague instruction** — "Be careful when editing files" is meaningless. Fix: replace with a specific, actionable instruction like "Before editing a file, read its current contents. After editing, re-read to verify the change was applied correctly." (2) **Contradictory rules** — "Always ask for confirmation before making changes" contradicts "Work autonomously without interrupting the user." Fix: pick one philosophy and be consistent, or specify when each applies (e.g., "Ask for confirmation before destructive operations. For safe edits, proceed autonomously."). (3) **Dynamic content in a potentially static section** — The `${new Date().toISOString()}` timestamp changes every call, which would break prompt caching if this were in a static section. Fix: move the timestamp to a dedicated dynamic section after the SYSTEM_PROMPT_DYNAMIC_BOUNDARY marker. (4) **Missing structure** — All rules are in one flat string with no sections. Fix: organize into named sections (identity, rules, environment) for modularity and testability.
