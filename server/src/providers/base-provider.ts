import type { ProviderPayload, NormalizedResponse, TokenUsage, ToolCall } from "../types.js"
import { analyzeTaskComplexity, type TaskAnalysis } from "../services/completion-guard.js"
import { actionPlanner } from "../services/action-planner.js"
import { isFrontendTask } from "../knowledge/frontend-patterns.js"
import { getFrontendPatternsCompact } from "../knowledge/frontend-patterns.js"
import { getPipeline } from "../services/task-pipeline.js"
import { buildSystemPrompt, type PromptCtx } from "./prompt/build.js"
import { shouldIncludeTaskPlanInstruction } from "./prompt/sections/system-rules.js"
import { buildVerifyAfterWriteBlock, extractWritesFromToolResults } from "../services/post-write-verifier.js"
import { buildErrorReasoningBlock } from "../services/error-reason-block.js"
import { shouldForceVerifyAfterWrite, getSelfReviewCadence } from "../services/free-tier-policy.js"
import { getFlag } from "../services/flags.js"
import { getLedger } from "../services/task-ledger.js"
import { shouldForceSelfReview, markReviewFired, buildReviewBlock } from "../services/self-review-scheduler.js"
import { getChunkHistory } from "../services/chunk-state.js"
export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "./prompt/build.js"

/**
 * Phase 15 Stage 4: pure helper that extracts a clean `memoryFeedback`
 * shape from a model JSON response. Defensive against any malformed
 * payload (missing object, non-arrays, non-string entries, empty
 * strings). Returns null when the field is absent or normalises to
 * empty — so the caller can `if (mf) normalized.memoryFeedback = mf`
 * without re-validating.
 *
 * Exported for unit tests.
 */
export function extractMemoryFeedback(
  json: Record<string, unknown> | null | undefined,
): { confirmed: string[]; contradicted: string[] } | null {
  if (!json || typeof json !== "object") return null
  const raw = (json as Record<string, unknown>).memoryFeedback
  if (!raw || typeof raw !== "object") return null
  const mf = raw as Record<string, unknown>
  const confirmed = Array.isArray(mf.confirmed)
    ? (mf.confirmed as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0)
    : []
  const contradicted = Array.isArray(mf.contradicted)
    ? (mf.contradicted as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0)
    : []
  if (confirmed.length === 0 && contradicted.length === 0) return null
  return { confirmed, contradicted }
}

// ─── Tool Name Sanitizer: map hallucinated tool names to real ones ───

const VALID_TOOLS = new Set([
  "list_directory", "read_file", "batch_read", "write_file",
  "edit_file", "create_directory", "search_code", "search_files",
  "run_command", "move_file", "delete_file", "web_search",
  "file_exists", "batch_write"  // batch_write handled as fallback in client
])

/** Map of commonly hallucinated tool names → correct tool names */
const TOOL_ALIASES: Record<string, string> = {
  "writeFile": "write_file",
  "readFile": "read_file",
  "editFile": "edit_file",
  "createFile": "write_file",
  "createDirectory": "create_directory",
  "mkdir": "create_directory",
  "listDirectory": "list_directory",
  "listDir": "list_directory",
  "ls": "list_directory",
  "searchCode": "search_code",
  "searchFiles": "search_files",
  "runCommand": "run_command",
  "exec": "run_command",
  "shell": "run_command",
  "moveFile": "move_file",
  "deleteFile": "delete_file",
  "removeFile": "delete_file",
  "rm": "delete_file",
  "webSearch": "web_search",
  "search": "web_search",
  "batchRead": "batch_read",
  "batchWrite": "batch_write",
  "batch_create": "batch_write",
  "create_files": "batch_write",
  "write_files": "batch_write",
  "multi_write": "batch_write",
}

/**
 * Robustly parse args_json with multiple fallback strategies.
 * Handles: valid JSON strings, already-parsed objects, malformed JSON,
 * double-encoded strings, and single-quoted JSON.
 */
function parseArgsRobust(argsJson: unknown, argsFallback: unknown, tool?: string): Record<string, unknown> {
  // Strategy 1: args_json is already an object
  if (argsJson && typeof argsJson === "object" && !Array.isArray(argsJson)) {
    const obj = argsJson as Record<string, unknown>
    if (Object.keys(obj).length > 0) return obj
  }

  // Strategy 2: args_json is a valid JSON string
  if (typeof argsJson === "string" && argsJson.trim()) {
    // Try direct parse
    try {
      const parsed = JSON.parse(argsJson)
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
    } catch { /* try fallbacks */ }

    // Strategy 3: double-encoded JSON (string inside string)
    try {
      const unescaped = JSON.parse(`"${argsJson.replace(/"/g, '\\"')}"`)
      if (typeof unescaped === "string") {
        const parsed = JSON.parse(unescaped)
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
      }
    } catch { /* try next */ }

    // Strategy 4: fix common JSON issues (single quotes, trailing commas)
    try {
      const fixed = argsJson
        .replace(/'/g, '"')                    // single → double quotes
        .replace(/,\s*([}\]])/g, "$1")         // trailing commas
        .replace(/(\w+)\s*:/g, '"$1":')        // unquoted keys
      const parsed = JSON.parse(fixed)
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
    } catch { /* try next */ }

    // Strategy 5: regex extraction — pull path and content/patch from the string
    const pathMatch = argsJson.match(/"path"\s*:\s*"([^"]+)"/)
    if (pathMatch) {
      const extracted: Record<string, unknown> = { path: pathMatch[1] }
      const contentMatch = argsJson.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      const patchMatch = argsJson.match(/"patch"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      if (contentMatch) extracted.content = contentMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"')
      if (patchMatch) extracted.patch = patchMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"')

      // Strategy 5.5: extract search/replace and line-based fields for edit_file
      if (tool === "edit_file") {
        const searchMatch = argsJson.match(/"search"\s*:\s*"((?:[^"\\]|\\.)*)"/)
        const replaceMatch = argsJson.match(/"replace"\s*:\s*"((?:[^"\\]|\\.)*)"/)
        if (searchMatch) {
          extracted.search = searchMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"')
          extracted.replace = replaceMatch ? replaceMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : ""
        }
        const lineStartMatch = argsJson.match(/"line_start"\s*:\s*(\d+)/)
        const lineEndMatch = argsJson.match(/"line_end"\s*:\s*(\d+)/)
        const insertAtMatch = argsJson.match(/"insert_at"\s*:\s*(\d+)/)
        if (lineStartMatch) extracted.line_start = parseInt(lineStartMatch[1])
        if (lineEndMatch) extracted.line_end = parseInt(lineEndMatch[1])
        if (insertAtMatch) extracted.insert_at = parseInt(insertAtMatch[1])
      }

      // Strategy 5.6: extract offset/limit for read_file
      if (tool === "read_file") {
        const offsetMatch = argsJson.match(/"offset"\s*:\s*(\d+)/)
        const limitMatch = argsJson.match(/"limit"\s*:\s*(\d+)/)
        if (offsetMatch) extracted.offset = parseInt(offsetMatch[1])
        if (limitMatch) extracted.limit = parseInt(limitMatch[1])
      }

      console.warn(`[args-parser] Recovered args via regex for ${tool || "unknown"}: path=${extracted.path}`)
      return extracted
    }

    console.error(`[args-parser] FAILED to parse args_json for ${tool || "unknown"}:`, argsJson.slice(0, 200))
  }

  // Strategy 6: use args fallback (non-Gemini providers use args directly)
  if (argsFallback && typeof argsFallback === "object") {
    return argsFallback as Record<string, unknown>
  }

  return {}
}

function sanitizeToolName(tool: string): string | null {
  if (VALID_TOOLS.has(tool)) return tool

  // Check aliases
  const alias = TOOL_ALIASES[tool]
  if (alias) {
    console.log(`[sanitizer] Mapped hallucinated tool "${tool}" → "${alias}"`)
    return alias
  }

  // Fuzzy match: try snake_case conversion
  const snakeCase = tool.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "")
  if (VALID_TOOLS.has(snakeCase)) {
    console.log(`[sanitizer] Mapped camelCase tool "${tool}" → "${snakeCase}"`)
    return snakeCase
  }

  // Hard reject: unknown tool — return null so the validation gate catches it
  console.warn(`[sanitizer] REJECTED unknown tool: "${tool}" — no mapping found`)
  return null
}

// ─── Rate Limit Tracker (shared across all providers) ───

export interface RateLimitState {
  lastHit: number          // timestamp of last 429
  hitCount: number         // consecutive hits without a successful call
  backoffMs: number        // current backoff duration
  reducedTokens: boolean   // whether we've reduced max_tokens
}

/** Global rate limit state per provider name */
const rateLimitState = new Map<string, RateLimitState>()

const RATE_LIMIT_BASE_BACKOFF = 5_000     // 5s initial backoff
const RATE_LIMIT_MAX_BACKOFF = 120_000    // 2min max backoff
const RATE_LIMIT_COOLDOWN = 300_000       // 5min — clear state after no hits
const RATE_LIMIT_MAX_RETRIES = 4          // max retries before fallback

export function getRateLimitState(providerName: string): RateLimitState | undefined {
  const state = rateLimitState.get(providerName)
  if (state && Date.now() - state.lastHit > RATE_LIMIT_COOLDOWN) {
    rateLimitState.delete(providerName)
    return undefined
  }
  return state
}

export function recordRateLimit(providerName: string): RateLimitState {
  const existing = rateLimitState.get(providerName)
  const hitCount = existing ? existing.hitCount + 1 : 1
  const backoffMs = Math.min(RATE_LIMIT_BASE_BACKOFF * Math.pow(2, hitCount - 1), RATE_LIMIT_MAX_BACKOFF)
  const state: RateLimitState = {
    lastHit: Date.now(),
    hitCount,
    backoffMs,
    reducedTokens: hitCount >= 2
  }
  rateLimitState.set(providerName, state)
  return state
}

export function clearRateLimit(providerName: string): void {
  rateLimitState.delete(providerName)
}

export function isProviderRateLimited(providerName: string): boolean {
  const state = getRateLimitState(providerName)
  return !!state && state.hitCount >= RATE_LIMIT_MAX_RETRIES
}

/**
 * Model fallback chains — when primary is exhausted, try these in order.
 *
 * Stage A of model-lock-and-portable-reasoning plan: explicit single-provider
 * picks (claude-*, gemini-*, llama-70b, mistral-small) have empty chains so a
 * rate-limited or failed call surfaces a clear error instead of silently
 * swapping providers. Only `openrouter-auto` retains a cross-provider chain
 * because the "auto" suffix is the user's signal that they expect cycling.
 *
 * The adapter ALSO gates chain-walking behind `providers.lock_to_chosen_model`
 * (see `shouldFallback()` in adapter.ts) so even if these chains are extended
 * in the future, explicit picks stay locked in by default.
 */
export const MODEL_FALLBACK_CHAINS: Record<string, string[]> = {
  "gemini-pro":       [],
  "gemini-flash":     [],
  "claude-sonnet":    [],
  "claude-opus":      [],
  "openrouter-auto":  ["gemini-flash", "mistral-small"],
  "llama-70b":        [],
  "mistral-small":    [],
  "swe":              ["gemini-pro", "gemini-flash"],
}

/**
 * Abstract base class for all AI model providers.
 *
 * Each provider must implement:
 *   - call()          → main entry point for the adapter
 *   - getModelName()  → map sysflow model ID to the provider's model ID
 *
 * Shared helpers provided:
 *   - buildInitialUserMessage()  → assembles context + prompt
 *   - parseJsonResponse()        → extracts JSON from raw model text
 *   - failedResponse()           → shorthand for error responses
 *   - clearRunState()            → cleanup per-run state
 *   - rateLimitedResponse()      → signal rate limit for retry/fallback
 */
export abstract class BaseProvider {
  /** Human-readable provider name (for logs) */
  abstract readonly name: string

  /** Map of sysflow model IDs this provider handles → provider-specific model IDs */
  abstract readonly modelMap: Record<string, string>

  /** Per-run state (chat sessions, message histories, etc.) */
  protected runState = new Map<string, unknown>()

  /** Per-run original task — persisted so every tool result includes a reminder */
  protected runTasks = new Map<string, string>()

  /**
   * Phase 18 Stage 5: per-run taskPlan emission gate. Set by each
   * provider's `call(payload)` from `payload.runIntent` +
   * `payload.taskComplexity` before invoking the model; read by
   * `parseJsonResponse` so the defensive drop knows whether a stray
   * taskPlan emission should be suppressed. Cleared by
   * `clearRunState(runId)`.
   */
  protected runTaskPlanGate = new Map<string, { runIntent: "simple" | "summary" | "bug" | "implement" | null; taskComplexity: "simple" | "medium" | "complex" | null }>()

  /** Phase 18 Stage 5: helper called by each provider's `call(payload)` before
   *  the model invocation so the normalizer sees the gate. Idempotent —
   *  re-writes are no-ops when the values are the same. */
  protected setRunTaskPlanGate(payload: ProviderPayload): void {
    this.runTaskPlanGate.set(payload.runId, {
      runIntent: payload.runIntent ?? null,
      taskComplexity: payload.taskComplexity ?? null,
    })
  }

  /** Per-run malformed-response counter — caps recovery loops. */
  protected runParseFailures = new Map<string, number>()
  protected static readonly MAX_PARSE_FAILURES = 2

  /** Per-run max-output-token recovery counter. */
  protected runMaxOutputAttempts = new Map<string, number>()
  protected static readonly MAX_OUTPUT_RECOVERY_ATTEMPTS = 3
  /** Escalated max-output-tokens limit on the first recovery attempt. */
  static readonly ESCALATED_MAX_OUTPUT_TOKENS = 131_072

  /** System prompt shared by all providers (can be overridden) */
  protected readonly systemPrompt: string = SHARED_SYSTEM_PROMPT

  // ─── Abstract methods ───

  abstract call(payload: ProviderPayload): Promise<NormalizedResponse>

  // ─── Shared helpers ───

  getModelName(modelId: string): string {
    const keys = Object.keys(this.modelMap)
    return this.modelMap[modelId] || this.modelMap[keys[0]] || modelId
  }

  /**
   * Stage B of model-lock-and-portable-reasoning: build the per-request
   * system prompt with the reasoning briefs threaded in.
   *
   * Anthropic and OpenRouter previously used the static `SHARED_SYSTEM_PROMPT`
   * (`this.systemPrompt`) which meant `payload.reasoningBrief` and
   * `payload.reasoningElaborationBrief` were computed by the reasoner,
   * cached, and then discarded — Anthropic / OpenRouter never saw them.
   * Calling this in place of `this.systemPrompt` routes the briefs through
   * `getSystemPrompt(ctx)` the same way Gemini's `buildPrompt(payload)` does.
   *
   * Project/learned memory still flows via `buildInitialUserMessage` on
   * these providers (unchanged from before this stage). Full memory parity
   * with Gemini's async discovery (`discoverProjectMemory` +
   * `recallForReasoning`) is intentionally out of scope for Stage B — the
   * load-bearing fix here is the BRIEF reaching the model, not a refactor
   * of memory flow. Future work can centralise the async-discovery path.
   */
  getSystemPromptForRequest(payload: ProviderPayload): string {
    return this.buildPromptCtx(payload, "full")
  }

  /**
   * Stage 5b of speed-overhaul plan (2026-05-26): expose the
   * stable + dynamic split of the system prompt so providers that
   * support prompt caching (Anthropic) can put `cache_control` on
   * the stable prefix only. Sections in `prompt/build.ts` are already
   * classified `cacheable: true|false` — this method just surfaces
   * the two halves to the provider.
   *
   * Stage 4 cached the FULL system prompt as one block — which silently
   * missed cache reads on every turn because the dynamic suffix
   * (reasoning briefs, task ledger, project-state) changes per turn.
   * With this split, the cacheable prefix stays byte-stable across the
   * run's turns and gets reliable cache hits.
   */
  getSystemPromptPartsForRequest(payload: ProviderPayload): { cacheable: string; dynamic: string } {
    const cacheable = this.buildPromptCtx(payload, "cacheable")
    const dynamic = this.buildPromptCtx(payload, "dynamic")
    return { cacheable, dynamic }
  }

  /** Internal shared builder for the two public methods above. Returns
   *  the requested portion (`full` | `cacheable` | `dynamic`) of the
   *  system prompt; the underlying section assembly is the same. */
  private buildPromptCtx(payload: ProviderPayload, part: "full" | "cacheable" | "dynamic"): string {
    // Phase 18 Stage 5: resolve the taskPlan-emission flag once per
    // request. Default `true` (gate on); flag-off path lets operators
    // restore the pre-Phase-18 always-include behaviour without code
    // changes.
    const gatingEnabled = (() => {
      try { return getFlag<boolean>("quality.taskplan_emission_gating_enabled") }
      catch { return true }
    })()

    const built = buildSystemPrompt({
      model: payload.model,
      cwd: payload.cwd,
      planMode: payload.planMode,
      // payload.reasoningBrief / reasoningElaborationBrief are typed
      // `unknown` on ProviderPayload to avoid an import cycle into the
      // reasoning module; cast at the seam (same pattern Gemini uses).
      reasoningBrief: payload.reasoningBrief as never,
      reasoningElaborationBrief: payload.reasoningElaborationBrief as never,
      // Stage 2 of free-tier quality enforcement: persistent task ledger.
      // Reads the current ledger snapshot for this run so the system
      // prompt always reflects which subtasks remain. Empty array when
      // the run had no implementBrief.buildPlan to seed from.
      taskLedger: getLedger(payload.runId),
      // Phase 18 Stage 5: taskPlan emission gating.
      runIntent: payload.runIntent ?? null,
      complexity: payload.taskComplexity ?? null,
      gatingEnabled,
      // Stage 1 of agent-runtime-fixes plan: thread the project-init
      // brief into the system prompt so the agent's first move reflects
      // the classified repo state.
      projectInitBrief: payload.projectInitBrief,
      // Stage 4.1 of awareness-and-verification-correctness plan:
      // thread the USER's host platform so env-info renders the
      // bash vs PowerShell preferred-commands list correctly. Without
      // this, the server's `process.platform` lied to every user
      // about the OS — Windows users saw `platform: linux` + bash
      // examples, so the model emitted `ls -la` rather than
      // `Get-ChildItem -Force`.
      platform: payload.clientPlatform,
    })
    return built[part]
  }

  clearRunState(runId: string): void {
    this.runState.delete(runId)
    this.runTasks.delete(runId)
    this.runFileCount.delete(runId)
    this.runToolCount.delete(runId)
    this.runAnalysis.delete(runId)
    this.runFilePaths.delete(runId)
    this.runParseFailures.delete(runId)
    this.runMaxOutputAttempts.delete(runId)
    this.runTaskPlanGate.delete(runId)
  }

  /** Store the original task for this run */
  protected setRunTask(runId: string, task: string): void {
    this.runTasks.set(runId, task)
  }

  /** Signal a rate limit — does NOT clear run state so we can retry */
  rateLimitedResponse(detail: string): NormalizedResponse {
    const state = recordRateLimit(this.name)
    console.log(`[${this.name}] Rate limited (hit #${state.hitCount}, backoff ${state.backoffMs}ms): ${detail}`)
    return {
      kind: "rate_limited",
      error: detail,
      usage: { inputTokens: 0, outputTokens: 0 }
    }
  }

  /** Get reduced max_tokens when under rate pressure */
  protected getAdaptiveMaxTokens(baseTokens: number): number {
    const state = getRateLimitState(this.name)
    if (!state || !state.reducedTokens) return baseTokens
    // Reduce by 25% per consecutive hit, floor at 25% of original
    const factor = Math.max(0.25, 1 - (state.hitCount * 0.25))
    const reduced = Math.floor(baseTokens * factor)
    console.log(`[${this.name}] Adaptive tokens: ${baseTokens} → ${reduced} (hit #${state.hitCount})`)
    return reduced
  }

  /** Mark a successful call — resets rate limit tracking */
  protected onSuccessfulCall(): void {
    clearRateLimit(this.name)
  }

  /**
   * Track and decide what to do on a model-side MAX_TOKENS finish. Returns:
   *   - 'escalate'  — first attempt: retry with a higher max-output cap.
   *   - 'continue'  — second attempt: send a "continue from where you left off" message.
   *   - 'fail'      — third attempt or beyond: surface as errorCode='max_output_tokens'.
   *
   * Counter is per-run; cleared by clearRunState. Providers are responsible for
   * wiring up the actual escalate/continue mechanics in their SDK.
   */
  protected nextMaxOutputAction(runId: string): "escalate" | "continue" | "fail" {
    const used = (this.runMaxOutputAttempts.get(runId) ?? 0) + 1
    this.runMaxOutputAttempts.set(runId, used)
    if (used === 1) return "escalate"
    if (used === 2) return "continue"
    return "fail"
  }

  /** Reset the max-output-tokens counter — call after a successful (non-MAX_TOKENS) response. */
  protected resetMaxOutputAttempts(runId: string): void {
    this.runMaxOutputAttempts.delete(runId)
  }

  /** Synthetic user-turn text used by the 'continue' recovery action. */
  static readonly MAX_OUTPUT_CONTINUE_PROMPT =
    "Your previous response was cut off mid-output (max_output_tokens). " +
    "Continue from exactly where you stopped. Output ONLY the remainder " +
    "of valid JSON — no preamble, no fences, just the missing tail."

  /**
   * Provider-level completion validation.
   * If the AI says "completed" but hasn't done enough work, override to "needs_tool"
   * with a list_directory call to force continuation.
   *
   * This is Layer 2 of the anti-premature-completion system.
   * It runs BEFORE the handler sees the response.
   */
  protected validateCompletionResponse(runId: string, normalized: NormalizedResponse): NormalizedResponse {
    if (normalized.kind !== "completed") return normalized

    const filesWritten = this.runFileCount.get(runId) || 0
    const toolCalls = this.runToolCount.get(runId) || 0
    const content = (normalized.content || "").toLowerCase()

    // Error-fix tasks are allowed to complete with 0 files — they may just edit or confirm "already fixed"
    const originalTask = this.runTasks.get(runId) || ""
    const isErrorFixTask = /\b(fix\s+(this\s+)?error|resolve|Failed to resolve|cannot find|does not exist|ENOENT|ERESOLVE|Module not found|import.analysis)\b/i.test(originalTask)
    if (isErrorFixTask && toolCalls <= 5) {
      console.log(`[${this.name}] Allowing error-fix completion (${filesWritten} files, ${toolCalls} tools)`)
      return normalized
    }

    // Detect weak completions — AI said "Done" with almost no work
    const isWeakCompletion =
      // Very short content (just "Done." or similar)
      (content.length < 100 && !content.includes("files created") && !content.includes("summary")) ||
      // No files written at all
      (filesWritten === 0 && toolCalls <= 3) ||
      // Fewer than 5 files for what looks like a multi-file task
      (filesWritten < 5 && toolCalls > 0 && toolCalls <= 5)

    if (isWeakCompletion) {
      console.log(`[${this.name}] WEAK COMPLETION DETECTED: ${filesWritten} files, ${toolCalls} tools, content: "${(normalized.content || "").slice(0, 80)}"`)
      console.log(`[${this.name}] Overriding to needs_tool — forcing continuation`)

      // Stage 3 of reasoning-chain-provider-parity plan: preserve the
      // model's reasoningChain through the override so the cli's live
      // peek doesn't lose this turn's deliberation. The override is
      // mechanical (the server decided to continue) — the model's prior
      // reasoning about why it thought it was done is still
      // user-visible signal worth keeping.
      return {
        kind: "needs_tool",
        tool: "list_directory",
        args: { path: "." },
        content: "Checking project state to continue implementation...",
        reasoning: "My previous response was premature. I need to continue creating all required files.",
        reasoningChain: normalized.reasoningChain,
        usage: normalized.usage
      }
    }

    // Enforce "Next Steps" in completions — if the AI didn't include setup/install instructions,
    // append them based on what was created during this run
    const hasNextSteps = /next\s*steps|npm install|npm run|to (start|run|launch|install)|yarn |pnpm /i.test(content)
    if (!hasNextSteps && filesWritten > 0) {
      const filePaths = this.runFilePaths.get(runId) || []
      const projectDir = this.detectProjectDir(filePaths)
      const hasPackageJson = filePaths.some(f => f.endsWith("package.json"))
      const hasTailwind = filePaths.some(f => f.includes("tailwind") || content.includes("tailwind"))
      const hasFramerMotion = content.includes("framer-motion") || content.includes("framer motion")

      const steps: string[] = []
      if (projectDir) steps.push(`cd ${projectDir}`)
      if (hasPackageJson) {
        const extraPkgs: string[] = []
        if (hasTailwind) {
          extraPkgs.push("tailwindcss")
          if (content.includes("@tailwindcss/postcss")) extraPkgs.push("@tailwindcss/postcss")
          if (content.includes("@tailwindcss/vite")) extraPkgs.push("@tailwindcss/vite")
        }
        if (hasFramerMotion) extraPkgs.push("framer-motion")
        if (extraPkgs.length > 0) {
          steps.push(`npm install ${extraPkgs.join(" ")}`)
        } else {
          steps.push("npm install")
        }
      }
      steps.push("npm run dev")

      if (steps.length > 0) {
        const nextStepsBlock = "\n\n## Next Steps\n" + steps.map((s, i) => `${i + 1}. \`${s}\``).join("\n")
        normalized.content = (normalized.content || "") + nextStepsBlock
        console.log(`[${this.name}] Appended Next Steps to completion (AI forgot to include them)`)
      }
    }

    return normalized
  }

  /** Track files written per run for continuation awareness */
  protected runFileCount = new Map<string, number>()
  protected runToolCount = new Map<string, number>()
  /** Cached task analysis per run */
  protected runAnalysis = new Map<string, TaskAnalysis>()
  /** Track file paths written per run */
  protected runFilePaths = new Map<string, string[]>()

  /** Detect the top-level project directory from file paths */
  private detectProjectDir(filePaths: string[]): string | null {
    if (filePaths.length === 0) return null
    // Find the most common first path segment (e.g., "catelisai-landing/src/App.tsx" → "catelisai-landing")
    const firstSegments = filePaths
      .map(f => f.split("/")[0])
      .filter(s => s && !s.includes(".") && s !== "src" && s !== "public")
    if (firstSegments.length === 0) return null
    const counts = new Map<string, number>()
    for (const seg of firstSegments) counts.set(seg, (counts.get(seg) || 0) + 1)
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
    return sorted[0]?.[1] > 1 ? sorted[0][0] : null
  }

  /** Build tool result message with original task reminder and continuation enforcement */
  protected buildToolResultMessage(payload: ProviderPayload): string {
    let toolMsg: string
    const tools = payload.toolResults || (payload.toolResult ? [{ id: "0", tool: payload.toolResult.tool, result: payload.toolResult.result }] : [])

    if (payload.toolResults && payload.toolResults.length > 0) {
      const batchStr = payload.toolResults
        .map((r) => `[${r.id}] ${r.tool}: ${JSON.stringify(r.result)}`)
        .join("\n")
      toolMsg = `Tool results (parallel):\n${batchStr}`
    } else {
      toolMsg = `Tool result:\n${JSON.stringify({
        tool: payload.toolResult!.tool,
        result: payload.toolResult!.result
      })}`
    }

    // Track progress
    const fileCount = this.runFileCount.get(payload.runId) || 0
    const toolCount = this.runToolCount.get(payload.runId) || 0
    const existingPaths = this.runFilePaths.get(payload.runId) || []
    const newWrites = tools.filter((t) => t.tool === "write_file" || t.tool === "edit_file").length
    const newCommands = tools.filter((t) => t.tool === "run_command").length
    const newPaths = tools
      .filter((t) => t.tool === "write_file" || t.tool === "edit_file")
      .map((t) => {
        const r = t.result as Record<string, unknown>
        return (r.path as string) || ""
      })
      .filter(Boolean)
    this.runFileCount.set(payload.runId, fileCount + newWrites)
    this.runToolCount.set(payload.runId, toolCount + tools.length)
    this.runFilePaths.set(payload.runId, [...existingPaths, ...newPaths])

    const totalFiles = fileCount + newWrites
    const totalTools = toolCount + tools.length
    const allPaths = [...existingPaths, ...newPaths]

    // Detect scaffold-only results (commands returned but no files written yet)
    const isScaffoldResult = newCommands > 0 && totalFiles === 0
    const hasInteractive = tools.some((t) =>
      t.tool === "run_command" && (
        JSON.stringify(t.result).includes("interactive") ||
        JSON.stringify(t.result).includes("scaffold") ||
        JSON.stringify(t.result).includes("CREATE") ||
        JSON.stringify(t.result).includes("Success!")
      )
    )

    // ─── Throttled context injection — reduce noise, keep signal ───

    // Planner context: ALWAYS inject (targeted, small, critical for recovery)
    const plannerContext = actionPlanner.getPendingContext(payload.runId)
    if (plannerContext) {
      toolMsg += `\n\n${plannerContext}`
    }

    // Working context: every 5 tool calls (or first 3)
    if (payload.context?.workingContext && (totalTools < 3 || totalTools % 5 === 0)) {
      toolMsg += `\n\n${payload.context.workingContext}`
    }

    // Frontend patterns: first response only (totalFiles === newWrites means this is the first write batch)
    if (isFrontendTask(payload.userMessage) && totalFiles > 0 && totalFiles <= newWrites) {
      toolMsg += `\n\n${getFrontendPatternsCompact()}`
    }

    // Plan progress: current step reminder
    const pipeline = getPipeline(payload.runId)
    if (pipeline && pipeline.steps.length > 0) {
      const currentStep = pipeline.steps.find((s) => s.status === "in_progress")
      const completedCount = pipeline.steps.filter((s) => s.status === "completed").length
      if (currentStep) {
        toolMsg += `\n\n[YOUR PLAN] Step ${completedCount + 1}/${pipeline.steps.length}: "${currentStep.label}"`
      }
    }

    // Original task reminder: every 10 tool calls (or first 3), and after scaffold
    const originalTask = this.runTasks.get(payload.runId) || payload.userMessage
    const shouldRemindTask = totalTools < 3 || totalTools % 10 === 0 || isScaffoldResult
    if (originalTask && originalTask !== "continue" && originalTask !== "continue the previous task") {
      if (shouldRemindTask) {
        toolMsg += `\n\n═══ REMINDER: ORIGINAL TASK ═══\n${originalTask}\n═══ END REMINDER ═══`
      }

      // Scaffold-aware enforcement: one-time injection after scaffold completes
      if (isScaffoldResult || hasInteractive) {
        toolMsg += `\n\nScaffolding created an empty skeleton. You MUST now create ALL source files with write_file. Do NOT respond with "completed".`
      }

      // Module progress: every 5 tool calls for non-simple tasks
      if (totalFiles > 0 && totalTools % 5 === 0) {
        if (!this.runAnalysis.has(payload.runId)) {
          this.runAnalysis.set(payload.runId, analyzeTaskComplexity(originalTask))
        }
        const analysis = this.runAnalysis.get(payload.runId)!

        if (analysis.complexity !== "simple" && (analysis.expectedModules.length > 0 || analysis.expectedFrontendPages.length > 0)) {
          const missingModules = analysis.expectedModules.filter((mod) =>
            !allPaths.some((p) => p.toLowerCase().includes(mod.toLowerCase()) || p.toLowerCase().includes(mod.replace(/s$/, "").toLowerCase()))
          )
          const missingPages = analysis.expectedFrontendPages.filter((page) =>
            !allPaths.some((p) => p.toLowerCase().includes(page.split(" ")[0].toLowerCase()))
          )

          const parts: string[] = []
          if (missingModules.length > 0) parts.push(`Modules remaining: ${missingModules.join(", ")}`)
          if (missingPages.length > 0) parts.push(`Pages remaining: ${missingPages.join(", ")}`)
          if (parts.length > 0) {
            toolMsg += `\n\n[PROGRESS] ${totalFiles} files created. ${parts.join(". ")}.`
          }
        }
      }

      toolMsg += `\nContinue with "needs_tool".`
    } else {
      toolMsg += "\n\nContinue with the next action needed to complete the task."
    }

    // Stage 1 of free-tier quality enforcement: if this chunk wrote any
    // files, inject a verify-after-write directive block instructing the
    // agent to cat/typecheck/find before proceeding. Free-tier always;
    // paid only on real-sized chunks. Closes the "agent wrote a typo and
    // didn't notice / created an empty folder and moved on" failure mode.
    toolMsg += this.renderVerifyAfterWriteBlock(payload, tools)

    // Stage 3 of free-tier quality enforcement: every N chunks, inject a
    // forced self-review block. Agent must batch_read recent files and
    // reason about completeness in `reasoningChain` BEFORE writing more.
    // Cadence: free-tier=2, paid=4 (see `getSelfReviewCadence`). Closes
    // the "lacks checking every iteration" failure mode.
    toolMsg += this.renderMandatoryReviewBlock(payload, tools)

    // Phase 10: chunk plan injection. Each turn that has a fresh planner
    // verdict gets the file list re-stamped at the bottom so the model sees
    // it last (closest to its response window).
    toolMsg += renderChunkPlanSection(payload.chunkPlanBrief)

    // Stage 3 of forced-error-reasoning plan: when a tool errored
    // this turn AND the error-reasoning chain produced a brief,
    // inject the `═══ ERROR — REASON THROUGH THIS ═══` block at the
    // VERY END of the tool-result body so it's the last thing the
    // model reads before its response window. Closes the user-
    // reported failure mode where the LLM ignores tool errors and
    // proceeds to the next step.
    toolMsg += this.renderErrorReasoningBlock(payload)

    return toolMsg
  }

  /**
   * Stage 3 of forced-error-reasoning plan: protected helper that
   * builds the error-reasoning directive block when
   * `payload.errorReasoningBrief` is set (which `tool-result.ts`
   * sets after `runErrorReasoningChain` commits). Returns empty
   * string when the brief is absent (no error fired this turn, or
   * the chain returned null and the existing bug-pipeline fallback
   * is rendering via `reasoningBrief` instead).
   */
  protected renderErrorReasoningBlock(payload: ProviderPayload): string {
    if (!payload.errorReasoningBrief) return ""

    const flagEnabled = (() => {
      try { return getFlag<boolean>("quality.force_error_reasoning_enabled") }
      catch { return true }
    })()
    if (!flagEnabled) return ""

    // The brief shape comes from `ErrorReasoningBrief` in
    // `reasoning/error-reasoner.ts`; loose-typed on `ProviderPayload`
    // to avoid an import cycle into the reasoning module.
    const brief = payload.errorReasoningBrief as {
      rootCause?: string
      platformContext?: string
      alternativeCommands?: string[]
      recommendedCommand?: string
      confidence?: "HIGH" | "MEDIUM" | "LOW"
    }
    if (!brief.recommendedCommand || !brief.rootCause) return ""

    return buildErrorReasoningBlock({
      errorText: payload.errorReasoningErrorText ?? "(no error text captured)",
      tool: payload.errorReasoningFailedTool ?? "tool",
      brief: {
        rootCause: brief.rootCause,
        platformContext: brief.platformContext ?? "unknown",
        alternativeCommands: brief.alternativeCommands ?? [],
        recommendedCommand: brief.recommendedCommand,
        confidence: brief.confidence ?? "LOW",
      },
    })
  }

  /**
   * Stage 1 of free-tier quality enforcement plan: protected helper that
   * builds the verify-after-write block from this turn's tool results.
   * Returns empty string when:
   *   - The gate (`shouldForceVerifyAfterWrite`) says no, OR
   *   - No writes happened this turn
   *
   * The block is concatenated into `buildToolResultMessage`'s outgoing
   * text BEFORE the chunk plan section so the agent sees verify-first,
   * plan-next ordering.
   */
  protected renderVerifyAfterWriteBlock(
    payload: ProviderPayload,
    tools: Array<{ tool: string; result: Record<string, unknown> }>,
  ): string {
    const { filesWritten, dirsCreated } = extractWritesFromToolResults({ tools })
    if (filesWritten.length === 0 && dirsCreated.length === 0) return ""

    // Gate via free-tier-policy: free-tier always; paid on ≥3 files +
    // medium/complex complexity.
    const flagEnabled = (() => {
      try { return getFlag<boolean>("quality.force_verify_after_write") } catch { return true }
    })()
    const originalTask = this.runTasks.get(payload.runId) || payload.userMessage || ""
    const complexity = analyzeTaskComplexity(originalTask).complexity
    if (!shouldForceVerifyAfterWrite({
      model: payload.model,
      complexity,
      filesWrittenInChunk: filesWritten.length,
      flagEnabled,
    })) {
      return ""
    }

    return buildVerifyAfterWriteBlock({
      filesWritten,
      dirsCreated,
      // Stage 4.1 of awareness-and-verification-correctness plan:
      // the verify-after-write block embeds platform-specific
      // commands the model is told to run. Picking the SERVER's
      // platform here would put bash commands in front of a Windows
      // user (or vice versa) — defeating the block's whole point.
      platform: (payload.clientPlatform || process.platform) as NodeJS.Platform,
    })
  }

  /**
   * Stage 3 of free-tier quality enforcement plan: protected helper that
   * builds the mandatory self-review block when the cadence fires.
   *
   * Cadence is per-run (free-tier=2, paid=4); the scheduler tracks
   * `lastReviewAtChunk` so reviews don't fire every turn. Files to
   * review come from the prior chunk(s)'s writes (we surface the most
   * recently-written paths from runFilePaths). Marks the review fired
   * AFTER successful injection — caller doesn't need to do bookkeeping.
   *
   * Returns empty string when:
   *   - Flag off, OR
   *   - No chunks executed yet, OR
   *   - Cadence not met
   */
  protected renderMandatoryReviewBlock(
    payload: ProviderPayload,
    _tools: Array<{ tool: string; result: Record<string, unknown> }>,
  ): string {
    const flagEnabled = (() => {
      try { return getFlag<boolean>("quality.mandatory_self_review_enabled") } catch { return true }
    })()
    if (!flagEnabled) return ""

    const chunkHistory = getChunkHistory(payload.runId)
    if (chunkHistory.length === 0) return ""

    // chunkHistory is 0-indexed; the latest chunk's `index` is the
    // current chunk index. For scheduling, "have at least N chunks
    // happened?" maps to chunkIndex >= cadence - 1.
    const latestChunk = chunkHistory[chunkHistory.length - 1]
    const chunkIndex = latestChunk.index
    const cadence = getSelfReviewCadence(payload.model)

    if (!shouldForceSelfReview({
      runId: payload.runId,
      chunkIndex,
      cadence,
      flagEnabled,
    })) {
      return ""
    }

    // Files to review: recent writes from this run, capped at 6.
    // runFilePaths tracks every path written this run; we surface the
    // tail so the agent reviews the most recent chunks.
    const allPaths = this.runFilePaths.get(payload.runId) ?? []
    const filesToReview = allPaths.slice(-6)

    const block = buildReviewBlock({ filesToReview, chunkIndex })
    markReviewFired(payload.runId, chunkIndex)
    console.log(`[self-review] forced review at chunk ${chunkIndex} (cadence=${cadence}, files=${filesToReview.length})`)
    return block
  }


  buildInitialUserMessage(payload: ProviderPayload): string {
    let msg = ""

    if (payload.context?.sessionHistory) {
      msg += `${payload.context.sessionHistory}\n\n`
    }

    if (payload.context?.continueContext) {
      msg += `${payload.context.continueContext}\n\n`
    } else if (payload.context?.continueFrom) {
      const prev = payload.context.continueFrom
      msg += `IMPORTANT: You are continuing a previous task that ${prev.outcome === "failed" ? "FAILED" : "was interrupted"}.\n`
      msg += `Previous prompt: "${prev.prompt}"\n`
      if (prev.error) msg += `Error that occurred: ${prev.error}\n`
      if (prev.filesModified.length > 0) msg += `Files already modified: ${prev.filesModified.join(", ")}\n`
      if (prev.actions.length > 0) {
        const actionStr = prev.actions.map((a) => a.tool + (a.path ? ` ${a.path}` : "")).join(", ")
        msg += `Actions already taken: ${actionStr}\n`
      }
      msg += `\nPick up where the previous run left off. Do NOT redo work that was already completed successfully.\n\n`
    }

    msg += `Task: ${payload.userMessage}`

    // ─── Error-fix task: inject ultra-specific instructions to prevent hallucination ───
    const isErrorFixTask = /\b(fix|resolve|error|failed|cannot find|does not exist|ENOENT|ERESOLVE|Module not found)\b/i.test(payload.userMessage)
    if (isErrorFixTask) {
      msg += `\n\n═══ ERROR FIX RULES ═══`
      msg += `\n- This is an ERROR FIX task. Keep it MINIMAL — only fix what's broken.`
      msg += `\n- DO NOT create new files unless the error specifically requires a missing file.`
      msg += `\n- DO NOT create directories with file extensions (e.g. mkdir "Foo.tsx" is WRONG).`
      msg += `\n- DO NOT rewrite entire files. Use edit_file with search/replace to make targeted fixes.`
      msg += `\n- ALWAYS read_file FIRST to see current content, then use edit_file search/replace.`
      msg += `\n- For "Failed to resolve import": read the importing file, then remove or fix the bad import line.`
      msg += `\n- For "Cannot find module": check if the module needs installing or if the import path is wrong.`
      msg += `\n═══ END ERROR FIX RULES ═══`
    }

    if (payload.directoryTree && payload.directoryTree.length > 0) {
      const filtered = payload.directoryTree.filter((e) => !e.name.startsWith("sysbase"))
      if (filtered.length > 0) {
        const treeStr = filtered
          .map((e) => `${e.type === "directory" ? "[dir]" : "[file]"} ${e.name}`)
          .join("\n")
        msg += `\n\nCurrent project structure:\n${treeStr}`
      }
    }

    if (payload.context?.projectMemory) {
      const mem = Array.isArray(payload.context.projectMemory)
        ? payload.context.projectMemory.join("\n")
        : String(payload.context.projectMemory)
      msg += `\n\nProject context:\n${mem}`
    }

    if (payload.context?.projectKnowledge) {
      msg += `\n\n${payload.context.projectKnowledge}`
    }

    // Inject frontend design patterns when available
    if (payload.context?.frontendPatterns) {
      msg += `\n\n${payload.context.frontendPatterns}`
    }

    // ─── Inject live task pipeline — only after AI has generated its own plan ───
    const pipeline = getPipeline(payload.runId)
    if (pipeline && pipeline.steps.length > 0) {
      const currentStep = pipeline.steps.find((s) => s.status === "in_progress")
      const completedCount = pipeline.steps.filter((s) => s.status === "completed").length
      msg += `\n\n═══ YOUR PLAN (${completedCount}/${pipeline.steps.length} done) ═══`
      for (const s of pipeline.steps) {
        const icon = s.status === "completed" ? "✔" : s.status === "in_progress" ? "▸" : "○"
        msg += `\n  ${icon} ${s.label}`
      }
      if (currentStep) {
        msg += `\n\nFOCUS NOW: "${currentStep.label}". Complete it, then move to the next.`
      }
      msg += `\n═══ END PLAN ═══`
    }

    // ─── Phase 10: chunk plan injection ───
    // The chunk-planner (separate Gemini Flash call) decided which 1-5 files
    // this turn should produce. Surface that decision to the main model so it
    // honours the file list exactly. The reflector (next Flash call after
    // tool results) will catch any deviation.
    msg += renderChunkPlanSection(payload.chunkPlanBrief)

    return msg
  }

  parseJsonResponse(text: string, runId?: string): NormalizedResponse {
    let json: Record<string, unknown> | null = null

    // Strip OpenAI-Harmony / GPT-OSS framing tokens before parsing.
    // OpenRouter's `auto` model can route to gpt-oss variants which return:
    //   <|channel|>analysis<|message|> ...thoughts...
    //   <|channel|>commentary<|message|> {"name": "read_file", ...}
    //   <|channel|>final<|message|> ...answer...
    // Without stripping, JSON.parse sees the framing tokens and fails.
    const cleaned = stripHarmonyFraming(text)

    try {
      json = JSON.parse(cleaned)
    } catch {
      const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (fenceMatch) {
        try { json = JSON.parse(fenceMatch[1].trim()) } catch { /* ignore */ }
      }
      if (!json) {
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          try { json = JSON.parse(jsonMatch[0]) } catch { /* ignore */ }
        }
      }
    }

    // If the parsed JSON looks like raw tool args (path/content/command but no
    // `kind`), wrap it in a needs_tool envelope. Harmony "commentary" channels
    // emit just the args object — we infer the tool from the arg shape.
    if (json && !json.kind && hasToolArgShape(json)) {
      const inferred = inferToolFromArgs(json, cleaned)
      if (inferred) json = inferred
    }

    if (!json || !json.kind) {
      // Cap malformed-response recoveries — never silently coerce forever.
      if (runId) {
        const failures = (this.runParseFailures.get(runId) || 0) + 1
        this.runParseFailures.set(runId, failures)
        if (failures > BaseProvider.MAX_PARSE_FAILURES) {
          console.error(`[parse] Run ${runId} exceeded ${BaseProvider.MAX_PARSE_FAILURES} malformed responses — failing.`)
          this.runParseFailures.delete(runId)
          return {
            kind: "failed",
            error: `Model returned malformed JSON ${failures} times in a row. Raw text: "${text.slice(0, 300)}..."`,
            content: "Malformed model response after multiple recovery attempts.",
            usage: { inputTokens: 0, outputTokens: 0 }
          }
        }
        console.warn(`[parse] Malformed response ${failures}/${BaseProvider.MAX_PARSE_FAILURES} for run ${runId} — recovering with structured feedback.`)
      }

      // Try to recover truncated JSON — extract kind from partial text
      const kindMatch = text.match(/"kind"\s*:\s*"(needs_tool|completed|failed|waiting_for_user)"/)
      if (kindMatch && kindMatch[1] === "needs_tool") {
        // The response was truncated but we know it's needs_tool — ask AI to continue
        const reasoningMatch = text.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)"/)
        return {
          kind: "needs_tool" as const,
          content: reasoningMatch ? reasoningMatch[1] : "Response was truncated. Continuing with fewer files per batch.",
          reasoning: reasoningMatch ? reasoningMatch[1] : null,
          tool: "list_directory",
          args: { path: "." },
          usage: { inputTokens: 0, outputTokens: 0 }
        }
      }

      // Genuine malformed response (not truncated, not parseable). Send the model
      // structured feedback via list_directory + a clear "your last response was bad"
      // signal in the content field so the next tool_result reminds the model.
      return {
        kind: "needs_tool",
        tool: "list_directory",
        args: { path: "." },
        content: `⛔ Your previous response was not valid JSON. Raw text: "${text.slice(0, 300)}...". Respond ONLY with valid JSON matching the schema. No prose, no markdown fences.`,
        reasoning: "Malformed JSON received — forcing recovery via list_directory.",
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    }

    // Successful parse — reset the failure counter for this run
    if (runId) this.runParseFailures.delete(runId)

    // Extract content — handle cases where AI puts JSON in content field
    let content = (json.content as string) || ""
    if (content.trimStart().startsWith("{") && content.includes('"kind"')) {
      try {
        const inner = JSON.parse(content)
        if (inner.content && typeof inner.content === "string") {
          content = inner.content
        }
      } catch { /* not JSON, use as-is */ }
    }

    const normalized: NormalizedResponse = {
      kind: json.kind as NormalizedResponse["kind"],
      content,
      reasoning: (json.reasoning as string) || null,
      usage: { inputTokens: 0, outputTokens: 0 }
    }

    // Stage 1.5 of command-first-investigation: extract per-turn
    // `reasoningChain` if the main model emitted one. Filters non-string
    // and empty entries defensively so a malformed payload can't crash
    // downstream consumers. Caps at 6 entries per turn (the schema
    // contract — anything longer is the model running away).
    if (Array.isArray((json as Record<string, unknown>).reasoningChain)) {
      const chain = ((json as Record<string, unknown>).reasoningChain as unknown[])
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .slice(0, 6)
      if (chain.length > 0) normalized.reasoningChain = chain
    }

    if (json.kind === "needs_tool") {
      // Check for parallel tools array first
      if (Array.isArray(json.tools) && json.tools.length > 0) {
        normalized.tools = (json.tools as Array<Record<string, unknown>>).map((tc, i) => {
          const args = parseArgsRobust(tc.args_json, tc.args, tc.tool as string)
          return {
            id: (tc.id as string) || `tc_${i}`,
            tool: tc.tool as string,
            args
          } satisfies ToolCall
        })
        // Backwards compat: set singular tool/args to first item
        normalized.tool = normalized.tools[0].tool
        normalized.args = normalized.tools[0].args
      } else {
        // Single tool (existing path)
        normalized.tool = json.tool as string
        normalized.args = parseArgsRobust(json.args_json, json.args, json.tool as string)
      }
    }

    // ─── Args rescue: if write_file/edit_file has no content, try harder to recover ───
    // Skip for targeted edits (search/replace, line edit, insert) — those don't need full content
    if (normalized.kind === "needs_tool") {
      const needsRescue = (tc: { tool: string; args?: Record<string, unknown> }) => {
        if (tc.tool === "write_file" && !tc.args?.content) return true
        if (tc.tool === "edit_file") {
          const a = tc.args || {}
          // Targeted edit modes are valid without content/patch
          if (a.search !== undefined || a.line_start !== undefined || a.insert_at !== undefined) return false
          if (!a.content && !a.patch) return true
        }
        return false
      }

      const rescueTools = normalized.tools
        ? normalized.tools.filter(needsRescue)
        : needsRescue({ tool: normalized.tool || "", args: normalized.args })
          ? [{ tool: normalized.tool || "", args: normalized.args || {} }]
          : []

      for (const tc of rescueTools) {
        const rawArgs = tc.args as Record<string, unknown>
        if (typeof rawArgs.args_json === "string") {
          try {
            const inner = JSON.parse(rawArgs.args_json)
            if (inner.content) { rawArgs.content = inner.content; rawArgs.path = inner.path || rawArgs.path }
            if (inner.patch) { rawArgs.patch = inner.patch; rawArgs.path = inner.path || rawArgs.path }
            // Also try to recover search/replace from nested args
            if (inner.search !== undefined) { rawArgs.search = inner.search; rawArgs.replace = inner.replace ?? "" }
          } catch { /* ignore */ }
        }
        if (!rawArgs.content && rawArgs.code) rawArgs.content = rawArgs.code
        if (!rawArgs.content && rawArgs.text) rawArgs.content = rawArgs.text
        if (!rawArgs.content && rawArgs.file_content) rawArgs.content = rawArgs.file_content

        if (!rawArgs.content && !rawArgs.patch && !rawArgs.search) {
          console.warn(`[args-rescue] write/edit_file for "${rawArgs.path || "?"}" has NO content. Raw keys: [${Object.keys(rawArgs).join(", ")}]`)
        }
      }
    }

    // ─── Tool name sanitizer + validation gate: fix or reject hallucinated tools ───
    if (normalized.kind === "needs_tool") {
      let hasInvalidTool = false
      const rejectedTools: string[] = []

      if (normalized.tool) {
        const sanitized = sanitizeToolName(normalized.tool)
        if (sanitized === null) {
          hasInvalidTool = true
          rejectedTools.push(normalized.tool)
        } else {
          normalized.tool = sanitized
        }
      }
      if (normalized.tools) {
        for (const tc of normalized.tools) {
          const sanitized = sanitizeToolName(tc.tool)
          if (sanitized === null) {
            hasInvalidTool = true
            rejectedTools.push(tc.tool)
          } else {
            tc.tool = sanitized
          }
        }
        // Update backwards-compat fields
        normalized.tool = normalized.tools[0].tool
        normalized.args = normalized.tools[0].args
      }

      // ─── HARD GATE: reject unknown tools — force AI to use valid ones ───
      if (hasInvalidTool) {
        const validList = Array.from(VALID_TOOLS).join(", ")
        console.error(`[tool-gate] BLOCKED unknown tool(s): ${rejectedTools.join(", ")} — forcing retry with valid tools`)
        // Stage 3 of reasoning-chain-provider-parity plan: preserve
        // the model's reasoningChain even when the tool gate fires.
        // The model's deliberation about WHY it picked the invalid
        // tool is exactly what the user wants to see in the peek —
        // it explains the mistake the override is correcting.
        return {
          kind: "needs_tool",
          tool: "list_directory",
          args: { path: "." },
          content: `⛔ TOOL REJECTED: You used unknown tool(s): ${rejectedTools.join(", ")}. These do NOT exist.\n\nYou may ONLY use these tools:\n${validList}\n\nPick the correct tool and try again. Do NOT invent tool names.`,
          reasoning: null,
          reasoningChain: normalized.reasoningChain,
          usage: { inputTokens: 0, outputTokens: 0 }
        }
      }
    }

    // Extract AI-generated task plan from first response.
    // Phase 18 Stage 5: defensively DROP the taskPlan when the
    // emission gate said skip. Free-tier models sometimes ignore the
    // system-rules instruction and emit a taskPlan on a simple Q&A
    // anyway; this is the second layer of defense (Phase 19's cli
    // render gate is the first). Same decision logic as the prompt
    // builder via `shouldIncludeTaskPlanInstruction` so the two
    // sides always agree.
    if (json.taskPlan && typeof json.taskPlan === "object") {
      const gate = runId ? this.runTaskPlanGate.get(runId) : undefined
      const gatingEnabled = (() => {
        try { return getFlag<boolean>("quality.taskplan_emission_gating_enabled") }
        catch { return true }
      })()
      const gateSaysInclude = shouldIncludeTaskPlanInstruction({
        runIntent: gate?.runIntent ?? null,
        complexity: gate?.taskComplexity ?? null,
        gatingEnabled,
      })
      if (!gateSaysInclude) {
        console.log(`[ai-plan] dropping stray taskPlan emitted on non-implement / trivial-complexity run (intent=${gate?.runIntent ?? "null"}, complexity=${gate?.taskComplexity ?? "null"})`)
      } else {
        const plan = json.taskPlan as Record<string, unknown>
        const title = (plan.title as string) || ""
        const steps = Array.isArray(plan.steps) ? (plan.steps as unknown[]).filter((s) => typeof s === "string").map(String) : []
        if (steps.length > 0) {
          normalized.taskPlan = { title, steps }
          console.log(`[ai-plan] AI generated task plan: "${title}" (${steps.length} steps)`)
        }
      }
    }

    // Phase 15 Stage 4: extract `memoryFeedback` from the response. The
    // handler will run this through `applyMemoryFeedback` (with the
    // per-id cross-validation guards) before the response returns to
    // the cli. The pure extractor below normalises malformed payloads
    // (numbers, nulls, non-arrays) into a clean shape or null.
    const mf = extractMemoryFeedback(json)
    if (mf) normalized.memoryFeedback = mf

    if (json.kind === "failed") {
      normalized.error = (json.content as string) || "Model reported failure"
    }

    return normalized
  }

  /**
   * Stage 2 of plan 2026-05-16-server-hardening-and-error-source-distinction.md:
   * `errorSource` discriminator threaded through. Providers should pass
   * `"sysflow_infra"` for their own API quota / auth / connection
   * failures so the cli's error-reasoning chain doesn't try to "fix"
   * them by mutating the user's project. Default `"unknown"` preserves
   * legacy behaviour for any path that hasn't been updated yet.
   */
  failedResponse(error: string, errorSource: "sysflow_infra" | "user_machine" | "unknown" = "unknown"): NormalizedResponse {
    return {
      kind: "failed",
      error,
      errorSource,
      usage: { inputTokens: 0, outputTokens: 0 }
    }
  }

  protected emptyUsage(): TokenUsage {
    return { inputTokens: 0, outputTokens: 0 }
  }
}

// ─── Shared system prompt ───
//
// The prompt is now assembled from sections in providers/prompt/sections/*.ts via
// providers/prompt/build.ts. SHARED_SYSTEM_PROMPT remains exported so existing
// imports keep working — it's the model-agnostic, no-context assembly.
// Providers that have a per-request context (cwd, model id, git branch) should
// call getSystemPrompt(ctx) instead.

export const SHARED_SYSTEM_PROMPT: string = buildSystemPrompt({}).full

export function getSystemPrompt(ctx: PromptCtx = {}): string {
  return buildSystemPrompt(ctx).full
}

// ─── OpenAI-Harmony / GPT-OSS framing stripper ───
//
// gpt-oss models (and OpenRouter's "auto" route, when it lands there) emit
// responses wrapped in tokens like:
//   <|start|>assistant<|channel|>analysis<|message|>...thoughts...<|end|>
//   <|start|>assistant<|channel|>commentary<|message|>{ "path": "..." }<|end|>
//   <|start|>assistant<|channel|>final<|message|>...answer...<|return|>
// JSON.parse on the raw text rejects everything because of the angle-bracket
// tokens. Strip them so the parser can see the underlying JSON / text.

export function stripHarmonyFraming(text: string): string {
  if (!text || !text.includes("<|")) return text
  // Drop the analysis (chain-of-thought) channel entirely — it's prose, not
  // JSON, and pulling it into the JSON-parse window only adds noise.
  let stripped = text.replace(/<\|start\|>[^<]*?<\|channel\|>analysis<\|message\|>[\s\S]*?(?=<\|(?:start|end|channel|return)\|>|$)/g, "")
  // Strip remaining channel/message/start/end markers in place.
  stripped = stripped
    .replace(/<\|start\|>[^<]*?<\|message\|>/g, "")
    .replace(/<\|start\|>[^<]*?<\|channel\|>[^<]*?<\|message\|>/g, "")
    .replace(/<\|channel\|>[^<]*?<\|message\|>/g, "")
    .replace(/<\|constrain\|>[^<]*?<\|message\|>/g, "")
    .replace(/<\|recipient\|>[^<]*?<\|message\|>/g, "")
    .replace(/<\|return\|>/g, "")
    .replace(/<\|end\|>/g, "")
    .replace(/<\|start\|>/g, "")
    .replace(/<\|im_start\|>[^\n<]*\n?/g, "")
    .replace(/<\|im_end\|>/g, "")
  return stripped.trim()
}

/** True when the parsed JSON looks like tool args (no envelope kind). */
function hasToolArgShape(obj: Record<string, unknown>): boolean {
  if (obj.kind || obj.tool || obj.tools) return false
  return typeof obj.path === "string"
      || typeof obj.command === "string"
      || typeof obj.from === "string"
      || (Array.isArray(obj.paths) && obj.paths.length > 0)
}

/**
 * Wrap raw tool args in a `needs_tool` envelope. Returns null if we can't
 * confidently infer the tool name. Looks at the arg shape and any
 * <|recipient|>functions.<name>… hint that survived the strip step.
 */
function inferToolFromArgs(args: Record<string, unknown>, originalText: string): Record<string, unknown> | null {
  // The pre-strip text might carry a "<|recipient|>functions.read_file" hint.
  const recipient = originalText.match(/functions\.([a-z_][a-z0-9_]*)/i)?.[1]
  let tool: string | null = recipient ?? null

  if (!tool) {
    if (typeof args.command === "string") tool = "run_command"
    else if (typeof args.from === "string" && typeof args.to === "string") tool = "move_file"
    else if (typeof args.path === "string" && typeof args.content === "string") tool = "write_file"
    else if (typeof args.path === "string" && (typeof args.search === "string" || typeof args.line_start === "number" || typeof args.insert_at === "number")) tool = "edit_file"
    else if (typeof args.path === "string" && (typeof args.offset === "number" || typeof args.limit === "number")) tool = "read_file"
    else if (typeof args.path === "string") tool = "read_file"
    else if (Array.isArray(args.paths)) tool = "batch_read"
  }
  if (!tool) return null
  return {
    kind: "needs_tool",
    tool,
    args,
    content: `Inferred tool=${tool} from harmony commentary args`,
  }
}

// ─── Phase 10: chunk plan injection ───
//
// Render the chunk-planner's brief as a labelled section the main model can't
// miss. Empty when no chunkPlanBrief is set (chunked loop disabled, free
// quota exhausted, trivial-task short-circuit, etc.).

interface ChunkPlanLike {
  nextAction?: string
  files?: string[]
  rationale?: string
  dependencies?: string[]
  expectedSizeBin?: string
  isFinalChunk?: boolean
}

export function renderChunkPlanSection(brief: unknown): string {
  if (!brief || typeof brief !== "object") return ""
  const b = brief as ChunkPlanLike
  if (!Array.isArray(b.files) || b.files.length === 0) return ""

  const lines: string[] = []
  lines.push("")
  lines.push("═══ CHUNK PLAN (HONOUR EXACTLY) ═══")
  if (b.nextAction) lines.push(`action: ${b.nextAction}`)
  lines.push(`files (${b.files.length}):`)
  for (const f of b.files) lines.push(`  - ${f}`)
  if (b.rationale) lines.push(`rationale: ${b.rationale}`)
  if (Array.isArray(b.dependencies) && b.dependencies.length > 0) {
    lines.push(`reads from prior chunks: ${b.dependencies.join(", ")}`)
  }
  if (b.expectedSizeBin) lines.push(`size budget: ${b.expectedSizeBin}`)
  if (b.isFinalChunk) lines.push(`THIS IS THE FINAL CHUNK — emit kind: completed after the writes resolve.`)
  lines.push("Write ONLY the files listed above. The reflector will catch deviations.")
  lines.push("═══ END CHUNK PLAN ═══")
  return "\n" + lines.join("\n")
}
