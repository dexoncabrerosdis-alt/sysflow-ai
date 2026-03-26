import { query } from "../db/connection.js"

interface ToolResultRecord {
  tool: string
  result: Record<string, unknown>
  timestamp: string
}

export async function saveToolResult(runId: string, tool: string, result: Record<string, unknown>): Promise<void> {
  await query(
    `INSERT INTO tool_results (run_id, tool, result) VALUES ($1, $2, $3)`,
    [runId, tool, JSON.stringify(result)]
  )
}

export async function getToolResults(runId: string): Promise<ToolResultRecord[]> {
  const res = await query(
    `SELECT tool, result, created_at FROM tool_results WHERE run_id = $1 ORDER BY created_at ASC`,
    [runId]
  )

  return res.rows.map((row) => ({
    tool: row.tool,
    result: typeof row.result === "string" ? JSON.parse(row.result) : row.result,
    timestamp: row.created_at
  }))
}
