# Lesson 13: Async Generators

In Lesson 12, our agent loop was a function that ran silently and then returned a final string. You couldn't see anything happening along the way — no streaming, no progress updates, no intermediate results. Claude Code's loop is different: it **yields events as they happen**, letting the UI update in real time. The mechanism that makes this possible is the **async generator**.

## Regular Functions vs. Generators

A regular function runs to completion and returns one value:

```typescript
function getNumbers(): number[] {
  return [1, 2, 3, 4, 5];
}

const nums = getNumbers(); // Waits for ALL numbers, then returns the array
```

A generator function **yields** values one at a time, pausing between each:

```typescript
function* getNumbers(): Generator<number> {
  yield 1;
  yield 2;
  yield 3;
  yield 4;
  yield 5;
}

for (const num of getNumbers()) {
  console.log(num); // Prints each number as it's produced
}
```

The `function*` syntax and `yield` keyword are the markers of a generator. When you call a generator function, it doesn't execute the body immediately — it returns an **iterator** that you step through. Each `yield` pauses the function. Each step resumes it from where it paused.

## Why Generators Matter

The key insight is that generators **invert control**. Instead of a function deciding when to push data to a consumer, the consumer pulls data when it's ready:

```typescript
function* fibonacci(): Generator<number> {
  let a = 0, b = 1;
  while (true) {
    yield a;
    [a, b] = [b, a + b];
  }
}

// The consumer controls how many values to take
const fib = fibonacci();
console.log(fib.next().value); // 0
console.log(fib.next().value); // 1
console.log(fib.next().value); // 1
console.log(fib.next().value); // 2
```

The generator contains an infinite loop, but it never runs away — it only runs when the consumer asks for the next value.

## Async Generators

Regular generators yield values synchronously. But agent loops need to make API calls, read files, and wait for tool execution — all asynchronous operations. That's where **async generators** come in:

```typescript
async function* fetchPages(urls: string[]): AsyncGenerator<string> {
  for (const url of urls) {
    const response = await fetch(url);   // Async operation
    const text = await response.text();   // Another async operation
    yield text;                           // Yield the result
  }
}
```

An async generator combines two ideas:
- **async**: it can `await` promises inside the function body
- **generator**: it can `yield` values incrementally instead of returning all at once

## Consuming with `for await...of`

You consume async generators with `for await...of`:

```typescript
async function main() {
  for await (const page of fetchPages(["https://a.com", "https://b.com"])) {
    console.log(`Got page: ${page.slice(0, 50)}...`);
  }
}
```

Each iteration of the loop waits for the next yielded value. The generator runs until it hits a `yield`, the consumer receives that value, and then the generator is suspended until the consumer asks for the next one.

## The Agent Loop as an Async Generator

Remember our agent loop from Lesson 12? Here's what it looks like as an async generator:

```typescript
interface AgentEvent {
  type: "thinking" | "tool_call" | "tool_result" | "final_answer";
  data: unknown;
}

async function* agentLoop(userMessage: string): AsyncGenerator<AgentEvent> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  while (true) {
    yield { type: "thinking", data: "Calling model..." };

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      tools,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const text = response.content.find((b) => b.type === "text");
      yield { type: "final_answer", data: text?.text ?? "" };
      return; // Ends the generator
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    for (const toolUse of toolUseBlocks) {
      yield { type: "tool_call", data: { name: toolUse.name, input: toolUse.input } };

      const result = await executeTool(
        toolUse.name,
        toolUse.input as Record<string, string>
      );

      yield { type: "tool_result", data: { name: toolUse.name, result } };

      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: result }],
      });
    }
  }
}
```

Now any consumer can react to events as they happen:

```typescript
// CLI consumer: print events to terminal
async function runCLI(task: string) {
  for await (const event of agentLoop(task)) {
    switch (event.type) {
      case "thinking":
        console.log(`🤔 ${event.data}`);
        break;
      case "tool_call":
        console.log(`🔧 Using ${(event.data as any).name}`);
        break;
      case "tool_result":
        console.log(`✅ Got result`);
        break;
      case "final_answer":
        console.log(`\n${event.data}`);
        break;
    }
  }
}

// Web consumer: send events over WebSocket
async function runWeb(task: string, ws: WebSocket) {
  for await (const event of agentLoop(task)) {
    ws.send(JSON.stringify(event));
  }
}
```

The same agent loop serves both a CLI and a web interface — because the loop doesn't know or care who's consuming its events. It just yields them.

## yield vs. return in Generators

These two keywords serve different purposes:

```typescript
async function* example(): AsyncGenerator<number, string> {
  yield 1;    // Produces a value, pauses the generator
  yield 2;    // Produces another value, pauses again
  yield 3;    // And another
  return "done"; // Ends the generator with a final value
}
```

- `yield` produces an intermediate value. The generator can be resumed after yielding.
- `return` ends the generator. The return value is accessible via `.next()` but is **not** iterated by `for await...of`.

In Claude Code, the `query()` function signature makes this explicit:

```typescript
async function* query(params: QueryParams): AsyncGenerator<StreamEvent | Message, Terminal>
//                            Yielded types: ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^  ^^^^^^^^
//                                                                           Return type
```

It **yields** stream events and messages (the intermediate results visible to consumers), and **returns** a `Terminal` value (the reason the loop ended — which isn't an event, it's metadata).

## The Return Type Trick

Getting the return value of an async generator requires using the iterator protocol directly:

```typescript
async function consumeWithReturn() {
  const gen = query(params);
  let result = await gen.next();

  while (!result.done) {
    const event = result.value; // StreamEvent | Message
    processEvent(event);
    result = await gen.next();
  }

  const terminal = result.value; // Terminal — the return value
  console.log(`Loop ended: ${terminal.reason}`);
}
```

When `result.done` is `true`, `result.value` holds the return value, not a yielded value. Claude Code uses this to separate "events you can display" from "the final status of the loop."

## Why Async Generators Are Perfect for Agent Loops

The fit is natural for three reasons:

**1. Agents produce events over time.** An agent doesn't have a single result — it has a stream of thoughts, tool calls, results, and a final answer. Async generators model this exactly.

**2. Consumers vary.** The CLI shows colored text. The web UI renders components. The SDK collects messages. An async generator lets each consumer process the same event stream differently.

**3. Backpressure is free.** If a consumer is slow (say, writing to disk), the generator automatically waits. You don't need to buffer events or worry about overwhelming the consumer.

This is precisely why Claude Code's `queryLoop` is an async generator — it's the right primitive for "a long-running process that produces a stream of typed events."

---

**Key Takeaways**
- `function*` creates a generator; `async function*` creates an async generator
- `yield` produces a value and pauses; the consumer resumes the function when ready
- `for await...of` is the standard way to consume an async generator
- Async generators are perfect for agent loops: they produce events over time for any consumer
- Claude Code's `query()` yields stream events and returns a terminal reason
- The return value of a generator (accessed via `.next()`) is separate from its yielded values

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook.

### Exercise 1 — Generator vs. Regular Function
**Question:** Explain what happens when you call a generator function. How is it different from calling a regular function? What does the caller receive, and when does the function body actually execute?

[View Answer](../../answers/02-the-agent-loop/answer-13.md#exercise-1)

### Exercise 2 — Build a Countdown Generator
**Challenge:** Write an async generator function called `countdown(n: number)` that yields numbers from `n` down to 1, waiting 1 second between each yield. Then write a consumer that prints each number using `for await...of`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-13.md#exercise-2)

### Exercise 3 — yield vs. return
**Question:** In the `AsyncGenerator<StreamEvent | Message, Terminal>` type signature from Claude Code's `query()`, what is yielded and what is returned? How does a consumer access the return value — and why can't `for await...of` access it?

[View Answer](../../answers/02-the-agent-loop/answer-13.md#exercise-3)

### Exercise 4 — Event Stream Agent
**Challenge:** Convert the following regular async function into an async generator that yields typed events. It should yield `{ type: "start" }` before the fetch, `{ type: "progress", bytes: number }` as data arrives, and `{ type: "done", total: number }` at the end.

```typescript
async function downloadFile(url: string): Promise<string> {
  const response = await fetch(url);
  const text = await response.text();
  return text;
}
```

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-13.md#exercise-4)

### Exercise 5 — Extracting the Return Value
**Challenge:** Write a function `consumeWithReturn` that consumes an `AsyncGenerator<number, string>` — it should collect all yielded numbers into an array AND capture the final return value. Return both as `{ values: number[], result: string }`. You cannot use `for await...of`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-13.md#exercise-5)
