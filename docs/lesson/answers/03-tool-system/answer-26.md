# Answers: Lesson 26 — Read-Only vs. Write Tools

## Exercise 1
**Question:** What determines whether a tool needs a permission prompt? Describe the three-level hierarchy and give an example tool that falls into each level.

**Answer:** The permission cascade has three levels:

1. **Read-only tools → always allowed, never prompt.** If `tool.isReadOnly` is `true`, the function returns immediately. Example: `Read` — reading a file is inherently safe, so no permission needed.

2. **Write tools with matching permission rules → auto-approved.** If the tool has a `checkPermissions()` method and the user has configured rules that pre-approve the operation, it's allowed without prompting. Example: `Write` to a file in a directory the user has whitelisted in their permission config.

3. **Write tools without matching rules → prompt the user.** If the tool is a write tool and no permission rule covers this specific operation, the user is shown a prompt like "Allow Write to src/index.ts?" Example: `Bash` running `rm -rf node_modules` — no pre-configured rule, so the user must approve.

This hierarchy balances productivity (no friction for safe reads) with safety (explicit gates on destructive writes).

---

## Exercise 2
**Challenge:** Implement the `shouldPromptUser()` function.

**Answer:**

```typescript
type Tool = {
  name: string;
  isReadOnly: boolean;
  checkPermissions?: (
    input: unknown,
    context: ToolContext
  ) => Promise<{ allowed: boolean; reason?: string }>;
};

type PermissionRule = {
  tool: string;
  pattern: string;
  allow: boolean;
};

async function shouldPromptUser(
  tool: Tool,
  input: unknown,
  context: ToolContext
): Promise<boolean> {
  // Level 1: Read-only tools never need permission
  if (tool.isReadOnly) {
    return false;
  }

  // Level 2: Check if permission rules auto-approve
  if (tool.checkPermissions) {
    const result = await tool.checkPermissions(input, context);
    if (result.allowed) {
      return false;  // pre-approved by rules
    }
  }

  // Level 3: No auto-approval — must prompt the user
  return true;
}
```

**Explanation:** The function implements the three-level cascade directly: check read-only first (cheapest check), then consult permission rules (may involve async checks), and finally default to prompting. Each level is a potential early return.

---

## Exercise 3
**Question:** Why is Bash marked as `isReadOnly: false` even though many bash commands are read-only?

**Answer:** Bash is marked `isReadOnly: false` because the tool *can* execute destructive commands — `rm -rf /`, `drop table users`, `git push --force` are all valid Bash inputs. The `isReadOnly` flag is a static property of the tool, not of any specific invocation. Since a single Bash tool handles all commands (read-only and destructive alike), it must be classified by its most dangerous capability.

Claude Code handles the tension through input-aware permission checks: the `checkPermissions()` function examines the actual command string. Commands like `ls`, `git status`, and `cat` are recognized as read-only and auto-approved. Commands like `rm`, `npm install`, and arbitrary scripts trigger a user prompt. This gives the tool a static write classification (for the safety system) while dynamically allowing read-only commands through without friction.

---

## Exercise 4
**Challenge:** Write an `isReadOnlyCommand()` function for bash commands.

**Answer:**

```typescript
function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();

  // Reject commands with output redirection (even "safe" commands can write)
  if (/[>|]/.test(trimmed)) {
    return false;
  }

  // Reject commands with shell operators that could chain writes
  if (/[;&]/.test(trimmed) && !trimmed.startsWith("git log")) {
    return false;
  }

  const safeCommands = [
    /^ls(\s|$)/,
    /^cat\s/,
    /^head\s/,
    /^tail\s/,
    /^echo\s/,
    /^pwd$/,
    /^whoami$/,
    /^which\s/,
    /^type\s/,
    /^wc\s/,
    /^file\s/,
    /^stat\s/,
    /^du\s/,
    /^df(\s|$)/,
    /^find\s/,
    /^grep\s/,
    /^rg\s/,
    /^git\s+status/,
    /^git\s+log/,
    /^git\s+diff/,
    /^git\s+show/,
    /^git\s+branch(\s+-[av]|\s*$)/,
    /^node\s+--version/,
    /^npm\s+list/,
    /^npm\s+--version/,
    /^python\s+--version/,
    /^env$/,
    /^printenv/,
  ];

  return safeCommands.some((pattern) => pattern.test(trimmed));
}

// Tests:
console.log(isReadOnlyCommand("ls -la"));           // true
console.log(isReadOnlyCommand("cat src/index.ts"));  // true
console.log(isReadOnlyCommand("git status"));        // true
console.log(isReadOnlyCommand("cat > file.txt"));    // false (redirect!)
console.log(isReadOnlyCommand("rm -rf /"));          // false
console.log(isReadOnlyCommand("echo hello > f.txt"));// false (redirect!)
console.log(isReadOnlyCommand("npm install"));       // false
```

**Explanation:** The function first rejects any command with output redirection (`>`) or pipe (`|`), which catches `cat > file.txt` even though `cat` alone is safe. Then it checks against a whitelist of known read-only command patterns. The regex patterns use `(\s|$)` to prevent partial matches. Unknown commands default to `false` (unsafe) since we can't know what they do.

---

## Exercise 5
**Challenge:** Classify each tool as read-only or write, and determine if it needs a permission prompt.

**Answer:**

1. **Port checker** — `isReadOnly: true`, no prompt. It observes network state without modifying anything. Opening a TCP connection to check if a port responds is analogous to reading a file.

2. **Slack message sender** — `isReadOnly: false`, prompt needed. Sending a message is a side effect on an external system. It's irreversible — you can't unsend a Slack message. This should definitely prompt.

3. **Environment variable reader** — `isReadOnly: true`, no prompt. It only reads values from the process environment. *Gray area:* environment variables might contain secrets (API keys, passwords), so some implementations might still want a permission check despite being read-only.

4. **Git branch creator** — `isReadOnly: false`, prompt needed. `git branch new-feature` modifies the local repository state. While not destructive (branches can be deleted), it does change the Git DAG.

5. **File hash computer (SHA-256)** — `isReadOnly: true`, no prompt. It reads the file and computes a hash — pure computation with no side effects. This is analogous to reading a file and is concurrency-safe too.
