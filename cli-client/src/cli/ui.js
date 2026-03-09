import path from "node:path"
import readline from "node:readline"
import chalk from "chalk"
import { ensureSysbase, getSelectedModel, setSelectedModel, getAuthUser, getActiveChatInfo } from "../lib/sysbase.js"
import { runAgent } from "../agent/agent.js"
import { parseUiLine } from "./parser.js"

const PROMPT = chalk.blue("  | ")

export async function startUi() {
  await ensureSysbase()
  const currentModel = await getSelectedModel()
  const user = await getAuthUser()
  const chatInfo = await getActiveChatInfo()

  console.log("")
  const userTag = user ? chalk.green(user.username) : chalk.yellow("not logged in")
  const chatTag = chatInfo?.title ? chalk.cyan(chatInfo.title) : chalk.dim("no chat")
  console.log(chalk.dim(`  sys v0.1  ${chalk.white(path.basename(process.cwd()))}  model: ${chalk.white(currentModel)}  user: ${userTag}  chat: ${chatTag}`))
  console.log(chalk.dim("  /model /chats /billing /usage /login /whoami /continue /exit"))
  console.log("")

  let working = false

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT
  })

  rl.prompt()

  rl.on("line", async (line) => {
    if (working) return

    const parsed = parseUiLine(line)

    if (!parsed) {
      rl.prompt()
      return
    }

    if (parsed.mode === "exit") {
      console.log(chalk.dim("  bye"))
      rl.close()
      return
    }

    if (parsed.mode === "login") {
      const { handleLogin } = await import("./auth.js")
      await handleLogin()
      rl.prompt()
      return
    }

    if (parsed.mode === "register") {
      const { handleRegister } = await import("./auth.js")
      await handleRegister()
      rl.prompt()
      return
    }

    if (parsed.mode === "logout") {
      const { handleLogout } = await import("./auth.js")
      await handleLogout()
      rl.prompt()
      return
    }

    if (parsed.mode === "whoami") {
      const { handleWhoami } = await import("./auth.js")
      await handleWhoami()
      rl.prompt()
      return
    }

    if (parsed.mode === "chats") {
      const { showChats } = await import("./chat-picker.js")
      await showChats()
      rl.prompt()
      return
    }

    if (parsed.mode === "delete-chat") {
      const { deleteActiveChat } = await import("./chat-picker.js")
      await deleteActiveChat()
      rl.prompt()
      return
    }

    if (parsed.mode === "billing") {
      const { showPlanPicker } = await import("./billing.js")
      await showPlanPicker()
      rl.prompt()
      return
    }

    if (parsed.mode === "usage") {
      const { showUsage } = await import("./billing.js")
      await showUsage()
      rl.prompt()
      return
    }

    if (parsed.mode === "model") {
      if (parsed.model) {
        await setSelectedModel(parsed.model)
        console.log(chalk.green(`  model set to ${parsed.model}`))
      } else {
        const { showModelPicker } = await import("./model-picker.js")
        await showModelPicker()
      }
      console.log("")
      rl.prompt()
      return
    }

    working = true
    rl.pause()
    // Clear the prompt line so | doesn't bleed into agent output
    process.stdout.write("\r\x1B[K")

    try {
      await runAgent({
        prompt: parsed.prompt,
        command: parsed.command
      })
    } catch (error) {
      console.log(chalk.red(`  error: ${error.message}`))
    }

    working = false
    console.log("")
    rl.resume()
    rl.prompt()
  })

  rl.on("close", () => {
    process.exit(0)
  })
}
