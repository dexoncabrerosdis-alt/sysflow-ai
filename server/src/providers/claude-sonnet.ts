import { BaseProvider } from "./base-provider.js"
import type { ProviderPayload, NormalizedResponse } from "../types.js"

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export class ClaudeSonnetProvider extends BaseProvider {
  readonly name = "Claude Sonnet"

  readonly modelMap: Record<string, string> = {
    "claude-sonnet-4": "claude-sonnet-4-20250514"
  }

  async call(payload: ProviderPayload): Promise<NormalizedResponse> {
    // TODO: Replace with real Claude Sonnet API call
    return this.mockFlow(payload)
  }

  private mockFlow(payload: ProviderPayload): NormalizedResponse {
    const t = (i: number, o: number) => ({ inputTokens: i, outputTokens: o })

    if (!payload.toolResult) {
      if (payload.command === "/pull") {
        return {
          kind: "needs_tool",
          tool: "write_file",
          args: { path: "sysbase/patterns/example-pattern.md", content: "# Example Pattern\n\nSynced from shared server source.\n" },
          content: "Provider claude-sonnet-4 requested sysbase sync.",
          usage: t(900, 120)
        }
      }

      if (payload.command === "/plan") {
        return {
          kind: "needs_tool",
          tool: "write_file",
          args: {
            path: `sysbase/plans/${slugify(payload.userMessage)}.md`,
            content: `# Plan: ${payload.userMessage}\n\n## Objective\n${payload.task?.goal || ""}\n\n## Steps\n\n1. Inspect project structure\n2. Identify dependencies\n3. Scaffold required files\n4. Implement core logic\n5. Add tests\n6. Verify\n`
          },
          content: "Provider claude-sonnet-4 generated a detailed plan.",
          usage: t(1200, 200)
        }
      }

      return {
        kind: "needs_tool",
        tool: "list_directory",
        args: { path: "." },
        content: "Provider claude-sonnet-4 is inspecting the repo.",
        usage: t(900, 120)
      }
    }

    const toolName = payload.toolResult.tool
    const result = payload.toolResult.result as Record<string, unknown>

    if (toolName === "list_directory") {
      const entries = (result.entries || []) as unknown[]
      if (entries.length === 0) {
        return { kind: "needs_tool", tool: "create_directory", args: { path: "src" }, content: "Repo is empty. Creating project structure.", usage: t(1400, 180) }
      }
      return { kind: "needs_tool", tool: "write_file", args: { path: "src/app.js", content: 'export function app() {\n  return "hello from claude-sonnet"\n}\n' }, content: "Creating application file.", usage: t(1400, 180) }
    }

    if (toolName === "create_directory") {
      return { kind: "needs_tool", tool: "write_file", args: { path: "package.json", content: '{\n  "name": "sys-generated-app",\n  "type": "module"\n}\n' }, content: "Writing package.json.", usage: t(1700, 220) }
    }

    if (toolName === "write_file") {
      return { kind: "completed", content: "Task completed successfully.", summary: JSON.stringify({ model: "claude-sonnet-4", wroteFile: result.path || null }), usage: t(700, 80) }
    }

    if (toolName === "read_file") {
      return { kind: "needs_tool", tool: "edit_file", args: { path: result.path, patch: "// updated by claude-sonnet agent\n" + (result.content || "") }, content: "Editing file.", usage: t(1800, 220) }
    }

    if (toolName === "edit_file") {
      return { kind: "completed", content: "File updated and task completed.", summary: JSON.stringify({ model: "claude-sonnet-4", editedFile: result.path || null }), usage: t(800, 90) }
    }

    return { kind: "completed", content: "Done.", usage: t(500, 50) }
  }
}
