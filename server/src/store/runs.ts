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

const runs = new Map<string, RunRecord>()

export async function saveRun(data: RunData): Promise<void> {
  runs.set(data.runId, {
    ...data,
    id: data.runId,
    userId: data.userId || null,
    chatId: data.chatId || null,
    createdAt: new Date().toISOString()
  })
}

export async function getRun(runId: string): Promise<RunRecord> {
  const run = runs.get(runId)
  if (!run) throw new Error(`Run not found: ${runId}`)
  return run
}

export async function finalizeRun(runId: string, response: NormalizedResponse): Promise<void> {
  const run = runs.get(runId)
  if (run) {
    run.status = "completed"
    run.completedAt = new Date().toISOString()
    run.response = response
  }
}
