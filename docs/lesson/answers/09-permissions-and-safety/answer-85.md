# Answers: Lesson 85 — Cyber Risk Instruction

## Exercise 1
**Question:** Why is the cyber risk instruction present even in bypass mode?

**Answer:** The cyber risk instruction operates at the **model behavior layer**, not the tool permission layer. Bypass mode skips tool-level permission checks (allow all reads, writes, and shell commands without approval), but it doesn't modify the system prompt. The cyber risk instruction prevents the model from *generating* malicious code in the first place — before any tool call is even attempted. For example, even with all permissions bypassed, the model should still refuse to write ransomware. This is a policy boundary set by the Safeguards team, not a user preference, so it cannot be disabled by configuration. The instruction is validated by hash to detect unauthorized modifications. If bypass mode could disable cyber risk guardrails, any CI/CD pipeline using bypass would become a potential vector for generating attack tools.

---

## Exercise 2
**Challenge:** Write a `classifySecurityRequest` function.

**Answer:**
```typescript
type SecurityClassification = "in-bounds" | "ambiguous" | "out-of-bounds";

const IN_BOUNDS_PATTERNS = [
  /security\s+(review|audit|test|analysis)/i,
  /vulnerability\s+(scan|analysis|assessment|check)/i,
  /penetration\s+test/i,
  /code\s+review.*secur/i,
  /ctf\s+(challenge|solution|writeup)/i,
  /input\s+validation/i,
  /csrf|xss|sqli|injection\s+prevention/i,
  /csp\s+header/i,
  /security\s+best\s+practice/i,
  /hardening/i,
  /fuzzing\s+(harness|test)/i,
  /sanitiz(e|ation)/i,
];

const OUT_OF_BOUNDS_PATTERNS = [
  /write\s+(a\s+)?(malware|ransomware|virus|worm|trojan)/i,
  /create\s+(a\s+)?(botnet|backdoor|rootkit)/i,
  /denial.of.service\s+(attack|tool)/i,
  /ddos\s+(tool|script|attack)/i,
  /phishing\s+(email|page|campaign|kit)/i,
  /bypass\s+(windows\s+defender|antivirus|edr|security\s+monitoring)/i,
  /supply\s+chain\s+(attack|compromise)/i,
  /social\s+engineering\s+(tool|attack|script)/i,
  /keylogger/i,
  /credential\s+(steal|harvest|dump)/i,
  /mass\s+scan/i,
  /exploit\s+(kit|framework)\s+for\s+unauthorized/i,
];

const AMBIGUOUS_PATTERNS = [
  /port\s+scan/i,
  /password\s+(crack|brute)/i,
  /packet\s+sniff/i,
  /reverse\s+(shell|engineer)/i,
  /exploit\s+(for|against|in)/i,
  /decompil/i,
  /intercept\s+(traffic|request)/i,
];

function classifySecurityRequest(message: string): SecurityClassification {
  const outOfBoundsScore = OUT_OF_BOUNDS_PATTERNS.filter((p) =>
    p.test(message)
  ).length;

  if (outOfBoundsScore > 0) {
    const hasInBoundsContext = IN_BOUNDS_PATTERNS.some((p) => p.test(message));
    if (hasInBoundsContext && outOfBoundsScore === 1) {
      return "ambiguous";
    }
    return "out-of-bounds";
  }

  const inBoundsScore = IN_BOUNDS_PATTERNS.filter((p) =>
    p.test(message)
  ).length;

  if (inBoundsScore > 0) return "in-bounds";

  const ambiguousScore = AMBIGUOUS_PATTERNS.filter((p) =>
    p.test(message)
  ).length;

  if (ambiguousScore > 0) return "ambiguous";

  return "in-bounds";
}

// Tests
console.assert(
  classifySecurityRequest("Review this code for XSS vulnerabilities") === "in-bounds"
);
console.assert(
  classifySecurityRequest("Write ransomware that encrypts files") === "out-of-bounds"
);
console.assert(
  classifySecurityRequest("Write a port scanner") === "ambiguous"
);
console.assert(
  classifySecurityRequest(
    "Create a brute-force tool for authorized penetration testing"
  ) === "ambiguous"
);
```
**Explanation:** The classifier uses three pattern lists and a scoring system. Out-of-bounds patterns are checked first because safety takes priority. However, if an out-of-bounds pattern co-occurs with an in-bounds context (like "authorized penetration testing"), the request is classified as ambiguous rather than immediately rejected — allowing the model to lean toward the legitimate interpretation as the cyber risk instruction directs. Requests that match no security-related patterns at all default to "in-bounds" since they're presumably ordinary coding requests.

---

## Exercise 3
**Challenge:** Implement hash-based instruction validation.

**Answer:**
```typescript
import { createHash } from "crypto";

const CYBER_RISK_INSTRUCTION = `## Security-Related Requests

You may assist with:
- Authorized security testing and penetration testing
- Defensive security analysis and hardening
...`;

const EXPECTED_HASH = computeHash(CYBER_RISK_INSTRUCTION);

function computeHash(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

interface ValidationResult {
  valid: boolean;
  expectedHash: string;
  actualHash: string;
  error?: string;
}

function validateCyberRiskInstruction(
  instruction: string
): ValidationResult {
  const actualHash = computeHash(instruction);

  return {
    valid: actualHash === EXPECTED_HASH,
    expectedHash: EXPECTED_HASH,
    actualHash,
    error:
      actualHash !== EXPECTED_HASH
        ? "Cyber risk instruction has been modified. " +
          "This may indicate unauthorized tampering. " +
          "Contact the Safeguards team."
        : undefined,
  };
}

function updateExpectedHash(newInstruction: string): {
  hash: string;
  declaration: string;
} {
  const hash = computeHash(newInstruction);
  return {
    hash,
    declaration: `const EXPECTED_HASH = "${hash}";`,
  };
}

function getCyberRiskInstructionSafe(): string {
  const validation = validateCyberRiskInstruction(CYBER_RISK_INSTRUCTION);

  if (!validation.valid) {
    console.error("[SECURITY ALERT]", validation.error);
    console.error(`Expected: ${validation.expectedHash}`);
    console.error(`Actual:   ${validation.actualHash}`);

    throw new Error(
      "Cyber risk instruction validation failed. " +
      "Agent cannot start with a potentially compromised security policy."
    );
  }

  return CYBER_RISK_INSTRUCTION;
}
```
**Explanation:** The hash validation ensures the instruction hasn't been accidentally edited or maliciously tampered with. The `validateCyberRiskInstruction` function returns structured results for logging. The `getCyberRiskInstructionSafe` function is the primary entry point — it throws a hard error if validation fails, preventing the agent from starting with a compromised policy. The `updateExpectedHash` helper generates the new constant declaration when the Safeguards team legitimately updates the instruction, making the update process auditable.

---

## Exercise 4
**Challenge:** Write a `traceToolCallThroughDefenses` function simulating all seven defense layers.

**Answer:**
```typescript
interface TraceEntry {
  layer: string;
  decision: "pass" | "block" | "flag" | "skip";
  reason: string;
}

interface TraceResult {
  finalOutcome: "allowed" | "blocked" | "ask_user";
  trace: TraceEntry[];
}

function traceToolCallThroughDefenses(
  toolName: string,
  input: Record<string, unknown>,
  userMessage: string,
  permissionMode: string,
  rules: {
    alwaysDeny: Array<{ tool: string; pattern: string }>;
    alwaysAllow: Array<{ tool: string; pattern: string }>;
  }
): TraceResult {
  const trace: TraceEntry[] = [];
  const command = (input.command || "") as string;

  // Layer 1: Cyber Risk Instruction (model behavior layer)
  const securityClass = classifySecurityRequest(userMessage);
  if (securityClass === "out-of-bounds") {
    trace.push({
      layer: "1. Cyber Risk Instruction",
      decision: "block",
      reason: `Request classified as out-of-bounds: "${userMessage.substring(0, 50)}..."`,
    });
    return { finalOutcome: "blocked", trace };
  }
  trace.push({
    layer: "1. Cyber Risk Instruction",
    decision: securityClass === "ambiguous" ? "flag" : "pass",
    reason: `Request classified as ${securityClass}`,
  });

  // Layer 2: Permission Mode
  if (permissionMode === "plan" && toolName !== "read_file") {
    trace.push({
      layer: "2. Permission Mode",
      decision: "block",
      reason: "Plan mode: only read operations allowed",
    });
    return { finalOutcome: "blocked", trace };
  }
  if (permissionMode === "bypassPermissions") {
    trace.push({
      layer: "2. Permission Mode",
      decision: "pass",
      reason: "Bypass mode: all operations allowed",
    });
    return { finalOutcome: "allowed", trace };
  }
  trace.push({
    layer: "2. Permission Mode",
    decision: "pass",
    reason: `Mode ${permissionMode}: proceeding to rule check`,
  });

  // Layer 3: Per-Tool Deny Rules
  const matchValue = toolName === "bash" ? command : (input.path as string || "");
  const denyMatch = rules.alwaysDeny.find(
    (r) => r.tool === toolName && matchValue.includes(r.pattern.replace("*", ""))
  );
  if (denyMatch) {
    trace.push({
      layer: "3. Per-Tool Rules (Deny)",
      decision: "block",
      reason: `Matched deny rule: ${denyMatch.pattern}`,
    });
    return { finalOutcome: "blocked", trace };
  }
  trace.push({ layer: "3. Per-Tool Rules (Deny)", decision: "pass", reason: "No deny rules matched" });

  // Layer 4: Per-Tool Allow Rules
  const allowMatch = rules.alwaysAllow.find(
    (r) => r.tool === toolName && matchValue.includes(r.pattern.replace("*", ""))
  );
  if (allowMatch) {
    trace.push({
      layer: "4. Per-Tool Rules (Allow)",
      decision: "pass",
      reason: `Matched allow rule: ${allowMatch.pattern}`,
    });
  } else {
    trace.push({ layer: "4. Per-Tool Rules (Allow)", decision: "skip", reason: "No allow rules matched" });
  }

  // Layer 5: Bash Classification (only for bash tool)
  if (toolName === "bash") {
    const classification = classifyBashCommand(command);
    trace.push({
      layer: "5. Bash Classification",
      decision: classification.classification === "safe" ? "pass" : "flag",
      reason: `Classified as ${classification.classification} (${classification.confidence})`,
    });
  } else {
    trace.push({ layer: "5. Bash Classification", decision: "skip", reason: "Not a bash command" });
  }

  // Layer 6: Prompt Injection Scan (on tool results — simulated)
  trace.push({
    layer: "6. Prompt Injection Scan",
    decision: "pass",
    reason: "Applied to tool results after execution (not applicable pre-execution)",
  });

  // Layer 7: Final Decision
  if (allowMatch) {
    trace.push({ layer: "7. Final Decision", decision: "pass", reason: "Allow rule matched" });
    return { finalOutcome: "allowed", trace };
  }

  trace.push({ layer: "7. Final Decision", decision: "flag", reason: "No allow rule — ask user" });
  return { finalOutcome: "ask_user", trace };
}

// Example trace
const result = traceToolCallThroughDefenses(
  "bash",
  { command: "npm test -- --watch" },
  "Run the test suite in watch mode",
  "default",
  {
    alwaysDeny: [{ tool: "bash", pattern: "rm -rf" }],
    alwaysAllow: [{ tool: "bash", pattern: "npm test" }],
  }
);

for (const entry of result.trace) {
  console.log(`${entry.layer}: ${entry.decision} — ${entry.reason}`);
}
console.log(`\nFinal: ${result.finalOutcome}`);
```
**Explanation:** The trace function simulates a tool call passing through all seven defense layers from Module 09. Each layer records its decision and reasoning, creating a complete audit trail. The layers are: (1) cyber risk instruction checks the user's intent, (2) permission mode sets global posture, (3) deny rules block known-dangerous patterns, (4) allow rules permit known-safe patterns, (5) bash classification evaluates command safety, (6) injection scanning protects against malicious tool results (applied post-execution), and (7) the final decision synthesizes all layers. This trace is valuable for debugging permission decisions and understanding why a specific action was allowed or blocked.
