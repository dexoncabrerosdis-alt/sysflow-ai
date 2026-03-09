/**
 * Session store — PostgreSQL-backed history of runs per project.
 *
 * Persists across server restarts so the AI remembers previous sessions.
 * Actions are recorded per-run in the run_actions table.
 * Completed/failed runs are saved to the sessions table as summaries.
 */

import { query } from "../db/connection.js"

const MAX_SESSIONS_IN_PROMPT = 20

// ─── In-memory action buffer (flushed to DB when run ends) ───

const runActions = new Map()

export function recordRunAction(runId, tool, args, projectId) {
  if (!runActions.has(runId)) {
    runActions.set(runId, { actions: [], filesModified: [], errors: [], projectId })
  }

  const log = runActions.get(runId)

  const action = { tool }
  if (args?.path) action.path = args.path
  if (args?.command) action.command = args.command?.slice(0, 120)
  if (args?.from) action.from = args.from
  if (args?.to) action.to = args.to
  // Store command output/result summary for richer session history
  if (tool === "run_command") {
    if (args?.stdout) action.output = args.stdout.slice(-500)
    if (args?.stderr) action.stderr = args.stderr.slice(-300)
    if (args?.skipped) action.skipped = true
    if (args?.message) action.message = args.message.slice(0, 200)
  }
  if (tool === "read_file" && args?.content) {
    action.contentPreview = args.content.slice(0, 200)
  }
  log.actions.push(action)

  if ((tool === "write_file" || tool === "edit_file") && args?.path) {
    if (!log.filesModified.includes(args.path)) {
      log.filesModified.push(args.path)
    }
  }

  // Track errors from tool results for error→fix pattern detection
  const result = args
  if (result?.error || result?.stderr || result?.success === false) {
    const errMsg = result.error || result.stderr || "Tool returned failure"
    log.errors.push({ tool, error: typeof errMsg === "string" ? errMsg.slice(0, 300) : String(errMsg).slice(0, 300), actionIndex: log.actions.length - 1 })
  }

  // Also write to DB immediately so nothing is lost on crash
  query(
    `INSERT INTO run_actions (run_id, project_id, tool, path, command, extra)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      runId,
      projectId || log.projectId,
      tool,
      action.path || null,
      action.command || null,
      JSON.stringify(action)
    ]
  ).catch((err) => console.error("[sessions] Failed to save run action:", err.message))
}

export function getRunActions(runId) {
  return runActions.get(runId) || { actions: [], filesModified: [] }
}

export function clearRunActions(runId) {
  runActions.delete(runId)
}

// ─── Session persistence (DB) ───

export async function saveSessionEntry(projectId, entry) {
  await query(
    `INSERT INTO sessions (run_id, project_id, prompt, model, outcome, error, files_modified, user_id, chat_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.runId,
      projectId,
      entry.prompt,
      entry.model,
      entry.outcome || "unknown",
      entry.error || null,
      entry.filesModified || [],
      entry.userId || null,
      entry.chatId || null
    ]
  )
}

export async function getRecentSessions(projectId, chatId, limit) {
  const count = limit || MAX_SESSIONS_IN_PROMPT

  // If chatId is provided, scope to that chat. Otherwise, project-wide.
  let res
  if (chatId) {
    res = await query(
      `SELECT s.run_id, s.prompt, s.model, s.outcome, s.error, s.files_modified, s.created_at
       FROM sessions s
       WHERE s.project_id = $1 AND s.chat_id = $2
       ORDER BY s.created_at DESC
       LIMIT $3`,
      [projectId, chatId, count]
    )
  } else {
    res = await query(
      `SELECT s.run_id, s.prompt, s.model, s.outcome, s.error, s.files_modified, s.created_at
       FROM sessions s
       WHERE s.project_id = $1
       ORDER BY s.created_at DESC
       LIMIT $2`,
      [projectId, count]
    )
  }

  // Also load each session's actions
  const sessions = []
  for (const row of res.rows.reverse()) {
    const actionsRes = await query(
      `SELECT tool, path, command FROM run_actions WHERE run_id = $1 ORDER BY created_at`,
      [row.run_id]
    )

    sessions.push({
      runId: row.run_id,
      prompt: row.prompt,
      model: row.model,
      outcome: row.outcome,
      error: row.error,
      filesModified: row.files_modified || [],
      actions: actionsRes.rows.map((a) => ({ tool: a.tool, path: a.path, command: a.command })),
      timestamp: row.created_at
    })
  }

  return sessions
}

export async function getLastSession(projectId, chatId) {
  const sessions = await getRecentSessions(projectId, chatId, 1)
  return sessions.length > 0 ? sessions[0] : null
}

/**
 * Find runs that have recorded actions but no session entry (interrupted/orphaned runs).
 * Creates "interrupted" session entries so the AI remembers what happened.
 */
export async function saveOrphanedSessions(projectId, chatId) {
  try {
    // Find distinct run_ids in run_actions for this project that have no matching session
    let res
    if (chatId) {
      // For chat-scoped: find orphaned runs that belong to this project
      // (run_actions don't store chat_id, so we match by project and exclude known sessions)
      res = await query(
        `SELECT DISTINCT ra.run_id, MIN(ra.created_at) as first_action
         FROM run_actions ra
         WHERE ra.project_id = $1
           AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.run_id = ra.run_id)
         GROUP BY ra.run_id
         ORDER BY first_action`,
        [projectId]
      )
    } else {
      res = await query(
        `SELECT DISTINCT ra.run_id, MIN(ra.created_at) as first_action
         FROM run_actions ra
         WHERE ra.project_id = $1
           AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.run_id = ra.run_id)
         GROUP BY ra.run_id
         ORDER BY first_action`,
        [projectId]
      )
    }

    for (const row of res.rows) {
      // Load actions for this orphaned run
      const actionsRes = await query(
        `SELECT tool, path, command FROM run_actions WHERE run_id = $1 ORDER BY created_at`,
        [row.run_id]
      )

      const actions = actionsRes.rows
      const filesModified = actions
        .filter((a) => a.tool === "write_file" || a.tool === "edit_file")
        .map((a) => a.path)
        .filter(Boolean)

      // Build a prompt summary from the actions (we don't have the original prompt)
      const actionSummary = actions.map((a) => a.tool + (a.path ? ` ${a.path}` : "")).join(", ")

      await saveSessionEntry(projectId, {
        runId: row.run_id,
        prompt: `(interrupted) actions: ${actionSummary}`,
        model: "unknown",
        outcome: "interrupted",
        error: "Run was interrupted before completion",
        filesModified,
        userId: null,
        chatId: chatId || null
      })

      console.log(`[sessions] Saved orphaned run ${row.run_id} as interrupted session`)
    }
  } catch (err) {
    console.error("[sessions] Failed to save orphaned sessions:", err.message)
  }
}

/**
 * Build a compact text summary of recent sessions for injection into the AI prompt.
 * Returns null if there are no previous sessions.
 */
export async function buildSessionSummary(projectId, chatId) {
  const recent = await getRecentSessions(projectId, chatId)
  if (recent.length === 0) return null

  const lines = ["Previous actions in this project (most recent last):"]

  for (const session of recent) {
    const outcomeTag = session.outcome === "completed" ? "✓" : session.outcome === "failed" ? "✗" : session.outcome === "interrupted" ? "⚡" : "?"
    const errorNote = session.error ? ` Error: ${session.error.slice(0, 100)}` : ""

    lines.push(`[${outcomeTag}] "${session.prompt}"${errorNote}`)

    for (const a of session.actions) {
      if (a.tool === "write_file" || a.tool === "edit_file") {
        lines.push(`  - ${a.tool} ${a.path}`)
      } else if (a.tool === "read_file") {
        lines.push(`  - read ${a.path}`)
      } else if (a.tool === "run_command") {
        const outputSnippet = a.output ? ` → ${a.output.trim().slice(-150)}` : ""
        const skippedNote = a.skipped ? " (skipped: long-running)" : ""
        lines.push(`  - run "${a.command}"${skippedNote}${outputSnippet}`)
      } else if (a.tool === "create_directory") {
        lines.push(`  - mkdir ${a.path}`)
      } else if (a.tool === "delete_file") {
        lines.push(`  - delete ${a.path}`)
      } else {
        lines.push(`  - ${a.tool}${a.path ? " " + a.path : ""}`)
      }
    }

    if (session.filesModified.length > 0) {
      lines.push(`  Files: ${session.filesModified.join(", ")}`)
    }
  }

  return lines.join("\n")
}

/**
 * Build a detailed context for the /continue command.
 * Includes all sessions in the chat with full action details and file lists.
 */
export async function buildContinueContext(projectId, chatId) {
  const recent = await getRecentSessions(projectId, chatId, 10)
  if (recent.length === 0) return null

  const allFilesCreated = new Set()
  const allFilesModified = new Set()
  let lastError = null
  let lastPrompt = null

  const lines = []
  lines.push("=== CONTINUATION CONTEXT — Full history of this chat ===")

  for (const session of recent) {
    const outcomeTag = session.outcome === "completed" ? "COMPLETED" : session.outcome === "failed" ? "FAILED" : "INTERRUPTED"
    lines.push(`\nRun [${outcomeTag}]: "${session.prompt}"`)

    if (session.actions.length > 0) {
      lines.push("  Steps taken:")
      for (const a of session.actions) {
        if (a.tool === "write_file") {
          lines.push(`    - Created file: ${a.path}`)
          allFilesCreated.add(a.path)
        } else if (a.tool === "edit_file") {
          lines.push(`    - Edited file: ${a.path}`)
          allFilesModified.add(a.path)
        } else if (a.tool === "read_file") {
          lines.push(`    - Read file: ${a.path}`)
        } else if (a.tool === "run_command") {
          lines.push(`    - Ran command: ${a.command}`)
        } else if (a.tool === "create_directory") {
          lines.push(`    - Created directory: ${a.path}`)
        } else if (a.tool === "delete_file") {
          lines.push(`    - Deleted file: ${a.path}`)
        } else {
          lines.push(`    - ${a.tool}${a.path ? " " + a.path : ""}`)
        }
      }
    }

    if (session.filesModified.length > 0) {
      lines.push(`  Files modified: ${session.filesModified.join(", ")}`)
    }

    if (session.error) {
      lines.push(`  Error: ${session.error.slice(0, 300)}`)
      lastError = session.error
    }

    lastPrompt = session.prompt
  }

  // Summary at the end
  lines.push("\n=== SUMMARY ===")
  if (allFilesCreated.size > 0) lines.push(`Files already created: ${[...allFilesCreated].join(", ")}`)
  if (allFilesModified.size > 0) lines.push(`Files already modified: ${[...allFilesModified].join(", ")}`)
  if (lastError) lines.push(`Last error: ${lastError.slice(0, 300)}`)
  lines.push("")
  lines.push("INSTRUCTION: Continue from where the last run left off. Do NOT re-read files you already created. Do NOT redo completed steps. If the last run failed or was interrupted, fix the issue and continue. Focus only on what remains to be done.")

  return lines.join("\n")
}
