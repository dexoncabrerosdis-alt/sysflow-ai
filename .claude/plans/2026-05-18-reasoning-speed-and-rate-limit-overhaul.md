# Reasoning speed + rate-limit overhaul

- **Created:** 2026-05-18
- **Status:** draft
- **Scope:** Make sysflow's upfront-reasoning pipeline FASTER (lower latency) AND CHEAPER (fewer Flash calls, lower rate-limit pressure) without sacrificing the reasoning value that prior plans landed. User-reported pain: "very very slow when prompting or iterating" + rate-limits firing on Gemini before the agent's first move.

## Goal

A single user prompt currently fires **4-19 sequential Flash calls** before the agent's first `needs_tool` response:

| Stage | Call | Worst-case Flash calls |
|---|---|---|
| `user-message.ts:213` | `runProjectInitChain` (iterative) | 1-3 |
| `user-message.ts:334` | `runReasoning(preflight)` (iterative paragraph chain) | 1-6 |
| `user-message.ts:453` | `runReasoningChain(implement_elaborate)` (free-tier extra) | 0-3 |
| `user-message.ts:509` | `runReasoning(chunk_plan)` | 1 |
| `user-message.ts:617` | `classifyIntentSmart` (iterative chain) | 1-6 |
| **Total** | | **4-19** |

These are awaited **sequentially**. On Gemini's free tier (15 RPM, 1M tokens/day), even the optimistic floor eats a third of a minute's budget before the agent moves. On Anthropic (10k input tokens/min on personal tier) it's worse.

Each layer was added to fix a real bug (per `.claude/plans/applied/`); none are wasteful in isolation. The SUM is what kills latency + budget.

## Context from knowledge base

- `architecture.md: ## Reasoning triggers (Phase 5)` — preflight + on-error + on-completion + self_invoked entry points.
- `applied/2026-05-15-agent-runtime-fixes-and-project-init-reasoning.md` Stage 1 — project-init reasoner rationale (cures phantom tsconfig demands).
- `applied/2026-05-07-phase-16-deep-reasoning-on-free-models.md` Stage 3 — `runReasoningChain` (implement_elaborate) for free-tier.
- `applied/2026-05-06-phase-10-chunked-reasoning-loop.md` — chunked-loop's separate planner + reflector calls.
- `applied/2026-05-15-llm-iterative-intent-classification.md` — iterative LLM intent chain (1-6 calls).
- `decisions.md: ## Planner ↔ reflector are additive, not merged` — separation rationale that this plan must respect.

## Dependencies between the 5 calls

Audited at the call sites:

- **project-init** (213): input = `directoryTree`. NO dependency on others.
- **preflight** (334): input = `userMessage`. NO dependency on others.
- **implement_elaborate** (453): input = `preflightBrief.implementBrief`. DEPENDS on preflight.
- **chunk-plan** (509): input = `preflightBrief.implementBrief`. DEPENDS on preflight.
- **intent classify** (617): input = `userMessage`. NO dependency on others.

This means **3 of 5 are independent** (can run in parallel) and the other 2 are independent of each other once preflight finishes (can ALSO run in parallel).

## Affected files

- `server/src/handlers/user-message.ts` — restructure upfront block to phase-parallelize (Stage 1), then merge schemas (Stage 2).
- `server/src/reasoning/task-reasoner.ts` — new `combined_preflight` pipeline backing Stage 2.
- `server/src/reasoning/reasoning-schema.ts` — new combined-brief Zod schema (project-init + preflight + intent in one envelope).
- `server/src/reasoning/pipelines/` — new pipeline file for the combined call.
- `server/src/providers/anthropic.ts` — `cache_control` markers (Stage 3) on system prompt + project context.
- `server/src/providers/base-provider.ts` — shared cache-control helpers if any provider apart from Anthropic supports caching later (OpenRouter does via `prompt: { cache: true }` for some models).
- `server/src/services/context-manager.ts` — directory-tree diffing so unchanged trees skip the prompt rebuild (Stage 4).
- `server/src/providers/anthropic.ts` (again) — input-rate-limit-aware 429 handling (Stage 5): when error body matches `input tokens per minute`, longer backoff + DON'T trim `max_tokens` (output cap is the wrong axis).
- New tests across each stage.

## Migrations / data

N/A. Pure server-side refactor; no schema changes.

## Hooks / skills / settings to update

- New feature flag `reasoning.upfront_parallelization_enabled` (default true after Stage 1 lands). Lets ops kill the parallel path if a regression surfaces.
- New feature flag `reasoning.combined_preflight_call_enabled` (default true after Stage 2 lands). Falls back to the parallelized 5-call path on disable — preserves Stage 1's value as a graceful degradation.
- New flag `provider.anthropic_prompt_caching_enabled` (Stage 3).

## Dependencies

- No new packages. `cache_control` is a request-body field on existing Anthropic API.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Parallel calls hammer the rate-limit at the SAME TIME instead of spread out → bigger 429 spike | Stage 1 ships behind a kill-switch flag. If 429s worsen, ops can re-serialize. Stage 2 (1 call total) closes this anyway. |
| Merged combined-schema brief loses fidelity vs 5 separate calls | Combined pipeline reuses the same per-section reasoning prompts inside ONE call. Schema validation per section pinned by Zod. A/B test by feature flag: existing 5-call path remains as fallback during rollout. |
| Prompt caching changes prompt structure and breaks the reasoning chain's expected context | Cache markers placed AT THE END of stable segments only (system prompt + project memory). Per-turn dynamic content stays uncached. |
| Directory-tree diffing misses a real change → agent acts on stale state | Diff is per-run, not per-process. Restart of run rebuilds full context. Tree diff is hashed; mismatched hash forces full re-send. |
| Anthropic input-rate detection regex over-matches and incorrectly extends backoff on unrelated 429s | Test fixtures pin the matched error bodies (real Anthropic 429 payloads); regex requires the exact phrase "input tokens per minute". |

## Implementation order

### Stage 1 — Parallelize the independent upfront calls (latency win, 0 call count change)

Wall-clock cut from `~SUM(5 calls)` to `~MAX(3 calls) + MAX(2 calls)`. Roughly **60% latency reduction with NO change in call count or reasoning value**.

Phase A (parallel): `[projectInit, preflight, intent]` via `Promise.all`.
Phase B (parallel after A): `[implement_elaborate, chunk_plan]` via `Promise.all`, gated on preflight's result.

Tests: ~4 new tests pinning the phasing (order of awaits, correct inputs to dependent calls, error isolation — one failure doesn't kill the others).

**Lands first because it's the highest-value-per-line-changed.**

### Stage 2 — Combined `preflight_combined` pipeline (call-count win)

New pipeline with combined schema:

```ts
combinedPreflightSchema = z.object({
  projectInit: projectInitSchema.nullable(),
  preflight: preflightBriefSchema,
  intent: intentBriefSchema,
})
```

ONE Flash call replaces project-init + preflight + intent. The model produces all three in one structured envelope. Implement_elaborate + chunk_plan still fire after (they depend on preflight); Stage 2 doesn't merge them since their inputs differ from the upfront inputs.

**4-19 calls → 2-3 calls.** Rate-limit pressure largely solved.

Feature-flag gated; fallback to Stage 1's parallel path on disable. ~8 tests.

### Stage 3 — Anthropic `cache_control` prompt caching

Mark system prompt + project memory blocks as cacheable. Anthropic's API:

```ts
messages: [{
  role: "user",
  content: [
    { type: "text", text: stableSystemPrompt, cache_control: { type: "ephemeral" } },
    { type: "text", text: dynamicPerTurnContent }
  ]
}]
```

Cached tokens cost ~10% of normal AND don't count against the input-tokens-per-minute bucket on most tiers. ~70% input-token reduction on multi-turn runs.

OpenRouter has similar support for some upstream models; out of scope for Stage 3 (Anthropic is the user's current pain point).

~6 tests pinning the cache-control envelope shape.

### Stage 4 — Directory-tree diff: skip re-sending when unchanged

Compute a hash of the directory tree on each turn. Compare to the prior turn's hash stored in run context. If unchanged, omit the directory tree from the system prompt entirely; reference "(unchanged since last turn)" in its place.

Saves 200-2000 input tokens per turn on stable projects. Stacks with Stage 3 caching.

~4 tests.

### Stage 5 — Input-rate-limit-aware 429 handling

Detect Anthropic's "input tokens per minute" 429 error specifically:

```ts
if (errBody.includes("input tokens per minute")) {
  // Don't trim max_tokens (output cap is wrong axis).
  // Wait at least 60s for the bucket to refill.
  return { backoffMs: 60_000, trimMaxTokens: false }
}
```

Replaces the current exponential backoff (5s → 10s → 20s) + max_tokens halving (which doesn't help input limits). Optional: auto-fallback to a different reasoner backend when sustained 429s exhaust the retry budget.

~5 tests + the user-repro 429 body as a fixture.

### Stage 6 — KB entries + plan archive + telemetry

- `decisions.md`: "Upfront reasoning is parallelized + combined to minimize wall-clock and rate-limit cost"
- `gotchas.md`: "Input-rate-limit 429s are NOT helped by reducing max_tokens; trim INPUT not OUTPUT"
- New `RunSummary` fields: `upfrontReasoningWallClockMs`, `combinedPreflightCallsCount`, `cacheHitTokens`, `directoryTreeSkipped`
- Move plan to `.claude/plans/applied/`

## Verification

**Stage 1**: parallel-await timing test confirms wall-clock < SUM of individual call durations. Manual: run the Express POS scaffold prompt and observe the `[reasoning]` log entries land near-simultaneously instead of sequentially.

**Stage 2**: feature-flag toggle test. With the flag on, ONE Flash call to the combined pipeline. With it off, falls back to the parallel 5-call path. Manual: log line `[reasoning] combined preflight: 1 call (was 3-15)`.

**Stage 3**: response payload inspection — cache markers present in Anthropic request bodies. Manual: observe input-token usage drop ~70% from turn 2 onward.

**Stage 4**: hash equality test for unchanged dir trees. Manual: prompt twice in the same dir, observe the second prompt's input-token count drops by the tree-size delta.

**Stage 5**: 429-body fixture matches the input-rate regex; backoff extends to 60s; max_tokens NOT trimmed. Manual: re-run the user's claude-sonnet repro and observe `[Anthropic] input-rate 429 — waiting 60s for bucket refill` instead of the 5s→10s→20s + tokens halved cycle.

**Stage 6**: KB entries present + linked from INDEX. Plan in `.claude/plans/applied/`. RunSummary fields surface in `usage.jsonl`.

## Out of scope

- Replacing the chunked-loop's per-chunk planner + reflector with a merged call. Decisions.md explicitly preserved their separation for good reasons; this plan respects it. The cost is per-chunk, not upfront, so it's a smaller pressure point.
- Provider auto-fallback (Anthropic 429 → Gemini Flash for this turn). Listed as a possible Stage 5 extension; deferred to a separate plan if needed.
- Context compression / RAG for project files (the "@Codebase" approach Cursor uses). This is a bigger architectural shift; if Stages 1-4 close the gap, it's not needed.
- Switching `claude-sonnet` users to a cheaper model automatically. Their model choice is intentional; the fix is to make sysflow's reasoning USE that budget more efficiently, not silently swap models.

## Why this order

Stages 1+2 are the user-visible WIN (faster prompts, no rate-limit walls). Stages 3+4 are the per-turn polish. Stage 5 is the safety net. Stage 6 is the bookkeeping.

If Stage 1 alone gets the user unblocked, Stage 2 can land same-day with the combined pipeline. Stages 3-5 stack additively. None are blocked on the previous one — each can be merged + measured independently.
