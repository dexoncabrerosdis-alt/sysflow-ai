# Answers: Lesson 07 — Request-Response vs Streaming

## Exercise 1

**Question:** What is the key difference between request-response and streaming when getting data from an LLM API?

**Answer:** With **request-response**, you send a prompt and wait for the complete answer to be generated before receiving anything back — you get the entire response all at once. With **streaming**, you receive the response token by token as the model generates it, so text appears in real time. The key difference is timing: request-response makes you wait for the full result, while streaming delivers incremental pieces immediately.

---

## Exercise 2

**Question:** Name and briefly explain two reasons why streaming is important for AI coding agents (beyond just user experience).

**Answer:** (1) **Early processing** — when the model begins streaming a `tool_use` block, the agent can start preparing to execute the tool (e.g., resolving file paths, checking permissions) before the full response is complete, making the agent faster. (2) **Error detection** — if something goes wrong during generation (nonsensical output, rate limits, connection issues), streaming lets the system detect and react immediately rather than waiting for the full response and discovering the problem too late.

---

## Exercise 3

**Question:** What is SSE (Server-Sent Events), and what does a `content_block_delta` event represent in the Anthropic streaming API?

**Answer:** SSE (Server-Sent Events) is a protocol where the server sends a series of text events over a persistent HTTP connection. Each event has a type and data payload. In the Anthropic streaming API, a `content_block_delta` event carries a small piece of the model's response — typically a few tokens of generated text. These delta events arrive one after another, and the client assembles them into the complete response.

---

## Exercise 4

**Challenge:** Modify the API call to enable streaming.

**Answer:**

```typescript
const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "Hello!" }],
  }),
});
```

**Explanation:** The only change needed is adding `stream: true` to the request body. This tells the API to return a stream of Server-Sent Events instead of a single JSON response. The response will then need to be consumed differently — using a stream reader to process events as they arrive, rather than calling `response.json()` for the full result.
