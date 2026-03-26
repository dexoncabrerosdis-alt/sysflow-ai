import { BaseProvider } from "./base-provider.js"
import type { ProviderPayload, NormalizedResponse, TokenUsage } from "../types.js"

interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

const API_URL = "https://openrouter.ai/api/v1/chat/completions"

export class OpenRouterProvider extends BaseProvider {
  readonly name = "OpenRouter"

  readonly modelMap: Record<string, string> = {
    "openrouter-auto": "openrouter/auto",
    "llama-70b": "meta-llama/llama-3.3-70b-instruct:free",
    "mistral-small": "mistralai/mistral-small-3.1-24b-instruct:free",
    "gemini-flash-or": "google/gemini-2.0-flash-exp:free"
  }

  private getApiKey(): string {
    const key = process.env.OPENROUTER_API_KEY
    if (!key) throw new Error("OPENROUTER_API_KEY is not set in .env")
    return key
  }

  async call(payload: ProviderPayload): Promise<NormalizedResponse> {
    const apiKey = this.getApiKey()
    const modelName = this.getModelName(payload.model)

    try {
      let history = this.runState.get(payload.runId) as ChatMessage[] | undefined

      if (!payload.toolResult && !payload.toolResults) {
        // First call — new conversation
        history = [
          { role: "system", content: this.systemPrompt },
          { role: "user", content: this.buildInitialUserMessage(payload) }
        ]
        this.runState.set(payload.runId, history)
        this.setRunTask(payload.runId, payload.userMessage)
      } else {
        // Continuation — add tool result(s) to history
        const toolMsg = this.buildToolResultMessage(payload)

        if (!history) {
          history = [
            { role: "system", content: this.systemPrompt },
            { role: "user", content: `Previous ${toolMsg}` }
          ]
          this.runState.set(payload.runId, history)
        } else {
          history.push({ role: "user", content: toolMsg })
        }
      }

      const MAX_RETRIES = 2
      let response: Response | undefined
      let lastError: Error | undefined

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 120_000)

          response = await fetch(API_URL, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://sysflow.dev",
              "X-Title": "Sysflow Agent"
            },
            body: JSON.stringify({
              model: modelName,
              messages: history,
              response_format: { type: "json_object" },
              temperature: 0.1,
              max_tokens: this.getAdaptiveMaxTokens(32768)
            }),
            signal: controller.signal
          })

          clearTimeout(timeout)
          break
        } catch (fetchErr) {
          lastError = fetchErr as Error
          console.error(`[openrouter] Fetch attempt ${attempt + 1} failed:`, lastError.message)
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
          }
        }
      }

      if (!response) {
        throw lastError || new Error("OpenRouter fetch failed after retries")
      }

      if (!response.ok) {
        const errBody = await response.text()
        const status = response.status
        console.error(`[openrouter] HTTP ${status}:`, errBody)

        // Rate limit — DON'T clear run state, signal for retry/fallback
        if (status === 429) {
          return this.rateLimitedResponse(`OpenRouter rate limit (429). Details: ${errBody.slice(0, 200)}`)
        }

        this.clearRunState(payload.runId)

        if (status === 401 || status === 403) {
          return this.failedResponse(`OpenRouter auth error (${status}). Check your OPENROUTER_API_KEY.`)
        }
        return this.failedResponse(`OpenRouter error ${status}: ${errBody.slice(0, 300)}`)
      }

      const data = await response.json() as {
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_cost?: number }
        choices?: Array<{ message?: { content?: string } }>
      }

      const usage: TokenUsage = {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        generationData: data.usage?.total_cost != null ? { total_cost: data.usage.total_cost } : null
      }

      const assistantMessage = data.choices?.[0]?.message?.content || ""

      // Add assistant response to history for multi-turn
      history!.push({ role: "assistant", content: assistantMessage })

      let normalized = this.parseJsonResponse(assistantMessage)
      normalized.usage = usage
      this.onSuccessfulCall()

      // Layer 2: provider-level completion validation
      normalized = this.validateCompletionResponse(payload.runId, normalized)

      if (normalized.kind === "completed" || normalized.kind === "failed") {
        this.clearRunState(payload.runId)
      }

      return normalized
    } catch (err) {
      this.clearRunState(payload.runId)

      const errMsg = (err as Error).message || ""
      console.error("[openrouter] Error:", errMsg)

      if (errMsg.includes("OPENROUTER_API_KEY")) {
        return this.failedResponse("OPENROUTER_API_KEY is not set in .env")
      }

      return this.failedResponse(`OpenRouter error: ${errMsg}`)
    }
  }
}
