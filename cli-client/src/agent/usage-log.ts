/**
 * Per-run usage telemetry. One JSONL line per terminal exit (success or
 * failure) appended to <sysbasePath>/usage.jsonl. Entries include just enough
 * to debug a session retroactively without leaking the user's full prompt.
 *
 * Best-effort I/O; never throws.
 */

import fs from "node:fs/promises"
import path from "node:path"

export interface RunSummary {
  runId: string | null
  prompt: string
  model: string
  durationMs: number
  stepCount: number
  toolCount: number
  errorCount: number
  estimatedInputTokens: number
  estimatedOutputTokens: number
  /** Terminal reason from the state machine (e.g. 'completed', 'failed', 'session_expired'). */
  terminalReason: string
  /** Phase 7: number of background jobs started during this run. */
  backgroundJobsRun?: number
  /** Phase 7: number of background jobs that ended in 'failed' status. */
  backgroundJobsFailed?: number
  /** Phase 10: how many chunks the planner emitted during this run. */
  chunkCount?: number
  /** Phase 10: count of successful Gemini Flash returns we OBSERVED on the
   *  client (preflight + chunk_plan + chunk_reflect). Approximate — failed
   *  Flash calls don't produce briefs and aren't counted. */
  flashCallsCount?: number
  /** Phase 11 Stage 6: how many response snapshots arrived with confidence
   *  below 100 (i.e. the awareness loop fired at least one signal that turn).
   *  A coarse "did the detector even notice anything?" signal. */
  divergenceDetections?: number
  /** Phase 11 Stage 6: mean confidence across every awareness snapshot we
   *  observed during the run. Drift indicator — runs that hit ~85 average
   *  are within normal noise; runs averaging <60 should get manual review. */
  divergenceConfidenceAvg?: number
  /** Phase 11 Stage 6: how many times the off-course modal was actually
   *  shown to the user this run (response carried `awarenessChoice: true`).
   *  Target ≤ 0.1/run on aggregate; spikes mean the thresholds need tuning
   *  or the model genuinely went off the rails. */
  autoPauseEvents?: number
  /** Stage E of model-lock-and-portable-reasoning: which reasoner
   *  backend served the run's Flash calls (`"gemini"` / `"anthropic"`
   *  / `"openrouter"`). Captured from the server's first response that
   *  carries `reasonerBackend`. Null on runs where no brief was
   *  produced (legacy fallback, or no API keys configured). Lets
   *  telemetry analysis split metrics by backend so the cost +
   *  reliability of each path can be tracked separately. */
  reasonerBackend?: "gemini" | "anthropic" | "openrouter" | null
  /** Stage 5 of command-first-investigation: count of safe-read-only
   *  `run_command` calls the agent dispatched during the run. Counted
   *  at CLI dispatch time via `isSafeReadOnlyCommand` so denied / failed
   *  commands still register — the metric measures the agent's intent
   *  to investigate, not its success rate. Target trend after this
   *  plan: ≥ 2 for non-trivial implement/bug runs, ~0 for trivial
   *  one-line fixes (the LLM should skip investigation for obvious work). */
  investigationCommandsCount?: number
  /** Stage 5 of llm-iterative-intent-classification: which
   *  classification path resolved the run's intent. See
   *  `server/src/types.ts: ClientResponse.intentClassificationSource`
   *  for the value semantics. Captured on the first response that
   *  carries it (constant for the run); null on legacy runs where
   *  the server hasn't shipped the field yet. */
  intentClassificationSource?: "cache" | "regex_simple" | "regex_confident" | "regex_fallback" | "chain" | null
  /** Stage 3 of forced-error-reasoning plan: which error-reasoning
   *  path resolved the run's most-recent error.
   *    `"chain"`         — LLM iterative chain committed.
   *    `"bug_fallback"`  — chain returned null; existing on-error
   *                        bug pipeline (Phase 5) produced the brief.
   *    `null`            — no error fired this run, OR the run is
   *                        from before this telemetry field shipped. */
  errorReasoningSource?: "chain" | "bug_fallback" | null
  /** Stage 6 of forced-error-reasoning plan: per-run count of error-
   *  reasoning chain invocations. Each tool error that fires the
   *  chain (whether the chain commits or falls back) increments this.
   *  Defaults to 0 on runs without errors so jq distributions don't
   *  need a null check. */
  errorReasoningEvents?: number
  /** Stage 6: peak per-run count of Stage 4 error-acknowledgement
   *  rejections. Reflects how often the model needed a stronger
   *  reject-prompt to engage with a prior tool error. Capped at
   *  `MAX_ERROR_ACK_REJECTIONS` (3) per error; sustained high values
   *  here on free-tier runs suggest the Stage 3 inject block isn't
   *  carrying enough weight. Defaults to 0. */
  errorAcknowledgementRejections?: number
  /** Stage 5 of agent-runtime-fixes plan: the project-init reasoner's
   *  repoState verdict (constant for the run). Null on runs that
   *  didn't fire project-init (flag off, no reasoner backend, or
   *  legacy pre-Stage-1 runs). */
  projectInitRepoState?: "empty" | "small" | "existing-small" | "existing-large" | null
  /** Stage 5: the project-init reasoner's confidence. Null sentinel
   *  on runs without a project-init brief. Useful for jq /
   *  distribution analysis: HIGH proportion ≈ classification is
   *  unambiguous most of the time; spikes in MEDIUM / LOW mean the
   *  tree-shape rubric needs tuning. */
  projectInitConfidence?: "HIGH" | "MEDIUM" | "LOW" | null
  /** Stage 5: per-run count of web_search calls that returned 0 hits.
   *  Defaults to 0. Sustained nonzero values mean Stage 2's prompt-
   *  level gating isn't tight enough; the agent is still issuing
   *  premature / over-specific queries. */
  webSearchEmptyCount?: number
  /** Stage 5: per-run count of times the user pressed `r` to expand
   *  the reasoning peek. Defaults to 0. High values mean the
   *  truncation cap (MAX_PARAGRAPH_LINES=3, MAX_PARAGRAPH_CHARS=180)
   *  is too tight for typical chains; low/zero values mean it's fine. */
  reasoningPeekExpansions?: number
  /** Stage 4 of reasoning-chain-provider-parity plan: per-run count
   *  of turns where the model emitted `reasoningChain[]` as a
   *  non-empty array (the post-Stage-2 directive working as intended).
   *  Defaults to 0. */
  reasoningChainEmittedTurns?: number
  /** Stage 4: per-run count of turns where only singular `reasoning`
   *  was present and Stage 1's normaliser fallback synthesised the
   *  chain. Distribution-wise, spike here = MANDATORY directive being
   *  ignored = need to tighten further or model-specific shim. */
  reasoningChainSynthesisedTurns?: number
  /** Stage 5 of plan 2026-05-16-server-hardening-and-error-source-distinction.md.
   *  Per-run count of failed responses tagged `errorSource: "sysflow_infra"`
   *  (sysflow's own API quota / auth / 5xx). Should be ≤ 1 most runs;
   *  spike = something wrong with our backend / API keys / quotas. */
  sysflowInfraErrorCount?: number
  /** Stage 5: per-run count of client-side unknown-tool rejections
   *  via `isKnownTool` gate. Spike = the model is hallucinating tool
   *  names (not in the registry) — signal to tighten the tool-list
   *  section of the system prompt. */
  nullToolRejectionCount?: number
  /** Stage 5: per-run count of 5xx responses the cli refused to retry
   *  via `NonRetryableError` (Stage 3 detector). Spike = the server is
   *  emitting more validation / constraint-violation 5xx than normal —
   *  signal to investigate the request-shaping path. */
  nonRetryable5xxCount?: number
  /** Stage 5 of plan 2026-05-16-agent-code-correctness-and-completion-artifacts.md.
   *  Per-run total of imports stripped by Stage 2's loud sanitizer.
   *  Spike = the model is writing forward references regularly =
   *  Stage 1's rules not landing OR batching/ordering needs Plan 4. */
  importsStrippedCount?: number
  /** Stage 5: peak tsc error count when Stage 3's gate fired. 0
   *  when the gate didn't fire OR typecheck passed. */
  tscErrorCount?: number
  /** Stage 5: which completion-time gate blocked the run, if any.
   *  Last-write-wins across multiple completion attempts in a run.
   *    "tsc"              — Stage 3 tsc gate fired
   *    "artifact_missing" — Stage 4 artifact gate fired
   *    null               — neither fired; completion succeeded
   *                         (or run terminated for a different reason) */
  completionBlockedReason?: "tsc" | "artifact_missing" | null
  /** Stage 5 of plan 2026-05-16-awareness-and-verification-correctness.md.
   *  Per-run count of legitimate top-level dotfiles (.env*, .gitignore,
   *  .eslintrc*, etc.) the Stage 1 conservative filter preserved that
   *  the pre-Stage-1 strip-all-dots filter would have dropped. Spike =
   *  Stage 1 is doing useful work on this scaffold style. 0 = no
   *  dotfiles authored (also fine — no false stale signals to suppress). */
  dotfileFilterCorrections?: number
  /** Stage 5: peak cumulative count of intent-keyword satisfactions
   *  satisfied via Stage 2's broader haystack (Tier 2 structural OR
   *  Tier 3 content). Tier 1 path hits don't count — those passed the
   *  pre-Stage-2 detector too. Captured from `response.intentKeyword-
   *  ContentMatches`; cli takes the peak across turns since the server-
   *  side counter is monotonic. */
  intentKeywordContentMatches?: number
  /** Stage 5: true if Stage 3's blocked-state off-course modal actually
   *  rendered to the user this run. Latched once-true and stays true
   *  for the run's remaining turns. Defaults to false. */
  awarenessModalShown?: boolean
  /** Stage 5: per-run count of Stage 4 PowerShell-error catches —
   *  times the cli's stderr scanner flagged a cmdlet-binding failure
   *  (FullyQualifiedErrorId etc.) that would otherwise have been
   *  reported as success. Spike on Windows runs = the model is still
   *  emitting bash forms PowerShell rejects = Stage 4.1's platform-
   *  aware prompt isn't fully landing yet. */
  windowsShellErrorsCaught?: number
  /** Stage 6 of plan 2026-05-16-accountability-and-parallel-execution-sequencing.md.
   *  Largest `tools[]` batch size observed on a response this run.
   *  Distribution-wise, high values mean the model is reaching for
   *  parallel scaffold patterns; Stage 1's cli-side cap (3 by
   *  default, 5 for existing-large) keeps the actual wire-side
   *  batch bounded regardless. Defaults to 0. */
  maxBatchSize?: number
  /** Stage 6: per-run count of cli batches where Stage 1's cap was
   *  enforced (at least one tool deferred). Diagnostic for
   *  "is the agent regularly trying to emit oversized batches?". */
  batchCapEnforcedCount?: number
  /** Stage 6: per-run count of cli batches where Stage 2's topo
   *  sort reordered the writes OR rejected an import cycle.
   *  Diagnostic for "does the model commonly emit consumer-before-
   *  producer batches?". Spike on free-tier = the rules-in-prompt
   *  aren't landing; reactive topo-sort doing real work. */
  reorderedBatchCount?: number
  /** Stage 6: per-run count of Stage 4 already-created-guard
   *  rejections. Spike = the model is re-writing files it already
   *  wrote within the run. */
  alreadyCreatedRejectionCount?: number
  /** Stage 6: peak per-run count of Stage 5 per-file-reasoning
   *  gate rejections (server-side; surfaced via
   *  ClientResponse.insufficientReasoningRejectionCount). Spike = the
   *  model is emitting oversized batches with terse reasoning. */
  insufficientReasoningRejectionCount?: number
  /** Stage 6 of plan 2026-05-18-ui-ux-polish-and-action-aware-spinner.md.
   *  Count of times Stage 1's resize-pause window fired this run.
   *  Diagnostic for the load-bearing scroll-glitch fix: if this counter
   *  is consistently > 0 on runs where users report glitches, the
   *  debounce is firing as designed. Zero is the common case. */
  scrollGlitchPauseFiredCount?: number
  /** Stage 6: latched true if Stage 2's spinner-label resolver returned
   *  an action-aware label (vs falling through to the verb cycle) at
   *  any point this run. False on runs with no tool dispatches. */
  spinnerActionLabelFired?: boolean
  /** Stage 6: latched true if Stage 5's run_command stream preview
   *  rendered at any point this run. False on runs with no run_command
   *  dispatches. */
  streamPreviewEverShown?: boolean
  /** Stage 6: latched true if Stage 4's sysflow_infra ErrorBanner
   *  rendered this run. False on the common case (no infra failure). */
  infraErrorBannerShown?: boolean
  /** Stage 6: count of times the permission modal mounted this run.
   *  Diagnostic for permission-mode UX: high counts on `ask` mode
   *  runs suggest click-fatigue. */
  permissionModalShownCount?: number
}

const PROMPT_PREVIEW_CHARS = 200

export async function recordRunSummary(sysbasePath: string | undefined | null, summary: RunSummary): Promise<void> {
  if (!sysbasePath) return
  const file = path.join(sysbasePath, "usage.jsonl")
  const entry = {
    ts: new Date().toISOString(),
    runId: summary.runId,
    prompt: (summary.prompt || "").slice(0, PROMPT_PREVIEW_CHARS),
    model: summary.model,
    durationMs: summary.durationMs,
    stepCount: summary.stepCount,
    toolCount: summary.toolCount,
    errorCount: summary.errorCount,
    estimatedInputTokens: summary.estimatedInputTokens,
    estimatedOutputTokens: summary.estimatedOutputTokens,
    terminalReason: summary.terminalReason,
    backgroundJobsRun: summary.backgroundJobsRun ?? 0,
    backgroundJobsFailed: summary.backgroundJobsFailed ?? 0,
    chunkCount: summary.chunkCount ?? 0,
    flashCallsCount: summary.flashCallsCount ?? 0,
    divergenceDetections: summary.divergenceDetections ?? 0,
    // null sentinel when no awareness snapshots were observed (awareness
    // disabled, or run terminated before any chunked-loop response landed).
    divergenceConfidenceAvg: typeof summary.divergenceConfidenceAvg === "number"
      ? Math.round(summary.divergenceConfidenceAvg * 10) / 10
      : null,
    autoPauseEvents: summary.autoPauseEvents ?? 0,
    // Stage E of model-lock-and-portable-reasoning. Null sentinel when
    // no brief landed during the run (legacy fallback path) so jq /
    // analysis tools can distinguish "no reasoning happened" from "no
    // such field was logged".
    reasonerBackend: summary.reasonerBackend ?? null,
    // Stage 5 of command-first-investigation. Defaults to 0 (omitted
    // → no investigation observed) since the cli always counts when
    // the field flows.
    investigationCommandsCount: summary.investigationCommandsCount ?? 0,
    // Stage 5 of llm-iterative-intent-classification. Null sentinel
    // on runs where the server didn't ship the field (legacy or pre-
    // Stage-4) so jq / analysis tools can distinguish "no signal"
    // from "field not logged".
    intentClassificationSource: summary.intentClassificationSource ?? null,
    // Stage 3 of forced-error-reasoning plan. Null sentinel on runs
    // where no error fired (most runs) so the distribution of `chain`
    // vs `bug_fallback` is countable.
    errorReasoningSource: summary.errorReasoningSource ?? null,
    // Stage 6 of forced-error-reasoning plan. Defaults to 0 (omitted
    // → no error reasoner fired this run) since a chain invocation
    // always increments client-side when observed.
    errorReasoningEvents: summary.errorReasoningEvents ?? 0,
    errorAcknowledgementRejections: summary.errorAcknowledgementRejections ?? 0,
    // Stage 5 of agent-runtime-fixes plan. Null sentinels on runs
    // without a project-init brief so jq / analysis tools can
    // distinguish "no signal" from "field not logged".
    projectInitRepoState: summary.projectInitRepoState ?? null,
    projectInitConfidence: summary.projectInitConfidence ?? null,
    webSearchEmptyCount: summary.webSearchEmptyCount ?? 0,
    reasoningPeekExpansions: summary.reasoningPeekExpansions ?? 0,
    // Stage 4 of reasoning-chain-provider-parity. Defaults to 0 so
    // jq distributions stay null-free.
    reasoningChainEmittedTurns: summary.reasoningChainEmittedTurns ?? 0,
    reasoningChainSynthesisedTurns: summary.reasoningChainSynthesisedTurns ?? 0,
    // Stage 5 of server-hardening plan. Defaults to 0.
    sysflowInfraErrorCount: summary.sysflowInfraErrorCount ?? 0,
    nullToolRejectionCount: summary.nullToolRejectionCount ?? 0,
    nonRetryable5xxCount: summary.nonRetryable5xxCount ?? 0,
    // Stage 5 of code-correctness plan. Defaults to 0 / null so
    // jq distributions stay null-free + sentinel-clean.
    importsStrippedCount: summary.importsStrippedCount ?? 0,
    tscErrorCount: summary.tscErrorCount ?? 0,
    completionBlockedReason: summary.completionBlockedReason ?? null,
    // Stage 5 of awareness-and-verification-correctness plan.
    dotfileFilterCorrections: summary.dotfileFilterCorrections ?? 0,
    intentKeywordContentMatches: summary.intentKeywordContentMatches ?? 0,
    awarenessModalShown: summary.awarenessModalShown ?? false,
    windowsShellErrorsCaught: summary.windowsShellErrorsCaught ?? 0,
    // Stage 6 of accountability-and-parallel-execution-sequencing plan.
    maxBatchSize: summary.maxBatchSize ?? 0,
    batchCapEnforcedCount: summary.batchCapEnforcedCount ?? 0,
    reorderedBatchCount: summary.reorderedBatchCount ?? 0,
    alreadyCreatedRejectionCount: summary.alreadyCreatedRejectionCount ?? 0,
    insufficientReasoningRejectionCount: summary.insufficientReasoningRejectionCount ?? 0,
    // Stage 6 of ui-ux-polish plan.
    scrollGlitchPauseFiredCount: summary.scrollGlitchPauseFiredCount ?? 0,
    spinnerActionLabelFired: summary.spinnerActionLabelFired ?? false,
    streamPreviewEverShown: summary.streamPreviewEverShown ?? false,
    infraErrorBannerShown: summary.infraErrorBannerShown ?? false,
    permissionModalShownCount: summary.permissionModalShownCount ?? 0,
  }
  try {
    await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8")
  } catch (err) {
    console.warn(`[usage-log] append failed:`, (err as Error).message)
  }
}
