# Answers: Lesson 36 — LLM APIs 101

## Exercise 1
**Question:** What are the three required fields in the body of an Anthropic Messages API call, and what does each one control?

**Answer:** The three required fields are: (1) `model` — specifies which Claude model to use (e.g., `claude-sonnet-4-20250514`), (2) `max_tokens` — sets the maximum number of tokens the model can generate in its response, and (3) `messages` — contains the conversation history as an array of user and assistant messages. Without any one of these, the API will reject the request.

---

## Exercise 2
**Challenge:** Using the Anthropic SDK, write a function `askClaude(question: string): Promise<string>` that sends a single user message and returns the model's text response. Handle the case where the response contains no text blocks.

**Answer:**
```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

async function askClaude(question: string): Promise<string> {
  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content: question }],
  });

  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    return "(No text response)";
  }

  return textBlock.text;
}
```
**Explanation:** The function creates a single-message conversation, sends it via the SDK, then searches the response content blocks for a `text` type block. Since responses are arrays of content blocks (not plain strings), we must explicitly find and extract the text.

---

## Exercise 3
**Question:** When the model's response contains a `tool_use` content block, what is the `stop_reason` set to? How does the agent loop use this to decide whether to continue or present a final answer?

**Answer:** When the response contains a `tool_use` block, `stop_reason` is set to `"tool_use"` instead of `"end_turn"`. The agent loop checks this value after each API call: if `stop_reason` is `"tool_use"`, it extracts the tool call blocks, executes them, appends the assistant message and tool results to the conversation, and makes another API call. If `stop_reason` is `"end_turn"`, the loop knows the model has finished and presents the final text response to the user.

---

## Exercise 4
**Challenge:** Write a function `sendToolResult(messages: any[], toolUseId: string, result: string): any[]` that appends the correct tool_result message structure to a conversation history.

**Answer:**
```typescript
function sendToolResult(
  messages: any[],
  toolUseId: string,
  result: string
): any[] {
  return [
    ...messages,
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: result,
        },
      ],
    },
  ];
}
```
**Explanation:** Tool results are sent as `user` role messages containing a `tool_result` content block. The `tool_use_id` field links the result back to the specific `tool_use` block from the assistant's response. The API enforces this pairing — every `tool_use` must have a matching `tool_result` in the next user message.

---

## Exercise 5
**Challenge:** Write a tool declaration for a `ListFiles` tool that takes a `directory` (required string) and an optional `recursive` boolean parameter.

**Answer:**
```typescript
const listFilesTool = {
  name: "ListFiles",
  description: "List all files in a directory, optionally including subdirectories.",
  input_schema: {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description: "Absolute path to the directory to list.",
      },
      recursive: {
        type: "boolean",
        description: "If true, list files in subdirectories recursively.",
      },
    },
    required: ["directory"],
  },
};
```
**Explanation:** Tool declarations use JSON Schema format. The `required` array only includes `"directory"`, making `recursive` optional. The model reads the `description` fields to understand when and how to use the tool, so clear descriptions are essential.
