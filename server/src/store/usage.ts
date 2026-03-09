import { recordUsage, calculateCostCents } from "./subscriptions.js"
import type { TokenUsage } from "../types.js"

interface UsageRecord {
  runId: string
  projectId: string
  model: string
  inputTokens: number
  outputTokens: number
  costCents: number
  timestamp: string
}

interface PersistUsageParams {
  runId: string
  projectId: string
  model: string
  usage: TokenUsage | null | undefined
  userId?: string | null
  isNewPrompt?: boolean
}

const usageRecords: UsageRecord[] = []

export async function persistModelUsage({ runId, projectId, model, usage, userId, isNewPrompt }: PersistUsageParams): Promise<void> {
  if (!usage) return

  const inputTokens = usage.inputTokens || 0
  const outputTokens = usage.outputTokens || 0
  const costCents = calculateCostCents(inputTokens, outputTokens, usage.generationData, model)

  usageRecords.push({
    runId,
    projectId,
    model,
    inputTokens,
    outputTokens,
    costCents,
    timestamp: new Date().toISOString()
  })

  if (userId) {
    await recordUsage(userId, { runId, projectId, model, inputTokens, outputTokens, costCents, isNewPrompt: !!isNewPrompt })
  }
}

export function getUsageRecords(): UsageRecord[] {
  return usageRecords
}
