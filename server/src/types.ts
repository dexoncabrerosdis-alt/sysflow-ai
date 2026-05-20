// ─── Directory Tree ───

export interface DirectoryEntry {
  name: string
  type: "file" | "directory"
}

// ─── Provider Payload & Response ───

export interface ToolResult {
  tool: string
  result: Record<string, unknown>
}

export interface ToolCall {
  id: string
  tool: string
  args: Record<string, unknown>
}

export interface BatchToolResult {
  id: string
  tool: string
  result: Record<string, unknown>
}

export interface ProviderPayload {
  model: string
  runId: string
  userMessage: string
  directoryTree: DirectoryEntry[]
  context: ProviderContext
  toolResult?: ToolResult
  toolResults?: BatchToolResult[]
  task?: TaskMeta
  userId?: string | null
  chatId?: string | null
  command?: string
  /** Absolute path of the user's project root — used for project-memory discovery. */
  cwd?: string
  /** When true, the prompt's plan-mode section is injected and the agent stays read-only. */
  planMode?: boolean
  /** Phase 5 reasoning brief from preflight / on-error / on-completion. Untyped here to avoid an import cycle. */
  reasoningBrief?: unknown
  /** Phase 16 Stage 3 chained-preflight elaboration brief. Set only when the
   *  free-tier elaboration gate matches (free-tier model + complexity ≥
   *  medium + preflight confidence < HIGH); otherwise omitted. The prompt
   *  builder renders it as a "DEEPER REASONING" sub-block under the
   *  implement brief. Untyped to avoid an import cycle. */
  reasoningElaborationBrief?: unknown
  /** Stage 3 of forced-error-reasoning plan: set by `tool-result.ts`
   *  when an inbound tool error fired the error-reasoning chain and
   *  the chain returned a brief. The provider's
   *  `buildToolResultMessage` reads this and injects the
   *  `═══ ERROR — REASON THROUGH THIS ═══` block at the end of the
   *  tool-result body. Untyped to avoid an import cycle with the
   *  reasoning module. */
  errorReasoningBrief?: unknown
  /** Stage 3: verbatim error text for the block to quote. Set
   *  alongside `errorReasoningBrief`. */
  errorReasoningErrorText?: string
  /** Stage 3: tool name that failed (`run_command`, `write_file`, etc.).
   *  Set alongside `errorReasoningBrief`. */
  errorReasoningFailedTool?: string
  /** Phase 10 chunked-loop planner brief — when set, the prompt builder injects "files: [...]" so the model honours the chunk's file list exactly. Untyped to avoid an import cycle. */
  chunkPlanBrief?: unknown
  /** Stage 1 of agent-runtime-fixes plan: project-init reasoner brief.
   *  Set ONCE per run on the initial user_message turn. The prompt builder
   *  reads `repoState` + `investigationPlan` + `keyMarkers` and renders the
   *  `═══ PROJECT STATE ═══` block so the agent's first move knows whether
   *  the repo is empty (scaffold) or large (investigate first). Untyped to
   *  avoid an import cycle with the reasoning module. */
  projectInitBrief?: unknown
  /** Phase 18 Stage 5: classified intent for the run, resolved by
   *  `classifyIntent(run.content)` at the handler entry. Threaded to
   *  the system-rules section so the taskPlan instruction is
   *  conditional (only `implement` runs ask for a taskPlan; other
   *  pipelines instruct the model to OMIT it). Same classification
   *  the cli's <AgentStream> uses to gate the task box (Phase 19) —
   *  server emission gating + frontend render gating compose as
   *  defense-in-depth. */
  runIntent?: "simple" | "summary" | "bug" | "implement" | null
  /** Phase 18 Stage 5: task complexity from `analyzeTaskComplexity`,
   *  resolved at the handler entry. Threaded into the system-rules
   *  section: even on `implement` runs, simple-complexity tasks
   *  (typo fix, one-line rename, "add a console.log") omit the
   *  taskPlan instruction. The model's per-turn output then doesn't
   *  carry a taskPlan ceiling the conversation. */
  taskComplexity?: "simple" | "medium" | "complex" | null
  /**
   * Stage 4.1 of awareness-and-verification-correctness plan: the
   * USER's platform as reported by the cli's `client.platform` field
   * on the initial user_message. Threaded through every provider
   * call so the prompt-builder's env-info section renders bash vs
   * PowerShell command examples matching the user's OS — NOT the
   * server's. Without this, our SaaS deployment (server on linux)
   * told every Windows user the platform was `linux` and they should
   * use bash, which is why the model kept emitting `ls -la` on
   * Windows.
   *
   * Fallback chain when undefined: `process.platform` (server's own).
   * Same shape as `NodeJS.Platform` but typed loosely so the type
   * survives JSON round-trip from the cli.
   */
  clientPlatform?: string
}

export interface ProviderContext {
  sessionHistory?: string
  continueFrom?: ContinueFrom
  continueContext?: string
  projectMemory?: string[] | string
  projectKnowledge?: string
  /** Managed working context from ContextManager — compressed, verified facts only */
  workingContext?: string
  /** Frontend design patterns injected when a frontend task is detected */
  frontendPatterns?: string
}

export interface ContinueFrom {
  outcome: string
  prompt: string
  error?: string
  filesModified: string[]
  actions: Array<{ tool: string; path?: string }>
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  generationData?: Record<string, unknown> | null
}

export interface NormalizedResponse {
  kind: "needs_tool" | "completed" | "failed" | "waiting_for_user" | "rate_limited"
  content?: string
  reasoning?: string | null
  tool?: string
  args?: Record<string, unknown>
  tools?: ToolCall[]
  error?: string
  usage: TokenUsage
  summary?: string | null
  task?: TaskMeta | null
  taskStep?: string | null
  stepTransition?: { complete?: string; start?: string }
  pendingAction?: unknown
  /** AI-generated task plan from first response */
  taskPlan?: { title: string; steps: string[] } | null
  /** Phase 15 Stage 4: model-driven memory feedback. Lists entry ids the
   *  model confirms it used and ids it contradicts. The handler processes
   *  this via `applyMemoryFeedback`, which cross-validates each id
   *  against the response text before mutating the store. */
  memoryFeedback?: { confirmed?: string[]; contradicted?: string[] } | null
  /**
   * Stage 1.5 of command-first-investigation plan: per-turn plain-prose
   * deliberation produced by the MAIN model on each `needs_tool` /
   * `completed` response. Mirrors the preflight reasoner's
   * `reasoningChain[]` from Stage C of model-lock-and-portable-reasoning,
   * but populated turn-by-turn so the agent's deliberation streams as
   * one-thought-per-LLM-call. Each entry is a mid-to-long paragraph
   * (3-6 sentences). Cap of 6 entries per turn — per-turn deliberation
   * is lighter than preflight's 10-entry chain.
   *
   * Surfaces in the CLI as `log` events so the user sees the agent
   * reasoning between commands. Omitted on trivial turns where there's
   * nothing meaningful to deliberate about.
   */
  reasoningChain?: string[]
  /**
   * Stage 2 of plan 2026-05-16-server-hardening-and-error-source-distinction.md.
   *
   * Discriminator for where the error originated. Threaded from
   * provider failure paths through to `ClientResponse` so the cli
   * and the agent can distinguish:
   *
   *   - "sysflow_infra" — sysflow's own backend / API quota / auth /
   *     DB connection failed. The user can't fix this from inside
   *     their project — they must top up credits, switch models with
   *     /model, set an env var, etc. The agent's error-reasoning
   *     chain should NOT fire (recovery is impossible); the cli
   *     surfaces a clear banner and halts the run.
   *
   *   - "user_machine" — tool execution failed on the user's machine
   *     (file not found, permission denied, command not in PATH,
   *     network unreachable from the user's box). The agent's
   *     recovery chain SHOULD fire — these are the errors the
   *     existing forced-error-reasoning plan was built for.
   *
   *   - "unknown" / undefined — fallback. Treated as user_machine
   *     for the recovery path. Legacy code paths get this default.
   */
  errorSource?: "sysflow_infra" | "user_machine" | "unknown"
}

// ─── Task ───

export interface TaskStep {
  id: string
  label: string
  status: "pending" | "in_progress" | "completed" | "failed"
}

export interface TaskMeta {
  id: string
  runId: string
  projectId: string
  model: string
  title: string
  goal: string
  steps: TaskStep[]
  status: "running" | "completed" | "failed"
}

// ─── Run ───

export interface RunState {
  id: string
  taskId: string
  projectId: string
  model: string
  status: "running" | "completed" | "failed"
  userId?: string | null
  chatId?: string | null
}

// ─── Client Response ───

/** Stable error codes the CLI can switch on instead of string-matching `error`. */
export type ServerErrorCode =
  | "usage_limit"
  | "rate_limit"
  | "session_expired"
  | "prompt_too_long"
  | "malformed_response"
  | "unknown"

export interface ClientResponse {
  status: "needs_tool" | "completed" | "waiting_for_user" | "failed"
  runId: string
  tool?: string
  args?: Record<string, unknown>
  tools?: ToolCall[]
  content?: string | null
  reasoning?: string | null
  message?: string | null
  summary?: string | null
  task?: TaskMeta | null
  taskStep?: string | null
  stepTransition?: { complete?: string; start?: string }
  pendingAction?: unknown
  error?: string
  /** Stable code for the CLI; `error` remains the human-readable string. */
  errorCode?: ServerErrorCode
  /** Phase 5: optional reasoning brief produced by the pre-flight / on-error / on-completion / self-invoked triggers. */
  reasoningBrief?: unknown
  /**
   * Stage E of model-lock-and-portable-reasoning: which reasoner
   * backend served the run's Flash calls (`"gemini"` / `"anthropic"` /
   * `"openrouter"`). Attached by the user-message + tool-result
   * handlers when a brief was produced for the run; absent otherwise.
   * Telemetry-only — the CLI records it in `RunSummary` and writes the
   * `usage.jsonl` line at terminal exit. Constant for the duration of
   * a run (env doesn't shift mid-run), so observing it on any response
   * is sufficient.
   */
  reasonerBackend?: "gemini" | "anthropic" | "openrouter" | null
  /**
   * Phase 19: the classified intent for this run, computed by
   * `classifyIntent(content)` in user-message.ts. The CLI's reducer
   * reads this on the first response and stores it in `runIntent` so
   * the <AgentStream> gate can decide whether the task box renders.
   * Constant for the duration of a run; the value is the same as
   * what the preflight reasoner's `pickPipeline` chose so the cli
   * and server share one classification.
   */
  runIntent?: "simple" | "summary" | "bug" | "implement" | null
  /**
   * Stage 5 of plan 2026-05-15-llm-iterative-intent-classification.md:
   * which classification path resolved this run's intent.
   *   - `"cache"`           — subsequent turn after the first one
   *                           classified it. Most turns of an
   *                           established run.
   *   - `"regex_simple"`    — fast-path: SIMPLE_PATTERNS matched
   *                           (continuation phrase / bare `ls` /
   *                           `/list` / …). No LLM call.
   *   - `"chain"`           — LLM iterative paragraph chain
   *                           committed the result. The happy path
   *                           for non-trivial prompts.
   *   - `"regex_fallback"`  — chain returned null (no API key /
   *                           parse fail / cap without commit) so
   *                           the regex's result was used. Worst
   *                           case is pre-plan behaviour.
   *   - `null`              — pre-Stage-4 surface, classification
   *                           didn't run (shouldn't happen on first
   *                           response after Stage 4 ships).
   *
   * Surfaced once per run on the initial response — constant for the
   * rest of the run since the cache holds the value. CLI captures
   * via the same first-observation-wins pattern as `reasonerBackend`.
   */
  intentClassificationSource?: "cache" | "regex_simple" | "regex_confident" | "regex_fallback" | "chain" | null
  /**
   * Stage 5: the LLM chain's senior-engineer paragraphs, when
   * `intentClassificationSource === "chain"`. Surfaces in
   * `<ReasoningPeek>` via a synthetic `reasoning_brief` event so the
   * user sees the model's deliberation. Absent on non-chain paths
   * (no paragraphs to render). Same shape as the brief envelope's
   * `reasoningChain[]` so the existing plain-prose render path
   * (PR #83) picks them up without any new render code.
   */
  intentClassificationParagraphs?: string[]
  /**
   * Stage 3 of forced-error-reasoning plan: the LLM chain's senior-
   * engineer paragraphs when an error-reasoning brief was produced
   * for this turn. CLI surfaces them in `<ReasoningPeek>` via the
   * existing `reasoning_brief` event mechanism (same path PR #83's
   * plain-prose render handles).
   */
  errorReasoningParagraphs?: string[]
  /**
   * Stage 3: telemetry of the error-reasoning source. Useful for
   * usage.jsonl analysis — `"chain"` means the LLM committed;
   * `"bug_fallback"` means the chain returned null and the existing
   * bug pipeline (Phase 5) provided the brief instead; `null` means
   * no error fired this turn.
   */
  errorReasoningSource?: "chain" | "bug_fallback" | null
  /**
   * Stage 6 of forced-error-reasoning plan: running per-run count of
   * Stage 4 error-acknowledgement rejections. The handler tracks this
   * server-side via `errorAcknowledgementRejections: Map<runId, number>`;
   * we surface the latest value on every tool-result response so the
   * CLI can capture max-observed for `RunSummary.errorAcknowledgementRejections`.
   * Absent on responses that don't touch the error-reasoning path.
   */
  errorAckRejectionCount?: number
  /**
   * Stage 1 of agent-runtime-fixes plan: project-init reasoner's
   * paragraphs for `<ReasoningPeek>`. Surfaces on the first response
   * of each run when the chain committed. Absent when no project-init
   * brief was produced (flag off / no reasoner backend / chain
   * returned null).
   */
  projectInitParagraphs?: string[]
  /**
   * Stage 1: the classifier's verdict, constant for the run. Used
   * for telemetry (`RunSummary.projectInitRepoState`) and for the cli
   * to render appropriate UI hints (e.g. "scaffolding from scratch"
   * label when `empty`).
   */
  projectInitRepoState?: "empty" | "small" | "existing-small" | "existing-large" | null
  /**
   * Stage 1: confidence of the project-init brief. Useful for jq /
   * analysis tools to slice telemetry by how sure the classifier was.
   */
  projectInitConfidence?: "HIGH" | "MEDIUM" | "LOW" | null
  /**
   * Stage 3 of agent-runtime-fixes plan: the per-turn senior-engineer
   * `reasoningChain[]` paragraphs the main model emitted on this response.
   * Surfaced so the cli can emit a fresh `reasoning_brief` event with
   * `kind: "per_turn"` — closes bug 6 (the peek was stuck on the FIRST
   * brief because no later events surfaced the per-turn deliberation).
   * Absent on turns where the model didn't emit a chain (most trivial
   * turns).
   */
  perTurnReasoningChain?: string[]
  /**
   * Stage 4 of reasoning-chain-provider-parity plan: classifies the
   * source of `perTurnReasoningChain` so cli telemetry can distinguish
   * structured-chain emissions from singular-reasoning fallbacks.
   *   - `"structured"` — model emitted a non-empty `reasoningChain[]`.
   *   - `"synthesised"` — only singular `reasoning` present; Stage 1's
   *     fallback synthesised a one-element chain.
   *   - `null` — neither path produced anything.
   * Cli accumulates per-run counts into RunSummary.
   */
  perTurnReasoningSource?: "structured" | "synthesised" | null
  /**
   * Stage 2 of plan 2026-05-16-server-hardening-and-error-source-distinction.md.
   *
   * Where the error originated. See the matching field on
   * `NormalizedResponse` for the full taxonomy. When present on a
   * `failed` envelope:
   *   - "sysflow_infra" → cli renders a banner + halts; agent's
   *     error-reasoning chain does NOT fire.
   *   - "user_machine" → existing recovery path applies.
   *   - "unknown" / absent → fallback to user_machine semantics
   *     (preserves legacy behaviour).
   */
  errorSource?: "sysflow_infra" | "user_machine" | "unknown"
  /**
   * Stage 5 of plan 2026-05-16-agent-code-correctness-and-completion-artifacts.md.
   *
   * Surfaced when a completion-time gate (Stage 3 tsc / Stage 4
   * artifact) overrode a `completed` envelope to `needs_tool`. The
   * cli reads this to increment per-run RunSummary counters.
   */
  completionBlockedBy?: "tsc" | "artifact_missing" | null
  /** Stage 5: when `completionBlockedBy === "tsc"`, the number of
   *  typecheck errors `tsc --noEmit` reported. */
  completionTscErrorCount?: number
  /** Stage 5 of awareness-and-verification-correctness plan:
   *  cumulative count of intent-keyword satisfactions that came
   *  from Stage 2's broader haystack (structural signal OR content
   *  snippet) rather than Tier 1 file paths. Monotonic per run;
   *  cli RunSummary records the peak. Tier 1 hits (existing
   *  behaviour) don't count — they would have passed the
   *  pre-Stage-2 detector. */
  intentKeywordContentMatches?: number
  /** Stage 6 of accountability-and-parallel-execution-sequencing
   *  plan: peak per-run count of Stage 5's per-file-reasoning gate
   *  rejections. Bounded at MAX_PER_FILE_REASONING_REJECTIONS=3 per
   *  run. Surfaced on every response — cli takes the peak. */
  insufficientReasoningRejectionCount?: number
}

// ─── Database ───

export interface MigrationModule {
  default: {
    name: string
    up: string
  }
}

// ─── Subscription ───

export type PlanId = "free" | "lite" | "pro" | "team"

export interface Plan {
  id: PlanId
  label: string
  price: number
  creditsPerMonth: number
  stripePriceId: string | null
}

export interface Subscription {
  plan: PlanId
  credits_total_cents: number
  credits_used_cents: number
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
}
