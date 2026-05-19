import crypto from "node:crypto"
import { createTask } from "../services/task.js"
import { loadProjectContext } from "../services/context.js"
import { saveRun } from "../store/runs.js"
import { persistModelUsage } from "../store/usage.js"
import { buildSessionSummary, getLastSession, saveOrphanedSessions, buildContinueContext } from "../store/sessions.js"
import { buildContextForPrompt, deprecateStaleEntries } from "../store/context.js"
import { callModelAdapter } from "../providers/adapter.js"
import { mapNormalizedResponseToClient } from "../providers/normalize.js"
import { analyzeTaskComplexity } from "../services/completion-guard.js"
import { actionPlanner } from "../services/action-planner.js"
import { initRunContext, ingestDirectoryTree } from "../services/context-manager.js"
import { setRunPlatform } from "../services/run-platform-store.js"
import { validatePerFileReasoning, buildInsufficientReasoningPrompt, MAX_PER_FILE_REASONING_REJECTIONS } from "../services/per-file-reasoning-guard.js"
import { isFrontendTask, detectFrontendStack, getFrontendPatterns } from "../knowledge/frontend-patterns.js"
import { accumulateFrontendContent } from "../services/frontend-quality-guard.js"
import { detectErrorForSearch, buildErrorSearchOverride, setConfigSkipList, setExpectedArtifacts, setRepoState } from "../services/setup-intelligence.js"
import { runProjectInitChain } from "../reasoning/project-init-reasoner.js"
import { detectErrorContext, setPendingError, detectAllErrors, setPendingErrorQueue } from "../services/error-autofix.js"
import { createPipelineFromAiPlan, createFallbackPipeline, pipelineToTaskMeta } from "../services/task-pipeline.js"
import { detectScaffoldingNeed, buildScaffoldConfirmationMessage } from "../scaffold/index.js"
import { estimateTokens, shouldBlockOnTokens } from "../services/context-budget.js"
import { runReasoning, getReasonerBackendForRun } from "../reasoning/task-reasoner.js"
import { classifyIntent, classifyIntentSmart } from "../reasoning/intent-classifier.js"
import { recommendScaffold, resolveCommand, getInstallCommand } from "../scaffold/index.js"
import { recordImplementSummary, recordOriginalIntent, recordDecision, recordBugPattern, applyMemoryFeedback } from "../memory-store/index.js"
import { runReasoningChain } from "../reasoning/chain.js"
import { shouldRunPreflightElaboration, resolveMaxFilesPerChunk } from "../services/free-tier-policy.js"
import { recordChunkStart } from "../services/chunk-state.js"
import { seedLedgerFromBuildPlan } from "../services/task-ledger.js"
import type { ChunkPlanBrief } from "../reasoning/reasoning-schema.js"
import { getFlag } from "../services/flags.js"
import { getConfidence, getThresholdState } from "../services/confidence-tracker.js"
import { setLastReasoning } from "../services/last-reasoning-store.js"
import type { ClientResponse, NormalizedResponse } from "../types.js"

interface UserMessageBody {
  projectId: string
  model: string
  content: string
  command?: string
  cwd: string
  sysbasePath?: string
  directoryTree?: Array<{ name: string; type: string }>
  userId?: string | null
  chatId?: string | null
  planMode?: boolean
  /**
   * Stage 4.1 of awareness-and-verification-correctness plan: the
   * cli sends its host platform here so the server's prompt builder
   * renders env-info matching the user's OS, not the server's.
   * Optional for backwards compatibility — legacy clients fall
   * through to `process.platform`.
   */
  client?: {
    platform?: string
    arch?: string
  }
}

export async function handleUserMessage(body: UserMessageBody): Promise<ClientResponse> {
  const runId = crypto.randomUUID()
  const taskId = crypto.randomUUID()

  // Stage 4.1 of awareness-and-verification-correctness plan: capture
  // the user's host platform so every downstream prompt-builder call
  // can render bash vs PowerShell command examples that match the
  // user's OS — not the server's. Fallback: `process.platform`
  // (legacy behaviour for cli versions that don't send `client`).
  const clientPlatform = (body.client?.platform || process.platform) as NodeJS.Platform
  setRunPlatform(runId, clientPlatform)
  if (body.client?.platform && body.client.platform !== process.platform) {
    console.log(`[platform] run ${runId} client=${body.client.platform} (server=${process.platform})`)
  }

  await saveOrphanedSessions(body.projectId, body.chatId)

  // Phase 16 Stage 1: classify task complexity pre-flight, before the
  // preflight reasoning chain runs. The classifier is pure regex on the
  // prompt so it's safe to fire this early. Phase 16 Stage 3 will use
  // this result to gate the chained `implement_elaborate` Flash; for
  // now it's plumbing and the existing post-hoc completion-validation
  // call site (below, after the model adapter) reads from this same
  // value instead of re-running the regex.
  const taskComplexity = analyzeTaskComplexity(body.content)
  console.log(`[user-message] task complexity: ${taskComplexity.complexity} (model=${body.model})`)

  const task = await createTask({
    taskId,
    runId,
    prompt: body.content,
    command: body.command,
    model: body.model,
    projectId: body.projectId
  })

  const context = await loadProjectContext({
    projectId: body.projectId,
    command: body.command,
    prompt: body.content,
    model: body.model,
    cwd: body.cwd,
    sysbasePath: body.sysbasePath,
    task
  }) as Record<string, unknown>

  const sessionSummary = await buildSessionSummary(body.projectId, body.chatId)
  if (sessionSummary) {
    // ─── Fresh-start detection: filter stale session references ───
    const currentFiles = (body.directoryTree || []).map((e) => e.name)
    const hasScaffoldedContent = currentFiles.length > 2 // more than just config files

    if (!hasScaffoldedContent && sessionSummary.includes("write_file")) {
      // Old sessions reference files that no longer exist — this is a fresh start
      context.sessionHistory = `⚠️ FRESH START DETECTED: Previous session data references files that no longer exist in this directory. The project was deleted or reset.\n\nCurrent directory contains: ${currentFiles.length > 0 ? currentFiles.join(", ") : "(empty)"}\n\nIMPORTANT: Ignore all previous file references. Start the task from scratch. Do NOT try to read, scan, or list directories from previous sessions — they do not exist. Create everything fresh.`
    } else {
      context.sessionHistory = sessionSummary
    }
  }

  const projectContext = await buildContextForPrompt(body.projectId, body.content)
  if (projectContext) {
    context.projectKnowledge = projectContext
  }

  // ─── Smart context loading: not just for /continue ───
  // Load continuation context when:
  // 1. Explicit /continue command
  // 2. New prompt that looks like a fix/debug request for the same project
  // 3. New prompt in a chat that has recent sessions (project already in progress)

  const isExplicitContinue = body.command === "/continue"
  const isFixRequest = /\b(fix|error|bug|issue|broken|wrong|fail|crash|not working|doesn't work|doesn't compile)\b/i.test(body.content)
  const isFollowUp = /\b(what'?s?\s*(the\s+)?(missing|wrong|left|remaining|incomplete|next)|missing\s+implementation|what\s+did\s+(i|you|we)\s+miss|check\s+(the\s+)?(status|progress)|review|improve|update|change|modify|add\s+to|enhance)\b/i.test(body.content)
  const lastSession = await getLastSession(body.projectId, body.chatId)
  const hasRecentWork = lastSession && lastSession.filesModified.length > 0

  if (isExplicitContinue || ((isFixRequest || isFollowUp) && hasRecentWork) || (hasRecentWork && body.chatId)) {
    const continueCtx = await buildContinueContext(body.projectId, body.chatId)
    if (continueCtx) {
      const currentFiles = (body.directoryTree || []).map((e) => e.name)
      if (currentFiles.length <= 2 && continueCtx.includes("Files already created:")) {
        context.continueContext = `⚠️ FRESH START: Previous files were deleted. Start from scratch. Current directory: ${currentFiles.join(", ") || "(empty)"}`
      } else {
        context.continueContext = continueCtx
      }
    }

    if (lastSession) {
      context.continueFrom = lastSession
    }

    if (isFixRequest && !isExplicitContinue) {
      context.continueContext = (context.continueContext || "") +
        `\n\n═══ FIX REQUEST CONTEXT ═══\nThe user is asking you to fix an error in the project you previously built. Use the continuation context above to understand what was created. Read the affected files, fix the issue, and continue completing any unfinished work from the original task.`
    }

    if (isFollowUp && !isFixRequest && !isExplicitContinue) {
      context.continueContext = (context.continueContext || "") +
        `\n\n═══ FOLLOW-UP CONTEXT ═══\nThe user is asking about work you already started. Use the continuation context above. Work in the SAME directory as the previous session — do NOT scaffold a new project or switch to a different directory.`
    }
  }

  await saveRun({
    runId,
    taskId,
    projectId: body.projectId,
    model: body.model,
    content: body.content,
    command: body.command,
    cwd: body.cwd,
    sysbasePath: body.sysbasePath,
    userId: body.userId || null,
    chatId: body.chatId || null,
    status: "running"
  })

  // ─── Phase 11 Stage 3: persist the LITERAL user prompt as `original_intent`
  // memory. The Phase 11 divergence detector reads this back so it compares
  // chunks against the user's actual ask, not the preflight brief's
  // interpretation. Best-effort; never blocks the run. Dedup is by content
  // hash so a repeat prompt is a no-op upsert.
  if (body.cwd) {
    recordOriginalIntent(body.cwd, body.content, { runId, trigger: "user_message" })
      .catch(() => { /* best-effort */ })
  }

  // ─── Initialize smart context manager for this run ───
  initRunContext(runId, body.content)
  if (body.directoryTree && body.directoryTree.length > 0) {
    ingestDirectoryTree(runId, body.directoryTree)
  }

  // ─── Cheap synchronous early-returns FIRST (Plan
  //     2026-05-18-reasoning-speed-and-rate-limit-overhaul.md Stage 1):
  //     scaffold-confirmation, frontend-pattern injection, error-aware
  //     fix path, and the pre-API token guard all short-circuit BEFORE
  //     we pay for any Flash call. Pre-Stage-1 these ran AFTER
  //     project-init's await — meaning a prompt that early-returned on
  //     scaffold-options still paid for the project-init Flash call
  //     just to discard the brief.
  //
  //     These checks are pure-sync on user input + dirTree; none depend
  //     on the reasoning briefs that follow. Moving them up is safe.
  // ─── Deprecate stale context entries (cheap, runs once per new prompt) ───
  deprecateStaleEntries(body.projectId, 30).catch(() => { /* non-blocking */ })

  // ─── Scaffolding Confirmation: ask user before scaffolding ───
  const scaffoldOptions = detectScaffoldingNeed(body.content, body.directoryTree || [])
  if (scaffoldOptions) {
    console.log(`[scaffold] Detected new project — presenting ${scaffoldOptions.length} scaffolding options to user`)
    return {
      status: "waiting_for_user",
      runId,
      content: buildScaffoldConfirmationMessage(scaffoldOptions),
    } as ClientResponse
  }

  // ─── Frontend Design Intelligence: inject patterns when frontend work is detected ───
  if (isFrontendTask(body.content)) {
    const stack = detectFrontendStack(body.content, body.directoryTree)
    if (stack) {
      const patterns = getFrontendPatterns(stack, body.content)
      context.frontendPatterns = patterns
      console.log(`[frontend-design] Detected frontend task (stack: ${stack}) — injecting prompt-aware design brief`)
    }
  }

  // ─── Error-Aware Fix: parse error, search for file first, then read + guide the AI ───
  const errorCtx = detectErrorContext(body.content)
  if (errorCtx) {
    const ctx = errorCtx.ctx
    const fileName = ctx.sourceFile.split("/").pop() || ctx.sourceFile
    const baseName = fileName.replace(/\.[^.]+$/, "")
    console.log(`[error-aware] Detected fixable error: "${ctx.description}" — searching for "${baseName}" first`)
    setPendingError(runId, ctx)

    const allErrors = detectAllErrors(body.content)
    if (allErrors.length > 1) {
      const remaining = allErrors.filter(e => !(e.sourceFile === ctx.sourceFile && e.targetImport === ctx.targetImport))
      if (remaining.length > 0) {
        setPendingErrorQueue(runId, remaining)
        console.log(`[error-aware] Queued ${remaining.length} additional error(s) for sequential fixing`)
      }
    }

    const allErrorsForPipeline = allErrors.length > 0
      ? allErrors.map(e => ({ sourceFile: e.sourceFile, targetImport: e.targetImport }))
      : [{ sourceFile: ctx.sourceFile, targetImport: ctx.targetImport }]
    const pipeline = createFallbackPipeline(runId, body.content, allErrorsForPipeline)

    const searchAction: NormalizedResponse = {
      kind: "needs_tool",
      tool: "search_files",
      args: { query: baseName, glob: `**/${baseName}.*` },
      content: `Searching for "${baseName}" to find its actual path and extension.`,
      reasoning: `The error references "${ctx.sourceFile}" but the extension may differ. Searching to find the real file.`,
      usage: { inputTokens: 0, outputTokens: 0 },
      task: pipelineToTaskMeta(pipeline)
    }

    return mapNormalizedResponseToClient(runId, searchAction)
  }

  // ─── Pre-API token guard: refuse oversized payloads BEFORE Flash calls ───
  const estimatedTokens =
    estimateTokens(body.content) +
    estimateTokens(body.directoryTree) +
    estimateTokens(context.sessionHistory) +
    estimateTokens(context.projectMemory) +
    estimateTokens(context.projectKnowledge) +
    estimateTokens(context.frontendPatterns) +
    estimateTokens(context.continueContext)
  if (shouldBlockOnTokens(estimatedTokens, body.model)) {
    console.warn(`[token-guard] BLOCKED: estimated ${estimatedTokens} tokens exceeds ${body.model} effective window`)
    return {
      status: "failed",
      runId,
      error: `Prompt too long (~${estimatedTokens} tokens). Try a shorter prompt or fewer @file mentions.`,
      errorCode: "prompt_too_long",
    } as ClientResponse
  }

  // ─── PHASE A (Stage 1 parallelization): 3 independent upfront Flash calls ─
  //     project-init, preflight reasoning, and intent classification have
  //     NO dependencies between them. Pre-Stage-1 they ran sequentially —
  //     wall-clock = sum of all three latencies. Running in parallel cuts
  //     to wall-clock = MAX of the three. On free-tier models where each
  //     call is ~3-8s, this is roughly a 60-70% latency reduction on the
  //     upfront block alone.
  //
  //     Error isolation: each promise's `.catch` returns null (or the
  //     classifier's regex fallback) so a single failure doesn't poison
  //     the others. Side effects (setRepoState, seedLedger,
  //     intent-classifier log) apply AFTER the await so the order of
  //     observable state mutations matches pre-Stage-1 behaviour.
  //
  //     Source: plan `.claude/plans/2026-05-18-reasoning-speed-and-rate-limit-overhaul.md`.
  const projectInitEnabled = (() => {
    try { return getFlag<boolean>("quality.project_init_reasoning_enabled", body.sysbasePath as string | undefined) }
    catch { return true }
  })()
  const projectInitMaxIters = projectInitEnabled
    ? (() => {
        try { return getFlag<number>("reasoning.project_init_max_iterations", body.sysbasePath as string | undefined) }
        catch { return 3 }
      })()
    : 3

  const [projectInitBrief, reasoningBriefRaw, intentResult] = await Promise.all([
    projectInitEnabled
      ? runProjectInitChain({
          directoryTree: (body.directoryTree ?? []) as Array<{ name: string; type: "file" | "directory" }>,
          userMessage: body.content,
          platform: clientPlatform,
          model: body.model,
          maxIterations: projectInitMaxIters,
        }).catch((err: unknown) => {
          console.warn(`[project-init] chain threw:`, (err as Error).message)
          return null
        })
      : Promise.resolve(null),
    runReasoning({
      trigger: "preflight",
      userMessage: body.content,
      model: body.model,
      cwd: body.cwd,
      sysbasePath: body.sysbasePath,
      runId,
    }).catch((err: unknown) => {
      console.warn(`[reasoning] preflight failed:`, (err as Error).message)
      return null
    }),
    classifyIntentSmart({
      userMessage: body.content,
      runId,
      model: body.model,
    }),
  ])
  const reasoningBrief: unknown = reasoningBriefRaw

  // ─── Apply project-init side effects ───
  if (projectInitBrief) {
    console.log(`[project-init] committed: repoState=${projectInitBrief.repoState} fileCount=${projectInitBrief.fileCount} confidence=${projectInitBrief.confidence} iterations=${projectInitBrief.iterations}`)
    setRepoState(runId, projectInitBrief.repoState)
    if (
      (projectInitBrief.repoState === "empty" || projectInitBrief.repoState === "small") &&
      projectInitBrief.confidence !== "LOW" &&
      projectInitBrief.skipConfigVerificationFor.length > 0
    ) {
      setConfigSkipList(runId, projectInitBrief.skipConfigVerificationFor)
      console.log(`[project-init] seeded action-planner skip list (${projectInitBrief.skipConfigVerificationFor.length} entries)`)
    }
    if (projectInitBrief.confidence !== "LOW") {
      setExpectedArtifacts(runId, projectInitBrief.expectedArtifacts)
      if (projectInitBrief.expectedArtifacts.length > 0) {
        console.log(`[project-init] LLM committed expectedArtifacts: ${projectInitBrief.expectedArtifacts.join(", ")}`)
      }
    }
  }

  // ─── Apply preflight side effects ───
  if (reasoningBriefRaw && reasoningBriefRaw.pipeline === "implement" && reasoningBriefRaw.implementBrief) {
    const buildPlan = reasoningBriefRaw.implementBrief.buildPlan ?? []
    if (Array.isArray(buildPlan) && buildPlan.length > 0) {
      seedLedgerFromBuildPlan(runId, buildPlan)
    }
  }
  if (reasoningBriefRaw && reasoningBriefRaw.decision === "proceed" && reasoningBriefRaw.confidence !== "LOW") {
    if (reasoningBriefRaw.pipeline === "implement" && reasoningBriefRaw.implementBrief) {
      recordImplementSummary(
        body.cwd,
        { implementBrief: reasoningBriefRaw.implementBrief, confidence: reasoningBriefRaw.confidence },
        { runId, trigger: "preflight" },
      ).catch(() => { /* best-effort */ })
    } else if (reasoningBriefRaw.pipeline === "bug" && reasoningBriefRaw.bugBrief) {
      const bb = reasoningBriefRaw.bugBrief
      const summary = [
        `Symptom: ${bb.symptom}`,
        `Boundary: ${bb.suspectedBoundary}`,
        bb.rootCauseGuess ? `Root cause: ${bb.rootCauseGuess}` : null,
        bb.proposedFix?.description ? `Fix: ${bb.proposedFix.description} (scope: ${bb.proposedFix.scope ?? "?"})` : null,
      ].filter(Boolean).join("\n")
      recordBugPattern(
        body.cwd,
        summary,
        bb.proposedFix?.filesAffected,
        { runId, trigger: "preflight" },
        { confidence: reasoningBriefRaw.confidence },
      ).catch(() => { /* best-effort */ })
    } else if (reasoningBriefRaw.pipeline === "decision" && reasoningBriefRaw.decisionBrief) {
      recordDecision(
        body.cwd,
        { decisionBrief: reasoningBriefRaw.decisionBrief, confidence: reasoningBriefRaw.confidence },
        { runId, trigger: "preflight" },
      ).catch(() => { /* best-effort */ })
    }
  }

  // ─── Apply intent classifier side effects ───
  const runIntent = intentResult.hint
  if (intentResult.source !== "cache") {
    console.log(`[intent-classifier] run ${runId} → ${runIntent} (source: ${intentResult.source}${intentResult.paragraphs?.length ? `, ${intentResult.paragraphs.length} paragraph${intentResult.paragraphs.length === 1 ? "" : "s"}` : ""})`)
  }

  // ─── Preflight ask_user short-circuit (saves Phase B Flash calls) ───
  if (reasoningBriefRaw && reasoningBriefRaw.pipeline !== "simple" && reasoningBriefRaw.decision === "ask_user" && reasoningBriefRaw.missingContext.length > 0) {
    const lines: string[] = []
    lines.push(`Before I start, I need a few things to avoid guessing:`)
    lines.push("")
    for (const m of reasoningBriefRaw.missingContext) {
      lines.push(`• **${m.field}** — ${m.suggestedQuestion}` + (m.exampleValue ? `\n   _e.g._ \`${m.exampleValue}\`` : ""))
    }
    lines.push("")
    if (reasoningBriefRaw.pipeline === "implement" && reasoningBriefRaw.implementBrief) {
      lines.push(`I'm planning to use **${reasoningBriefRaw.implementBrief.recommendedStack.language}**` +
        (reasoningBriefRaw.implementBrief.recommendedStack.frameworks.length ? ` + ${reasoningBriefRaw.implementBrief.recommendedStack.frameworks.join(" + ")}` : "") +
        ` — ${reasoningBriefRaw.implementBrief.recommendedStack.rationale}`)
    } else if (reasoningBriefRaw.pipeline === "bug" && reasoningBriefRaw.bugBrief) {
      lines.push(`I suspect a **${reasoningBriefRaw.bugBrief.suspectedBoundary}** issue — paste the requested context and I'll narrow it down.`)
    }
    console.log(`[reasoning] preflight ask_user with ${reasoningBriefRaw.missingContext.length} questions`)
    return {
      status: "waiting_for_user",
      runId,
      message: lines.join("\n"),
      reasoningBrief: reasoningBriefRaw,
    } as ClientResponse
  }

  // ─── Phase 6 scaffold-first (moved up — saves Phase B Flash calls when
  //     auto-trust matches). Only needs reasoningBrief, not the chunked-loop
  //     planner or elaboration. ───
  try {
    const briefAny = reasoningBrief as never as Parameters<typeof recommendScaffold>[0]["brief"]
    const recommendation = recommendScaffold({
      brief: briefAny,
      userMessage: body.content,
      cwd: body.cwd,
      directoryTree: body.directoryTree as never,
    })
    if (recommendation.shouldScaffold && recommendation.autoTrust && recommendation.scaffolder) {
      const scaffoldCmd = resolveCommand(recommendation.scaffolder, recommendation.projectName)
      const installCmd = getInstallCommand(recommendation.scaffolder, recommendation.projectName)
      console.log(`[scaffold-first] auto-trust ${recommendation.scaffolder.stackKey}: ${scaffoldCmd} (note: simple stacks like Vite-family have autoTrust=false and fall through to hand-writing)`)

      const postScaffoldNote = recommendation.scaffolder.postScaffoldNote
      const followUpLines: string[] = []
      followUpLines.push(`[SCAFFOLD COMPLETE] You scaffolded "${recommendation.projectName}" using ${recommendation.scaffolder.displayName}.`)
      followUpLines.push(`The scaffolder created the standard file layout — DO NOT recreate files it already produced. Read package.json first to see what's there.`)
      if (installCmd) {
        followUpLines.push(`Next: run \`${installCmd}\` to install deps. The permission system will ask the user once.`)
      }
      if (postScaffoldNote) followUpLines.push(`NOTE: ${postScaffoldNote}`)
      followUpLines.push(`Then customise the scaffold for the user's actual task: "${body.content}".`)
      actionPlanner.injectContext(runId, followUpLines.join("\n"))

      const synthesizedNormalized: NormalizedResponse = {
        kind: "needs_tool",
        tool: "run_command",
        args: { command: scaffoldCmd, cwd: "." },
        content: `Scaffolding ${recommendation.scaffolder.displayName} into ./${recommendation.projectName}`,
        reasoning: `HIGH-confidence single registry match for ${recommendation.scaffolder.stackKey}; running the scaffolder beats hand-writing config files.`,
        usage: { inputTokens: 0, outputTokens: 0 },
      }
      const clientResp = mapNormalizedResponseToClient(runId, synthesizedNormalized)
      clientResp.reasoningBrief = reasoningBrief
      return clientResp
    }
  } catch (err) {
    console.warn(`[scaffold-first] recommender failed:`, (err as Error).message)
  }

  // ─── PHASE B (Stage 1 parallelization): 2 calls dependent on preflight ─
  //     implement_elaborate and chunk_plan BOTH read from `reasoningBrief`
  //     (the preflight output) but have NO dependency on each other. We
  //     fire them in parallel: wall-clock = MAX(elab, chunkPlan) instead
  //     of SUM.
  //
  //     Each is feature-gated (free-tier-only for elab; chunked-loop flag
  //     + briefPipeline === "implement" + non-trivial buildPlan for
  //     chunk_plan). Disabled paths resolve to Promise.resolve(null) so
  //     the Promise.all return shape is stable.
  const briefAsEnv = reasoningBrief as { pipeline?: string; confidence?: "HIGH" | "MEDIUM" | "LOW"; decision?: string } | null
  const elaborationGateOn = (
    !!briefAsEnv
    && briefAsEnv.pipeline === "implement"
    && briefAsEnv.decision === "proceed"
    && shouldRunPreflightElaboration({
      model: body.model,
      complexity: taskComplexity.complexity,
      preflightConfidence: briefAsEnv.confidence ?? null,
      flagEnabled: ((): boolean => {
        try { return getFlag<boolean>("reasoning.chained.preflight_elaboration_enabled", body.sysbasePath) }
        catch { return true }
      })(),
    })
  )
  const chunkedLoopOn = (() => {
    try { return getFlag<boolean>("reasoning.chunked_loop_enabled", body.sysbasePath) }
    catch { return true }
  })()
  const chunkBriefPipeline = (reasoningBrief as { pipeline?: string } | null)?.pipeline
  const implementBriefForChunk = (reasoningBrief as { implementBrief?: { buildPlan?: unknown[] } } | null)?.implementBrief
  const buildPlanSteps = Array.isArray(implementBriefForChunk?.buildPlan) ? implementBriefForChunk!.buildPlan!.length : 0
  // 2026-05-18 (Plan 4 Stage 3): trivial-task threshold tightened from
  // ≤3 to ≤1 steps. Scaffold-class buildPlans summarize to 2-3 bullets
  // that expand to 15-25 files at execution time; chunked-loop structure
  // is valuable for those, not just for ≥4-bullet plans.
  const isTrivial = buildPlanSteps === 1
  const chunkPlanGateOn = chunkedLoopOn && chunkBriefPipeline === "implement" && !isTrivial

  const [reasoningElaborationBrief, chunkPlanFromPlanner] = await Promise.all([
    elaborationGateOn
      ? runReasoningChain(
          {
            trigger: "preflight",
            userMessage: body.content,
            model: body.model,
            cwd: body.cwd,
            sysbasePath: body.sysbasePath,
          },
          [
            {
              name: "implement_elaborate",
              buildPayload: (_prior, original) => ({
                ...original,
                trigger: "implement_elaborate" as const,
                context: {
                  preflightBrief: reasoningBrief,
                  taskComplexity: taskComplexity.complexity,
                },
              }),
            },
          ],
        ).then((chain) => {
          if (chain.finalBrief && chain.finalBrief.pipeline === "implement_elaborate") {
            const elabBrief = (chain.finalBrief as { implementElaborationBrief?: { confidence?: string } }).implementElaborationBrief
            console.log(`[reasoning] preflight elaboration: confidence=${elabBrief?.confidence ?? "?"} (${chain.stages.length} stages)`)
            return chain.finalBrief as unknown
          }
          return null
        }).catch((err: unknown) => {
          console.warn(`[reasoning] preflight elaboration failed:`, (err as Error).message)
          return null as unknown
        })
      : Promise.resolve(null as unknown),
    chunkPlanGateOn
      ? runReasoning({
          trigger: "chunk_plan",
          userMessage: body.content,
          model: body.model,
          cwd: body.cwd,
          sysbasePath: body.sysbasePath,
          runId,
          context: {
            originalUserPrompt: body.content,
            implementBrief: implementBriefForChunk ?? null,
            chunkHistory: [],
          },
        }).then((planResult) => planResult?.chunkPlanBrief ?? null).catch((err: unknown) => {
          console.warn(`[chunked-loop] initial chunk_plan failed:`, (err as Error).message)
          return null
        })
      : Promise.resolve(null),
  ])

  // ─── Apply chunk-plan side effects ───
  let chunkPlanBrief: ChunkPlanBrief | null = chunkPlanFromPlanner
  if (chunkPlanBrief) {
    // Phase 16 Stage 5: tighten the planner's file list to the
    // free-tier cap. Schema allows up to 5; free-tier drops to 4 so
    // the free model has fewer balls in the air per chunk. Paid-tier
    // passes through at 5 (slice is a no-op).
    const maxFiles = resolveMaxFilesPerChunk(body.model)
    if (chunkPlanBrief.files.length > maxFiles) {
      chunkPlanBrief.files = chunkPlanBrief.files.slice(0, maxFiles)
    }
    recordChunkStart(runId, chunkPlanBrief, [...chunkPlanBrief.files])
    console.log(`[chunked-loop] chunk 0 planned: ${chunkPlanBrief.nextAction} (${chunkPlanBrief.files.length} files, cap=${maxFiles})`)
  }

  let normalized = await callModelAdapter({
    model: body.model,
    runId,
    task: task as never,
    context: context as never,
    userMessage: body.content,
    command: body.command,
    directoryTree: (body.directoryTree || []) as never,
    projectId: body.projectId,
    cwd: body.cwd,
    planMode: body.planMode === true,
    reasoningBrief,
    reasoningElaborationBrief,
    chunkPlanBrief,
    projectInitBrief,
    runIntent,
    taskComplexity: taskComplexity.complexity,
    userId: body.userId || null,
    chatId: body.chatId || null,
    // Stage 4.1 of awareness-and-verification-correctness plan.
    clientPlatform,
  } as never)

  // Stage 5 of accountability-and-parallel-execution-sequencing
  // plan: per-file-reasoning gate on the INITIAL turn too. The
  // user-reported 11-tool blast originated here — pre-Stage-5
  // the first response could ship tools.length=11 with one
  // brief paragraph. Now: if tools > threshold AND paragraphs <
  // tools, inject the reject prompt and re-call the adapter.
  // Capped at MAX_PER_FILE_REASONING_REJECTIONS.
  const pfFlagOn = (() => {
    try { return getFlag<boolean>("quality.per_file_reasoning_required_enabled", body.sysbasePath as string | undefined) }
    catch { return true }
  })()
  if (pfFlagOn) {
    const pfThreshold = (() => {
      try { return getFlag<number>("quality.per_file_reasoning_threshold", body.sysbasePath as string | undefined) }
      catch { return 3 }
    })()
    let pfRejections = 0
    while (pfRejections < MAX_PER_FILE_REASONING_REJECTIONS) {
      const check = validatePerFileReasoning({
        responseKind: normalized.kind,
        tools: normalized.tools,
        reasoningChain: normalized.reasoningChain,
        threshold: pfThreshold,
      })
      if (check.ok) break
      pfRejections += 1
      console.log(`[per-file-reasoning] initial-turn rejection ${pfRejections}/${MAX_PER_FILE_REASONING_REJECTIONS}: ${check.reason}`)
      actionPlanner.injectContext(
        runId,
        buildInsufficientReasoningPrompt(check, pfThreshold, pfRejections, MAX_PER_FILE_REASONING_REJECTIONS),
      )
      normalized = await callModelAdapter({
        model: body.model,
        runId,
        task: task as never,
        context: context as never,
        userMessage: body.content,
        command: body.command,
        directoryTree: (body.directoryTree || []) as never,
        projectId: body.projectId,
        cwd: body.cwd,
        planMode: body.planMode === true,
        reasoningBrief,
        reasoningElaborationBrief,
        chunkPlanBrief,
        projectInitBrief,
        runIntent,
        taskComplexity: taskComplexity.complexity,
        userId: body.userId || null,
        chatId: body.chatId || null,
        clientPlatform,
      } as never)
    }
  }

  await persistModelUsage({
    runId,
    projectId: body.projectId,
    model: body.model,
    usage: normalized.usage,
    userId: body.userId || null,
    isNewPrompt: true
  })

  // ─── Forced reconnaissance: tell planner if this is an existing project ───
  const nonSysbaseFiles = (body.directoryTree || []).filter((e) => !e.name.startsWith("sysbase"))
  const hasExistingProject = nonSysbaseFiles.length > 2
  actionPlanner.setHasExistingProject(runId, hasExistingProject)

  // Action planner: fix broken tools, detect loops, enforce reconnaissance
  normalized = actionPlanner.intercept(runId, normalized)

  // ─── Setup Intelligence: if user reported an error, force web search for the fix ───
  const detectedError = detectErrorForSearch(body.content)
  if (detectedError && normalized.tool !== "web_search") {
    console.log(`[setup-intelligence] Error detected in prompt (${detectedError.errorType}) — overriding to web_search: "${detectedError.searchQuery}"`)
    normalized = buildErrorSearchOverride(detectedError)
  }

  // Accumulate frontend content for quality analysis
  if (isFrontendTask(body.content)) {
    accumulateFrontendContent(runId, normalized)
  }

  // Layer 3: Guard against AI completing on the FIRST call (before any tools run).
  // Phase 16 Stage 1: reuse the pre-flight `taskComplexity` instead of
  // re-running the regex; pure helper, identical input → identical output.
  const analysis = taskComplexity
  if (normalized.kind === "completed") {
    if (analysis.complexity !== "simple") {
      console.log(`[user-message] AI tried to complete ${analysis.complexity} task on first call — overriding to needs_tool`)
      normalized.kind = "needs_tool"
      normalized.tool = "list_directory"
      normalized.args = { path: "." }
      normalized.content = "Starting implementation..."
      normalized.reasoning = "I need to implement the full task, not just respond with a summary."
    }
  }

  // ─── AI-Driven Planning: for complex tasks, force the AI to present a plan ───
  // If the AI's first response is a write/edit (not a read), and the task is complex,
  // inject a planning directive so the AI outputs a plan for user confirmation.
  if (analysis.complexity !== "simple" && normalized.kind === "needs_tool") {
    const firstTool = normalized.tool || ""
    const isAlreadyReading = ["read_file", "batch_read", "list_directory", "search_code", "search_files", "web_search"].includes(firstTool)

    if (!isAlreadyReading) {
      // Override: force the AI to read first, then on next turn it'll get a planning directive
      console.log(`[user-message] Complex task — forcing AI to read project before implementing`)
      normalized.tool = "list_directory"
      normalized.args = { path: "." }
      normalized.tools = undefined
      normalized.content = "Reading project structure to plan implementation..."
    }
  }

  // ─── Task Pipeline: only render the box when the AI itself produced a plan.
  // No more canned "Setup project / Implement features / Polish & finalize"
  // fallback — if the AI didn't generate a taskPlan that's its signal that
  // the task doesn't need one, and the agent's tool stream + final summary
  // cover the visible feedback. (Closes #12.)
  if (normalized.kind === "needs_tool" && normalized.taskPlan && normalized.taskPlan.steps.length > 0) {
    let pipelinePrompt = body.content
    const isContinue = /^\s*(continue|go on|keep going|next|proceed|finish)\s*$/i.test(body.content.trim()) || body.command === "/continue"
    if (isContinue && lastSession) {
      pipelinePrompt = lastSession.prompt || body.content
      console.log(`[task-pipeline] Using original prompt for /continue pipeline: "${pipelinePrompt.slice(0, 80)}"`)
    }
    const pipeline = createPipelineFromAiPlan(runId, pipelinePrompt, normalized.taskPlan)
    normalized.task = pipelineToTaskMeta(pipeline)
  }

  // Phase 15 Stage 4: apply the model's memoryFeedback against the on-disk
  // store. cross-validation guards in feedback.ts reject hallucinated
  // confirms (entry content nowhere in response) and fabricated
  // contradictions (response doesn't reference the entry's [id]). Best
  // effort — never blocks the run. Gated by a flag so users can disable
  // when free-tier hallucinations make the signal noisier than useful.
  if (
    body.cwd
    && normalized.memoryFeedback
    && getFlag<boolean>("memory.active_confirmation_enabled", body.sysbasePath)
  ) {
    applyMemoryFeedback(body.cwd, normalized.memoryFeedback, normalized.content || "")
      .then((audit) => {
        if (audit.confirmedHonoured.length > 0 || audit.contradictedHonoured.length > 0) {
          console.log(`[memory] feedback applied: confirmed=${audit.confirmedHonoured.length} contradicted=${audit.contradictedHonoured.length} (rejected: c=${audit.confirmedRejected.length} d=${audit.contradictedRejected.length})`)
        }
      })
      .catch(() => { /* best-effort */ })
  }

  // Stage 5 of free-tier-quality-enforcement: cache the per-turn
  // reasoningChain so the next tool-result handler can run the
  // reasoner-vs-action cross-check against the action the agent emits.
  if (Array.isArray(normalized.reasoningChain)) {
    setLastReasoning(runId, normalized.reasoningChain)
  }

  const clientResp = mapNormalizedResponseToClient(runId, normalized)
  if (reasoningBrief) clientResp.reasoningBrief = reasoningBrief
  // Stage E of model-lock-and-portable-reasoning: surface the resolved
  // reasoner backend for CLI telemetry. Absent until the first
  // runReasoning call lands; constant for the rest of the run.
  const reasonerBackend = getReasonerBackendForRun(runId)
  if (reasonerBackend) clientResp.reasonerBackend = reasonerBackend
  // Phase 19: surface the classified intent so the CLI's <AgentStream>
  // can gate the task box (only `implement` runs render the box; Q&A /
  // summary / bug pipelines keep the surface lean — see plan
  // `applied/2026-05-07-phase-19-task-display-selectivity.md`).
  // Always present on the initial response so the cli reducer has the
  // intent BEFORE any taskPlan arrives.
  // Phase 19 surface. The smart classifier above already cached the
  // value for this run; this just hands it to the cli.
  clientResp.runIntent = runIntent
  // Stage 5 of llm-iterative-intent-classification: surface the
  // classification source (for usage.jsonl telemetry) + chain
  // paragraphs (for <ReasoningPeek> render). intentResult holds them
  // from the smart classifier earlier in this handler.
  clientResp.intentClassificationSource = intentResult.source
  if (intentResult.paragraphs && intentResult.paragraphs.length > 0) {
    clientResp.intentClassificationParagraphs = intentResult.paragraphs
  }
  // Stage 1 of agent-runtime-fixes plan: surface the project-init brief
  // so the cli renders the paragraphs in <ReasoningPeek> (PR #83's
  // plain-prose path) and captures the classification for telemetry.
  // Constant for the run — set ONLY on this initial response.
  if (projectInitBrief) {
    clientResp.projectInitParagraphs = projectInitBrief.paragraphs
    clientResp.projectInitRepoState = projectInitBrief.repoState
    clientResp.projectInitConfidence = projectInitBrief.confidence
  }
  // Phase 10: surface the chunk-plan brief on the response so the CLI (Stage 5)
  // can render the chunk progress badge. Stage 4 will also inject it into the
  // provider prompt so the model honours the planner's file list.
  if (chunkPlanBrief) (clientResp as unknown as Record<string, unknown>).chunkPlanBrief = chunkPlanBrief

  // Phase 11 Stage 5: emit a fresh awarenessSnapshot on the initial turn so
  // the CLI sees the badge from chunk 1 onwards. State is always on_track
  // here (the run just started), but consistency lets the cli use the
  // presence/absence of the field as the awareness-on signal.
  try {
    if (getFlag<boolean>("awareness.enabled", body.sysbasePath)) {
      ;(clientResp as unknown as Record<string, unknown>).awarenessSnapshot = {
        state: getThresholdState(runId, body.sysbasePath, body.model),
        confidence: getConfidence(runId),
        lastSignal: null,
      }
    }
  } catch {
    /* best-effort */
  }
  return clientResp
}
