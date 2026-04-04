# Answers: Lesson 20 — Loop Lifecycle

## Exercise 1
**Question:** Group the 14 steps into four phases and explain each.

**Answer:**

**Phase 1: Context Preparation (Steps 1-6)**
- Step 1: Yield `stream_request_start` — signal consumers a new turn is beginning
- Step 2: Apply tool result budget — truncate oversized tool results
- Step 3: Microcompact — remove structural waste (empty messages, duplicate whitespace)
- Step 4: Autocompact if needed — summarize old messages via API call when threshold is exceeded
- Step 5: Build system prompt — reconstruct instructions with current tools, cwd, context
- Step 6: Pre-API token check — verify messages fit in context window

This phase ensures the conversation is optimized, within limits, and has up-to-date instructions before the expensive API call. It's about preparing the best possible input for the model.

**Phase 2: Model Call (Steps 7-8)**
- Step 7: Call model API (streaming) — the actual `await` that sends messages to the model
- Step 8: Process streaming events and tool blocks — yield chunks to consumers, accumulate tool calls

This phase is the core "think" step. The model receives everything and generates a response. Events stream in real time to consumers.

**Phase 3: Decision (Steps 9-10)**
- Step 9: Handle fallback if needed — tombstone bad responses, switch models
- Step 10: Determine terminal or continue — the critical branch point

This phase analyzes the model's response and decides the loop's fate. It's the "should we stop or keep going?" logic.

**Phase 4: Execution & Transition (Steps 11-14)**
- Step 11: Execute tools — run the tools the model requested, with permission checks
- Step 12: Process attachments — handle images, diffs, and other media from tool results
- Step 13: Check max turns — verify we haven't exceeded the iteration limit
- Step 14: Build next state — create the new immutable state object and loop back

This phase carries out the model's decisions, captures the results, and sets up the next iteration. It's the "act" and "observe" steps combined.

---

## Exercise 2
**Question:** For each missing step (not in the simple loop), explain what production problem it solves.

**Answer:**

**Step 1 (yield stream_request_start):** Without it, consumers can't distinguish between iterations. The CLI would show one continuous stream of text with no turn boundaries. The web UI couldn't create separate "turn cards."

**Step 2 (tool result budget):** A tool that reads a 50,000-line file dumps all of it into the conversation. Without truncation, this consumes most of the context window in one turn, leaving no room for future iterations. The simple loop would silently degrade as context fills up.

**Step 3 (microcompact):** Over 20+ iterations, empty messages, duplicate whitespace, and expired system messages accumulate. Without cleanup, these waste hundreds or thousands of tokens on non-informational content. The simple loop wastes context space on structural noise.

**Step 4 (autocompact):** Long conversations eventually exceed the context window. Without proactive compaction, the loop would suddenly fail with `prompt_too_long` on turn 15 instead of gracefully summarizing old turns and continuing. The simple loop has no compaction — it just crashes when context fills up.

**Step 5 (dynamic system prompt):** Tools can be added/removed mid-conversation (e.g., after permission changes). The working directory can change. Without rebuilding the prompt each turn, the model operates on stale instructions. The simple loop uses a static prompt that can't adapt.

**Step 6 (pre-API token check):** Without this, the loop sends a request that the API rejects (prompt too long), wastes an API call, and gets a cryptic error. The check catches this early, can trigger compaction, and gives a clear error message. The simple loop wastes money on doomed API calls.

**Step 8 (streaming event processing):** The simple loop waits for the complete response. Without streaming, users stare at a blank screen for 10-30 seconds per turn. Streaming shows text appearing in real time, making the agent feel responsive.

**Step 9 (fallback):** If a smaller model produces a truncated or incoherent response, without fallback the loop either crashes or continues with garbage. Fallback tombstones the bad response and retries with a more capable model. The simple loop has no model escalation strategy.

**Step 12 (process attachments):** Tool results may include screenshots, images, or structured data that need special formatting before the model can understand them. Without processing, these are either lost or sent in a format the model can't interpret.

**Step 13 (max turns check):** The simple loop checks at the top with `while (iterations < max)`, but this means it might start an iteration it can't finish. Checking after tool execution (step 13) ensures tool results are captured even if the loop is about to stop — data is not lost on the final iteration.

---

## Exercise 3
**Challenge:** Full 14-step trace for iteration 4 of a "refactor auth module" task.

**Answer:**
```
=== Iteration 4 ===
Context: 45,000 tokens used, budget 62,000 remaining, turn 3 → 4

Step 1:  yield { type: "stream_request_start" }
         → CLI shows "--- Turn 4 ---" separator

Step 2:  applyToolResultBudget(messages)
         → Previous turn's read_file result (3,200 chars) is under budget — no truncation

Step 3:  microcompact(messages)
         → Removes 1 empty tool_result formatting artifact — saves ~20 tokens

Step 4:  shouldAutoCompact? tokensSinceLastCompact = 38,000 < 50,000 threshold
         → Skip autocompact

Step 5:  buildSystemPrompt({
           basePrompt: "You are a coding assistant...",
           tools: [read_file, write_file, search, bash],
           cwd: "/home/user/project"
         })
         → Prompt rebuilt with current tools and directory

Step 6:  estimateTokenCount = ~45,200 tokens
         contextWindow = 200,000 - 4,096 reserved = 195,904 available
         45,200 < 195,904 → OK, proceed

Step 7:  API call: model receives 45,200 tokens of context
         → Model generates: "I'll update the auth module..." + tool_use: write_file

Step 8:  Stream events to consumer:
         content_block_delta: "I'll update the auth module with the new token validation..."
         content_block_start: tool_use block for write_file("src/auth.ts", newCode)
         → CLI renders text in real time, shows tool call indicator
         → tokensUsedThisTurn = 2,800 (input: 45,200, output: 2,800, but counted as output)

Step 9:  shouldFallback? Response is complete, not truncated → no fallback needed

Step 10: determineTransition:
         stopReason = "end_turn" but hasToolUse = true
         → Continue: { type: "continue", reason: "tool_use" }

Step 11: Execute write_file("src/auth.ts", newCode):
         → canUseTool("write_file") = true (auto-approved for project files)
         → File written successfully
         → yield toolResult message
         → yield ToolUseSummaryMessage: "Wrote 85 lines to src/auth.ts (12ms)"

Step 12: extractAttachments(toolResults)
         → No attachments (write_file doesn't produce images/diffs)

Step 13: turnCount + 1 = 4, maxTurns = 30
         4 < 30 → within limit, continue

Step 14: Build next state:
         {
           messages: [...previous, assistant(write_file), tool_result("success")],
           turnCount: 4,
           remainingBudgetTokens: 62,000 - 2,800 = 59,200,
           autoCompactTracking: {
             lastCompactedAt: 0,
             tokensSinceLastCompact: 38,000 + 2,800 = 40,800
           },
           maxOutputTokensRecoveryCount: 0,
           hasAttemptedReactiveCompact: false,
         }
         state = nextState
         → Back to Step 1 for iteration 5
```

---

## Exercise 4
**Challenge:** Implement the context preparation functions (steps 2-5).

**Answer:**
```typescript
interface Message {
  role: string;
  content: string;
  toolName?: string;
}

interface Tool {
  name: string;
  description: string;
}

// Step 2: Truncate oversized tool results
function applyToolResultBudget(messages: Message[], maxChars: number = 2000): Message[] {
  return messages.map((msg) => {
    if (msg.role === "user" && msg.toolName && msg.content.length > maxChars) {
      const truncated = msg.content.slice(0, maxChars);
      return {
        ...msg,
        content: `${truncated}\n[Result truncated: ${msg.content.length} chars → ${maxChars} chars]`,
      };
    }
    return msg;
  });
}

// Step 3: Remove empty/wasteful messages
function microcompact(messages: Message[]): Message[] {
  return messages.filter((msg) => {
    if (!msg.content || msg.content.trim() === "") return false;
    return true;
  });
}

// Step 4: Check if autocompact should run
function shouldAutoCompact(state: {
  autoCompactTracking: { tokensSinceLastCompact: number };
}): boolean {
  return state.autoCompactTracking.tokensSinceLastCompact > 50000;
}

// Step 5: Build system prompt dynamically
function buildSystemPrompt(params: {
  basePrompt: string;
  tools: Tool[];
  cwd: string;
}): string {
  const toolDescriptions = params.tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");

  return [
    params.basePrompt,
    "",
    `Working directory: ${params.cwd}`,
    "",
    "Available tools:",
    toolDescriptions,
  ].join("\n");
}
```

**Explanation:** Each function handles one concern: `applyToolResultBudget` prevents any single tool result from dominating the context; `microcompact` cleans up empty accumulation; `shouldAutoCompact` is a simple threshold check (the actual compaction call is made by the loop if this returns true); `buildSystemPrompt` combines static instructions with dynamic context. In production, these are more sophisticated (token-aware truncation, smarter compaction heuristics), but the structure is the same.

---

## Exercise 5
**Question:** Identify all exit paths from a single iteration.

**Answer:** There are four exit paths where the loop can terminate during a single iteration:

**Exit 1 — Step 6: `prompt_too_long`**
- **Condition:** Token estimate exceeds context window AND reactive compaction has already been attempted (`hasAttemptedReactiveCompact === true`)
- **Terminal reason:** `prompt_too_long`
- **What happens:** The conversation is too large to fit in the model's context window. Compaction was tried but didn't free enough space. The loop can't make any more API calls.

**Exit 2 — Step 9: Model escalation failure**
- **Condition:** Fallback is needed but no fallback model is available, or the fallback has already been tried
- **Terminal reason:** `model_error`
- **What happens:** The model produced a bad response (truncated, incoherent) and there's no better model to escalate to. (Note: if fallback IS available, this becomes a continue with `max_output_tokens_escalate`, not a terminal.)

**Exit 3 — Step 10: Terminal transition**
- **Condition:** `determineTransition()` returns `type: "terminal"` — which can happen for: `completed` (no tool use), `model_error` (unrecoverable API error), `aborted_streaming`/`aborted_tools` (user interrupt), `blocking_limit` (permission denied), `stop_hook_prevented`/`hook_stopped` (hook blocked)
- **Terminal reason:** Any of the above
- **What happens:** This is the primary decision point. Most terminations happen here.

**Exit 4 — Step 13: `max_turns`**
- **Condition:** `turnCount + 1 >= maxTurns`
- **Terminal reason:** `max_turns`
- **What happens:** The iteration limit is reached after tools have been executed. Tool results are preserved in the conversation (they happened before this check), but no further iterations occur.

Note that Step 6 can also produce a `reactive_compact_retry` continue (if compaction hasn't been tried yet), and Step 9 can produce a continue (if fallback is available). These are not exits — they cause the loop to retry rather than terminate.
