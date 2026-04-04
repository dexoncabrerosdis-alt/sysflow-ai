# Lesson 89: Context Overflow Recovery

## The Context Limit Wall

Every language model has a maximum context window — the total number of tokens it can process in a single request (input + output combined). When the conversation history grows too large, the API rejects the request with a 413 status code or a `prompt_too_long` error.

This happens naturally in long agent sessions:
- Many tool calls accumulate results in the conversation
- Large file contents are read into context
- Multiple retry attempts add messages
- The model's own responses consume space

When context overflows, the agent can't just retry — it needs to **reduce the context** while preserving enough information to continue working.

## The Recovery Cascade

Claude Code uses a three-stage cascade for context overflow recovery:

```typescript
type OverflowRecoveryStage = 
  | "context_collapse"    // Stage 1: Commit planned collapses
  | "reactive_compact"    // Stage 2: Emergency summarization
  | "terminal";           // Stage 3: Give up gracefully

async function* recoverFromOverflow(
  messages: Message[],
  config: ModelConfig,
  error: ContextOverflowError
): AsyncGenerator<Message, RecoveryResult> {
  // Stage 1: Try collapsing already-staged sections
  const collapseResult = await tryContextCollapse(messages, config);
  if (collapseResult.success) {
    return {
      stage: "context_collapse",
      messages: collapseResult.messages,
      tokensSaved: collapseResult.tokensSaved,
    };
  }

  // Stage 2: Emergency reactive compaction
  const compactResult = await tryReactiveCompact(messages, config);
  if (compactResult.success) {
    yield {
      type: "system",
      message: "Context was too large. Summarizing conversation history...",
    };
    return {
      stage: "reactive_compact",
      messages: compactResult.messages,
      tokensSaved: compactResult.tokensSaved,
    };
  }

  // Stage 3: Terminal — cannot recover
  return {
    stage: "terminal",
    reason: "prompt_too_long",
    messages,
    tokensSaved: 0,
  };
}
```

## Stage 1: Context Collapse Drain

Throughout normal operation, the agent identifies sections of the conversation that *could* be collapsed — old tool results, completed subtasks, resolved errors. These are marked as "collapsible" but not actually removed until needed:

```typescript
interface CollapsibleSection {
  startIndex: number;     // First message in the section
  endIndex: number;       // Last message in the section
  summary: string;        // Pre-computed summary
  tokenCount: number;     // How many tokens this section uses
  priority: number;       // Lower = collapse first
}

function identifyCollapsibleSections(
  messages: Message[]
): CollapsibleSection[] {
  const sections: CollapsibleSection[] = [];

  let i = 0;
  while (i < messages.length) {
    // Old tool call + result pairs
    if (isToolCallPair(messages, i)) {
      sections.push({
        startIndex: i,
        endIndex: i + 1,
        summary: summarizeToolCall(messages[i], messages[i + 1]),
        tokenCount: estimateTokens(messages[i]) + estimateTokens(messages[i + 1]),
        priority: getAgePriority(i, messages.length),
      });
      i += 2;
      continue;
    }

    // Long text responses that have been superseded
    if (isLongTextBlock(messages[i]) && hasBeenSuperseded(messages, i)) {
      sections.push({
        startIndex: i,
        endIndex: i,
        summary: `[Previous response summarized: ${messages[i].content[0].text.slice(0, 100)}...]`,
        tokenCount: estimateTokens(messages[i]),
        priority: getAgePriority(i, messages.length),
      });
    }

    i++;
  }

  return sections.sort((a, b) => a.priority - b.priority);
}
```

When overflow occurs, these staged collapses are committed:

```typescript
async function tryContextCollapse(
  messages: Message[],
  config: ModelConfig
): Promise<CollapseResult> {
  const sections = identifyCollapsibleSections(messages);

  if (sections.length === 0) {
    return { success: false, messages, tokensSaved: 0 };
  }

  let tokensSaved = 0;
  let collapsedMessages = [...messages];

  // Collapse sections from lowest priority first
  for (const section of sections) {
    collapsedMessages = replaceSectionWithSummary(
      collapsedMessages,
      section
    );
    tokensSaved += section.tokenCount - estimateTokens(section.summary);

    // Check if we've freed enough
    const currentTokens = estimateTokens(collapsedMessages);
    if (currentTokens < config.maxContextTokens * 0.8) {
      return {
        success: true,
        messages: collapsedMessages,
        tokensSaved,
      };
    }
  }

  // Collapsed everything we could
  const finalTokens = estimateTokens(collapsedMessages);
  return {
    success: finalTokens < config.maxContextTokens,
    messages: collapsedMessages,
    tokensSaved,
  };
}

function replaceSectionWithSummary(
  messages: Message[],
  section: CollapsibleSection
): Message[] {
  const before = messages.slice(0, section.startIndex);
  const after = messages.slice(section.endIndex + 1);
  const summaryMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `[Context collapsed] ${section.summary}`,
      },
    ],
  };

  return [...before, summaryMessage, ...after];
}
```

## Stage 2: Reactive Compact

If collapsing staged sections isn't enough, the system performs an emergency compaction — using the model itself to summarize the conversation:

```typescript
async function tryReactiveCompact(
  messages: Message[],
  config: ModelConfig
): Promise<CompactResult> {
  // Calculate how much we need to trim
  const currentTokens = estimateTokens(messages);
  const targetTokens = config.maxContextTokens * 0.6;
  const tokensToRemove = currentTokens - targetTokens;

  if (tokensToRemove <= 0) {
    return { success: true, messages, tokensSaved: 0 };
  }

  // Find the oldest messages that make up the excess tokens
  const messagesToSummarize = selectMessagesForCompaction(
    messages,
    tokensToRemove
  );

  if (messagesToSummarize.length === 0) {
    return { success: false, messages, tokensSaved: 0 };
  }

  // Use the model to create a summary
  const summary = await generateCompactionSummary(
    messagesToSummarize,
    config
  );

  // Build the compacted message list
  const compactedMessages = buildPostCompactMessages(
    messages,
    messagesToSummarize,
    summary
  );

  const tokensSaved = currentTokens - estimateTokens(compactedMessages);

  return {
    success: estimateTokens(compactedMessages) < config.maxContextTokens,
    messages: compactedMessages,
    tokensSaved,
  };
}
```

The summary generation call uses a smaller model for speed and to avoid consuming too many tokens on the summarization itself:

```typescript
async function generateCompactionSummary(
  messages: Message[],
  config: ModelConfig
): Promise<string> {
  const summaryPrompt = `Summarize the following conversation segment concisely.
Focus on:
1. What tasks were attempted and their outcomes
2. Key decisions made
3. Important file paths and code changes
4. Any errors encountered and how they were resolved
5. Current state and pending work

Keep the summary under 500 tokens. Preserve specific details
(file names, function names, error messages) that might be
needed to continue the work.

Conversation to summarize:
${formatMessagesForSummary(messages)}`;

  const response = await callModel({
    model: "claude-haiku", // Fast, cheap summarization
    maxTokens: 600,
    messages: [{ role: "user", content: summaryPrompt }],
  });

  return response.content[0].text;
}
```

## Building Post-Compact Messages

After compaction, the message list is restructured:

```typescript
function buildPostCompactMessages(
  allMessages: Message[],
  summarizedMessages: Message[],
  summary: string
): Message[] {
  // The system prompt stays
  const systemMessages = allMessages.filter(isSystemMessage);

  // Find the boundary between summarized and preserved messages
  const summarizedEnd = allMessages.indexOf(
    summarizedMessages[summarizedMessages.length - 1]
  );
  const preservedMessages = allMessages.slice(summarizedEnd + 1);

  // Build the new message list
  return [
    ...systemMessages,
    // Summary replaces old messages
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `[Conversation history was compacted to save context space]\n\n` +
            `Summary of previous conversation:\n${summary}`,
        },
      ],
    },
    // A synthetic assistant acknowledgment
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Understood. I have the context from the summarized conversation. " +
            "Continuing with the current task.",
        },
      ],
    },
    // Preserved recent messages
    ...preservedMessages,
  ];
}
```

## Stage 3: Terminal Failure

If both collapse and compaction fail (the preserved messages alone exceed the limit), recovery isn't possible:

```typescript
function handleTerminalOverflow(
  error: ContextOverflowError,
  config: ModelConfig
): TerminalResult {
  return {
    reason: "prompt_too_long",
    message: `The conversation context (${error.currentTokens} tokens) ` +
      `exceeds the model's limit (${error.maxTokens} tokens) ` +
      `and could not be compacted further. ` +
      `Please start a new conversation.`,
    suggestion: "Consider breaking complex tasks into smaller conversations, " +
      "or use a model with a larger context window.",
  };
}
```

## Selecting Messages for Compaction

The selection algorithm preserves recent messages and the system prompt, compacting the oldest middle section:

```typescript
function selectMessagesForCompaction(
  messages: Message[],
  tokensToRemove: number
): Message[] {
  // Never compact:
  // - System messages (first message)
  // - The last N messages (recent context)
  const PRESERVE_RECENT = 10;

  const compactable = messages.slice(
    1, // Skip system prompt
    Math.max(1, messages.length - PRESERVE_RECENT)
  );

  let tokensCollected = 0;
  const selected: Message[] = [];

  // Collect from oldest first until we have enough
  for (const msg of compactable) {
    selected.push(msg);
    tokensCollected += estimateTokens(msg);

    if (tokensCollected >= tokensToRemove) break;
  }

  return selected;
}
```

## Integration with the Agent Loop

The overflow recovery plugs into the main agent loop at the model call boundary:

```typescript
async function* agentLoopWithOverflowRecovery(
  config: AgentConfig
): AsyncGenerator<Message> {
  let messages = config.initialMessages;

  while (true) {
    try {
      const response = await callModel({ ...config, messages });
      // ... normal processing ...

    } catch (error) {
      if (isContextOverflowError(error)) {
        const recovery = recoverFromOverflow(messages, config, error);

        for await (const msg of recovery) {
          yield msg; // Yield status messages to UI
        }

        const result = await getGeneratorReturn(recovery);

        if (result.stage === "terminal") {
          yield createErrorMessage(result.reason);
          break;
        }

        // Update messages with compacted version and retry
        messages = result.messages;
        continue; // Retry the model call with smaller context
      }

      throw error;
    }
  }
}
```

## Summary

Context overflow is inevitable in long agent sessions. The three-stage recovery cascade provides graceful degradation: first commit staged collapses, then perform emergency summarization, then fail gracefully. The key insight is that context compaction trades detail for continuity — the agent loses specifics from old interactions but can keep working on the current task.

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Token Estimation
**Challenge:** Implement `estimateTokens()` using the 4-characters-per-token heuristic for both strings and message arrays. Then write a test that compares your heuristic against exact counts for 5 different content types: short text, long prose, code with indentation, JSON tool results, and error stack traces. Report the accuracy percentage for each.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-89.md#exercise-1)

### Exercise 2 — Three-Stage Recovery Cascade
**Challenge:** Build the full three-stage overflow recovery: (1) context collapse using pre-identified collapsible sections, (2) reactive compaction using a mock summarizer, and (3) terminal failure. Create a conversation with 50 messages and test that each stage activates at the correct threshold (collapse at 80%, compact at 60% target, terminal when nothing fits).

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-89.md#exercise-2)

### Exercise 3 — Proactive Compaction
**Challenge:** Design and implement a `ProactiveCompactionMonitor` that tracks context size after every message and triggers compaction before overflow. It should: monitor token usage, trigger at a configurable threshold (e.g., 70% of max), select messages for compaction, and integrate with the agent loop via a `shouldCompact()` check.

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-89.md#exercise-3)

### Exercise 4 — Compaction Priority System
**Challenge:** Implement a `CompactionPriorityRanker` that scores messages by importance. It should protect: the system prompt (never compact), the current task description, recent errors, and active file paths. It should aggressively compact: old tool results, resolved errors, superseded plans, and acknowledgment messages. Write a `rankForCompaction()` method that returns messages sorted from "compact first" to "protect at all costs."

Write your solution in your IDE first, then check:

[View Answer](../../answers/10-error-handling/answer-89.md#exercise-4)

### Exercise 5 — Compaction Quality
**Question:** When compacting a conversation, the agent trades detail for continuity. Describe in 3-4 sentences what specific information types must be preserved in the summary to keep the agent functional, and what can safely be lost. Give an example of a compaction that preserves the right details and one that doesn't.

[View Answer](../../answers/10-error-handling/answer-89.md#exercise-5)
