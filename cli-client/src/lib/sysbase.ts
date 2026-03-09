import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const SYSBASE_DIR = path.join(process.cwd(), "sysbase")
const SYSBASE_META_DIR = path.join(SYSBASE_DIR, ".meta")
const PROJECT_META_FILE = path.join(SYSBASE_META_DIR, "project.json")
const MODELS_META_FILE = path.join(SYSBASE_META_DIR, "models.json")

const SYSFLOW_HOME = path.join(os.homedir(), ".sysflow")
const AUTH_FILE = path.join(SYSFLOW_HOME, "auth.json")
const CHAT_FILE = path.join(SYSBASE_META_DIR, "chat.json")

export interface ModelDef {
  id: string
  label: string
  desc: string
  visible: boolean
}

export const MODELS: ModelDef[] = [
  { id: "openrouter-auto", label: "Auto (OpenRouter)", desc: "Best available model via OpenRouter", visible: true },
  { id: "gemini-flash",    label: "Gemini 2.5 Flash",  desc: "Fast & free — Google AI direct", visible: true }
]

export const VISIBLE_MODELS = MODELS.filter((m) => m.visible !== false)

export function getSysbasePath(): string {
  return SYSBASE_DIR
}

export async function ensureSysbase(): Promise<void> {
  const dirs = [
    SYSBASE_DIR,
    path.join(SYSBASE_DIR, "plans"),
    path.join(SYSBASE_DIR, "patterns"),
    path.join(SYSBASE_DIR, "fixes"),
    path.join(SYSBASE_DIR, "architecture"),
    path.join(SYSBASE_DIR, "decisions"),
    path.join(SYSBASE_DIR, "archive"),
    SYSBASE_META_DIR
  ]

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true })
  }

  const defaults = [
    {
      file: PROJECT_META_FILE,
      content: JSON.stringify({ defaultModel: "openrouter-auto", initializedAt: new Date().toISOString(), cwd: process.cwd() }, null, 2)
    },
    {
      file: MODELS_META_FILE,
      content: JSON.stringify({ available: MODELS.map((m) => m.id), selected: "openrouter-auto" }, null, 2)
    }
  ]

  for (const item of defaults) {
    try {
      await fs.access(item.file)
    } catch {
      await fs.writeFile(item.file, item.content, "utf8")
    }
  }
}

export async function getSelectedModel(): Promise<string> {
  await ensureSysbase()
  const raw = await fs.readFile(MODELS_META_FILE, "utf8")
  const data = JSON.parse(raw)
  return data.selected || "swe"
}

export async function setSelectedModel(model: string): Promise<void> {
  await ensureSysbase()
  const valid = MODELS.find((m) => m.id === model)
  if (!valid) {
    throw new Error(`Unknown model: ${model}. Available: ${MODELS.map((m) => m.id).join(", ")}`)
  }

  const raw = await fs.readFile(MODELS_META_FILE, "utf8")
  const data = JSON.parse(raw)
  data.selected = model
  data.available = MODELS.map((m) => m.id)
  await fs.writeFile(MODELS_META_FILE, JSON.stringify(data, null, 2), "utf8")
}

export async function getReasoningEnabled(): Promise<boolean> {
  await ensureSysbase()
  const raw = await fs.readFile(MODELS_META_FILE, "utf8")
  const data = JSON.parse(raw)
  return data.reasoning !== false
}

export async function setReasoningEnabled(enabled: boolean): Promise<void> {
  await ensureSysbase()
  const raw = await fs.readFile(MODELS_META_FILE, "utf8")
  const data = JSON.parse(raw)
  data.reasoning = enabled
  await fs.writeFile(MODELS_META_FILE, JSON.stringify(data, null, 2), "utf8")
}

async function ensureSysflowHome(): Promise<void> {
  await fs.mkdir(SYSFLOW_HOME, { recursive: true })
}

export async function saveAuthToken(token: string, user: Record<string, unknown>): Promise<void> {
  await ensureSysflowHome()
  await fs.writeFile(AUTH_FILE, JSON.stringify({ token, user, savedAt: new Date().toISOString() }, null, 2), "utf8")
}

export async function getAuthToken(): Promise<string | null> {
  try {
    const raw = await fs.readFile(AUTH_FILE, "utf8")
    const data = JSON.parse(raw)
    return data.token || null
  } catch {
    return null
  }
}

export async function getAuthUser(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(AUTH_FILE, "utf8")
    const data = JSON.parse(raw)
    return data.user || null
  } catch {
    return null
  }
}

export async function clearAuth(): Promise<void> {
  try {
    await fs.unlink(AUTH_FILE)
  } catch {
    // file doesn't exist, fine
  }
}

export async function saveActiveChat(chatUid: string, title: string): Promise<void> {
  await ensureSysbase()
  await fs.writeFile(CHAT_FILE, JSON.stringify({ chatUid, title, savedAt: new Date().toISOString() }, null, 2), "utf8")
}

export async function getActiveChat(): Promise<string | null> {
  try {
    const raw = await fs.readFile(CHAT_FILE, "utf8")
    const data = JSON.parse(raw)
    return data.chatUid || null
  } catch {
    return null
  }
}

export async function getActiveChatInfo(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(CHAT_FILE, "utf8")
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function clearActiveChat(): Promise<void> {
  try {
    await fs.unlink(CHAT_FILE)
  } catch {
    // file doesn't exist, fine
  }
}
