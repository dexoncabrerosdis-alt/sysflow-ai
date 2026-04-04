# Answers: Lesson 05 — What Is Tool Use?

## Exercise 1

**Question:** What is "tool use" and why is it the concept that transforms a chatbot into an agent?

**Answer:** Tool use (also called "function calling") is the ability for an LLM to output structured requests to call functions, rather than just generating text. The system running the model executes those functions and sends the results back. This transforms a chatbot into an agent because, without tools, the model can only *talk about* actions (like suggesting you read a file). With tools, the model can actually *perform* actions (like reading the file itself and getting the contents back).

---

## Exercise 2

**Question:** Describe the four steps of the tool use cycle in order. What happens at each step?

**Answer:** The four steps are: (1) **Model decides** — the model determines it needs to use a tool to accomplish the task; (2) **tool_use request** — the model outputs a structured JSON block specifying the tool name and input arguments; (3) **Execution** — the agent program receives the request and actually runs the function (e.g., reads a file from disk); (4) **tool_result** — the result of the execution is sent back to the model as a message, and the model continues with that new information.

---

## Exercise 3

**Question:** In the agent loop, how does the system decide whether to keep looping or stop? What signals "we're done"?

**Answer:** The system checks each response from the model for `tool_use` blocks. If the response contains one or more `tool_use` blocks, the system executes those tools, adds the results to the conversation, and calls the model again (keep looping). If the response contains only plain text with no `tool_use` blocks, that signals the model has finished its task, and the loop stops. The absence of tool calls is the "done" signal.

---

## Exercise 4

**Challenge:** Write a tool definition object (in TypeScript) for a tool called `list_files` that lists all files in a given directory. Include the `name`, `description`, and `input_schema` with a required `directory` property of type `string`.

**Answer:**

```typescript
const listFilesTool = {
  name: "list_files",
  description:
    "List all files and folders in the given directory. Use this to explore the project structure.",
  input_schema: {
    type: "object",
    properties: {
      directory: {
        type: "string",
        description: "The path of the directory to list",
      },
    },
    required: ["directory"],
  },
};
```

**Explanation:** The tool definition follows the same structure as the `calculator` example in the lesson. It has a `name` that the model uses to request the tool, a `description` that helps the model understand when to use it, and an `input_schema` that defines the expected input — in this case, a single required `directory` string. The `required` array ensures the model always provides a directory path.
