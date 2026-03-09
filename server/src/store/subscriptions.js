import { query } from "../db/connection.js"

// Plan definitions: credits in cents (e.g. $20 = 2000 cents)
export const PLANS = {
  free:  { label: "Free",  creditsCents: 0,     dailyPrompts: 10 },
  lite:  { label: "Lite",  creditsCents: 2000,  dailyPrompts: null },
  pro:   { label: "Pro",   creditsCents: 6000,  dailyPrompts: null },
  team:  { label: "Team",  creditsCents: 20000, dailyPrompts: null }
}

// Per-model pricing per 1M tokens (in cents), with margin baked in
// Base cost -> our price (includes infra + margin)
//
// Gemini Flash base:  input $0.15/1M, output $0.60/1M
// Our price (~3x):    input $0.50/1M, output $2.00/1M
//
// Gemini Pro base:    input $1.25/1M, output $10.00/1M
// Our price (~2.5x):  input $3.00/1M, output $25.00/1M
const MODEL_PRICING = {
  "gemini-flash":    { inputPerM: 50,   outputPerM: 200  },
  "gemini-pro":      { inputPerM: 300,  outputPerM: 2500 },
  "openrouter-auto": { inputPerM: 30,   outputPerM: 120  },
  "llama-70b":       { inputPerM: 30,   outputPerM: 120  },
  "mistral-small":   { inputPerM: 30,   outputPerM: 120  },
  "gemini-flash-or": { inputPerM: 30,   outputPerM: 120  },
}

// Fallback for models without specific pricing (e.g. OpenRouter where we read from API)
const DEFAULT_INPUT_COST_PER_M  = 50   // $0.50 per 1M input tokens
const DEFAULT_OUTPUT_COST_PER_M = 200  // $2.00 per 1M output tokens

/**
 * Calculate cost in cents from token counts.
 * Uses actual OpenRouter generation data if available, otherwise model-specific pricing.
 */
export function calculateCostCents(inputTokens, outputTokens, generationData, model) {
  // If OpenRouter reports a non-zero total_cost, use it with 1.5x margin
  // For free models (total_cost = 0), fall through to our MODEL_PRICING
  if (generationData?.total_cost && generationData.total_cost > 0) {
    const baseCents = generationData.total_cost * 100
    return Math.ceil(baseCents * 1.5 * 10000) / 10000
  }

  // Use model-specific pricing or defaults
  const pricing = MODEL_PRICING[model] || { inputPerM: DEFAULT_INPUT_COST_PER_M, outputPerM: DEFAULT_OUTPUT_COST_PER_M }
  const inputCost  = (inputTokens / 1_000_000) * pricing.inputPerM
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerM
  // Round up to 4 decimal places of cents
  return Math.ceil((inputCost + outputCost) * 10000) / 10000
}

/**
 * Get or create subscription record for a user.
 */
export async function getSubscription(userId) {
  let res = await query("SELECT * FROM subscriptions WHERE user_id = $1", [userId])

  if (res.rowCount === 0) {
    // Create free subscription
    await query(
      `INSERT INTO subscriptions (user_id, plan, credits_cents, credits_used_cents, status)
       VALUES ($1, 'free', 0, 0, 'active')`,
      [userId]
    )
    res = await query("SELECT * FROM subscriptions WHERE user_id = $1", [userId])
  }

  return res.rows[0]
}

/**
 * Check if user can make a request.
 * Returns { allowed: true/false, reason: string, remaining: number|null }
 */
export async function checkUsageAllowed(userId) {
  if (!userId) {
    // No auth — allow with a generic limit message
    return { allowed: true, remaining: null }
  }

  const sub = await getSubscription(userId)

  if (sub.plan === "free") {
    // Check daily prompt limit
    const user = await query("SELECT free_prompts_today, free_prompts_reset_at FROM users WHERE id = $1", [userId])
    const row = user.rows[0]

    // Reset daily counter if new day
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

    const used = row.free_prompts_today || 0
    const limit = PLANS.free.dailyPrompts
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

  // Paid plan — check credits
  const remaining = sub.credits_cents - sub.credits_used_cents
  if (remaining <= 0) {
    return {
      allowed: false,
      reason: `Credits exhausted on ${PLANS[sub.plan]?.label || sub.plan} plan. Wait for renewal or upgrade.`,
      remaining: 0,
      plan: sub.plan
    }
  }

  return {
    allowed: true,
    remaining: remaining / 100, // in dollars
    plan: sub.plan
  }
}

/**
 * Record usage after a model call.
 * Increments free prompt count OR deducts credits.
 * @param {boolean} isNewPrompt - true only for user_message (not tool_result continuations)
 */
export async function recordUsage(userId, { runId, projectId, model, inputTokens, outputTokens, costCents, isNewPrompt }) {
  if (!userId) return

  const sub = await getSubscription(userId)

  if (sub.plan === "free") {
    // Free plan: log with 0 cost, only increment prompt counter
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
    // Paid plan: log actual cost and deduct credits
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

/**
 * Get usage summary for a user.
 */
export async function getUsageSummary(userId) {
  const sub = await getSubscription(userId)
  const plan = PLANS[sub.plan] || PLANS.free

  const todayLogs = await query(
    `SELECT COUNT(*) as count, COALESCE(SUM(cost_cents), 0) as total_cost
     FROM usage_logs WHERE user_id = $1 AND created_at > CURRENT_DATE`,
    [userId]
  )

  const result = {
    plan: sub.plan,
    planLabel: plan.label,
    status: sub.status
  }

  if (sub.plan === "free") {
    const user = await query("SELECT free_prompts_today, free_prompts_reset_at FROM users WHERE id = $1", [userId])
    const row = user.rows[0]
    const resetAt = new Date(row.free_prompts_reset_at)
    const isNewDay = new Date().toDateString() !== resetAt.toDateString()
    result.promptsUsed = isNewDay ? 0 : (row.free_prompts_today || 0)
    result.promptsLimit = plan.dailyPrompts
    result.promptsRemaining = plan.dailyPrompts - result.promptsUsed
  } else {
    result.creditsCents = sub.credits_cents
    result.creditsUsedCents = sub.credits_used_cents
    result.creditsRemainingCents = sub.credits_cents - sub.credits_used_cents
    result.creditsRemaining = (result.creditsRemainingCents / 100).toFixed(2)
    result.creditsTotal = (sub.credits_cents / 100).toFixed(2)
    if (sub.period_end) result.periodEnd = sub.period_end
  }

  result.todayRequests = parseInt(todayLogs.rows[0].count)
  result.todayCostCents = parseFloat(todayLogs.rows[0].total_cost)

  return result
}

/**
 * Update subscription from Stripe webhook data.
 */
export async function updateSubscriptionFromStripe(userId, stripeData) {
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
