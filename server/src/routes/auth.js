import bcrypt from "bcrypt"
import jwt from "jsonwebtoken"
import { query } from "../db/connection.js"

const JWT_SECRET = process.env.JWT_SECRET || "sysflow-secret-change-me"
const SALT_ROUNDS = 10

export async function authRoutes(fastify) {
  // ─── Register ───
  fastify.post("/auth/register", async (request, reply) => {
    const { username, password } = request.body || {}

    if (!username || !password) {
      return reply.code(400).send({ error: "Username and password are required" })
    }

    if (username.length < 3) {
      return reply.code(400).send({ error: "Username must be at least 3 characters" })
    }

    if (password.length < 4) {
      return reply.code(400).send({ error: "Password must be at least 4 characters" })
    }

    // Check if username already exists
    const existing = await query("SELECT id FROM users WHERE username = $1", [username])
    if (existing.rowCount > 0) {
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

  // ─── Login ───
  fastify.post("/auth/login", async (request, reply) => {
    const { username, password } = request.body || {}

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

  // ─── Whoami (verify token) ───
  fastify.get("/auth/me", async (request, reply) => {
    const auth = request.headers.authorization
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Not authenticated" })
    }

    try {
      const decoded = jwt.verify(auth.slice(7), JWT_SECRET)
      return { status: "ok", user: { id: decoded.userId, username: decoded.username } }
    } catch {
      return reply.code(401).send({ error: "Invalid or expired token" })
    }
  })
}

/**
 * Auth middleware — extracts user from JWT and attaches to request.
 * Use this as a preHandler on routes that need auth.
 * Falls through gracefully if no token (for backward compatibility).
 */
export function extractUser(request) {
  const auth = request.headers?.authorization
  if (!auth || !auth.startsWith("Bearer ")) return null

  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET)
    return { userId: decoded.userId, username: decoded.username }
  } catch {
    return null
  }
}
