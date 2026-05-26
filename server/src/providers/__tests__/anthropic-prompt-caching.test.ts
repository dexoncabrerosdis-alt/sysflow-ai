/**
 * Plan `2026-05-18-reasoning-speed-and-rate-limit-overhaul.md`
 * Stages 4 (2026-05-20), 5 (2026-05-21), and 5b (2026-05-26).
 *
 * Pins the Anthropic prompt-caching contract.
 *
 * Stage 4: system field is a cacheable content-block array.
 * Stage 5: messages[0] also gets a cache_control marker.
 * Stage 5b: system splits into stable + dynamic (cache only the stable
 * half); messages[last] gets a 3rd cache_control marker for rolling
 * conversation cache.
 *
 * `buildSystemForRequest` and `buildMessagesForRequest` are pure
 * helpers that don't need the full provider stack; this suite tests
 * them directly. The actual fetch + caching behavior is verified
 * manually against Anthropic by inspecting `cache_read_input_tokens`
 * on response usage.
 */

import { describe, it, expect } from "vitest"
import { buildSystemForRequest, buildMessagesForRequest } from "../anthropic.js"

describe("buildSystemForRequest — caching disabled", () => {
  it("returns the concatenated full text when cachingEnabled=false", () => {
    const result = buildSystemForRequest({ cacheable: "stable", dynamic: "dynamic" }, false)
    expect(result).toBe("stable\n\ndynamic")
  })

  it("returns just cacheable when no dynamic suffix", () => {
    const result = buildSystemForRequest({ cacheable: "only stable", dynamic: "" }, false)
    expect(result).toBe("only stable")
  })

  it("returns empty string when both parts are empty", () => {
    expect(buildSystemForRequest({ cacheable: "", dynamic: "" }, true)).toBe("")
    expect(buildSystemForRequest({ cacheable: "", dynamic: "" }, false)).toBe("")
  })
})

describe("buildSystemForRequest — caching enabled (Stage 5b stable/dynamic split)", () => {
  it("when both halves are present: returns TWO blocks; cache_control on the CACHEABLE block only", () => {
    const result = buildSystemForRequest(
      { cacheable: "stable system instructions", dynamic: "per-turn reasoning briefs" },
      true,
    ) as Array<{ type: string; text: string; cache_control?: { type: string } }>
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(2)
    // Block 0: cacheable prefix WITH marker
    expect(result[0].type).toBe("text")
    expect(result[0].text).toBe("stable system instructions")
    expect(result[0].cache_control).toEqual({ type: "ephemeral" })
    // Block 1: dynamic suffix WITHOUT marker
    expect(result[1].type).toBe("text")
    expect(result[1].text).toBe("per-turn reasoning briefs")
    expect(result[1].cache_control).toBeUndefined()
  })

  it("when only cacheable is present: returns single-block array with marker", () => {
    const result = buildSystemForRequest(
      { cacheable: "stable only", dynamic: "" },
      true,
    ) as Array<{ type: string; text: string; cache_control?: { type: string } }>
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe("stable only")
    expect(result[0].cache_control).toEqual({ type: "ephemeral" })
  })

  it("when only dynamic is present (no cacheable): returns the dynamic string verbatim (no caching possible)", () => {
    // Edge case: all sections classified non-cacheable. Nothing to
    // cache — fall through to the unwrapped string so the request
    // still goes out with a system field.
    const result = buildSystemForRequest({ cacheable: "", dynamic: "all dynamic" }, true)
    expect(result).toBe("all dynamic")
  })

  it("preserves the FULL text of both halves (no truncation)", () => {
    const cacheable = "x".repeat(20_000)
    const dynamic = "y".repeat(10_000)
    const result = buildSystemForRequest({ cacheable, dynamic }, true) as Array<{ text: string }>
    expect(result[0].text).toHaveLength(20_000)
    expect(result[1].text).toHaveLength(10_000)
  })

  it("returned cacheable block shape matches Anthropic's documented schema", () => {
    const result = buildSystemForRequest(
      { cacheable: "x", dynamic: "y" },
      true,
    ) as Array<Record<string, unknown>>
    expect(Object.keys(result[0]).sort()).toEqual(["cache_control", "text", "type"])
  })

  it("dynamic block has NO cache_control key (not just undefined — actually absent)", () => {
    // Pins that a future regression that adds cache_control: undefined
    // to the dynamic block still passes a structural check. The block
    // should be a clean {type, text} pair.
    const result = buildSystemForRequest(
      { cacheable: "x", dynamic: "y" },
      true,
    ) as Array<Record<string, unknown>>
    expect(Object.keys(result[1]).sort()).toEqual(["text", "type"])
  })
})

describe("buildSystemForRequest — feature-flag-off escape hatch", () => {
  it("operators can disable caching at runtime; output reverts to a single concatenated string", () => {
    const parts = { cacheable: "the instructions", dynamic: "briefs go here" }
    const off = buildSystemForRequest(parts, false)
    const on = buildSystemForRequest(parts, true) as Array<{ text: string }>
    expect(off).toBe("the instructions\n\nbriefs go here")
    expect(on[0].text).toBe("the instructions")
    expect(on[1].text).toBe("briefs go here")
  })
})

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

describe("buildMessagesForRequest — Stage 5 (messages[0]) + Stage 5b (messages[last])", () => {
  it("multi-turn: BOTH messages[0] AND messages[last] get cache_control markers; middle messages stay string", () => {
    const history = [
      { role: "user" as const, content: "initial" },
      { role: "assistant" as const, content: "response 1" },
      { role: "user" as const, content: "tool result 1" },
      { role: "assistant" as const, content: "response 2" },
      { role: "user" as const, content: "tool result 2" },
    ]
    const result = buildMessagesForRequest(history, true)
    // messages[0] cached
    expect(Array.isArray(result[0].content)).toBe(true)
    expect((result[0].content as Array<{ cache_control?: unknown }>)[0].cache_control).toBeTruthy()
    // middle messages stay string
    expect(typeof result[1].content).toBe("string")
    expect(typeof result[2].content).toBe("string")
    expect(typeof result[3].content).toBe("string")
    // messages[last] cached (Stage 5b — rolling conversation cache)
    expect(Array.isArray(result[4].content)).toBe(true)
    expect((result[4].content as Array<{ cache_control?: unknown }>)[0].cache_control).toBeTruthy()
  })

  it("single-turn (history.length === 1): one marker only (messages[0] === messages[last])", () => {
    const history = [{ role: "user" as const, content: "initial prompt only" }]
    const result = buildMessagesForRequest(history, true)
    expect(Array.isArray(result[0].content)).toBe(true)
    const blocks = result[0].content as Array<{ cache_control?: unknown }>
    expect(blocks).toHaveLength(1)
    expect(blocks[0].cache_control).toBeTruthy()
  })

  it("two-turn: marker on messages[0] and on messages[1] (the new turn)", () => {
    // Most common steady-state shape for sysflow: initial + tool_result.
    const history = [
      { role: "user" as const, content: "initial" },
      { role: "user" as const, content: "tool_result" },
    ]
    const result = buildMessagesForRequest(history, true)
    expect(Array.isArray(result[0].content)).toBe(true)
    expect(Array.isArray(result[1].content)).toBe(true)
  })

  it("does NOT mutate the input history (returns a new array)", () => {
    const original = [
      { role: "user" as const, content: "initial" },
      { role: "assistant" as const, content: "response" },
      { role: "user" as const, content: "follow-up" },
    ]
    const result = buildMessagesForRequest(original, true)
    expect(typeof original[0].content).toBe("string")
    expect(typeof original[1].content).toBe("string")
    expect(typeof original[2].content).toBe("string")
    expect(Array.isArray(result[0].content)).toBe(true)
    expect(typeof result[1].content).toBe("string")
    expect(Array.isArray(result[2].content)).toBe(true)
  })

  it("empty-string content on messages[0] or messages[last] is NOT wrapped (defensive)", () => {
    const history = [
      { role: "user" as const, content: "" },
      { role: "assistant" as const, content: "response" },
      { role: "user" as const, content: "" },
    ]
    const result = buildMessagesForRequest(history, true)
    // Both endpoint messages have empty content → stay as string
    expect(result[0].content).toBe("")
    expect(result[2].content).toBe("")
  })

  it("breakpoint count never exceeds Anthropic's max of 4 per request (1 system + max 2 here = 3 total)", () => {
    // Sanity guard against a future refactor adding more markers.
    const history = [
      { role: "user" as const, content: "msg0" },
      { role: "assistant" as const, content: "a1" },
      { role: "user" as const, content: "msg2" },
      { role: "assistant" as const, content: "a3" },
      { role: "user" as const, content: "msg4" },
    ]
    const result = buildMessagesForRequest(history, true)
    let markers = 0
    for (const m of result) {
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.cache_control) markers++
        }
      }
    }
    expect(markers).toBe(2) // messages[0] + messages[last]
  })
})
