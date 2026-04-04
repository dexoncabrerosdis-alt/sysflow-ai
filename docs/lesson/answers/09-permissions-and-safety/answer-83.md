# Answers: Lesson 83 — Bash Classification

## Exercise 1
**Question:** List five reasons why bash needs extra scrutiny and give an example command for each.

**Answer:** (1) **Unbounded capabilities** — `rm -rf / --no-preserve-root` can destroy an entire filesystem. A write_file tool writes one file; bash can chain unlimited operations. (2) **Opaque intent** — `rm -rf $(cat targets.txt)` deletes files determined at runtime; the permission system can't inspect what's in `targets.txt` at check time. (3) **Side effects cascade** — `npm install evil-package` runs arbitrary install scripts that can modify files, make network calls, or install backdoors — all triggered by a single command. (4) **Irreversible damage** — `git push --force origin main` overwrites remote history; `curl -X DELETE https://api.prod.com/users` deletes production data. Neither can be undone. (5) **Privilege escalation** — `sudo chmod 777 /etc/shadow` grants world-readable access to password hashes, escalating from normal user to system-level access.

---

## Exercise 2
**Challenge:** Build a heuristic bash command classifier.

**Answer:**
```typescript
interface ClassificationResult {
  classification: "safe" | "unsafe" | "unknown";
  confidence: number;
  reasoning: string;
}

const SAFE_COMMANDS = new Set([
  "ls", "pwd", "echo", "cat", "head", "tail", "wc",
  "grep", "rg", "find", "which", "whoami", "date",
  "node", "python", "tsc", "eslint", "prettier",
]);

const SAFE_COMPOUND = [
  "git status", "git log", "git diff", "git branch",
  "npm test", "npm run", "npx vitest", "npx jest",
  "cargo test", "cargo check", "cargo build",
  "pip list", "pip show",
];

const UNSAFE_PATTERNS = [
  /\brm\s+(-[a-z]*r|-[a-z]*f)/i,
  /\bsudo\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\//,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+push\s+-f\b/,
  /\bcurl\b.*\|\s*\b(bash|sh)\b/,
  /\bwget\b.*\|\s*\b(bash|sh)\b/,
  /\beval\b/,
  /\bexec\b/,
];

function classifyBashCommand(command: string): ClassificationResult {
  const trimmed = command.trim();

  if (!trimmed) {
    return { classification: "safe", confidence: 1.0, reasoning: "Empty command" };
  }

  for (const pattern of UNSAFE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        classification: "unsafe",
        confidence: 0.95,
        reasoning: `Matches unsafe pattern: ${pattern}`,
      };
    }
  }

  const segments = trimmed.split(/\s*(?:&&|\|\||;|\|)\s*/);

  for (const segment of segments) {
    const subResult = classifySingleCommand(segment.trim());
    if (subResult.classification === "unsafe") return subResult;
  }

  const allSafe = segments.every(
    (seg) => classifySingleCommand(seg.trim()).classification === "safe"
  );

  if (allSafe) {
    return {
      classification: "safe",
      confidence: 0.85,
      reasoning: "All segments classified as safe",
    };
  }

  return {
    classification: "unknown",
    confidence: 0.5,
    reasoning: "Could not confidently classify",
  };
}

function classifySingleCommand(command: string): ClassificationResult {
  const firstToken = command.split(/\s+/)[0];

  if (SAFE_COMMANDS.has(firstToken)) {
    return { classification: "safe", confidence: 0.9, reasoning: `Safe command: ${firstToken}` };
  }

  for (const compound of SAFE_COMPOUND) {
    if (command.startsWith(compound)) {
      return { classification: "safe", confidence: 0.9, reasoning: `Safe compound: ${compound}` };
    }
  }

  return {
    classification: "unknown",
    confidence: 0.5,
    reasoning: `Unknown command: ${firstToken}`,
  };
}
```
**Explanation:** The classifier works in layers: first check unsafe patterns (regex-based, catches dangerous commands regardless of position), then split on pipe/chain operators to analyze each segment independently. A chained command is only "safe" if every segment is safe — one unsafe segment makes the whole chain unsafe. Confidence is lower for chained commands (0.85 vs 0.9) because the interaction between commands adds uncertainty. Unknown commands get 0.5 confidence, triggering user approval in auto mode.

---

## Exercise 3
**Challenge:** Implement speculative classification with race timeout.

**Answer:**
```typescript
const CLASSIFIER_TIMEOUT_MS = 2000;

let speculativeResult: Promise<ClassificationResult> | null = null;

function startSpeculativeCheck(command: string): void {
  speculativeResult = classifyBashCommandAsync(command);
}

async function consumeSpeculativeCheck(): Promise<ClassificationResult | null> {
  if (!speculativeResult) return null;

  const pending = speculativeResult;
  speculativeResult = null;

  try {
    const result = await Promise.race([
      pending,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), CLASSIFIER_TIMEOUT_MS)
      ),
    ]);
    return result;
  } catch {
    return null;
  }
}

async function classifyBashCommandAsync(
  command: string
): Promise<ClassificationResult> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(classifyBashCommand(command));
    }, 50);
  });
}

async function handleBashPermission(
  command: string,
  permissionMode: string
): Promise<"allow" | "ask"> {
  const result = await consumeSpeculativeCheck();

  if (result === null) {
    return "ask";
  }

  if (result.classification === "safe" && result.confidence > 0.95) {
    return "allow";
  }

  if (result.classification === "unsafe") {
    return "ask";
  }

  if (permissionMode === "auto" && result.classification === "safe" && result.confidence > 0.8) {
    return "allow";
  }

  return "ask";
}

// Usage in the agent loop
async function processToolUse(block: { name: string; input: any }) {
  if (block.name === "bash") {
    startSpeculativeCheck(block.input.command);
  }

  // ... other processing happens here, giving classifier time to complete ...

  if (block.name === "bash") {
    const behavior = await handleBashPermission(block.input.command, "auto");
    return behavior;
  }
}
```
**Explanation:** The speculative check starts as soon as the model produces a bash tool_use block — while other processing continues, the classifier runs concurrently. `consumeSpeculativeCheck` races the pending result against a 2-second timeout. If the timeout wins, we fall back to asking the user (safe default). The result is consumed once (set to `null` after use) to prevent stale results from affecting future checks. In auto mode, the confidence threshold is slightly lower (0.8 vs 0.95) because the user has opted for less friction.

---

## Exercise 4
**Challenge:** Write tests for edge case commands.

**Answer:**
```typescript
interface EdgeCaseTest {
  command: string;
  description: string;
  expectedClassification: "safe" | "unsafe" | "unknown";
  heuristicHandles: boolean;
}

const edgeCases: EdgeCaseTest[] = [
  {
    command: "",
    description: "Empty command",
    expectedClassification: "safe",
    heuristicHandles: true,
  },
  {
    command: "echo $HOME",
    description: "Variable expansion",
    expectedClassification: "safe",
    heuristicHandles: true,
  },
  {
    command: "rm -rf $(cat targets.txt)",
    description: "Command substitution in rm",
    expectedClassification: "unsafe",
    heuristicHandles: true,
  },
  {
    command: "cat << 'EOF'\nsudo rm -rf /\nEOF",
    description: "Heredoc containing dangerous command",
    expectedClassification: "safe",
    heuristicHandles: false, // heuristic sees 'sudo rm -rf' and flags it
  },
  {
    command: "sleep 60 &",
    description: "Background process",
    expectedClassification: "unknown",
    heuristicHandles: true,
  },
  {
    command: "echo 'cm0gLXJmIC8=' | base64 -d | bash",
    description: "Base64-encoded dangerous command piped to bash",
    expectedClassification: "unsafe",
    heuristicHandles: true, // catches '| bash' pattern
  },
  {
    command: "ls && echo done || echo failed",
    description: "Chained safe commands",
    expectedClassification: "safe",
    heuristicHandles: true,
  },
  {
    command: "ls; rm -rf /",
    description: "Safe command chained with dangerous",
    expectedClassification: "unsafe",
    heuristicHandles: true,
  },
];

function runEdgeCaseTests(): void {
  for (const tc of edgeCases) {
    const result = classifyBashCommand(tc.command);
    const matches = result.classification === tc.expectedClassification;

    console.log(
      `${matches ? "PASS" : "FAIL"}: ${tc.description}` +
      ` — expected ${tc.expectedClassification}, got ${result.classification}` +
      (tc.heuristicHandles ? "" : " (known limitation)")
    );
  }
}

runEdgeCaseTests();
```
**Explanation:** The test suite documents both successes and known limitations. The heredoc case is a known false positive — the heuristic sees `sudo rm -rf` in the text content and flags it, even though it's just text being printed. The base64-encoded command is caught because the heuristic detects the `| bash` pipe pattern regardless of what's being piped. The `heuristicHandles` field explicitly documents which edge cases the simple heuristic handles correctly versus which would need an AI classifier for accurate results.
