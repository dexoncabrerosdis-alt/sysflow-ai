import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"

export async function listDirectoryTool(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : "file"
  }))
}

export async function fileExistsTool(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function createDirectoryTool(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
  return true
}

export async function readFileTool(filePath) {
  return fs.readFile(filePath, "utf8")
}

export async function writeFileTool(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, "utf8")
  return true
}

export async function editFileTool(filePath, patch) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, patch, "utf8")
  return true
}

export async function moveFileTool(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.rename(from, to)
  return true
}

export async function deleteFileTool(filePath) {
  await fs.unlink(filePath)
  return true
}

export async function searchCodeTool(directory, pattern) {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32"
    const shell = isWindows ? "cmd.exe" : "/bin/sh"
    const cmd = isWindows
      ? `findstr /s /n /c:"${pattern}" *`
      : `grep -rn "${pattern}" "${directory}" --include="*" -l`
    const shellArgs = isWindows ? ["/c", cmd] : ["-c", cmd]

    const child = spawn(shell, shellArgs, { cwd: directory })
    let stdout = ""
    child.stdout.on("data", (d) => { stdout += d.toString() })
    child.on("close", () => {
      resolve(stdout.trim().split("\n").filter(Boolean))
    })
    child.on("error", () => resolve([]))
  })
}

// Commands that start long-running processes (servers, watchers, etc.)
const LONG_RUNNING_PATTERNS = [
  /^npm\s+start/,
  /^npm\s+run\s+(dev|start|serve|watch)/,
  /^npx\s+(nodemon|ts-node-dev|next|vite|webpack\s+serve)/,
  /^node\s+\S+\.(js|ts|mjs)$/,
  /^python\s+\S+\.py$/,
  /^deno\s+run/,
  /^bun\s+run/
]

const COMMAND_TIMEOUT_MS = 30_000 // 30s for normal commands

export async function runCommandTool(command, cwd = process.cwd()) {
  const isLongRunning = LONG_RUNNING_PATTERNS.some((p) => p.test(command.trim()))

  if (isLongRunning) {
    return {
      stdout: "",
      stderr: "",
      skipped: true,
      message: `This is a long-running command (server/watcher). The user should run it manually:\n\n  ${command}\n\nDo NOT attempt to run server-start commands. Instead, tell the user to run it themselves.`
    }
  }

  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32"
    const shell = isWindows ? "cmd.exe" : "/bin/sh"
    const shellArgs = isWindows ? ["/c", command] : ["-c", command]

    const child = spawn(shell, shellArgs, { cwd, env: { ...process.env, FORCE_COLOR: "0" } })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (d) => { stdout += d.toString() })
    child.stderr.on("data", (d) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      resolve({
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000),
        timedOut: true,
        message: `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s. Partial output included. If this is a server/watcher, tell the user to run it manually.`
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

export function computeLineDiff(oldContent, newContent) {
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

export async function scanDirectoryTree(dirPath, prefix = "") {
  const tree = []
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
