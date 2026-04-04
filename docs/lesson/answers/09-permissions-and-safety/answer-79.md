# Answers: Lesson 79 — Why Permissions Matter

## Exercise 1
**Question:** What is the "capability-safety balance" in AI agent design? Give two concrete examples of each extreme.

**Answer:** The capability-safety balance is the core tension in AI agent design: more capability makes the agent more useful but also more dangerous, while more safety makes it less dangerous but also less useful. Two examples of too-restrictive agents: (1) an agent that can't write files — it can only suggest changes in text, requiring the user to manually copy-paste every edit; (2) an agent that requires approval for every single read operation, even reading `package.json`, making basic exploration painfully slow. Two examples of too-permissive agents: (1) an agent that can execute `rm -rf /` without any check, potentially destroying the entire filesystem from a misinterpreted instruction like "clean up the project"; (2) an agent that reads `.env` files and includes their contents in API responses, leaking production secrets to external services. We can't simply "trust the AI model" because models hallucinate, have limited context, are vulnerable to prompt injection, and the composition of individually-safe actions can create dangerous chains.

---

## Exercise 2
**Challenge:** Implement a `classifyRisk` function.

**Answer:**
```typescript
import * as path from "path";

function classifyRisk(
  tool: string,
  input: Record<string, unknown>,
  projectRoot: string
): "low" | "medium" | "high" {
  const filePath = (input.path || input.file_path || "") as string;
  const command = (input.command || "") as string;

  const resolvedPath = filePath
    ? path.resolve(projectRoot, filePath)
    : "";
  const isInsideProject = resolvedPath.startsWith(path.resolve(projectRoot));

  const readOnlyTools = ["read_file", "grep", "glob", "list_directory", "search_files"];
  if (readOnlyTools.includes(tool)) {
    if (!filePath || isInsideProject) return "low";
    return "medium";
  }

  if (tool === "write_file" || tool === "edit_file") {
    if (!isInsideProject) return "high";
    const sensitivePatterns = [".env", ".ssh", "credentials", "secrets"];
    if (sensitivePatterns.some((p) => filePath.includes(p))) return "high";
    return "medium";
  }

  if (tool === "bash") {
    const dangerousTokens = [
      "rm -rf", "sudo", "chmod", "chown",
      "curl", "wget", "nc ", "ncat",
      "> /dev", "mkfs", "dd if=",
      "git push --force", "git push -f",
    ];
    if (dangerousTokens.some((t) => command.includes(t))) return "high";

    const safeCommands = [
      "ls", "cat", "echo", "pwd", "git status",
      "git log", "git diff", "npm test", "npx",
    ];
    if (safeCommands.some((c) => command.startsWith(c))) return "low";

    return "medium";
  }

  return "high";
}
```
**Explanation:** The function layers decisions: read-only tools are low risk within the project, file writes are medium risk within the project but high risk outside or to sensitive files, and bash commands are classified by token analysis. The fallback for unknown tools is "high" — defaulting to the most cautious classification when in doubt. The `projectRoot` resolution handles relative paths and prevents path traversal attacks.

---

## Exercise 3
**Challenge:** Write an `isWithinProject` function.

**Answer:**
```typescript
import * as path from "path";
import * as fs from "fs";

function isWithinProject(filePath: string, projectRoot: string): boolean {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedFile = path.resolve(projectRoot, filePath);

  if (!resolvedFile.startsWith(resolvedRoot + path.sep) &&
      resolvedFile !== resolvedRoot) {
    return false;
  }

  try {
    const realRoot = fs.realpathSync(resolvedRoot);
    const realFile = fs.realpathSync(path.dirname(resolvedFile));
    if (!realFile.startsWith(realRoot + path.sep) &&
        realFile !== realRoot) {
      return false;
    }
  } catch {
    // If realpath fails (file doesn't exist yet), check parent
    const parentDir = path.dirname(resolvedFile);
    try {
      const realParent = fs.realpathSync(parentDir);
      const realRoot = fs.realpathSync(resolvedRoot);
      return realParent.startsWith(realRoot + path.sep) ||
             realParent === realRoot;
    } catch {
      return false;
    }
  }

  return true;
}

// Tests
const root = "/home/user/project";
console.assert(isWithinProject("src/index.ts", root) === true);
console.assert(isWithinProject("../etc/passwd", root) === false);
console.assert(isWithinProject("../../etc/passwd", root) === false);
console.assert(isWithinProject("src/../../../etc/passwd", root) === false);
console.assert(isWithinProject("./src/utils.ts", root) === true);
```
**Explanation:** The function uses two layers of protection. First, it resolves the path and checks if it starts with the project root using string comparison (catches `../` traversal). Second, it uses `realpathSync` to resolve symlinks — a symlink inside the project that points outside would pass the first check but fail the second. The `path.sep` suffix prevents false positives (e.g., `/project-other` matching `/project`). When the file doesn't exist yet (new file creation), it checks the parent directory instead.

---

## Exercise 4
**Challenge:** Define `SafetyEvent` and implement `SafetyAuditLog`.

**Answer:**
```typescript
interface SafetyEvent {
  timestamp: number;
  tool: string;
  input: Record<string, unknown>;
  riskLevel: "low" | "medium" | "high";
  approved: boolean;
  approvalSource: "rule" | "classifier" | "user" | "auto";
  denialReason?: string;
}

interface AuditSummary {
  totalEvents: number;
  approved: number;
  denied: number;
  byRiskLevel: Record<string, { total: number; approved: number; denied: number }>;
  highRiskDenials: SafetyEvent[];
}

class SafetyAuditLog {
  private events: SafetyEvent[] = [];

  record(event: SafetyEvent): void {
    this.events.push(event);
  }

  getSummary(): AuditSummary {
    const summary: AuditSummary = {
      totalEvents: this.events.length,
      approved: this.events.filter((e) => e.approved).length,
      denied: this.events.filter((e) => !e.approved).length,
      byRiskLevel: {},
      highRiskDenials: this.events.filter(
        (e) => e.riskLevel === "high" && !e.approved
      ),
    };

    for (const level of ["low", "medium", "high"]) {
      const levelEvents = this.events.filter((e) => e.riskLevel === level);
      summary.byRiskLevel[level] = {
        total: levelEvents.length,
        approved: levelEvents.filter((e) => e.approved).length,
        denied: levelEvents.filter((e) => !e.approved).length,
      };
    }

    return summary;
  }

  toJSON(): string {
    return JSON.stringify(this.events, null, 2);
  }

  static fromJSON(json: string): SafetyAuditLog {
    const log = new SafetyAuditLog();
    log.events = JSON.parse(json);
    return log;
  }
}
```
**Explanation:** The `SafetyEvent` type captures everything needed for post-session review: what was attempted, the risk assessment, whether it was approved, and by what mechanism. The `SafetyAuditLog` class provides both raw storage and a summary view. The `highRiskDenials` field in the summary highlights the most important security events — high-risk actions that were blocked. Serialization support (`toJSON`/`fromJSON`) enables persisting the log for compliance and debugging.
