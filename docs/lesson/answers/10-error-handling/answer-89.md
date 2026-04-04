# Answers: Lesson 89 — Context Overflow Recovery

## Exercise 1
**Challenge:** Implement `estimateTokens()` with the 4-characters-per-token heuristic and test accuracy.

**Answer:**
```typescript
interface Message {
  role: "user" | "assistant" | "system";
  content: string | { type: string; text?: string }[];
}

function estimateTokens(input: string | Message | Message[]): number {
  if (typeof input === "string") {
    return Math.ceil(input.length / 4);
  }

  if (Array.isArray(input)) {
    return input.reduce((sum, msg) => sum + estimateTokens(msg), 0);
  }

  // Single message
  const roleOverhead = 4; // tokens for role markers
  if (typeof input.content === "string") {
    return roleOverhead + Math.ceil(input.content.length / 4);
  }

  const contentTokens = input.content.reduce((sum, block) => {
    if (block.type === "text" && block.text) {
      return sum + Math.ceil(block.text.length / 4);
    }
    return sum + 10; // non-text blocks have metadata overhead
  }, 0);

  return roleOverhead + contentTokens;
}

// Accuracy test
function testAccuracy() {
  const testCases = [
    { label: "Short text", content: "Hello, how are you?", expectedTokens: 6 },
    { label: "Long prose", content: "The quick brown fox ".repeat(50), expectedTokens: 250 },
    { label: "Code", content: "function foo() {\n  const x = 42;\n  return x * 2;\n}", expectedTokens: 14 },
    { label: "JSON result", content: '{"path":"src/index.ts","content":"export default {}","lines":42}', expectedTokens: 17 },
    { label: "Stack trace", content: "Error: ENOENT\n    at Object.openSync (fs.js:498:3)\n    at readFileSync (fs.js:394:35)", expectedTokens: 25 },
  ];

  for (const tc of testCases) {
    const estimated = estimateTokens(tc.content);
    const accuracy = 100 - Math.abs(estimated - tc.expectedTokens) / tc.expectedTokens * 100;
    console.log(`${tc.label}: estimated=${estimated}, expected=${tc.expectedTokens}, accuracy=${accuracy.toFixed(1)}%`);
  }
}
```

**Explanation:** The 4-characters-per-token heuristic is typically 75-90% accurate for English text and slightly less accurate for code (which has more short tokens like brackets and operators). It's intentionally conservative — overestimating is safer than underestimating for overflow prevention.

---

## Exercise 2
**Challenge:** Build the full three-stage recovery cascade with 50 mock messages.

**Answer:**
```typescript
interface CollapseResult {
  success: boolean;
  messages: Message[];
  tokensSaved: number;
}

async function recoverFromOverflow(
  messages: Message[],
  maxTokens: number,
  summarize: (msgs: Message[]) => Promise<string>
): Promise<{ stage: string; messages: Message[]; tokensSaved: number }> {
  // Stage 1: Context collapse — remove collapsible tool pairs
  const collapseResult = tryContextCollapse(messages, maxTokens);
  if (collapseResult.success) {
    return { stage: "context_collapse", ...collapseResult };
  }

  // Stage 2: Reactive compaction — summarize old messages
  const compactResult = await tryReactiveCompact(
    collapseResult.messages,
    maxTokens,
    summarize
  );
  if (compactResult.success) {
    return { stage: "reactive_compact", ...compactResult };
  }

  // Stage 3: Terminal
  return { stage: "terminal", messages, tokensSaved: 0 };
}

function tryContextCollapse(messages: Message[], maxTokens: number): CollapseResult {
  let collapsed = [...messages];
  let tokensSaved = 0;

  for (let i = 1; i < collapsed.length - 10; i++) {
    if (isToolCallPair(collapsed, i) && estimateTokens(collapsed) > maxTokens * 0.8) {
      const pairTokens = estimateTokens(collapsed[i]) + estimateTokens(collapsed[i + 1]);
      const summary: Message = {
        role: "user",
        content: `[Collapsed] Tool call completed successfully.`,
      };
      collapsed = [...collapsed.slice(0, i), summary, ...collapsed.slice(i + 2)];
      tokensSaved += pairTokens - estimateTokens(summary);
    }
  }

  return {
    success: estimateTokens(collapsed) < maxTokens,
    messages: collapsed,
    tokensSaved,
  };
}

async function tryReactiveCompact(
  messages: Message[],
  maxTokens: number,
  summarize: (msgs: Message[]) => Promise<string>
): Promise<CollapseResult> {
  const PRESERVE_RECENT = 10;
  const toSummarize = messages.slice(1, Math.max(1, messages.length - PRESERVE_RECENT));

  if (toSummarize.length === 0) {
    return { success: false, messages, tokensSaved: 0 };
  }

  const summary = await summarize(toSummarize);
  const compacted: Message[] = [
    messages[0], // system prompt
    { role: "user", content: `[Compacted conversation]\n\n${summary}` },
    { role: "assistant", content: "Understood. Continuing with the current task." },
    ...messages.slice(messages.length - PRESERVE_RECENT),
  ];

  const originalTokens = estimateTokens(messages);
  const newTokens = estimateTokens(compacted);

  return {
    success: newTokens < maxTokens,
    messages: compacted,
    tokensSaved: originalTokens - newTokens,
  };
}

function isToolCallPair(messages: Message[], index: number): boolean {
  return (
    index + 1 < messages.length &&
    messages[index].role === "assistant" &&
    messages[index + 1].role === "user"
  );
}
```

**Explanation:** Stage 1 collapses old tool call pairs into one-line summaries, targeting messages older than the most recent 10. Stage 2 uses a model to summarize everything except the system prompt and last 10 messages. Stage 3 is reached only when even post-compaction messages exceed the limit.

---

## Exercise 3
**Challenge:** Implement `ProactiveCompactionMonitor`.

**Answer:**
```typescript
class ProactiveCompactionMonitor {
  private currentTokenEstimate = 0;

  constructor(
    private maxContextTokens: number,
    private compactThreshold: number = 0.7
  ) {}

  updateEstimate(messages: Message[]): void {
    this.currentTokenEstimate = estimateTokens(messages);
  }

  shouldCompact(): boolean {
    return this.currentTokenEstimate >= this.maxContextTokens * this.compactThreshold;
  }

  getUsagePercentage(): number {
    return this.currentTokenEstimate / this.maxContextTokens;
  }

  getTokensUntilCompaction(): number {
    const threshold = this.maxContextTokens * this.compactThreshold;
    return Math.max(0, threshold - this.currentTokenEstimate);
  }
}

// Integration with agent loop
async function agentLoopWithProactiveCompaction(
  config: { maxContextTokens: number },
  messages: Message[],
  summarize: (msgs: Message[]) => Promise<string>
): Promise<void> {
  const monitor = new ProactiveCompactionMonitor(config.maxContextTokens, 0.7);

  while (true) {
    monitor.updateEstimate(messages);

    if (monitor.shouldCompact()) {
      console.log(
        `Proactive compaction at ${(monitor.getUsagePercentage() * 100).toFixed(0)}% usage`
      );
      const result = await tryReactiveCompact(
        messages,
        config.maxContextTokens,
        summarize
      );
      if (result.success) {
        messages.length = 0;
        messages.push(...result.messages);
      }
    }

    // ... normal agent loop iteration ...
    break; // placeholder
  }
}
```

**Explanation:** The monitor checks context size after every message update. At 70% capacity, it triggers proactive compaction — leaving a 30% buffer for the current operation to complete without hitting overflow. This is preferable to the 80% reactive threshold because it avoids the emergency code path entirely.

---

## Exercise 4
**Challenge:** Implement `CompactionPriorityRanker`.

**Answer:**
```typescript
interface RankedMessage {
  message: Message;
  index: number;
  priority: number; // lower = compact first
  reason: string;
}

class CompactionPriorityRanker {
  rankForCompaction(messages: Message[]): RankedMessage[] {
    return messages
      .map((message, index) => ({
        message,
        index,
        ...this.scorePriority(message, index, messages.length),
      }))
      .sort((a, b) => a.priority - b.priority);
  }

  private scorePriority(
    msg: Message,
    index: number,
    totalMessages: number
  ): { priority: number; reason: string } {
    // Never compact
    if (index === 0) return { priority: 1000, reason: "system prompt — never compact" };

    // Protect recent messages
    if (index >= totalMessages - 10) {
      return { priority: 900 + (index - totalMessages + 10), reason: "recent context — protect" };
    }

    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

    // Protect: current task description (first user message)
    if (index === 1 && msg.role === "user") {
      return { priority: 800, reason: "original task — protect" };
    }

    // Protect: recent errors
    if (content.includes("Error:") && index > totalMessages * 0.5) {
      return { priority: 700, reason: "recent error — protect" };
    }

    // Protect: active file paths mentioned recently
    if (/\.(ts|js|py|rs|go|md)/.test(content) && index > totalMessages * 0.7) {
      return { priority: 600, reason: "recent file reference — protect" };
    }

    // Compact aggressively: acknowledgment messages
    if (content.length < 50 && msg.role === "assistant") {
      return { priority: 10, reason: "short acknowledgment — compact first" };
    }

    // Compact aggressively: old tool results
    if (msg.role === "user" && content.includes("tool_result")) {
      return { priority: 20, reason: "old tool result — compact early" };
    }

    // Compact: resolved errors (old errors)
    if (content.includes("Error:") && index < totalMessages * 0.3) {
      return { priority: 30, reason: "resolved old error — compact" };
    }

    // Compact: superseded plans
    if (content.includes("plan") && content.includes("instead")) {
      return { priority: 40, reason: "superseded plan — compact" };
    }

    // Default: age-based priority
    const ageFactor = (totalMessages - index) / totalMessages;
    return { priority: Math.floor(100 + ageFactor * 400), reason: `age-based: position ${index}/${totalMessages}` };
  }
}
```

**Explanation:** The ranker assigns numeric priorities from 10 (compact first) to 1000 (never compact). System prompts and recent messages are untouchable. Short acknowledgments and old tool results are compacted first. Active error messages and file references are protected based on recency.

---

## Exercise 5
**Question:** What information must be preserved during compaction and what can safely be lost?

**Answer:** The summary must preserve: the current task and its goals, specific file paths and function names currently being worked on, unresolved errors and their messages, and key decisions already made (e.g., "chose approach B over A because of X"). What can safely be lost: the raw content of tool results that were already processed (the model acted on them), resolved errors and their full stack traces, intermediate reasoning that led to completed steps, and acknowledgment messages. A good compaction: "Working on user auth. Modified `src/auth/jwt.ts` to add refresh tokens. Tests in `auth.test.ts` failing on line 42 with `TypeError: token.verify is not a function`. Decided to use jose library instead of jsonwebtoken." A bad compaction: "The user asked to work on authentication. Several files were modified and some tests are failing." The bad version loses every actionable detail the model needs to continue.
