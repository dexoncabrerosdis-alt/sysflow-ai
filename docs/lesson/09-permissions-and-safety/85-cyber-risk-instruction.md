# Lesson 85: Cyber Risk Instruction

## The Security Balance

AI coding agents are powerful tools for security work. Developers use them to write security tests, analyze vulnerabilities, build defensive tools, and solve CTF challenges. But those same capabilities could be used for malicious purposes — writing exploits, launching attacks, or compromising systems.

Claude Code handles this with the `CYBER_RISK_INSTRUCTION` — a dedicated system prompt section that sets clear boundaries around security-related requests.

## The Instruction

Here's what the cyber risk instruction looks like in practice:

```typescript
const CYBER_RISK_INSTRUCTION = `## Security-Related Requests

You may assist with:
- Authorized security testing and penetration testing
- Defensive security analysis and hardening
- CTF (Capture the Flag) challenges and security education
- Vulnerability analysis of the user's own code
- Security code review and best practices
- Writing security tests and fuzzing harnesses

You must refuse:
- Creating tools for unauthorized access to systems
- Developing malware, ransomware, or destructive payloads
- Techniques for denial-of-service attacks
- Mass targeting or scanning of systems without authorization
- Supply chain compromise techniques
- Social engineering attack tools
- Techniques to evade security monitoring without authorization

When assisting with security tasks, assume the user has proper
authorization for the systems they're working with. Focus on
defensive applications and educational contexts.

If a request is ambiguous, lean toward the educational or
defensive interpretation.`;
```

## How It's Injected

The cyber risk instruction is part of the system prompt, assembled alongside other sections:

```typescript
function buildSystemPrompt(context: SystemPromptContext): string {
  const sections: SystemSection[] = [
    getIdentitySection(),           // Who the agent is
    getToolInstructionsSection(),   // How to use tools
    getSecurityGuidanceSection(),   // Prompt injection defense (Lesson 84)
    getCyberRiskSection(),          // THIS — security boundaries
    getProjectContextSection(),     // Current project info
    getConversationGuidance(),      // Interaction style
  ];

  // Sort by priority (highest first)
  sections.sort((a, b) => b.priority - a.priority);

  return sections
    .map((s) => `${s.title}\n\n${s.content}`)
    .join("\n\n---\n\n");
}

function getCyberRiskSection(): SystemSection {
  return {
    id: "cyber_risk",
    title: "Security Policy",
    content: CYBER_RISK_INSTRUCTION,
    priority: 90,
  };
}
```

This section appears in **every** system prompt, regardless of permission mode or user configuration. It's not something users can disable because it represents a policy boundary, not a user preference.

## Why a Dedicated Section?

You might wonder: doesn't the model already know not to help with malicious activities? Why do we need an explicit instruction?

**Reason 1: Specificity matters.** Vague instructions like "be safe" are less effective than specific lists of allowed and disallowed activities. The model needs concrete categories to make consistent decisions.

**Reason 2: Context shifts interpretation.** In a coding context, many security requests are ambiguous. "Write a port scanner" could be a network diagnostics tool or an attack reconnaissance tool. The instruction provides a framework for interpretation.

**Reason 3: Defense in depth.** The model's training includes safety guidelines, but the system prompt reinforces them for this specific use case. Multiple layers of guidance are more robust than one.

**Reason 4: Auditability.** Having the policy in explicit text means it can be reviewed, updated, and audited by the safety team. It's not hidden in model weights — it's visible in the code.

## The Safeguards Team Ownership

In Claude Code's development organization, the cyber risk instruction is **owned by the Safeguards team**, not the product team:

```typescript
/**
 * CYBER_RISK_INSTRUCTION
 *
 * Owner: Safeguards Team
 * Last reviewed: 2024-10-15
 * Policy version: 2.3
 *
 * Changes to this instruction require Safeguards team approval.
 * Do not modify without consulting the security policy review process.
 *
 * This instruction is injected into every system prompt for all
 * permission modes, including bypass mode.
 */
```

This ownership model ensures that product development speed doesn't erode security boundaries. Even in bypass mode (which skips permission checks), the cyber risk instruction is still present because it operates at the model behavior level, not the tool permission level.

## Interpreting Ambiguous Requests

The instruction includes guidance for ambiguous cases: "lean toward the educational or defensive interpretation." Here's how this plays out:

```typescript
// Request: "Write a SQL injection test"
// Interpretation: Security testing tool
// Response: Help write a parameterized test suite that checks for
//           SQL injection vulnerabilities in the user's own code

// Request: "Create a keylogger"
// Interpretation: Malicious tool — no defensive/educational framing
// Response: Decline, explain why, suggest legitimate alternatives
//           like accessibility input monitoring tools

// Request: "Analyze this binary for vulnerabilities"
// Interpretation: Security research / reverse engineering
// Response: Help with static analysis, explain findings educationally

// Request: "Write a script to brute-force login"
// Interpretation: Could be authorized pen testing
// Response: Help, but include rate limiting, target only specified host,
//           add authentication check, note "for authorized testing only"
```

The key heuristic: if you can imagine a legitimate security professional making this request as part of their authorized work, help with it. If the request only makes sense in an attack context, decline.

## Integration with Permission Checks

The cyber risk instruction works alongside the permission system but at a different level:

```
┌─────────────────────────────────────────────────────────┐
│ Model Layer (cyber risk instruction)                     │
│ "Should I help with this request?"                       │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Permission Layer (tool permissions)                  │ │
│ │ "Is this specific tool call allowed?"               │ │
│ │                                                      │ │
│ │ ┌─────────────────────────────────────────────────┐ │ │
│ │ │ Tool Layer (actual execution)                    │ │ │
│ │ │ "Execute the operation"                          │ │ │
│ │ └─────────────────────────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

The model decides whether to attempt the request at all (cyber risk layer). If it proceeds, the permission system decides whether each specific tool call is allowed (permission layer). Both must pass for an action to execute.

```typescript
// Example: User asks "scan my network for open ports"

// Step 1: Model layer (cyber risk instruction)
// Decision: This is authorized security testing → proceed
// The model generates a tool call:
const toolCall = {
  name: "bash",
  input: { command: "nmap -sT 192.168.1.0/24" },
};

// Step 2: Permission layer (tool permissions)
// Decision: bash command "nmap" → ask user
const permission = await checkPermission(toolCall);
// permission.behavior === "ask"

// Step 3: User approves → tool executes
// Step 3 (alt): User denies → command blocked
```

Without the cyber risk instruction, the model might generate attack tools that the permission system can't distinguish from legitimate code. The instruction prevents the model from even attempting clearly malicious generations.

## Real Code Structure

In the actual codebase, the instruction lives in a dedicated file:

```typescript
// cyberRiskInstruction.ts

export function getCyberRiskInstruction(): string {
  return CYBER_RISK_INSTRUCTION;
}

export function injectCyberRiskInstruction(
  systemPrompt: string
): string {
  // Ensure the instruction is always present
  if (!systemPrompt.includes("Security-Related Requests")) {
    return systemPrompt + "\n\n" + CYBER_RISK_INSTRUCTION;
  }
  return systemPrompt;
}

// Validation: ensure the instruction hasn't been accidentally modified
export function validateCyberRiskInstruction(): boolean {
  const hash = computeHash(CYBER_RISK_INSTRUCTION);
  return hash === EXPECTED_HASH;
}

const EXPECTED_HASH = "sha256:a1b2c3d4..."; // Updated by Safeguards team
```

The `validateCyberRiskInstruction` pattern is interesting — it provides a way to detect accidental or unauthorized modifications to the security policy. If the hash doesn't match, something has changed that shouldn't have.

## The Balance Between Helpful and Safe

The cyber risk instruction embodies a philosophy: **be maximally helpful within clear boundaries**. It doesn't refuse all security-related work. It doesn't treat every security question as suspicious. Instead, it defines what's in-bounds and what's out-of-bounds, and leans toward helpfulness in ambiguous cases.

```typescript
// The spectrum of security requests:

// Clearly in-bounds ✅
// - "Review this code for XSS vulnerabilities"
// - "Write input validation for this form"
// - "Set up CSP headers for my Express app"
// - "Solve this CTF challenge about buffer overflows"

// Ambiguous → lean helpful ✅
// - "Write a port scanner" → network diagnostics tool
// - "Implement password cracking" → password strength testing
// - "Create a packet sniffer" → network debugging tool

// Clearly out-of-bounds ❌
// - "Write ransomware that encrypts files"
// - "Create a botnet controller"
// - "Generate phishing emails at scale"
// - "Bypass Windows Defender for my payload"
```

This balanced approach makes the agent genuinely useful for security professionals while maintaining boundaries that prevent misuse.

## Module 09 Summary

Over these seven lessons, you've built a complete understanding of how an AI coding agent protects users and systems:

1. **Why permissions matter** — the risks of unchecked agents
2. **Permission modes** — global safety postures
3. **Per-tool permissions** — granular allow/deny/ask rules
4. **Interactive flow** — how the user approves or denies actions
5. **Bash classification** — AI-powered command safety analysis
6. **Prompt injection** — defending against malicious tool output
7. **Cyber risk** — boundaries around security-related capabilities

These layers work together to create an agent that's powerful enough to be useful and safe enough to be trusted.

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Bypass Mode and Cyber Risk
**Question:** Why is the cyber risk instruction present even in bypass mode, which skips all other permission checks? What layer of defense does it operate at, and why can't it be disabled by configuration?

[View Answer](../../answers/09-permissions-and-safety/answer-85.md#exercise-1)

### Exercise 2 — Classify Security Requests
**Challenge:** Write a `classifySecurityRequest` function that takes a user message string and returns `"in-bounds" | "ambiguous" | "out-of-bounds"` based on keyword analysis. In-bounds includes defensive testing, code review, and CTF challenges. Out-of-bounds includes malware creation, unauthorized access tools, and DoS techniques.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-85.md#exercise-2)

### Exercise 3 — Hash-Based Instruction Validator
**Challenge:** Implement a `validateCyberRiskInstruction` function that computes a SHA-256 hash of the instruction text and compares it to an expected hash. If validation fails, return an error with details. Include a `updateExpectedHash` helper for when the instruction is legitimately updated.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-85.md#exercise-3)

### Exercise 4 — Full Defense Layer Diagram
**Challenge:** Write a `traceToolCallThroughDefenses` function that simulates a tool call passing through all seven defense layers from Module 09 (cyber risk → permission mode → per-tool rules → interactive flow → bash classification → injection scan → execution). Return a trace log showing the decision at each layer.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-85.md#exercise-4)
