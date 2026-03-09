const tasks = new Map()

export async function saveTask(task) {
  tasks.set(task.id, task)
}

export async function getTask(taskId) {
  const task = tasks.get(taskId)
  if (!task) {
    throw new Error(`Task not found: ${taskId}`)
  }
  return task
}

export async function finalizeTask(taskId, response) {
  const task = tasks.get(taskId)
  if (task) {
    task.status = "completed"
    task.completedAt = new Date().toISOString()
    task.result = response
  }
}
