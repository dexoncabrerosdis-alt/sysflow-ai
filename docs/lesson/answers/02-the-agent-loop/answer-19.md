# Answers: Lesson 19 — The QueryEngine

## Exercise 1
**Question:** Describe the three-layer architecture and explain why the boundary between QueryEngine and query() matters.

**Answer:**

**Layer 1 — Consumer (CLI / Web UI / SDK):** Owns user interaction and display. Submits messages, receives events, renders output. Knows nothing about conversation formatting, tool schemas, or loop mechanics. Examples: the terminal renderer, a React web app, a programmatic SDK script.

**Layer 2 — QueryEngine:** Owns session state and configuration. Maintains message history across multiple `submitMessage()` calls, builds `QueryParams` from its config, manages the `AbortController` for interruption, tracks file read state, and handles model selection. It translates "what the consumer wants" (send a message, get events) into "what the loop needs" (a fully populated QueryParams object).

**Layer 3 — query() / queryLoop():** Owns the execution loop. Manages the `while (true)`, state transitions, tool execution, streaming, compaction, terminal/continue decisions. It takes a `QueryParams` and yields events — it doesn't know whether a CLI or web UI is consuming them.

**Why the boundary matters:** The QueryEngine is the **API stability boundary**. If the loop internals change (new state fields, different compaction strategy, new terminal reasons, different streaming format), the QueryEngine absorbs those changes. The consumer API (`submitMessage`, `getMessages`, `interrupt`) stays the same. Without this boundary, every internal loop change would break every consumer. The QueryEngine is the adapter pattern — it decouples "how the loop works" from "how consumers use it."

---

## Exercise 2
**Challenge:** Implement a simplified `QueryEngine` class.

**Answer:**
```typescript
interface EngineConfig {
  model: string;
  systemPrompt: string;
  maxTurns: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

type EngineEvent =
  | { type: "thinking"; turn: number }
  | { type: "response"; text: string }
  | Message;

class QueryEngine {
  private config: EngineConfig;
  private messages: Message[] = [];
  private abortController: AbortController | null = null;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  async *submitMessage(userMessage: string): AsyncGenerator<EngineEvent> {
    this.messages.push({ role: "user", content: userMessage });
    this.abortController = new AbortController();

    let turns = 0;

    while (turns < this.config.maxTurns) {
      if (this.abortController.signal.aborted) {
        break;
      }

      turns++;
      yield { type: "thinking", turn: turns };

      // Simulate model call (in reality, this calls query() with built QueryParams)
      const response = await this.simulateModelCall();

      yield { type: "response", text: response };

      const assistantMsg: Message = { role: "assistant", content: response };
      this.messages.push(assistantMsg);
      yield assistantMsg;

      // Simulate: if response doesn't contain "[TOOL]", model is done
      if (!response.includes("[TOOL]")) {
        break;
      }
    }

    this.abortController = null;
  }

  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  getMessages(): Message[] {
    return [...this.messages]; // Return a copy
  }

  getModel(): string {
    return this.config.model;
  }

  setModel(model: string): void {
    this.config.model = model;
  }

  private async simulateModelCall(): Promise<string> {
    await new Promise((r) => setTimeout(r, 100));
    return "Simulated response";
  }
}

// Usage across multiple submitMessage calls:
const engine = new QueryEngine({
  model: "claude-sonnet-4-20250514",
  systemPrompt: "You are a helpful assistant.",
  maxTurns: 30,
});

// First interaction
for await (const event of engine.submitMessage("Hello")) {
  console.log(event);
}

// Second interaction — messages from first call are still in history
for await (const event of engine.submitMessage("Follow up question")) {
  console.log(event);
}

console.log(engine.getMessages().length); // Includes messages from BOTH calls
```

**Explanation:** The key behaviors: (1) `messages` persists between `submitMessage()` calls, enabling multi-turn conversations; (2) `getMessages()` returns a copy via spread, preventing external mutation; (3) `interrupt()` signals abort through the standard `AbortController` pattern; (4) `submitMessage()` is itself an async generator, wrapping the inner loop and yielding events.

---

## Exercise 3
**Question:** Why return copies from accessor methods?

**Answer:** Returning copies prevents consumers from accidentally (or intentionally) mutating the engine's internal state. Without copies, the engine's state integrity is broken.

**Concrete bug example:**
```typescript
// If getMessages() returned a reference:
const messages = engine.getMessages(); // Direct reference to internal array

// Consumer innocently filters for display
messages.splice(0, 5); // "Remove old messages for UI"

// Now the engine's internal message array is corrupted!
// The next submitMessage() call sends truncated history to the model.
// The model loses context from the first 5 messages and gives incoherent responses.
```

Another example: a consumer adds a message directly: `engine.getMessages().push({ role: "user", content: "injected" })`. If this is a reference, the engine now has a message it didn't put there — it's out of sync with its own bookkeeping (turn count, token tracking, etc.). By returning `[...this.messages]` (a shallow copy), the consumer gets a snapshot they can modify freely without affecting the engine. This is the defensive copying pattern — essential for any class that exposes internal collections.

---

## Exercise 4
**Challenge:** Demonstrate the full interrupt flow.

**Answer:**
```typescript
class InterruptDemo {
  private abortController: AbortController | null = null;

  async *submitMessage(msg: string): AsyncGenerator<string> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      for (let turn = 1; turn <= 100; turn++) {
        if (signal.aborted) {
          console.log(`[Engine] Abort detected at turn ${turn}`);
          return; // Generator ends cleanly
        }

        yield `Turn ${turn}: thinking...`;

        // Simulate a long API call that respects the abort signal
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        }).catch((e) => {
          if (e.name === "AbortError") {
            console.log(`[Engine] API call aborted mid-flight`);
            return;
          }
          throw e;
        });

        yield `Turn ${turn}: completed`;
      }
    } finally {
      this.abortController = null;
      console.log("[Engine] Cleanup complete");
    }
  }

  interrupt(): void {
    if (this.abortController) {
      console.log("[Engine] Interrupt requested");
      this.abortController.abort();
    }
  }
}

// Usage
async function main() {
  const engine = new InterruptDemo();

  // Set interrupt after 2.5 seconds
  setTimeout(() => engine.interrupt(), 2500);

  for await (const event of engine.submitMessage("Do a long task")) {
    console.log(`[Consumer] ${event}`);
  }

  console.log("[Consumer] Generator finished");
}

// Output:
// [Consumer] Turn 1: thinking...
// [Consumer] Turn 1: completed
// [Consumer] Turn 2: thinking...
// [Consumer] Turn 2: completed
// [Consumer] Turn 3: thinking...
// [Engine] Interrupt requested
// [Engine] API call aborted mid-flight
// [Engine] Cleanup complete
// [Consumer] Generator finished
```

**Explanation:** The interrupt flow is: (1) `interrupt()` calls `abort()` on the controller; (2) any in-flight promise listening on the signal rejects with `AbortError`; (3) the generator catches the error and returns cleanly; (4) the `finally` block runs cleanup; (5) the consumer's `for await...of` loop exits normally. No hanging promises, no orphaned operations.

---

## Exercise 5
**Question:** What happens to messages across three `submitMessage()` calls?

**Answer:**

```
Call 1: engine.submitMessage("What files are here?")
  messages BEFORE: []
  → Engine adds: { role: "user", content: "What files are here?" }
  → Loop runs: model calls list_directory, gets results, responds with text
  → Engine adds: assistant(tool_use), user(tool_result), assistant(text answer)
  messages AFTER: [user, assistant, user(tool), assistant] (4 messages)

Call 2: engine.submitMessage("Read the README")
  messages BEFORE: [user, assistant, user(tool), assistant] (4 from call 1)
  → Engine adds: { role: "user", content: "Read the README" }
  → Loop runs: model sees ALL 5 messages, calls read_file, responds
  → Engine adds: assistant(tool_use), user(tool_result), assistant(text)
  messages AFTER: 8 messages (4 from call 1 + 4 from call 2)

Call 3: engine.submitMessage("Summarize both")
  messages BEFORE: 8 messages (from calls 1 and 2)
  → Engine adds user message → model sees ALL 9 messages
  → Model can reference both previous interactions
  messages AFTER: 10+ messages
```

**Why persistence matters:** If messages reset between calls, the model would lose all context. In call 2, it wouldn't know which files exist (from call 1's directory listing). In call 3, it couldn't summarize "both" because it wouldn't remember what "both" refers to. Persistent messages enable **multi-turn conversations** — the defining feature that separates a stateful agent session from a series of disconnected one-shot queries. The engine accumulates a shared history so each new `submitMessage()` builds on everything that came before.
