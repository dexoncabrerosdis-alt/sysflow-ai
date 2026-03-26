import { getAuthToken } from "./sysbase.js"

const SERVER_URL = process.env.SYS_SERVER_URL || "http://localhost:3000"

interface ServerError extends Error {
  code?: string
  plan?: string
}

export interface StreamEvent {
  type: "phase" | "result" | "error"
  data: Record<string, unknown>
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Parse a 429 response — throws USAGE_LIMIT or returns null if not a billing limit */
function parse429(text: string, status: number): never | null {
  if (status !== 429) return null
  try {
    const data = JSON.parse(text)
    if (data.status === "usage_limit") {
      const err: ServerError = new Error(data.error || "Usage limit reached")
      err.code = "USAGE_LIMIT"
      err.plan = data.plan
      throw err
    }
  } catch (e) {
    if ((e as ServerError).code === "USAGE_LIMIT") throw e
  }
  return null
}

/** Check for session expired errors */
function checkSessionExpired(text: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(text)
    if (data.error && (data.error.includes("Run not found") || data.error.includes("Session expired"))) {
      return { status: "failed", runId: null, error: "Session expired. The server was restarted. Please run your prompt again or use sys continue." }
    }
  } catch { /* not JSON */ }
  return null
}

const MAX_SERVER_RETRIES = 3
const SERVER_RETRY_BASE_MS = 3000

export async function callServer(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const authToken = await getAuthToken()
  const bearerToken = authToken || process.env.SYS_TOKEN || "YOUR_TOKEN"

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_SERVER_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 300000)

    try {
      const res = await fetch(`${SERVER_URL}/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      })

      if (!res.ok) {
        const text = await res.text()

        // Billing usage limit — throw immediately (caller handles retry)
        parse429(text, res.status)

        // API rate limit (429 but not billing) — retry with backoff
        if (res.status === 429 && attempt < MAX_SERVER_RETRIES) {
          const waitMs = SERVER_RETRY_BASE_MS * Math.pow(2, attempt)
          console.error(`[server] 429 rate limit, retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_SERVER_RETRIES})`)
          await sleepMs(waitMs)
          continue
        }

        // Session expired
        const expired = checkSessionExpired(text)
        if (expired) return expired

        throw new Error(`Server error ${res.status}: ${text}`)
      }

      return res.json() as Promise<Record<string, unknown>>
    } catch (err) {
      if ((err as ServerError).code === "USAGE_LIMIT") throw err
      lastError = err as Error

      // Network/timeout errors — retry
      if (attempt < MAX_SERVER_RETRIES && !(err as Error).message?.includes("Server error")) {
        const waitMs = SERVER_RETRY_BASE_MS * Math.pow(2, attempt)
        console.error(`[server] Request failed, retrying in ${waitMs}ms: ${(err as Error).message}`)
        await sleepMs(waitMs)
        continue
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  throw lastError || new Error("callServer exhausted retries")
}

/**
 * Call server with SSE streaming for real-time progress updates.
 * Yields phase events, then returns the final result.
 * Retries on 429 (non-billing) with exponential backoff.
 */
export async function callServerStream(
  payload: Record<string, unknown>,
  onPhase?: (label: string) => void
): Promise<Record<string, unknown>> {
  const authToken = await getAuthToken()
  const bearerToken = authToken || process.env.SYS_TOKEN || "YOUR_TOKEN"

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_SERVER_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 300000)

    try {
      const res = await fetch(`${SERVER_URL}/agent/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearerToken}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      })

      if (!res.ok) {
        const text = await res.text()

        // Billing usage limit — throw immediately
        parse429(text, res.status)

        // API rate limit — retry with backoff
        if (res.status === 429 && attempt < MAX_SERVER_RETRIES) {
          const waitMs = SERVER_RETRY_BASE_MS * Math.pow(2, attempt)
          console.error(`[stream] 429 rate limit, retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_SERVER_RETRIES})`)
          await sleepMs(waitMs)
          continue
        }

        // Session expired
        const expired = checkSessionExpired(text)
        if (expired) return expired

        throw new Error(`Server error ${res.status}: ${text}`)
      }

      // Parse SSE stream
      const body = res.body
      if (!body) throw new Error("No response body")

      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let finalResult: Record<string, unknown> | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete SSE messages
        const lines = buffer.split("\n")
        buffer = lines.pop() || "" // Keep incomplete line in buffer

        let currentEvent = ""
        let currentData = ""

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6).trim()
          } else if (line === "" && currentEvent && currentData) {
            try {
              const parsed = JSON.parse(currentData)

              if (currentEvent === "phase" && onPhase) {
                onPhase(parsed.label || parsed.phase)
              } else if (currentEvent === "result") {
                finalResult = parsed
              } else if (currentEvent === "error") {
                if (parsed.status === "usage_limit") {
                  const err: ServerError = new Error(parsed.error || "Usage limit reached")
                  err.code = "USAGE_LIMIT"
                  err.plan = parsed.plan
                  throw err
                }
                throw new Error(parsed.error || "Server error")
              }
            } catch (e) {
              if ((e as ServerError).code === "USAGE_LIMIT") throw e
              if ((e as Error).message === "Server error") throw e
              // Ignore parse errors for partial data
            }
            currentEvent = ""
            currentData = ""
          }
        }
      }

      if (!finalResult) {
        throw new Error("Stream ended without result")
      }

      return finalResult
    } catch (err) {
      if ((err as ServerError).code === "USAGE_LIMIT") throw err
      lastError = err as Error

      // Network/timeout errors — retry
      if (attempt < MAX_SERVER_RETRIES && !(err as Error).message?.includes("Server error")) {
        const waitMs = SERVER_RETRY_BASE_MS * Math.pow(2, attempt)
        console.error(`[stream] Request failed, retrying in ${waitMs}ms: ${(err as Error).message}`)
        await sleepMs(waitMs)
        continue
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  throw lastError || new Error("callServerStream exhausted retries")
}
