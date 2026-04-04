# Answers: Lesson 04 — Messages and Conversations

## Exercise 1

**Question:** Name the three message roles in the chat format and describe who or what each role represents.

**Answer:** The three roles are: (1) **system** — represents the developer and sets the model's behavior, personality, and rules for the conversation; (2) **user** — represents the human who asks questions or gives instructions; and (3) **assistant** — represents the AI model and contains its responses. Together, these roles structure a conversation so the model knows who said what and how to behave.

---

## Exercise 2

**Question:** LLMs have "no memory between API calls." If that's true, how does a conversation with an AI model appear to have continuity? What is actually happening behind the scenes?

**Answer:** The model doesn't actually remember anything between API calls. Instead, the entire conversation history is re-sent with every new request. Each API call includes the full array of messages — every user question, every assistant response, every tool result — from the beginning of the conversation. The model reads this entire history fresh each time and generates its next response based on all of it. This is why the context window is so important: as the conversation grows, the message array takes up more and more space.

---

## Exercise 3

**Question:** What is the purpose of the system message, and why is it especially important for an AI coding agent like Claude Code?

**Answer:** The system message sets the ground rules for the entire conversation. It tells the model what it is, what it can do, and how it should behave. For an AI coding agent like Claude Code, the system message is critical because it defines the agent's identity ("you are a coding agent"), lists available tools, and establishes behavioral rules (like "always read a file before editing it" and "ask permission before running dangerous commands"). Without a well-crafted system message, the agent wouldn't know how to act as a reliable coding assistant.

---

## Exercise 4

**Question:** Two conversations ask the exact same question — "How do I read a file?" — but get different answers. Explain why message order affects the model's response.

**Answer:** The model reads messages in order from first to last, treating earlier messages as context for later ones. If earlier messages mention Python, the model will answer "How do I read a file?" with Python code. If earlier messages mention JavaScript, it will respond with JavaScript code. The same question produces different answers because the surrounding context changes the model's interpretation. This is important for agents because the message history — every file read, every command run — accumulates over time and influences all future responses.
