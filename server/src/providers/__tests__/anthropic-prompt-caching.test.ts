/**
 * Plan `2026-05-18-reasoning-speed-and-rate-limit-overhaul.md` Stage 4
 * (2026-05-20). Pins the Anthropic prompt-caching contract.
 *
 * The change in `anthropic.ts`:
 *
 *   - When `provider.anthropic_prompt_caching_enabled` is on (default),
 *     the `system` field in the request body is built as a structured
 *     content-block array with a `cache_control: { type: "ephemeral" }`
 *     marker on the final block.
 *   - When the flag is off (or the system prompt is empty), the legacy
 *     string-form `system` is sent as-is.
 *
 * Testing the full provider requires mocking `fetch` + the run-state
 * machinery. The pure helper `buildSystemForRequest` is what the
 * provider calls; this suite pins it directly.
 */

import { describe, it, expect } from "vitest"
import { buildSystemForRequest, buildMessagesForRequest } from "../anthropic.js"

describe("buildSystemForRequest — caching disabled (legacy string-form)", () => {
  it("returns the string verbatim when cachingEnabled=false", () => {
    const prompt = "You are a coding agent. Follow these rules..."
    const result = buildSystemForRequest(prompt, false)
    expect(result).toBe(prompt)
  })

  it("returns empty string verbatim (no caching for empty prompts)", () => {
    expect(buildSystemForRequest("", true)).toBe("")
    expect(buildSystemForRequest("", false)).toBe("")
  })
})

describe("buildSystemForRequest — caching enabled (content-block array)", () => {
  it("converts a non-empty string into a single-block array with cache_control on the last (only) block", () => {
    const prompt = "You are a coding agent. Long system prompt with project memory + reasoning briefs..."
    const result = buildSystemForRequest(prompt, true) as Array<{ type: string; text: string; cache_control?: { type: string } }>
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("text")
    expect(result[0].text).toBe(prompt)
    expect(result[0].cache_control).toEqual({ type: "ephemeral" })
  })

  it("preserves the FULL prompt text inside the cached block (no truncation)", () => {
    // The system prompt can be 5k-20k tokens long. We must not slice
    // or summarize it — Anthropic caches the verbatim block content.
    const prompt = "x".repeat(50_000)
    const result = buildSystemForRequest(prompt, true) as Array<{ text: string }>
    expect(result[0].text).toHaveLength(50_000)
  })

  it("marker is on the LAST cacheable block (Anthropic caches the prefix up to and including the marker)", () => {
    // Today the helper produces ONE block, so the last block == the
    // only block. This test pins the invariant for future refactors
    // that might split the system into multiple cacheable segments
    // (e.g. static-instructions block + dynamic-briefs block).
    const prompt = "stable instructions + dynamic briefs"
    const result = buildSystemForRequest(prompt, true) as Array<{ cache_control?: unknown }>
    const lastBlock = result[result.length - 1]
    expect(lastBlock.cache_control).toBeTruthy()
  })

  it("returned shape matches Anthropic's documented content-block schema", () => {
    const prompt = "test"
    const result = buildSystemForRequest(prompt, true) as Array<Record<string, unknown>>
    // Per https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching:
    //   { type: "text", text: "...", cache_control: { type: "ephemeral" } }
    expect(Object.keys(result[0]).sort()).toEqual(["cache_control", "text", "type"])
  })
})

describe("buildSystemForRequest — feature-flag-off escape hatch", () => {
  it("operators can disable caching at runtime (the provider reads the flag each call)", () => {
    // The actual flag-read happens inside anthropic.ts's provider
    // call — this pins that the disabled path is non-destructive
    // (just returns the original string). If a regression in
    // Anthropic's caching beta breaks responses, operators flip the
    // flag and the provider reverts to the legacy string-form.
    const prompt = "the instructions"
    const off = buildSystemForRequest(prompt, false)
    const on = buildSystemForRequest(prompt, true) as Array<{ text: string }>
    expect(off).toBe(prompt)
    expect(on[0].text).toBe(prompt)
  })
})

// Stage 5 of speed-overhaul plan (2026-05-21).
describe("buildMessagesForRequest — caching disabled (legacy string-content)", () => {
  it("returns messages with string content verbatim when cachingEnabled=false", () => {
    const history = [
      { role: "user" as const, content: "initial prompt + project context" },
      { role: "assistant" as const, content: "ack" },
      { role: "user" as const, content: "tool result 1" },
    ]
    const result = buildMessagesForRequest(history, false)
    expect(result).toHaveLength(3)
    expect(result[0].content).toBe("initial prompt + project context")
    expect(result[1].content).toBe("ack")
    expect(result[2].content).toBe("tool result 1")
  })

  it("returns empty array on empty history", () => {
    expect(buildMessagesForRequest([], true)).toEqual([])
    expect(buildMessagesForRequest([], false)).toEqual([])
  })
})

describe("buildMessagesForRequest — caching enabled (messages[0] gets a cache marker)", () => {
  it("converts messages[0].content to a single-block cacheable array", () => {
    const history = [
      { role: "user" as const, content: "initial prompt + project context" },
      { role: "assistant" as const, content: "ack" },
    ]
    const result = buildMessagesForRequest(history, true)
    expect(Array.isArray(result[0].content)).toBe(true)
    const blocks = result[0].content as Array<{ type: string; text: string; cache_control?: { type: string } }>
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe("text")
    expect(blocks[0].text).toBe("initial prompt + project context")
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" })
  })

  it("only messages[0] gets cached; subsequent messages keep string content", () => {
    // Assistant responses + tool results vary turn-to-turn; caching
    // them is wasteful (cache miss every call). Only the stable
    // first message benefits from caching.
    const history = [
      { role: "user" as const, content: "initial" },
      { role: "assistant" as const, content: "response 1" },
      { role: "user" as const, content: "tool result 1" },
      { role: "assistant" as const, content: "response 2" },
      { role: "user" as const, content: "tool result 2" },
    ]
    const result = buildMessagesForRequest(history, true)
    expect(Array.isArray(result[0].content)).toBe(true)
    expect(typeof result[1].content).toBe("string")
    expect(typeof result[2].content).toBe("string")
    expect(typeof result[3].content).toBe("string")
    expect(typeof result[4].content).toBe("string")
  })

  it("does NOT mutate the input history (returns a new array)", () => {
    const original = [
      { role: "user" as const, content: "initial" },
    ]
    const result = buildMessagesForRequest(original, true)
    // Input should be unchanged.
    expect(typeof original[0].content).toBe("string")
    expect(original[0].content).toBe("initial")
    // Output should have the cached shape.
    expect(Array.isArray(result[0].content)).toBe(true)
  })

  it("empty-string content on messages[0] is NOT wrapped (defensive — no point caching empty)", () => {
    // The provider always builds a non-empty initial user message,
    // but guard defensively against the empty case.
    const history = [
      { role: "user" as const, content: "" },
    ]
    const result = buildMessagesForRequest(history, true)
    expect(result[0].content).toBe("")
  })

  it("single-turn history (just messages[0]) still gets the marker (creates cache for future turns)", () => {
    const history = [
      { role: "user" as const, content: "initial prompt only" },
    ]
    const result = buildMessagesForRequest(history, true)
    expect(Array.isArray(result[0].content)).toBe(true)
    const blocks = result[0].content as Array<{ cache_control?: unknown }>
    expect(blocks[0].cache_control).toBeTruthy()
  })
})
