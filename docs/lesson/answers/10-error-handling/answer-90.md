# Answers: Lesson 90 — Streaming Errors

## Exercise 1
**Challenge:** Implement `createSyntheticToolResults()` for orphaned tool_use blocks.

**Answer:**
```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

interface ToolResultMessage {
  role: "user";
  content: {
    type: "tool_result";
    tool_use_id: string;
    content: string;
    is_error: true;
  }[];
}

function createSyntheticToolResults(
  partialResponse: ContentBlock[]
): ToolResultMessage[] {
  const orphanedToolUses = partialResponse.filter(
    (block): block is Extract<ContentBlock, { type: "tool_use" }> =>
      block.type === "tool_use"
  );

  if (orphanedToolUses.length === 0) return [];

  return orphanedToolUses.map((toolUse) => ({
    role: "user" as const,
    content: [
      {
        type: "tool_result" as const,
        tool_use_id: toolUse.id,
        content:
          `This tool call (${toolUse.name}) was not executed because the ` +
          "response was interrupted by a streaming error. The operation was " +
          "not performed. You may retry this tool call if still needed.",
        is_error: true as const,
      },
    ],
  }));
}

// Tests
function testSyntheticToolResults() {
  // Case 1: zero tool_use blocks
  const noTools: ContentBlock[] = [{ type: "text", text: "Just text." }];
  console.assert(createSyntheticToolResults(noTools).length === 0);

  // Case 2: one orphaned tool_use
  const oneOrphan: ContentBlock[] = [
    { type: "text", text: "Reading file..." },
    { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "foo.ts" } },
  ];
  const result1 = createSyntheticToolResults(oneOrphan);
  console.assert(result1.length === 1);
  console.assert(result1[0].content[0].tool_use_id === "toolu_1");
  console.assert(result1[0].content[0].is_error === true);

  // Case 3: three orphaned tool_use blocks
  const threeOrphans: ContentBlock[] = [
    { type: "tool_use", id: "toolu_a", name: "read_file", input: {} },
    { type: "text", text: "middle text" },
    { type: "tool_use", id: "toolu_b", name: "write_file", input: {} },
    { type: "tool_use", id: "toolu_c", name: "shell", input: {} },
  ];
  const result3 = createSyntheticToolResults(threeOrphans);
  console.assert(result3.length === 3);
  console.assert(result3[0].content[0].tool_use_id === "toolu_a");
  console.assert(result3[1].content[0].tool_use_id === "toolu_b");
  console.assert(result3[2].content[0].tool_use_id === "toolu_c");

  console.log("All synthetic tool result tests passed.");
}
```

**Explanation:** The function filters for `tool_use` blocks and creates one synthetic `tool_result` message per orphan. Each result clearly indicates the tool was not executed and suggests the model retry if needed. The `is_error: true` flag tells the model the result is an error, not a success.

---

## Exercise 2
**Challenge:** Build a stream error simulator and error handler.

**Answer:**
```typescript
interface StreamEvent {
  type: "content_block_start" | "content_block_delta" | "content_block_stop" | "message_stop";
  block?: ContentBlock;
  delta?: { type: string; text?: string };
}

class MockStream {
  private events: StreamEvent[];
  private errorAtIndex: number;

  constructor(events: StreamEvent[], errorAtIndex: number) {
    this.events = events;
    this.errorAtIndex = errorAtIndex;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    for (let i = 0; i < this.events.length; i++) {
      if (i === this.errorAtIndex) {
        throw new Error("Stream interrupted");
      }
      yield this.events[i];
    }
  }
}

class StreamErrorSimulator {
  async testErrorAtPoint(
    events: StreamEvent[],
    errorIndex: number
  ): Promise<{ valid: boolean; errors: string[] }> {
    const stream = new MockStream(events, errorIndex);
    const accumulatedBlocks: ContentBlock[] = [];
    const conversationMessages: any[] = [];

    try {
      for await (const event of stream) {
        if (event.type === "content_block_start" && event.block) {
          accumulatedBlocks.push(event.block);
        }
      }
    } catch {
      // Build assistant message with partial content
      conversationMessages.push({
        role: "assistant",
        content: accumulatedBlocks,
      });

      // Add synthetic tool results
      const synthetics = createSyntheticToolResults(accumulatedBlocks);
      conversationMessages.push(...synthetics);
    }

    return validateConversationState(conversationMessages);
  }

  async runRandomTests(events: StreamEvent[], iterations: number): Promise<void> {
    for (let i = 0; i < iterations; i++) {
      const errorIndex = Math.floor(Math.random() * events.length);
      const result = await this.testErrorAtPoint(events, errorIndex);
      if (!result.valid) {
        console.error(`Failed at index ${errorIndex}:`, result.errors);
      }
    }
  }
}

function validateConversationState(messages: any[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const pendingToolUses = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use") pendingToolUses.add(block.id);
      }
    }
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result") pendingToolUses.delete(block.tool_use_id);
      }
    }
  }

  if (pendingToolUses.size > 0) {
    errors.push(`Orphaned tool_use IDs: ${[...pendingToolUses].join(", ")}`);
  }

  return { valid: errors.length === 0, errors };
}
```

**Explanation:** The `MockStream` throws at a configurable index, simulating interruption at any point. The simulator accumulates content blocks, catches the error, and creates synthetic results. The validator confirms no orphaned tool_use blocks remain.

---

## Exercise 3
**Challenge:** Implement `StreamErrorBuffer` with auto-flush timeout.

**Answer:**
```typescript
interface WithheldStreamError {
  error: Error;
  partialResponse: ContentBlock[];
  withheldAt: number;
  resolved: boolean;
}

class StreamErrorBuffer {
  private withheld: WithheldStreamError[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private onFlushCallback?: (errors: WithheldStreamError[]) => void;

  constructor(private autoFlushTimeoutMs: number = 5000) {}

  onAutoFlush(callback: (errors: WithheldStreamError[]) => void): void {
    this.onFlushCallback = callback;
  }

  withhold(error: Error, partial: ContentBlock[]): number {
    const index = this.withheld.length;
    this.withheld.push({
      error,
      partialResponse: partial,
      withheldAt: Date.now(),
      resolved: false,
    });

    const timer = setTimeout(() => {
      const entry = this.withheld[index];
      if (entry && !entry.resolved) {
        const flushed = this.flush();
        if (flushed.length > 0 && this.onFlushCallback) {
          this.onFlushCallback(flushed);
        }
      }
    }, this.autoFlushTimeoutMs);

    this.timers.push(timer);
    return index;
  }

  resolve(index: number): void {
    if (this.withheld[index]) {
      this.withheld[index].resolved = true;
    }
    if (this.timers[index]) {
      clearTimeout(this.timers[index]);
    }
  }

  flush(): WithheldStreamError[] {
    const unresolved = this.withheld.filter((e) => !e.resolved);
    for (const timer of this.timers) clearTimeout(timer);
    this.withheld = [];
    this.timers = [];
    return unresolved;
  }

  destroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
  }
}
```

**Explanation:** Each withheld error starts a timer. If `resolve()` isn't called within the timeout, the timer fires and auto-flushes all unresolved errors through the registered callback. The `destroy()` method cleans up timers to prevent leaks.

---

## Exercise 4
**Challenge:** Write `validateConversationState()` with comprehensive checks.

**Answer:**
```typescript
interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validateConversationState(messages: any[]): ValidationResult {
  const errors: string[] = [];
  const pendingToolUses = new Map<string, number>(); // id → message index

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Check 2: role alternation (after first message)
    if (i > 0) {
      const prev = messages[i - 1];
      if (msg.role === prev.role && msg.role !== "user") {
        errors.push(`Messages ${i - 1} and ${i} have same role "${msg.role}" (non-user)`);
      }
    }

    // Track tool_use blocks
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        // Check 3: no empty content blocks
        if (block.type === "text" && block.text === "") {
          errors.push(`Message ${i} has empty text block`);
        }
        if (block.type === "tool_use") {
          pendingToolUses.set(block.id, i);
        }
      }
    }

    // Match tool_results to tool_uses
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          if (!pendingToolUses.has(block.tool_use_id)) {
            errors.push(`Message ${i} has tool_result for unknown tool_use_id "${block.tool_use_id}"`);
          } else {
            pendingToolUses.delete(block.tool_use_id);
          }
        }
      }
    }

    // Check 4: last message structure
    if (i === messages.length - 1) {
      if (!msg.role || !msg.content) {
        errors.push("Last message missing role or content");
      }
    }
  }

  // Check 1: all tool_uses have matching tool_results
  for (const [id, msgIndex] of pendingToolUses) {
    errors.push(`tool_use "${id}" in message ${msgIndex} has no matching tool_result`);
  }

  return { valid: errors.length === 0, errors };
}
```

**Explanation:** The validator tracks four invariants: tool_use/tool_result pairing (via a map), role alternation, non-empty content blocks, and valid structure on the last message. These are the minimum requirements for the Claude API to accept the conversation.

---

## Exercise 5
**Question:** Why are orphaned `tool_use` blocks dangerous?

**Answer:** Orphaned `tool_use` blocks violate the Claude API's message format contract, which requires every `tool_use` in an assistant message to have a corresponding `tool_result` in the following user message. If you try to send a follow-up message without the matching `tool_result`, the API returns a 400 Bad Request error, completely halting the agent loop. The synthetic result is marked `is_error: true` (rather than faking a success) because the tool was genuinely never executed — returning fake success data would cause the model to reason about nonexistent results, leading to cascading incorrect decisions that are far harder to debug than an honest error.
