interface MemoryRecord {
  runId: string
  command?: string
  sysbasePath?: string
  updatedAt: string
}

interface MemoryParams {
  runId: string
  projectId: string
  command?: string
  sysbasePath?: string
}

const projectMemories = new Map<string, MemoryRecord[]>()

export async function maybeUpdateProjectMemory({ runId, projectId, command, sysbasePath }: MemoryParams): Promise<void> {
  if (!projectMemories.has(projectId)) {
    projectMemories.set(projectId, [])
  }

  projectMemories.get(projectId)!.push({
    runId,
    command,
    sysbasePath,
    updatedAt: new Date().toISOString()
  })
}

export async function getProjectMemories(projectId: string): Promise<MemoryRecord[]> {
  return projectMemories.get(projectId) || []
}
