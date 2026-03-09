const projectMemories = new Map()

export async function maybeUpdateProjectMemory({ runId, projectId, command, sysbasePath }) {
  if (!projectMemories.has(projectId)) {
    projectMemories.set(projectId, [])
  }

  projectMemories.get(projectId).push({
    runId,
    command,
    sysbasePath,
    updatedAt: new Date().toISOString()
  })
}

export async function getProjectMemories(projectId) {
  return projectMemories.get(projectId) || []
}
