import { query } from "../db/connection.js"
import { extractUser } from "./auth.js"
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"

export async function chatRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/chats", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = extractUser(request)
    if (!user) return reply.code(401).send({ error: "Not authenticated" })

    const projectId = (request.query as Record<string, string>).projectId || null

    let res
    if (projectId) {
      res = await query(
        `SELECT c.id, c.chat_uid, c.title, c.model, c.status, c.project_id, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM sessions s WHERE s.chat_id = c.id) AS session_count,
                (SELECT s.prompt FROM sessions s WHERE s.chat_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS last_prompt,
                (SELECT s.outcome FROM sessions s WHERE s.chat_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS last_outcome
         FROM chats c WHERE c.user_id = $1 AND c.project_id = $2
         ORDER BY c.updated_at DESC LIMIT 20`,
        [user.userId, projectId]
      )
    } else {
      res = await query(
        `SELECT c.id, c.chat_uid, c.title, c.model, c.status, c.project_id, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM sessions s WHERE s.chat_id = c.id) AS session_count,
                (SELECT s.prompt FROM sessions s WHERE s.chat_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS last_prompt,
                (SELECT s.outcome FROM sessions s WHERE s.chat_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS last_outcome
         FROM chats c WHERE c.user_id = $1
         ORDER BY c.updated_at DESC LIMIT 20`,
        [user.userId]
      )
    }

    return { status: "ok", chats: res.rows }
  })

  fastify.post("/chats", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = extractUser(request)
    if (!user) return reply.code(401).send({ error: "Not authenticated" })

    const { projectId, title, model } = (request.body || {}) as { projectId?: string; title?: string; model?: string }
    if (!projectId) return reply.code(400).send({ error: "projectId is required" })

    const res = await query(
      `INSERT INTO chats (user_id, project_id, title, model)
       VALUES ($1, $2, $3, $4)
       RETURNING chat_uid, title, model, status, project_id, created_at`,
      [user.userId, projectId, title || "New Chat", model || null]
    )

    return { status: "ok", chat: res.rows[0] }
  })

  fastify.get("/chats/:chatUid", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = extractUser(request)
    if (!user) return reply.code(401).send({ error: "Not authenticated" })

    const { chatUid } = request.params as { chatUid: string }

    const chatRes = await query(
      `SELECT id, chat_uid, title, model, status, project_id, created_at, updated_at
       FROM chats WHERE chat_uid = $1 AND user_id = $2`,
      [chatUid, user.userId]
    )

    if (chatRes.rowCount === 0) {
      return reply.code(404).send({ error: "Chat not found" })
    }

    const chat = chatRes.rows[0]

    const sessionsRes = await query(
      `SELECT s.run_id, s.prompt, s.model, s.outcome, s.error, s.files_modified, s.created_at
       FROM sessions s WHERE s.chat_id = $1
       ORDER BY s.created_at ASC LIMIT 50`,
      [chat.id]
    )

    return {
      status: "ok",
      chat: {
        chatUid: chat.chat_uid,
        title: chat.title,
        model: chat.model,
        status: chat.status,
        projectId: chat.project_id,
        createdAt: chat.created_at,
        updatedAt: chat.updated_at
      },
      sessions: sessionsRes.rows
    }
  })

  fastify.patch("/chats/:chatUid", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = extractUser(request)
    if (!user) return reply.code(401).send({ error: "Not authenticated" })

    const { chatUid } = request.params as { chatUid: string }
    const { title } = (request.body || {}) as { title?: string }

    if (!title) return reply.code(400).send({ error: "title is required" })

    const res = await query(
      `UPDATE chats SET title = $1, updated_at = NOW()
       WHERE chat_uid = $2 AND user_id = $3 RETURNING chat_uid, title`,
      [title, chatUid, user.userId]
    )

    if (res.rowCount === 0) return reply.code(404).send({ error: "Chat not found" })

    return { status: "ok", chat: res.rows[0] }
  })

  fastify.delete("/chats/:chatUid", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = extractUser(request)
    if (!user) return reply.code(401).send({ error: "Not authenticated" })

    const { chatUid } = request.params as { chatUid: string }

    const chatRes = await query(
      "SELECT id FROM chats WHERE chat_uid = $1 AND user_id = $2",
      [chatUid, user.userId]
    )

    if (chatRes.rowCount === 0) return reply.code(404).send({ error: "Chat not found" })

    const chatId = chatRes.rows[0].id

    await query("DELETE FROM run_actions WHERE run_id IN (SELECT run_id FROM sessions WHERE chat_id = $1)", [chatId])
    await query("DELETE FROM sessions WHERE chat_id = $1", [chatId])
    await query("DELETE FROM chats WHERE id = $1", [chatId])

    return { status: "ok", deleted: chatUid }
  })
}

export async function resolveChat(chatUid: string, userId: string): Promise<{ id: number; chatUid: string; userId: string; projectId: string } | null> {
  if (!chatUid) return null

  const res = await query(
    "SELECT id, chat_uid, user_id, project_id FROM chats WHERE chat_uid = $1 AND user_id = $2",
    [chatUid, userId]
  )

  if (res.rowCount === 0) return null

  const row = res.rows[0]
  return { id: row.id, chatUid: row.chat_uid, userId: row.user_id, projectId: row.project_id }
}
