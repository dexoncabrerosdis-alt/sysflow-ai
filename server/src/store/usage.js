import { recordUsage, calculateCostCents } from "./subscriptions.js"

const usageRecords = []

export async function persistModelUsage({ runId, projectId, model, usage, userId, isNewPrompt }) {
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

  // Record in DB + deduct credits/increment free counter
  if (userId) {
    await recordUsage(userId, { runId, projectId, model, inputTokens, outputTokens, costCents, isNewPrompt: !!isNewPrompt })
  }
}

export function getUsageRecords() {
  return usageRecords
}
