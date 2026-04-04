# Lesson 61: Compaction Summary

## What the Summary Must Preserve

When Claude Code compacts a 170K-token conversation into a 15K-token summary, it can't keep everything. The art of compaction is deciding what to keep and what to discard.

A good summary preserves:
- **The original task**: What the user asked for
- **Files modified**: Which files were changed and how
- **Key decisions**: Why certain approaches were chosen over alternatives
- **Current progress**: What's done, what's in progress, what's remaining
- **Errors encountered**: What went wrong and how it was resolved (or not)
- **Working state**: Current branch, test status, build status

A bad summary loses:
- Specific file contents (the model can re-read files)
- Intermediate search results (the model can re-search)
- Verbose error logs (the key error message matters, not the full stack trace)
- Superseded plans (early approaches that were abandoned)

## The compactConversation() Pipeline

Full compaction is not a single function call. It's a pipeline with pre-processing, summarization, post-processing, and cleanup steps:

```typescript
async function compactConversation(
  messages: Message[],
  model: ModelId,
  options: CompactOptions
): Promise<CompactResult> {
  // Step 1: Pre-compact hooks
  //   Notify subsystems that compaction is about to happen.
  //   Some subsystems may want to inject data before the old
  //   messages are summarized.
  await runPreCompactHooks(messages, options);

  // Step 2: Generate the summary via streaming API call
  const rawSummary = await streamCompactSummary(messages, model);

  // Step 3: Strip images from the summary
  //   Images can't be summarized as text. Remove them to
  //   avoid wasting tokens on base64-encoded image data.
  const textSummary = stripImages(rawSummary);

  // Step 4: Format the summary — remove analysis tags
  const cleanSummary = formatCompactSummary(textSummary);

  // Step 5: Handle PTL (prompt-too-long) retry
  //   If the summary itself is too large, retry with a
  //   more aggressive summarization prompt.
  const finalSummary = await retryIfTooLarge(cleanSummary, model);

  // Step 6: Post-compact attachments
  //   Append current state info that should always be present
  //   after compaction (e.g., current working directory, git status).
  const withAttachments = appendPostCompactAttachments(
    finalSummary,
    options
  );

  // Step 7: Create the boundary message
  //   Wrap the summary in a special message that marks the
  //   compaction boundary in the conversation history.
  const boundaryMessage = createBoundaryMessage(withAttachments);

  return {
    success: true,
    newMessages: [boundaryMessage],
    tokensFreed: estimateTokenCount(messages) - estimateTokenCount([boundaryMessage]),
  };
}
```

Let's examine each step in detail.

## Step 2: The Compact Prompt

The most critical part is the prompt that instructs the model to generate the summary. `getCompactPrompt()` builds this:

```typescript
function getCompactPrompt(messages: Message[]): string {
  return `You are a summarization assistant. Your task is to create a concise 
summary of the following coding conversation between a user and an AI assistant.

The summary MUST preserve:
1. The original user task/request
2. All files that were read, created, modified, or deleted — with their paths
3. Key decisions made and the reasoning behind them
4. Current progress: what has been completed, what is in progress, what remains
5. Any errors encountered and their resolutions (or unresolved status)
6. The current state of the work (branch, test results, build status)
7. Any specific user preferences or constraints mentioned

The summary MUST NOT include:
- Full file contents (just note which files were read/modified)
- Full command output (just note the key results)
- Intermediate search results
- Superseded plans or abandoned approaches (unless relevant to current direction)
- Redundant information (e.g., file read then immediately re-read)

Format the summary as a structured document with clear sections.
Keep it under 3000 words.

<conversation>
${formatMessagesForSummary(messages)}
</conversation>

Provide ONLY the summary. Do not include any analysis, commentary, or meta-discussion.`;
}
```

The prompt is highly specific about what to include and exclude. It's been tuned through extensive testing to produce summaries that let the model continue working effectively after compaction.

## Step 3: Stripping Images

Conversations often contain screenshots, diagrams, or image-based tool results. These can't be meaningfully summarized in text, and their base64 encoding consumes enormous token counts:

```typescript
function stripImages(summary: ContentBlock[]): ContentBlock[] {
  return summary
    .filter((block) => {
      if (block.type === "image") {
        return false;  // Remove image blocks entirely
      }
      return true;
    })
    .map((block) => {
      if (block.type === "text") {
        // Also remove inline base64 image references
        return {
          ...block,
          text: block.text.replace(
            /\[Image: .*?\]/g,
            "[Image removed during compaction]"
          ),
        };
      }
      return block;
    });
}
```

A single screenshot can consume 10K+ tokens. Stripping images from the compacted summary prevents them from persisting indefinitely across compaction cycles.

## Step 4: Formatting — Strip Analysis Tags

The summarization model sometimes wraps its output in analysis tags (thinking out loud about what to include). These need to be stripped:

```typescript
function formatCompactSummary(rawSummary: string): string {
  // Remove <analysis>...</analysis> tags the model may produce
  let cleaned = rawSummary.replace(
    /<analysis>[\s\S]*?<\/analysis>/g,
    ""
  );

  // Remove <thinking>...</thinking> tags
  cleaned = cleaned.replace(
    /<thinking>[\s\S]*?<\/thinking>/g,
    ""
  );

  // Trim whitespace
  cleaned = cleaned.trim();

  return cleaned;
}
```

The model is instructed to provide "ONLY the summary," but models sometimes include meta-commentary anyway. The formatter catches these cases.

## Step 5: PTL Retry

Sometimes the summary itself is too large — especially for very long conversations. The PTL (prompt-too-long) retry handles this:

```typescript
async function retryIfTooLarge(
  summary: string,
  model: ModelId
): Promise<string> {
  const summaryTokens = estimateTokenCount(summary);
  const maxSummaryTokens = getMaxSummaryTokens(model);

  if (summaryTokens <= maxSummaryTokens) {
    return summary;
  }

  // Summary is too large — retry with a more aggressive prompt
  const aggressivePrompt = `The following summary is ${summaryTokens} tokens, 
which exceeds the ${maxSummaryTokens} token budget. 

Please compress it further while preserving:
1. The original task
2. File paths modified (not contents)
3. Current status and next steps
4. Unresolved errors

Remove all other detail. Target: under ${maxSummaryTokens} tokens.

${summary}`;

  const compressed = await callModel(aggressivePrompt, model);
  return formatCompactSummary(compressed);
}
```

This recursive summarization ensures the compacted output actually fits in context. It's a fallback — most summaries are already within budget on the first try.

## Step 6: Post-Compact Attachments

After compaction, the agent needs certain context to be fresh and accurate — not summarized from a potentially outdated conversation state. Post-compact attachments inject this:

```typescript
function appendPostCompactAttachments(
  summary: string,
  options: CompactOptions
): string {
  const attachments: string[] = [summary];

  // Current working directory
  if (options.cwd) {
    attachments.push(`\nCurrent working directory: ${options.cwd}`);
  }

  // Git status (if in a git repo)
  if (options.gitStatus) {
    attachments.push(`\nGit status:\n${options.gitStatus}`);
  }

  // Active file (if the user has a file open)
  if (options.activeFile) {
    attachments.push(`\nUser's currently open file: ${options.activeFile}`);
  }

  // Any pinned context that should survive compaction
  if (options.pinnedContext) {
    attachments.push(`\nPinned context:\n${options.pinnedContext}`);
  }

  return attachments.join("\n");
}
```

These attachments ensure the model knows the current environment state even after the detailed conversation history is gone.

## Step 7: The Boundary Message

The summary is wrapped in a special boundary message that marks the compaction point:

```typescript
function createBoundaryMessage(summary: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "─".repeat(60),
          "CONVERSATION COMPACTED",
          "The conversation history above has been summarized.",
          "Previous detailed messages have been replaced with this summary.",
          "─".repeat(60),
          "",
          summary,
        ].join("\n"),
      },
    ],
    metadata: {
      isCompactionBoundary: true,
      compactedAt: Date.now(),
      originalMessageCount: 0,  // set by caller
      originalTokenCount: 0,    // set by caller
    },
  };
}
```

The boundary message serves as a clear marker in the conversation history. If the agent compacts multiple times during a long session, each boundary is visible. The model can see "this is where a compaction happened" and understands that detailed history before this point is unavailable.

## A Complete Example

Here's what compaction looks like end-to-end for a real conversation:

**Before compaction (170K tokens across 45 messages):**

```
User: "Add JWT authentication to the Express app"
Assistant: "I'll start by examining the current auth setup..."
  → Read auth/middleware.ts (2000 tokens)
  → Read auth/routes.ts (1500 tokens)
  → Grep "passport" across src/ (800 tokens)
  → Read package.json (400 tokens)
Assistant: "I see you're using Passport.js. I'll migrate to JWT..."
  → Edit auth/middleware.ts (600 tokens)
  → Edit auth/routes.ts (900 tokens)
  → Shell: npm install jsonwebtoken (200 tokens)
  → Edit package.json (300 tokens)
  → Shell: npm test (3000 tokens — many test failures)
Assistant: "Tests are failing because existing routes expect sessions..."
  → Read routes/api.ts (1800 tokens)
  → Read routes/admin.ts (1200 tokens)
  → Edit routes/api.ts (500 tokens)
  ... (30 more tool calls) ...
```

**After compaction (12K tokens, 1 boundary message):**

```
────────────────────────────────────────────────────
CONVERSATION COMPACTED
────────────────────────────────────────────────────

## Task
Add JWT authentication to the Express app, migrating from Passport.js sessions.

## Files Modified
- auth/middleware.ts — Replaced Passport session check with JWT verify middleware
- auth/routes.ts — Added /login endpoint that returns JWT, removed /session endpoints
- routes/api.ts — Updated all route handlers to use req.user from JWT
- routes/admin.ts — Added role checking from JWT claims
- package.json — Added jsonwebtoken@9.0.0, removed passport, passport-local
- tests/auth.test.ts — Updated test fixtures to use JWT tokens instead of session cookies

## Decisions
- Chose jsonwebtoken over jose (simpler API, user's existing code style)
- Token expiry set to 24h per user's preference
- Refresh tokens NOT implemented (user said "keep it simple for now")

## Current Status
- JWT auth fully implemented and working
- 18/20 tests passing
- 2 remaining failures in tests/admin.test.ts (role-based access tests)
- Need to update the admin role checking logic

## Errors
- Initial migration broke all 20 tests (session → JWT mismatch)
- Fixed 18 tests by updating test fixtures
- Admin tests still failing: "Expected role 'admin' but got undefined"
  → The JWT payload doesn't include the role claim yet

## Next Steps
1. Add role claim to JWT payload in auth/routes.ts login handler
2. Fix the 2 admin tests
3. Run full test suite to confirm

Current working directory: /home/user/express-app
Git branch: feature/jwt-auth (3 commits ahead of main)
```

The 170K-token conversation is now 12K tokens. The model has everything it needs to continue: what was done, what's broken, and what to do next.

## Key Takeaways

1. **Compaction is a multi-step pipeline** — pre-hooks, streaming summary, image stripping, formatting, PTL retry, post-attachments, boundary message
2. **The compact prompt is tuned for specificity** — it explicitly lists what to preserve and what to discard
3. **Image stripping prevents token waste** — images can't be summarized as text
4. **PTL retry handles oversized summaries** — recursive summarization as a fallback
5. **Post-compact attachments inject fresh state** — cwd, git status, and pinned context survive compaction
6. **Boundary messages mark compaction points** — the model knows where summaries replace detailed history
7. **A good summary enables seamless continuation** — the model can pick up work without re-reading everything

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Summary Quality Assessment
**Question:** Given a 40-turn conversation where the agent migrated a database from MySQL to PostgreSQL, list the 5 most critical pieces of information the compaction summary must preserve. Then list 3 things that should be discarded. Explain your reasoning.

[View Answer](../../answers/06-context-management/answer-61.md#exercise-1)

### Exercise 2 — Build a Compact Prompt
**Challenge:** Write a `getCompactPrompt(conversationSummary: string)` function that returns a prompt string for the summarization model. It should instruct the model on what to preserve (task, files, decisions, progress, errors, state) and what to discard (file contents, command output, intermediate search results). Include a word limit.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-61.md#exercise-2)

### Exercise 3 — Boundary Message Creator
**Challenge:** Implement `createBoundaryMessage(summary: string, originalMessageCount: number, originalTokenCount: number)` that wraps a compaction summary in the boundary message format with the `CONVERSATION COMPACTED` header and metadata fields.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-61.md#exercise-3)

### Exercise 4 — PTL Retry Logic
**Challenge:** Write a function `retryIfTooLarge(summary: string, maxTokens: number, estimateTokens: (s: string) => number, compress: (prompt: string) => Promise<string>)` that checks if a summary exceeds the budget and recursively compresses it with a more aggressive prompt. Cap recursion at 2 retries.

Write your solution in your IDE first, then check:

[View Answer](../../answers/06-context-management/answer-61.md#exercise-4)

---

*Previous: [Lesson 60 — Autocompact](60-autocompact.md) · Next: [Lesson 62 — Reactive Compact](62-reactive-compact.md)*
