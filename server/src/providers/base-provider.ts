import type { ProviderPayload, NormalizedResponse, TokenUsage } from "../types.js"

/**
 * Abstract base class for all AI model providers.
 *
 * Each provider must implement:
 *   - call()          → main entry point for the adapter
 *   - getModelName()  → map sysflow model ID to the provider's model ID
 *
 * Shared helpers provided:
 *   - buildInitialUserMessage()  → assembles context + prompt
 *   - parseJsonResponse()        → extracts JSON from raw model text
 *   - failedResponse()           → shorthand for error responses
 *   - clearRunState()            → cleanup per-run state
 */
export abstract class BaseProvider {
  /** Human-readable provider name (for logs) */
  abstract readonly name: string

  /** Map of sysflow model IDs this provider handles → provider-specific model IDs */
  abstract readonly modelMap: Record<string, string>

  /** Per-run state (chat sessions, message histories, etc.) */
  protected runState = new Map<string, unknown>()

  /** System prompt shared by all providers (can be overridden) */
  protected readonly systemPrompt: string = SHARED_SYSTEM_PROMPT

  // ─── Abstract methods ───

  abstract call(payload: ProviderPayload): Promise<NormalizedResponse>

  // ─── Shared helpers ───

  getModelName(modelId: string): string {
    const keys = Object.keys(this.modelMap)
    return this.modelMap[modelId] || this.modelMap[keys[0]] || modelId
  }

  clearRunState(runId: string): void {
    this.runState.delete(runId)
  }

  buildInitialUserMessage(payload: ProviderPayload): string {
    let msg = ""

    if (payload.context?.sessionHistory) {
      msg += `${payload.context.sessionHistory}\n\n`
    }

    if (payload.context?.continueContext) {
      msg += `${payload.context.continueContext}\n\n`
    } else if (payload.context?.continueFrom) {
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

    if (payload.context?.projectKnowledge) {
      msg += `\n\n${payload.context.projectKnowledge}`
    }

    return msg
  }

  parseJsonResponse(text: string): NormalizedResponse {
    let json: Record<string, unknown> | null = null

    try {
      json = JSON.parse(text)
    } catch {
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
        reasoning: null,
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    }

    const normalized: NormalizedResponse = {
      kind: json.kind as NormalizedResponse["kind"],
      content: (json.content as string) || "",
      reasoning: (json.reasoning as string) || null,
      usage: { inputTokens: 0, outputTokens: 0 }
    }

    if (json.kind === "needs_tool") {
      normalized.tool = json.tool as string

      // Handle args_json (Gemini) or args (OpenRouter)
      if (json.args_json) {
        try {
          normalized.args = typeof json.args_json === "string"
            ? JSON.parse(json.args_json)
            : json.args_json as Record<string, unknown>
        } catch {
          normalized.args = {}
        }
      } else if (json.args) {
        normalized.args = json.args as Record<string, unknown>
      } else {
        normalized.args = {}
      }
    }

    if (json.kind === "failed") {
      normalized.error = (json.content as string) || "Model reported failure"
    }

    return normalized
  }

  failedResponse(error: string): NormalizedResponse {
    return {
      kind: "failed",
      error,
      usage: { inputTokens: 0, outputTokens: 0 }
    }
  }

  protected emptyUsage(): TokenUsage {
    return { inputTokens: 0, outputTokens: 0 }
  }
}

// ─── Shared system prompt ───

const SHARED_SYSTEM_PROMPT = `You are an AI coding agent. You help the user by performing actions on their codebase using tools.

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
- If a tool returns an error, DO NOT give up. Analyze the error, fix the problem, and try again with "needs_tool".
- ALWAYS VERIFY your work before completing. If you write tests, RUN them. If you write code, TEST it.
- Always include "reasoning" with a short explanation.
- Write complete, production-quality code.
- Do one action at a time. You will be called again with the tool result.

TERMINAL COMMAND RULES:
- NEVER run long-running/server commands like "npm start", "npm run dev", "node server.js", "python app.py", etc.
- If the task requires starting a server, DO NOT run it yourself. Tell the user to run it manually.
- Only run short-lived commands: install deps, build, run tests, linting, etc.
- If a command times out or is skipped, acknowledge it and move on.

MEMORY RULES:
- You have access to session history showing your previous actions in this chat. USE IT.
- Do NOT re-read files you just wrote in the same run. You already know their content.
- Do NOT redo steps that already succeeded in previous runs (check session history).
- If continuing from an interrupted run, pick up exactly where it left off.`
