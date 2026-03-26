import { saveTask } from "../store/tasks.js"
import { analyzeTaskComplexity } from "./completion-guard.js"
import type { TaskStep } from "../types.js"

interface CreateTaskParams {
  taskId: string
  runId: string
  prompt: string
  command?: string
  model: string
  projectId: string
}

interface TaskRecord {
  id: string
  runId: string
  projectId: string
  model: string
  title: string
  goal: string
  steps: TaskStep[]
  status: string
  createdAt: string
}

export async function createTask({ taskId, runId, prompt, command, model, projectId }: CreateTaskParams): Promise<TaskRecord> {
  const title = buildTaskTitle({ prompt, command })

  const task: TaskRecord = {
    id: taskId,
    runId,
    projectId,
    model,
    title,
    goal: buildTaskGoal({ prompt, command }),
    steps: buildInitialTaskSteps({ prompt, command }),
    status: "active",
    createdAt: new Date().toISOString()
  }

  await saveTask(task as never)
  return task
}

function buildTaskTitle({ prompt, command }: { prompt: string; command?: string }): string {
  if (command === "/plan") return `Plan: ${prompt}`
  if (command === "/implement") return `Implement: ${prompt}`
  if (command === "/pull") return "Pull shared sysbase updates"
  if (command === "/stash") return `Stash: ${prompt}`
  return `Run: ${prompt}`
}

function buildTaskGoal({ prompt, command }: { prompt: string; command?: string }): string {
  if (command === "/plan") return `Generate a plan and store it in sysbase for: ${prompt}`
  if (command === "/implement") return `Implement the referenced plan: ${prompt}`
  if (command === "/pull") return "Sync shared sysbase content locally"
  if (command === "/stash") return `Archive sysbase content: ${prompt}`
  return prompt
}

function toSteps(labels: string[]): TaskStep[] {
  return labels.map((label, i) => ({
    id: `step_${i}`,
    label,
    status: i === 0 ? "in_progress" as const : "pending" as const
  }))
}

function buildInitialTaskSteps({ prompt, command }: { prompt: string; command?: string }): TaskStep[] {
  if (command === "/plan") {
    return toSteps(["Inspect project context", "Retrieve relevant patterns", "Generate plan", "Write plan into sysbase", "Complete task"])
  }
  if (command === "/implement") {
    return toSteps(["Load referenced plan", "Retrieve relevant patterns", "Inspect relevant repo structure", "Detect unknowns and validate", "Implement required files and changes", "Verify implementation", "Extract learnings", "Complete task"])
  }
  if (command === "/pull") {
    return toSteps(["Fetch shared sysbase data", "Write local sysbase files", "Complete task"])
  }
  if (command === "/stash") {
    return toSteps(["Locate target sysbase content", "Move content to archive", "Complete task"])
  }

  // ─── Dynamic step generation based on prompt analysis ───
  const analysis = analyzeTaskComplexity(prompt)

  if (analysis.complexity === "complex") {
    const steps: string[] = []

    // Phase 1: Scaffolding
    steps.push("Scaffold project(s)")

    // Phase 2: Database
    if (analysis.expectedBackendFeatures.some((f) => f.includes("Prisma") || f.includes("TypeORM") || f.includes("database"))) {
      steps.push("Set up database schema and config")
    }

    // Phase 3: Backend modules (dynamic per module)
    if (analysis.expectedModules.length > 0) {
      for (const mod of analysis.expectedModules) {
        steps.push(`Build ${mod} module (controller, service, DTOs)`)
      }
      steps.push("Wire up backend (app module, guards, main)")
    }

    // Phase 4: Frontend
    if (analysis.expectedFrontendPages.length > 0) {
      steps.push("Create frontend core (API client, types, layouts)")
      for (const page of analysis.expectedFrontendPages) {
        steps.push(`Build ${page} page`)
      }
    }

    // Phase 5: Finalization
    steps.push("Verify and finalize")

    return toSteps(steps)
  }

  if (analysis.complexity === "medium") {
    const steps = [
      "Inspect codebase",
      "Set up project structure",
    ]

    if (analysis.expectedModules.length > 0) {
      for (const mod of analysis.expectedModules) {
        steps.push(`Implement ${mod}`)
      }
    } else {
      steps.push("Implement core features")
    }

    steps.push("Verify and complete")
    return toSteps(steps)
  }

  // Simple: generic pipeline
  return toSteps([
    "Inspect codebase and read relevant files",
    "Retrieve patterns and knowledge from context",
    "Analyze requirements and detect unknowns",
    "Plan implementation steps",
    "Execute implementation",
    "Verify and test",
    "Extract learnings",
    "Complete task"
  ])
}
