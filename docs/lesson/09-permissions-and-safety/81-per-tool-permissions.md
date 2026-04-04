# Lesson 81: Per-Tool Permissions

## Beyond Global Modes

Permission modes set the overall safety posture, but real-world usage demands finer control. You don't want to approve every single file write when you've been editing TypeScript files in `src/` for the past hour. You also don't want to allow writes to `package.json` without review, even if you've generally allowed writes.

Per-tool permissions solve this with pattern-matching rules that override mode defaults.

## The Permission Check Pipeline

Every tool execution starts with `checkPermissions()`:

```typescript
async function checkPermissions(
  tool: Tool,
  input: ToolInput,
  context: PermissionContext
): Promise<PermissionResult> {
  // 1. Check always-deny rules first (highest priority)
  const denyMatch = matchRules(context.rules.alwaysDeny, tool, input);
  if (denyMatch) {
    return {
      behavior: "deny",
      message: `Blocked by rule: ${denyMatch.pattern}`,
    };
  }

  // 2. Check always-allow rules
  const allowMatch = matchRules(context.rules.alwaysAllow, tool, input);
  if (allowMatch) {
    return {
      behavior: "allow",
      updatedInput: allowMatch.transformedInput,
    };
  }

  // 3. Check always-ask rules
  const askMatch = matchRules(context.rules.alwaysAsk, tool, input);
  if (askMatch) {
    return { behavior: "ask" };
  }

  // 4. Fall back to mode default
  return getDefaultBehaviorForMode(context.permissionMode, tool);
}
```

Notice the priority order: **deny > allow > ask > default**. This is critical. A deny rule always wins, even if an allow rule also matches. This prevents accidental permission escalation.

## The PermissionResult Type

```typescript
interface PermissionResult {
  behavior: "allow" | "deny" | "ask";
  updatedInput?: ToolInput;   // Rules can modify the tool input
  message?: string;           // Human-readable explanation
  rule?: PermissionRule;      // Which rule triggered this result
}
```

The `updatedInput` field is interesting — a permission rule can not only approve or deny a tool call, it can transform the input. For example, a rule might strip dangerous flags from a command while still allowing it:

```typescript
const sanitizeRule: PermissionRule = {
  tool: "bash",
  pattern: "npm *",
  behavior: "allow",
  transform: (input) => ({
    ...input,
    command: input.command.replace(/--force/g, ""), // Strip --force
  }),
};
```

## Permission Rules: The Three Lists

Claude Code maintains three lists of rules, each serving a distinct purpose:

### alwaysAllowRules

These rules grant permission without asking. They're the "I trust this" list:

```typescript
const alwaysAllowRules: PermissionRule[] = [
  // Allow reading any file
  { tool: "read_file", pattern: "**/*" },

  // Allow writing TypeScript files in src/
  { tool: "write_file", pattern: "src/**/*.ts" },
  { tool: "edit_file", pattern: "src/**/*.ts" },

  // Allow running test commands
  { tool: "bash", pattern: "npm test*" },
  { tool: "bash", pattern: "npx jest*" },
  { tool: "bash", pattern: "npx vitest*" },

  // Allow git status/log/diff (read-only git operations)
  { tool: "bash", pattern: "git status*" },
  { tool: "bash", pattern: "git log*" },
  { tool: "bash", pattern: "git diff*" },
];
```

### alwaysDenyRules

These rules block actions unconditionally. They're the hard safety boundaries:

```typescript
const alwaysDenyRules: PermissionRule[] = [
  // Never allow deleting the git directory
  { tool: "bash", pattern: "rm -rf .git*" },
  { tool: "bash", pattern: "rm -rf /.git*" },

  // Never allow modifying environment files with secrets
  { tool: "write_file", pattern: "**/.env" },
  { tool: "write_file", pattern: "**/.env.production" },

  // Never allow force-pushing
  { tool: "bash", pattern: "git push --force*" },
  { tool: "bash", pattern: "git push -f*" },

  // Never allow running as root
  { tool: "bash", pattern: "sudo *" },

  // Block access to sensitive system paths
  { tool: "write_file", pattern: "/etc/**" },
  { tool: "write_file", pattern: "/usr/**" },
  { tool: "write_file", pattern: "C:\\Windows\\**" },
];
```

### alwaysAskRules

These rules force a prompt even if other rules would allow the action:

```typescript
const alwaysAskRules: PermissionRule[] = [
  // Always ask before modifying package.json
  { tool: "write_file", pattern: "**/package.json" },
  { tool: "edit_file", pattern: "**/package.json" },

  // Always ask before running install commands
  { tool: "bash", pattern: "npm install*" },
  { tool: "bash", pattern: "pip install*" },
  { tool: "bash", pattern: "cargo add*" },

  // Always ask before network operations
  { tool: "bash", pattern: "curl *" },
  { tool: "bash", pattern: "wget *" },
];
```

## Rule Evaluation with Glob Patterns

Rules use glob patterns to match tool inputs. The matching depends on the tool type:

```typescript
import { minimatch } from "minimatch";

interface PermissionRule {
  tool: string;
  pattern: string;
  behavior?: "allow" | "deny" | "ask";
  transform?: (input: ToolInput) => ToolInput;
}

function matchRules(
  rules: PermissionRule[],
  tool: Tool,
  input: ToolInput
): PermissionRule | null {
  for (const rule of rules) {
    if (rule.tool !== tool.name) continue;

    const valueToMatch = getMatchableValue(tool, input);
    if (minimatch(valueToMatch, rule.pattern, { dot: true })) {
      return rule;
    }
  }
  return null;
}

function getMatchableValue(tool: Tool, input: ToolInput): string {
  switch (tool.name) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return input.path as string;  // Match against file path

    case "bash":
      return input.command as string; // Match against command string

    case "search_files":
    case "grep":
      return input.directory as string; // Match against search directory

    default:
      return JSON.stringify(input);  // Fallback: match against serialized input
  }
}
```

## Read vs Write Permission Checks

Claude Code distinguishes between read and write operations because they carry fundamentally different risk levels:

```typescript
function checkReadPermissionForTool(
  tool: Tool,
  input: ToolInput,
  context: PermissionContext
): PermissionResult {
  // Read operations check a simpler path
  // Most modes allow reads freely

  // Still check deny rules — some files shouldn't be readable
  const denyMatch = matchRules(context.rules.alwaysDeny, tool, input);
  if (denyMatch) {
    return { behavior: "deny", message: denyMatch.pattern };
  }

  // In all modes except a hypothetical "paranoid" mode, reads are allowed
  return { behavior: "allow" };
}

function checkWritePermissionForTool(
  tool: Tool,
  input: ToolInput,
  context: PermissionContext
): PermissionResult {
  // Write operations go through the full pipeline
  // Deny rules checked first
  const denyMatch = matchRules(context.rules.alwaysDeny, tool, input);
  if (denyMatch) {
    return { behavior: "deny", message: denyMatch.pattern };
  }

  // Allow rules checked next
  const allowMatch = matchRules(context.rules.alwaysAllow, tool, input);
  if (allowMatch) {
    return { behavior: "allow", updatedInput: allowMatch.transformedInput };
  }

  // Ask rules checked
  const askMatch = matchRules(context.rules.alwaysAsk, tool, input);
  if (askMatch) {
    return { behavior: "ask" };
  }

  // Default for writes: ask in default mode, classify in auto mode
  if (context.permissionMode === "auto") {
    return { behavior: "allow" }; // Auto mode delegates to classifier
  }
  return { behavior: "ask" };
}
```

## Building Rules Incrementally

In practice, rules build up over a session. Each time the user approves an action, they can choose to create a rule:

```typescript
interface UserApprovalChoice {
  action: "allow_once" | "allow_session" | "allow_always" | "deny";
  scope?: string; // Glob pattern for always rules
}

function handleUserApproval(
  choice: UserApprovalChoice,
  tool: Tool,
  input: ToolInput,
  rules: PermissionRules
): void {
  switch (choice.action) {
    case "allow_once":
      // No rule created, just proceed
      break;

    case "allow_session":
      // Rule lasts until the session ends (in-memory only)
      rules.alwaysAllow.push({
        tool: tool.name,
        pattern: choice.scope || derivePattern(tool, input),
        session: true,
      });
      break;

    case "allow_always":
      // Rule persisted to configuration file
      rules.alwaysAllow.push({
        tool: tool.name,
        pattern: choice.scope || derivePattern(tool, input),
        session: false,
      });
      persistRules(rules);
      break;

    case "deny":
      // Could also create a deny rule
      break;
  }
}

function derivePattern(tool: Tool, input: ToolInput): string {
  // Generalize the specific input into a pattern
  if (tool.name === "write_file") {
    const filePath = input.path as string;
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    return `${dir}/**/*${ext}`; // e.g., "src/utils/**/*.ts"
  }
  if (tool.name === "bash") {
    const command = input.command as string;
    const firstWord = command.split(" ")[0];
    return `${firstWord} *`; // e.g., "npm *"
  }
  return "**/*";
}
```

## Example: A Full Permission Evaluation

Let's trace a real permission check from start to finish:

```typescript
// The agent wants to run: npm test -- --watch
const tool = { name: "bash" };
const input = { command: "npm test -- --watch" };

// User's current rules:
const rules = {
  alwaysDeny: [
    { tool: "bash", pattern: "rm -rf *" },
    { tool: "bash", pattern: "sudo *" },
  ],
  alwaysAllow: [
    { tool: "bash", pattern: "npm test*" },  // User approved this earlier
    { tool: "read_file", pattern: "**/*" },
  ],
  alwaysAsk: [
    { tool: "bash", pattern: "npm install*" },
  ],
};

// Step 1: Check deny rules
// "npm test -- --watch" vs "rm -rf *" → no match
// "npm test -- --watch" vs "sudo *" → no match

// Step 2: Check allow rules
// "npm test -- --watch" vs "npm test*" → MATCH!
// Result: { behavior: "allow" }

// The command executes without prompting the user
```

Now trace a denied operation:

```typescript
// The agent wants to run: sudo apt-get install ripgrep
const tool = { name: "bash" };
const input = { command: "sudo apt-get install ripgrep" };

// Step 1: Check deny rules
// "sudo apt-get install ripgrep" vs "rm -rf *" → no match
// "sudo apt-get install ripgrep" vs "sudo *" → MATCH!
// Result: { behavior: "deny", message: "Blocked by rule: sudo *" }

// The command is blocked. The model receives an error:
// "Permission denied: cannot execute 'sudo apt-get install ripgrep'.
//  Reason: Blocked by rule: sudo *"
```

## Summary

Per-tool permissions give you surgical control over what the agent can do. The three-list system (deny > allow > ask) creates a clear priority order. Glob patterns make rules expressive yet readable. And the incremental rule-building flow means users start safe and progressively grant trust as they work.

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Rule Priority Order
**Question:** What is the priority order for rule evaluation in the permission system, and why does "deny" always win over "allow"? What could go wrong if the order were reversed?

[View Answer](../../answers/09-permissions-and-safety/answer-81.md#exercise-1)

### Exercise 2 — Implement matchRules with Glob
**Challenge:** Write a `matchRules` function that takes an array of `PermissionRule` objects, a tool name, and a tool input. Use glob pattern matching (via `minimatch`) to check if any rule matches the tool's matchable value (file path for file tools, command string for bash).

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-81.md#exercise-2)

### Exercise 3 — Implement derivePattern
**Challenge:** Write a `derivePattern` function that generalizes a specific tool input into a reusable glob pattern. For file writes, generalize `src/utils/parser.ts` into `src/utils/**/*.ts`. For bash commands, generalize `npm test -- --watch` into `npm test*`. Handle edge cases like deeply nested paths and multi-word commands.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-81.md#exercise-3)

### Exercise 4 — Permission Rule Test Suite
**Challenge:** Write a test suite that verifies: (a) a deny rule blocks even when an allow rule matches, (b) an allow rule skips the user prompt, (c) the default for unknown tools is "ask", and (d) rules match correctly using glob patterns.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-81.md#exercise-4)
