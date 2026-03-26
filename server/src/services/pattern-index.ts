import fs from "node:fs/promises"
import path from "node:path"

// ─── Types ───

interface PatternEntry {
  file: string
  dir: string
  content: string
  tokens: string[]
}

interface PatternIndex {
  builtAt: string
  root: string
  entries: PatternEntry[]
  /** token → entry indices */
  byToken: Map<string, number[]>
}

// ─── Singleton cache per project root ───

const indexCache = new Map<string, PatternIndex>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const cacheTimestamps = new Map<string, number>()

// ─── Build index ───

async function buildPatternIndex(cwd: string): Promise<PatternIndex | null> {
  const sysbaseDir = path.join(cwd, "sysbase")

  try {
    const stat = await fs.stat(sysbaseDir)
    if (!stat.isDirectory()) return null
  } catch {
    return null
  }

  const entries: PatternEntry[] = []
  const dirs = ["architecture", "patterns", "conventions", "stack", "status", "decisions", "fixes"]

  for (const dir of dirs) {
    const dirPath = path.join(sysbaseDir, dir)
    let files: string[]
    try {
      files = (await fs.readdir(dirPath)).filter((f) => f.endsWith(".md"))
    } catch {
      continue
    }

    for (const file of files) {
      try {
        const content = await fs.readFile(path.join(dirPath, file), "utf8")
        const tokens = tokenize(content)
        entries.push({ file: `${dir}/${file}`, dir, content, tokens })
      } catch {
        continue
      }
    }
  }

  if (entries.length === 0) return null

  // Build inverted token index
  const byToken = new Map<string, number[]>()
  for (let i = 0; i < entries.length; i++) {
    for (const token of entries[i].tokens) {
      if (!byToken.has(token)) byToken.set(token, [])
      byToken.get(token)!.push(i)
    }
  }

  return {
    builtAt: new Date().toISOString(),
    root: cwd,
    entries,
    byToken
  }
}

// ─── Query index ───

export interface PatternMatch {
  file: string
  dir: string
  content: string
  score: number
}

export function queryPatternIndex(index: PatternIndex, prompt: string, limit: number = 8): PatternMatch[] {
  const queryTokens = tokenize(prompt)
  const scores = new Map<number, number>()

  for (const token of queryTokens) {
    const indices = index.byToken.get(token)
    if (indices) {
      for (const idx of indices) {
        scores.set(idx, (scores.get(idx) || 0) + 1)
      }
    }
  }

  // Always include architecture/overview.md and status/current.md
  for (let i = 0; i < index.entries.length; i++) {
    const entry = index.entries[i]
    if (entry.file === "architecture/overview.md" || entry.file === "status/current.md") {
      scores.set(i, (scores.get(i) || 0) + 10) // boost essential files
    }
  }

  return Array.from(scores.entries())
    .map(([idx, score]) => ({
      file: index.entries[idx].file,
      dir: index.entries[idx].dir,
      content: index.entries[idx].content,
      score
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

// ─── Public API ───

export async function getPatternIndex(cwd: string): Promise<PatternIndex | null> {
  const now = Date.now()
  const cached = indexCache.get(cwd)
  const timestamp = cacheTimestamps.get(cwd) || 0

  if (cached && now - timestamp < CACHE_TTL_MS) {
    return cached
  }

  const index = await buildPatternIndex(cwd)
  if (index) {
    indexCache.set(cwd, index)
    cacheTimestamps.set(cwd, now)
  }

  return index
}

export async function getRelevantPatterns(cwd: string, prompt: string, limit?: number): Promise<PatternMatch[]> {
  const index = await getPatternIndex(cwd)
  if (!index) return []
  return queryPatternIndex(index, prompt, limit)
}

/** Force rebuild the index (after sysbase knowledge files change) */
export function invalidatePatternIndex(cwd: string): void {
  indexCache.delete(cwd)
  cacheTimestamps.delete(cwd)
}

// ─── Utilities ───

function tokenize(text: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "to", "of", "in", "for", "on", "with",
    "at", "by", "from", "as", "and", "or", "but", "not", "this", "that",
    "it", "be", "has", "have", "was", "were", "will", "can", "do", "does"
  ])

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !stopWords.has(t))
    .filter((t, i, arr) => arr.indexOf(t) === i) // dedupe
}
