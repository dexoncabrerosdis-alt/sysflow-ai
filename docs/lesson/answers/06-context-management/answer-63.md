# Answers: Lesson 63 — Context Collapse

## Exercise 1
**Question:** Explain the photo compression analogy and when each strategy wins.

**Answer:** Context collapse is like reducing a high-resolution photo in steps: 50MB to 20MB, then to 8MB, then to 3MB. Each step loses some quality but the image remains recognizable. Autocompact is like converting that 50MB photo directly to a 100KB thumbnail — massive savings but extreme detail loss. **Collapse wins** when the agent is working on a long task with many phases (e.g., a multi-file refactoring) and the earlier phases' tool results are stale but the reasoning decisions are still valuable. Progressive reduction preserves more of that reasoning. **Autocompact wins** when the conversation is so bloated that even progressive reduction can't free enough space — for example, after 50+ turns with massive tool results where even Stage 3 collapses aren't sufficient. At that point, a full summary is the only option.

---

## Exercise 2
**Challenge:** Write a `identifyCollapseStage` function.

**Answer:**

```typescript
interface Message {
  role: string;
  toolName?: string;
  age: number; // milliseconds since message was created
  hasToolCall?: boolean;
  content: string;
}

type CollapseStage = 1 | 2 | 3 | "none";

const OLD_THRESHOLD_MS = 5 * 60 * 1000;

function identifyCollapseStage(message: Message): CollapseStage {
  if (message.age < OLD_THRESHOLD_MS) return "none";

  // Stage 1: Old tool results only
  if (message.role === "tool" && message.toolName) {
    return 1;
  }

  // Stage 2: Old assistant messages that contain tool calls
  if (message.role === "assistant" && message.hasToolCall) {
    return 2;
  }

  // Stage 3: Old assistant reasoning blocks (no tool calls)
  if (message.role === "assistant" && !message.hasToolCall) {
    return 3;
  }

  return "none";
}
```

**Explanation:** The function first checks if the message is old enough to be a collapse candidate. Then it classifies by the three stages of increasing aggression: tool results only (safest to collapse), tool call pairs (moderate), and assistant reasoning (most aggressive, loses the model's own analysis).

---

## Exercise 3
**Challenge:** Implement `applyCollapsesIfNeeded`.

**Answer:**

```typescript
interface ContextCollapse {
  messageIndex: number;
  collapsedContent: string;
  tokensFreed: number;
  stage: number;
}

function applyCollapsesIfNeeded(
  messages: Message[],
  tokenThreshold: number,
  stagedCollapses: Map<number, ContextCollapse[]>,
  estimateTokens: (msgs: Message[]) => number
): { projectedMessages: Message[]; tokensFreed: number } {
  const currentTokens = estimateTokens(messages);

  if (currentTokens < tokenThreshold) {
    return { projectedMessages: messages, tokensFreed: 0 };
  }

  const projectedMessages = structuredClone(messages);
  let totalFreed = 0;

  for (const stage of [1, 2, 3]) {
    const collapses = stagedCollapses.get(stage) ?? [];

    for (const collapse of collapses) {
      projectedMessages[collapse.messageIndex].content = collapse.collapsedContent;
      totalFreed += collapse.tokensFreed;
    }

    const projectedTokens = currentTokens - totalFreed;
    if (projectedTokens < tokenThreshold) {
      break;
    }
  }

  return { projectedMessages, tokensFreed: totalFreed };
}
```

**Explanation:** The function progressively applies collapse stages, stopping as soon as the projected token count drops below the threshold. It returns cloned messages (not mutating the originals) so the collapses remain "staged" until committed during a 413 recovery.

---

## Exercise 4
**Question:** Why does enabling context collapse suppress autocompact?

**Answer:** Context collapse stages reductions as projections — it plans which message segments to compress but doesn't commit them yet. Autocompact, on the other hand, rewrites the entire conversation into a single summary message. If both ran simultaneously, autocompact would summarize messages that collapse had already earmarked for progressive reduction. The carefully staged collapse projections would be destroyed because the messages they reference no longer exist. Concretely: suppose collapse has Stage 1 collapses staged for messages 5-15 and Stage 2 for messages 16-25. Then autocompact fires and replaces all 30 messages with one summary. The collapse state still references indices 5-25, but those indices are now invalid. On the next 413, `drainCollapses` would try to commit changes to nonexistent messages, causing index-out-of-bounds errors or corrupting the conversation.
