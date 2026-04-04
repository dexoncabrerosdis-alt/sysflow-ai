# Lesson 11: What Is an Agent Loop?

Every AI coding agent — Claude Code, Cursor Agent, Devin, Aider, all of them — is built around the same fundamental pattern. It's deceptively simple, and once you see it, you'll recognize it everywhere.

## The Core Pattern

```
while (true) {
  think → act → observe
}
```

That's it. That's the entire architecture of an AI agent, reduced to its essence.

**Think**: The LLM receives the current conversation and decides what to do next.
**Act**: The agent executes whatever the LLM decided — run a tool, write a file, search code.
**Observe**: The result of that action gets added to the conversation.

Then the loop repeats. The LLM sees the new result, thinks again, acts again, observes again. Over and over until the task is done.

## Why It Must Be a Loop

Consider what happens when you ask Claude Code to "add input validation to the signup form." The agent can't do this in one shot. It needs to:

1. Find the signup form file
2. Read the file to understand the current code
3. Identify what fields need validation
4. Write the validation logic
5. Maybe check if there's an existing validation library in the project
6. Read the package.json to find out
7. Write the updated code
8. Possibly read related test files
9. Update the tests

That's at least 9 steps. Each step requires the LLM to see what happened in the previous step before deciding the next one. The LLM can't plan all 9 steps upfront because step 5 depends on what it found in step 2, and step 6 depends on what it decided in step 5.

This is why agents loop. Real tasks are **multi-step** and **adaptive** — each step depends on the results of previous steps.

## The Simplest Agent Loop

Here's the pattern expressed as real pseudocode:

```typescript
const messages = [{ role: "user", content: userTask }];

while (true) {
  // THINK: Ask the model what to do next
  const response = await callModel(messages);

  // Add the model's response to history
  messages.push({ role: "assistant", content: response });

  // Did the model use any tools?
  if (!response.hasToolUse) {
    // No tools means the model is done — it gave a final answer
    break;
  }

  // ACT: Execute whatever tools the model requested
  const results = await executeTools(response.toolUse);

  // OBSERVE: Feed the results back into the conversation
  messages.push({ role: "user", content: results });
}
```

Read this carefully. The model doesn't just answer — it **decides** whether to use a tool or give a final response. If it uses a tool, the loop continues. If it doesn't, the loop ends.

## When Does the Loop Stop?

There are exactly three categories of loop termination:

### 1. Task Complete
The model decides it has finished the task. It responds with a text message instead of a tool call. This is the happy path — the agent did its job and is done.

### 2. Error
Something goes wrong that can't be recovered from. The API returns an error, a tool crashes in an unrecoverable way, or the context window fills up.

### 3. Limit Reached
A safety boundary is hit. The loop has run too many iterations, the token budget is exhausted, or the user interrupts. Without limits, a confused agent could loop forever, burning money and accomplishing nothing.

In Claude Code, these are formalized into **terminal reasons** — an explicit enum that categorizes every possible way the loop can end. We'll cover these in detail in Lesson 17.

## It's Really Just a Conversation

Here's the mental model that makes everything click: an agent loop is just a **conversation** where one participant (the agent) can take actions in the real world between messages.

```
User:    "Add input validation to the signup form"
Agent:   [uses read_file tool on src/components/SignupForm.tsx]
System:  "Here are the contents of SignupForm.tsx: ..."
Agent:   [uses read_file tool on package.json]
System:  "Here are the contents of package.json: ..."
Agent:   [uses write_file tool to update SignupForm.tsx]
System:  "File written successfully"
Agent:   "I've added validation for the email, password, and name fields..."
```

Each "System" message is a tool result — the observation from an action. The agent keeps going until it has a final text response for the user.

Compare this to how a human developer works in a pair programming session:

```
PM:        "Add input validation to the signup form"
Developer: *opens the file browser, navigates to src/components/*
Developer: *opens SignupForm.tsx, reads through the code*
Developer: "I see, there's no validation at all. Let me check what libraries we have..."
Developer: *opens package.json*
Developer: "OK, we have zod already. I'll use that."
Developer: *writes validation schema and updates the form*
Developer: "Done — I added email format, password length, and required name validation."
```

The structure is identical. Think, act, observe, repeat. The agent loop is a formalization of how humans already work through multi-step problems.

## Tracing Through a Real Example

Let's trace through the loop with concrete data. Suppose the user says: "What's in my package.json?"

**Iteration 1:**
```
messages = [
  { role: "user", content: "What's in my package.json?" }
]

→ Model THINKS: "I need to read the file to answer this."
→ Response includes: tool_use { name: "read_file", input: { path: "package.json" } }
→ Has tool use? YES → continue loop

→ ACT: Execute read_file("package.json")
→ Result: '{ "name": "my-app", "version": "2.1.0", ... }'

→ OBSERVE: Append result to messages
messages = [
  { role: "user", content: "What's in my package.json?" },
  { role: "assistant", content: [tool_use block] },
  { role: "user", content: [tool_result with file contents] }
]
```

**Iteration 2:**
```
messages = [all three messages from above]

→ Model THINKS: "I have the file contents. I can answer now."
→ Response: "Your package.json defines a project called 'my-app' at version 2.1.0..."
→ Has tool use? NO → break out of loop

→ Return the final text response
```

Two iterations. The first gathered information, the second synthesized an answer. That's the loop doing its job.

Notice what happened between iterations: the model received the file contents as a tool result, understood them, and formulated a human-readable summary. The loop provided the infrastructure; the model provided the intelligence.

## The Loop Is the Intelligence Amplifier

Without the loop, an LLM is a one-shot question-answering system. It can only work with information that's already in its context. The loop changes everything:

- **Without loop**: "Fix the bug in auth.ts" → "I'd suggest checking the token validation logic..." (a guess, based on nothing)
- **With loop**: "Fix the bug in auth.ts" → reads the file → finds the bug → writes the fix → runs tests → confirms the fix works (actual work, based on real information)

The loop transforms an LLM from an advisor into an actor. It can gather information it doesn't have, take actions in the real world, and verify the results of those actions.

## Why Every Agent Has This Loop

You might wonder: is there another way? Could you build an agent without a loop?

You could have the LLM generate a complete plan upfront and execute it all at once. But this fails for the same reason waterfall project management fails — you can't plan everything before you start, because what you learn along the way changes the plan.

You could have the LLM make a single tool call and stop. But that's just a chatbot with function calling, not an agent. It can't handle multi-step tasks.

The loop is the minimal architecture that enables:
- **Multi-step reasoning**: doing things that require more than one action
- **Adaptive behavior**: changing plans based on what you discover
- **Error recovery**: retrying or trying a different approach when something fails
- **Progressive refinement**: improving output across multiple iterations

This is why the loop is universal. It's not a design choice — it's the only structure that produces agent behavior.

## Chatbot vs. Agent: The Loop Is the Difference

This distinction is worth making explicit because it's the most important boundary in AI engineering:

| Chatbot | Agent |
|---------|-------|
| Receives a message, sends a reply | Receives a task, works until it's done |
| One model call per interaction | Many model calls per interaction |
| No tools or single tool call | Multiple tools, used adaptively |
| Stateless or simple context | Rich state management across turns |
| User drives every step | Model drives its own execution |

The difference isn't the model, the tools, or the UI. The difference is the **loop**. Wrap an LLM in a loop with tools, and it becomes an agent. Without the loop, it's a chatbot — no matter how good the model is.

## What's Coming

In the next lesson, we'll build a real, working agent loop from scratch. Not pseudocode — actual TypeScript that calls a model, executes tools, manages conversation history, and solves a task through multiple iterations.

Then we'll progressively layer on the concepts that make Claude Code's loop sophisticated: async generators, streaming, state management, turn limits, and the full lifecycle of a single iteration.

But it all starts here, with the simplest idea in AI engineering:

```
while (true) {
  think → act → observe
}
```

---

**Key Takeaways**
- Every AI agent is built on a think → act → observe loop
- The loop exists because real tasks require multiple adaptive steps
- The loop stops when: the task is done, an error occurs, or a limit is hit
- The loop is fundamentally a conversation where one side can take real-world actions
- This pattern is universal — all agent frameworks share it

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook.

### Exercise 1 — Three Categories of Loop Termination
**Question:** Name the three categories that cause an agent loop to stop, and give a concrete example of each.

[View Answer](../../answers/02-the-agent-loop/answer-11.md#exercise-1)

### Exercise 2 — Chatbot vs. Agent
**Question:** A developer builds a system that takes a user message, calls an LLM once with a `read_file` tool, returns the result to the user, and waits for the next message. Is this a chatbot or an agent? Explain why, referencing the loop.

[View Answer](../../answers/02-the-agent-loop/answer-11.md#exercise-2)

### Exercise 3 — Trace the Loop
**Challenge:** Given the user prompt `"How many TypeScript files are in the src directory?"`, write out the full trace of an agent loop — show each iteration with the think, act, and observe phases. Assume the agent has `list_directory` and `read_file` tools. Show the `messages` array at each step.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-11.md#exercise-3)

### Exercise 4 — Why Not Plan Upfront?
**Question:** Explain why an agent can't generate a complete plan of all tool calls upfront and execute them in sequence. Use a concrete example to illustrate the problem.

[View Answer](../../answers/02-the-agent-loop/answer-11.md#exercise-4)

### Exercise 5 — Minimal Loop Pseudocode
**Challenge:** Without looking at the lesson, write the minimal agent loop in pseudocode (or TypeScript) from memory. It should include: message initialization, the while loop, the model call, the tool-use check, tool execution, and result appending.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-11.md#exercise-5)
