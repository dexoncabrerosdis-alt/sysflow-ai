import os from "node:os"
import path from "node:path"
import chalk from "chalk"
import ora from "ora"
import { callServer } from "../lib/server.js"
import { ensureSysbase, getSelectedModel, getSysbasePath, getReasoningEnabled, getAuthToken } from "../lib/sysbase.js"
import { executeTool } from "./executor.js"
import { scanDirectoryTree, readFileTool, computeLineDiff } from "./tools.js"
import { ensureActiveChat } from "../commands/chats.js"

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function thinkTime() {
  return 800 + Math.floor(Math.random() * 1400)
}

async function typeReasoning(text) {
  const prefix = chalk.dim("    ")
  process.stdout.write(prefix)

  const words = text.split(" ")
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    for (const char of word) {
      process.stdout.write(chalk.dim(char))
      await sleep(18 + Math.floor(Math.random() * 30))
    }
    if (i < words.length - 1) {
      process.stdout.write(chalk.dim(" "))
      if (word.endsWith(",") || word.endsWith(".") || word.endsWith("--")) {
        await sleep(80 + Math.floor(Math.random() * 120))
      } else {
        await sleep(10 + Math.floor(Math.random() * 20))
      }
    }
  }
  process.stdout.write("\n")
  await sleep(300 + Math.floor(Math.random() * 200))
}

function formatToolLabel(tool, args) {
  switch (tool) {
    case "read_file":
      return chalk.blue("read") + " " + args.path
    case "batch_read":
      return null // handled separately
    case "write_file":
      return chalk.blue("create") + " " + args.path
    case "edit_file":
      return chalk.blue("edit") + " " + args.path
    case "create_directory":
      return chalk.blue("mkdir") + " " + args.path
    case "move_file":
      return chalk.blue("move") + " " + args.from + " -> " + args.to
    case "delete_file":
      return chalk.blue("delete") + " " + args.path
    case "file_exists":
      return chalk.blue("check") + " " + args.path
    case "search_code":
      return chalk.blue("search") + ` "${args.pattern}"`
    case "run_command":
      return chalk.blue("run") + " " + args.command
    default:
      return chalk.blue(tool) + " " + JSON.stringify(args)
  }
}

function isHiddenStep(tool) {
  return tool === "list_directory"
}

function resolveFileMentions(prompt, cwd) {
  // Match @filepath patterns (e.g. @src/app.js, @package.json)
  const mentions = []
  const resolved = prompt.replace(/@([\w./-]+)/g, (match, filePath) => {
    const absolute = path.resolve(cwd, filePath)
    mentions.push({ path: filePath, absolute })
    return filePath
  })
  return { prompt: resolved, mentions }
}

export async function runAgent({ prompt, command = null, model = null }) {
  await ensureSysbase()

  // Require login before prompting
  const authToken = await getAuthToken()
  if (!authToken) {
    console.log("")
    console.log(chalk.yellow("  ⚠ You must be logged in to use Sysflow"))
    console.log("")
    console.log(chalk.dim("  Run ") + chalk.cyan("sys login") + chalk.dim(" or ") + chalk.cyan("sys register") + chalk.dim(" to get started"))
    console.log("")
    return
  }

  const selectedModel = model || (await getSelectedModel())
  const hasReasoning = await getReasoningEnabled()

  // Ensure there's an active chat session (auto-creates if logged in)
  const chatUid = await ensureActiveChat()
  if (!chatUid) {
    console.log("")
    console.log(chalk.yellow("  ⚠ Could not establish a chat session"))
    console.log(chalk.dim("  Check your connection and try again, or run ") + chalk.cyan("sys chat") + chalk.dim(" to select one"))
    console.log("")
    return
  }

  // Resolve @file mentions
  const { prompt: cleanPrompt, mentions } = resolveFileMentions(prompt, process.cwd())

  // Read mentioned files
  const mentionedFiles = []
  for (const m of mentions) {
    try {
      const content = await readFileTool(m.absolute)
      mentionedFiles.push({ path: m.path, content })
    } catch {
      // file doesn't exist, skip
    }
  }

  // Scan directory tree and send it with the initial request
  const dirTree = await scanDirectoryTree(process.cwd())

  console.log("")

  const spinner = ora({
    text: chalk.dim("thinking..."),
    prefixText: " ",
    spinner: "dots",
    color: "cyan"
  }).start()

  let response
  try {
    response = await callServer({
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
      client: {
        platform: os.platform(),
        arch: os.arch()
      }
    })
  } catch (err) {
    spinner.stop()
    if (err.code === "USAGE_LIMIT") {
      console.log("")
      console.log(chalk.yellow("  ⚠ " + err.message))
      console.log("")
      console.log(chalk.dim("  Run ") + chalk.cyan("sys billing") + chalk.dim(" to upgrade your plan"))
      console.log("")
      return
    }
    throw err
  }

  let stepCount = 0
  let taskShown = false
  let taskSteps = []
  const completedSteps = new Set()
  let consecutiveErrors = 0
  const MAX_CONSECUTIVE_ERRORS = 3
  let lastDisplayedAction = null

  while (true) {
    switch (response.status) {
      case "completed": {
        spinner.stop()

        if (hasReasoning && response.reasoning) {
          await typeReasoning(response.reasoning)
        }

        console.log("")

        if (response.summary && response.summary.memoryUpdated) {
          console.log(chalk.dim("  ───────────────────────────────────"))
          console.log(chalk.yellow.bold("  MEMORY SAVED"))
          if (response.summary.patternSaved) {
            console.log(chalk.white(`  Pattern: ${response.summary.patternSaved}`))
          }
          console.log(chalk.dim("  This is now shared with the whole team."))
          console.log("")
        }

        // Show completed task summary
        if (taskSteps.length > 0) {
          console.log(chalk.dim("  ───────────────────────────────────"))
          console.log(chalk.white.bold(`  ${completedSteps.size}/${taskSteps.length} tasks completed`))
          console.log("")
          for (const s of taskSteps) {
            if (completedSteps.has(s.id)) {
              console.log(chalk.green(`  [x] ${s.label}`))
            } else {
              console.log(chalk.dim(`  [ ] ${s.label}`))
            }
          }
          console.log("")
        }

        console.log(chalk.green(`  done.`) + chalk.dim(` ${stepCount} steps`))
        console.log("")
        return response
      }

      case "waiting_for_user":
        spinner.stop()
        console.log(chalk.yellow(`\n  paused: ${response.message || "Waiting for user"}`))
        return response

      case "failed": {
        // If the AI gave up mid-run, give it one more shot by sending the failure
        // back as a tool result so it can try to recover
        if (stepCount > 0 && consecutiveErrors < MAX_CONSECUTIVE_ERRORS && response.runId) {
          consecutiveErrors++
          spinner.stop()
          console.log(chalk.red(`  ✖ ${response.error || "Model reported failure"}`))
          spinner.start(chalk.dim("retrying..."))
          response = await callServer({
            type: "tool_result",
            runId: response.runId,
            tool: "_recovery",
            result: {
              error: response.error || "Previous step failed",
              success: false,
              hint: "Please fix the issue and continue. Do NOT give up. Respond with needs_tool to take the next action."
            }
          })
          break
        }
        spinner.fail(chalk.red(response.error || "Agent failed"))
        throw new Error(response.error || "Agent failed")
      }

      case "needs_tool": {
        stepCount++

        // Track which task step this action will complete (marked after execution)
        const pendingTaskStep = response.taskStep || null

        // Dedup: skip display if model returned the exact same action twice
        const actionKey = `${response.tool}:${JSON.stringify(response.args)}:${response.reasoning || ""}`
        const isDuplicate = actionKey === lastDisplayedAction
        lastDisplayedAction = actionKey

        // Simulate LLM think time (faster without reasoning)
        await sleep(hasReasoning ? thinkTime() : 200 + Math.floor(Math.random() * 400))

        if (isHiddenStep(response.tool)) {
          spinner.text = chalk.dim("scanning directory...")
        } else if (isDuplicate) {
          // Model repeated itself — skip display, still execute the tool
          spinner.stop()
          spinner.start(chalk.dim("thinking..."))
        } else {
          // Show reasoning with typing animation (only if model supports it)
          if (hasReasoning && response.reasoning) {
            spinner.stop()
            await typeReasoning(response.reasoning)
          } else {
            spinner.stop()
          }

          // Show task checklist after first reasoning
          if (response.task && !taskShown) {
            taskShown = true
            taskSteps = response.task.steps || []
            console.log("")
            console.log(chalk.white.bold(`  TASK: ${response.task.title}`))
            console.log(chalk.dim(`  ${response.task.goal}`))
            console.log("")
            for (const s of taskSteps) {
              console.log(chalk.dim(`  [ ] ${s.label}`))
            }
            console.log("")
          }

          // Handle batch_read specially — show grouped list
          if (response.tool === "batch_read") {
            const paths = response.args.paths
            console.log(chalk.blue("    read") + chalk.dim(` ${paths.length} files`))
            for (const p of paths) {
              console.log(chalk.dim(`      ${p}`))
            }
          } else if (response.tool === "run_command") {
            // Show command inline with spinner
            const cmd = response.args.command
            spinner.start(chalk.dim("  ") + chalk.white(cmd))
          } else {
            const label = formatToolLabel(response.tool, response.args)
            const hasDiff = response.tool === "write_file" || response.tool === "edit_file"
            if (hasDiff) {
              const newContent = response.args.content || response.args.patch || ""
              let oldContent = null
              try { oldContent = await readFileTool(response.args.path) } catch { /* new file */ }
              const { added, removed } = computeLineDiff(oldContent, newContent)
              const parts = []
              if (added > 0) parts.push(chalk.green(`+${added}`))
              if (removed > 0) parts.push(chalk.red(`-${removed}`))
              const diffTag = parts.length > 0 ? " " + parts.join(chalk.dim(" ")) : ""
              console.log(chalk.green("    + ") + label + diffTag)
            } else {
              console.log(chalk.green("    + ") + label)
            }
          }

          // Don't start thinking spinner for run_command (it already has inline spinner)
          if (response.tool !== "run_command") {
            spinner.start(chalk.dim("thinking..."))
          }
        }

        const currentTool = response.tool
        const currentCmd = response.args?.command

        try {
          response = await executeTool(response)
          consecutiveErrors = 0

          // After run_command completes, replace spinner with done indicator
          if (currentTool === "run_command") {
            spinner.stop()
            // Check if the tool result indicates skipped/timed out
            const toolResult = response.result || response.lastResult
            if (toolResult?.skipped) {
              console.log(chalk.yellow("  ⚠ ") + chalk.dim(currentCmd) + chalk.yellow(" (user should run manually)"))
            } else if (toolResult?.timedOut) {
              console.log(chalk.yellow("  ⏱ ") + chalk.dim(currentCmd) + chalk.yellow(" (timed out)"))
            } else {
              console.log(chalk.green("  ✓ ") + chalk.dim(currentCmd))
            }
            spinner.start(chalk.dim("thinking..."))
          }

          // Mark task step as completed after successful execution
          if (pendingTaskStep && taskSteps.length > 0) {
            const step = taskSteps.find((s) => s.id === pendingTaskStep)
            if (step) completedSteps.add(step.id)
          }
        } catch (toolError) {
          consecutiveErrors++
          spinner.stop()
          if (currentTool === "run_command") {
            console.log(chalk.red("  ✖ ") + chalk.dim(currentCmd) + chalk.red(` — ${toolError.message}`))
          } else {
            console.log(chalk.red(`    x ${toolError.message}`))
          }

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.log(chalk.red(`\n  aborted: ${MAX_CONSECUTIVE_ERRORS} consecutive errors`))
            console.log("")
            throw new Error("Too many consecutive tool errors")
          }

          spinner.start(chalk.dim("thinking..."))
          response = await callServer({
            type: "tool_result",
            runId: response.runId,
            tool: response.tool,
            result: {
              error: toolError.message,
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
