# Lesson 3: How LLMs Generate Text

## Introduction

In Lessons 1 and 2, you learned that an AI coding agent follows a Think → Act → Observe loop, and that it lives in the terminal where everything is text. But what actually powers the "thinking" part? What produces the text?

The answer is a **Large Language Model**, or **LLM**. In this lesson, you'll learn what an LLM is, how it generates text, and the key concepts you need to understand before we go deeper.

---

## What Is an LLM?

An **LLM** (Large Language Model) is a program that predicts the next piece of text given some input text.

That's it. At its core, it's a **text prediction machine**.

You give it some text:

```
Input:  "The capital of France is"
```

And it predicts what comes next:

```
Output: " Paris"
```

It does this by having been trained on enormous amounts of text from books, websites, and code. Through that training, it learned patterns — grammar, facts, logic, and even how to write code.

When we say "large," we mean it. These models have billions of **parameters** (the numbers inside the model that were adjusted during training). The more parameters and training data, the better the model tends to be at predicting useful text.

**Claude** — the model behind Claude Code — is an LLM made by Anthropic. When the agent needs to "think" about what to do next, it's actually asking Claude to predict the most useful next piece of text.

---

## Tokens: How LLMs See Text

You and I read text as words. LLMs read text as **tokens**.

A **token** is a small chunk of text — sometimes a whole word, sometimes part of a word, sometimes just a character.

Here's how a sentence might be split into tokens:

```
Sentence: "The function returns a value"

Tokens:   ["The", " function", " returns", " a", " value"]
```

Simple words usually become one token. Longer or unusual words get split:

```
Word:     "unbelievable"
Tokens:   ["un", "believ", "able"]
```

Code also gets tokenized:

```
Code:     "console.log('hello')"
Tokens:   ["console", ".", "log", "('", "hello", "')"]
```

### Why Does This Matter?

Tokens matter for two reasons:

1. **Cost**: LLM APIs charge per token. More tokens = more money.
2. **Limits**: Every model has a maximum number of tokens it can process at once (we'll cover this below).

A rough rule of thumb: **1 token ≈ 4 characters** in English, or about **¾ of a word**.

---

## The Prompt → Completion Flow

When you use an LLM, there's a simple two-step flow:

```
┌──────────┐         ┌──────────────┐
│  PROMPT  │────────▶│  COMPLETION  │
│ (input)  │         │  (output)    │
└──────────┘         └──────────────┘
```

- The **prompt** is the text you send to the model (your question, instruction, or context).
- The **completion** is the text the model generates in response.

For example:

```
Prompt:     "Write a Python function that adds two numbers"

Completion: "def add(a, b):
                return a + b"
```

The model doesn't "understand" your request the way a human does. It's predicting: *given this prompt, what text is most likely to come next?* Because it was trained on billions of examples of questions and answers, code and documentation, it predicts remarkably useful completions.

---

## Temperature: How Random Is the Output?

When the model predicts the next token, it doesn't just pick one — it calculates probabilities for *every possible* next token. **Temperature** controls how it chooses from those probabilities.

- **Temperature 0**: Always picks the most likely token. Output is deterministic (same input → same output).
- **Temperature 1**: Picks tokens proportionally to their probability. Output is creative and varied.
- **Values in between**: A sliding scale from "focused" to "creative."

```
Prompt: "Write a variable name for a user's email"

Temperature 0.0: "userEmail"    (always the same, most predictable)
Temperature 0.5: "emailAddress" (sometimes different)
Temperature 1.0: "mailbox_id"   (more creative, less predictable)
```

For coding agents, **lower temperatures** are usually better. You want reliable, consistent code — not creative surprises. Claude Code typically uses a temperature of **1** with specific sampling parameters that still produce focused output, because the model has been trained to be precise even at that setting.

---

## Context Window: How Much Can the Model "See"?

The **context window** is the maximum amount of text (measured in tokens) that the model can process in a single request. It includes *both* your prompt and the model's response.

Think of it like the model's "working memory":

```
┌──────────────────────────────────────────┐
│            CONTEXT WINDOW                │
│  ┌─────────────────┐ ┌────────────────┐  │
│  │    Your prompt   │ │ Model response │  │
│  │  (input tokens)  │ │(output tokens) │  │
│  └─────────────────┘ └────────────────┘  │
│                                          │
│  Total must fit within the window limit  │
└──────────────────────────────────────────┘
```

Different models have different context window sizes:

| Model             | Context Window   |
| ----------------- | ---------------- |
| GPT-3 (2020)      | ~4,000 tokens    |
| GPT-4 (2023)      | ~128,000 tokens  |
| Claude 3.5 (2024) | ~200,000 tokens  |

200,000 tokens is roughly **150,000 words**, or about **500 pages** of text. That's enough to fit entire codebases in a single prompt.

### Why This Matters for Agents

A coding agent needs to send a lot of context to the model:

- The system instructions ("you are a coding agent...")
- The conversation history (everything you've said so far)
- File contents the agent has read
- Command output from tools it has run

All of this has to fit inside the context window. If it doesn't fit, the agent has to **summarize** or **drop** older information. Managing the context window is one of the biggest challenges in building an agent.

---

## Code Example: Calling an LLM API

Here's what it looks like to call an LLM in code. This uses the Anthropic API (the company behind Claude):

```typescript
// Calling the Claude API to generate a completion
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": "your-api-key-here",
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: "Write a function that reverses a string in Python",
      },
    ],
  }),
});

const data = await response.json();
console.log(data.content[0].text);
// Output: "def reverse_string(s):\n    return s[::-1]"
```

Let's break this down:

- **`model`**: Which LLM to use
- **`max_tokens`**: Maximum number of tokens in the response (limits cost and length)
- **`messages`**: The conversation so far (we'll cover this in detail in the next lesson)
- **`content[0].text`**: The model's generated text

This is the fundamental building block. Every AI agent — including Claude Code — works by making API calls like this, getting text back, and deciding what to do with it.

---

## How Text Generation Actually Works (Simplified)

Here's a simplified view of what happens inside the model when it generates text:

```
Step 1: Model receives prompt tokens
        ["Write", " a", " function", " that", " adds", ...]

Step 2: Model predicts probability of every possible next token
        "def"  → 85% probability
        "Here" → 10% probability
        "The"  → 3% probability
        ...

Step 3: Model selects a token (influenced by temperature)
        Selected: "def"

Step 4: That token is added, and the model predicts the NEXT token
        [..., "def"] → predicts next token → " add" (90%)

Step 5: Repeat until done (hits max_tokens or a stop condition)
```

The model generates text **one token at a time**, always predicting the next token based on everything that came before it. This is why it's called an "auto-regressive" model — each prediction feeds into the next.

---

## Summary

- An **LLM** (Large Language Model) is a text prediction machine trained on enormous amounts of data.
- LLMs process text as **tokens** — small chunks of text (~4 characters each).
- The **prompt → completion** flow: you send text in, the model sends text back.
- **Temperature** controls how random/creative the output is (lower = more predictable).
- The **context window** is the maximum amount of text the model can process at once (e.g., 200K tokens for Claude).
- Agents make **API calls** to the LLM, sending prompts and receiving completions.
- Text is generated **one token at a time**, with each token depending on all previous tokens.

---

> **Key Takeaway**
>
> An LLM is not magic — it's a text prediction machine that generates output one token at a time. Understanding this helps you understand the agent's limitations: it can only "see" what fits in its context window, it generates text sequentially, and its quality depends on the prompt you give it.

---

---

## Practice Exercises

> **Remember**: Write your answers in your notebook first, then check below.

### Exercise 1 — What Is an LLM?
**Question:** In one or two sentences, explain what an LLM is and what it fundamentally does.

[View Answer](../../answers/01-foundations/answer-03.md#exercise-1)

### Exercise 2 — Tokens
**Question:** What is a token, and why do tokens matter for AI agents? Give two reasons.

[View Answer](../../answers/01-foundations/answer-03.md#exercise-2)

### Exercise 3 — Temperature
**Question:** What does the temperature setting control when an LLM generates text? Why would a coding agent typically use a lower temperature?

[View Answer](../../answers/01-foundations/answer-03.md#exercise-3)

### Exercise 4 — Context Window
**Question:** What is the context window, and why is managing it one of the biggest challenges in building an AI agent?

[View Answer](../../answers/01-foundations/answer-03.md#exercise-4)

---

*Next up: [Lesson 4 — Messages and Conversations](./04-messages-and-conversations.md), where you'll learn how conversations are structured as arrays of messages.*
