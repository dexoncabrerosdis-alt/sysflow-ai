# Answers: Lesson 14 — The Query Function

## Exercise 1
**Question:** Why does Claude Code split the agent loop into `query()` and `queryLoop()` instead of putting everything in one function?

**Answer:** The split separates one-time work from repeated work. `query()` handles things that happen exactly once: setup before the loop starts (initializing tracking arrays, preparing state) and cleanup after it ends (sending completion notifications, recording analytics metrics). `queryLoop()` contains the `while (true)` loop — the repeated work of calling the model, processing responses, executing tools, and managing state transitions. This separation makes each function easier to understand, test, and modify independently. If you need to change the notification logic, you only touch `query()`. If you need to change how tool execution works, you only touch `queryLoop()`. Without the split, loop logic and lifecycle logic would be interleaved in one large function.

---

## Exercise 2
**Challenge:** Write `inner()` and `outer()` demonstrating `yield*` delegation with return value capture.

**Answer:**
```typescript
async function* inner(): AsyncGenerator<number, string> {
  yield 1;
  yield 2;
  yield 3;
  return "done";
}

async function* outer(): AsyncGenerator<number, number> {
  // yield* forwards all yields from inner() and captures its return value
  const result: string = yield* inner();

  // result is "done" (length 4) — yield it as a final number
  yield result.length;

  return result.length;
}

// Consumer sees: 1, 2, 3, 4
async function main() {
  for await (const value of outer()) {
    console.log(value);
  }
}

main();
```

**Explanation:** `yield*` does two things simultaneously: (1) it forwards every yielded value from `inner()` through `outer()` to the consumer transparently, and (2) when `inner()` returns, the return value becomes the result of the `yield*` expression. The consumer never knows two generators are involved — they see a single stream: 1, 2, 3 from `inner()`, then 4 from `outer()`. This is exactly how `query()` delegates to `queryLoop()`.

---

## Exercise 3
**Question:** Why is `canUseTool` a function rather than a simple list of allowed tool names?

**Answer:** A function is more powerful because tool permissions can depend on **runtime context**, not just tool identity. Two scenarios where a simple list falls short:

1. **Conditional permissions based on state:** A tool like `write_file` might be allowed for files in the project directory but blocked for files outside it (e.g., system files). The function can inspect the tool's arguments: `canUseTool(tool) => tool.name === "write_file" && tool.input.path.startsWith(projectDir)`. A list can only say "write_file: yes/no" globally.

2. **Permissions that change mid-conversation:** After the user grants "trust this session" approval, previously blocked tools become allowed. A function reads the current permission state each time it's called. A static list would need to be rebuilt and re-injected into the params, which the loop doesn't support mid-execution.

---

## Exercise 4
**Challenge:** Build a mini `query()` / `queryLoop()` split.

**Answer:**
```typescript
type LoopEvent = string;
type Terminal = { reason: string };

async function* queryLoop(task: string): AsyncGenerator<LoopEvent, Terminal> {
  const steps = ["Reading files...", "Analyzing code...", "Writing fix..."];

  for (const step of steps) {
    yield step;
    await new Promise((r) => setTimeout(r, 100));
  }

  return { reason: "completed" };
}

async function* query(task: string): AsyncGenerator<LoopEvent, Terminal> {
  console.log("[query] Setup: initializing tracking");

  // Delegate all yields to queryLoop, capture its return value
  const terminal: Terminal = yield* queryLoop(task);

  // Post-loop cleanup
  console.log(`[query] Cleanup: loop ended with reason "${terminal.reason}"`);

  if (terminal.reason === "completed") {
    console.log("[query] Sending completion notification");
  }

  return terminal;
}

// Consumer
async function main() {
  const gen = query("Fix the auth bug");
  let result = await gen.next();

  while (!result.done) {
    console.log(`Event: ${result.value}`);
    result = await gen.next();
  }

  console.log(`Terminal: ${result.value.reason}`);
}

main();
// Output:
// [query] Setup: initializing tracking
// Event: Reading files...
// Event: Analyzing code...
// Event: Writing fix...
// [query] Cleanup: loop ended with reason "completed"
// [query] Sending completion notification
// Terminal: completed
```

**Explanation:** The consumer sees only the yielded events from `queryLoop()`, flowing transparently through `query()`. The setup runs before the first yield, and cleanup runs after `queryLoop()` returns. The terminal reason is both logged internally and returned to the consumer.

---

## Exercise 5
**Question:** Describe the behavior of `async function* process(config: Config): AsyncGenerator<Event | Log, Summary>`.

**Answer:** Without seeing the implementation, the type signature tells us: (1) `process` is a long-running async generator that takes a `Config` object to control its behavior. (2) During execution, it **yields** a stream of values that are either `Event` or `Log` objects — consumers receive these incrementally as the function runs, likely representing progress updates, status changes, or diagnostic information. (3) When the function finishes, it **returns** a `Summary` object — this is metadata about the overall execution (not an event to display), accessible only through the iterator protocol (`result.value` when `result.done === true`). A consumer using `for await...of` would see all the `Event | Log` values but would miss the `Summary`. To get both, they'd need to use `.next()` manually, just like Claude Code's consumers do with `Terminal`.
