import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import chalk from "chalk"
import ora from "ora"
import { callServer, callServerStream } from "../lib/server.js"
import { ensureSysbase, getSelectedModel, getSysbasePath, getReasoningEnabled, getAuthToken } from "../lib/sysbase.js"
import { executeTool, executeToolsBatch } from "./executor.js"
import { readFileTool, computeLineDiff } from "./tools.js"
import { getOrBuildIndex, compactTree } from "./indexer.js"
import { ensureActiveChat } from "../commands/chats.js"

interface ServerError extends Error {
  code?: string
  plan?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Color palette ───

const colors = {
  accent: chalk.hex("#7C6FFF"),       // purple accent
  accentDim: chalk.hex("#5A50B8"),    // muted purple
  success: chalk.hex("#58D68D"),      // green
  warning: chalk.hex("#F4D03F"),      // yellow
  error: chalk.hex("#E74C3C"),        // red
  info: chalk.hex("#5DADE2"),         // blue
  muted: chalk.hex("#7F8C8D"),       // gray
  bright: chalk.hex("#ECF0F1"),      // off-white
  tool: chalk.hex("#48C9B0"),        // teal for tool names
  file: chalk.hex("#AEB6BF"),        // silver for paths
  bar: chalk.hex("#34495E"),         // dark bar color
}

// ─── Box drawing helpers ───

const BOX = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│",
  lt: "├", rt: "┤",
  dot: "●", ring: "○", arrow: "▸", check: "✔", cross: "✖", dash: "─",
} as const

function boxLine(width: number): string {
  return colors.bar(BOX.h.repeat(width))
}

function boxTop(label: string, width = 40): string {
  const inner = ` ${label} `
  const pad = Math.max(0, width - inner.length - 2)
  return colors.bar(BOX.tl + BOX.h) + colors.accent.bold(inner) + colors.bar(BOX.h.repeat(pad) + BOX.tr)
}

function boxMid(content: string, width = 40): string {
  return colors.bar(BOX.v) + " " + content
}

function boxBot(width = 40): string {
  return colors.bar(BOX.bl + BOX.h.repeat(width) + BOX.br)
}

// ─── Reasoning: instant display with cascade reveal animation ───

async function revealReasoning(text: string): Promise<void> {
  // Truncate long reasoning to keep output clean
  const maxLen = 280
  let display = text.trim()
  if (display.length > maxLen) {
    display = display.slice(0, maxLen).trimEnd() + "..."
  }

  const lines = display.split("\n")

  // Print each line with a fast cascade delay (no cursor movement — Windows compatible)
  for (let i = 0; i < lines.length; i++) {
    const line = `    ${colors.muted(BOX.v)} ${colors.muted(lines[i])}`
    console.log(line)
    if (lines.length > 1 && i < lines.length - 1) {
      await sleep(20)
    }
  }
  await sleep(60)
}

// ─── Tool label formatting ───

function formatToolLabel(tool: string, args: Record<string, unknown>): string | null {
  switch (tool) {
    case "read_file":
      return colors.tool("read") + " " + colors.file(args.path as string)
    case "batch_read":
      return null
    case "write_file":
      return colors.tool("create") + " " + colors.file(args.path as string)
    case "edit_file":
      return colors.tool("edit") + " " + colors.file(args.path as string)
    case "create_directory":
      return colors.tool("mkdir") + " " + colors.file(args.path as string)
    case "move_file":
      return colors.tool("move") + " " + colors.file(args.from as string) + colors.muted(" → ") + colors.file(args.to as string)
    case "delete_file":
      return colors.tool("delete") + " " + colors.file(args.path as string)
    case "file_exists":
      return colors.tool("check") + " " + colors.file(args.path as string)
    case "search_code":
      return colors.tool("search") + " " + colors.bright(`"${args.pattern}"`)
    case "search_files":
      return colors.tool("find") + " " + colors.bright(`"${args.query || args.glob}"`)
    case "run_command":
      return colors.tool("run") + " " + colors.bright(args.command as string)
    case "web_search":
      return colors.tool("search web") + " " + colors.bright(`"${args.query}"`)
    default:
      return colors.tool(tool) + " " + colors.muted(JSON.stringify(args))
  }
}

function isHiddenStep(tool: string): boolean {
  return tool === "list_directory"
}

// ─── User input prompt ───

function askUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(colors.accent("  > "), (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// ─── Markdown → terminal renderer ───

function renderMarkdown(text: string): string {
  let inCodeBlock = false
  const lines = text.split("\n")
  const result: string[] = []

  for (const raw of lines) {
    // Code fence toggle
    if (raw.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock
      continue // skip fence lines
    }

    // Inside code block — render as-is with code color
    if (inCodeBlock) {
      result.push(colors.info(raw))
      continue
    }

    let line = raw

    // Headers: ## Title → bold colored
    if (/^#{1,3}\s/.test(line)) {
      result.push("")
      result.push(colors.accent.bold(line.replace(/^#{1,3}\s+/, "")))
      continue
    }

    // Empty lines → preserved as spacing
    if (line.trim() === "") {
      result.push("")
      continue
    }

    // Apply inline formatting BEFORE bullet/number detection
    // Bold: **text**
    line = line.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => colors.bright.bold(b))
    // Inline code: `code`
    line = line.replace(/`([^`]+)`/g, (_m, c: string) => colors.info(c))

    // Bullet points: - item or * item (with any indentation)
    if (/^\s*[-*]\s/.test(line)) {
      line = line.replace(/^(\s*)([-*])\s/, `$1${colors.accent(BOX.arrow)} `)
      result.push(line)
      continue
    }

    // Numbered list: 1. item (with any indentation)
    if (/^\s*\d+\.\s/.test(line)) {
      line = line.replace(/^(\s*)(\d+\.)\s/, `$1${colors.accent("$2")} `)
      result.push(line)
      continue
    }

    result.push(line)
  }

  // Clean up leading/trailing empty lines
  while (result.length > 0 && result[0] === "") result.shift()
  while (result.length > 0 && result[result.length - 1] === "") result.pop()

  return result.join("\n")
}

// ─── Step icon helpers ───

function stepIcon(status: string | undefined): string {
  if (status === "completed") return colors.success(BOX.check)
  if (status === "in_progress") return colors.accent(BOX.arrow)
  return colors.muted(BOX.ring)
}

function stepLabel(label: string, status: string | undefined): string {
  if (status === "completed") return colors.success(label)
  if (status === "in_progress") return colors.accent.bold(label)
  return colors.muted(label)
}

function resolveFileMentions(prompt: string, cwd: string): { prompt: string; mentions: Array<{ path: string; absolute: string }> } {
  const mentions: Array<{ path: string; absolute: string }> = []
  const resolved = prompt.replace(/@([\w./-]+)/g, (_match, filePath: string) => {
    const absolute = path.resolve(cwd, filePath)
    mentions.push({ path: filePath, absolute })
    return filePath
  })
  return { prompt: resolved, mentions }
}

interface RunAgentParams {
  prompt: string
  command?: string | null
  model?: string | null
}

export async function runAgent({ prompt, command = null, model = null }: RunAgentParams): Promise<Record<string, unknown> | undefined> {
  await ensureSysbase()

  const authToken = await getAuthToken()
  if (!authToken) {
    console.log("")
    console.log(colors.warning("  ⚠ You must be logged in to use Sysflow"))
    console.log("")
    console.log(colors.muted("  Run ") + colors.accent("sys login") + colors.muted(" or ") + colors.accent("sys register") + colors.muted(" to get started"))
    console.log("")
    return
  }

  const selectedModel = model || (await getSelectedModel())
  const hasReasoning = await getReasoningEnabled()

  const chatUid = await ensureActiveChat()
  if (!chatUid) {
    console.log("")
    console.log(colors.warning("  ⚠ Could not establish a chat session"))
    console.log(colors.muted("  Check your connection and try again, or run ") + colors.accent("sys chat") + colors.muted(" to select one"))
    console.log("")
    return
  }

  const { prompt: cleanPrompt, mentions } = resolveFileMentions(prompt, process.cwd())

  const mentionedFiles: Array<{ path: string; content: string }> = []
  for (const m of mentions) {
    try {
      const content = await readFileTool(m.absolute)
      mentionedFiles.push({ path: m.path, content })
    } catch {
      // file doesn't exist, skip
    }
  }

  const fileIndex = await getOrBuildIndex(process.cwd(), getSysbasePath())
  const dirTree = compactTree(fileIndex)

  console.log("")

  const spinner = ora({
    text: colors.muted("thinking..."),
    prefixText: "  ",
    spinner: "dots",
    color: "magenta"
  }).start()

  const serverPayload = {
    type: "user_message",
    command,
    content: cleanPrompt,
    model: selectedModel,
    projectId: path.basename(process.cwd()),
    cwd: process.cwd(),
    sysbasePath: getSysbasePath(),
    directoryTree: dirTree,
    mentionedFiles,
    chatUid: chatUid || undefined,
    client: { platform: os.platform(), arch: os.arch() }
  }

  let response: Record<string, unknown>

  // ─── Initial call with task-driven retry on rate/usage limits ───
  async function makeServerCall(payload: Record<string, unknown>, phaseHandler?: (label: string) => void): Promise<Record<string, unknown>> {
    try {
      return await callServerStream(payload, phaseHandler)
    } catch (err) {
      if ((err as ServerError).code === "USAGE_LIMIT") {
        throw err // let outer handler decide
      }
      // Fallback to non-streaming
      return await callServer(payload)
    }
  }

  let initialAttempts = 0
  const MAX_INITIAL_ATTEMPTS = 6
  while (true) {
    try {
      response = await makeServerCall(serverPayload, (label) => {
        spinner.text = colors.muted(label)
      })
      break
    } catch (err) {
      if ((err as ServerError).code === "USAGE_LIMIT" && initialAttempts < MAX_INITIAL_ATTEMPTS) {
        initialAttempts++
        const waitMs = Math.min(5000 * Math.pow(2, initialAttempts - 1), 120_000)
        spinner.stop()
        console.log("")
        console.log(colors.warning(`  ⚠ Usage limit hit — waiting ${Math.round(waitMs / 1000)}s before retry (${initialAttempts}/${MAX_INITIAL_ATTEMPTS})`))
        console.log(colors.muted("    The system will reduce usage and retry automatically."))
        await sleep(waitMs)
        spinner.start(colors.muted("retrying..."))
        continue
      }
      if ((err as ServerError).code === "USAGE_LIMIT") {
        spinner.stop()
        console.log("")
        console.log(colors.warning("  ⚠ " + (err as Error).message))
        console.log(colors.muted("  Exhausted all retry attempts."))
        console.log(colors.muted("  Run ") + colors.accent("sys billing") + colors.muted(" to upgrade your plan"))
        console.log("")
        return
      }
      spinner.stop()
      throw err
    }
  }

  let stepCount = 0
  let taskShown = false
  let taskSteps: Array<{ id: string; label: string; status?: string }> = []
  const completedSteps = new Set<string>()
  let consecutiveErrors = 0
  const MAX_CONSECUTIVE_ERRORS = 3
  let lastDisplayedAction: string | null = null
  let lastDisplayedReasoning: string | null = null

  // ─── Task-driven persistence state ───
  let rateLimitRetries = 0
  const MAX_RATE_LIMIT_RETRIES = 8       // total retries across all rate limit events
  let rateLimitBackoffMs = 5000           // starts at 5s, doubles each time
  const MAX_RATE_LIMIT_BACKOFF = 120_000  // cap at 2 minutes
  let failureRetries = 0
  const MAX_FAILURE_RETRIES = 5           // auto-retry recoverable failures

  while (true) {
    // Safety: detect misclassified responses — if "completed" but message contains needs_tool JSON
    if (response.status === "completed") {
      const msg = (response.message || response.content || "") as string
      if (msg.trimStart().startsWith("{")) {
        try {
          const parsed = JSON.parse(msg)
          if (parsed.kind === "needs_tool" && (parsed.tool || parsed.tools)) {
            // Re-map as needs_tool response
            response.status = "needs_tool"
            response.tool = parsed.tool || undefined
            response.args = parsed.args || undefined
            if (parsed.args_json) {
              try { response.args = typeof parsed.args_json === "string" ? JSON.parse(parsed.args_json) : parsed.args_json } catch { /* ignore */ }
            }
            if (Array.isArray(parsed.tools)) {
              response.tools = parsed.tools.map((tc: Record<string, unknown>, i: number) => {
                let args: Record<string, unknown> = {}
                if (tc.args_json) {
                  try { args = typeof tc.args_json === "string" ? JSON.parse(tc.args_json as string) : tc.args_json as Record<string, unknown> } catch { /* */ }
                } else if (tc.args) {
                  args = tc.args as Record<string, unknown>
                }
                return { id: (tc.id as string) || `tc_${i}`, tool: tc.tool as string, args }
              })
            }
            response.reasoning = parsed.reasoning || null
            response.content = parsed.content || null
            response.message = null
          }
        } catch { /* not JSON */ }
      }
    }

    switch (response.status) {
      case "completed": {
        spinner.stop()

        let message = (response.message || response.content) as string | null
        const reasoning = response.reasoning as string | null

        // Safety: if message is raw JSON, extract the content field
        if (message && message.trimStart().startsWith("{")) {
          try {
            const parsed = JSON.parse(message)
            if (parsed.content && typeof parsed.content === "string") {
              message = parsed.content
            }
          } catch { /* not JSON, use as-is */ }
        }

        // Show reasoning only if it's different from the message AND from last displayed
        if (hasReasoning && reasoning && reasoning !== lastDisplayedReasoning && reasoning !== message) {
          lastDisplayedReasoning = reasoning
          await revealReasoning(reasoning)
        }

        console.log("")

        const summary = response.summary as Record<string, unknown> | null
        if (summary && summary.memoryUpdated) {
          console.log("  " + boxTop("MEMORY", 36))
          if (summary.patternSaved) {
            console.log("  " + boxMid(colors.bright(`Pattern: ${summary.patternSaved}`)))
          }
          console.log("  " + boxMid(colors.muted("Shared with the whole team.")))
          console.log("  " + boxBot(36))
          console.log("")
        }

        if (taskSteps.length > 0) {
          console.log("  " + boxTop(`${completedSteps.size}/${taskSteps.length} COMPLETE`, 36))
          for (const s of taskSteps) {
            const done = completedSteps.has(s.id)
            console.log("  " + boxMid(`${done ? stepIcon("completed") : stepIcon(undefined)} ${done ? stepLabel(s.label, "completed") : stepLabel(s.label, undefined)}`))
          }
          console.log("  " + boxBot(36))
          console.log("")
        }

        // Display the completion message with markdown rendering
        if (message) {
          const rendered = renderMarkdown(message)
          const renderedLines = rendered.split("\n")
          console.log("  " + boxTop("SUMMARY", 50))
          for (const line of renderedLines) {
            console.log("  " + boxMid(line, 50))
          }
          console.log("  " + boxBot(50))
          console.log("")
        }

        // Animated completion line
        const doneText = `  ${colors.success(BOX.check)} done`
        const stepText = colors.muted(` ${BOX.dash} ${stepCount} steps`)
        process.stdout.write(doneText)
        await sleep(60)
        console.log(stepText)
        console.log("")
        return response
      }

      case "waiting_for_user": {
        spinner.stop()
        console.log("")
        const questionText = (response.message || response.content || "Waiting for your input") as string
        // Render the question with markdown formatting
        const renderedQ = renderMarkdown(questionText)
        for (const qLine of renderedQ.split("\n")) {
          console.log("  " + boxMid(qLine, 50))
        }
        console.log("")

        // Prompt user for input
        const userAnswer = await askUser(questionText)

        if (!userAnswer || userAnswer.toLowerCase() === "quit" || userAnswer.toLowerCase() === "exit") {
          console.log(colors.muted("  cancelled."))
          console.log("")
          return response
        }

        // Send user's answer back to the server and continue the loop
        spinner.start(colors.muted("thinking..."))
        try {
          response = await makeServerCall({
            type: "tool_result",
            runId: response.runId,
            tool: "_user_response",
            result: { answer: userAnswer, success: true }
          }, (label) => { spinner.text = colors.muted(label) })
        } catch (userErr) {
          if ((userErr as ServerError).code === "USAGE_LIMIT") {
            // Rate limit during user response — wait and retry
            rateLimitRetries++
            const waitMs = Math.min(10000 * rateLimitRetries, MAX_RATE_LIMIT_BACKOFF)
            spinner.stop()
            console.log(colors.warning(`  ⚠ Usage limit — waiting ${Math.round(waitMs / 1000)}s...`))
            await sleep(waitMs)
            spinner.start(colors.muted("retrying..."))
          }
          response = await callServer({
            type: "tool_result",
            runId: response.runId,
            tool: "_user_response",
            result: { answer: userAnswer, success: true }
          })
        }
        break
      }

      case "failed": {
        const errorMsg = (response.error as string) || "Agent failed"
        const isSessionExpired = errorMsg.includes("Session expired") || errorMsg.includes("Run not found")
        const isRateLimited = errorMsg.includes("rate limit") || errorMsg.includes("Rate limit") || errorMsg.includes("429") || errorMsg.includes("quota") || errorMsg.includes("RESOURCE_EXHAUSTED") || errorMsg.includes("auto-retry")
        const isUsageLimit = errorMsg.includes("Usage limit") || errorMsg.includes("usage_limit")

        // Session expired — don't retry, just tell the user
        if (isSessionExpired) {
          spinner.stop()
          console.log("")
          console.log(colors.warning("  Session expired (server was restarted)."))
          console.log(colors.muted("  Run your prompt again with ") + colors.accent("sys \"your prompt\"") + colors.muted(" or ") + colors.accent("sys continue"))
          console.log("")
          return response
        }

        // ─── Task-driven: auto-retry rate limits with exponential backoff ───
        if (isRateLimited && rateLimitRetries < MAX_RATE_LIMIT_RETRIES && response.runId) {
          rateLimitRetries++
          spinner.stop()
          console.log(colors.warning(`  ⚠ Rate limited — waiting ${Math.round(rateLimitBackoffMs / 1000)}s (retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})`))
          console.log(colors.muted("    Server will try fallback models automatically."))
          await sleep(rateLimitBackoffMs)
          rateLimitBackoffMs = Math.min(rateLimitBackoffMs * 2, MAX_RATE_LIMIT_BACKOFF)
          spinner.start(colors.muted("retrying after rate limit..."))
          try {
            response = await makeServerCall({
              type: "tool_result",
              runId: response.runId,
              tool: "_recovery",
              result: {
                error: errorMsg,
                success: false,
                hint: "Rate limit was hit. The system waited and is retrying. Continue with the task using fewer tokens if possible."
              }
            }, (label) => { spinner.text = colors.muted(label) })
          } catch (retryErr) {
            if ((retryErr as ServerError).code === "USAGE_LIMIT") {
              // Usage limit during retry — wait longer
              rateLimitRetries++
              const waitMs = Math.min(rateLimitBackoffMs * 2, MAX_RATE_LIMIT_BACKOFF)
              spinner.stop()
              console.log(colors.warning(`  ⚠ Usage limit during retry — waiting ${Math.round(waitMs / 1000)}s`))
              await sleep(waitMs)
              spinner.start(colors.muted("retrying..."))
              response = { ...response, status: "failed", error: errorMsg }
            } else {
              response = await callServer({
                type: "tool_result",
                runId: response.runId,
                tool: "_recovery",
                result: { error: errorMsg, success: false }
              })
            }
          }
          break
        }

        // ─── Task-driven: auto-retry usage limits ───
        if (isUsageLimit && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
          rateLimitRetries++
          const waitMs = Math.min(30000 * rateLimitRetries, MAX_RATE_LIMIT_BACKOFF)
          spinner.stop()
          console.log(colors.warning(`  ⚠ Usage limit — waiting ${Math.round(waitMs / 1000)}s (retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES})`))
          await sleep(waitMs)
          spinner.start(colors.muted("retrying after usage limit..."))
          // Re-send the last state to the server
          if (response.runId) {
            try {
              response = await makeServerCall({
                type: "tool_result",
                runId: response.runId,
                tool: "_recovery",
                result: { error: errorMsg, success: false, hint: "Usage limit was hit. Reduce token usage and continue the task." }
              }, (label) => { spinner.text = colors.muted(label) })
            } catch {
              response = { ...response, status: "failed", error: errorMsg }
            }
          }
          break
        }

        // ─── Task-driven: auto-retry generic failures if task is in progress ───
        if (stepCount > 0 && failureRetries < MAX_FAILURE_RETRIES && response.runId) {
          failureRetries++
          consecutiveErrors++
          spinner.stop()

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && failureRetries >= MAX_FAILURE_RETRIES) {
            // Truly exhausted — give up
            console.log(colors.error(`  ${BOX.cross} ${errorMsg}`))
            console.log(colors.error(`  Task failed after ${failureRetries} retries and ${consecutiveErrors} consecutive errors.`))
            console.log("")
            throw new Error(errorMsg)
          }

          console.log(colors.error(`  ${BOX.cross} ${errorMsg}`))
          console.log(colors.muted(`    Auto-retrying (${failureRetries}/${MAX_FAILURE_RETRIES})...`))
          spinner.start(colors.muted("retrying..."))
          try {
            response = await makeServerCall({
              type: "tool_result",
              runId: response.runId,
              tool: "_recovery",
              result: {
                error: errorMsg,
                success: false,
                hint: "Please fix the issue and continue. Do NOT give up. Respond with needs_tool to take the next action."
              }
            }, (label) => { spinner.text = colors.muted(label) })
          } catch {
            response = await callServer({
              type: "tool_result",
              runId: response.runId,
              tool: "_recovery",
              result: { error: errorMsg, success: false, hint: "Continue the task." }
            })
          }
          break
        }

        spinner.fail(colors.error(errorMsg))
        if (rateLimitRetries > 0 || failureRetries > 0) {
          console.log(colors.muted(`  Exhausted retries: ${rateLimitRetries} rate limit, ${failureRetries} failure retries`))
        }
        throw new Error(errorMsg)
      }

      case "needs_tool": {
        stepCount++
        // Reset failure counters on successful progress
        consecutiveErrors = 0
        failureRetries = 0
        // Gradually reduce rate limit backoff on success
        if (rateLimitBackoffMs > 5000) {
          rateLimitBackoffMs = Math.max(5000, rateLimitBackoffMs / 2)
        }

        // Handle step transitions from AI
        const stepTransition = response.stepTransition as { complete?: string; start?: string } | undefined
        if (stepTransition) {
          if (stepTransition.complete) {
            completedSteps.add(stepTransition.complete)
          }
        }

        const toolCalls = response.tools as Array<{ id: string; tool: string; args: Record<string, unknown> }> | undefined
        const isParallel = toolCalls && toolCalls.length > 1

        // Show task on first tool call
        const task = response.task as Record<string, unknown> | null
        if (task && !taskShown) {
          spinner.stop()
          taskShown = true
          taskSteps = (task.steps || []) as Array<{ id: string; label: string; status?: string }>

          console.log("")
          console.log("  " + boxTop("TASK", 42))
          console.log("  " + boxMid(colors.bright.bold(task.title as string)))
          console.log("  " + boxMid(colors.muted(task.goal as string)))
          console.log("  " + boxMid(""))

          for (let i = 0; i < taskSteps.length; i++) {
            const s = taskSteps[i]
            console.log("  " + boxMid(`${stepIcon(s.status)} ${stepLabel(s.label, s.status)}`))
          }
          console.log("  " + boxBot(42))
          console.log("")

          spinner.start(colors.muted("thinking..."))
        }

        // Update step display from task in response
        if (task?.steps) {
          const steps = task.steps as Array<{ id: string; status?: string }>
          for (const s of steps) {
            if (s.status === "completed" && s.id) completedSteps.add(s.id)
          }
        }

        if (isParallel) {
          // ═══ PARALLEL EXECUTION PATH ═══
          spinner.stop()

          if (hasReasoning && response.reasoning && response.reasoning !== lastDisplayedReasoning) {
            lastDisplayedReasoning = response.reasoning as string
            await revealReasoning(response.reasoning as string)
          }

          // Check if any tools are shell commands
          const hasCommands = toolCalls!.some((tc) => tc.tool === "run_command")

          // Show batch header
          console.log("")
          const batchLabel = hasCommands ? "batch" : "parallel"
          console.log(colors.accent(`    ${BOX.tl}${BOX.h}${BOX.h} ${batchLabel} `) + colors.muted(`(${toolCalls!.length} tools)`))

          // List tools
          for (let i = 0; i < toolCalls!.length; i++) {
            const tc = toolCalls![i]
            const label = formatToolLabel(tc.tool, tc.args)
            await sleep(30)
            console.log(colors.accent(`    ${BOX.v}`) + `  ${colors.muted(BOX.ring)} ` + (label || `${tc.tool} ${JSON.stringify(tc.args)}`))
          }

          if (hasCommands) {
            // Commands present — run everything without spinner (commands need terminal)
            console.log("")
            try {
              response = await executeToolsBatch(toolCalls!, response.runId as string)
            } catch (batchError) {
              consecutiveErrors++
              console.log(colors.accent(`    ${BOX.bl}${BOX.h}${BOX.h}`) + ` ${colors.error("error:")} ` + colors.muted((batchError as Error).message))

              if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                console.log(colors.error(`\n  aborted: ${MAX_CONSECUTIVE_ERRORS} consecutive errors`))
                throw new Error("Too many consecutive tool errors")
              }

              spinner.start(colors.muted("thinking..."))
              response = await callServer({
                type: "tool_result",
                runId: response.runId,
                tool: "_recovery",
                result: { error: (batchError as Error).message, success: false }
              })
              break
            }
            consecutiveErrors = 0
            console.log(colors.accent(`    ${BOX.bl}${BOX.h}${BOX.h}`) + ` ${colors.success("done")}`)
            console.log("")
            spinner.start(colors.muted("thinking..."))
            break
          }

          // Pure file operations — run with spinner
          spinner.start(colors.muted(`  executing ${toolCalls!.length} tools...`))

          try {
            response = await executeToolsBatch(toolCalls!, response.runId as string, (label) => {
              spinner.text = colors.muted(`  ${label}`)
            })
            consecutiveErrors = 0
            spinner.stop()

            // Animated completion: mark each tool done
            process.stdout.write(`\x1b[${toolCalls!.length}A`)
            for (let i = 0; i < toolCalls!.length; i++) {
              const tc = toolCalls![i]
              const label = formatToolLabel(tc.tool, tc.args)
              process.stdout.write("\r\x1b[K")
              console.log(colors.accent(`    ${BOX.v}`) + `  ${colors.success(BOX.check)} ` + (label || `${tc.tool}`))
              await sleep(50)
            }

            console.log(colors.accent(`    ${BOX.bl}${BOX.h}${BOX.h}`) + ` ${colors.success("done")}`)
            console.log("")
            spinner.start(colors.muted("thinking..."))
          } catch (batchError) {
            consecutiveErrors++
            spinner.stop()
            console.log(colors.accent(`    ${BOX.bl}${BOX.h}${BOX.h}`) + ` ${colors.error("error:")} ` + colors.muted((batchError as Error).message))

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              console.log(colors.error(`\n  aborted: ${MAX_CONSECUTIVE_ERRORS} consecutive errors`))
              throw new Error("Too many consecutive tool errors")
            }

            spinner.start(colors.muted("thinking..."))
            response = await callServer({
              type: "tool_result",
              runId: response.runId,
              tool: "_recovery",
              result: { error: (batchError as Error).message, success: false }
            })
          }
          break
        }

        // ═══ SINGLE TOOL PATH ═══
        const pendingTaskStep = (response.taskStep as string) || null
        const args = response.args as Record<string, unknown>

        const actionKey = `${response.tool}:${JSON.stringify(args)}:${response.reasoning || ""}`
        const isDuplicate = actionKey === lastDisplayedAction
        lastDisplayedAction = actionKey

        await sleep(hasReasoning ? 200 : 100 + Math.floor(Math.random() * 150))

        if (isHiddenStep(response.tool as string)) {
          spinner.text = colors.muted("scanning directory...")
        } else if (isDuplicate) {
          spinner.stop()
          spinner.start(colors.muted("thinking..."))
        } else {
          if (hasReasoning && response.reasoning && response.reasoning !== lastDisplayedReasoning) {
            lastDisplayedReasoning = response.reasoning as string
            spinner.stop()
            await revealReasoning(response.reasoning as string)
          } else {
            spinner.stop()
          }

          if (response.tool === "batch_read") {
            const paths = (args.paths || []) as string[]
            console.log(`    ${colors.tool("read")} ${colors.muted(`${paths.length} files`)}`)
            for (const p of paths) {
              console.log(colors.muted(`      ${BOX.dot} ${p}`))
            }
          } else if (response.tool === "run_command") {
            const cmd = args.command as string
            // Check if this is an interactive command — stop spinner completely
            // Import the same patterns used by tools.ts
            const isInteractiveCmd = /^npx\s+(--yes\s+)?(create-|@nestjs\/cli|@angular\/cli|nuxi)|^npm\s+(create|init)|^yarn\s+create|^pnpm\s+create/.test(cmd.trim())
            if (isInteractiveCmd) {
              console.log(`    ${colors.accent(BOX.arrow)} ${colors.tool("run")} ${colors.bright(cmd)}`)
              console.log(colors.muted("    (interactive — answer prompts below)"))
            } else {
              spinner.start(colors.muted("  ") + colors.bright(cmd))
            }
          } else {
            const label = formatToolLabel(response.tool as string, args)
            const hasDiff = response.tool === "write_file" || response.tool === "edit_file"
            if (hasDiff) {
              const newContent = (args.content || args.patch || "") as string
              let oldContent: string | null = null
              try { oldContent = await readFileTool(args.path as string) } catch { /* new file */ }
              const { added, removed } = computeLineDiff(oldContent, newContent)
              const parts: string[] = []
              if (added > 0) parts.push(colors.success(`+${added}`))
              if (removed > 0) parts.push(colors.error(`-${removed}`))
              const diffTag = parts.length > 0 ? " " + parts.join(colors.muted(" ")) : ""
              console.log(`    ${colors.accent(BOX.arrow)} ${label}${diffTag}`)
            } else {
              console.log(`    ${colors.accent(BOX.arrow)} ${label}`)
            }
          }

          if (response.tool !== "run_command") {
            spinner.start(colors.muted("thinking..."))
          }
        }

        const currentTool = response.tool as string
        const currentCmd = args?.command as string | undefined

        try {
          response = await executeTool(response as never, (label) => {
            spinner.text = colors.muted(label)
          })
          consecutiveErrors = 0

          if (currentTool === "run_command") {
            spinner.stop()
            const toolResult = response.lastToolResult as Record<string, unknown> | undefined
            if (toolResult?.skipped) {
              console.log(colors.warning(`  ⚠ `) + colors.muted(currentCmd) + colors.warning(" (run manually)"))
            } else if (toolResult?.timedOut) {
              console.log(colors.warning(`  ⏱ `) + colors.muted(currentCmd) + colors.warning(" (timed out)"))
              console.log(colors.warning("  command timed out — continuing task..."))
            } else if (toolResult?.interactive) {
              console.log("")
              console.log(`  ${colors.success(BOX.check)} ` + colors.muted(currentCmd) + colors.success(" (done)"))
              console.log(colors.accent("  continuing task..."))
            } else {
              console.log(`  ${colors.success(BOX.check)} ` + colors.muted(currentCmd))
            }
            spinner.start(colors.muted("thinking..."))
          }

          if (pendingTaskStep && taskSteps.length > 0) {
            const step = taskSteps.find((s) => s.id === pendingTaskStep)
            if (step) completedSteps.add(step.id)
          }
        } catch (toolError) {
          consecutiveErrors++
          spinner.stop()
          if (currentTool === "run_command") {
            console.log(colors.error(`  ${BOX.cross} `) + colors.muted(currentCmd) + colors.error(` — ${(toolError as Error).message}`))
          } else {
            console.log(colors.error(`    ${BOX.cross} ${(toolError as Error).message}`))
          }

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.log(colors.error(`\n  aborted: ${MAX_CONSECUTIVE_ERRORS} consecutive errors`))
            console.log("")
            throw new Error("Too many consecutive tool errors")
          }

          spinner.start(colors.muted("thinking..."))
          response = await callServer({
            type: "tool_result",
            runId: response.runId,
            tool: response.tool,
            result: {
              error: (toolError as Error).message,
              success: false
            }
          })
        }
        break
      }

      default:
        spinner.stop()
        throw new Error(`Unexpected status: ${response.status}`)
    }
  }
}
