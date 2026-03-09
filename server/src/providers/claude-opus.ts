import { BaseProvider } from "./base-provider.js"
import type { ProviderPayload, NormalizedResponse } from "../types.js"

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export class ClaudeOpusProvider extends BaseProvider {
  readonly name = "Claude Opus"

  readonly modelMap: Record<string, string> = {
    "claude-opus-4": "claude-opus-4-20250514"
  }

  async call(payload: ProviderPayload): Promise<NormalizedResponse> {
    // TODO: Replace with real Claude Opus API call
    return this.mockFlow(payload)
  }

  private mockFlow(payload: ProviderPayload): NormalizedResponse {
    const t = (i: number, o: number) => ({ inputTokens: i, outputTokens: o })

    if (!payload.toolResult) {
      if (payload.command === "/plan") {
        return {
          kind: "needs_tool",
          tool: "write_file",
          args: {
            path: `sysbase/plans/${slugify(payload.userMessage)}.md`,
            content: `# Plan: ${payload.userMessage}\n\n## Objective\n${payload.task?.goal || ""}\n\n## Architecture Notes\nThis plan considers the full system architecture.\n\n## Steps\n\n1. Deep analysis of project state\n2. Identify architectural boundaries\n3. Design module interfaces\n4. Scaffold structure\n5. Implement core logic\n6. Add integration tests\n7. Verify end-to-end\n`
          },
          content: "Provider claude-opus-4 generated a comprehensive plan.",
          usage: t(2000, 400)
        }
      }

      if (payload.command === "/implement") {
        return {
          kind: "needs_tool",
          tool: "read_file",
          args: { path: payload.userMessage.replace("@", "") },
          content: "Provider claude-opus-4 is reading the plan for implementation.",
          usage: t(1800, 200)
        }
      }

      return {
        kind: "needs_tool",
        tool: "list_directory",
        args: { path: "." },
        content: "Provider claude-opus-4 is analyzing the repo.",
        usage: t(1500, 200)
      }
    }

    const toolName = payload.toolResult.tool
    const result = payload.toolResult.result as Record<string, unknown>

    if (toolName === "list_directory") {
      const entries = (result.entries || []) as unknown[]
      if (entries.length === 0) {
        return { kind: "needs_tool", tool: "create_directory", args: { path: "src" }, content: "Repo is empty. Building full project structure.", usage: t(2200, 300) }
      }
      return { kind: "needs_tool", tool: "write_file", args: { path: "src/app.js", content: 'export function app() {\n  return "hello from claude-opus"\n}\n' }, content: "Creating application file with full architecture.", usage: t(2200, 300) }
    }

    if (toolName === "create_directory") {
      return { kind: "needs_tool", tool: "write_file", args: { path: "package.json", content: '{\n  "name": "sys-generated-app",\n  "type": "module"\n}\n' }, content: "Writing package.json with full config.", usage: t(2500, 350) }
    }

    if (toolName === "write_file") {
      return { kind: "completed", content: "Task completed with full architectural consideration.", summary: JSON.stringify({ model: "claude-opus-4", wroteFile: result.path || null }), usage: t(1200, 150) }
    }

    if (toolName === "read_file") {
      return { kind: "needs_tool", tool: "edit_file", args: { path: result.path, patch: "// deep refactor by claude-opus agent\n" + (result.content || "") }, content: "Performing deep edit based on analysis.", usage: t(2800, 400) }
    }

    if (toolName === "edit_file") {
      return { kind: "completed", content: "Deep edit completed. Task finalized.", summary: JSON.stringify({ model: "claude-opus-4", editedFile: result.path || null }), usage: t(1500, 180) }
    }

    return { kind: "completed", content: "Task completed.", usage: t(800, 80) }
  }
}
