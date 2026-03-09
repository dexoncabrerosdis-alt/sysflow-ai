import { parseCliInput } from "./cli/parser.js"
import { ensureSysbase, setSelectedModel, getSelectedModel, MODELS } from "./lib/sysbase.js"
import { runAgent } from "./agent/agent.js"
import { startUi } from "./cli/ui.js"
import { showModelPicker } from "./commands/model.js"
import { handleLogin, handleRegister, handleLogout, handleWhoami } from "./commands/auth.js"
import { showChats, deleteActiveChat } from "./commands/chats.js"
import { showPlanPicker, showUsage } from "./commands/billing.js"

async function main() {
  const args = process.argv.slice(2)

  // No args = interactive mode
  if (args.length === 0) {
    await startUi()
    return
  }

  const parsed = parseCliInput(args)

  if (parsed.mode === "ui") {
    await startUi()
    return
  }

  if (parsed.mode === "login") {
    await handleLogin()
    return
  }

  if (parsed.mode === "register") {
    await handleRegister()
    return
  }

  if (parsed.mode === "logout") {
    await handleLogout()
    return
  }

  if (parsed.mode === "whoami") {
    await handleWhoami()
    return
  }

  if (parsed.mode === "chats") {
    await showChats()
    return
  }

  if (parsed.mode === "delete-chat") {
    await deleteActiveChat()
    return
  }

  if (parsed.mode === "billing") {
    await showPlanPicker()
    return
  }

  if (parsed.mode === "usage") {
    await showUsage()
    return
  }

  if (parsed.mode === "model") {
    await ensureSysbase()
    if (parsed.model) {
      await setSelectedModel(parsed.model)
      console.log(`  model set to ${parsed.model}`)
    } else {
      await showModelPicker()
    }
    return
  }

  if (parsed.mode === "noop") {
    return
  }

  await runAgent({
    prompt: parsed.prompt,
    command: parsed.command
  })
}

main().catch((error) => {
  console.error(`  error: ${error.message}`)
  process.exit(1)
})
