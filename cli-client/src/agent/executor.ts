import { callServer } from "../lib/server.js"
import {
  listDirectoryTool,
  fileExistsTool,
  createDirectoryTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  moveFileTool,
  deleteFileTool,
  searchCodeTool,
  runCommandTool,
  searchFilesTool
} from "./tools.js"

interface ToolResponse {
  tool: string
  args: Record<string, unknown>
  runId: string
  [key: string]: unknown
}

interface ToolCallEntry {
  id: string
  tool: string
  args: Record<string, unknown>
}

// ─── Local tool execution (no server call) ───

export async function executeToolLocally(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (tool) {
    case "list_directory": {
      const entries = await listDirectoryTool(args.path as string)
      return { path: args.path, entries }
    }

    case "file_exists": {
      const exists = await fileExistsTool(args.path as string)
      return { path: args.path, exists }
    }

    case "create_directory": {
      await createDirectoryTool(args.path as string)
      return { path: args.path, success: true }
    }

    case "read_file": {
      const content = await readFileTool(args.path as string)
      return { path: args.path, content }
    }

    case "batch_read": {
      const results: Array<{ path: string; content?: string; error?: string; success: boolean }> = []
      for (const filePath of args.paths as string[]) {
        try {
          const content = await readFileTool(filePath)
          results.push({ path: filePath, content, success: true })
        } catch (err) {
          results.push({ path: filePath, error: (err as Error).message, success: false })
        }
      }
      return { files: results }
    }

    case "write_file": {
      await writeFileTool(args.path as string, args.content as string)
      return { path: args.path, success: true }
    }

    case "edit_file": {
      await editFileTool(args.path as string, args.patch as string)
      return { path: args.path, success: true }
    }

    case "move_file": {
      await moveFileTool(args.from as string, args.to as string)
      return { from: args.from, to: args.to, success: true }
    }

    case "delete_file": {
      await deleteFileTool(args.path as string)
      return { path: args.path, success: true }
    }

    case "search_code": {
      const matches = await searchCodeTool((args.directory as string) || ".", args.pattern as string)
      return { directory: args.directory || ".", pattern: args.pattern, matches }
    }

    case "search_files": {
      const results = await searchFilesTool(
        (args.query as string) || "",
        args.glob as string | undefined
      )
      return { query: args.query, glob: args.glob, results }
    }

    case "run_command": {
      const output = await runCommandTool(args.command as string, (args.cwd as string) || process.cwd())
      return { command: args.command, cwd: args.cwd || process.cwd(), ...output }
    }

    default:
      throw new Error(`Unknown tool: ${tool}`)
  }
}

// ─── Single tool execution (existing flow — execute + send to server) ───

export async function executeTool(response: ToolResponse): Promise<Record<string, unknown>> {
  const { tool, args, runId } = response
  const result = await executeToolLocally(tool, args)
  return callServer({
    type: "tool_result",
    runId,
    tool,
    result
  })
}

// ─── Batch tool execution (parallel — execute all + send batch to server) ───

export async function executeToolsBatch(
  tools: ToolCallEntry[],
  runId: string
): Promise<Record<string, unknown>> {
  // Execute all tools in parallel
  const settled = await Promise.allSettled(
    tools.map(async (tc) => {
      const result = await executeToolLocally(tc.tool, tc.args)
      return { id: tc.id, tool: tc.tool, result }
    })
  )

  // Collect results — convert rejections to error objects
  const toolResults = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value
    return {
      id: tools[i].id,
      tool: tools[i].tool,
      result: { error: (r.reason as Error).message, success: false }
    }
  })

  // Send all results to server in one call
  return callServer({
    type: "tool_result",
    runId,
    tool: tools[0].tool,      // backwards compat
    result: toolResults[0]?.result || {},
    toolResults
  })
}
