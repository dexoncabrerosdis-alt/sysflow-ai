/**
 * Intent classifier — two layers:
 *
 *   1. **Regex** (`classifyIntentByRegex`): cheap synchronous pattern
 *      match. Pre-existing since Phase 5. Catches obvious cases
 *      (bare `ls`, `/continue`, stack-trace shapes, explicit build
 *      verbs at the start of the prompt). Backwards compatible —
 *      every existing sync caller keeps working.
 *
 *   2. **LLM iterative paragraph chain** (`classifyIntentByChain`):
 *      self-directing-depth chain shipped per plan
 *      `.claude/plans/2026-05-15-llm-iterative-intent-classification.md`.
 *      Up to 6 iterations, each emitting one senior-engineer
 *      paragraph + a `done` flag the LLM owns. Eliminates the
 *      regex's compound-noun landmines (e.g. "error handling"
 *      inside a build prompt's feature list).
 *
 * For Stage 1+2 (this PR), the chain is implemented + tested but NOT
 * yet wired into handlers — `classifyIntent` (the existing sync
 * regex export) is unchanged. Stage 4 (later PR) wires async
 * `classifyIntentByChain` through `user-message.ts` + `tool-result.ts`.
 *
 * The regex returns a *hint* — the LLM reasoner can override this if
 * it sees a stronger signal in the full prompt + context. The hint
 * exists to avoid burning a round-trip on prompts that don't need
 * reasoning at all.
 */

import { z } from "zod"
import { callReasonerBackend } from "./backends/index.js"
import { pickReasonerBackend, type ReasonerBackend } from "../services/free-tier-policy.js"
import { getPipelineSystemPrompt } from "./pipelines/index.js"
import { getFlag } from "../services/flags.js"
import { getIntentForRun, setIntentForRun } from "../services/intent-cache.js"

export type IntentHint = "simple" | "bug" | "summary" | "implement"

const SIMPLE_PATTERNS: RegExp[] = [
  /^\s*(list|show|display|cat|print)\s+(files?|dirs?|directory|folder|content)/i,
  /^\s*(list|show|display|cat|print)\s+(me\s+)?(the\s+)?(content\s+of\s+)?[\w./-]+\s*(content)?\s*$/i,
  /^\s*(what|which)\s+(file|dir|folder|module|function|class|export)s?\s+(is|are|does|do|exist)/i,
  /^\s*ls\b/i,
  /^\s*pwd\b/i,
  /^\s*find\s+(files?|all)/i,
  /^\s*open\s+\S+\s*$/i,
  /^\s*read\s+(the\s+)?\S+\s*$/i,
  /^\s*continue\s*$/i,
  /^\s*go\s+on\s*$/i,
  // Continuation phrasings — "continue the task", "keep going",
  // "carry on", "proceed", "finish it", "resume", "go ahead", optionally
  // followed by "the task / previous / work / job / build / implementation".
  // The server-side handler swaps these for the previous run's prompt,
  // so the request is "pick up where we left off" not a fresh implement.
  // No fake task pipeline should appear.
  /^\s*(continue|carry\s+on|keep\s+going|proceed|next|finish(\s+(it|up))?|resume|go\s+ahead)(\s+(the\s+)?((previous|prev|last|same)\s+)?(task|work|job|build|implementation))?\s*[.!?]?\s*$/i,
]

/**
 * Implement-lead anchor: strong build verbs at the very start of the
 * prompt followed by at least some content (`an`/`the`/`me` is allowed
 * between verb and noun). When this matches, the classifier returns
 * `implement` BEFORE the bug check runs.
 *
 * Closes the false-positive where a build prompt mentioning bug-class
 * vocabulary inside its FEATURE LIST mis-routed to the bug pipeline.
 * Concrete reported case (2026-05-15):
 *
 *   "build a Node.js Express PostgreSQL backend for a simple POS system
 *    ... validation middleware, error handling, pagination ..."
 *
 * The `\berror\b` in BUG_PATTERNS matched "error handling" — feature
 * list noun, not a bug report — and the bug pipeline asked the user
 * for symptom / boundary / fix context for an app that didn't exist.
 *
 * Bug-reports open with different verbs (`fix`, `debug`, `why is X
 * failing`) and a stack-trace shape; none of those trip this anchor.
 *
 * Keep the verb list small and specific — adding catch-alls like
 * "do" or "handle" would let bug-reports through (e.g. "do something
 * about this crash").
 */
const IMPLEMENT_LEAD_PATTERNS: RegExp[] = [
  /^\s*(build|create|implement|make|add|set\s+up|scaffold|construct|develop|generate|design|write|spin\s+up|stand\s+up|bootstrap|produce|craft|put\s+together)\b\s+(an?\s+|the\s+|me\s+(an?\s+|the\s+)?)?\w/i,
]

const BUG_PATTERNS: RegExp[] = [
  /\b(fix|debug|broken|broke|fail(ed|ing|s)?|error|exception|crash(ed|ing)?|stack\s*trace)\b/i,
  /\b(not\s+working|doesn'?t\s+work|isn'?t\s+working)\b/i,
  /\b(typeerror|referenceerror|syntaxerror|enoent|eacces|etimedout|econnrefused|ehosturenreach|module\s+not\s+found)\b/i,
  /\bcannot\s+(find|read|access|resolve)\b/i,
  /\bunexpected\s+(token|behavi|error)/i,
  /^\s*why\s+(does|is|do|am|did)/i,
  /\bregression\b/i,
  /^\s*\S+\s*:\s*\S+error\b/i,  // looks like "foo: TypeError"
]

const SUMMARY_PATTERNS: RegExp[] = [
  /^\s*(explain|summari[sz]e|describe|recap|overview)\b/i,
  // Allow one optional word between the article and the noun: "what does the action-planner service do"
  /\b(what\s+does|what\s+is)\s+(this|the|that)\s+(\S+\s+)?(file|module|function|class|component|service|repo|project|code|tool|hook|registry|store|module)/i,
  /\bwalk\s+me\s+through\b/i,
  /^\s*(tldr|tl;dr|tl\s+dr)\b/i,
  /\bgive\s+me\s+(a|an)\s+(summary|overview|breakdown|tour)/i,
  /^\s*how\s+does\s+\S+\s+work\s*\??\s*$/i,
  // "what's on / in / inside this repo / project / dir" — a tour request, not
  // an implementation request. Match "what's", "whats", and "what is".
  /^\s*what(?:'?s|s|\s+is)\s+(on|in|inside|under|at)\s+(this|the|my|our)\b/i,
  // "tell me about ...", "show me what ..."
  /^\s*tell\s+me\s+about\b/i,
  /^\s*show\s+me\s+what\b/i,
  // "any X here", "what kind of X"
  /^\s*what\s+kind\s+of\b/i,
  /^\s*anything\s+(special|interesting|notable)\s+(about|in)\b/i,
]

/**
 * Plan `2026-05-18-reasoning-speed-and-rate-limit-overhaul.md` Stage 3
 * (2026-05-20): detailed regex result. Exposes whether a SPECIFIC
 * pattern matched the prompt or whether we fell through to the
 * default "implement" verdict.
 *
 * Why this distinction matters: `classifyIntentSmart` consults the
 * LLM chain (1-6 Flash calls) to refine the regex's guess. But when
 * a specific pattern matched (IMPLEMENT_LEAD / BUG / SUMMARY / SIMPLE),
 * the regex is high-confidence and the LLM rarely overrides correctly.
 * Trusting the regex on pattern-matched prompts saves 1-6 Flash calls
 * per non-simple prompt — the primary cost driver pre-Stage-3 for
 * implement-class prompts like "build a POS backend with Express".
 */
export interface IntentRegexResult {
  hint: IntentHint
  /** True when one of the four specific pattern arrays matched.
   *  False when the classifier fell through to the default
   *  `implement` verdict at the end. */
  patternMatched: boolean
}

export function classifyIntentDetailed(userMessage: string): IntentRegexResult {
  const msg = (userMessage || "").trim()
  if (msg.length === 0) return { hint: "simple", patternMatched: true }

  // Implement-anchor override: when the prompt opens with a strong
  // implement verb followed by something to build, classify as
  // implement BEFORE the bug check runs. Closes the regression where
  // feature-list nouns like "error handling" tripped `\berror\b` and
  // mis-routed long build prompts to the bug pipeline.
  if (IMPLEMENT_LEAD_PATTERNS.some((re) => re.test(msg))) return { hint: "implement", patternMatched: true }

  // 'bug' has the highest specificity — error keywords trump anything else.
  if (BUG_PATTERNS.some((re) => re.test(msg))) return { hint: "bug", patternMatched: true }

  // 'summary' before 'simple' — "explain X" looks shallow but needs the summary pipeline.
  if (SUMMARY_PATTERNS.some((re) => re.test(msg))) return { hint: "summary", patternMatched: true }

  // Trivial single-action prompts skip reasoning entirely.
  if (SIMPLE_PATTERNS.some((re) => re.test(msg)) && msg.length < 80) return { hint: "simple", patternMatched: true }

  // Default: implement pipeline (fall-through — no specific pattern
  // matched, so the verdict is "least bad guess").
  return { hint: "implement", patternMatched: false }
}

/**
 * Synchronous regex classifier — the existing fast path. Preserved
 * unchanged so every existing caller continues to work without an
 * async migration. Exported under both `classifyIntent` (the
 * historical name) and `classifyIntentByRegex` (the explicit name
 * the new async wrapper falls back to). Thin wrapper over
 * `classifyIntentDetailed` — discards the `patternMatched` flag
 * for callers that only care about the verdict.
 */
export function classifyIntent(userMessage: string): IntentHint {
  return classifyIntentDetailed(userMessage).hint
}

/** Alias of {@link classifyIntent} — explicit name used by the
 *  async chain wrapper's fallback path. */
export const classifyIntentByRegex = classifyIntent

/**
 * Sync helper for callsites that already have a runId from a prior
 * `classifyIntentSmart` call (most commonly `tool-result.ts`'s
 * synchronous response-building code). Reads the per-run cache first;
 * on miss falls back to the regex.
 *
 * Use this instead of `classifyIntent` (raw regex) on any code path
 * that runs AFTER `user-message.ts` already populated the cache.
 * Keeps the resolved intent stable for the lifetime of the run
 * without forcing the caller to become async.
 */
export function getCachedIntentOrRegex(runId: string | null | undefined, userMessage: string): IntentHint {
  return getIntentForRun(runId) ?? classifyIntentByRegex(userMessage)
}

// ─── LLM iterative paragraph chain (Stage 1+2 of plan
// ─── 2026-05-15-llm-iterative-intent-classification.md) ──────────

/** Per-iteration shape the LLM emits. Mirrors the iterative-chain
 *  pattern in `runIterativeChain` (task-reasoner.ts): one paragraph
 *  per call, `done` flag the LLM owns, optional `supersedes` index
 *  for revising a prior paragraph. */
export const intentClassificationStepSchema = z.object({
  paragraph: z.string().min(1).max(1200),
  done: z.boolean(),
  hypothesis: z.enum(["simple", "bug", "summary", "implement"]).nullable(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]).nullable(),
  supersedes: z.number().int().min(0).nullable().optional(),
})
export type IntentClassificationStep = z.infer<typeof intentClassificationStepSchema>

/** Final brief returned by `classifyIntentByChain`. The orchestrator
 *  flattens the iteration history into this shape so callers
 *  (Stage 4 wiring) don't need to walk the per-iteration outputs. */
export interface IntentClassificationBrief {
  hypothesis: IntentHint
  confidence: "HIGH" | "MEDIUM" | "LOW"
  /** Senior-engineer paragraphs from the chain — feeds `<ReasoningPeek>`
   *  via the plain-prose render path shipped in PR #83. */
  paragraphs: string[]
  /** How many iterations actually fired (1-6). */
  iterations: number
  /** How the chain settled. `done_flag` is the success path; the
   *  others are degraded shapes the orchestrator handles gracefully. */
  committedVia: "done_flag" | "step_cap" | "regex_fallback"
}

/** Runaway-safety cap on the iterative chain. Mirrors
 *  `MAX_ITERATIVE_STEPS` in task-reasoner.ts so operators have one
 *  number to reason about for "how deep can iterative reasoning go". */
export const MAX_INTENT_CLASSIFICATION_ITERATIONS = 6

/** Inputs the chain orchestrator needs. Kept narrow on purpose — the
 *  classifier doesn't need full `ReasoningPayload` shape, just the
 *  user prompt + model identifier + reasoner-backend selector knob
 *  (`flagOverride` from `reasoning.backend`). */
export interface ClassifyIntentByChainPayload {
  userMessage: string
  model?: string | null
  /** Value of `reasoning.backend` flag — `"auto"` (default) defers
   *  to `pickReasonerBackend`, or pin to a specific backend for
   *  testing. */
  flagOverride?: string
  /** Per-iteration max output tokens. The classifier's output is
   *  small (one paragraph + a few flags), so a tighter cap keeps the
   *  per-call cost predictable. */
  maxOutputTokens?: number
  /** Hard ceiling on iterations. Defaults to
   *  {@link MAX_INTENT_CLASSIFICATION_ITERATIONS}. */
  maxIterations?: number
}

/** Test-DI: the orchestrator calls this to talk to a reasoner
 *  backend. In production it's `callReasonerBackend`; tests inject a
 *  stub that returns canned per-iteration JSON. */
export type ClassifyIntentLlmCall = (args: {
  backend: ReasonerBackend
  systemInstruction: string
  userTurn: string
  maxOutputTokens: number
}) => Promise<string>

/** Parse one iteration's raw JSON. Returns `null` on any unparseable
 *  output so the orchestrator can stop the chain gracefully. */
export function parseIntentClassificationStep(raw: string): IntentClassificationStep | null {
  // Strip common markdown fences a model might wrap the JSON in.
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim()
  try {
    const obj = JSON.parse(stripped) as Record<string, unknown>
    const parsed = intentClassificationStepSchema.safeParse(obj)
    if (!parsed.success) return null
    return parsed.data
  } catch {
    return null
  }
}

/** Build the user turn for one iteration of the chain. The system
 *  prompt covers the senior-engineer rubric; the user turn carries
 *  the prompt to classify + any prior paragraphs.
 *
 *  Pure — exported for tests + so the orchestrator stays readable. */
export function buildIntentClassificationUserTurn(payload: ClassifyIntentByChainPayload, paragraphs: string[], stepIndex: number, maxSteps: number): string {
  const parts: string[] = []
  parts.push(`ITERATION ${stepIndex + 1} of up to ${maxSteps}`)
  parts.push("")
  parts.push("USER PROMPT:")
  parts.push(payload.userMessage)
  parts.push("")
  if (paragraphs.length === 0) {
    parts.push("This is the FIRST iteration. Read the prompt carefully — every word matters. Apply the senior-engineer rubric in your paragraph. If the classification is obvious after one read, commit with `done: true`; if not, set `done: false` and end your paragraph with the specific question another pass would answer.")
  } else {
    parts.push("PRIOR PARAGRAPHS (oldest first):")
    paragraphs.forEach((p, i) => parts.push(`[${i}] ${p}`))
    parts.push("")
    parts.push("This is a follow-up iteration. Address the question your prior paragraph raised. Use `supersedes: N` if a prior paragraph is now wrong — DON'T stack contradictory paragraphs. Commit with `done: true` unless this pass surfaces yet another genuine question.")
  }
  parts.push("")
  parts.push("Output ONLY the JSON object. No markdown fences. No prose outside the JSON.")
  return parts.join("\n")
}

/**
 * LLM iterative paragraph chain. Self-directing depth — the LLM marks
 * `done: true` when it's ready to commit; the orchestrator respects
 * that. Returns `null` only when no usable hypothesis emerged (no
 * reasoner backend / every iteration unparseable / etc.). The caller
 * (Stage 4 wiring) treats `null` as a signal to fall back to the
 * regex.
 *
 * The `callBackend` parameter is for testing — defaults to
 * `callReasonerBackend` in production.
 */
export async function classifyIntentByChain(
  payload: ClassifyIntentByChainPayload,
  callBackend: ClassifyIntentLlmCall = defaultLlmCall,
): Promise<IntentClassificationBrief | null> {
  // Resolve which backend to use. Same path the preflight reasoner
  // takes (`pickReasonerBackend` honours `reasoning.backend` flag +
  // configured API keys).
  const backend = pickReasonerBackend({
    model: payload.model ?? null,
    flagOverride: payload.flagOverride ?? "auto",
  })
  if (!backend) return null  // No API keys → caller falls back to regex.

  const systemInstruction = getPipelineSystemPrompt("intent_classification")
  const maxOutputTokens = payload.maxOutputTokens ?? 1200
  const maxIterations = payload.maxIterations ?? MAX_INTENT_CLASSIFICATION_ITERATIONS

  const paragraphs: string[] = []
  let lastHypothesis: IntentHint | null = null
  let lastConfidence: "HIGH" | "MEDIUM" | "LOW" | null = null
  let committedViaDoneFlag = false
  let iterations = 0

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1
    const userTurn = buildIntentClassificationUserTurn(payload, paragraphs, i, maxIterations)
    let raw: string
    try {
      raw = await callBackend({ backend, systemInstruction, userTurn, maxOutputTokens })
    } catch (err) {
      console.warn(`[intent-classifier] iteration ${iterations} failed: ${(err as Error).message}`)
      break
    }
    const step = parseIntentClassificationStep(raw)
    if (!step) {
      console.warn(`[intent-classifier] iteration ${iterations} unparseable; stopping with ${paragraphs.length} paragraph(s)`)
      break
    }

    // Anti-staleness: allow superseding a prior paragraph instead of
    // stacking contradictions.
    if (step.supersedes != null && step.supersedes >= 0 && step.supersedes < paragraphs.length) {
      paragraphs[step.supersedes] = step.paragraph
    } else {
      paragraphs.push(step.paragraph)
    }
    if (step.hypothesis) lastHypothesis = step.hypothesis
    if (step.confidence) lastConfidence = step.confidence

    if (step.done) {
      committedViaDoneFlag = true
      break
    }
  }

  if (!lastHypothesis) return null

  return {
    hypothesis: lastHypothesis,
    confidence: lastConfidence ?? "LOW",
    paragraphs,
    iterations,
    committedVia: committedViaDoneFlag ? "done_flag" : "step_cap",
  }
}

/** Production wiring: `callReasonerBackend` from the backend
 *  dispatcher. Kept as a default for `classifyIntentByChain`'s
 *  `callBackend` parameter so tests can inject a stub. */
async function defaultLlmCall(args: { backend: ReasonerBackend; systemInstruction: string; userTurn: string; maxOutputTokens: number }): Promise<string> {
  return callReasonerBackend(args.backend, {
    // The classifier doesn't need a real ReasoningPayload — the
    // backend dispatcher only uses `args.systemInstruction` /
    // `args.userTurnOverride` / `args.maxOutputTokens`. `payload` +
    // `kind` are passed along for telemetry parity with other
    // pipelines.
    payload: {
      trigger: "preflight",
      userMessage: args.userTurn,
      model: "intent-classifier",
    },
    kind: "intent_classification",
    userTurnOverride: args.userTurn,
    defaultUserTurn: args.userTurn,
    maxOutputTokens: args.maxOutputTokens,
    systemInstruction: args.systemInstruction,
  })
}

// ─── Smart wrapper: cache → regex fast-path → LLM chain → regex fallback ───
// Stage 4 entry point used by user-message.ts + tool-result.ts.

/**
 * Where the classifier's hint came from:
 *
 *   - "cache"            — runId-cached value from earlier in the run.
 *   - "regex_simple"     — fast-path: SIMPLE_PATTERNS matched (bare
 *                          shell-style / continuation / etc.). No
 *                          LLM call.
 *   - "regex_confident"  — Stage 3 of speed-overhaul plan
 *                          (2026-05-20): IMPLEMENT_LEAD / BUG / SUMMARY
 *                          pattern matched specifically. The regex is
 *                          high-confidence on those; no LLM call.
 *                          Saves 1-6 Flash on every implement-class
 *                          prompt.
 *   - "chain"            — LLM iterative chain committed the result.
 *                          Fires only when the regex fell through to
 *                          the default "implement" path (no specific
 *                          pattern matched).
 *   - "regex_fallback"   — chain returned null / errored / flag off,
 *                          and the regex's verdict was used.
 */
export type ClassifyIntentSource = "cache" | "regex_simple" | "regex_confident" | "regex_fallback" | "chain"

export interface ClassifyIntentSmartArgs {
  /** The user's prompt. Same string `classifyIntent(regex)` consumes. */
  userMessage: string
  /** Per-run cache key. When set, classification fires ONCE per run
   *  and subsequent calls return the cached hint. Pass `null` /
   *  `undefined` to disable caching (e.g. one-shot CLI commands that
   *  don't have a runId yet). */
  runId?: string | null
  /** Main-model identifier — fed to `pickReasonerBackend` so the
   *  classifier uses the same backend the preflight reasoner would. */
  model?: string | null
  /** Resolved value of `reasoning.backend` flag. Defaults to `"auto"`
   *  (model-driven backend pick); operators can pin a specific
   *  backend via the flag. */
  flagOverride?: string
}

export interface ClassifyIntentSmartResult {
  hint: IntentHint
  /** Where the hint came from (telemetry — Stage 5 will surface this
   *  on `RunSummary.intentClassificationSource`). */
  source: ClassifyIntentSource
  /** Senior-engineer paragraphs from the chain, when `source === "chain"`.
   *  Caller can surface these in `<ReasoningPeek>` via the brief envelope's
   *  `reasoningChain[]` field — `formatPlainReasoningChain` (PR #83)
   *  renders them automatically. */
  paragraphs?: string[]
}

/**
 * The user-facing async classifier. Walks four paths in order:
 *
 *   1. **Cache hit.** If `runId` is set and the cache holds a value
 *      from earlier in this run, return it immediately. No regex
 *      pass, no LLM call. Constant for the run.
 *   2. **Regex fast-path.** Run the sync regex; if it classifies as
 *      `simple` (continuation phrase / bare `ls` / `/list` / etc.),
 *      commit immediately. Those prompts are trivial and unambiguous;
 *      no LLM value-add.
 *   3. **LLM chain.** If the regex classified as anything else AND
 *      `reasoning.intent_classification_via_llm_enabled` is true,
 *      run `classifyIntentByChain`. The LLM owns its own depth (1-6
 *      iterations via `done`). When it commits, the chain's
 *      `hypothesis` wins and `paragraphs` flow back to the caller.
 *   4. **Regex fallback.** If the LLM chain returned `null` (no
 *      backend / unparseable / chain ran to cap without committing)
 *      OR the flag was off, return the regex's classification with
 *      `source: "regex_fallback"`. The regex's classification IS
 *      always available — the worst case is the existing pre-plan
 *      behaviour.
 *
 * The `callBackend` parameter is for testing — defaults to
 * `classifyIntentByChain`'s default `defaultLlmCall`.
 */
export async function classifyIntentSmart(
  args: ClassifyIntentSmartArgs,
  callBackend?: ClassifyIntentLlmCall,
): Promise<ClassifyIntentSmartResult> {
  // 1. Cache hit — short-circuit before any classification work.
  const cached = getIntentForRun(args.runId)
  if (cached) {
    return { hint: cached, source: "cache" }
  }

  // 2. Regex fast-path. SIMPLE_PATTERNS match → commit + cache.
  // Bare `ls`, `pwd`, `/continue` etc. are unambiguous; the LLM has
  // nothing to add. Other regex classes (bug / summary / implement)
  // may have false-positive compound-noun matches — they MUST go
  // through the LLM.
  //
  // Stage 5: the regex fast-path can be disabled via
  // `reasoning.intent_classification_fast_path_regex_enabled = false`
  // to force every prompt through the LLM (telemetry / accuracy
  // tuning mode).
  const fastPathEnabled = (() => {
    try { return getFlag<boolean>("reasoning.intent_classification_fast_path_regex_enabled") }
    catch { return true }
  })()
  const regex = classifyIntentDetailed(args.userMessage)
  const regexHint = regex.hint
  if (fastPathEnabled && regexHint === "simple") {
    setIntentForRun(args.runId, regexHint)
    return { hint: regexHint, source: "regex_simple" }
  }

  // 2b. Stage 3 of speed-overhaul plan (2026-05-20):
  //     trust the regex when a SPECIFIC pattern matched.
  //
  //     IMPLEMENT_LEAD / BUG / SUMMARY patterns are tight enough that
  //     the LLM chain rarely overrides correctly — but it costs 1-6
  //     Flash calls per prompt. For implement-class prompts ("build a
  //     POS backend with Express"), this was the single biggest Flash
  //     budget pressure point pre-Stage-3.
  //
  //     LLM chain still fires when the regex fell through to the
  //     default "implement" verdict (patternMatched=false) — those are
  //     the genuinely-ambiguous prompts where the chain adds value.
  if (fastPathEnabled && regex.patternMatched) {
    setIntentForRun(args.runId, regexHint)
    return { hint: regexHint, source: "regex_confident" }
  }

  // 3. LLM chain. Flag-gated.
  const llmEnabled = (() => {
    try { return getFlag<boolean>("reasoning.intent_classification_via_llm_enabled") }
    catch { return true }
  })()
  // Stage 5: depth cap from flag (default MAX_INTENT_CLASSIFICATION_ITERATIONS).
  const maxIterationsFromFlag = (() => {
    try { return getFlag<number>("reasoning.intent_classification_max_iterations") }
    catch { return MAX_INTENT_CLASSIFICATION_ITERATIONS }
  })()

  if (llmEnabled) {
    try {
      const brief = await classifyIntentByChain(
        {
          userMessage: args.userMessage,
          model: args.model ?? null,
          flagOverride: args.flagOverride ?? "auto",
          maxIterations: maxIterationsFromFlag,
        },
        callBackend,
      )
      if (brief) {
        setIntentForRun(args.runId, brief.hypothesis)
        return { hint: brief.hypothesis, source: "chain", paragraphs: brief.paragraphs }
      }
    } catch (err) {
      // Chain shouldn't throw to the caller — it catches its own
      // network / parse failures. A throw here is a programmer error
      // (DI stub mistake, etc.). Log + fall through to regex fallback.
      console.warn(`[intent-classifier] smart wrapper caught chain throw: ${(err as Error).message}; falling back to regex`)
    }
  }

  // 4. Regex fallback. The regex's `regexHint` IS the safe default.
  setIntentForRun(args.runId, regexHint)
  return { hint: regexHint, source: "regex_fallback" }
}
