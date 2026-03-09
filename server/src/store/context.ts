import { query } from "../db/connection.js"

interface SaveContextParams {
  projectId: string
  userId?: string | null
  category?: string
  title: string
  content: string
  tags?: string[]
}

interface ContextEntry {
  id: number
  category: string
  title: string
  content: string
  tags: string[]
  created_at: string
}

interface QueryContextOpts {
  category?: string
  tags?: string[]
  limit?: number
}

export async function saveContext({ projectId, userId, category, title, content, tags }: SaveContextParams): Promise<{ id: number; title: string; category: string }> {
  const res = await query(
    `INSERT INTO context_entries (project_id, user_id, category, title, content, tags)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, category`,
    [projectId, userId || null, category || "general", title, content, tags || []]
  )
  return res.rows[0]
}

export async function queryContext(projectId: string, opts: QueryContextOpts = {}): Promise<ContextEntry[]> {
  const { category, tags, limit = 10 } = opts

  let sql = `SELECT id, category, title, content, tags, created_at
             FROM context_entries WHERE project_id = $1`
  const params: unknown[] = [projectId]
  let paramIdx = 2

  if (category) {
    sql += ` AND category = $${paramIdx}`
    params.push(category)
    paramIdx++
  }

  if (tags && tags.length > 0) {
    sql += ` AND tags && $${paramIdx}`
    params.push(tags)
    paramIdx++
  }

  sql += ` ORDER BY updated_at DESC LIMIT $${paramIdx}`
  params.push(limit)

  const res = await query(sql, params)
  return res.rows
}

export async function getAllContext(projectId: string): Promise<ContextEntry[]> {
  const res = await query(
    `SELECT id, category, title, content, tags, created_at
     FROM context_entries WHERE project_id = $1
     ORDER BY updated_at DESC LIMIT 20`,
    [projectId]
  )
  return res.rows
}

export async function buildContextForPrompt(projectId: string, userPrompt: string): Promise<string | null> {
  const keywords = extractKeywords(userPrompt)

  const patterns = await queryContext(projectId, { category: "pattern", limit: 5 })
  const preferences = await queryContext(projectId, { category: "preference", limit: 3 })

  let fixes: ContextEntry[] = []
  let memories: ContextEntry[] = []

  if (keywords.length > 0) {
    fixes = await queryContext(projectId, { category: "fix", tags: keywords, limit: 5 })
    memories = await queryContext(projectId, { category: "memory", tags: keywords, limit: 5 })
  }

  if (fixes.length === 0) {
    fixes = await queryContext(projectId, { category: "fix", limit: 3 })
  }
  if (memories.length === 0) {
    memories = await queryContext(projectId, { category: "memory", limit: 3 })
  }

  const all = [...patterns, ...preferences, ...fixes, ...memories]
  if (all.length === 0) return null

  const seen = new Set<number>()
  const unique = all.filter((e) => {
    if (seen.has(e.id)) return false
    seen.add(e.id)
    return true
  })

  const lines = ["Project context and learned patterns:"]
  for (const entry of unique) {
    lines.push(`[${entry.category}] ${entry.title}: ${entry.content.slice(0, 200)}`)
  }

  return lines.join("\n")
}

function extractKeywords(prompt: string): string[] {
  if (!prompt) return []

  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "to", "of", "in", "for",
    "on", "with", "at", "by", "from", "as", "into", "about", "like",
    "through", "after", "before", "between", "under", "above", "up",
    "down", "out", "off", "over", "again", "further", "then", "once",
    "here", "there", "when", "where", "why", "how", "all", "each",
    "every", "both", "few", "more", "most", "other", "some", "such",
    "no", "not", "only", "own", "same", "so", "than", "too", "very",
    "just", "because", "but", "and", "or", "if", "while", "that", "this",
    "it", "its", "i", "me", "my", "we", "our", "you", "your", "he",
    "she", "they", "them", "what", "which", "who", "whom", "make",
    "add", "create", "build", "fix", "update", "change", "modify",
    "implement", "write", "test", "run", "check", "use", "using",
    "please", "want", "need"
  ])

  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 10)
}
