import { handleUserMessage } from "../handlers/user-message.js"
import { handleToolResult } from "../handlers/tool-result.js"
import { extractUser } from "./auth.js"
import { resolveChat } from "./chats.js"
import { checkUsageAllowed } from "../store/subscriptions.js"
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"

export async function agentRunRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post("/agent/run", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>

    try {
      const user = extractUser(request)
      if (user) {
        body.userId = user.userId
        body.username = user.username
      }

      if (body.chatUid && user) {
        const chat = await resolveChat(body.chatUid as string, user.userId)
        if (chat) {
          body.chatId = chat.id
          body.chatUid = chat.chatUid
        }
      }

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
        return await handleUserMessage(body as never)
      }

      if (body.type === "tool_result") {
        return await handleToolResult(body as never)
      }

      return reply.code(400).send({
        status: "failed",
        error: "Unknown request type"
      })
    } catch (error) {
      request.log.error(error)
      return reply.code(500).send({
        status: "failed",
        error: (error as Error).message || "Internal server error"
      })
    }
  })
}
