import type { NormalizedResponse, ClientResponse } from "../types.js"

export function mapNormalizedResponseToClient(runId: string, normalized: NormalizedResponse): ClientResponse {
  switch (normalized.kind) {
    case "needs_tool":
      return {
        status: "needs_tool",
        runId,
        tool: normalized.tool,
        args: normalized.args,
        content: normalized.content || null,
        reasoning: normalized.reasoning || null,
        task: normalized.task || null,
        taskStep: normalized.taskStep || null
      }

    case "waiting_for_user":
      return {
        status: "waiting_for_user",
        runId,
        message: normalized.content,
        pendingAction: normalized.pendingAction || null
      }

    case "completed":
      return {
        status: "completed",
        runId,
        message: normalized.content,
        summary: normalized.summary || null,
        reasoning: normalized.reasoning || null
      }

    case "failed":
      return {
        status: "failed",
        runId,
        error: normalized.error
      }

    default:
      return {
        status: "failed",
        runId,
        error: "Unknown normalized response kind"
      }
  }
}
