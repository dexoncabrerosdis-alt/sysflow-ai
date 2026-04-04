# Answers: Lesson 80 — Permission Modes

## Exercise 1
**Question:** Compare the four permission modes across reads, writes, and shell commands.

**Answer:** **Default mode**: Reads are allowed freely, writes require user approval ("ask"), shell commands require user approval ("ask"). Best for normal interactive development where you want to review changes. **Plan mode**: Reads are allowed, writes are denied entirely, shell commands are denied. Best for analyzing a codebase and proposing plans without risking any modifications. **Auto mode**: Reads are allowed, writes are classified by an AI classifier (auto-allow if safe, ask if uncertain), shell commands are classified similarly. Best for experienced users who want less friction during long coding sessions. **Bypass mode**: Everything is allowed — reads, writes, and shell commands all proceed without any checks. Best for CI/CD pipelines and automated environments where safety comes from the sandboxed execution environment rather than permission prompts.

---

## Exercise 2
**Challenge:** Implement `getPermissionBehavior` for all four modes.

**Answer:**
```typescript
type PermissionMode = "default" | "plan" | "auto" | "bypassPermissions";

interface Tool {
  name: string;
  isReadOnly: boolean;
}

function getPermissionBehavior(
  mode: PermissionMode,
  tool: Tool
): "allow" | "ask" | "deny" {
  switch (mode) {
    case "bypassPermissions":
      return "allow";

    case "plan":
      return tool.isReadOnly ? "allow" : "deny";

    case "auto":
      return tool.isReadOnly ? "allow" : "allow";

    case "default":
    default:
      return tool.isReadOnly ? "allow" : "ask";
  }
}

// Tests
const readTool: Tool = { name: "read_file", isReadOnly: true };
const writeTool: Tool = { name: "write_file", isReadOnly: false };
const bashTool: Tool = { name: "bash", isReadOnly: false };

console.assert(getPermissionBehavior("default", readTool) === "allow");
console.assert(getPermissionBehavior("default", writeTool) === "ask");
console.assert(getPermissionBehavior("plan", writeTool) === "deny");
console.assert(getPermissionBehavior("plan", readTool) === "allow");
console.assert(getPermissionBehavior("bypassPermissions", bashTool) === "allow");
console.assert(getPermissionBehavior("auto", writeTool) === "allow");
```
**Explanation:** The function uses a switch over the permission mode and branches on `isReadOnly`. Note that auto mode returns "allow" for write tools here because the actual classification happens in a separate layer (the bash classifier, covered in Lesson 83). The `getPermissionBehavior` function represents the mode's *default intent* — per-tool rules and classifiers add additional refinement on top.

---

## Exercise 3
**Challenge:** Implement a `PermissionModeManager` class.

**Answer:**
```typescript
type ModeChangeListener = (from: PermissionMode, to: PermissionMode) => void;

const VALID_TRANSITIONS: Record<PermissionMode, PermissionMode[]> = {
  default: ["plan", "auto"],
  plan: ["default", "auto"],
  auto: ["default", "plan"],
  bypassPermissions: [],
};

class PermissionModeManager {
  private currentMode: PermissionMode;
  private listeners: ModeChangeListener[] = [];

  constructor(initialMode: PermissionMode = "default") {
    this.currentMode = initialMode;
  }

  getMode(): PermissionMode {
    return this.currentMode;
  }

  switchMode(newMode: PermissionMode): { success: boolean; message: string } {
    if (newMode === this.currentMode) {
      return { success: true, message: `Already in ${newMode} mode.` };
    }

    const allowed = VALID_TRANSITIONS[this.currentMode];
    if (!allowed.includes(newMode)) {
      return {
        success: false,
        message: `Cannot switch from ${this.currentMode} to ${newMode}. ` +
          `Allowed transitions: ${allowed.join(", ") || "none"}.`,
      };
    }

    const oldMode = this.currentMode;
    this.currentMode = newMode;

    for (const listener of this.listeners) {
      listener(oldMode, newMode);
    }

    return {
      success: true,
      message: `Permission mode changed to: ${newMode}. ` +
        `Adjust your behavior accordingly.`,
    };
  }

  onModeChange(listener: ModeChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }
}

// Tests
const manager = new PermissionModeManager("default");
console.assert(manager.switchMode("plan").success === true);
console.assert(manager.getMode() === "plan");
console.assert(manager.switchMode("bypassPermissions").success === false);
```
**Explanation:** The manager enforces transition rules: bypass mode cannot be entered from any interactive mode (it must be set at startup for CI/CD). Similarly, once in bypass, you can't switch out — this prevents confused state where some operations ran with full trust and others don't. The event listener pattern allows the system prompt to be updated when the mode changes. The unsubscribe function (returned by `onModeChange`) prevents memory leaks.

---

## Exercise 4
**Challenge:** Write the full `checkPermission` pipeline function.

**Answer:**
```typescript
interface PermissionRule {
  tool: string;
  pattern: string;
}

interface PermissionResult {
  behavior: "allow" | "deny" | "ask";
  message?: string;
  updatedInput?: Record<string, unknown>;
}

interface PermissionContext {
  permissionMode: PermissionMode;
  tool: Tool;
  input: Record<string, unknown>;
  rules: {
    alwaysDeny: PermissionRule[];
    alwaysAllow: PermissionRule[];
    alwaysAsk: PermissionRule[];
  };
}

function checkPermission(ctx: PermissionContext): PermissionResult {
  // Layer 1: Mode-level overrides
  if (ctx.permissionMode === "bypassPermissions") {
    return { behavior: "allow" };
  }
  if (ctx.permissionMode === "plan" && !ctx.tool.isReadOnly) {
    return { behavior: "deny", message: "Plan mode: read-only operations only." };
  }

  const matchValue = getMatchableValue(ctx.tool, ctx.input);

  // Layer 2: Deny rules (highest priority)
  for (const rule of ctx.rules.alwaysDeny) {
    if (rule.tool === ctx.tool.name && minimatch(matchValue, rule.pattern)) {
      return { behavior: "deny", message: `Blocked by rule: ${rule.pattern}` };
    }
  }

  // Layer 3: Allow rules
  for (const rule of ctx.rules.alwaysAllow) {
    if (rule.tool === ctx.tool.name && minimatch(matchValue, rule.pattern)) {
      return { behavior: "allow" };
    }
  }

  // Layer 4: Ask rules
  for (const rule of ctx.rules.alwaysAsk) {
    if (rule.tool === ctx.tool.name && minimatch(matchValue, rule.pattern)) {
      return { behavior: "ask" };
    }
  }

  // Layer 5: Mode default
  if (ctx.tool.isReadOnly) {
    return { behavior: "allow" };
  }

  if (ctx.permissionMode === "auto") {
    return { behavior: "allow" };
  }

  return { behavior: "ask" };
}

function getMatchableValue(tool: Tool, input: Record<string, unknown>): string {
  if (tool.name === "bash") return (input.command || "") as string;
  return (input.path || input.file_path || "") as string;
}

function minimatch(value: string, pattern: string): boolean {
  const regex = pattern
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regex}$`).test(value);
}
```
**Explanation:** The pipeline evaluates in strict priority order: bypass mode short-circuits everything, plan mode blocks all writes, then deny rules are checked (highest priority among rules), then allow rules, then ask rules, and finally the mode's default behavior. This layered approach ensures that safety boundaries (deny rules) can never be overridden by convenience rules (allow rules). The simplified `minimatch` demonstrates the concept; production code uses the `minimatch` npm package for full glob support.
