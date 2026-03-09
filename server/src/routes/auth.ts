import bcrypt from "bcrypt"
import jwt from "jsonwebtoken"
import { query } from "../db/connection.js"
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"

const JWT_SECRET = process.env.JWT_SECRET || "sysflow-secret-change-me"
const SALT_ROUNDS = 10

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/auth/register", async (request: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = (request.body || {}) as { username?: string; password?: string }

    if (!username || !password) {
      return reply.code(400).send({ error: "Username and password are required" })
    }

    if (username.length < 3) {
      return reply.code(400).send({ error: "Username must be at least 3 characters" })
    }

    if (password.length < 4) {
      return reply.code(400).send({ error: "Password must be at least 4 characters" })
    }

    const existing = await query("SELECT id FROM users WHERE username = $1", [username])
    if (existing.rowCount! > 0) {
      return reply.code(409).send({ error: "Username already taken" })
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)
    const res = await query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at",
      [username, passwordHash]
    )

    const user = res.rows[0]
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" })

    return {
      status: "ok",
      user: { id: user.id, username: user.username },
      token
    }
  })

  fastify.post("/auth/login", async (request: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = (request.body || {}) as { username?: string; password?: string }

    if (!username || !password) {
      return reply.code(400).send({ error: "Username and password are required" })
    }

    const res = await query("SELECT id, username, password_hash FROM users WHERE username = $1", [username])
    if (res.rowCount === 0) {
      return reply.code(401).send({ error: "Invalid username or password" })
    }

    const user = res.rows[0]
    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return reply.code(401).send({ error: "Invalid username or password" })
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" })

    return {
      status: "ok",
      user: { id: user.id, username: user.username },
      token
    }
  })

  fastify.get("/auth/me", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Not authenticated" })
    }

    try {
      const decoded = jwt.verify(auth.slice(7), JWT_SECRET) as { userId: string; username: string }
      return { status: "ok", user: { id: decoded.userId, username: decoded.username } }
    } catch {
      return reply.code(401).send({ error: "Invalid or expired token" })
    }
  })
}

export function extractUser(request: FastifyRequest): { userId: string; username: string } | null {
  const auth = request.headers?.authorization
  if (!auth || !auth.startsWith("Bearer ")) return null

  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET) as { userId: string; username: string }
    return { userId: decoded.userId, username: decoded.username }
  } catch {
    return null
  }
}
