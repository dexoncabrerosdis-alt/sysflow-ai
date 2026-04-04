# Answers: Lesson 03 — How LLMs Generate Text

## Exercise 1

**Question:** In one or two sentences, explain what an LLM is and what it fundamentally does.

**Answer:** An LLM (Large Language Model) is a text prediction machine that has been trained on enormous amounts of text data. Given some input text (a prompt), it predicts the most likely next piece of text, generating output one token at a time. This is the engine that powers the "thinking" part of an AI coding agent.

---

## Exercise 2

**Question:** What is a token, and why do tokens matter for AI agents? Give two reasons.

**Answer:** A token is a small chunk of text — sometimes a whole word, sometimes part of a word, sometimes a single character. Tokens matter for two key reasons: (1) **Cost** — LLM APIs charge per token, so more tokens means higher cost for every API call the agent makes; and (2) **Limits** — every model has a maximum context window measured in tokens, and everything the agent sends (conversation history, file contents, tool results) must fit within that limit.

---

## Exercise 3

**Question:** What does the temperature setting control when an LLM generates text? Why would a coding agent typically use a lower temperature?

**Answer:** Temperature controls how randomly the model selects from its predicted next-token probabilities. A temperature of 0 always picks the most likely token (deterministic output), while higher temperatures introduce more randomness and creativity. A coding agent typically benefits from lower temperature because you want reliable, consistent, and predictable code — not creative surprises that might introduce bugs or unexpected behavior.

---

## Exercise 4

**Question:** What is the context window, and why is managing it one of the biggest challenges in building an AI agent?

**Answer:** The context window is the maximum number of tokens a model can process in a single API call, including both the prompt (input) and the completion (output). Managing it is challenging because an agent accumulates a lot of context over time: the system instructions, the full conversation history, file contents it has read, and command outputs from tools it has run. All of this must fit within the window. If it exceeds the limit, the agent must summarize or drop older information, potentially losing important context.
