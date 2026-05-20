/**
 * Plan `2026-05-18-reasoning-speed-and-rate-limit-overhaul.md` Stage 2.
 *
 * Pins the skip-when-simple gate's contract via the regex classifier
 * it consults. The gate in `user-message.ts` reads
 * `classifyIntent(body.content)` synchronously; when the regex returns
 * "simple", ALL upfront Flash calls (project-init, preflight, intent
 * chain) are bypassed and the agent goes straight to the main model.
 *
 * Testing the full handler requires the server stack (db, fastify,
 * fixtures). Instead, this suite pins:
 *
 *   1. The set of inputs the gate WILL skip on (simple intents)
 *   2. The set of inputs the gate WILL NOT skip on (everything else)
 *   3. The integration shape: regex output drives the gate boolean
 *
 * If someone adds a new SIMPLE_PATTERNS regex or a new BUG_PATTERNS
 * regex and accidentally inverts a case, this test catches it.
 */

import { describe, it, expect } from "vitest"
import { classifyIntent, type IntentHint } from "../../reasoning/intent-classifier.js"

/** Mirror of the gate's predicate. Pure for tests. */
function shouldSkipUpfrontReasoning(userMessage: string): boolean {
  return classifyIntent(userMessage) === "simple"
}

describe("Stage 2 — skip-when-simple gate: prompts that should bypass all upfront Flash", () => {
  it("bare shell-style listing requests classify as simple → skip", () => {
    expect(shouldSkipUpfrontReasoning("ls")).toBe(true)
    expect(shouldSkipUpfrontReasoning("pwd")).toBe(true)
    expect(shouldSkipUpfrontReasoning("ls -la")).toBe(true)
  })

  it("continuation phrases classify as simple → skip", () => {
    expect(shouldSkipUpfrontReasoning("continue")).toBe(true)
    expect(shouldSkipUpfrontReasoning("go on")).toBe(true)
  })

  it("listing / display requests classify as simple → skip", () => {
    expect(shouldSkipUpfrontReasoning("list files")).toBe(true)
    expect(shouldSkipUpfrontReasoning("show me the content of package.json")).toBe(true)
  })

  it("empty prompt defaults to simple → skip (defensive)", () => {
    expect(shouldSkipUpfrontReasoning("")).toBe(true)
    expect(shouldSkipUpfrontReasoning("   ")).toBe(true)
  })
})

describe("Stage 2 — skip-when-simple gate: prompts that MUST run the full upfront pipeline", () => {
  it("implement-class prompts do NOT skip", () => {
    expect(shouldSkipUpfrontReasoning("build a POS backend with Express + Postgres")).toBe(false)
    expect(shouldSkipUpfrontReasoning("add a /health endpoint to this Express app")).toBe(false)
    expect(shouldSkipUpfrontReasoning("create a new react component for the dashboard")).toBe(false)
  })

  it("bug-class prompts do NOT skip — they need the bug pipeline", () => {
    expect(shouldSkipUpfrontReasoning("fix the TypeError in src/index.ts")).toBe(false)
    expect(shouldSkipUpfrontReasoning("the build is failing with module not found")).toBe(false)
  })

  it("summary-class prompts do NOT skip — they go through the summary pipeline", () => {
    expect(shouldSkipUpfrontReasoning("explain what this codebase does")).toBe(false)
    expect(shouldSkipUpfrontReasoning("walk me through the auth flow")).toBe(false)
  })

  it("user-repro scaffold prompts do NOT skip", () => {
    expect(shouldSkipUpfrontReasoning("build a POS backend with Express + Postgres")).toBe(false)
    expect(shouldSkipUpfrontReasoning("scaffold a Vite + React + Tailwind app called dashboard")).toBe(false)
  })
})

describe("Stage 2 — gate predicate matches the regex classifier exactly", () => {
  // Sanity: the gate IS just the regex's "simple" verdict. Any future
  // tightening of SIMPLE_PATTERNS automatically tightens the gate; any
  // loosening automatically loosens it. No second source of truth.
  it("the gate boolean equals (classifyIntent(msg) === 'simple') for every IntentHint value", () => {
    const cases: Array<{ msg: string; expected: IntentHint }> = [
      { msg: "ls", expected: "simple" },
      { msg: "continue", expected: "simple" },
      { msg: "build a small Express app", expected: "implement" },
      { msg: "fix the error", expected: "bug" },
      { msg: "tldr: what is this", expected: "summary" },
    ]
    for (const { msg, expected } of cases) {
      const actualIntent = classifyIntent(msg)
      expect(actualIntent).toBe(expected)
      expect(shouldSkipUpfrontReasoning(msg)).toBe(actualIntent === "simple")
    }
  })
})
