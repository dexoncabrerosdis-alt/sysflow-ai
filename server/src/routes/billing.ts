import Stripe from "stripe"
import { query } from "../db/connection.js"
import { extractUser } from "./auth.js"
import { getSubscription, updateSubscriptionFromStripe, getUsageSummary, PLANS } from "../store/subscriptions.js"
import { onCheckoutComplete, removeCheckoutListener, emitCheckoutComplete } from "../store/checkout-events.js"
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify"

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "")

function stripeDate(ts: number | null | undefined): Date {
  if (!ts || typeof ts !== "number") return new Date()
  return new Date(ts * 1000)
}

const PRICE_TO_PLAN: Record<string, string> = {
  [process.env.STRIPE_PRICE_ID_LITE || ""]: "lite",
  [process.env.STRIPE_PRICE_ID_PRO || ""]: "pro",
  [process.env.STRIPE_PRICE_ID_TEAM || ""]: "team"
}

export async function stripeRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/billing/plans", async () => {
    return {
      plans: [
        { id: "free", label: "Free",  price: "$0/mo",  desc: "10 prompts/day",       priceId: null },
        { id: "lite", label: "Lite",  price: "$20/mo", desc: "$20 of AI credits/mo",  priceId: process.env.STRIPE_PRICE_ID_LITE },
        { id: "pro",  label: "Pro",   price: "$60/mo", desc: "$60 of AI credits/mo",  priceId: process.env.STRIPE_PRICE_ID_PRO },
        { id: "team", label: "Team",  price: "$200/mo", desc: "$200 of AI credits/mo", priceId: process.env.STRIPE_PRICE_ID_TEAM }
      ]
    }
  })

  fastify.get("/billing/usage", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = extractUser(request)
    if (!user) return reply.code(401).send({ error: "Not authenticated" })

    const sub = await getSubscription(user.userId)
    if (sub.plan === "free" && sub.stripe_customer_id) {
      try {
        const subs = await stripe.subscriptions.list({
          customer: sub.stripe_customer_id as string,
          status: "active",
          limit: 1
        })
        if (subs.data.length > 0) {
          const activeSub = subs.data[0]
          const priceId = activeSub.items?.data?.[0]?.price?.id
          const plan = priceId ? PRICE_TO_PLAN[priceId] : undefined
          if (plan) {
            await updateSubscriptionFromStripe(user.userId, {
              plan,
              stripeCustomerId: sub.stripe_customer_id as string,
              stripeSubscriptionId: activeSub.id,
              periodStart: stripeDate(activeSub.current_period_start as number).toISOString(),
              periodEnd: stripeDate(activeSub.current_period_end as number).toISOString(),
              status: "active"
            })
            console.log(`[stripe] Reconciled: activated ${plan} for user ${user.userId}`)
          }
        }
      } catch (err) {
        console.error("[stripe] Reconciliation check failed:", (err as Error).message)
      }
    }

    const summary = await getUsageSummary(user.userId)
    return { status: "ok", ...summary }
  })

  fastify.post("/billing/checkout", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = extractUser(request)
    if (!user) return reply.code(401).send({ error: "Not authenticated" })

    const { priceId } = (request.body || {}) as { priceId?: string }
    if (!priceId) return reply.code(400).send({ error: "priceId is required" })

    const plan = PRICE_TO_PLAN[priceId]
    if (!plan) return reply.code(400).send({ error: "Invalid price ID" })

    const sub = await getSubscription(user.userId)
    let customerId = sub.stripe_customer_id as string | null

    if (!customerId) {
      const userRow = await query("SELECT username FROM users WHERE id = $1", [user.userId])
      const customer = await stripe.customers.create({
        metadata: { userId: String(user.userId), username: userRow.rows[0].username }
      })
      customerId = customer.id
      await query("UPDATE subscriptions SET stripe_customer_id = $1 WHERE user_id = $2", [customerId, user.userId])
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.STRIPE_SUCCESS_URL || "http://localhost:3000/billing/success"}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.STRIPE_CANCEL_URL || "http://localhost:3000/billing/cancel"}`,
      metadata: { userId: String(user.userId), plan }
    })

    return { status: "ok", url: session.url, sessionId: session.id }
  })

  fastify.post("/billing/webhook", async (request: FastifyRequest, reply: FastifyReply) => {
    const sig = request.headers["stripe-signature"] as string
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || ""

    let event: Stripe.Event
    try {
      const rawBody = (request as unknown as { rawBody?: string }).rawBody || JSON.stringify(request.body)
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret)
    } catch (err) {
      console.error("[stripe] Webhook signature verification failed:", (err as Error).message)
      return reply.code(400).send({ error: "Invalid signature" })
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session
        const userId = session.metadata?.userId
        const plan = session.metadata?.plan
        if (userId && plan && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription as string)
          await updateSubscriptionFromStripe(userId, {
            plan,
            stripeCustomerId: session.customer as string,
            stripeSubscriptionId: session.subscription as string,
            periodStart: stripeDate(subscription.current_period_start as number).toISOString(),
            periodEnd: stripeDate(subscription.current_period_end as number).toISOString(),
            status: "active"
          })
          console.log(`[stripe] User ${userId} subscribed to ${plan}`)
        }
        break
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice
        const subId = invoice.subscription as string | null
        if (subId) {
          const subRow = await query(
            "SELECT user_id, plan FROM subscriptions WHERE stripe_subscription_id = $1",
            [subId]
          )
          if (subRow.rowCount! > 0) {
            const { user_id, plan } = subRow.rows[0]
            const planDef = PLANS[plan]
            if (planDef) {
              const subscription = await stripe.subscriptions.retrieve(subId)
              await query(
                `UPDATE subscriptions SET
                   credits_used_cents = 0,
                   credits_cents = $1,
                   period_start = $2,
                   period_end = $3,
                   updated_at = NOW()
                 WHERE stripe_subscription_id = $4`,
                [
                  planDef.creditsCents,
                  stripeDate(subscription.current_period_start as number),
                  stripeDate(subscription.current_period_end as number),
                  subId
                ]
              )
              console.log(`[stripe] Renewed credits for user ${user_id} on ${plan} plan`)
            }
          }
        }
        break
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription
        const subRow = await query(
          "SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1",
          [sub.id]
        )
        if (subRow.rowCount! > 0) {
          await query(
            `UPDATE subscriptions SET plan = 'free', credits_cents = 0, credits_used_cents = 0,
             stripe_subscription_id = NULL, status = 'cancelled', updated_at = NOW()
             WHERE stripe_subscription_id = $1`,
            [sub.id]
          )
          console.log(`[stripe] Subscription cancelled for user ${subRow.rows[0].user_id}`)
        }
        break
      }

      default:
        break
    }

    return { received: true }
  })

  fastify.get("/billing/checkout-stream", { logLevel: "warn" }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = request.query as { sessionId?: string }
    if (!sessionId) return reply.code(400).send({ error: "sessionId required" })

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    })

    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n")
    }, 15000)

    onCheckoutComplete(sessionId, (result) => {
      clearInterval(heartbeat)
      reply.raw.write(`data: ${JSON.stringify(result)}\n\n`)
      reply.raw.end()
    })

    request.raw.on("close", () => {
      clearInterval(heartbeat)
      removeCheckoutListener(sessionId)
    })
  })

  fastify.get("/billing/success", async (request: FastifyRequest) => {
    const sessionId = (request.query as Record<string, string>).session_id
    if (sessionId) {
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId)
        const userId = session.metadata?.userId
        const plan = session.metadata?.plan

        if (userId && plan && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription as string)
          await updateSubscriptionFromStripe(userId, {
            plan,
            stripeCustomerId: session.customer as string,
            stripeSubscriptionId: session.subscription as string,
            periodStart: stripeDate(subscription.current_period_start as number).toISOString(),
            periodEnd: stripeDate(subscription.current_period_end as number).toISOString(),
            status: "active"
          })
          console.log(`[stripe] Success page: activated ${plan} for user ${userId}`)

          emitCheckoutComplete(sessionId, { status: "paid", plan })
        }
      } catch (err) {
        console.error("[stripe] Success page fulfillment error:", (err as Error).message)
      }
    }

    return { status: "ok", message: "Subscription activated! You can close this page and return to the terminal." }
  })

  fastify.get("/billing/cancel", async () => {
    return { status: "ok", message: "Checkout cancelled. No charges were made." }
  })
}
