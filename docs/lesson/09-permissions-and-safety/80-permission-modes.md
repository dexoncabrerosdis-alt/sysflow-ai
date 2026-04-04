# Lesson 80: Permission Modes

## Four Modes, Four Philosophies

Claude Code doesn't use a single permission setting. It offers four distinct permission modes, each designed for a different use case. The mode you choose fundamentally changes how the agent loop behaves — which tools require approval, how the model is routed, and what the user experience feels like.

```typescript
type PermissionMode = "default" | "plan" | "auto" | "bypassPermissions";
```

Let's explore each one.

## Mode 1: Default — Ask Before Danger

The default mode is what most users experience. The agent can read freely but asks before writing or executing:

```typescript
function getDefaultPermissionBehavior(tool: Tool): "allow" | "ask" {
  switch (tool.type) {
    case "read_file":
    case "list_directory":
    case "search_files":
    case "grep":
      return "allow";   // Reading is safe

    case "write_file":
    case "edit_file":
      return "ask";     // Writing needs approval

    case "bash":
      return "ask";     // Shell commands need approval

    default:
      return "ask";     // Unknown tools need approval
  }
}
```

In default mode, the first time the agent wants to write a file, the user sees a prompt:

```
Agent wants to write to: src/utils/parser.ts
[Allow] [Allow Always for src/**] [Deny]
```

The user can allow once, create a permanent rule, or deny. This creates the progressive trust model — as you work with the agent, you build up allow rules that reduce friction.

**When to use:** Interactive development sessions where you want to review changes before they happen.

## Mode 2: Plan — Read-Only Exploration

Plan mode transforms the agent into a pure analyst. It can read and search but cannot modify anything:

```typescript
function getPlanModePermissionBehavior(tool: Tool): "allow" | "deny" {
  if (isReadOnlyTool(tool)) {
    return "allow";
  }
  return "deny"; // All write operations blocked
}

function isReadOnlyTool(tool: Tool): boolean {
  const readOnlyTools = [
    "read_file",
    "list_directory",
    "search_files",
    "grep",
    "glob",
  ];
  return readOnlyTools.includes(tool.type);
}
```

But plan mode does more than just block writes. It also changes **which model** handles the request. In Claude Code's architecture, plan mode can route to a different model optimized for analysis and planning rather than code generation:

```typescript
async function routeModel(
  permissionMode: PermissionMode,
  task: string
): Promise<ModelConfig> {
  if (permissionMode === "plan") {
    return {
      model: "claude-sonnet", // Faster, cheaper for analysis
      systemPrompt: getPlanModeSystemPrompt(),
      maxTokens: PLAN_MAX_TOKENS,
    };
  }
  return {
    model: "claude-sonnet", // Full model for implementation
    systemPrompt: getDefaultSystemPrompt(),
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}
```

The system prompt also changes in plan mode to instruct the model to analyze rather than implement:

```typescript
function getPlanModeSystemPrompt(): string {
  return `You are in PLAN mode. You can read files and analyze code,
but you cannot make changes. Provide analysis, suggestions, and plans
that the user can review before switching to implementation mode.

Do NOT attempt to call write_file, edit_file, or bash tools.
Instead, describe what changes you would make and why.`;
}
```

**When to use:** When you want the agent to analyze a codebase and propose a plan before making any changes. Great for understanding unfamiliar code or planning large refactors.

## Mode 3: Auto — AI-Classified Safety

Auto mode is the middle ground between default and bypass. Instead of asking the user about every write operation, it uses an AI classifier to determine whether an action is safe:

```typescript
async function getAutoModePermissionBehavior(
  tool: Tool,
  input: ToolInput
): Promise<"allow" | "ask"> {
  if (isReadOnlyTool(tool)) {
    return "allow";
  }

  // For write operations, classify the risk
  const classification = await classifyToolSafety(tool, input);

  if (classification.confidence > 0.95 && classification.safe) {
    return "allow"; // High confidence safe → proceed
  }

  return "ask"; // Uncertain or unsafe → ask user
}
```

The classifier considers factors like:
- Is this a standard development operation? (creating source files, running tests)
- Does the command modify files outside the project?
- Does the bash command contain dangerous patterns?
- Is this a common workflow the user has been doing?

```typescript
interface ClassificationResult {
  safe: boolean;
  confidence: number;
  reasoning: string;
  factors: {
    withinProject: boolean;
    commonOperation: boolean;
    destructivePotential: "none" | "low" | "medium" | "high";
    networkAccess: boolean;
  };
}
```

We'll explore the bash classifier in detail in Lesson 83. For now, understand that auto mode makes the agent feel more autonomous while still catching genuinely risky operations.

**When to use:** Experienced users who understand the risks and want less friction. Useful for long coding sessions where constant approval prompts slow you down.

## Mode 4: Bypass — Full Trust for Automation

Bypass mode skips all permission checks. Every tool call proceeds immediately without approval:

```typescript
function getBypassPermissionBehavior(_tool: Tool): "allow" {
  return "allow"; // Everything proceeds
}
```

This mode exists specifically for **non-interactive environments** where no human is present to approve:

- CI/CD pipelines
- Automated code review bots
- Batch processing scripts
- Testing harnesses

```typescript
// In a CI pipeline configuration
const agentConfig = {
  permissionMode: "bypassPermissions" as const,
  // Safety comes from the environment instead:
  sandboxed: true,           // Running in a container
  readOnlyFilesystem: false, // Can write, but it's ephemeral
  networkRestricted: true,   // No outbound access
  timeoutMs: 300_000,        // 5 minute hard timeout
};
```

The critical insight: bypass mode shifts safety responsibility from the permission system to the **execution environment**. If the agent runs in a disposable container with no access to production systems, letting it do anything is fine — the blast radius is contained.

**When to use:** Automated pipelines with proper sandboxing. Never for interactive use unless you truly understand the risks.

## The ToolPermissionContext Type

All permission decisions flow through a central context object:

```typescript
interface ToolPermissionContext {
  permissionMode: PermissionMode;
  tool: Tool;
  input: ToolInput;
  rules: {
    alwaysAllow: PermissionRule[];
    alwaysDeny: PermissionRule[];
    alwaysAsk: PermissionRule[];
  };
  abortSignal: AbortSignal;
  options: {
    isInteractive: boolean;
    hasBridge: boolean;       // Connected to a UI
    trustLevel: "none" | "session" | "permanent";
  };
}
```

This context gets passed through the permission checking pipeline. Each layer examines what it needs and passes the rest along:

```typescript
async function checkPermission(
  ctx: ToolPermissionContext
): Promise<PermissionResult> {
  // Layer 1: Mode-level override
  if (ctx.permissionMode === "bypassPermissions") {
    return { behavior: "allow" };
  }
  if (ctx.permissionMode === "plan" && !isReadOnlyTool(ctx.tool)) {
    return { behavior: "deny", message: "Plan mode: read-only" };
  }

  // Layer 2: Explicit rules (always-deny wins over always-allow)
  const ruleResult = evaluateRules(ctx);
  if (ruleResult) return ruleResult;

  // Layer 3: Mode-specific behavior
  if (ctx.permissionMode === "auto") {
    return await classifyAndDecide(ctx);
  }

  // Layer 4: Default behavior for the tool
  return getDefaultBehavior(ctx.tool);
}
```

## Permission Mode in the Query Loop

Remember the agent loop from Module 02? Permission mode affects it at a critical point — right before tool execution:

```typescript
async function* agentLoop(config: AgentConfig): AsyncGenerator<Message> {
  while (true) {
    const response = await callModel(config);

    for (const block of response.content) {
      if (block.type === "tool_use") {
        // Permission check happens HERE
        const permitted = await checkPermission({
          permissionMode: config.permissionMode,
          tool: getToolByName(block.name),
          input: block.input,
          rules: config.permissionRules,
          abortSignal: config.signal,
          options: config.permissionOptions,
        });

        if (permitted.behavior === "deny") {
          yield createDenialMessage(block, permitted.message);
          continue;
        }

        if (permitted.behavior === "ask") {
          const userDecision = await promptUser(block);
          if (!userDecision.approved) {
            yield createDenialMessage(block, "User denied");
            continue;
          }
        }

        // Only reaches here if allowed
        const result = await executeTool(block.name, block.input);
        yield createToolResultMessage(block.id, result);
      }
    }

    if (response.stop_reason === "end_turn") break;
  }
}
```

The permission check is a gate. The model proposes an action, the permission system evaluates it, and only approved actions execute. Denied actions generate a tool result explaining the denial, which the model sees and can adapt to.

## Switching Modes at Runtime

Users can switch modes during a session. This is represented as a state change that affects all subsequent permission checks:

```typescript
class AgentSession {
  private permissionMode: PermissionMode = "default";

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    // Notify the model about the mode change
    this.injectSystemMessage(
      `Permission mode changed to: ${mode}. ` +
      `Adjust your behavior accordingly.`
    );
  }
}
```

A common workflow: start in plan mode to understand the codebase, then switch to default mode to implement changes. This gives the user a natural review-then-act workflow.

## Summary

| Mode | Reads | Writes | Shell | Use Case |
|------|-------|--------|-------|----------|
| Default | Allow | Ask | Ask | Normal interactive use |
| Plan | Allow | Deny | Deny | Analysis and planning |
| Auto | Allow | Classify | Classify | Experienced users |
| Bypass | Allow | Allow | Allow | CI/CD pipelines |

The permission mode is the broadest control knob. It sets the overall safety posture. Within each mode, finer-grained controls (per-tool rules, classifiers) add precision. In the next lesson, we'll explore those per-tool permission rules.

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Comparing Permission Modes
**Question:** For each of the four permission modes (default, plan, auto, bypass), state whether reads, writes, and shell commands are allowed, ask, or denied. In what scenario is each mode most appropriate?

[View Answer](../../answers/09-permissions-and-safety/answer-80.md#exercise-1)

### Exercise 2 — Implement getPermissionBehavior
**Challenge:** Write a `getPermissionBehavior` function that takes a `PermissionMode` and a `Tool` object, and returns `"allow" | "ask" | "deny"`. Handle all four modes with the correct behavior for read-only tools vs. write tools vs. bash.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-80.md#exercise-2)

### Exercise 3 — PermissionModeManager Class
**Challenge:** Implement a `PermissionModeManager` class that tracks the current mode, validates mode transitions (e.g., cannot switch directly from plan to bypass), emits events on mode changes, and injects a system message notifying the model.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-80.md#exercise-3)

### Exercise 4 — Permission Check Pipeline
**Challenge:** Write the full `checkPermission` function that layers mode-level overrides, explicit rules (deny > allow > ask), auto-mode classification, and default behavior. Return a `PermissionResult` with `behavior`, optional `message`, and optional `updatedInput`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-80.md#exercise-4)
