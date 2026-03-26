import { BaseProvider, MODEL_FALLBACK_CHAINS, isProviderRateLimited, getRateLimitState } from "./base-provider.js"
import { GeminiProvider } from "./gemini.js"
import { OpenRouterProvider } from "./openrouter.js"
import { ClaudeSonnetProvider } from "./claude-sonnet.js"
import { ClaudeOpusProvider } from "./claude-opus.js"
import { SweProvider } from "./swe.js"
import type { ProviderPayload, NormalizedResponse } from "../types.js"

// ─── Provider Registry ───

const providers: Map<string, BaseProvider> = new Map()

function registerProvider(provider: BaseProvider): void {
  for (const modelId of Object.keys(provider.modelMap)) {
    providers.set(modelId, provider)
  }
}

// Register all providers
registerProvider(new GeminiProvider())
registerProvider(new OpenRouterProvider())
registerProvider(new ClaudeSonnetProvider())
registerProvider(new ClaudeOpusProvider())
registerProvider(new SweProvider())

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Call the model adapter with automatic retry and fallback on rate limits.
 *
 * Strategy:
 * 1. Try the primary model
 * 2. If rate_limited, wait (exponential backoff) and retry
 * 3. If the primary is exhausted (too many consecutive hits), try fallback models
 * 4. Only return failed if ALL options are exhausted
 */
export async function callModelAdapter(payload: ProviderPayload): Promise<NormalizedResponse> {
  // Try the primary model first
  const result = await callWithRetry(payload.model, payload)
  if (result.kind !== "rate_limited") return result

  // Primary exhausted — try fallback chain
  const fallbacks = MODEL_FALLBACK_CHAINS[payload.model] || []
  for (const fallbackModel of fallbacks) {
    const fbProvider = providers.get(fallbackModel)
    if (!fbProvider) continue
    if (isProviderRateLimited(fbProvider.name)) {
      console.log(`[adapter] Skipping fallback ${fallbackModel} — also rate limited`)
      continue
    }

    console.log(`[adapter] Falling back from ${payload.model} → ${fallbackModel}`)
    const fbPayload = { ...payload, model: fallbackModel }
    const fbResult = await callWithRetry(fallbackModel, fbPayload)
    if (fbResult.kind !== "rate_limited") return fbResult
  }

  // All options exhausted — return a failed response with retry hint
  return {
    kind: "failed",
    error: `All models rate limited. The system will auto-retry shortly. Original: ${result.error}`,
    usage: { inputTokens: 0, outputTokens: 0 }
  }
}

async function callWithRetry(modelId: string, payload: ProviderPayload): Promise<NormalizedResponse> {
  const provider = providers.get(modelId)
  if (!provider) {
    throw new Error(`Unsupported model: ${modelId}`)
  }

  const MAX_RETRIES = 3
  let lastResult: NormalizedResponse | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await provider.call(payload)

    if (result.kind !== "rate_limited") {
      return result
    }

    lastResult = result
    const state = getRateLimitState(provider.name)
    if (!state) break

    // If we've hit too many times, give up on this provider
    if (state.hitCount > MAX_RETRIES) {
      console.log(`[adapter] ${provider.name} exceeded retry limit (${state.hitCount} hits), moving to fallback`)
      break
    }

    // Wait with exponential backoff before retrying
    console.log(`[adapter] Waiting ${state.backoffMs}ms before retry #${attempt + 1} on ${provider.name}`)
    await sleep(state.backoffMs)
  }

  return lastResult || { kind: "rate_limited", error: "Rate limited", usage: { inputTokens: 0, outputTokens: 0 } }
}
