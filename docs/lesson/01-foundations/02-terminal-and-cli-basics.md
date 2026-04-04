# Lesson 2: Terminal and CLI Basics

## Introduction

In the previous lesson, you learned that an AI coding agent takes real actions on your computer. But *where* does it do this? Not in a browser. Not in a graphical app. It works in the **terminal**.

In this lesson, you'll learn what a terminal is, what a CLI is, and why the terminal is the perfect home for an AI agent.

---

## What Is a Terminal?

A **terminal** is a text-based window where you type commands to tell your computer what to do.

You're probably used to interacting with your computer through graphical interfaces — clicking buttons, dragging files, opening menus. The terminal is a different approach: instead of clicking, you **type**.

Here's what a terminal looks like:

```
C:\Users\you\projects> _
```

That blinking cursor is waiting for your command. You type something, press Enter, and the computer responds with text.

For example:

```
C:\Users\you\projects> echo "Hello, world!"
Hello, world!
```

You typed a command (`echo "Hello, world!"`), and the computer printed the result (`Hello, world!`).

That's the terminal in a nutshell: **you type text, the computer responds with text.**

---

## Why Does This Matter for AI Agents?

Here's the key insight: AI models work with text. They read text, they produce text. The terminal also works with text — commands are text in, results are text out.

This makes the terminal the **perfect environment** for an AI agent:

```
┌─────────────────────────┐
│       TERMINAL          │
│                         │
│  Text in ──▶ Text out   │
│                         │
└─────────────────────────┘
         ▲       │
         │       ▼
┌─────────────────────────┐
│       AI MODEL          │
│                         │
│  Text in ──▶ Text out   │
│                         │
└─────────────────────────┘
```

The AI agent reads text from the terminal (file contents, command output) and writes text back (commands to run, code to write). It's a natural fit.

---

## What Is a CLI?

**CLI** stands for **Command-Line Interface**. It's a program that you use by typing commands in the terminal (instead of clicking buttons in a window).

Some CLI tools you might have heard of:

| CLI Tool | What it does                |
| -------- | --------------------------- |
| `git`    | Manages code versions       |
| `npm`    | Installs JavaScript packages |
| `python` | Runs Python programs        |
| `node`   | Runs JavaScript programs    |
| `claude` | Runs the Claude Code agent  |

A CLI tool follows a simple pattern:

```
command [arguments] [options]
```

For example:

```bash
git status              # command with no arguments
npm install express     # command with argument "express"
python --version        # command with option "--version"
```

**Claude Code is a CLI tool.** You open your terminal, type `claude`, and the agent starts. That's it.

---

## Basic Terminal Concepts

Let's cover four concepts you'll see throughout this course.

### 1. Commands

A **command** is an instruction you type in the terminal. It tells the computer to do something.

```bash
echo "hello"      # Print "hello" to the screen
ls                # List files in the current folder (macOS/Linux)
dir               # List files in the current folder (Windows)
cd my-project     # Change into the "my-project" folder
```

### 2. Arguments

**Arguments** are extra pieces of information you give to a command. They tell the command *what* to work on.

```bash
cat readme.md          # "readme.md" is the argument — it's the file to read
mkdir new-folder       # "new-folder" is the argument — it's the folder name
node app.js            # "app.js" is the argument — it's the file to run
```

### 3. Working Directory

The **working directory** is the folder you're currently "in." When you run a command, it runs in that folder.

```bash
C:\Users\you\projects> dir
 my-app/
 notes.txt
 readme.md

C:\Users\you\projects> cd my-app

C:\Users\you\projects\my-app> dir
 index.html
 style.css
 app.js
```

When you typed `dir` the first time, it listed files in `projects`. After `cd my-app`, you moved into the `my-app` folder, so `dir` now shows different files.

Think of it like opening a folder on your desktop. The "working directory" is whichever folder you have open.

### 4. Output

**Output** is what the computer sends back after you run a command. It's the text that appears below your command.

```bash
C:\Users\you\projects> node --version
v20.11.0
```

Here, `v20.11.0` is the output. The computer is telling you which version of Node.js is installed.

Output can be short (one line) or long (hundreds of lines). When an AI agent runs a command, it reads this output to understand what happened.

---

## How the Terminal Fits Into the Agent Loop

Remember the **Think → Act → Observe** loop from Lesson 1? The terminal is where **Act** and **Observe** happen:

```
THINK:    "I should check if the tests pass."
   │
   ▼
ACT:      Runs `npm test` in the terminal
   │
   ▼
OBSERVE:  Reads the terminal output:
          "3 tests passed, 1 test failed: test_login"
   │
   ▼
THINK:    "The login test failed. Let me read that test file."
```

The terminal gives the agent a way to **do things** (run commands) and **see results** (read output). Without it, the agent would have no way to interact with your computer.

---

## A Quick Tour of Claude Code in the Terminal

Here's what it looks like when you start Claude Code:

```
C:\Users\you\my-project> claude

╭──────────────────────────────────────╮
│  Claude Code                         │
│  Type your request below.            │
╰──────────────────────────────────────╯

you> Fix the bug in src/login.ts
```

You type your request in plain English, just like chatting. But behind the scenes, Claude Code is using the terminal to:

1. Read your files
2. Search your codebase
3. Edit files
4. Run commands
5. Check results

All of this happens through text — the same text-based communication that the terminal was built for.

---

## Common Terminal Commands You'll See

Throughout this course, you'll see these commands referenced. You don't need to memorize them — just know they exist.

```bash
# Navigating
cd folder-name         # Move into a folder
cd ..                  # Move up one folder

# Looking at files
ls                     # List files (macOS/Linux)
dir                    # List files (Windows)
cat filename.txt       # Print a file's contents (macOS/Linux)
type filename.txt      # Print a file's contents (Windows)

# Running programs
node app.js            # Run a JavaScript file
python script.py       # Run a Python file
npm install            # Install JavaScript dependencies
npm test               # Run tests

# Other useful ones
echo "hello"           # Print text
pwd                    # Print current directory (macOS/Linux)
cd                     # Print current directory (Windows)
```

---

## The Terminal Is Just Text

Here's the one thing to remember from this lesson:

**The terminal is just text in, text out.**

This is why AI agents live in the terminal. The AI model produces text (commands, code), and the terminal consumes text. The terminal produces text (output, errors), and the AI model consumes text. It's a perfect match.

In the next lesson, we'll look at the AI model itself — how it generates the text that drives the agent.

---

## Summary

- A **terminal** is a text window where you type commands to control your computer.
- A **CLI** (Command-Line Interface) is a program you use by typing commands (like `git`, `npm`, or `claude`).
- Terminal commands have **arguments** (what to work on) and produce **output** (the result).
- The **working directory** is the folder you're currently in.
- AI agents live in the terminal because both the terminal and AI models work with **text**.
- **Claude Code** is a CLI tool — you start it by typing `claude` in your terminal.

---

> **Key Takeaway**
>
> The terminal is the bridge between the AI model and your computer. The model produces text (commands and code), the terminal executes it, and the output goes back to the model. This text-in-text-out pipeline is what makes AI coding agents possible.

---

---

## Practice Exercises

> **Remember**: Write your answers in your notebook first, then check below.

### Exercise 1 — Terminal Basics
**Question:** In your own words, what is a terminal? Why is it described as "text in, text out"?

[View Answer](../../answers/01-foundations/answer-02.md#exercise-1)

### Exercise 2 — CLI vs GUI
**Question:** What does CLI stand for, and how does using a CLI differ from using a graphical interface (like clicking buttons in an app)?

[View Answer](../../answers/01-foundations/answer-02.md#exercise-2)

### Exercise 3 — Terminal Concepts
**Question:** Explain the difference between a *command*, an *argument*, and *output* in the terminal. Give one example of each.

[View Answer](../../answers/01-foundations/answer-02.md#exercise-3)

### Exercise 4 — Why the Terminal for Agents?
**Question:** Why is the terminal described as the "perfect environment" for an AI agent? What do the terminal and an AI model have in common?

[View Answer](../../answers/01-foundations/answer-02.md#exercise-4)

---

*Next up: [Lesson 3 — How LLMs Generate Text](./03-how-llms-generate-text.md), where you'll learn how the AI brain behind the agent actually works.*
