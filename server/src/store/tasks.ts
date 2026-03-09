import type { TaskMeta, NormalizedResponse } from "../types.js"

interface TaskRecord extends TaskMeta {
  completedAt?: string
  result?: NormalizedResponse
}

const tasks = new Map<string, TaskRecord>()

export async function saveTask(task: TaskMeta): Promise<void> {
  tasks.set(task.id, task as TaskRecord)
}

export async function getTask(taskId: string): Promise<TaskRecord> {
  const task = tasks.get(taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  return task
}

export async function finalizeTask(taskId: string, response: NormalizedResponse): Promise<void> {
  const task = tasks.get(taskId)
  if (task) {
    task.status = "completed"
    task.completedAt = new Date().toISOString()
    task.result = response
  }
}
