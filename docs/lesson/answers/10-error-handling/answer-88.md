# Answers: Lesson 88 — Max Output Token Recovery

## Exercise 1
**Challenge:** Implement `handleTruncatedResponse` with escalation and continuation strategies.

**Answer:**
```typescript
interface ModelResponse {
  content: ContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "tool_use";
  usage: { input_tokens: number; output_tokens: number };
}

type ContentBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

const DEFAULT_MAX_TOKENS = 4096;
const ESCALATED_MAX_TOKENS = 16384;
const MAX_RECOVERY_ATTEMPTS = 3;

async function* handleTruncatedResponse(
  response: ModelResponse,
  messages: Message[],
  callModel: (config: any) => Promise<ModelResponse>,
  config: any
): AsyncGenerator<{ type: string; message: string }, ModelResponse> {
  let currentResponse = response;
  let attempts = 0;

  while (currentResponse.stop_reason === "max_tokens" && attempts < MAX_RECOVERY_ATTEMPTS) {
    attempts++;

    if (attempts === 1) {
      yield { type: "system", message: "Response truncated. Escalating token limit..." };

      currentResponse = await callModel({
        ...config,
        maxTokens: ESCALATED_MAX_TOKENS,
      });
    } else {
      yield { type: "system", message: `Response still truncated. Sending continuation prompt (attempt ${attempts})...` };

      const continuationMessages = [
        ...messages,
        { role: "assistant" as const, content: currentResponse.content },
        {
          role: "user" as const,
          content: [{
            type: "text" as const,
            text: "Your response was cut off at the output token limit. Continue exactly from where you left off. Do not repeat content already generated.",
          }],
        },
      ];

      const continuation = await callModel({
        ...config,
        maxTokens: ESCALATED_MAX_TOKENS,
        messages: continuationMessages,
      });

      currentResponse = stitchResponses(currentResponse, continuation);
    }
  }

  if (currentResponse.stop_reason === "max_tokens") {
    yield { type: "system", message: "Recovery exhausted. Response may be incomplete." };
  }

  return currentResponse;
}
```

**Explanation:** The first attempt escalates the token limit (often sufficient). Subsequent attempts use continuation prompts, stitching each continuation onto the accumulated response. After 3 attempts, the system accepts what it has rather than retrying indefinitely.

---

## Exercise 2
**Challenge:** Write `stitchResponses` handling all content block combinations.

**Answer:**
```typescript
function stitchResponses(
  original: ModelResponse,
  continuation: ModelResponse
): ModelResponse {
  const lastOriginal = original.content[original.content.length - 1];
  const firstContinuation = continuation.content[0];

  let mergedContent: ContentBlock[];

  if (lastOriginal?.type === "text" && firstContinuation?.type === "text") {
    mergedContent = [
      ...original.content.slice(0, -1),
      { type: "text", text: lastOriginal.text + firstContinuation.text },
      ...continuation.content.slice(1),
    ];
  } else {
    mergedContent = [...original.content, ...continuation.content];
  }

  return {
    content: mergedContent,
    stop_reason: continuation.stop_reason,
    usage: {
      input_tokens: original.usage.input_tokens + continuation.usage.input_tokens,
      output_tokens: original.usage.output_tokens + continuation.usage.output_tokens,
    },
  };
}

function stitchMultiple(responses: ModelResponse[]): ModelResponse {
  if (responses.length === 0) throw new Error("No responses to stitch");
  return responses.reduce((acc, next) => stitchResponses(acc, next));
}
```

**Explanation:** When both the last original block and first continuation block are text, they get merged into a single text block (since the truncation split mid-text). For other combinations (text+tool_use, tool_use+text), blocks are simply concatenated. The `stitchMultiple` helper chains multiple continuations using `reduce`.

---

## Exercise 3
**Challenge:** Implement `detectAndRecoverIncompleteTool()`.

**Answer:**
```typescript
interface IncompleteToolInfo {
  isIncomplete: boolean;
  toolBlock?: ContentBlock;
  continuationPrompt: string;
}

function detectAndRecoverIncompleteTool(
  response: ModelResponse
): IncompleteToolInfo {
  if (response.stop_reason !== "max_tokens") {
    return { isIncomplete: false, continuationPrompt: "" };
  }

  const lastBlock = response.content[response.content.length - 1];

  if (!lastBlock || lastBlock.type !== "tool_use") {
    return {
      isIncomplete: false,
      continuationPrompt:
        "Your response was cut off. Continue exactly from where you left off.",
    };
  }

  const hasValidInput = isValidJson(lastBlock.input);

  if (hasValidInput) {
    return {
      isIncomplete: false,
      continuationPrompt:
        "Your response was truncated after a tool call. " +
        "Continue with any remaining content after the tool call.",
    };
  }

  return {
    isIncomplete: true,
    toolBlock: lastBlock,
    continuationPrompt:
      "Your previous response was cut off while generating a tool call " +
      `(tool: "${lastBlock.name}"). The input JSON was incomplete and cannot ` +
      "be executed. Please regenerate the complete tool call from the " +
      "beginning. Do not try to continue the partial JSON — start the " +
      "tool call over entirely.",
  };
}

function isValidJson(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}
```

**Explanation:** The function checks three cases: no tool_use at the end (simple text continuation), a tool_use with valid JSON (probably complete — continue after it), or a tool_use with invalid JSON (definitely incomplete — regenerate entirely). The "regenerate entirely" instruction is crucial because partial JSON cannot be reliably continued.

---

## Exercise 4
**Question:** Why are truncation errors "withheld" rather than immediately shown to the user?

**Answer:** Truncation errors are withheld because the recovery system can often resolve them transparently. If every truncation triggered an immediate error message, the user would see alarming warnings like "Response truncated!" followed moments later by a seamless recovery — creating needless anxiety and eroding trust in the agent. By withholding the error, the system gets a chance to escalate tokens or send a continuation prompt; if recovery succeeds, the user never knew there was a problem. Only when all recovery attempts fail does the system finally surface the error, at which point the user actually needs to know about it.

---

## Exercise 5
**Challenge:** Implement a `TruncationTracker` with metrics and recommendation logic.

**Answer:**
```typescript
interface TruncationEvent {
  timestamp: number;
  originalMaxTokens: number;
  outputTokensUsed: number;
  recoveryStrategy: "escalation" | "continuation" | "none";
  recovered: boolean;
  wastedTokens: number;
}

class TruncationTracker {
  private events: TruncationEvent[] = [];

  record(event: TruncationEvent): void {
    this.events.push(event);
  }

  get totalCalls(): number {
    return this.events.length;
  }

  get truncationRate(): number {
    return this.events.length > 0 ? 1.0 : 0; // all entries are truncations
  }

  get escalationSuccessRate(): number {
    const escalations = this.events.filter((e) => e.recoveryStrategy === "escalation");
    if (escalations.length === 0) return 0;
    return escalations.filter((e) => e.recovered).length / escalations.length;
  }

  get continuationSuccessRate(): number {
    const continuations = this.events.filter((e) => e.recoveryStrategy === "continuation");
    if (continuations.length === 0) return 0;
    return continuations.filter((e) => e.recovered).length / continuations.length;
  }

  get totalWastedTokens(): number {
    return this.events.reduce((sum, e) => sum + e.wastedTokens, 0);
  }

  get overallRecoveryRate(): number {
    if (this.events.length === 0) return 0;
    return this.events.filter((e) => e.recovered).length / this.events.length;
  }

  shouldIncreaseDefaultMaxTokens(
    totalApiCalls: number,
    currentDefault: number
  ): { recommend: boolean; suggestedDefault: number; reason: string } {
    const truncationRate = this.events.length / totalApiCalls;

    if (truncationRate <= 0.2) {
      return { recommend: false, suggestedDefault: currentDefault, reason: "Truncation rate within acceptable range" };
    }

    const avgOutputTokens = this.events.reduce((s, e) => s + e.outputTokensUsed, 0) / this.events.length;
    const suggestedDefault = Math.ceil(avgOutputTokens * 1.5);

    return {
      recommend: true,
      suggestedDefault: Math.min(suggestedDefault, 16384),
      reason: `Truncation rate is ${(truncationRate * 100).toFixed(1)}% (>${20}% threshold). ` +
              `Average output was ${Math.round(avgOutputTokens)} tokens. ` +
              `${this.totalWastedTokens} tokens wasted on failed recovery.`,
    };
  }
}
```

**Explanation:** The tracker records every truncation event with its recovery outcome. The `shouldIncreaseDefaultMaxTokens()` method uses the truncation rate (events vs total API calls) to determine whether the default is too low, and suggests a value at 1.5x the average observed output tokens, capped at the escalated limit.
