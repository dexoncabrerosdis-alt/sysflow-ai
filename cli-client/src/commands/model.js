import readline from "node:readline"
import chalk from "chalk"
import { MODELS, VISIBLE_MODELS, getSelectedModel, setSelectedModel, getReasoningEnabled, setReasoningEnabled, ensureSysbase } from "../lib/sysbase.js"

function arrowPicker(items, startIndex, title) {
  let index = startIndex

  const totalLines = items.length * 2

  console.log("")
  console.log(chalk.white.bold(`  ${title}`) + chalk.dim("  (up/down, enter)"))
  console.log("")

  function render() {
    const lines = []
    for (let i = 0; i < items.length; i++) {
      const isSelected = i === index
      const pointer = isSelected ? chalk.blue("  > ") : "    "
      const label = isSelected ? chalk.white.bold(items[i].label) : chalk.dim(items[i].label)
      const tag = items[i].tag || ""
      const desc = chalk.dim(`      ${items[i].desc}`)
      lines.push(`${pointer}${label}${tag}`)
      lines.push(desc)
    }
    return lines
  }

  // Draw initial
  const initial = render()
  for (const line of initial) console.log(line)

  return new Promise((resolve) => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    readline.emitKeypressEvents(stdin)
    stdin.resume()

    function redraw() {
      process.stdout.write(`\x1b[${totalLines}A`)
      const lines = render()
      for (const line of lines) {
        process.stdout.write(`\x1b[2K${line}\n`)
      }
    }

    function onKeypress(str, key) {
      if (!key) return

      if (key.name === "up") {
        index = (index - 1 + items.length) % items.length
        redraw()
      } else if (key.name === "down") {
        index = (index + 1) % items.length
        redraw()
      } else if (key.name === "return") {
        stdin.removeListener("keypress", onKeypress)
        stdin.setRawMode(false)
        stdin.pause()
        resolve(index)
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        stdin.removeListener("keypress", onKeypress)
        stdin.setRawMode(false)
        stdin.pause()
        resolve(-1)
      }
    }

    stdin.on("keypress", onKeypress)
  })
}

export async function showModelPicker() {
  await ensureSysbase()
  const current = await getSelectedModel()
  const currentReasoning = await getReasoningEnabled()

  // Step 1: Pick model (only show visible models)
  const displayModels = VISIBLE_MODELS.length > 0 ? VISIBLE_MODELS : MODELS
  const modelItems = displayModels.map((m) => ({
    label: m.label,
    desc: m.desc,
    tag: m.id === current ? chalk.green(" (current)") : ""
  }))

  let startIndex = displayModels.findIndex((m) => m.id === current)
  if (startIndex < 0) startIndex = 0

  const modelChoice = await arrowPicker(modelItems, startIndex, "Select a model:")

  if (modelChoice === -1) {
    console.log("")
    console.log(chalk.dim("  cancelled"))
    console.log("")
    return
  }

  const selected = displayModels[modelChoice]
  await setSelectedModel(selected.id)

  // Step 2: Pick reasoning mode
  const reasoningItems = [
    { label: "Reasoning", desc: "Visible AI thinking before each action" },
    { label: "No reasoning (faster)", desc: "Skip reasoning output, faster execution" }
  ]
  const reasoningStart = currentReasoning ? 0 : 1

  const reasoningChoice = await arrowPicker(reasoningItems, reasoningStart, "Reasoning mode:")

  if (reasoningChoice === -1) {
    console.log("")
    console.log(chalk.green(`  switched to ${selected.label}`))
    console.log("")
    return
  }

  const reasoning = reasoningChoice === 0
  await setReasoningEnabled(reasoning)

  console.log("")
  console.log(chalk.green(`  ${selected.label}`) + chalk.dim(reasoning ? " with reasoning" : " fast mode"))
  console.log("")
}
