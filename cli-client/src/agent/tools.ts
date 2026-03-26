import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"

// ─── Web Search ───

interface SearchResult {
  title: string
  snippet: string
  url: string
}

export async function webSearchTool(query: string): Promise<SearchResult[]> {
  const encoded = encodeURIComponent(query)
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SysflowBot/1.0)"
      },
      signal: controller.signal
    })

    const html = await res.text()

    // Parse DuckDuckGo HTML results
    const results: SearchResult[] = []
    const resultBlocks = html.split(/class="result\s/)

    for (const block of resultBlocks.slice(1, 8)) { // top 7 results
      // Extract title
      const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/)
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : ""

      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\//)
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : ""

      // Extract URL
      const urlMatch = block.match(/class="result__url"[^>]*>([\s\S]*?)<\//)
      const resultUrl = urlMatch ? urlMatch[1].replace(/<[^>]+>/g, "").trim() : ""

      if (title || snippet) {
        results.push({ title, snippet, url: resultUrl })
      }
    }

    return results
  } catch (err) {
    // Fallback: try npm registry search for package info
    if (query.includes("npm") || query.includes("npx") || query.includes("install")) {
      return await npmSearchFallback(query)
    }
    return [{ title: "Search failed", snippet: (err as Error).message, url: "" }]
  } finally {
    clearTimeout(timeout)
  }
}

async function npmSearchFallback(query: string): Promise<SearchResult[]> {
  // Extract package name from query
  const pkgMatch = query.match(/([@\w/-]+)/)
  if (!pkgMatch) return []

  const pkg = pkgMatch[1]
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}`, {
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return [{ title: `Package ${pkg} not found`, snippet: "Check the package name", url: "" }]

    const data = await res.json() as Record<string, unknown>
    const latest = (data["dist-tags"] as Record<string, string>)?.latest || "unknown"
    const desc = (data.description as string) || ""
    const homepage = (data.homepage as string) || ""

    return [{
      title: `${pkg}@${latest}`,
      snippet: desc,
      url: homepage
    }]
  } catch {
    return []
  }
}

interface DirectoryEntry {
  name: string
  type: "file" | "directory"
}

export async function listDirectoryTool(dirPath: string): Promise<DirectoryEntry[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" as const : "file" as const
  }))
}

export async function fileExistsTool(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function createDirectoryTool(dirPath: string): Promise<boolean> {
  await fs.mkdir(dirPath, { recursive: true })
  return true
}

export async function readFileTool(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8")
}

export async function writeFileTool(filePath: string, content: string): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, "utf8")
  return true
}

export async function editFileTool(filePath: string, patch: string): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, patch, "utf8")
  return true
}

export async function moveFileTool(from: string, to: string): Promise<boolean> {
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.rename(from, to)
  return true
}

export async function deleteFileTool(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath)
  if (stat.isDirectory()) {
    await fs.rm(filePath, { recursive: true, force: true })
  } else {
    await fs.unlink(filePath)
  }
  return true
}

export async function searchCodeTool(directory: string, pattern: string): Promise<string[]> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32"
    const shell = isWindows ? "cmd.exe" : "/bin/sh"
    const cmd = isWindows
      ? `findstr /s /n /c:"${pattern}" *`
      : `grep -rn "${pattern}" "${directory}" --include="*" -l`
    const shellArgs = isWindows ? ["/c", cmd] : ["-c", cmd]

    const child = spawn(shell, shellArgs, { cwd: directory })
    let stdout = ""
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
    child.on("close", () => {
      resolve(stdout.trim().split("\n").filter(Boolean))
    })
    child.on("error", () => resolve([]))
  })
}

const LONG_RUNNING_PATTERNS = [
  /^npm\s+start/,
  /^npm\s+run\s+(dev|start|serve|watch)/,
  /^npx\s+(nodemon|ts-node-dev|next\s+dev|vite\s+dev|webpack\s+serve)/,
  /^node\s+\S+\.(js|ts|mjs)$/,
  /^python\s+\S+\.py$/,
  /^deno\s+run/,
  /^bun\s+run/
]

// Commands that are too slow, obsolete, or should be user-run — auto-skip
const SLOW_COMMAND_PATTERNS = [
  /npm\s+(install|i|ci)\b/,
  /yarn\s+(install|add)\b/,
  /pnpm\s+(install|i|add)\b/,
  /npx\s+(--yes\s+)?prisma\b/,
  /npx\s+(--yes\s+)?shadcn/,
  /tailwindcss\s+init/,           // removed in Tailwind v4
  /npx\s+(--yes\s+)?tailwindcss/, // no executable in v4
]

// Commands that need interactive terminal (scaffolding tools, prompts)
export const INTERACTIVE_PATTERNS = [
  /^npx\s+(--yes\s+)?create-/,
  /^npm\s+create\s/,
  /^npm\s+init/,
  /^yarn\s+create/,
  /^pnpm\s+create/,
  /^npx\s+(--yes\s+)?@nestjs\/cli\s+new/,
  /^npx\s+(--yes\s+)?@angular\/cli\s+new/,
  /^npx\s+(--yes\s+)?nuxi/,
  /^npx\s+(--yes\s+)?degit/,
  /^npx\s+(--yes\s+)?giget/,
  /^django-admin\s+startproject/,
  /^rails\s+new/,
  /^cargo\s+init/,
  /^dotnet\s+new/
]

const COMMAND_TIMEOUT_MS = 30_000

interface CommandResult {
  stdout: string
  stderr: string
  skipped?: boolean
  timedOut?: boolean
  interactive?: boolean
  message?: string
}

export async function runCommandTool(command: string, cwd: string = process.cwd()): Promise<CommandResult> {
  const trimmed = command.trim()
  const isLongRunning = LONG_RUNNING_PATTERNS.some((p) => p.test(trimmed))
  const isSlow = SLOW_COMMAND_PATTERNS.some((p) => p.test(trimmed))
  const isInteractive = INTERACTIVE_PATTERNS.some((p) => p.test(trimmed))

  if (isLongRunning) {
    return {
      stdout: "",
      stderr: "",
      skipped: true,
      message: `This is a long-running command (server/watcher). The user should run it manually:\n\n  ${command}\n\nDo NOT attempt to run server-start commands. Instead, tell the user to run it themselves.`
    }
  }

  if (isSlow) {
    return {
      stdout: "",
      stderr: "",
      skipped: true,
      message: `SKIPPED (slow command — user will run manually): ${command}\n\nDo NOT stop or complete because of this skip. CONTINUE creating all project files with write_file. Add this command to your final summary under "Next Steps". The task is NOT done — keep implementing.`
    }
  }

  // Interactive commands: full terminal passthrough so user can see prompts and type
  if (isInteractive) {
    return new Promise((resolve, reject) => {
      const isWindows = process.platform === "win32"
      const shell = isWindows ? "cmd.exe" : "/bin/sh"
      const shellArgs = isWindows ? ["/c", trimmed] : ["-c", trimmed]

      console.log("") // blank line before interactive output

      const child = spawn(shell, shellArgs, {
        cwd,
        stdio: "inherit",
        env: { ...process.env, FORCE_COLOR: "1" }
      })

      // Safety timeout: if command runs longer than 10 minutes, it's probably stuck
      const safetyTimer = setTimeout(() => {
        console.log("\n  (command exceeded 10 minutes — stopping)")
        if (isWindows) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
        } else {
          child.kill("SIGTERM")
        }
        resolve({
          stdout: "",
          stderr: "",
          timedOut: true,
          interactive: true,
          message: "Interactive command exceeded 10 minutes and was stopped."
        })
      }, 600_000)

      child.on("close", (code) => {
        clearTimeout(safetyTimer)
        console.log("") // blank line after interactive output
        if (code !== 0 && code !== null) {
          resolve({
            stdout: "",
            stderr: `Exited with code ${code}`,
            interactive: true,
            message: `Command finished with exit code ${code}. Check the output above for details.`
          })
        } else {
          resolve({
            stdout: "",
            stderr: "",
            interactive: true,
            message: "Command completed successfully."
          })
        }
      })

      child.on("error", (err) => {
        clearTimeout(safetyTimer)
        reject(err)
      })
    })
  }

  // Normal commands: capture output
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32"
    const shell = isWindows ? "cmd.exe" : "/bin/sh"
    const shellArgs = isWindows ? ["/c", trimmed] : ["-c", trimmed]

    const child = spawn(shell, shellArgs, { cwd, env: { ...process.env, FORCE_COLOR: "0" } })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      resolve({
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000),
        timedOut: true,
        message: `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s. Partial output included.`
      })
    }, COMMAND_TIMEOUT_MS)

    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0 && !stdout) {
        reject(new Error(stderr.slice(-500) || `Command exited with code ${code}`))
      } else {
        resolve({ stdout: stdout.slice(-4000), stderr: stderr.slice(-2000) })
      }
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

// ─── Indexed file search ───

import { getOrBuildIndex, searchIndex, searchByGlob } from "./indexer.js"
import { getSysbasePath } from "../lib/sysbase.js"

export async function searchFilesTool(query: string, glob?: string): Promise<string> {
  const index = await getOrBuildIndex(process.cwd(), getSysbasePath())

  if (glob) {
    const results = searchByGlob(index, glob)
    if (results.length === 0) return `No files matching glob: ${glob}`
    return results.join("\n")
  }

  const results = searchIndex(index, query, 30)
  if (results.length === 0) return `No files matching: ${query}`
  return results.map((r) => r.path).join("\n")
}

// ─── Command Error Recovery ───

interface CommandFix {
  /** Pattern to match against the error message or command */
  match: (cmd: string, error: string) => boolean
  /** Return fixed command, or null if can't fix */
  fix: (cmd: string, error: string) => string | null
  /** Human-readable description of what was fixed */
  description: string
}

/**
 * Known command fixes — ordered by priority.
 * Each entry matches a common error and returns the corrected command.
 */
const KNOWN_COMMAND_FIXES: CommandFix[] = [
  // tailwindcss init removed in v4
  {
    match: (cmd) => /tailwindcss\s+init/i.test(cmd),
    fix: () => null, // no fix — skip entirely
    description: "tailwindcss init was removed in Tailwind v4. Tailwind is configured via postcss.config.js (already set up by create-next-app --tailwind)."
  },
  // shadcn init — should create components manually
  {
    match: (cmd) => /shadcn(-ui)?(@\S+)?\s+init/i.test(cmd),
    fix: () => null,
    description: "shadcn init is slow and interactive. Components should be created manually with write_file."
  },
  // npx without --yes flag
  {
    match: (cmd, err) => cmd.startsWith("npx ") && !cmd.includes("--yes") && (err.includes("Need to install") || err.includes("not found")),
    fix: (cmd) => cmd.replace(/^npx\s+/, "npx --yes "),
    description: "Added --yes flag to auto-accept npx package installation."
  },
  // npm create → npx --yes create-
  {
    match: (cmd) => /^npm\s+create\s+/.test(cmd),
    fix: (cmd) => {
      const pkg = cmd.replace(/^npm\s+create\s+/, "").trim()
      return `npx --yes create-${pkg}`
    },
    description: "Converted npm create to npx --yes create- format."
  },
  // could not determine executable — package doesn't have a bin
  {
    match: (_cmd, err) => err.includes("could not determine executable"),
    fix: () => null,
    description: "Package does not provide an executable. This command should be skipped."
  },
  // ENOENT / command not found
  {
    match: (_cmd, err) => err.includes("ENOENT") || err.includes("not found") || err.includes("not recognized"),
    fix: (cmd) => {
      // Try adding npx --yes prefix if it looks like a CLI tool
      if (!cmd.startsWith("npx") && !cmd.startsWith("npm") && !cmd.startsWith("node")) {
        return `npx --yes ${cmd}`
      }
      return null
    },
    description: "Command not found — trying with npx --yes prefix."
  },
  // Permission denied
  {
    match: (_cmd, err) => err.includes("EACCES") || err.includes("permission denied"),
    fix: (cmd) => {
      if (cmd.startsWith("npm ")) return cmd // npm handles its own permissions
      return null
    },
    description: "Permission error — cannot auto-fix."
  },
  // cd into directory that might not exist yet
  {
    match: (cmd, err) => cmd.startsWith("cd ") && (err.includes("no such file") || err.includes("cannot find")),
    fix: () => null,
    description: "Directory does not exist. The scaffolding command may not have created it."
  },
  // Chained commands where the first part (cd) fails
  {
    match: (cmd, err) => cmd.includes("&&") && (err.includes("no such file") || err.includes("cannot find") || err.includes("not recognized")),
    fix: (cmd) => {
      // Try just the second part of the chain
      const parts = cmd.split("&&").map((p) => p.trim())
      if (parts.length >= 2) return parts[parts.length - 1]
      return null
    },
    description: "Chained command failed — trying the last part only."
  },
  // prisma commands — should be skipped
  {
    match: (cmd) => /prisma\s+(init|migrate|generate|db)/i.test(cmd),
    fix: () => null,
    description: "Prisma commands should be run by the user. Create schema.prisma manually with write_file."
  },
]

export interface CommandRecoveryResult {
  /** Whether a fix was found and should be attempted */
  action: "auto_fix" | "skip" | "web_search" | "ask_user"
  /** The fixed command (only for auto_fix) */
  fixedCommand?: string
  /** Description of what happened */
  description: string
  /** Web search query (only for web_search) */
  searchQuery?: string
}

/**
 * Attempt to recover from a command error using a fallback chain:
 * 1. Known fixes (pattern matching)
 * 2. Auto-fix heuristics
 * 3. Web search suggestion
 * 4. Ask user (last resort)
 */
export function recoverFromCommandError(cmd: string, error: string): CommandRecoveryResult {
  // Step 1: Check known fixes
  for (const fix of KNOWN_COMMAND_FIXES) {
    if (fix.match(cmd, error)) {
      const fixedCmd = fix.fix(cmd, error)
      if (fixedCmd) {
        return { action: "auto_fix", fixedCommand: fixedCmd, description: fix.description }
      }
      // Known issue but no fix — skip
      return { action: "skip", description: fix.description }
    }
  }

  // Step 2: Web search for unknown errors
  // Build a search query from the command and error
  const shortError = error.split("\n")[0].slice(0, 100)
  const searchQuery = `${cmd.split(" ").slice(0, 3).join(" ")} error "${shortError}"`
  return {
    action: "web_search",
    description: `Unknown error. Searching the web for: ${searchQuery}`,
    searchQuery
  }
}

/**
 * Try to find a corrected command via web search.
 * Returns the suggested command or null if search fails.
 */
export async function searchForCommandFix(cmd: string, error: string): Promise<string | null> {
  const shortCmd = cmd.split(" ").slice(0, 4).join(" ")
  const query = `${shortCmd} correct command 2025`

  try {
    const results = await webSearchTool(query)
    if (results.length === 0) return null

    // Look for a command in the search results
    for (const result of results.slice(0, 3)) {
      const text = `${result.title} ${result.snippet}`
      // Find npx/npm commands in the text
      const cmdMatch = text.match(/`?(npx\s+[^`\n]+|npm\s+[^`\n]+)`?/)
      if (cmdMatch) {
        const candidate = cmdMatch[1].trim().replace(/`/g, "")
        // Sanity check: must be a plausible command
        if (candidate.length > 5 && candidate.length < 200) {
          return candidate
        }
      }
    }
    return null
  } catch {
    return null
  }
}

// ─── Diff ───

export function computeLineDiff(oldContent: string | null, newContent: string): { added: number; removed: number } {
  const oldLines = oldContent ? oldContent.split("\n") : []
  const newLines = newContent ? newContent.split("\n") : []
  const oldSet = new Set(oldLines)
  const newSet = new Set(newLines)
  let added = 0
  let removed = 0
  for (const line of newLines) {
    if (!oldSet.has(line)) added++
  }
  for (const line of oldLines) {
    if (!newSet.has(line)) removed++
  }
  return { added, removed }
}

export async function scanDirectoryTree(dirPath: string, prefix: string = ""): Promise<DirectoryEntry[]> {
  const tree: DirectoryEntry[] = []
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const sorted = entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "sysbase")
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })

    for (const entry of sorted) {
      const fullPath = path.join(dirPath, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        tree.push({ name: relativePath, type: "directory" })
        const children = await scanDirectoryTree(fullPath, relativePath)
        tree.push(...children)
      } else {
        tree.push({ name: relativePath, type: "file" })
      }
    }
  } catch {
    // directory doesn't exist or can't be read
  }
  return tree
}
