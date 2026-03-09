import "dotenv/config"
import Fastify from "fastify"
import cors from "@fastify/cors"
import { agentRunRoute } from "./routes/agent.js"
import { authRoutes } from "./routes/auth.js"
import { chatRoutes } from "./routes/chats.js"
import { stripeRoutes } from "./routes/billing.js"
import { initDatabase, closeDatabase } from "./db/connection.js"

const fastify = Fastify({
  logger: true,
  requestTimeout: 300000,
  keepAliveTimeout: 300000
})

// Preserve raw body for Stripe webhook signature verification
fastify.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  (req as unknown as { rawBody: unknown }).rawBody = body
  try {
    done(null, JSON.parse(body as string))
  } catch (err) {
    done(err as Error, undefined)
  }
})

await fastify.register(cors, {
  origin: true
})

await fastify.register(authRoutes)
await fastify.register(chatRoutes)
await fastify.register(stripeRoutes)
await fastify.register(agentRunRoute)

fastify.get("/health", async () => {
  return { status: "ok", timestamp: new Date().toISOString() }
})

fastify.addHook("onClose", async () => {
  await closeDatabase()
})

async function start(): Promise<void> {
  try {
    await initDatabase()
    await fastify.listen({ port: 3000, host: "0.0.0.0" })
    console.log("Sysflow API listening on http://localhost:3000")
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}

start()
