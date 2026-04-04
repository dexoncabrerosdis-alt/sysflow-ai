# Answers: Lesson 61 — Compaction Summary

## Exercise 1
**Question:** For a MySQL-to-PostgreSQL migration, list the 5 most critical things to preserve and 3 to discard.

**Answer:** **Must preserve:** (1) The original task: "migrate from MySQL to PostgreSQL." (2) All files modified — migration scripts, ORM config, connection strings, query files — with their paths. (3) Key decisions: e.g., "chose pg-promise over knex because the existing codebase uses raw SQL." (4) Current progress: which tables are migrated, which queries are converted, what's remaining. (5) Unresolved errors: e.g., "the `GROUP_CONCAT` to `STRING_AGG` conversion fails on the reports query." **Should discard:** (1) Full file contents of files that were read — the model can re-read them. (2) Intermediate `npm test` output from earlier failing runs that have since been fixed. (3) The first approach to migration that was abandoned in favor of the current approach (unless it explains *why* it was abandoned to prevent retrying it).

---

## Exercise 2
**Challenge:** Write a `getCompactPrompt` function.

**Answer:**

```typescript
function getCompactPrompt(conversationSummary: string): string {
  return `You are a summarization assistant. Create a concise summary of the following coding conversation.

The summary MUST preserve:
1. The original user task/request
2. All files read, created, modified, or deleted — with paths
3. Key decisions and their reasoning
4. Current progress: completed, in progress, remaining
5. Errors encountered and their resolution status
6. Current working state (branch, test results, build status)
7. User preferences or constraints mentioned

The summary MUST NOT include:
- Full file contents (just note which files were read/modified)
- Full command output (just the key results)
- Intermediate search results
- Superseded or abandoned plans
- Redundant information

Format as a structured document with clear sections.
Keep it under 3000 words.

<conversation>
${conversationSummary}
</conversation>

Provide ONLY the summary. No analysis or meta-commentary.`;
}
```

**Explanation:** The prompt is explicit about inclusions and exclusions. The word limit prevents the summary itself from becoming too large. Using `<conversation>` tags clearly delineates the input content for the summarization model.

---

## Exercise 3
**Challenge:** Implement `createBoundaryMessage`.

**Answer:**

```typescript
interface BoundaryMessage {
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  metadata: {
    isCompactionBoundary: boolean;
    compactedAt: number;
    originalMessageCount: number;
    originalTokenCount: number;
  };
}

function createBoundaryMessage(
  summary: string,
  originalMessageCount: number,
  originalTokenCount: number
): BoundaryMessage {
  const separator = "─".repeat(60);

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          separator,
          "CONVERSATION COMPACTED",
          "The conversation history above has been summarized.",
          "Previous detailed messages have been replaced with this summary.",
          separator,
          "",
          summary,
        ].join("\n"),
      },
    ],
    metadata: {
      isCompactionBoundary: true,
      compactedAt: Date.now(),
      originalMessageCount,
      originalTokenCount,
    },
  };
}
```

**Explanation:** The boundary message uses a `user` role so it fits naturally into the conversation. The separator and header text make it visually distinct, and the metadata fields let downstream systems detect and reason about compaction points.

---

## Exercise 4
**Challenge:** Write a `retryIfTooLarge` function with capped recursion.

**Answer:**

```typescript
async function retryIfTooLarge(
  summary: string,
  maxTokens: number,
  estimateTokens: (s: string) => number,
  compress: (prompt: string) => Promise<string>,
  attempt: number = 0
): Promise<string> {
  const MAX_RETRIES = 2;
  const currentTokens = estimateTokens(summary);

  if (currentTokens <= maxTokens) {
    return summary;
  }

  if (attempt >= MAX_RETRIES) {
    return summary.slice(0, Math.floor(summary.length * (maxTokens / currentTokens)));
  }

  const aggressivePrompt =
    `The following summary is ${currentTokens} tokens, ` +
    `exceeding the ${maxTokens} token budget. ` +
    `Compress further while preserving:\n` +
    `1. The original task\n` +
    `2. File paths modified\n` +
    `3. Current status and next steps\n` +
    `4. Unresolved errors\n\n` +
    `Remove all other detail. Target: under ${maxTokens} tokens.\n\n` +
    summary;

  const compressed = await compress(aggressivePrompt);
  return retryIfTooLarge(compressed, maxTokens, estimateTokens, compress, attempt + 1);
}
```

**Explanation:** The function recursively compresses with increasingly aggressive prompts. The recursion cap at 2 retries prevents infinite loops. As a final fallback, if still over budget after max retries, it does a hard truncation proportional to the token ratio.
