# Answers: Lesson 01 — What Is an AI Coding Agent?

## Exercise 1

**Question:** What is the key difference between an AI chatbot (like ChatGPT in a browser) and an AI coding agent (like Claude Code)?

**Answer:** A chatbot can only *talk about* code — it generates text responses inside a chat window but cannot interact with your computer. An AI coding agent can *take real actions*: it reads files, writes code, runs terminal commands, and checks results on your actual system. The key difference is that an agent doesn't just tell you what to do — it does it.

---

## Exercise 2

**Question:** Name the three steps of the agent loop and briefly describe what happens at each step.

**Answer:** The three steps are **Think**, **Act**, and **Observe**. During the *Think* step, the agent reads the current context and decides what to do next. During the *Act* step, the agent takes an action like reading a file, writing code, or running a command. During the *Observe* step, the agent looks at the result of its action and decides whether to continue or if the task is complete. This loop repeats until the job is done.

---

## Exercise 3

**Question:** List at least three real-world actions that an AI coding agent can take on your computer that a chatbot cannot.

**Answer:** An AI coding agent can: (1) read files on your computer to understand existing code, (2) write and edit files to create or modify code, (3) run terminal commands like `npm install` or `python script.py`, and (4) search through your codebase for specific patterns. A chatbot cannot perform any of these actions because it is confined to a chat window with no access to your filesystem or terminal.

---

## Exercise 4

**Question:** Why is it important that an agent operates as a *loop* rather than giving a single response? Use the chef analogy from the lesson to explain.

**Answer:** Just like a chef doesn't prepare an entire meal in one step — they read the recipe, chop ingredients, cook, taste, and adjust repeatedly — an agent needs multiple steps to complete most tasks. A single response can only do one thing, but real coding tasks require reading files, understanding code, making edits, running tests, and fixing errors. The loop lets the agent build on each previous result, adapt to what it discovers, and recover from mistakes, just like a chef who tastes the food and adjusts the seasoning before serving.
