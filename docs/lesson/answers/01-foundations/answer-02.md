# Answers: Lesson 02 — Terminal and CLI Basics

## Exercise 1

**Question:** In your own words, what is a terminal? Why is it described as "text in, text out"?

**Answer:** A terminal is a text-based window where you type commands to tell your computer what to do. Instead of clicking buttons and icons, you type instructions as text and the computer responds with text. It's described as "text in, text out" because that's the entire interaction model: you type a text command (input), press Enter, and the computer prints a text response (output). There are no images, buttons, or graphical elements involved.

---

## Exercise 2

**Question:** What does CLI stand for, and how does using a CLI differ from using a graphical interface (like clicking buttons in an app)?

**Answer:** CLI stands for **Command-Line Interface**. With a CLI, you interact with a program by typing commands in the terminal (e.g., `git status` or `npm install`). With a graphical interface (GUI), you interact by clicking buttons, dragging items, and using menus. CLIs are text-based and require you to know the command names, while GUIs are visual and discoverable by exploring the interface.

---

## Exercise 3

**Question:** Explain the difference between a *command*, an *argument*, and *output* in the terminal. Give one example of each.

**Answer:** A **command** is the instruction you type to tell the computer what to do (e.g., `cd`). An **argument** is extra information you give to the command to tell it *what* to work on (e.g., `my-project` in `cd my-project`). **Output** is the text the computer sends back after running the command (e.g., when you run `node --version`, the output might be `v20.11.0`). In short: the command is the action, the argument is the target, and the output is the result.

---

## Exercise 4

**Question:** Why is the terminal described as the "perfect environment" for an AI agent? What do the terminal and an AI model have in common?

**Answer:** Both the terminal and an AI model operate on the same principle: text in, text out. The terminal accepts text commands and returns text results. An AI model accepts text prompts and generates text responses. This shared text-based interface makes them a natural fit — the AI agent can produce text (commands and code), the terminal can execute it, and the text output can be fed right back to the AI model. No translation between formats is needed.
