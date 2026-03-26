import { query } from "../db/connection.js"
import type { TaskMeta, NormalizedResponse } from "../types.js"

interface TaskRecord extends TaskMeta {
  completedAt?: string
  result?: NormalizedResponse
}

export async function saveTask(task: TaskMeta): Promise<void> {
  await query(
    `INSERT INTO tasks (id, run_id, project_id, model, title, goal, steps, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET steps = $7, status = $8`,
    [
      task.id,
      task.runId,
      task.projectId,
      task.model,
      task.title || "",
      task.goal || "",
      JSON.stringify(task.steps || []),
      task.status || "running"
    ]
  )
}

export async function getTask(taskId: string): Promise<TaskRecord> {
  const res = await query(
    `SELECT id, run_id, project_id, model, title, goal, steps, status, result, created_at, completed_at
     FROM tasks WHERE id = $1`,
    [taskId]
  )

  if (res.rows.length === 0) {
    throw new Error(`Task not found: ${taskId}`)
  }

  const row = res.rows[0]
  return {
    id: row.id,
    runId: row.run_id,
    projectId: row.project_id,
    model: row.model,
    title: row.title,
    goal: row.goal,
    steps: typeof row.steps === "string" ? JSON.parse(row.steps) : row.steps,
    status: row.status,
    result: row.result ? (typeof row.result === "string" ? JSON.parse(row.result) : row.result) : undefined,
    completedAt: row.completed_at || undefined
  }
}

export async function finalizeTask(taskId: string, response: NormalizedResponse): Promise<void> {
  await query(
    `UPDATE tasks SET status = 'completed', completed_at = NOW(), result = $2 WHERE id = $1`,
    [taskId, JSON.stringify(response)]
  )
}
