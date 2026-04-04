# Answers: Lesson 40 — Token Counting

## Exercise 1
**Challenge:** Write a function `estimateTokens` that estimates total token count using the 4-characters-per-token heuristic.

**Answer:**
```typescript
interface Message {
  role: string;
  content: Array<{ type: string; text?: string; name?: string; input?: unknown; content?: string }>;
}

function estimateTokens(messages: Message[], systemPrompt: string): number {
  let totalChars = systemPrompt.length;

  for (const message of messages) {
    for (const block of message.content) {
      switch (block.type) {
        case "text":
          totalChars += block.text?.length ?? 0;
          break;
        case "tool_use":
          totalChars += (block.name?.length ?? 0);
          totalChars += JSON.stringify(block.input).length;
          break;
        case "tool_result":
          totalChars += typeof block.content === "string"
            ? block.content.length
            : JSON.stringify(block.content).length;
          break;
      }
    }
  }

  const perMessageOverhead = messages.length * 4;
  return Math.ceil(totalChars / 4) + perMessageOverhead;
}
```
**Explanation:** Each content block type contributes differently to the character count. Tool inputs are serialized to JSON since that's how they're sent. The per-message overhead of 4 tokens accounts for role markers and formatting that the tokenizer adds. We divide total characters by 4 for the rough token estimate.

---

## Exercise 2
**Question:** Claude Code uses four token-ratio thresholds to decide what to do: OK, warn, compact, and block. What are the approximate ratio ranges for each, and why is the "block" threshold set below 100%?

**Answer:** The ranges are: OK (< 60% of context window), Warn (60-80%), Compact (80-95%), and Block (> 95%). The block threshold is set at 95% rather than 100% because token estimation is imprecise — the 4-characters-per-token heuristic can be off by 20%. If you allowed calls up to 100% of the estimated capacity, actual token counts could exceed the context window, resulting in a 400 error from the API and a wasted API call. The 5% buffer protects against estimation inaccuracy.

---

## Exercise 3
**Challenge:** Write a function `getEffectiveContextWindow` that returns the usable input token budget.

**Answer:**
```typescript
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-20250514": 200_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-haiku-3-20250307": 200_000,
};

function getEffectiveContextWindow(
  model: string,
  maxOutputTokens: number
): number {
  const contextWindow = MODEL_CONTEXT_WINDOWS[model] ?? 200_000;
  return contextWindow - maxOutputTokens;
}
```
**Explanation:** The total context window is shared between input and output tokens. If you set `max_tokens: 16384`, the model reserves that many tokens for its response, leaving the remainder for your input (system prompt + messages + tools). The effective input budget is simply the total window minus the output reservation.

---

## Exercise 4
**Question:** Why does Claude Code use a rough heuristic instead of the exact `count_tokens` endpoint? Give at least three reasons.

**Answer:** (1) **Latency** — the `count_tokens` endpoint takes 100-500ms per call, and a fast-moving agent loop making dozens of calls per session can't afford that overhead before every API call. (2) **Cost** — each count request is itself an API call that costs money, doubling the number of API requests. (3) **Speed of decision-making** — token counts are used for threshold decisions (compact vs. warn vs. block), not for exact billing. Being off by 20% doesn't change the outcome when comparing against a 200,000 token window. The heuristic trades precision for speed, and in this context, speed matters far more.

---

## Exercise 5
**Challenge:** Write a function that estimates tool definition token cost and demonstrate why tool partitioning matters.

**Answer:**
```typescript
interface ToolDef {
  name: string;
  description: string;
  input_schema: object;
}

function estimateToolTokens(tools: ToolDef[]): number {
  if (tools.length === 0) return 0;

  let totalChars = 0;
  for (const tool of tools) {
    totalChars += tool.name.length;
    totalChars += tool.description.length;
    totalChars += JSON.stringify(tool.input_schema).length;
  }

  return Math.ceil(totalChars / 4);
}

// Demonstration:
const allTools: ToolDef[] = [
  { name: "FileRead", description: "Read a file from disk and return contents with line numbers. Supports line ranges for large files.", input_schema: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] } },
  { name: "FileEdit", description: "Edit a file using search and replace.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  // ... imagine 18 more tools
];

// With 20 tools: ~5,000-10,000 tokens consumed just by definitions
// With 5 relevant tools: ~1,500-2,500 tokens
// Savings: 3,500-7,500 tokens per API call
```
**Explanation:** Tool definitions are serialized and sent with every API call. With 20+ tools, definitions alone can consume 5,000-10,000 tokens — a significant portion of the context window. Tool partitioning (only sending relevant tools) reduces this overhead substantially, leaving more room for conversation history and results.
