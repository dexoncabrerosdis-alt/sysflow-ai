import { handleUserMessage } from "../handlers/user-message.js"
import { handleToolResult } from "../handlers/tool-result.js"
import { extractUser } from "./auth.js"
import { resolveChat } from "./chats.js"
import { checkUsageAllowed } from "../store/subscriptions.js"

export async function agentRunRoute(fastify) {
  fastify.post("/agent/run", async (request, reply) => {
    const body = request.body

    try {
      // Extract auth (optional — backward compatible)
      const user = extractUser(request)
      if (user) {
        body.userId = user.userId
        body.username = user.username
      }

      // Resolve chat if provided
      if (body.chatUid && user) {
        const chat = await resolveChat(body.chatUid, user.userId)
        if (chat) {
          body.chatId = chat.id
          body.chatUid = chat.chatUid
        }
      }

      // Check usage limits on new messages (not tool results — those are continuations)
      if (body.type === "user_message" && user) {
        const usage = await checkUsageAllowed(user.userId)
        if (!usage.allowed) {
          return reply.code(429).send({
            status: "usage_limit",
            error: usage.reason,
            plan: usage.plan,
            remaining: usage.remaining
          })
        }
      }

      if (body.type === "user_message") {
        return await handleUserMessage(body)
      }

      if (body.type === "tool_result") {
        return await handleToolResult(body)
      }

      return reply.code(400).send({
        status: "failed",
        error: "Unknown request type"
      })
    } catch (error) {
      request.log.error(error)
      return reply.code(500).send({
        status: "failed",
        error: error.message || "Internal server error"
      })
    }
  })
}
