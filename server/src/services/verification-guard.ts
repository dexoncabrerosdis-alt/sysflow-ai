/**
 * Verification Guard — blocks task completion if there are unresolved
 * verification errors (type errors, broken imports, empty files).
 *
 * Works alongside completion-guard.ts:
 * - completion-guard: prevents premature completion (not enough files)
 * - verification-guard: prevents completion with broken code
 */

export interface VerificationState {
  lastErrors: string[]
  lastWarnings: string[]
  attemptCount: number
  filesWithErrors: string[]
  lastCheckedAt: number
}

const verificationState = new Map<string, VerificationState>()
const MAX_FIX_ATTEMPTS = 3

export function recordVerificationResult(
  runId: string,
  passed: boolean,
  errors: string[],
  warnings: string[]
): void {
  if (passed) {
    // Clear state on success
    verificationState.delete(runId)
    return
  }

  const existing = verificationState.get(runId)
  const attemptCount = existing ? existing.attemptCount + 1 : 1

  // Extract file paths from error messages
  const filesWithErrors = [...new Set(
    errors
      .map((e) => {
        const match = e.match(/^([^:]+\.(ts|tsx|js|jsx|json|prisma)):/)
        return match ? match[1] : null
      })
      .filter(Boolean) as string[]
  )]

  verificationState.set(runId, {
    lastErrors: errors.slice(0, 20),
    lastWarnings: warnings.slice(0, 10),
    attemptCount,
    filesWithErrors,
    lastCheckedAt: Date.now()
  })

  console.log(`[verification-guard] Run ${runId}: ${errors.length} errors (attempt ${attemptCount}/${MAX_FIX_ATTEMPTS})`)
}

export function getVerificationState(runId: string): VerificationState | undefined {
  return verificationState.get(runId)
}

export function clearVerificationState(runId: string): void {
  verificationState.delete(runId)
}

export function shouldBlockCompletion(runId: string): { block: boolean; reason?: string } {
  const state = verificationState.get(runId)
  if (!state) return { block: false }
  if (state.lastErrors.length === 0) return { block: false }
  if (state.attemptCount >= MAX_FIX_ATTEMPTS) {
    console.log(`[verification-guard] Max fix attempts reached for ${runId} — allowing completion with errors`)
    return { block: false }
  }

  return {
    block: true,
    reason: `VERIFICATION FAILED (attempt ${state.attemptCount}/${MAX_FIX_ATTEMPTS}). Fix these errors before completing:\n\n${state.lastErrors.map((e) => `  ✗ ${e}`).join("\n")}\n\nRead the files with errors and fix them. Do NOT complete until verification passes.`
  }
}

/**
 * Build a needs_tool response that forces the AI to read and fix errored files.
 */
export function buildVerificationFixPayload(state: VerificationState): {
  tool: string
  args: Record<string, unknown>
  content: string
} {
  const filesToRead = state.filesWithErrors.slice(0, 5)

  if (filesToRead.length > 1) {
    return {
      tool: "batch_read",
      args: { paths: filesToRead },
      content: `Verification found ${state.lastErrors.length} errors. Reading affected files to fix them.`
    }
  }

  if (filesToRead.length === 1) {
    return {
      tool: "read_file",
      args: { path: filesToRead[0] },
      content: `Verification found errors in ${filesToRead[0]}. Reading to fix.`
    }
  }

  // No specific files — just list directory to get context
  return {
    tool: "list_directory",
    args: { path: "." },
    content: `Verification found ${state.lastErrors.length} errors. Checking project state.`
  }
}
