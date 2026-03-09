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
  runCommandTool
} from "./tools.js"

export async function executeTool(response) {
  const { tool, args, runId } = response

  switch (tool) {
    case "list_directory": {
      const entries = await listDirectoryTool(args.path)
      return callServer({
        type: "tool_result",
        runId,
        tool,
        result: {
          path: args.path,
          entries
        }
      })
    }

    case "file_exists": {
      const exists = await fileExistsTool(args.path)
      return callServer({
        type: "tool_result",
        runId,
        tool,
        result: {
          path: args.path,
          exists
        }
      })
    }

    case "create_directory": {
      await createDirectoryTool(args.path)
      return callServer({
        type: "tool_result",
        runId,
        tool,
        result: {
          path: args.path,
          success: true
        }
      })
    }

    case "read_file": {
      const content = await readFileTool(args.path)
      return callServer({
        type: "tool_result",
        runId,
        tool,
        result: {
          path: args.path,
          content
        }
      })
    }

    case "batch_read": {
      const results = []
      for (const filePath of args.paths) {
        try {
          const content = await readFileTool(filePath)
          results.push({ path: filePath, content, success: true })
        } catch (err) {
          results.push({ path: filePath, error: err.message, success: false })
        }
      }
      return callServer({
        type: "tool_result",
        runId,
        tool,
        result: { files: results }
      })
    }

    case "write_file": {
      await writeFileTool(args.path, args.content)
      return callServer({
        type: "tool_result",
        runId,
        tool,
        result: {
          path: args.path,
          success: true
        }
      })
    }

    case "edit_file": {
      await editFileTool(args.path, args.patch)
      return callServer({
        type: "tool_result",
        runId,
        tool,
        result: {
          path: args.path,
          success: true
        }
      })
    }

    case "move_file": {
      await moveFileTool(args.from, args.to)
      return callServer({
        type: "tool_result",
        runId,
        tool,
        result: {
          from: args.from,
          to: args.to,
          success: true
        }
      })
    }

    case "delete_file": {
      await deleteFileTool(args.path)
      return callServer({
        type: "tool_result",
        runId,
        tool,
        result: {
          path: args.path,
          success: true
        }
      })
    }

    case "search_code": {
      const matches = await searchCodeTool(args.directory || ".", args.pattern)
      return callServer({
        type: "tool_result",
        runId,
        tool,
        result: {
          directory: args.directory || ".",
          pattern: args.pattern,
          matches
        }
      })
    }

    case "run_command": {
      const output = await runCommandTool(args.command, args.cwd || process.cwd())
      return callServer({
        type: "tool_result",
        runId,
        tool,
        result: {
          command: args.command,
          cwd: args.cwd || process.cwd(),
          ...output
        }
      })
    }

    default:
      throw new Error(`Unknown tool: ${tool}`)
  }
}
