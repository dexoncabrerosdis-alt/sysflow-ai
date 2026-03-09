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

export async function handleToolResult(body) {
  await saveToolResult(body.runId, body.tool, body.result)

  const run = await getRun(body.runId)

  // Record this action for session memory (needs projectId from run)
  recordRunAction(body.runId, body.tool, body.result, run.projectId)
  const task = await getTask(run.taskId)
  const context = await loadRunContext({
    runId: body.runId,
    taskId: run.taskId,
    projectId: run.projectId,
    cwd: run.cwd,
    sysbasePath: run.sysbasePath
  })

  const normalized = await callModelAdapter({
    model: run.model,
    runId: body.runId,
    task,
    context,
    userMessage: run.content,
    command: run.command,
    toolResult: {
      tool: body.tool,
      result: body.result
    },
    projectId: run.projectId,
    userId: run.userId || null,
    chatId: run.chatId || null
  })

  await persistModelUsage({
    runId: body.runId,
    projectId: run.projectId,
    model: run.model,
    usage: normalized.usage,
    userId: run.userId || null
  })

  const response = mapNormalizedResponseToClient(body.runId, normalized)

  if (response.status === "completed" || response.status === "failed") {
    if (response.status === "completed") {
      await finalizeTask(run.taskId, response)
      await finalizeRun(body.runId, response)
      await maybeUpdateProjectMemory({
        runId: body.runId,
        projectId: run.projectId,
        command: run.command,
        sysbasePath: run.sysbasePath
      })
    }

    // Save session summary for cross-run memory
    const runLog = getRunActions(body.runId)
    await saveSessionEntry(run.projectId, {
      runId: body.runId,
      prompt: run.content,
      model: run.model,
      actions: runLog.actions,
      filesModified: runLog.filesModified,
      outcome: response.status,
      error: response.error || null,
      userId: run.userId || null,
      chatId: run.chatId || null
    })

    // Auto-save context: learn from completed tasks and failures
    try {
      await autoSaveContext(run, runLog, response)
    } catch (err) {
      console.error("[context] Failed to auto-save context:", err.message)
    }

    clearRunActions(body.runId)
  }

  return response
}

/**
 * Automatically extract and save useful context from completed/failed runs.
 * - Completed tasks: save as "memory" (what was done)
 * - Failed tasks with errors: save as "fix" (what went wrong)
 * - Error→fix patterns: when errors occurred mid-run but the task still completed
 * - Writes fix files to sysbase/fixes/ so the AI can read them on future runs
 */
async function autoSaveContext(run, runLog, response) {
  const tags = extractSimpleTags(run.content)

  if (response.status === "completed" && runLog.filesModified.length > 0) {
    await saveContext({
      projectId: run.projectId,
      userId: run.userId,
      category: "memory",
      title: run.content.slice(0, 100),
      content: `Task completed: "${run.content}". Files modified: ${runLog.filesModified.join(", ")}. Actions: ${runLog.actions.map((a) => a.tool).join(", ")}.`,
      tags
    })
  }

  if (response.status === "failed" && response.error) {
    const fixContent = `Error: ${response.error.slice(0, 300)}\nTask: "${run.content}"\nActions attempted: ${runLog.actions.map((a) => a.tool + (a.path ? ` ${a.path}` : "")).join(", ")}`

    await saveContext({
      projectId: run.projectId,
      userId: run.userId,
      category: "fix",
      title: `Failed: ${run.content.slice(0, 80)}`,
      content: fixContent,
      tags
    })

    await writeFixFile(run, fixContent)
  }

  // Detect error→fix patterns: errors happened mid-run but task completed
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
        category: "fix",
        title: `Fixed: ${err.error.slice(0, 80)}`,
        content: fixContent,
        tags: [...tags, err.tool]
      })

      await writeFixFile(run, fixContent)
    }
  }
}

/**
 * Write a fix entry to sysbase/fixes/ as a local file so the AI reads it.
 */
async function writeFixFile(run, content) {
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
    console.error("[context] Failed to write fix file:", err.message)
  }
}

function extractSimpleTags(prompt) {
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
