import { getAuthToken } from "./sysbase.js"

const SERVER_URL = process.env.SYS_SERVER_URL || "http://localhost:3000"

interface ServerError extends Error {
  code?: string
  plan?: string
}

export async function callServer(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 300000)

  const authToken = await getAuthToken()
  const bearerToken = authToken || process.env.SYS_TOKEN || "YOUR_TOKEN"

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
      if (res.status === 429) {
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
      }
      throw new Error(`Server error ${res.status}: ${text}`)
    }

    return res.json() as Promise<Record<string, unknown>>
  } finally {
    clearTimeout(timeout)
  }
}
