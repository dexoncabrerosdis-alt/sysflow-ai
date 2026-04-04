# Answers: Lesson 21 — What Are Tools?

## Exercise 1
**Question:** Describe the `tool_use` → `tool_result` cycle in your own words. What role does each participant (model, runtime) play, and why is `tool_use` **not** a traditional function call?

**Answer:** The model produces a `tool_use` content block containing a tool name, a unique ID, and structured JSON input — this is a *declaration of intent*, not an actual function invocation. The agent runtime receives this block, looks up the matching tool, validates the input, executes the function, and packages the output into a `tool_result` message sent back as a user message. The key distinction from a traditional function call is that the model has no direct access to code execution — it's generating structured text that conforms to a schema, and a separate process (the runtime) interprets and acts on it. The model never "runs" anything; it requests that something be run on its behalf.

---

## Exercise 2
**Challenge:** A user asks: *"Delete all `.log` files in my project."* Write the complete sequence of `tool_use` and `tool_result` JSON blocks (at least 2 turns) that an agent might produce.

**Answer:**

```json
// Turn 1 — Assistant response
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Let me find all .log files first." },
    {
      "type": "tool_use",
      "id": "toolu_01FIND_LOGS",
      "name": "Glob",
      "input": { "pattern": "**/*.log" }
    }
  ]
}

// Turn 2 — Runtime returns tool_result
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01FIND_LOGS",
      "content": "logs/app.log\nlogs/error.log\ntmp/debug.log"
    }
  ]
}

// Turn 3 — Assistant deletes the files
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Found 3 .log files. I'll delete them now." },
    {
      "type": "tool_use",
      "id": "toolu_02DELETE_LOGS",
      "name": "Bash",
      "input": { "command": "rm logs/app.log logs/error.log tmp/debug.log" }
    }
  ]
}

// Turn 4 — Runtime returns result
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_02DELETE_LOGS",
      "content": ""
    }
  ]
}

// Turn 5 — Assistant confirms
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Done! Deleted 3 .log files: app.log, error.log, and debug.log." }
  ]
}
```

**Explanation:** The agent follows an explore-then-act pattern: first Glob to discover files, then Bash to delete them. Each tool interaction is a separate `tool_use` → `tool_result` round trip. The model never touches the filesystem directly.

---

## Exercise 3
**Challenge:** Write a single assistant response with a text block and three `tool_use` blocks, then write the corresponding `tool_result` user message.

**Answer:**

```json
// Assistant response — 1 text + 3 tool_use blocks
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Let me search the codebase to understand the project structure." },
    {
      "type": "tool_use",
      "id": "toolu_A1",
      "name": "Grep",
      "input": { "pattern": "export default", "include": "*.tsx" }
    },
    {
      "type": "tool_use",
      "id": "toolu_A2",
      "name": "Read",
      "input": { "file_path": "/home/user/project/package.json" }
    },
    {
      "type": "tool_use",
      "id": "toolu_A3",
      "name": "Glob",
      "input": { "pattern": "src/**/*.ts" }
    }
  ]
}

// Corresponding tool_result user message — all three results
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_A1",
      "content": "src/App.tsx:5:export default function App() {\nsrc/Header.tsx:12:export default function Header() {"
    },
    {
      "type": "tool_result",
      "tool_use_id": "toolu_A2",
      "content": "{\n  \"name\": \"my-app\",\n  \"version\": \"1.0.0\"\n}"
    },
    {
      "type": "tool_result",
      "tool_use_id": "toolu_A3",
      "content": "src/index.ts\nsrc/utils.ts\nsrc/types.ts"
    }
  ]
}
```

**Explanation:** All three tool_use blocks share a single assistant message, and all three tool_result blocks share a single user message. The `tool_use_id` fields link each result to its corresponding request. The runtime decides whether to execute these in parallel or sequentially based on concurrency safety.

---

## Exercise 4
**Question:** Using the "chef and kitchen" analogy, explain what would happen if you removed the `Grep` tool from an agent. How would the agent's behavior change?

**Answer:** Removing Grep is like taking away the label maker from the kitchen — the chef can still open every drawer and read every label by hand, but finding a specific spice in a pantry of 500 jars becomes painfully slow. Without Grep, the agent would have to resort to reading files one at a time with the Read tool and scanning their contents manually, or guessing file locations based on naming conventions. For a large codebase, finding a function definition that Grep could locate in one call might take dozens of Read calls across many files. The agent would still be *capable* of finding things, but it would be far slower, more error-prone, and consume much more of the model's context window with unnecessary file contents. It's the difference between a targeted search and a brute-force scan.
