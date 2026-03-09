import { query } from "../db/connection.js"

interface PlanDef {
  label: string
  creditsCents: number
  dailyPrompts: number | null
}

export const PLANS: Record<string, PlanDef> = {
  free:  { label: "Free",  creditsCents: 0,     dailyPrompts: 10 },
  lite:  { label: "Lite",  creditsCents: 2000,  dailyPrompts: null },
  pro:   { label: "Pro",   creditsCents: 6000,  dailyPrompts: null },
  team:  { label: "Team",  creditsCents: 20000, dailyPrompts: null }
}

const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  "gemini-flash":    { inputPerM: 50,   outputPerM: 200  },
  "gemini-pro":      { inputPerM: 300,  outputPerM: 2500 },
  "openrouter-auto": { inputPerM: 30,   outputPerM: 120  },
  "llama-70b":       { inputPerM: 30,   outputPerM: 120  },
  "mistral-small":   { inputPerM: 30,   outputPerM: 120  },
  "gemini-flash-or": { inputPerM: 30,   outputPerM: 120  },
}

const DEFAULT_INPUT_COST_PER_M  = 50
const DEFAULT_OUTPUT_COST_PER_M = 200

export function calculateCostCents(inputTokens: number, outputTokens: number, generationData: Record<string, unknown> | null | undefined, model: string): number {
  if (generationData?.total_cost && (generationData.total_cost as number) > 0) {
    const baseCents = (generationData.total_cost as number) * 100
    return Math.ceil(baseCents * 1.5 * 10000) / 10000
  }

  const pricing = MODEL_PRICING[model] || { inputPerM: DEFAULT_INPUT_COST_PER_M, outputPerM: DEFAULT_OUTPUT_COST_PER_M }
  const inputCost  = (inputTokens / 1_000_000) * pricing.inputPerM
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerM
  return Math.ceil((inputCost + outputCost) * 10000) / 10000
}

export async function getSubscription(userId: string): Promise<Record<string, unknown>> {
  let res = await query("SELECT * FROM subscriptions WHERE user_id = $1", [userId])

  if (res.rowCount === 0) {
    await query(
      `INSERT INTO subscriptions (user_id, plan, credits_cents, credits_used_cents, status)
       VALUES ($1, 'free', 0, 0, 'active')`,
      [userId]
    )
    res = await query("SELECT * FROM subscriptions WHERE user_id = $1", [userId])
  }

  return res.rows[0]
}

interface UsageCheckResult {
  allowed: boolean
  reason?: string
  remaining: number | null
  plan?: string
}

export async function checkUsageAllowed(userId: string | null | undefined): Promise<UsageCheckResult> {
  if (!userId) {
    return { allowed: true, remaining: null }
  }

  const sub = await getSubscription(userId)

  if (sub.plan === "free") {
    const user = await query("SELECT free_prompts_today, free_prompts_reset_at FROM users WHERE id = $1", [userId])
    const row = user.rows[0]

    const resetAt = new Date(row.free_prompts_reset_at)
    const now = new Date()
    const isNewDay = now.toDateString() !== resetAt.toDateString()

    if (isNewDay) {
      await query(
        "UPDATE users SET free_prompts_today = 0, free_prompts_reset_at = NOW() WHERE id = $1",
        [userId]
      )
      return { allowed: true, remaining: PLANS.free.dailyPrompts, plan: "free" }
    }

    const used = (row.free_prompts_today || 0) as number
    const limit = PLANS.free.dailyPrompts!
    if (used >= limit) {
      return {
        allowed: false,
        reason: `Daily limit reached (${limit} prompts/day on Free plan). Upgrade for unlimited usage.`,
        remaining: 0,
        plan: "free"
      }
    }

    return { allowed: true, remaining: limit - used, plan: "free" }
  }

  const remaining = (sub.credits_cents as number) - (sub.credits_used_cents as number)
  if (remaining <= 0) {
    return {
      allowed: false,
      reason: `Credits exhausted on ${PLANS[sub.plan as string]?.label || sub.plan} plan. Wait for renewal or upgrade.`,
      remaining: 0,
      plan: sub.plan as string
    }
  }

  return {
    allowed: true,
    remaining: remaining / 100,
    plan: sub.plan as string
  }
}

interface RecordUsageParams {
  runId: string
  projectId: string
  model: string
  inputTokens: number
  outputTokens: number
  costCents: number
  isNewPrompt: boolean
}

export async function recordUsage(userId: string, { runId, projectId, model, inputTokens, outputTokens, costCents, isNewPrompt }: RecordUsageParams): Promise<void> {
  if (!userId) return

  const sub = await getSubscription(userId)

  if (sub.plan === "free") {
    await query(
      `INSERT INTO usage_logs (user_id, run_id, project_id, model, input_tokens, output_tokens, cost_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, runId, projectId, model, inputTokens, outputTokens, 0]
    )
    if (isNewPrompt) {
      await query(
        "UPDATE users SET free_prompts_today = free_prompts_today + 1 WHERE id = $1",
        [userId]
      )
    }
  } else {
    await query(
      `INSERT INTO usage_logs (user_id, run_id, project_id, model, input_tokens, output_tokens, cost_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, runId, projectId, model, inputTokens, outputTokens, costCents]
    )
    await query(
      `UPDATE subscriptions SET credits_used_cents = credits_used_cents + $1, updated_at = NOW()
       WHERE user_id = $2`,
      [costCents, userId]
    )
  }
}

export async function getUsageSummary(userId: string): Promise<Record<string, unknown>> {
  const sub = await getSubscription(userId)
  const plan = PLANS[sub.plan as string] || PLANS.free

  const todayLogs = await query(
    `SELECT COUNT(*) as count, COALESCE(SUM(cost_cents), 0) as total_cost
     FROM usage_logs WHERE user_id = $1 AND created_at > CURRENT_DATE`,
    [userId]
  )

  const result: Record<string, unknown> = {
    plan: sub.plan,
    planLabel: plan.label,
    status: sub.status
  }

  if (sub.plan === "free") {
    const user = await query("SELECT free_prompts_today, free_prompts_reset_at FROM users WHERE id = $1", [userId])
    const row = user.rows[0]
    const resetAt = new Date(row.free_prompts_reset_at)
    const isNewDay = new Date().toDateString() !== resetAt.toDateString()
    const promptsUsed = isNewDay ? 0 : (row.free_prompts_today || 0)
    result.promptsUsed = promptsUsed
    result.promptsLimit = plan.dailyPrompts
    result.promptsRemaining = plan.dailyPrompts! - (promptsUsed as number)
  } else {
    result.creditsCents = sub.credits_cents
    result.creditsUsedCents = sub.credits_used_cents
    result.creditsRemainingCents = (sub.credits_cents as number) - (sub.credits_used_cents as number)
    result.creditsRemaining = ((result.creditsRemainingCents as number) / 100).toFixed(2)
    result.creditsTotal = ((sub.credits_cents as number) / 100).toFixed(2)
    if (sub.period_end) result.periodEnd = sub.period_end
  }

  result.todayRequests = parseInt(todayLogs.rows[0].count)
  result.todayCostCents = parseFloat(todayLogs.rows[0].total_cost)

  return result
}

interface StripeData {
  plan: string
  stripeCustomerId: string
  stripeSubscriptionId: string
  periodStart: string
  periodEnd: string
  status?: string
}

export async function updateSubscriptionFromStripe(userId: string, stripeData: StripeData): Promise<void> {
  const { plan, stripeCustomerId, stripeSubscriptionId, periodStart, periodEnd, status } = stripeData
  const planDef = PLANS[plan]
  if (!planDef) throw new Error(`Unknown plan: ${plan}`)

  await query(
    `UPDATE subscriptions SET
       plan = $1,
       stripe_customer_id = $2,
       stripe_subscription_id = $3,
       credits_cents = $4,
       credits_used_cents = 0,
       period_start = $5,
       period_end = $6,
       status = $7,
       updated_at = NOW()
     WHERE user_id = $8`,
    [plan, stripeCustomerId, stripeSubscriptionId, planDef.creditsCents, periodStart, periodEnd, status || "active", userId]
  )
}
