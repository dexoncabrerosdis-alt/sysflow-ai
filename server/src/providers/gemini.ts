import { GoogleGenerativeAI, SchemaType, type ChatSession, type GenerateContentResult } from "@google/generative-ai"
import { BaseProvider } from "./base-provider.js"
import type { ProviderPayload, NormalizedResponse, TokenUsage } from "../types.js"

const RESPONSE_SCHEMA = {
  description: "Agent action response",
  type: SchemaType.OBJECT,
  properties: {
    kind: {
      type: SchemaType.STRING,
      description: "The type of response",
      enum: ["needs_tool", "completed", "failed"]
    },
    reasoning: {
      type: SchemaType.STRING,
      description: "Brief internal reasoning about what to do next (1-2 sentences)"
    },
    tool: {
      type: SchemaType.STRING,
      description: "The tool to use. Required when kind is needs_tool.",
      nullable: true,
      enum: [
        "list_directory", "read_file", "batch_read", "write_file",
        "edit_file", "create_directory", "search_code", "run_command",
        "move_file", "delete_file"
      ]
    },
    args_json: {
      type: SchemaType.STRING,
      description: "JSON string of tool arguments. Required when kind is needs_tool. MUST be valid JSON.",
      nullable: true
    },
    content: {
      type: SchemaType.STRING,
      description: "Brief description of what you are doing or result message"
    }
  },
  required: ["kind", "reasoning", "content"]
}

export class GeminiProvider extends BaseProvider {
  readonly name = "Gemini"

  readonly modelMap: Record<string, string> = {
    "gemini-flash": "gemini-2.5-flash",
    "gemini-pro": "gemini-2.5-pro"
  }

  // Override: Gemini uses structured output, so the system prompt uses args_json instead of args
  protected override readonly systemPrompt: string

  constructor() {
    super()
    // Gemini-specific system prompt with args_json field
    this.systemPrompt = `You are an AI coding agent. You help the user by performing actions on their codebase using tools.

IMPORTANT: All file paths are relative to the PROJECT ROOT (the current working directory ".").
- Place files in the project root: "package.json", "server.js", "src/app.js", etc.
- NEVER write files into the "sysbase/" directory. That folder is reserved for internal agent memory and is NOT part of the user's project.

Your response uses the field "args_json" which is a JSON STRING containing the tool arguments.

Available tools and their args_json examples:

1. list_directory
   args_json: {"path": "."}

2. read_file
   args_json: {"path": "src/app.js"}

3. batch_read
   args_json: {"paths": ["src/app.js", "package.json"]}

4. write_file — IMPORTANT: "content" must contain the COMPLETE file text, never empty or null
   args_json: {"path": "src/app.js", "content": "const express = require('express');\\nconst app = express();\\napp.get('/', (req, res) => res.send('Hello World'));\\napp.listen(3000);"}

5. edit_file — "patch" must contain the COMPLETE new file text
   args_json: {"path": "src/app.js", "patch": "const express = require('express');\\nmodified content here"}

6. create_directory
   args_json: {"path": "src/utils"}

7. search_code
   args_json: {"directory": ".", "pattern": "function auth"}

8. run_command
   args_json: {"command": "npm install express", "cwd": "."}

9. move_file
   args_json: {"from": "old.js", "to": "new.js"}

10. delete_file
    args_json: {"path": "temp.js"}

CRITICAL RULES:
- For write_file: args_json MUST include both "path" and "content". The "content" field must be the FULL file source code. Never leave content empty.
- For edit_file: args_json MUST include both "path" and "patch". The "patch" field must be the FULL new file content.
- args_json must be a valid JSON string.
- Use "needs_tool" when you need to perform an action.
- Use "completed" when the task is fully done. Set tool to null and args_json to null.
- Use "failed" ONLY if the task is truly impossible (e.g. missing permissions, impossible request).
- If a tool returns an error, DO NOT give up. Analyze the error, fix the problem, and try again with "needs_tool".
- ALWAYS VERIFY your work before completing. If you write tests, RUN them. If you write code, TEST it. If you edit a file, READ it back to confirm.
- If something already exists but the user asks you to work on it, CHECK if it actually works first.
- Always include "reasoning" with a short explanation.
- Write complete, production-quality code.
- Do one action at a time. You will be called again with the tool result.

TERMINAL COMMAND RULES:
- NEVER run long-running/server commands like "npm start", "npm run dev", "node server.js", "python app.py", etc. These will hang forever.
- If the task requires starting a server, DO NOT run it yourself. Instead, complete the task and tell the user to run it manually.
- Only run short-lived commands: install deps (npm install), build (npm run build), run tests (npm test), linting, etc.
- If a command times out or is skipped, acknowledge it and move on. Do NOT retry server-start commands.

MEMORY RULES:
- You have access to session history showing your previous actions in this chat. USE IT.
- Do NOT re-read files you just wrote in the same run. You already know their content.
- Do NOT redo steps that already succeeded in previous runs (check session history).
- If continuing from an interrupted run, pick up exactly where it left off.`
  }

  private getGenAI(): GoogleGenerativeAI {
    const key = process.env.GEMINI_API_KEY
    if (!key) throw new Error("GEMINI_API_KEY is not set in .env")
    return new GoogleGenerativeAI(key)
  }

  private extractUsage(result: GenerateContentResult): TokenUsage {
    try {
      const meta = result.response.usageMetadata
      return {
        inputTokens: meta?.promptTokenCount || 0,
        outputTokens: meta?.candidatesTokenCount || 0
      }
    } catch {
      return this.emptyUsage()
    }
  }

  async call(payload: ProviderPayload): Promise<NormalizedResponse> {
    const genAI = this.getGenAI()
    const geminiModelName = this.getModelName(payload.model)

    try {
      if (!payload.toolResult) {
        // First call — create a new chat session
        const model = genAI.getGenerativeModel({
          model: geminiModelName,
          systemInstruction: this.systemPrompt,
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA as never,
            temperature: 0.1,
            maxOutputTokens: 8192
          }
        })

        const chat = model.startChat({ history: [] })
        this.runState.set(payload.runId, chat)

        const userMsg = this.buildInitialUserMessage(payload)
        const result = await chat.sendMessage(userMsg)
        const text = result.response.text()

        const normalized = this.parseJsonResponse(text)
        normalized.usage = this.extractUsage(result)

        if (normalized.kind === "completed" || normalized.kind === "failed") {
          this.clearRunState(payload.runId)
        }

        return normalized
      }

      // Subsequent call — continue existing chat with tool result
      let chat = this.runState.get(payload.runId) as ChatSession | undefined

      if (!chat) {
        // Session lost — recreate
        const model = genAI.getGenerativeModel({
          model: geminiModelName,
          systemInstruction: this.systemPrompt,
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA as never,
            temperature: 0.1,
            maxOutputTokens: 8192
          }
        })

        chat = model.startChat({ history: [] })
        this.runState.set(payload.runId, chat)
      }

      const toolResultStr = JSON.stringify({
        tool: payload.toolResult.tool,
        result: payload.toolResult.result
      })

      const result = await chat.sendMessage(
        `Tool result:\n${toolResultStr}\n\nDecide the next action.`
      )
      const text = result.response.text()

      const normalized = this.parseJsonResponse(text)
      normalized.usage = this.extractUsage(result)

      if (normalized.kind === "completed" || normalized.kind === "failed") {
        this.clearRunState(payload.runId)
      }

      return normalized
    } catch (err) {
      this.clearRunState(payload.runId)

      const error = err as Error & { status?: number; httpStatusCode?: number }
      const errMsg = error.message || ""
      const errStatus = error.status || error.httpStatusCode || 0
      console.error("[gemini] Error:", errStatus, errMsg)

      if (errMsg.includes("API key") || errMsg.includes("API_KEY_INVALID")) {
        return this.failedResponse("Invalid GEMINI_API_KEY. Check your .env file.")
      }

      if (errStatus === 429 || errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota")) {
        return this.failedResponse("Gemini rate limit hit. Free tier: 15 RPM / 1000 RPD for Flash. Wait a minute and try again.")
      }

      return this.failedResponse(`Gemini error: ${errMsg}`)
    }
  }
}
