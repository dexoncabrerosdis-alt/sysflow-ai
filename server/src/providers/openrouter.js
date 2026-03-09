/**
 * OpenRouter provider adapter
 *
 * Uses OpenAI-compatible API via OpenRouter to access free models.
 * Requires OPENROUTER_API_KEY in .env
 *
 * Supported model IDs:
 *   openrouter-auto    -> openrouter/auto (picks best free model)
 *   llama-70b          -> meta-llama/llama-3.3-70b-instruct:free
 *   mistral-small      -> mistralai/mistral-small-3.1-24b-instruct:free
 *   gemini-flash-or    -> google/gemini-2.0-flash-exp:free
 */

const API_URL = "https://openrouter.ai/api/v1/chat/completions"

const MODEL_MAP = {
  "openrouter-auto":  "openrouter/auto",
  "llama-70b":        "meta-llama/llama-3.3-70b-instruct:free",
  "mistral-small":    "mistralai/mistral-small-3.1-24b-instruct:free",
  "gemini-flash-or":  "google/gemini-2.0-flash-exp:free"
}

// Conversation history per run (multi-turn)
const runHistories = new Map()

const SYSTEM_PROMPT = `You are an AI coding agent. You help the user by performing actions on their codebase using tools.

IMPORTANT: All file paths are relative to the PROJECT ROOT (the current working directory ".").
- Place files in the project root: "package.json", "server.js", "src/app.js", etc.
- NEVER write files into the "sysbase/" directory. That folder is reserved for internal agent memory and is NOT part of the user's project.

You MUST respond with ONLY valid JSON. No markdown fences, no explanation outside JSON.

Response format:
{
  "kind": "needs_tool" | "completed" | "failed",
  "reasoning": "brief internal reasoning (1-2 sentences)",
  "tool": "tool_name or null",
  "args": { ... } or null,
  "content": "brief description of what you are doing"
}

Available tools:

1. list_directory — List files and folders
   args: { "path": "." }

2. read_file — Read a single file
   args: { "path": "src/app.js" }

3. batch_read — Read multiple files at once
   args: { "paths": ["src/app.js", "package.json"] }

4. write_file — Create or overwrite a file. "content" MUST be the COMPLETE file source code, never empty.
   args: { "path": "src/app.js", "content": "const express = require('express');\\nconst app = express();\\napp.get('/', (req, res) => res.send('Hello'));\\napp.listen(3000);" }

5. edit_file — Replace content in an existing file. "patch" MUST be the COMPLETE new file text.
   args: { "path": "src/app.js", "patch": "full new file content here" }

6. create_directory — Create a directory (recursive)
   args: { "path": "src/utils" }

7. search_code — Search for a pattern in files
   args: { "directory": ".", "pattern": "function auth" }

8. run_command — Run a shell command
   args: { "command": "npm install express", "cwd": "." }

9. move_file — Move or rename a file
   args: { "from": "old.js", "to": "new.js" }

10. delete_file — Delete a file
    args: { "path": "temp.js" }

CRITICAL RULES:
- All paths are relative to the project root. NEVER use "sysbase/" in any path.
- For write_file: args MUST include "path" and "content". Content must be the FULL file source code.
- For edit_file: args MUST include "path" and "patch". Patch must be the FULL new file content.
- Use "needs_tool" when you need to perform an action. Specify tool and args.
- Use "completed" when the task is fully done. Set tool and args to null.
- Use "failed" ONLY if the task is truly impossible (e.g. missing permissions, impossible request).
- If a tool returns an error, DO NOT give up. Analyze the error, fix the problem, and try again with "needs_tool". For example, if a test fails, fix the test file and re-run. If a command fails, adjust the command.
- ALWAYS VERIFY your work before completing. If you write tests, RUN them. If you write code, TEST it. If you edit a file, READ it back to confirm. Never say "done" without verifying the result actually works.
- If something already exists but the user asks you to work on it, CHECK if it actually works first. Don't assume existing code is correct.
- Always include "reasoning" with a short explanation.
- Write complete, production-quality code.
- Do one action at a time. You will be called again with the tool result.

TERMINAL COMMAND RULES:
- NEVER run long-running/server commands like "npm start", "npm run dev", "node server.js", "python app.py", etc. These will hang forever.
- If the task requires starting a server, DO NOT run it yourself. Instead, complete the task and tell the user to run it manually: "Run \`npm start\` to start the server."
- Only run short-lived commands: install deps (npm install), build (npm run build), run tests (npm test), linting, etc.
- If a command times out or is skipped, acknowledge it and move on. Do NOT retry server-start commands.
- When verifying a server app works, do NOT start it. Instead, check that the code is correct by reading the files and confirming the structure is right.

MEMORY RULES:
- You have access to session history showing your previous actions in this chat. USE IT.
- Do NOT re-read files you just wrote in the same run. You already know their content.
- Do NOT redo steps that already succeeded in previous runs (check session history).
- If continuing from an interrupted run, pick up exactly where it left off.`

function getApiKey() {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) {
    throw new Error("OPENROUTER_API_KEY is not set in .env")
  }
  return key
}

function getModelName(modelId) {
  return MODEL_MAP[modelId] || MODEL_MAP["openrouter-auto"]
}

function buildInitialUserMessage(payload) {
  let msg = ""

  // Inject session history so the AI knows what happened in previous runs
  if (payload.context?.sessionHistory) {
    msg += `${payload.context.sessionHistory}\n\n`
  }

  // If continuing, inject the detailed continuation context
  if (payload.context?.continueContext) {
    msg += `${payload.context.continueContext}\n\n`
  } else if (payload.context?.continueFrom) {
    // Fallback to basic continue context
    const prev = payload.context.continueFrom
    msg += `IMPORTANT: You are continuing a previous task that ${prev.outcome === "failed" ? "FAILED" : "was interrupted"}.\n`
    msg += `Previous prompt: "${prev.prompt}"\n`
    if (prev.error) msg += `Error that occurred: ${prev.error}\n`
    if (prev.filesModified.length > 0) msg += `Files already modified: ${prev.filesModified.join(", ")}\n`
    if (prev.actions.length > 0) {
      const actionStr = prev.actions.map((a) => a.tool + (a.path ? ` ${a.path}` : "")).join(", ")
      msg += `Actions already taken: ${actionStr}\n`
    }
    msg += `\nPick up where the previous run left off. Do NOT redo work that was already completed successfully.\n\n`
  }

  msg += `Task: ${payload.userMessage}`

  if (payload.directoryTree && payload.directoryTree.length > 0) {
    const filtered = payload.directoryTree.filter((e) => !e.name.startsWith("sysbase"))
    if (filtered.length > 0) {
      const treeStr = filtered
        .map((e) => `${e.type === "directory" ? "[dir]" : "[file]"} ${e.name}`)
        .join("\n")
      msg += `\n\nCurrent project structure:\n${treeStr}`
    }
  }

  if (payload.context?.projectMemory) {
    const mem = Array.isArray(payload.context.projectMemory)
      ? payload.context.projectMemory.join("\n")
      : String(payload.context.projectMemory)
    msg += `\n\nProject context:\n${mem}`
  }

  // Inject learned patterns/memories from DB
  if (payload.context?.projectKnowledge) {
    msg += `\n\n${payload.context.projectKnowledge}`
  }

  return msg
}

function parseResponse(text) {
  let json = null

  // Try direct parse
  try {
    json = JSON.parse(text)
  } catch {
    // Try to extract JSON from markdown fences or raw text
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch) {
      try { json = JSON.parse(fenceMatch[1].trim()) } catch { /* ignore */ }
    }
    if (!json) {
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try { json = JSON.parse(jsonMatch[0]) } catch { /* ignore */ }
      }
    }
  }

  if (!json || !json.kind) {
    return {
      kind: "completed",
      content: text || "Done.",
      reasoning: null
    }
  }

  const normalized = {
    kind: json.kind,
    content: json.content || "",
    reasoning: json.reasoning || null,
    usage: { inputTokens: 0, outputTokens: 0 }
  }

  if (json.kind === "needs_tool") {
    normalized.tool = json.tool
    normalized.args = json.args || {}
  }

  if (json.kind === "failed") {
    normalized.error = json.content || "Model reported failure"
  }

  return normalized
}

export async function callOpenRouterAdapter(payload) {
  const apiKey = getApiKey()
  const modelName = getModelName(payload.model)

  try {
    // Build or continue conversation history
    let history = runHistories.get(payload.runId)

    if (!payload.toolResult) {
      // First call — new conversation
      history = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildInitialUserMessage(payload) }
      ]
      runHistories.set(payload.runId, history)
    } else {
      // Continuation — add tool result to history
      if (!history) {
        // Session lost — start fresh with context
        history = [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Previous tool result:\n${JSON.stringify({
              tool: payload.toolResult.tool,
              result: payload.toolResult.result
            })}\n\nDecide the next action.`
          }
        ]
        runHistories.set(payload.runId, history)
      } else {
        history.push({
          role: "user",
          content: `Tool result:\n${JSON.stringify({
            tool: payload.toolResult.tool,
            result: payload.toolResult.result
          })}\n\nDecide the next action.`
        })
      }
    }

    const MAX_RETRIES = 2
    let response
    let lastError

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 120_000)

        response = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://sysflow.dev",
            "X-Title": "Sysflow Agent"
          },
          body: JSON.stringify({
            model: modelName,
            messages: history,
            response_format: { type: "json_object" },
            temperature: 0.1,
            max_tokens: 8192
          }),
          signal: controller.signal
        })

        clearTimeout(timeout)
        break
      } catch (fetchErr) {
        lastError = fetchErr
        console.error(`[openrouter] Fetch attempt ${attempt + 1} failed:`, fetchErr.message)
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        }
      }
    }

    if (!response) {
      throw lastError || new Error("OpenRouter fetch failed after retries")
    }

    if (!response.ok) {
      const errBody = await response.text()
      const status = response.status
      console.error(`[openrouter] HTTP ${status}:`, errBody)

      runHistories.delete(payload.runId)

      if (status === 429) {
        return {
          kind: "failed",
          error: `OpenRouter rate limit (429). Try again in a minute. Details: ${errBody.slice(0, 200)}`,
          usage: { inputTokens: 0, outputTokens: 0 }
        }
      }

      if (status === 401 || status === 403) {
        return {
          kind: "failed",
          error: `OpenRouter auth error (${status}). Check your OPENROUTER_API_KEY.`,
          usage: { inputTokens: 0, outputTokens: 0 }
        }
      }

      return {
        kind: "failed",
        error: `OpenRouter error ${status}: ${errBody.slice(0, 300)}`,
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    }

    const data = await response.json()

    // Extract usage + generation cost data from OpenRouter
    const usage = {
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      generationData: data.usage?.total_cost != null ? { total_cost: data.usage.total_cost } : null
    }

    const assistantMessage = data.choices?.[0]?.message?.content || ""

    // Add assistant response to history for multi-turn
    history.push({ role: "assistant", content: assistantMessage })

    const normalized = parseResponse(assistantMessage)
    normalized.usage = usage

    if (normalized.kind === "completed" || normalized.kind === "failed") {
      runHistories.delete(payload.runId)
    }

    return normalized
  } catch (err) {
    runHistories.delete(payload.runId)

    const errMsg = err.message || ""
    console.error("[openrouter] Error:", errMsg)

    if (errMsg.includes("OPENROUTER_API_KEY")) {
      return {
        kind: "failed",
        error: "OPENROUTER_API_KEY is not set in .env",
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    }

    return {
      kind: "failed",
      error: `OpenRouter error: ${errMsg}`,
      usage: { inputTokens: 0, outputTokens: 0 }
    }
  }
}
