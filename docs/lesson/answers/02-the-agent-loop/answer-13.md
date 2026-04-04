# Answers: Lesson 13 — Async Generators

## Exercise 1
**Question:** Explain what happens when you call a generator function. How is it different from calling a regular function?

**Answer:** When you call a regular function, the function body executes immediately and returns a value. When you call a generator function (marked with `*`), the body does **not** execute — instead, you receive an **iterator object**. The function body only starts running when you call `.next()` on the iterator (or use `for...of`). Each call to `.next()` executes the body until it hits a `yield`, which pauses the function and returns the yielded value. The next `.next()` call resumes execution from exactly where it paused. This lazy execution model means generators only do work when the consumer requests the next value — the producer doesn't run ahead of the consumer.

---

## Exercise 2
**Challenge:** Write an async generator `countdown(n)` that yields numbers from `n` down to 1 with a 1-second delay.

**Answer:**
```typescript
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* countdown(n: number): AsyncGenerator<number> {
  for (let i = n; i >= 1; i--) {
    yield i;
    if (i > 1) {
      await sleep(1000);
    }
  }
}

// Consumer
async function main() {
  for await (const num of countdown(5)) {
    console.log(num); // Prints 5, 4, 3, 2, 1 with 1s gaps
  }
  console.log("Liftoff!");
}

main();
```

**Explanation:** The `async function*` syntax creates an async generator that can both `await` (for the sleep) and `yield` (for each number). The consumer's `for await...of` loop automatically waits for each yielded value. The sleep happens inside the generator — the consumer doesn't know or care about the timing; it just receives numbers as they're produced.

---

## Exercise 3
**Question:** In `AsyncGenerator<StreamEvent | Message, Terminal>`, what is yielded vs. returned? How does a consumer access the return value?

**Answer:** The first type parameter (`StreamEvent | Message`) is what gets **yielded** — these are the intermediate values produced during the loop's execution (streaming events and complete messages). The second type parameter (`Terminal`) is what gets **returned** when the generator finishes — this is the final status indicating why the loop ended.

`for await...of` cannot access the return value because it only iterates over yielded values; when the generator returns, the loop simply exits. To access the return value, you must use the **iterator protocol** directly:

```typescript
const gen = query(params);
let result = await gen.next();
while (!result.done) {
  processEvent(result.value); // StreamEvent | Message
  result = await gen.next();
}
const terminal = result.value; // Terminal — only available when done is true
```

When `result.done` is `true`, `result.value` contains the return value, not a yielded value. This separation lets Claude Code distinguish "events to display" from "why the loop ended."

---

## Exercise 4
**Challenge:** Convert a download function into an async generator that yields typed events.

**Answer:**
```typescript
type DownloadEvent =
  | { type: "start" }
  | { type: "progress"; bytes: number }
  | { type: "done"; total: number };

async function* downloadFile(url: string): AsyncGenerator<DownloadEvent> {
  yield { type: "start" };

  const response = await fetch(url);
  const reader = response.body!.getReader();
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    yield { type: "progress", bytes: totalBytes };
  }

  yield { type: "done", total: totalBytes };
}

// Consumer example
async function main() {
  for await (const event of downloadFile("https://example.com/data.json")) {
    switch (event.type) {
      case "start":
        console.log("Download started...");
        break;
      case "progress":
        console.log(`Downloaded ${event.bytes} bytes`);
        break;
      case "done":
        console.log(`Complete: ${event.total} bytes total`);
        break;
    }
  }
}
```

**Explanation:** The original function was a black box — the caller waited for the entire download to finish. The async generator version yields events at each stage, letting consumers render progress bars, log status, or cancel mid-download. This is the same pattern Claude Code uses: convert a long-running operation into a stream of typed events.

---

## Exercise 5
**Challenge:** Write `consumeWithReturn` that captures both yielded values and the return value.

**Answer:**
```typescript
async function consumeWithReturn(
  gen: AsyncGenerator<number, string>
): Promise<{ values: number[]; result: string }> {
  const values: number[] = [];
  let iterResult = await gen.next();

  while (!iterResult.done) {
    values.push(iterResult.value);
    iterResult = await gen.next();
  }

  // When done is true, value is the return type (string), not the yield type (number)
  const result: string = iterResult.value;

  return { values, result };
}

// Usage example:
async function* exampleGen(): AsyncGenerator<number, string> {
  yield 10;
  yield 20;
  yield 30;
  return "finished";
}

const output = await consumeWithReturn(exampleGen());
// output = { values: [10, 20, 30], result: "finished" }
```

**Explanation:** The key is using the `.next()` protocol instead of `for await...of`. Each call to `gen.next()` returns `{ done: boolean, value: ... }`. While `done` is `false`, `value` is the yielded type (`number`). When `done` is `true`, `value` is the return type (`string`). TypeScript's type narrowing on the `done` property correctly infers the value type in each branch. This is exactly how Claude Code's consumers capture the `Terminal` return value from `query()`.
