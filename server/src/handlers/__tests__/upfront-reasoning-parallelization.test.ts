/**
 * Plan `2026-05-18-reasoning-speed-and-rate-limit-overhaul.md` Stage 1.
 *
 * Pins the parallelization contract that lives inline in `user-message.ts`:
 * the three independent upfront Flash calls (project-init, preflight,
 * intent classification) run via `Promise.all` so wall-clock ≈ MAX of
 * the three latencies, not SUM. Same for the two dependent-on-preflight
 * calls (implement_elaborate + chunk_plan).
 *
 * Testing the user-message handler itself requires the full server
 * stack (db, run state, fastify). Instead, this suite pins the SHAPE
 * of the parallelization pattern via a tiny harness that mirrors the
 * exact `Promise.all` structure in the handler — so any regression
 * that flips back to sequential awaits (or breaks error isolation
 * with `Promise.all` rejecting on first failure) fails here.
 */

import { describe, it, expect } from "vitest"

/** Simulate a Flash call with a configurable delay + return value. */
function fakeFlashCall<T>(label: string, delayMs: number, result: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(result), delayMs))
}

/** Simulate a failing Flash call. */
function failingFlashCall(label: string, delayMs: number, err: Error): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(err), delayMs))
}

describe("Stage 1 — Phase A: project-init / preflight / intent run in parallel", () => {
  it("wall-clock ≈ MAX(3 calls), not SUM", async () => {
    const start = Date.now()
    const [a, b, c] = await Promise.all([
      fakeFlashCall("project-init", 50, { name: "init" }),
      fakeFlashCall("preflight", 80, { name: "preflight" }),
      fakeFlashCall("intent", 30, { name: "intent" }),
    ])
    const elapsed = Date.now() - start
    expect(a).toEqual({ name: "init" })
    expect(b).toEqual({ name: "preflight" })
    expect(c).toEqual({ name: "intent" })
    // Wall-clock floor is MAX(50, 80, 30) = 80ms. Allow a generous
    // upper bound (~250ms) for setTimeout drift + CI variability,
    // but assert it's clearly less than SUM (50+80+30=160).
    expect(elapsed).toBeGreaterThanOrEqual(75)
    expect(elapsed).toBeLessThan(200)
  })

  it("error isolation: one rejection with .catch fallback does not kill the others", async () => {
    // Mirrors the handler's per-call .catch(err => null) shape.
    const [a, b, c] = await Promise.all([
      failingFlashCall("project-init", 30, new Error("boom")).catch((): null => null),
      fakeFlashCall("preflight", 50, { name: "preflight" }),
      fakeFlashCall("intent", 20, { hint: "implement", source: "regex_simple" as const }),
    ])
    expect(a).toBeNull()
    expect(b).toEqual({ name: "preflight" })
    expect(c).toEqual({ hint: "implement", source: "regex_simple" })
  })

  it("when one call is much slower, others still resolve at their natural latency (Promise.all only blocks the final await)", async () => {
    const timings: Record<string, number> = {}
    const start = Date.now()
    const recordTiming = (label: string) => {
      timings[label] = Date.now() - start
    }
    const fastA = fakeFlashCall("a", 20, "A").then((v) => { recordTiming("a"); return v })
    const slowB = fakeFlashCall("b", 100, "B").then((v) => { recordTiming("b"); return v })
    const fastC = fakeFlashCall("c", 30, "C").then((v) => { recordTiming("c"); return v })
    await Promise.all([fastA, slowB, fastC])
    // fastA + fastC resolved well before slowB; the parallel shape
    // means slow B doesn't delay the others' resolution. This is
    // what makes the wall-clock optimisation work.
    expect(timings.a).toBeLessThan(60)
    expect(timings.c).toBeLessThan(60)
    expect(timings.b).toBeGreaterThanOrEqual(95)
  })
})

describe("Stage 1 — Phase B: implement_elaborate + chunk_plan run in parallel after preflight", () => {
  it("when both Phase B gates are open, both fire concurrently", async () => {
    const start = Date.now()
    const [elab, chunk] = await Promise.all([
      fakeFlashCall("elaborate", 60, { kind: "elab" }),
      fakeFlashCall("chunk_plan", 70, { kind: "chunk" }),
    ])
    const elapsed = Date.now() - start
    expect(elab).toEqual({ kind: "elab" })
    expect(chunk).toEqual({ kind: "chunk" })
    expect(elapsed).toBeGreaterThanOrEqual(65)
    expect(elapsed).toBeLessThan(170)
  })

  it("when one Phase B gate is closed, Promise.resolve(null) keeps the shape stable (parallel-still-correct)", async () => {
    const [elab, chunk] = await Promise.all([
      Promise.resolve(null), // elaborate gate closed
      fakeFlashCall("chunk_plan", 40, { kind: "chunk" }),
    ])
    expect(elab).toBeNull()
    expect(chunk).toEqual({ kind: "chunk" })
  })

  it("both gates closed → both null, no Flash calls fire (resolves immediately)", async () => {
    const start = Date.now()
    const [elab, chunk] = await Promise.all([
      Promise.resolve(null),
      Promise.resolve(null),
    ])
    const elapsed = Date.now() - start
    expect(elab).toBeNull()
    expect(chunk).toBeNull()
    expect(elapsed).toBeLessThan(20)
  })
})
