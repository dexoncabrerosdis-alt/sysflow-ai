# Lesson 1: What Is an AI Coding Agent?

## Introduction

Imagine you hired an assistant who could read your code, write new code, run commands on your computer, and fix bugs — all by following your instructions in plain English. That's an **AI coding agent**.

In this lesson, you'll learn what an AI coding agent is, how it's different from a chatbot like ChatGPT, and the simple pattern every agent follows.

---

## A Robot Assistant That Can Code

An AI coding agent is a program that:

1. **Understands** your instructions in plain English
2. **Takes actions** on your computer (reads files, writes code, runs commands)
3. **Checks the results** and decides what to do next

Think of it like this: a chatbot *talks* about code. An agent *writes* the code, saves it to a file, runs it, and checks if it works.

Here's a simple comparison:

| You say...                     | Chatbot does...              | Agent does...                              |
| ------------------------------ | ---------------------------- | ------------------------------------------ |
| "Create a hello world program" | Shows code in chat           | Creates the file, writes the code, saves it |
| "Fix the bug in app.js"       | Suggests a fix               | Opens app.js, reads it, edits it, saves it  |
| "Run my tests"                | Says "run `npm test`"        | Actually runs `npm test` and reads output   |

The key difference: **an agent doesn't just tell you what to do — it does it.**

---

## How Is This Different from ChatGPT?

If you've used ChatGPT, you know it can write code. But ChatGPT has a major limitation: it lives inside a chat window. It can't touch your files. It can't run your programs. It can only *talk*.

An AI coding agent is different because it has **tools** — abilities to interact with the real world:

- **Read files** on your computer
- **Write and edit files** on your computer
- **Run terminal commands** (like `npm install` or `python script.py`)
- **Search through your codebase** for specific patterns

A chatbot is like a consultant who gives advice over the phone. An agent is like a contractor who shows up at your house with tools and does the work.

---

## The 3 Things Every Agent Does

Every AI coding agent follows the same simple pattern. We call it the **Think → Act → Observe** loop:

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│          │     │          │     │          │
│  THINK   │────▶│   ACT    │────▶│ OBSERVE  │
│          │     │          │     │          │
└──────────┘     └──────────┘     └──────────┘
      ▲                                 │
      │                                 │
      └─────────────────────────────────┘
              (repeat until done)
```

### Step 1: Think

The agent reads your instruction and its current context (files it has seen, previous results) and decides what to do next.

> "The user wants me to fix a bug in `app.js`. I should read that file first."

### Step 2: Act

The agent takes an action — like reading a file, writing code, or running a command.

> *Reads `app.js` and sees the contents...*

### Step 3: Observe

The agent looks at the result of its action and decides what to do next.

> "I see the bug on line 42. There's a typo in the variable name. I'll fix it."

Then the loop repeats: **Think** (decide to edit the file) → **Act** (make the edit) → **Observe** (confirm the edit was saved). This continues until the task is done.

---

## The Chef Analogy

Here's an analogy that makes this concrete.

Imagine a chef in a kitchen:

1. **Think**: The chef reads a recipe and plans the next step. *"I need to chop the onions."*
2. **Act**: The chef picks up a knife and chops the onions.
3. **Observe**: The chef looks at the onions. *"Those are chopped nicely. Now I need to heat the pan."*

The chef keeps going — reading the recipe, cooking, tasting, adjusting — until the dish is done.

An AI coding agent works the same way:

| Chef                        | AI Coding Agent                          |
| --------------------------- | ---------------------------------------- |
| Reads a recipe              | Reads your instruction                   |
| Chops vegetables            | Reads/writes files                       |
| Tastes the food             | Runs code and checks the output          |
| Adjusts seasoning           | Fixes errors and tries again             |
| Serves the dish             | Tells you the task is complete            |

The big idea: **an agent is a loop, not a single response.** It keeps going until the job is done.

---

## Meet Claude Code

**Claude Code** is an AI coding agent made by [Anthropic](https://anthropic.com). It's one of many agents out there, but it's the one we'll study throughout this course.

Here's what makes Claude Code interesting:

- It runs **in your terminal** (we'll learn about terminals in the next lesson)
- It's powered by **Claude**, a large language model (we'll learn about those in Lesson 3)
- It can **read, write, and search** your code files
- It can **run commands** on your computer
- It has a **permission system** so it asks before doing anything dangerous
- It's built with **TypeScript** and open-source tools

You don't need to install Claude Code right now. In this module, we'll focus on understanding *how* it works under the hood. By the end, you'll build your own tiny version.

---

## A Day in the Life of an Agent

Here's a realistic example of what it looks like to use an AI coding agent:

```
You:    "Add a dark mode toggle to the settings page"

Agent:  [THINK] I need to find the settings page component first.
        [ACT]   Searches for "settings" in the codebase
        [OBSERVE] Found: src/pages/Settings.tsx

        [THINK] Let me read this file to understand its structure.
        [ACT]   Reads src/pages/Settings.tsx
        [OBSERVE] It's a React component with a form. No dark mode yet.

        [THINK] I need to add a toggle switch and connect it to a theme context.
        [ACT]   Edits src/pages/Settings.tsx — adds a toggle component
        [OBSERVE] File saved successfully.

        [THINK] I should also update the CSS for dark mode styles.
        [ACT]   Edits src/styles/theme.css — adds dark mode variables
        [OBSERVE] File saved successfully.

        [THINK] Let me verify everything works by running the dev server.
        [ACT]   Runs `npm run dev`
        [OBSERVE] Server started, no errors.

Agent:  "Done! I added a dark mode toggle to Settings.tsx and updated
         the theme styles. The dev server is running with no errors."
```

Notice the pattern: every step is **Think → Act → Observe**, repeated until the job is done.

---

## What You'll Learn in This Module

This is the first lesson in a module called **Foundations**. Here's what's coming:

| Lesson | Topic                              |
| ------ | ---------------------------------- |
| 1      | What is an AI coding agent (this!) |
| 2      | Terminal and CLI basics            |
| 3      | How LLMs generate text             |
| 4      | Messages and conversations         |
| 5      | What is tool use                   |
| 6      | JSON communication                 |
| 7      | Request-response vs streaming      |
| 8      | What makes a good agent            |
| 9      | Claude Code architecture overview  |
| 10     | Build your first tiny agent        |

By the end of this module, you'll understand every layer of how an AI coding agent works — from the text generation engine to the tool system to the architecture of a real-world agent.

---

## Summary

- An **AI coding agent** is a program that reads your instructions and takes real actions on your computer (reading files, writing code, running commands).
- It's different from a chatbot because it **does things**, not just talks about them.
- Every agent follows the **Think → Act → Observe** loop, repeating until the task is done.
- **Claude Code** is an AI coding agent made by Anthropic that runs in your terminal.

---

> **Key Takeaway**
>
> An AI coding agent is not magic — it's a loop. The agent reads your instruction, takes an action, checks the result, and repeats. That's it. Every advanced feature you'll learn about in this course is built on top of this simple loop.

---

---

## Practice Exercises

> **Remember**: Write your answers in your notebook first, then check below.

### Exercise 1 — Agent vs Chatbot
**Question:** What is the key difference between an AI chatbot (like ChatGPT in a browser) and an AI coding agent (like Claude Code)?

[View Answer](../../answers/01-foundations/answer-01.md#exercise-1)

### Exercise 2 — The Agent Loop
**Question:** Name the three steps of the agent loop and briefly describe what happens at each step.

[View Answer](../../answers/01-foundations/answer-01.md#exercise-2)

### Exercise 3 — Agent Tools
**Question:** List at least three real-world actions that an AI coding agent can take on your computer that a chatbot cannot.

[View Answer](../../answers/01-foundations/answer-01.md#exercise-3)

### Exercise 4 — Loop, Not a Single Response
**Question:** Why is it important that an agent operates as a *loop* rather than giving a single response? Use the chef analogy from the lesson to explain.

[View Answer](../../answers/01-foundations/answer-01.md#exercise-4)

---

*Next up: [Lesson 2 — Terminal and CLI Basics](./02-terminal-and-cli-basics.md), where you'll learn about the environment agents live in.*
