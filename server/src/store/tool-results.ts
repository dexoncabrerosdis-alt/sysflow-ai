interface ToolResultRecord {
  tool: string
  result: Record<string, unknown>
  timestamp: string
}

const toolResults = new Map<string, ToolResultRecord[]>()

export async function saveToolResult(runId: string, tool: string, result: Record<string, unknown>): Promise<void> {
  if (!toolResults.has(runId)) {
    toolResults.set(runId, [])
  }

  toolResults.get(runId)!.push({
    tool,
    result,
    timestamp: new Date().toISOString()
  })
}

export async function getToolResults(runId: string): Promise<ToolResultRecord[]> {
  return toolResults.get(runId) || []
}
