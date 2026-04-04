# Answers: Lesson 11 — What Is an Agent Loop?

## Exercise 1
**Question:** Name the three categories that cause an agent loop to stop, and give a concrete example of each.

**Answer:**
1. **Task Complete** — The model responds with a text message instead of a tool call, signaling it considers the work done. Example: after reading a file and writing a fix, the model says "I've updated the validation logic in SignupForm.tsx."
2. **Error** — An unrecoverable failure occurs. Example: the API returns a 500 error repeatedly, or the context window is completely full and compaction isn't possible.
3. **Limit Reached** — A safety boundary is hit. Example: the loop has run 100 iterations (hitting `maxTurns`), or the token budget is exhausted.

---

## Exercise 2
**Question:** A developer builds a system that takes a user message, calls an LLM once with a `read_file` tool, returns the result to the user, and waits for the next message. Is this a chatbot or an agent? Explain why, referencing the loop.

**Answer:** This is a chatbot, not an agent. The defining characteristic of an agent is the **loop** — the model drives its own execution across multiple iterations, deciding when to use tools and when to stop. In this system, there is exactly one model call per user message, and the model cannot chain multiple tool calls together adaptively. The model doesn't decide whether to continue — the system always stops after one tool call. An agent would let the model call `read_file`, see the result, decide it also needs to call `list_directory`, see that result, and only stop when it determines the task is complete. The loop is the difference, and this system has no loop.

---

## Exercise 3
**Challenge:** Given the user prompt `"How many TypeScript files are in the src directory?"`, write out the full trace of an agent loop.

**Answer:**
```
Iteration 1:
  messages = [
    { role: "user", content: "How many TypeScript files are in the src directory?" }
  ]

  THINK: Model receives messages, decides it needs to see directory contents.
  ACT:   Model responds with tool_use: list_directory({ path: "src" })
  OBSERVE: Tool returns: "[file] index.ts\n[file] utils.ts\n[dir] components\n[file] types.ts"

  messages = [
    { role: "user", content: "How many TypeScript files are in the src directory?" },
    { role: "assistant", content: [tool_use: list_directory({ path: "src" })] },
    { role: "user", content: [tool_result: "[file] index.ts\n[file] utils.ts\n[dir] components\n[file] types.ts"] }
  ]

  Has tool use? YES → continue

Iteration 2:
  THINK: Model sees there's a subdirectory "components" that might contain more .ts files.
  ACT:   Model responds with tool_use: list_directory({ path: "src/components" })
  OBSERVE: Tool returns: "[file] Button.tsx\n[file] Form.tsx"

  messages = [
    ...previous messages,
    { role: "assistant", content: [tool_use: list_directory({ path: "src/components" })] },
    { role: "user", content: [tool_result: "[file] Button.tsx\n[file] Form.tsx"] }
  ]

  Has tool use? YES → continue

Iteration 3:
  THINK: Model has seen all directories. Counts: index.ts, utils.ts, types.ts,
         Button.tsx, Form.tsx = 5 TypeScript files.
  ACT:   Model responds with text: "There are 5 TypeScript files in the src directory..."

  Has tool use? NO → break

  Return: "There are 5 TypeScript files in the src directory: index.ts, utils.ts,
           types.ts in src/, and Button.tsx, Form.tsx in src/components/."
```

**Explanation:** The model adapted its plan based on what it discovered. It didn't know about the `components` subdirectory until iteration 1 revealed it. This is why the loop exists — each step depends on the previous one's results.

---

## Exercise 4
**Question:** Explain why an agent can't generate a complete plan of all tool calls upfront and execute them in sequence.

**Answer:** An agent can't plan all steps upfront because real tasks are **adaptive** — each step depends on the results of previous steps. Consider the task "fix the authentication bug." The agent might plan to read `auth.ts`, but after reading it, it discovers the bug is actually in a helper function imported from `utils/token.ts`. It couldn't have known to read that file before seeing the import. Then after reading `token.ts`, it might discover the project uses a specific JWT library, requiring it to check `package.json` for the version. Each discovery changes the plan. This is the same reason waterfall project management fails — you learn things along the way that invalidate the original plan. The loop enables adaptive behavior; a fixed plan cannot.

---

## Exercise 5
**Challenge:** Without looking at the lesson, write the minimal agent loop in pseudocode from memory.

**Answer:**
```typescript
const messages = [{ role: "user", content: userTask }];

while (true) {
  // THINK: Ask the model what to do
  const response = await callModel(messages);

  // Add assistant's response to history
  messages.push({ role: "assistant", content: response });

  // Check: did the model use any tools?
  if (!response.hasToolUse) {
    break; // No tools = model is done
  }

  // ACT: Execute the requested tools
  const results = await executeTools(response.toolUse);

  // OBSERVE: Feed results back into conversation
  messages.push({ role: "user", content: results });
}
```

**Explanation:** The five essential parts are: (1) initialize messages with the user's task, (2) the `while (true)` loop, (3) calling the model with the full message history, (4) the tool-use check as the exit condition, and (5) executing tools and appending results. Everything else in a production agent loop is built on top of this skeleton.
