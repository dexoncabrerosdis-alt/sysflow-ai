# Answers: Lesson 38 — The Claude API Service

## Exercise 1
**Question:** Name five responsibilities that `queryModelWithStreaming()` handles so the agent loop doesn't have to. Why is centralizing these in one function important?

**Answer:** The five responsibilities are: (1) building API parameters from context (model, system prompt, tools, messages), (2) wrapping the call in retry logic for transient failures, (3) processing the SSE stream into usable content blocks, (4) tracking costs and token usage after each call, and (5) handling recording/replay for debugging via the streaming VCR. Centralizing these prevents duplication — without it, every call site would need its own retry logic, stream parsing, and cost tracking, leading to inconsistencies and bugs.

---

## Exercise 2
**Question:** In the service layer's stream processing, text deltas are yielded immediately while tool_use blocks wait for `content_block_stop`. Explain why these two content types are handled differently.

**Answer:** Text deltas are yielded immediately because the user can benefit from seeing text as it's generated — it provides real-time feedback that the agent is working. There's no need to wait for the complete text. Tool_use blocks, however, require the complete parsed JSON input before the tool can be executed. Since tool input arrives as partial JSON fragments (`input_json_delta`), attempting to execute a tool with incomplete JSON would fail. The service must accumulate all fragments and parse the full JSON on `content_block_stop` before yielding the tool call.

---

## Exercise 3
**Challenge:** Implement a `StreamingVCR` class with three modes: `record`, `replay`, and `off`.

**Answer:**
```typescript
interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

class StreamingVCR {
  private mode: "record" | "replay" | "off";
  private events: StreamEvent[] = [];

  constructor(mode: "record" | "replay" | "off", events: StreamEvent[] = []) {
    this.mode = mode;
    this.events = events;
  }

  async *record(
    stream: AsyncIterable<StreamEvent>
  ): AsyncGenerator<StreamEvent> {
    if (this.mode === "off") {
      yield* stream;
      return;
    }

    if (this.mode === "replay") {
      yield* this.replay();
      return;
    }

    this.events = [];
    for await (const event of stream) {
      this.events.push(event);
      yield event;
    }
  }

  async *replay(): AsyncGenerator<StreamEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  getRecordedEvents(): StreamEvent[] {
    return [...this.events];
  }

  toJSON(): string {
    return JSON.stringify(this.events);
  }

  static fromJSON(json: string): StreamingVCR {
    const events = JSON.parse(json) as StreamEvent[];
    return new StreamingVCR("replay", events);
  }
}
```
**Explanation:** In `record` mode, the VCR transparently captures every event while still yielding it to the consumer. In `replay` mode, it yields previously captured events without making an API call. The `fromJSON` static method allows loading recordings from disk for debugging.

---

## Exercise 4
**Challenge:** Write a `buildParams()` function that returns a properly structured API parameter object.

**Answer:**
```typescript
interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function buildParams(
  messages: Array<{ role: string; content: unknown }>,
  systemPrompt: string,
  tools: Tool[],
  model: string,
  maxTokens: number,
  enableCaching: boolean = false
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
    stream: true,
    betas: ["interleaved-thinking-2025-05-14"],
  };

  if (tools.length > 0) {
    params.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }

  if (enableCaching) {
    params.system = [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  return params;
}
```
**Explanation:** The function assembles all required API parameters and conditionally includes `tools` (only when tools exist) and cache breakpoints (only when caching is enabled). The `betas` array enables experimental features like interleaved thinking. When caching is enabled, the system prompt is converted from a string to a structured block with `cache_control`.
