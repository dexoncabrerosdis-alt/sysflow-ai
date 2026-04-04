# Lesson 20: Loop Lifecycle

We've seen the pieces individually — state management, stream events, terminal reasons, turn limits. Now let's walk through one complete iteration of Claude Code's agent loop from start to finish. This is the full lifecycle of a single turn.

## The 14 Steps

Every iteration of the `while (true)` loop executes the following sequence. Some steps are conditional, but the order is fixed.

### Step 1: Yield stream_request_start

```typescript
yield { type: "stream_request_start" };
```

The very first action of every iteration. This event tells consumers "a new turn is beginning." The CLI uses this to show a spinner. The web UI uses it to create a new turn boundary. It carries no data — it's a pure signal.

### Step 2: Apply Tool Result Budget

```typescript
state.messages = applyToolResultBudget(state.messages, toolResultBudget);
```

Tool results can be enormous. If a tool read a 10,000-line file, that entire content is sitting in the messages. This step scans recent tool results and truncates any that exceed a configurable budget. The truncated content is replaced with a summary: `"[Result truncated: 10,247 chars → 2,000 chars]"`.

This happens every iteration because new tool results were added at the end of the previous iteration.

### Step 3: Run Microcompact

```typescript
state.messages = microcompact(state.messages);
```

Microcompaction is a lightweight optimization pass. It doesn't summarize content — it removes **structural waste**: empty messages, duplicate whitespace in tool results, system-generated messages that are no longer relevant, and other small inefficiencies that accumulate over many turns.

This is cheap (no API call) and runs unconditionally.

### Step 4: Run Autocompact If Needed

```typescript
if (shouldAutoCompact(state)) {
  const compacted = await compactConversation(state.messages, model);
  state = {
    ...state,
    messages: compacted,
    autoCompactTracking: {
      lastCompactedAt: state.turnCount,
      tokensSinceLastCompact: 0,
    },
  };
}
```

Unlike microcompact, autocompact is expensive — it calls the model to summarize old messages into a condensed form. It only triggers when `tokensSinceLastCompact` exceeds a threshold.

The decision function considers:
- How many tokens have been consumed since the last compaction
- How close we are to the context window limit
- Whether compaction would actually free meaningful space

### Step 5: Build System Prompt

```typescript
const systemPrompt = buildSystemPrompt({
  basePrompt: params.systemPrompt,
  tools: availableTools,
  context: state.toolUseContext,
  cwd: params.cwd,
  model: params.model,
});
```

The system prompt is rebuilt **every iteration**, not just once at the start. This allows the prompt to reflect current state: which tools are available right now, what the current working directory is, what the model's context looks like. Dynamic system prompts adapt to the evolving conversation.

### Step 6: Check Token Limit (Pre-API Guard)

```typescript
const tokenEstimate = estimateTokenCount(state.messages, systemPrompt);
const limit = getContextWindowSize(model) - reservedOutputTokens;

if (tokenEstimate > limit) {
  if (!state.hasAttemptedReactiveCompact) {
    // Try reactive compaction
    return { type: "continue", reason: "reactive_compact_retry" };
  }
  // Already tried compaction, can't continue
  return { type: "terminal", reason: "prompt_too_long" };
}
```

This is the safety valve before the API call. If the messages won't fit, don't waste an API call — either compact reactively or terminate. The token count is an estimate (exact counting would require the tokenizer), but it's conservative enough to prevent overflows.

### Step 7: Call Model API (Streaming)

```typescript
const stream = await client.messages.stream({
  model: params.model,
  max_tokens: maxOutputTokens,
  system: systemPrompt,
  tools: availableTools,
  messages: state.messages,
  signal: abortController.signal,
});
```

The actual API call. This is the `await` that blocks while the model thinks and generates. The `signal` parameter enables cancellation via `interrupt()`.

The response streams back in chunks, which leads to step 8.

### Step 8: Process Streaming Events and Tool Blocks

```typescript
const toolBlocks: ToolUseBlock[] = [];
let assistantMessage: Message;

for await (const event of stream) {
  yield event; // Forward to consumer for real-time rendering

  if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
    toolBlocks.push(event.content_block);
  }

  // Accumulate deltas into tool inputs
  if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
    appendToolInput(toolBlocks, event);
  }
}

assistantMessage = stream.finalMessage();
```

Two things happen simultaneously during streaming:
1. Every event is yielded to the consumer (for real-time UI updates)
2. Tool use blocks are extracted and accumulated (for execution after streaming completes)

The assistant message is fully assembled only after the stream completes.

### Step 9: Handle Fallback If Needed

```typescript
if (shouldFallback(assistantMessage, state)) {
  // Switch to a different model and retry
  yield { type: "tombstone", originalMessage: assistantMessage, reason: "fallback" };
  return { type: "continue", reason: "max_output_tokens_escalate" };
}
```

If the model's response indicates a problem (truncated output, incoherent response, unsupported feature), the loop may decide to fall back to a different model. The original response is tombstoned (invalidated) and the iteration restarts with a new model.

### Step 10: Determine Terminal or Continue

```typescript
const transition = determineTransition(state, assistantMessage, toolBlocks);

if (transition.type === "terminal") {
  yield assistantMessage;
  return transition.terminal;
}
```

This is the core decision from Lesson 17. Based on the response's stop reason, the tool blocks present, and the current state, the loop decides whether to stop or continue.

If terminal: yield the final message, return the terminal reason, and the generator ends.

### Step 11: Execute Tools If Needed

```typescript
if (transition.reason === "tool_use") {
  const toolResults: Message[] = [];

  for (const toolBlock of toolBlocks) {
    // Check permissions
    if (!params.canUseTool(toolBlock.name)) {
      toolResults.push(permissionDeniedResult(toolBlock));
      continue;
    }

    // Execute the tool
    const result = await executeTool(toolBlock, {
      cwd: params.cwd,
      signal: abortController.signal,
    });

    yield result; // Yield tool result to consumer
    toolResults.push(result);
  }
}
```

Tools execute sequentially by default. Each tool result is yielded immediately so the consumer can display progress. Permission checks happen before execution — if a tool isn't allowed, a "permission denied" result is returned to the model (so it knows not to try again).

### Step 12: Process Attachments

```typescript
const attachments = extractAttachments(toolResults);
if (attachments.length > 0) {
  state.messages.push(...processAttachments(attachments));
}
```

Some tools produce attachments — images from screenshots, file contents for inline display, diff previews. These are extracted from tool results and processed into the format the model expects for the next iteration.

### Step 13: Check Max Turns

```typescript
if (state.turnCount + 1 >= params.maxTurns) {
  return { reason: "max_turns" };
}
```

After all work is done for this iteration, check whether the next iteration would exceed the limit. If so, terminate now. This happens after tool execution so the tool results are still captured (they're in the messages even if the loop stops).

### Step 14: Build Next State and Continue

```typescript
const nextState: State = {
  messages: [
    ...state.messages,
    assistantMessage,
    ...toolResults,
  ],
  toolUseContext: updatedToolContext,
  autoCompactTracking: {
    lastCompactedAt: state.autoCompactTracking.lastCompactedAt,
    tokensSinceLastCompact:
      state.autoCompactTracking.tokensSinceLastCompact + tokensUsedThisTurn,
  },
  maxOutputTokensRecoveryCount: state.maxOutputTokensRecoveryCount,
  hasAttemptedReactiveCompact: state.hasAttemptedReactiveCompact,
  turnCount: state.turnCount + 1,
  remainingBudgetTokens: deductBudget(state.remainingBudgetTokens, tokensUsedThisTurn),
  compactedMessageIds: state.compactedMessageIds,
};

state = nextState;
// Loop continues: back to step 1
```

A new state object is built with updated messages, incremented turn count, deducted budget, and refreshed compaction tracking. Then `state = nextState` replaces the old state, and the `while (true)` loop goes back to step 1.

## The Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         while (true)                            │
│                                                                 │
│  ┌─ 1. yield stream_request_start ──────────────────────────┐   │
│  │                                                          │   │
│  │  2. Apply tool result budget                             │   │
│  │  3. Microcompact                                         │   │
│  │  4. Autocompact (if needed)                              │   │
│  │  5. Build system prompt                                  │   │
│  │                                                          │   │
│  │  6. Token limit check ──── over limit? ──→ TERMINAL      │   │
│  │         │                                prompt_too_long  │   │
│  │         ↓ (under limit)                                  │   │
│  │                                                          │   │
│  │  7. Call model API (streaming)                           │   │
│  │  8. Process stream events + tool blocks                  │   │
│  │                                                          │   │
│  │  9. Fallback needed? ──── yes ──→ tombstone + CONTINUE   │   │
│  │         │                        escalate                │   │
│  │         ↓ (no)                                           │   │
│  │                                                          │   │
│  │  10. Terminal or continue?                               │   │
│  │         │              │                                 │   │
│  │     terminal        continue                             │   │
│  │         │              │                                 │   │
│  │         ↓              ↓                                 │   │
│  │      RETURN     11. Execute tools                        │   │
│  │                 12. Process attachments                   │   │
│  │                 13. Check max turns ──→ TERMINAL          │   │
│  │                       │               max_turns          │   │
│  │                       ↓                                  │   │
│  │                 14. Build next state                      │   │
│  │                       │                                  │   │
│  └───────────────────────┘                                  │   │
│         (loop back to step 1)                               │   │
└─────────────────────────────────────────────────────────────────┘
```

## From Simple to Real

Remember the simple loop from Lesson 12?

```typescript
while (true) {
  const response = await callModel(messages);
  messages.push(response);
  if (!response.hasToolUse) break;
  const results = await executeTools(response.toolUse);
  messages.push(results);
}
```

That's steps 7, 10, 11, and 14 — the core path. Everything else is infrastructure that handles edge cases, optimizes performance, and ensures reliability:

| Simple Loop | Full Lifecycle | Why |
|-------------|---------------|-----|
| (nothing) | Steps 2-3: Budget + microcompact | Context management |
| (nothing) | Step 4: Autocompact | Context window limits |
| (nothing) | Step 5: Dynamic system prompt | Adaptive instructions |
| (nothing) | Step 6: Pre-API token check | Prevent wasted calls |
| `await callModel()` | Steps 7-8: Streaming + event processing | Real-time UI |
| (nothing) | Step 9: Fallback | Model reliability |
| `if (!hasToolUse) break` | Step 10: Transition determination | Typed exit reasons |
| `await executeTools()` | Steps 11-12: Tools + attachments | Permissions, media |
| (nothing) | Step 13: Max turns check | Safety limits |
| `messages.push()` | Step 14: State rebuild | Immutable state |

The simple loop and the full lifecycle are the same algorithm. The full lifecycle just doesn't cut corners.

## One Iteration in Practice

For a concrete example, here's what happens when the model decides to read a file during a "fix this bug" task:

```
Step 1:  yield { type: "stream_request_start" }
Step 2:  No tool results to trim (first turn)
Step 3:  Microcompact removes nothing (conversation is small)
Step 4:  Skip autocompact (well within context window)
Step 5:  Build system prompt with file tools, current directory
Step 6:  Token check: 3,200 tokens used of 200,000 available → OK
Step 7:  API call: "Let me read the file to understand the bug..."
Step 8:  Stream: text tokens + tool_use block for read_file("src/auth.ts")
Step 9:  No fallback needed
Step 10: Transition: continue (reason: tool_use)
Step 11: Execute read_file → returns 150 lines of TypeScript
Step 12: No attachments
Step 13: Turn 1 of 100 → within limit
Step 14: State rebuilt: messages now include assistant response + file contents
         turnCount: 1, tokensSinceLastCompact: 4,800
→ Back to step 1 for the next iteration
```

And on the next iteration, the model sees the file contents and can write the fix.

---

**Key Takeaways**
- Each loop iteration follows 14 steps in a fixed order
- Steps 2-5 prepare the context (budget, compact, system prompt)
- Step 6 is a pre-flight check that prevents wasted API calls
- Steps 7-8 are the model call and streaming
- Step 10 is the critical branch: terminal or continue
- Steps 11-14 handle tool execution and state transition
- The simple loop from Lesson 12 maps to steps 7, 10, 11, 14 — everything else is production infrastructure
- The flow diagram shows all possible exit paths: prompt_too_long, terminal reasons, max_turns, and the continue loop-back

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook.

### Exercise 1 — Map the 14 Steps
**Question:** Group the 14 lifecycle steps into four phases: Context Preparation, Model Call, Decision, and Execution. List which steps belong to each phase and explain what the phase accomplishes.

[View Answer](../../answers/02-the-agent-loop/answer-20.md#exercise-1)

### Exercise 2 — Simple Loop to Full Lifecycle
**Question:** The simple loop from Lesson 12 covers steps 7, 10, 11, and 14. For each of the missing steps (1-6, 8-9, 12-13), explain what production problem it solves that the simple loop ignores.

[View Answer](../../answers/02-the-agent-loop/answer-20.md#exercise-2)

### Exercise 3 — Trace a Complete Iteration
**Challenge:** Write out the full 14-step trace for this scenario: It's iteration 4 of a "refactor auth module" task. The conversation is at 45,000 tokens. The model calls `write_file` to update `src/auth.ts`. The tool succeeds. `maxTurns` is 30. Budget started at 100,000 and 38,000 have been used. Show what happens at each step.

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-20.md#exercise-3)

### Exercise 4 — Implement the Context Preparation Phase
**Challenge:** Write the functions for steps 2-5: `applyToolResultBudget` (truncate results over 2,000 chars), `microcompact` (remove empty messages), `shouldAutoCompact` (check if tokens since last compact exceed 50,000), and `buildSystemPrompt` (concatenate base prompt with tool descriptions).

Write your solution in your IDE first, then check:

[View Answer](../../answers/02-the-agent-loop/answer-20.md#exercise-4)

### Exercise 5 — Exit Path Analysis
**Question:** Identify all the exit paths from a single loop iteration — every point where the loop can terminate instead of continuing. For each exit, name the step number, the condition, and the terminal reason.

[View Answer](../../answers/02-the-agent-loop/answer-20.md#exercise-5)
