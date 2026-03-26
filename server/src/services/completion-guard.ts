/**
 * Completion Guard — prevents the AI from declaring "completed" prematurely.
 *
 * Strategy:
 * 1. Analyze the original prompt to determine task complexity (simple/medium/complex)
 * 2. Extract expected deliverables (modules, components, files) from the prompt
 * 3. Compare actual work done (files created, tool calls) against expectations
 * 4. Reject completion if insufficient work was done — force continuation
 */

import { getRunActions } from "../store/sessions.js"

// ─── Complexity Classification ───

export type TaskComplexity = "simple" | "medium" | "complex"

export interface TaskAnalysis {
  complexity: TaskComplexity
  expectedModules: string[]       // e.g., ["products", "orders", "customers", "auth"]
  expectedFrontendPages: string[] // e.g., ["product listing", "cart", "order history"]
  expectedBackendFeatures: string[] // e.g., ["CRUD products", "JWT auth", "order creation"]
  minExpectedFiles: number
  minExpectedToolCalls: number
  keywords: string[]
}

interface CompletionVerdict {
  pass: boolean
  reason?: string  // why it was rejected — sent back to AI as continuation hint
}

// ─── Prompt analysis ───

const COMPLEXITY_SIGNALS = {
  complex: [
    /full[- ]?stack/i,
    /backend.*frontend/i,
    /frontend.*backend/i,
    /nestjs.*next\.?js/i,
    /next\.?js.*nestjs/i,
    /multiple\s+modules/i,
    /end[- ]?to[- ]?end/i,
    /complete\s+(system|application|app|project)/i,
    /build\s+(a|an|the)\s+(complete|full|entire)/i,
    /create\s+(a|an|the)\s+.*\s+with\s+.*\s+(backend|frontend|api)/i,
    /\bpos\b.*system/i,
    /\be-?commerce\b/i,
    /\bdashboard\b.*\b(crud|api|backend)\b/i,
  ],
  medium: [
    /\bcrud\b/i,
    /\brest\s*api/i,
    /\bauthentication\b/i,
    /\bmodule/i,
    /multiple\s+(pages|components|endpoints|routes)/i,
    /\bintegrat/i,
    /\bdatabase\b/i,
    /\bschema\b/i,
    /\bmigrat/i,
  ]
}

const MODULE_PATTERNS = [
  { pattern: /\bproducts?\b/i, module: "products" },
  { pattern: /\borders?\b/i, module: "orders" },
  { pattern: /\bcustomers?\b/i, module: "customers" },
  { pattern: /\bauth(?:entication)?\b/i, module: "auth" },
  { pattern: /\busers?\b/i, module: "users" },
  { pattern: /\bpayments?\b/i, module: "payments" },
  { pattern: /\binventory\b/i, module: "inventory" },
  { pattern: /\bcategori(?:es|y)\b/i, module: "categories" },
  { pattern: /\bcart\b/i, module: "cart" },
  { pattern: /\bnotifications?\b/i, module: "notifications" },
  { pattern: /\breports?\b/i, module: "reports" },
  { pattern: /\bsettings?\b/i, module: "settings" },
  { pattern: /\broles?\b/i, module: "roles" },
  { pattern: /\binvoices?\b/i, module: "invoices" },
]

const FRONTEND_PAGE_PATTERNS = [
  { pattern: /product\s+listing/i, page: "product listing" },
  { pattern: /cart\s+(system|page|view)/i, page: "cart" },
  { pattern: /\bcart\b/i, page: "cart" },
  { pattern: /order\s+(creation|flow|form)/i, page: "order creation" },
  { pattern: /order\s+history/i, page: "order history" },
  { pattern: /customer\s+(selection|creation|management)/i, page: "customer management" },
  { pattern: /\bdashboard\b/i, page: "dashboard" },
  { pattern: /\blogin\b/i, page: "login" },
  { pattern: /\bregister\b/i, page: "register" },
  { pattern: /\bsignup\b/i, page: "register" },
  { pattern: /\bprofile\b/i, page: "profile" },
  { pattern: /\bcheckout\b/i, page: "checkout" },
]

const BACKEND_FEATURE_PATTERNS = [
  { pattern: /crud/i, feature: "CRUD operations" },
  { pattern: /jwt/i, feature: "JWT authentication" },
  { pattern: /rest\s*api/i, feature: "REST APIs" },
  { pattern: /\bvalidation\b/i, feature: "validation" },
  { pattern: /\bdto/i, feature: "DTOs" },
  { pattern: /\berror\s+handling\b/i, feature: "error handling" },
  { pattern: /\bmiddleware\b/i, feature: "middleware" },
  { pattern: /\bguards?\b/i, feature: "auth guards" },
  { pattern: /\bseed/i, feature: "seed data" },
  { pattern: /\bprisma\b/i, feature: "Prisma ORM" },
  { pattern: /\btypeorm\b/i, feature: "TypeORM" },
]

export function analyzeTaskComplexity(prompt: string): TaskAnalysis {
  // Check complexity level
  let complexity: TaskComplexity = "simple"

  for (const pattern of COMPLEXITY_SIGNALS.complex) {
    if (pattern.test(prompt)) {
      complexity = "complex"
      break
    }
  }
  if (complexity === "simple") {
    for (const pattern of COMPLEXITY_SIGNALS.medium) {
      if (pattern.test(prompt)) {
        complexity = "medium"
        break
      }
    }
  }

  // Extract expected modules
  const expectedModules = [...new Set(
    MODULE_PATTERNS
      .filter((p) => p.pattern.test(prompt))
      .map((p) => p.module)
  )]

  // Extract frontend pages
  const expectedFrontendPages = [...new Set(
    FRONTEND_PAGE_PATTERNS
      .filter((p) => p.pattern.test(prompt))
      .map((p) => p.page)
  )]

  // Extract backend features
  const expectedBackendFeatures = [...new Set(
    BACKEND_FEATURE_PATTERNS
      .filter((p) => p.pattern.test(prompt))
      .map((p) => p.feature)
  )]

  // Also upgrade complexity if many modules/pages detected
  if (expectedModules.length >= 3 && complexity === "simple") complexity = "medium"
  if (expectedModules.length >= 3 && expectedFrontendPages.length >= 2) complexity = "complex"
  if (expectedModules.length >= 4) complexity = "complex"

  // Estimate minimum expected files
  let minExpectedFiles: number
  let minExpectedToolCalls: number

  switch (complexity) {
    case "complex":
      // Full-stack: each module = ~3-5 files (controller, service, dto, entity/model)
      // Frontend: each page = ~1-2 files + shared components
      // Plus: config, schema, env, layout, etc.
      minExpectedFiles = Math.max(
        20,
        (expectedModules.length * 4) + (expectedFrontendPages.length * 2) + 8
      )
      minExpectedToolCalls = Math.max(15, minExpectedFiles + 5) // reads + writes + commands
      break
    case "medium":
      minExpectedFiles = Math.max(8, expectedModules.length * 3 + 4)
      minExpectedToolCalls = Math.max(8, minExpectedFiles + 3)
      break
    default:
      minExpectedFiles = 1
      minExpectedToolCalls = 2
  }

  // Extract keywords for matching
  const keywords = prompt.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)

  return {
    complexity,
    expectedModules,
    expectedFrontendPages,
    expectedBackendFeatures,
    minExpectedFiles,
    minExpectedToolCalls,
    keywords
  }
}

// ─── Completion Validation ───

export function validateCompletion(
  runId: string,
  prompt: string,
  analysis?: TaskAnalysis
): CompletionVerdict {
  const taskAnalysis = analysis || analyzeTaskComplexity(prompt)
  const runLog = getRunActions(runId)

  const filesCreated = runLog.filesModified // write_file and edit_file tracked here
  const totalActions = runLog.actions.length
  const writeActions = runLog.actions.filter((a) => a.tool === "write_file" || a.tool === "edit_file")
  const commandActions = runLog.actions.filter((a) => a.tool === "run_command")

  // ─── Simple tasks: minimal validation ───
  if (taskAnalysis.complexity === "simple") {
    if (totalActions < 1) {
      return { pass: false, reason: "No actions were taken. You must implement the task before completing." }
    }
    return { pass: true }
  }

  // ─── Medium/Complex tasks: strict validation ───

  // Check 1: Minimum file count
  if (filesCreated.length < taskAnalysis.minExpectedFiles) {
    const missing = taskAnalysis.minExpectedFiles - filesCreated.length
    const moduleHint = taskAnalysis.expectedModules.length > 0
      ? `\nExpected modules: ${taskAnalysis.expectedModules.join(", ")}`
      : ""
    const pageHint = taskAnalysis.expectedFrontendPages.length > 0
      ? `\nExpected frontend pages: ${taskAnalysis.expectedFrontendPages.join(", ")}`
      : ""

    return {
      pass: false,
      reason: `PREMATURE COMPLETION REJECTED. You created ${filesCreated.length} files but this task requires at least ${taskAnalysis.minExpectedFiles} files.${moduleHint}${pageHint}\n\nFiles created so far: ${filesCreated.join(", ") || "none"}\n\nYou MUST continue implementing. Create ALL backend modules, services, controllers, DTOs, frontend pages, and components. Do NOT complete until every feature from the original prompt is implemented with real code.`
    }
  }

  // Check 2: Minimum tool calls (prevents "create 1 file and complete")
  if (totalActions < taskAnalysis.minExpectedToolCalls) {
    return {
      pass: false,
      reason: `PREMATURE COMPLETION REJECTED. Only ${totalActions} tool calls were made but this ${taskAnalysis.complexity} task requires at least ${taskAnalysis.minExpectedToolCalls}. Continue implementing all remaining features.`
    }
  }

  // Check 3: For complex tasks with expected modules, verify each module has files
  if (taskAnalysis.complexity === "complex" && taskAnalysis.expectedModules.length > 0) {
    const missingModules: string[] = []
    for (const mod of taskAnalysis.expectedModules) {
      const hasFiles = filesCreated.some((f) =>
        f.toLowerCase().includes(mod.toLowerCase()) ||
        f.toLowerCase().includes(mod.toLowerCase().replace(/s$/, ""))
      )
      if (!hasFiles) missingModules.push(mod)
    }

    if (missingModules.length > 0) {
      return {
        pass: false,
        reason: `PREMATURE COMPLETION REJECTED. The following modules have NO files: ${missingModules.join(", ")}. You must create controllers, services, DTOs, and any related files for EACH module. Continue implementing.`
      }
    }
  }

  // Check 4: For complex tasks with frontend pages, verify page files exist
  if (taskAnalysis.complexity === "complex" && taskAnalysis.expectedFrontendPages.length > 0) {
    // Check if any frontend files exist at all
    const frontendFiles = filesCreated.filter((f) =>
      f.includes("frontend") || f.includes("client") || f.includes("app/") ||
      f.includes("pages/") || f.includes("components/") || f.includes("src/app")
    )

    if (frontendFiles.length < taskAnalysis.expectedFrontendPages.length) {
      return {
        pass: false,
        reason: `PREMATURE COMPLETION REJECTED. Expected ${taskAnalysis.expectedFrontendPages.length} frontend pages (${taskAnalysis.expectedFrontendPages.join(", ")}) but only found ${frontendFiles.length} frontend files. Create ALL pages with real UI code, not just stubs.`
      }
    }
  }

  // Check 5: Scaffolding-only detection — if most actions are commands (scaffolding) with few writes
  if (taskAnalysis.complexity === "complex") {
    const scaffoldRatio = commandActions.length / Math.max(1, totalActions)
    if (scaffoldRatio > 0.5 && writeActions.length < 10) {
      return {
        pass: false,
        reason: `PREMATURE COMPLETION REJECTED. Most actions were scaffolding commands (${commandActions.length} commands vs ${writeActions.length} file writes). Scaffolding is just the first step. You must now create ALL source files: modules, services, controllers, DTOs, pages, components, schemas, and configs.`
      }
    }
  }

  return { pass: true }
}

/**
 * Build a rejection message that gets sent back to the AI as a "tool result"
 * to force it to continue working.
 */
export function buildRejectionPayload(reason: string, prompt: string): {
  tool: string
  result: Record<string, unknown>
} {
  return {
    tool: "_completion_rejected",
    result: {
      success: false,
      error: reason,
      originalTask: prompt,
      hint: "Your completion was rejected because the task is not finished. Review the ORIGINAL TASK and the rejection reason above. Continue implementing with needs_tool. Do NOT try to complete again until ALL files are created."
    }
  }
}
