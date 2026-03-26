import fs from "node:fs/promises"
import path from "node:path"
import { getProjectMemories } from "../store/memory.js"
import { getToolResults } from "../store/tool-results.js"
import { getRelevantPatterns } from "./pattern-index.js"

// ─── Fix files loader ───

async function loadFixFiles(sysbasePath: string | undefined): Promise<string | null> {
  if (!sysbasePath) return null
  try {
    const fixesDir = path.join(sysbasePath, "fixes")
    const files = await fs.readdir(fixesDir).catch(() => [] as string[])
    if (files.length === 0) return null

    const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse().slice(0, 10)
    if (mdFiles.length === 0) return null

    const entries: string[] = []
    for (const file of mdFiles) {
      const content = await fs.readFile(path.join(fixesDir, file), "utf8")
      entries.push(content.trim())
    }

    return "PAST FIXES AND LESSONS (do NOT repeat these mistakes):\n\n" + entries.join("\n---\n")
  } catch {
    return null
  }
}

// ─── Sysbase knowledge loader (indexed) ───

async function loadSysbaseKnowledge(cwd: string, prompt: string): Promise<string | null> {
  const matches = await getRelevantPatterns(cwd, prompt, 8)
  if (matches.length === 0) return null

  const sections: string[] = []
  for (const match of matches) {
    const label = match.file.replace(".md", "").toUpperCase()
    const stripped = match.content.replace(/^---[\s\S]*?---\n*/, "").trim()
    const truncated = stripped.length > 500 ? stripped.slice(0, 500) + "..." : stripped
    sections.push(`[${label}]\n${truncated}`)
  }

  return "═══ PROJECT KNOWLEDGE BASE ═══\n\n" + sections.join("\n\n---\n\n")
}

// ─── Public API ───

interface LoadProjectContextParams {
  projectId: string
  command?: string
  prompt: string
  model: string
  cwd: string
  sysbasePath?: string
  task: unknown
}

export async function loadProjectContext({ projectId, command, prompt, model, cwd, sysbasePath, task }: LoadProjectContextParams): Promise<Record<string, unknown>> {
  const memories = await getProjectMemories(projectId)
  const fixes = await loadFixFiles(sysbasePath)
  const sysbaseKnowledge = await loadSysbaseKnowledge(cwd, prompt)

  const projectMemory: unknown[] = memories.length > 0
    ? memories
    : [
        "Use sysbase as the shared project support folder.",
        "Prefer creating missing folders and files when repo is empty."
      ]

  if (fixes) {
    projectMemory.push(fixes)
  }

  if (sysbaseKnowledge) {
    projectMemory.push(sysbaseKnowledge)
  }

  return {
    projectId, command, prompt, model, cwd, sysbasePath, task,
    projectMemory,
    supportFolders: { sysbase: sysbasePath }
  }
}

interface LoadRunContextParams {
  runId: string
  taskId: string
  projectId: string
  cwd: string
  sysbasePath?: string
}

export async function loadRunContext({ runId, taskId, projectId, cwd, sysbasePath }: LoadRunContextParams): Promise<Record<string, unknown>> {
  const previousToolResults = await getToolResults(runId)

  return { runId, taskId, projectId, cwd, sysbasePath, previousToolResults }
}
