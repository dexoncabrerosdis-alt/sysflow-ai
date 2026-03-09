import { BaseProvider } from "./base-provider.js"
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

export async function callModelAdapter(payload: ProviderPayload): Promise<NormalizedResponse> {
  const provider = providers.get(payload.model)
  if (!provider) {
    throw new Error(`Unsupported model: ${payload.model}`)
  }
  return provider.call(payload)
}
