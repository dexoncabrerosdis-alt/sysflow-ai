# Answers: Lesson 81 — Per-Tool Permissions

## Exercise 1
**Question:** What is the priority order for rule evaluation, and why does "deny" always win?

**Answer:** The priority order is: **deny > allow > ask > mode default**. Deny rules are checked first and always win because they represent hard safety boundaries — operations that should never be permitted regardless of other rules. If allow rules could override deny rules, a user could accidentally create an allow pattern like `bash: *` that would neutralize all their safety deny rules (like blocking `rm -rf .git`). The deny-wins-always principle prevents accidental permission escalation: adding convenience rules (allow) can never weaken security rules (deny). This mirrors the principle of least privilege — it's safer to have permissions be additive on top of a restrictive base than to allow broad permissions with carve-outs.

---

## Exercise 2
**Challenge:** Implement `matchRules` with glob matching.

**Answer:**
```typescript
import { minimatch } from "minimatch";

interface PermissionRule {
  tool: string;
  pattern: string;
  transform?: (input: Record<string, unknown>) => Record<string, unknown>;
}

function matchRules(
  rules: PermissionRule[],
  toolName: string,
  input: Record<string, unknown>
): PermissionRule | null {
  const matchValue = getMatchableValue(toolName, input);

  for (const rule of rules) {
    if (rule.tool !== toolName) continue;

    if (minimatch(matchValue, rule.pattern, { dot: true, matchBase: false })) {
      return rule;
    }
  }

  return null;
}

function getMatchableValue(
  toolName: string,
  input: Record<string, unknown>
): string {
  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return (input.path || input.file_path || "") as string;
    case "bash":
      return (input.command || "") as string;
    case "grep":
    case "search_files":
      return (input.directory || input.path || ".") as string;
    default:
      return JSON.stringify(input);
  }
}

// Tests
const rules: PermissionRule[] = [
  { tool: "bash", pattern: "npm test*" },
  { tool: "write_file", pattern: "src/**/*.ts" },
  { tool: "bash", pattern: "sudo *" },
];

console.assert(
  matchRules(rules, "bash", { command: "npm test -- --watch" })?.pattern === "npm test*"
);
console.assert(
  matchRules(rules, "write_file", { path: "src/utils/parser.ts" })?.pattern === "src/**/*.ts"
);
console.assert(
  matchRules(rules, "bash", { command: "git status" }) === null
);
console.assert(
  matchRules(rules, "read_file", { path: "src/index.ts" }) === null
);
```
**Explanation:** The function iterates through rules in order, checking tool name first (cheap string comparison) before running glob matching (more expensive). The `getMatchableValue` function extracts the appropriate value to match against based on tool type — file path for file tools, command string for bash, directory for search tools. The `{ dot: true }` option in minimatch ensures patterns can match dotfiles (like `.env`). First match wins, so rule ordering matters.

---

## Exercise 3
**Challenge:** Implement `derivePattern` that generalizes tool inputs.

**Answer:**
```typescript
import * as path from "path";

function derivePattern(
  toolName: string,
  input: Record<string, unknown>
): string {
  if (toolName === "write_file" || toolName === "edit_file") {
    const filePath = (input.path || input.file_path || "") as string;
    if (!filePath) return "**/*";

    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);

    if (ext) {
      return `${dir}/**/*${ext}`;
    }
    return `${dir}/**/*`;
  }

  if (toolName === "bash") {
    const command = (input.command || "") as string;
    if (!command) return "*";

    const parts = command.split(/\s+/);
    const baseCommand = parts[0];

    const compoundCommands: Record<string, string> = {
      npm: parts[1] ? `npm ${parts[1]}*` : "npm *",
      git: parts[1] ? `git ${parts[1]}*` : "git *",
      npx: parts[1] ? `npx ${parts[1]}*` : "npx *",
      pip: parts[1] ? `pip ${parts[1]}*` : "pip *",
      cargo: parts[1] ? `cargo ${parts[1]}*` : "cargo *",
    };

    if (baseCommand in compoundCommands) {
      return compoundCommands[baseCommand];
    }

    return `${baseCommand} *`;
  }

  if (toolName === "read_file") {
    const filePath = (input.path || input.file_path || "") as string;
    const ext = path.extname(filePath);
    return ext ? `**/*${ext}` : "**/*";
  }

  return "**/*";
}

// Tests
console.assert(
  derivePattern("write_file", { path: "src/utils/parser.ts" }) === "src/utils/**/*.ts"
);
console.assert(
  derivePattern("bash", { command: "npm test -- --watch" }) === "npm test*"
);
console.assert(
  derivePattern("bash", { command: "git status" }) === "git status*"
);
console.assert(
  derivePattern("bash", { command: "ls -la" }) === "ls *"
);
```
**Explanation:** The function generalizes specific inputs into patterns that are broad enough to be useful (avoiding repeated prompts for similar actions) but narrow enough to maintain safety. For file writes, it keeps the directory and extension, so approving a write to `src/utils/parser.ts` creates a rule for all `.ts` files in `src/utils/`. For bash commands, it recognizes compound commands (like `npm test`) and keeps the subcommand, so approving `npm test -- --watch` creates a rule matching any `npm test*` variation.

---

## Exercise 4
**Challenge:** Write a test suite for the permission rule pipeline.

**Answer:**
```typescript
interface TestCase {
  name: string;
  rules: {
    alwaysDeny: PermissionRule[];
    alwaysAllow: PermissionRule[];
    alwaysAsk: PermissionRule[];
  };
  tool: string;
  input: Record<string, unknown>;
  expectedBehavior: "allow" | "deny" | "ask";
}

const testCases: TestCase[] = [
  {
    name: "deny beats allow when both match",
    rules: {
      alwaysDeny: [{ tool: "bash", pattern: "rm *" }],
      alwaysAllow: [{ tool: "bash", pattern: "rm *" }],
      alwaysAsk: [],
    },
    tool: "bash",
    input: { command: "rm -rf node_modules" },
    expectedBehavior: "deny",
  },
  {
    name: "allow rule skips user prompt",
    rules: {
      alwaysDeny: [],
      alwaysAllow: [{ tool: "write_file", pattern: "src/**/*.ts" }],
      alwaysAsk: [],
    },
    tool: "write_file",
    input: { path: "src/utils/helper.ts" },
    expectedBehavior: "allow",
  },
  {
    name: "unknown tool defaults to ask",
    rules: {
      alwaysDeny: [],
      alwaysAllow: [],
      alwaysAsk: [],
    },
    tool: "unknown_tool",
    input: { data: "something" },
    expectedBehavior: "ask",
  },
  {
    name: "glob pattern matches nested paths",
    rules: {
      alwaysDeny: [],
      alwaysAllow: [{ tool: "write_file", pattern: "src/**/*.ts" }],
      alwaysAsk: [],
    },
    tool: "write_file",
    input: { path: "src/deep/nested/dir/file.ts" },
    expectedBehavior: "allow",
  },
  {
    name: "non-matching rules fall through to default",
    rules: {
      alwaysDeny: [{ tool: "bash", pattern: "sudo *" }],
      alwaysAllow: [{ tool: "bash", pattern: "npm test*" }],
      alwaysAsk: [],
    },
    tool: "bash",
    input: { command: "git push origin main" },
    expectedBehavior: "ask",
  },
];

function runPermissionTests(testCases: TestCase[]): void {
  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    const result = checkPermissions(tc.tool, tc.input, {
      permissionMode: "default",
      rules: tc.rules,
    });

    if (result.behavior === tc.expectedBehavior) {
      passed++;
    } else {
      failed++;
      console.error(
        `FAIL: ${tc.name} — expected ${tc.expectedBehavior}, got ${result.behavior}`
      );
    }
  }

  console.log(`${passed}/${passed + failed} tests passed`);
}

function checkPermissions(
  toolName: string,
  input: Record<string, unknown>,
  context: { permissionMode: string; rules: TestCase["rules"] }
): { behavior: string } {
  const deny = matchRules(context.rules.alwaysDeny, toolName, input);
  if (deny) return { behavior: "deny" };

  const allow = matchRules(context.rules.alwaysAllow, toolName, input);
  if (allow) return { behavior: "allow" };

  const ask = matchRules(context.rules.alwaysAsk, toolName, input);
  if (ask) return { behavior: "ask" };

  return { behavior: "ask" };
}

runPermissionTests(testCases);
```
**Explanation:** The test suite covers the critical scenarios: deny-beats-allow (most important safety invariant), allow-skips-prompt (usability), unknown-defaults-to-ask (safety default), glob-matching-depth (pattern correctness), and fall-through behavior (when no rules match). Each test case is self-contained with its own rule set, making failures easy to diagnose. The `checkPermissions` function demonstrates the deny > allow > ask > default pipeline in its simplest form.
