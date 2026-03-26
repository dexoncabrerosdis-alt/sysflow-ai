import { query } from "../db/connection.js"
import type { NormalizedResponse } from "../types.js"

interface RunData {
  runId: string
  taskId: string
  projectId: string
  model: string
  content: string
  command?: string
  cwd?: string
  sysbasePath?: string
  userId?: string | null
  chatId?: string | null
  status: string
}

interface RunRecord extends RunData {
  id: string
  createdAt: string
  completedAt?: string
  response?: NormalizedResponse
}

export async function saveRun(data: RunData): Promise<void> {
  await query(
    `INSERT INTO runs (id, task_id, project_id, model, content, command, cwd, sysbase_path, user_id, chat_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET status = $11`,
    [
      data.runId,
      data.taskId,
      data.projectId,
      data.model,
      data.content,
      data.command || null,
      data.cwd || null,
      data.sysbasePath || null,
      data.userId || null,
      data.chatId || null,
      data.status
    ]
  )
}

export async function getRun(runId: string): Promise<RunRecord> {
  const res = await query(
    `SELECT id, task_id, project_id, model, content, command, cwd, sysbase_path, user_id, chat_id, status, response, created_at, completed_at
     FROM runs WHERE id = $1`,
    [runId]
  )

  if (res.rows.length === 0) {
    throw new Error(`Run not found: ${runId}`)
  }

  const row = res.rows[0]
  return {
    id: row.id,
    runId: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    model: row.model,
    content: row.content,
    command: row.command,
    cwd: row.cwd,
    sysbasePath: row.sysbase_path,
    userId: row.user_id,
    chatId: row.chat_id,
    status: row.status,
    response: row.response || undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at || undefined
  }
}

export async function finalizeRun(runId: string, response: NormalizedResponse): Promise<void> {
  await query(
    `UPDATE runs SET status = 'completed', completed_at = NOW(), response = $2 WHERE id = $1`,
    [runId, JSON.stringify(response)]
  )
}
