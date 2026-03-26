// ─── Directory Tree ───

export interface DirectoryEntry {
  name: string
  type: "file" | "directory"
}

// ─── Provider Payload & Response ───

export interface ToolResult {
  tool: string
  result: Record<string, unknown>
}

export interface ToolCall {
  id: string
  tool: string
  args: Record<string, unknown>
}

export interface BatchToolResult {
  id: string
  tool: string
  result: Record<string, unknown>
}

export interface ProviderPayload {
  model: string
  runId: string
  userMessage: string
  directoryTree: DirectoryEntry[]
  context: ProviderContext
  toolResult?: ToolResult
  toolResults?: BatchToolResult[]
  task?: TaskMeta
  userId?: string | null
  chatId?: string | null
  command?: string
}

export interface ProviderContext {
  sessionHistory?: string
  continueFrom?: ContinueFrom
  continueContext?: string
  projectMemory?: string[] | string
  projectKnowledge?: string
}

export interface ContinueFrom {
  outcome: string
  prompt: string
  error?: string
  filesModified: string[]
  actions: Array<{ tool: string; path?: string }>
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  generationData?: Record<string, unknown> | null
}

export interface NormalizedResponse {
  kind: "needs_tool" | "completed" | "failed" | "waiting_for_user"
  content?: string
  reasoning?: string | null
  tool?: string
  args?: Record<string, unknown>
  tools?: ToolCall[]
  error?: string
  usage: TokenUsage
  summary?: string | null
  task?: TaskMeta | null
  taskStep?: string | null
  stepTransition?: { complete?: string; start?: string }
  pendingAction?: unknown
}

// ─── Task ───

export interface TaskStep {
  id: string
  label: string
  status: "pending" | "in_progress" | "completed" | "failed"
}

export interface TaskMeta {
  id: string
  runId: string
  projectId: string
  model: string
  title: string
  goal: string
  steps: TaskStep[]
  status: "running" | "completed" | "failed"
}

// ─── Run ───

export interface RunState {
  id: string
  taskId: string
  projectId: string
  model: string
  status: "running" | "completed" | "failed"
  userId?: string | null
  chatId?: string | null
}

// ─── Client Response ───

export interface ClientResponse {
  status: "needs_tool" | "completed" | "waiting_for_user" | "failed"
  runId: string
  tool?: string
  args?: Record<string, unknown>
  tools?: ToolCall[]
  content?: string | null
  reasoning?: string | null
  message?: string | null
  summary?: string | null
  task?: TaskMeta | null
  taskStep?: string | null
  stepTransition?: { complete?: string; start?: string }
  pendingAction?: unknown
  error?: string
}

// ─── Database ───

export interface MigrationModule {
  default: {
    name: string
    up: string
  }
}

// ─── Subscription ───

export type PlanId = "free" | "lite" | "pro" | "team"

export interface Plan {
  id: PlanId
  label: string
  price: number
  creditsPerMonth: number
  stripePriceId: string | null
}

export interface Subscription {
  plan: PlanId
  credits_total_cents: number
  credits_used_cents: number
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
}
