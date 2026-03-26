import { query } from "../db/connection.js"

const MAX_SESSIONS_IN_PROMPT = 20

interface RunActionLog {
  actions: Array<Record<string, unknown>>
  filesModified: string[]
  errors: Array<{ tool: string; error: string; actionIndex: number }>
  projectId: string
}

interface SessionEntry {
  runId: string
  prompt: string
  model: string
  outcome?: string
  error?: string | null
  filesModified?: string[]
  userId?: string | null
  chatId?: string | null
}

interface SessionRecord {
  runId: string
  prompt: string
  model: string
  outcome: string
  error: string | null
  filesModified: string[]
  actions: Array<{ tool: string; path?: string; command?: string; output?: string; skipped?: boolean }>
  timestamp: string
}

const runActions = new Map<string, RunActionLog>()

export function recordRunAction(runId: string, tool: string, args: Record<string, unknown>, projectId: string): void {
  if (!runActions.has(runId)) {
    runActions.set(runId, { actions: [], filesModified: [], errors: [], projectId })
  }

  const log = runActions.get(runId)!

  const action: Record<string, unknown> = { tool }
  if (args?.path) action.path = args.path
  if (args?.command) action.command = (args.command as string)?.slice(0, 120)
  if (args?.from) action.from = args.from
  if (args?.to) action.to = args.to
  if (tool === "run_command") {
    if (args?.stdout) action.output = (args.stdout as string).slice(-500)
    if (args?.stderr) action.stderr = (args.stderr as string).slice(-300)
    if (args?.skipped) action.skipped = true
    if (args?.message) action.message = (args.message as string).slice(0, 200)
  }
  if (tool === "read_file" && args?.content) {
    action.contentPreview = (args.content as string).slice(0, 200)
  }
  if (tool === "_user_response" && args?.answer) {
    action.answer = (args.answer as string).slice(0, 500)
  }
  log.actions.push(action)

  if ((tool === "write_file" || tool === "edit_file") && args?.path) {
    if (!log.filesModified.includes(args.path as string)) {
      log.filesModified.push(args.path as string)
    }
  }

  const result = args
  if (result?.error || result?.stderr || result?.success === false) {
    const errMsg = result.error || result.stderr || "Tool returned failure"
    log.errors.push({ tool, error: typeof errMsg === "string" ? errMsg.slice(0, 300) : String(errMsg).slice(0, 300), actionIndex: log.actions.length - 1 })
  }

  query(
    `INSERT INTO run_actions (run_id, project_id, tool, path, command, extra)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      runId,
      projectId || log.projectId,
      tool,
      (action.path as string) || null,
      (action.command as string) || null,
      JSON.stringify(action)
    ]
  ).catch((err) => console.error("[sessions] Failed to save run action:", (err as Error).message))
}

export function getRunActions(runId: string): RunActionLog {
  return runActions.get(runId) || { actions: [], filesModified: [], errors: [], projectId: "" }
}

export function clearRunActions(runId: string): void {
  runActions.delete(runId)
}

export async function saveSessionEntry(projectId: string, entry: SessionEntry): Promise<void> {
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

export async function getRecentSessions(projectId: string, chatId?: string | null, limit?: number): Promise<SessionRecord[]> {
  const count = limit || MAX_SESSIONS_IN_PROMPT

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

  const sessions: SessionRecord[] = []
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
      actions: actionsRes.rows.map((a: Record<string, unknown>) => ({ tool: a.tool as string, path: a.path as string | undefined, command: a.command as string | undefined })),
      timestamp: row.created_at
    })
  }

  return sessions
}

export async function getLastSession(projectId: string, chatId?: string | null): Promise<SessionRecord | null> {
  const sessions = await getRecentSessions(projectId, chatId, 1)
  return sessions.length > 0 ? sessions[0] : null
}

export async function saveOrphanedSessions(projectId: string, chatId?: string | null): Promise<void> {
  try {
    const res = await query(
      `SELECT DISTINCT ra.run_id, MIN(ra.created_at) as first_action
       FROM run_actions ra
       WHERE ra.project_id = $1
         AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.run_id = ra.run_id)
       GROUP BY ra.run_id
       ORDER BY first_action`,
      [projectId]
    )

    for (const row of res.rows) {
      const actionsRes = await query(
        `SELECT tool, path, command FROM run_actions WHERE run_id = $1 ORDER BY created_at`,
        [row.run_id]
      )

      const actions = actionsRes.rows as Array<{ tool: string; path?: string }>
      const filesModified = actions
        .filter((a) => a.tool === "write_file" || a.tool === "edit_file")
        .map((a) => a.path)
        .filter(Boolean) as string[]

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
    console.error("[sessions] Failed to save orphaned sessions:", (err as Error).message)
  }
}

export async function buildSessionSummary(projectId: string, chatId?: string | null): Promise<string | null> {
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

export async function buildContinueContext(projectId: string, chatId?: string | null): Promise<string | null> {
  const recent = await getRecentSessions(projectId, chatId, 10)
  if (recent.length === 0) return null

  const allFilesCreated = new Set<string>()
  const allFilesModified = new Set<string>()
  const userDecisions: string[] = []
  let lastError: string | null = null

  const lines: string[] = []
  lines.push("=== CONTINUATION CONTEXT — Full history of this chat ===")

  for (const session of recent) {
    const outcomeTag = session.outcome === "completed" ? "COMPLETED" : session.outcome === "failed" ? "FAILED" : "INTERRUPTED"
    lines.push(`\nRun [${outcomeTag}]: "${session.prompt}"`)

    if (session.actions.length > 0) {
      lines.push("  Steps taken:")
      for (const a of session.actions) {
        if (a.tool === "_user_response") {
          const answer = (a as Record<string, unknown>).answer || (a as Record<string, unknown>).output || ""
          lines.push(`    - USER ANSWERED: "${answer}"`)
          userDecisions.push(String(answer))
        } else if (a.tool === "write_file") {
          lines.push(`    - Created file: ${a.path}`)
          if (a.path) allFilesCreated.add(a.path)
        } else if (a.tool === "edit_file") {
          lines.push(`    - Edited file: ${a.path}`)
          if (a.path) allFilesModified.add(a.path)
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
  }

  // Find the ORIGINAL task prompt (first run in this chat)
  const originalPrompt = recent.length > 0 ? recent[recent.length - 1].prompt : null
  const lastPrompt = recent[0]?.prompt || null

  lines.push("\n=== ORIGINAL TASK ===")
  if (originalPrompt) {
    lines.push(`ORIGINAL GOAL: "${originalPrompt}"`)
  }
  if (lastPrompt && lastPrompt !== originalPrompt) {
    lines.push(`MOST RECENT PROMPT: "${lastPrompt}"`)
  }

  if (userDecisions.length > 0) {
    lines.push("\n=== USER DECISIONS (from previous questions) ===")
    for (const decision of userDecisions) {
      lines.push(`- "${decision}"`)
    }
    lines.push("IMPORTANT: These are the user's confirmed choices. Do NOT ask about these again. Use them directly.")
  }

  lines.push("\n=== PROGRESS SUMMARY ===")
  if (allFilesCreated.size > 0) lines.push(`Files already created: ${[...allFilesCreated].join(", ")}`)
  if (allFilesModified.size > 0) lines.push(`Files already modified: ${[...allFilesModified].join(", ")}`)
  if (lastError) lines.push(`Last error: ${lastError.slice(0, 300)}`)
  lines.push("")
  lines.push("INSTRUCTION: Your goal is to COMPLETE THE ORIGINAL TASK above. The user's technology choices are listed above — use them, do NOT ask again. Review what has been done and continue from where the last run left off. Do NOT re-read files you already created. Do NOT redo completed steps. Do NOT ask clarifying questions — all decisions are already made. Just implement.")

  return lines.join("\n")
}
