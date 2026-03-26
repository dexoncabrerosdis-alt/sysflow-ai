import fs from "node:fs/promises"
import path from "node:path"
import { getRun, finalizeRun } from "../store/runs.js"
import { getTask, finalizeTask } from "../store/tasks.js"
import { saveToolResult } from "../store/tool-results.js"
import { persistModelUsage } from "../store/usage.js"
import { maybeUpdateProjectMemory } from "../store/memory.js"
import { recordRunAction, saveSessionEntry, getRunActions, clearRunActions } from "../store/sessions.js"
import { saveContext } from "../store/context.js"
import { loadRunContext } from "../services/context.js"
import { callModelAdapter } from "../providers/adapter.js"
import { mapNormalizedResponseToClient } from "../providers/normalize.js"
import { validateCompletion, buildRejectionPayload, analyzeTaskComplexity } from "../services/completion-guard.js"
import type { ClientResponse, NormalizedResponse } from "../types.js"

/** Track how many times completion was rejected per run (prevent infinite loops) */
const completionRejections = new Map<string, number>()
const MAX_COMPLETION_REJECTIONS = 3

interface ToolResultBody {
  runId: string
  tool: string
  result: Record<string, unknown>
  toolResults?: Array<{ id: string; tool: string; result: Record<string, unknown> }>
}

export async function handleToolResult(body: ToolResultBody): Promise<ClientResponse> {
  const isBatch = body.toolResults && body.toolResults.length > 0

  if (isBatch) {
    // Save each tool result in the batch
    for (const tr of body.toolResults!) {
      await saveToolResult(body.runId, tr.tool, tr.result)
    }
  } else {
    await saveToolResult(body.runId, body.tool, body.result)
  }

  let run: Awaited<ReturnType<typeof getRun>>
  try {
    run = await getRun(body.runId)
  } catch {
    return {
      status: "failed",
      runId: body.runId,
      error: "Session expired. The server was restarted and lost this run's state. Please start a new prompt."
    }
  }

  // Record actions for each tool
  if (isBatch) {
    for (const tr of body.toolResults!) {
      recordRunAction(body.runId, tr.tool, tr.result, run.projectId)
    }
  } else {
    recordRunAction(body.runId, body.tool, body.result, run.projectId)
  }

  const task = await getTask(run.taskId)
  const context = await loadRunContext({
    runId: body.runId,
    taskId: run.taskId,
    projectId: run.projectId,
    cwd: run.cwd as string,
    sysbasePath: run.sysbasePath as string | undefined
  })

  // Build provider payload with single or batch results
  const providerPayload: Record<string, unknown> = {
    model: run.model,
    runId: body.runId,
    task: task,
    context: context,
    userMessage: run.content,
    command: run.command as string | undefined,
    projectId: run.projectId,
    userId: run.userId || null,
    chatId: run.chatId || null
  }

  if (isBatch) {
    providerPayload.toolResults = body.toolResults
    // Also set toolResult to first item for backwards compat
    providerPayload.toolResult = {
      tool: body.toolResults![0].tool,
      result: body.toolResults![0].result
    }
  } else {
    providerPayload.toolResult = {
      tool: body.tool,
      result: body.result
    }
  }

  let normalized = await callModelAdapter(providerPayload as never)

  await persistModelUsage({
    runId: body.runId,
    projectId: run.projectId,
    model: run.model,
    usage: normalized.usage,
    userId: run.userId || null
  })

  // ─── COMPLETION GUARD: reject premature completion ───
  if (normalized.kind === "completed") {
    const rejectionCount = completionRejections.get(body.runId) || 0

    if (rejectionCount < MAX_COMPLETION_REJECTIONS) {
      const verdict = validateCompletion(body.runId, run.content)

      if (!verdict.pass) {
        completionRejections.set(body.runId, rejectionCount + 1)
        console.log(`[completion-guard] REJECTED completion for run ${body.runId} (attempt ${rejectionCount + 1}/${MAX_COMPLETION_REJECTIONS}): ${verdict.reason?.slice(0, 150)}`)

        // Send rejection back to the AI as a tool result — force it to continue
        const rejection = buildRejectionPayload(verdict.reason!, run.content)
        const retryPayload = {
          ...providerPayload,
          toolResult: { tool: rejection.tool, result: rejection.result },
          toolResults: undefined
        }

        const retryNormalized = await callModelAdapter(retryPayload as never)
        await persistModelUsage({
          runId: body.runId,
          projectId: run.projectId,
          model: run.model,
          usage: retryNormalized.usage,
          userId: run.userId || null
        })

        // If AI STILL says completed after rejection, let it through on subsequent attempts
        // (prevents infinite loops — after MAX_COMPLETION_REJECTIONS, we accept)
        normalized = retryNormalized
      }
    } else {
      // Max rejections reached — accept completion and clean up
      completionRejections.delete(body.runId)
    }
  }

  // Clean up rejection counter on terminal states
  if (normalized.kind === "completed" || normalized.kind === "failed") {
    completionRejections.delete(body.runId)
  }

  // Handle step transitions
  if (normalized.stepTransition && task) {
    const steps = (task as unknown as Record<string, unknown>).steps as Array<{ id: string; status: string }> | undefined
    if (steps) {
      if (normalized.stepTransition.complete) {
        const step = steps.find((s) => s.id === normalized.stepTransition!.complete)
        if (step) step.status = "completed"
      }
      if (normalized.stepTransition.start) {
        const step = steps.find((s) => s.id === normalized.stepTransition!.start)
        if (step) step.status = "in_progress"
      }
    }
  }

  const response = mapNormalizedResponseToClient(body.runId, normalized)

  if (response.status === "completed" || response.status === "failed") {
    if (response.status === "completed") {
      await finalizeTask(run.taskId, response as never)
      await finalizeRun(body.runId, response as never)
      await maybeUpdateProjectMemory({
        runId: body.runId,
        projectId: run.projectId,
        command: run.command as string | undefined,
        sysbasePath: run.sysbasePath as string | undefined
      })
    }

    const runLog = getRunActions(body.runId)
    await saveSessionEntry(run.projectId, {
      runId: body.runId,
      prompt: run.content,
      model: run.model,
      outcome: response.status,
      error: response.error || null,
      filesModified: runLog.filesModified,
      userId: run.userId || null,
      chatId: run.chatId || null
    })

    try {
      await autoSaveContext(run as unknown as RunRecord, runLog, response)
    } catch (err) {
      console.error("[context] Failed to auto-save context:", (err as Error).message)
    }

    clearRunActions(body.runId)
  }

  return response
}

interface RunRecord {
  projectId: string
  userId?: string | null
  content: string
  sysbasePath?: string
  [key: string]: unknown
}

interface RunLog {
  actions: Array<Record<string, unknown>>
  filesModified: string[]
  errors: Array<{ tool: string; error: string; actionIndex: number }>
}

async function autoSaveContext(run: RunRecord, runLog: RunLog, response: ClientResponse): Promise<void> {
  const tags = extractSimpleTags(run.content)

  // Successful completion → save as candidate memory pattern
  if (response.status === "completed" && runLog.filesModified.length > 0) {
    await saveContext({
      projectId: run.projectId,
      userId: run.userId,
      category: "memory",
      title: run.content.slice(0, 100),
      content: `Task completed: "${run.content}". Files modified: ${runLog.filesModified.join(", ")}. Actions: ${runLog.actions.map((a) => a.tool).join(", ")}.`,
      tags,
      confidence: "medium",
      lifecycle: "candidate"
    })
  }

  // Failed task → save as verified bugfix pattern (we know the error is real)
  if (response.status === "failed" && response.error) {
    const fixContent = `Error: ${response.error.slice(0, 300)}\nTask: "${run.content}"\nActions attempted: ${runLog.actions.map((a) => a.tool + (a.path ? ` ${a.path}` : "")).join(", ")}`

    await saveContext({
      projectId: run.projectId,
      userId: run.userId,
      category: "bugfix_pattern",
      title: `Failed: ${run.content.slice(0, 80)}`,
      content: fixContent,
      tags,
      confidence: "high",
      lifecycle: "verified"
    })

    await writeFixFile(run, fixContent)
  }

  // Errors that were recovered from → high-value fix patterns
  const errors = runLog.errors || []
  if (response.status === "completed" && errors.length > 0) {
    for (const err of errors) {
      const fixContent = [
        `Error encountered: ${err.error}`,
        `Tool: ${err.tool}`,
        `Task: "${run.content}"`,
        `Resolution: The AI recovered and completed the task successfully.`,
        `Files modified: ${runLog.filesModified.join(", ") || "none"}`,
        ``,
        `LESSON: When you see this error, check the fix above. Do not repeat the same mistake.`
      ].join("\n")

      await saveContext({
        projectId: run.projectId,
        userId: run.userId,
        category: "bugfix_pattern",
        title: `Fixed: ${err.error.slice(0, 80)}`,
        content: fixContent,
        tags: [...tags, err.tool],
        confidence: "high",
        lifecycle: "verified"
      })

      await writeFixFile(run, fixContent)
    }
  }
}

async function writeFixFile(run: RunRecord, content: string): Promise<void> {
  try {
    if (!run.sysbasePath) return
    const fixesDir = path.join(run.sysbasePath, "fixes")
    await fs.mkdir(fixesDir, { recursive: true })

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    const slug = (run.content || "fix").slice(0, 40).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()
    const filename = `${timestamp}_${slug}.md`

    await fs.writeFile(
      path.join(fixesDir, filename),
      `# Fix — ${new Date().toISOString()}\n\n${content}\n`,
      "utf8"
    )
    console.log(`[context] Wrote fix file: sysbase/fixes/${filename}`)
  } catch (err) {
    console.error("[context] Failed to write fix file:", (err as Error).message)
  }
}

function extractSimpleTags(prompt: string): string[] {
  if (!prompt) return []
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "to", "of", "in", "for", "on", "with",
    "at", "by", "from", "as", "and", "or", "but", "not", "this", "that",
    "it", "i", "me", "my", "we", "you", "add", "create", "make", "use",
    "using", "please", "want", "need", "can", "will", "should"
  ])
  return prompt.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w)).slice(0, 8)
}
