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
      description: "The tool to use (single tool mode). Required when kind is needs_tool and tools array is not used.",
      nullable: true,
      enum: [
        "list_directory", "read_file", "batch_read", "write_file",
        "edit_file", "create_directory", "search_code", "search_files",
        "run_command", "move_file", "delete_file", "web_search"
      ]
    },
    args_json: {
      type: SchemaType.STRING,
      description: "JSON string of tool arguments (single tool mode). MUST be valid JSON.",
      nullable: true
    },
    tools: {
      type: SchemaType.ARRAY,
      description: "Array of tool calls for parallel execution. Use INSTEAD of tool/args_json when calling multiple independent tools at once.",
      nullable: true,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          id: { type: SchemaType.STRING, description: "Unique ID like tc_0, tc_1" },
          tool: {
            type: SchemaType.STRING,
            enum: [
              "list_directory", "read_file", "batch_read", "write_file",
              "edit_file", "create_directory", "search_code", "search_files",
              "run_command", "move_file", "delete_file"
            ]
          },
          args_json: { type: SchemaType.STRING, description: "JSON string of tool arguments" }
        },
        required: ["id", "tool", "args_json"]
      }
    },
    stepTransition: {
      type: SchemaType.OBJECT,
      description: "Step transition to mark pipeline progress",
      nullable: true,
      properties: {
        complete: { type: SchemaType.STRING, description: "Step ID to mark completed", nullable: true },
        start: { type: SchemaType.STRING, description: "Step ID to mark in_progress", nullable: true }
      }
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
  protected override readonly systemPrompt: string = ""

  constructor() {
    super()
    // Gemini-specific system prompt with args_json field
    this.systemPrompt = `You are an AI coding agent. You help the user by performing actions on their codebase using tools.

COMPLEXITY CHECK (DO THIS FIRST):
For COMPLEX NEW tasks (full-stack apps, multi-module systems, 2+ frameworks): You MUST ask 1-3 questions BEFORE implementing when:
- The prompt gives alternatives (e.g. "Prisma or TypeORM") — ask which one
- Frontend is mentioned but NO CSS/UI framework specified — ask (Tailwind? MUI? shadcn/ui?)
- Database not specified — ask which one
Format as numbered list. Use kind: "waiting_for_user".
NEVER ask when: user says "continue", session history has answers, or ALL choices are explicit with no ambiguity.
For SIMPLE tasks or /continue: proceed directly.

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

11. web_search — Search the web for current docs, CLI commands, latest package versions.
    args_json: {"query": "how to create nestjs project 2025 cli command"}
    USE THIS BEFORE running any scaffolding command you're not 100% sure about.

CRITICAL RULES:
- For write_file: args_json MUST include both "path" and "content". The "content" field must be the FULL file source code. Never leave content empty.
- For edit_file: args_json MUST include both "path" and "patch". The "patch" field must be the FULL new file content.
- args_json must be a valid JSON string.
- Use "needs_tool" when you need to perform an action.
- Use "completed" when the task is fully done. Set tool to null and args_json to null.
- Use "failed" ONLY if the task is truly impossible (e.g. missing permissions, impossible request).
- If a tool returns an error, DO NOT give up. Analyze the error, fix the problem, and try again with "needs_tool".
- If read_file fails because a file doesn't exist, CREATE IT with write_file. Never give up because files are missing.
- NEVER complete a task by listing what you WOULD do — actually DO IT with tools.
- You are TASK-DRIVEN. The ORIGINAL user prompt defines your task. You are NOT done until FULLY implemented.
- BEFORE completing: did you create ALL files? All backend modules? All frontend components? All configs? If NO → keep going.
- When user answers a question (e.g. "3", "yes"), that is NOT a new task. Continue the ORIGINAL task.
- NEVER ask "what would you like me to do?" if the original task isn't finished. Just keep implementing.
- NEVER stop because a command was skipped. Keep writing source files.
- ALWAYS VERIFY your work before completing.
- Always include "reasoning" with a short explanation.
- Write complete, production-quality code.
- Use the "tools" array to call multiple independent tools in parallel for speed. You will be called again with all results at once.
- For single actions, use "tool" and "args_json" as before.
- ALWAYS MAXIMIZE PARALLELISM — batch 10-20 independent tools whenever possible.
- When creating a project: batch ALL write_file calls for independent files into one "tools" array.
- When reading: batch ALL read_file calls together (up to 20). When searching: batch searches together.
- Parallel is MUCH faster — 15 writes in one batch = same time as 1 write.

⚠️ ANTI-PREMATURE-COMPLETION (THE SERVER ENFORCES THIS):
- The server WILL REJECT your "completed" response if you haven't created enough files.
- For full-stack projects: expect 25-60 files. If you created fewer than 20, you WILL be rejected.
- Scaffolding (npx create-next-app, npx @nestjs/cli new) does NOT count as implementation.
- After scaffolding, you must STILL create ALL: modules, services, controllers, DTOs, pages, components.
- Batch up to 8 write_file calls per response. For a full-stack app, expect 4-8 batches.
- After each batch, return "needs_tool" with the NEXT batch. Only "completed" after the FINAL batch.
- NEVER complete after only scaffolding + a few files. That will be REJECTED.
- NEVER say "the rest follows the same pattern" — write EVERY file explicitly.
- For EACH backend module: create controller, service, DTOs, entity/model, and module file.
- For EACH frontend page: create page component with full JSX/TSX and real UI code.

IMPLEMENTATION ORDER FOR FULL-STACK PROJECTS:
Phase 1: Scaffold backend + frontend (1-2 calls)
Phase 2: Database schema + .env + DB module (2-4 calls)
Phase 3: ALL backend modules — controller, service, DTOs, entity per module (8-20 calls)
Phase 4: Backend wiring — app.module, auth guards, main.ts (2-4 calls)
Phase 5: Frontend core — API client, types, layouts, shared components (4-8 calls)
Phase 6: ALL frontend pages with real UI code (8-16 calls)
Phase 7: Finalization — save patterns, respond "completed" (1-2 calls)

TERMINAL COMMAND RULES:
- NEVER run long-running/server commands like "npm start", "npm run dev", "node server.js", "python app.py", etc. These will hang forever.
- Scaffolding tools are ALLOWED — they run interactively in the user's terminal.
- BEFORE running scaffolding: use web_search to verify the correct command (e.g. web_search("create nestjs project cli 2025")).
- If web_search fails, use these KNOWN-GOOD commands (always use "npx --yes"):
  React:   npx --yes create-vite@latest {name} --template react
  React+TS: npx --yes create-vite@latest {name} --template react-ts
  Next.js: npx --yes create-next-app@latest {name} --ts --eslint --tailwind --app --src-dir --use-npm
  NestJS:  npx --yes @nestjs/cli new {name} --skip-install --package-manager npm
  Angular: npx --yes @angular/cli new {name} --skip-install
  Vue:     npx --yes create-vite@latest {name} --template vue
  Nuxt:    npx --yes nuxi@latest init {name}
  Remix:   npx --yes create-remix@latest {name}
  Astro:   npm create astro@latest {name}
  Express: create files manually (no scaffolding tool)
  ALWAYS use --skip-install when available. Install deps separately with "npm install".
  If a scaffolding command fails, fall back to creating files manually. Do NOT ask user to install CLIs.
  NEVER use create-react-app. NEVER use "npm create @nestjs". If unsure, create files manually.
  SCAFFOLDING ORDER: Step 1: scaffold only. Step 2: verify with read_file. Step 3: create files with write_file. Step 4: tell user to install deps in summary.
  NEVER run "npm install" — it times out. Defer to user in summary.
  NEVER run "npx prisma init/migrate/generate" — create schema.prisma and .env with write_file, tell user to run prisma commands in summary.
  NEVER combine scaffolding + file creation in one batch.
- If the task requires starting a server, DO NOT run it yourself. Tell the user to run it manually.
- Only run SHORT commands: build, test, lint, mkdir, etc.
- BANNED COMMANDS (never run — they time out or don't exist):
  × npm install / npm i / yarn install / pnpm install
  × npx prisma init / migrate / generate
  × npx shadcn-ui init / npx shadcn init
  × npx tailwindcss init / tailwindcss init -p (REMOVED in Tailwind v4 — does not exist)
  NOTE: create-next-app --tailwind already configures Tailwind. Do NOT run tailwindcss init.
  NOTE: For shadcn/ui, create components manually with write_file. Do NOT run npx shadcn init.
  Instead: create all config/source files with write_file. List install commands in completion summary.
- If a command is skipped or times out: DO NOT STOP. Continue writing ALL remaining source code files. You can write code without deps installed. Skipped commands go in the final summary. The task is NOT done until ALL source files are written.

WHEN TO READ FILES:
- READ files when: the project has existing code you need to understand, or you need sysbase/patterns/ and sysbase/architecture/ for conventions.
- For existing projects: FIRST read key project files AND sysbase/patterns/*.md + sysbase/architecture/*.md in one parallel batch.
- DO NOT READ files you just created/wrote in this run — you already know their content.
- DO NOT READ files that don't exist yet — just create them.
- For new projects in empty dirs: skip reading, go straight to planning and writing.

MEMORY RULES (CRITICAL):
- You have access to session history AND tool results from the current run. USE THEM.
- NEVER re-read files whose content you already know from this run.
- After creating files, proceed to the NEXT step immediately.
- When creating a project from scratch: plan ALL files, then batch write_file for ALL of them in one parallel call.
- Do NOT redo steps that already succeeded in previous runs.

COMPLETION FORMAT:
When you finish a task (kind: "completed"), your "content" MUST include:
1. A brief SUMMARY of what was done (files created/modified, key decisions)
2. NEXT STEPS — concrete instructions for the user (e.g. "Run npm install, then npm start")
3. Any important notes or warnings

PATTERN SAVING:
- Before saving, check if sysbase/patterns/ already has a file covering this topic — read existing patterns in your initial batch.
- If pattern already exists with same content → skip. If it needs updating → edit_file. If genuinely new → write_file.
- Save patterns for: new architectures, non-obvious conventions, non-trivial bugfixes.
- Do NOT save for: basic CRUD, standard boilerplate, trivial changes, or content that's already saved.`
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
      if (!payload.toolResult && !payload.toolResults) {
        // First call — create a new chat session
        const model = genAI.getGenerativeModel({
          model: geminiModelName,
          systemInstruction: this.systemPrompt,
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA as never,
            temperature: 0.1,
            maxOutputTokens: this.getAdaptiveMaxTokens(65536)
          }
        })

        const chat = model.startChat({ history: [] })
        this.runState.set(payload.runId, chat)
        this.setRunTask(payload.runId, payload.userMessage)

        const userMsg = this.buildInitialUserMessage(payload)
        const result = await chat.sendMessage(userMsg)
        const text = result.response.text()

        let normalized = this.parseJsonResponse(text)
        normalized.usage = this.extractUsage(result)
        this.onSuccessfulCall()

        // Layer 2: provider-level completion validation
        normalized = this.validateCompletionResponse(payload.runId, normalized)

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
            maxOutputTokens: this.getAdaptiveMaxTokens(65536)
          }
        })

        chat = model.startChat({ history: [] })
        this.runState.set(payload.runId, chat)
      }

      const toolMsg = this.buildToolResultMessage(payload)

      const result = await chat.sendMessage(toolMsg)
      const text = result.response.text()

      const normalized = this.parseJsonResponse(text)
      normalized.usage = this.extractUsage(result)
      this.onSuccessfulCall()

      if (normalized.kind === "completed" || normalized.kind === "failed") {
        this.clearRunState(payload.runId)
      }

      return normalized
    } catch (err) {
      const error = err as Error & { status?: number; httpStatusCode?: number }
      const errMsg = error.message || ""
      const errStatus = error.status || error.httpStatusCode || 0
      console.error("[gemini] Error:", errStatus, errMsg)

      if (errMsg.includes("API key") || errMsg.includes("API_KEY_INVALID")) {
        this.clearRunState(payload.runId)
        return this.failedResponse("Invalid GEMINI_API_KEY. Check your .env file.")
      }

      // Rate limit — DON'T clear run state, signal for retry/fallback
      if (errStatus === 429 || errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("quota")) {
        return this.rateLimitedResponse("Gemini rate limit hit. Free tier: 15 RPM / 1000 RPD for Flash.")
      }

      this.clearRunState(payload.runId)
      return this.failedResponse(`Gemini error: ${errMsg}`)
    }
  }
}
