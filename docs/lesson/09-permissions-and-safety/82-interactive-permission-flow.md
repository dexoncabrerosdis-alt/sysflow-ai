# Lesson 82: Interactive Permission Flow

## From Decision to Prompt

In the previous lessons, we saw that some permission checks return `{ behavior: "ask" }`. But what happens next? How does the agent actually ask the user for approval, wait for a response, and continue?

This lesson traces the full interactive permission flow — from the moment a tool call needs approval to the moment execution resumes.

## The Entry Point: useCanUseTool

The core function that orchestrates permission checking is `useCanUseTool`. Despite the React-hook-like name, it's a general-purpose async function that handles the entire flow:

```typescript
async function useCanUseTool(
  tool: Tool,
  input: ToolInput,
  context: PermissionContext
): Promise<UseCanUseToolResult> {
  // Step 1: Static permission check
  const staticResult = hasPermissionsToUseTool(tool, input, context);

  // Step 2: Branch based on result
  switch (staticResult.behavior) {
    case "allow":
      return { permitted: true, input: staticResult.updatedInput || input };

    case "deny":
      return {
        permitted: false,
        error: createDenialError(tool, staticResult.message),
      };

    case "ask":
      return await resolveAskPermission(tool, input, context);
  }
}

interface UseCanUseToolResult {
  permitted: boolean;
  input?: ToolInput;     // Potentially modified input
  error?: PermissionError;
}
```

## Step 1: Static Rule Evaluation

`hasPermissionsToUseTool` applies the rules we built in Lesson 81. It's purely synchronous — no user interaction, no network calls:

```typescript
function hasPermissionsToUseTool(
  tool: Tool,
  input: ToolInput,
  context: PermissionContext
): PermissionResult {
  // Bypass mode: always allow
  if (context.permissionMode === "bypassPermissions") {
    return { behavior: "allow" };
  }

  // Plan mode: deny all writes
  if (context.permissionMode === "plan" && isWriteTool(tool)) {
    return {
      behavior: "deny",
      message: "Cannot modify files in plan mode",
    };
  }

  // Check deny rules
  for (const rule of context.rules.alwaysDeny) {
    if (ruleMatches(rule, tool, input)) {
      return { behavior: "deny", message: `Rule: ${rule.pattern}` };
    }
  }

  // Check allow rules
  for (const rule of context.rules.alwaysAllow) {
    if (ruleMatches(rule, tool, input)) {
      return { behavior: "allow", updatedInput: rule.transform?.(input) };
    }
  }

  // Check ask rules
  for (const rule of context.rules.alwaysAsk) {
    if (ruleMatches(rule, tool, input)) {
      return { behavior: "ask" };
    }
  }

  // Default: read operations allowed, write operations ask
  if (isReadTool(tool)) {
    return { behavior: "allow" };
  }
  return { behavior: "ask" };
}
```

## Step 2: Resolving "Ask" — Three Paths

When the static check returns "ask", there are three possible resolution paths depending on the execution context:

```typescript
async function resolveAskPermission(
  tool: Tool,
  input: ToolInput,
  context: PermissionContext
): Promise<UseCanUseToolResult> {
  // Path A: Interactive terminal — prompt the user directly
  if (context.options.isInteractive) {
    return await handleInteractivePermission(tool, input, context);
  }

  // Path B: Bridge/UI connection — send approval request via callback
  if (context.options.hasBridge) {
    return await handleBridgePermission(tool, input, context);
  }

  // Path C: Non-interactive, no bridge — deny by default
  return {
    permitted: false,
    error: createDenialError(
      tool,
      "No interactive session available to approve this action"
    ),
  };
}
```

### Path A: Interactive Terminal Permission

In a terminal environment, the agent directly prompts the user:

```typescript
async function handleInteractivePermission(
  tool: Tool,
  input: ToolInput,
  context: PermissionContext
): Promise<UseCanUseToolResult> {
  // Format the request for display
  const display = formatPermissionRequest(tool, input);

  // Show the prompt
  console.log("\n" + display.summary);
  console.log(display.details);

  // Present choices
  const choices = [
    { key: "y", label: "Allow once" },
    { key: "a", label: `Always allow: ${display.suggestedPattern}` },
    { key: "n", label: "Deny" },
    { key: "e", label: "Explain (ask agent to explain why)" },
  ];

  const choice = await promptUserChoice(choices, context.abortSignal);

  switch (choice) {
    case "y":
      return { permitted: true, input };

    case "a": {
      // Create a permanent allow rule
      const rule: PermissionRule = {
        tool: tool.name,
        pattern: display.suggestedPattern,
      };
      context.rules.alwaysAllow.push(rule);
      await persistRule(rule);
      return { permitted: true, input };
    }

    case "n":
      return {
        permitted: false,
        error: createDenialError(tool, "User denied"),
      };

    case "e":
      // Return a special result that tells the agent to explain
      return {
        permitted: false,
        error: createExplanationRequest(tool, input),
      };
  }
}
```

Here's what the user actually sees in the terminal:

```
┌─────────────────────────────────────────────┐
│  Agent wants to execute:                     │
│                                              │
│  bash: npm install lodash                    │
│                                              │
│  y  Allow once                               │
│  a  Always allow: npm install*               │
│  n  Deny                                     │
│  e  Ask agent to explain                     │
└─────────────────────────────────────────────┘
```

### Path B: Bridge/Channel Permission

When Claude Code runs with a UI frontend (like a VS Code extension), permissions flow through a bridge — a callback channel between the agent backend and the UI:

```typescript
async function handleBridgePermission(
  tool: Tool,
  input: ToolInput,
  context: PermissionContext
): Promise<UseCanUseToolResult> {
  // Create a permission request
  const request: PermissionRequest = {
    id: generateRequestId(),
    tool: tool.name,
    input: sanitizeForDisplay(input),
    suggestedPattern: deriveSuggestedPattern(tool, input),
    timestamp: Date.now(),
  };

  // Send through the bridge and wait for response
  const response = await context.bridge.requestPermission(
    request,
    context.abortSignal
  );

  // Process the response
  if (response.approved) {
    if (response.createRule) {
      context.rules.alwaysAllow.push({
        tool: tool.name,
        pattern: response.rulePattern,
      });
    }
    return { permitted: true, input };
  }

  return {
    permitted: false,
    error: createDenialError(tool, response.reason || "Denied via UI"),
  };
}
```

The bridge pattern decouples the permission logic from the display mechanism. The same permission system works whether the user is in a terminal, a VS Code panel, a web UI, or a Slack bot.

```typescript
interface PermissionBridge {
  requestPermission(
    request: PermissionRequest,
    signal: AbortSignal
  ): Promise<PermissionResponse>;

  onRuleCreated(callback: (rule: PermissionRule) => void): void;
}

interface PermissionRequest {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  suggestedPattern: string;
  timestamp: number;
}

interface PermissionResponse {
  approved: boolean;
  createRule: boolean;
  rulePattern?: string;
  reason?: string;
}
```

## The Full Flow Diagram

Let's trace the complete journey of a tool call that requires permission:

```typescript
// 1. Model produces a tool_use block
const toolUse = {
  type: "tool_use",
  id: "toolu_abc123",
  name: "bash",
  input: { command: "npm install express" },
};

// 2. Agent loop calls useCanUseTool
const permResult = await useCanUseTool(
  tools.bash,
  toolUse.input,
  permissionContext
);

// 3. Static check: no deny rule, no allow rule → "ask"
// hasPermissionsToUseTool returns { behavior: "ask" }

// 4. Interactive resolution: prompt user
// handleInteractivePermission shows the prompt

// 5. User presses "a" (always allow)
// A rule is created: { tool: "bash", pattern: "npm install*" }

// 6. Result returns to agent loop
// permResult = { permitted: true, input: { command: "npm install express" } }

// 7. Tool executes
const result = await executeBash("npm install express");

// 8. Next time "npm install <anything>" is called,
//    the static check matches the allow rule → no prompt
```

## Handling Denial Gracefully

When a tool call is denied, the denial becomes a tool result that the model sees:

```typescript
function createDenialToolResult(
  toolUseId: string,
  tool: Tool,
  error: PermissionError
): ToolResultMessage {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [
      {
        type: "text",
        text: `Permission denied: ${error.message}\n\n` +
          `The tool "${tool.name}" was not allowed to execute.\n` +
          `Reason: ${error.reason}\n\n` +
          `You can try an alternative approach that doesn't ` +
          `require this permission, or explain to the user ` +
          `why this action is needed.`,
      },
    ],
    is_error: true,
  };
}
```

The model sees this error and can adapt. Instead of crashing, it might:
- Try a different approach that doesn't need the blocked operation
- Explain to the user why it needs permission
- Ask the user to manually perform the blocked action

## Abort During Permission Prompts

What if the user aborts while a permission prompt is waiting? The AbortSignal handles this:

```typescript
async function promptUserChoice(
  choices: Choice[],
  signal: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Set up abort handler
    signal.addEventListener("abort", () => {
      cleanup();
      reject(new AbortError("Permission prompt aborted"));
    });

    // Set up input handler
    const handler = (key: string) => {
      const match = choices.find((c) => c.key === key);
      if (match) {
        cleanup();
        resolve(match.key);
      }
    };

    process.stdin.on("keypress", handler);

    function cleanup() {
      process.stdin.off("keypress", handler);
    }
  });
}
```

## Summary

The interactive permission flow is a bridge between the static rule system and the human user. It handles three contexts (terminal, UI bridge, non-interactive), supports rule creation from approvals, and gracefully handles both denials and aborts. The model always sees the outcome of permission checks, allowing it to adapt its behavior.

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Three Resolution Paths
**Question:** When a permission check returns `{ behavior: "ask" }`, what are the three possible resolution paths? Under what conditions does each path activate, and what happens if none are available?

[View Answer](../../answers/09-permissions-and-safety/answer-82.md#exercise-1)

### Exercise 2 — Implement resolveAskPermission
**Challenge:** Write the `resolveAskPermission` function that routes to interactive terminal, bridge/UI, or non-interactive denial based on the context. Include the "allow once", "always allow", "deny", and "explain" choices for the interactive path.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-82.md#exercise-2)

### Exercise 3 — WebSocket Permission Bridge
**Challenge:** Implement a `WebSocketPermissionBridge` class that implements the `PermissionBridge` interface. It should send permission requests as JSON over a WebSocket, wait for responses, and handle connection failures with automatic denial.

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-82.md#exercise-3)

### Exercise 4 — Denial Tool Result
**Challenge:** Write a `createDenialToolResult` function that creates a structured tool result message for denied operations. The message should explain the denial reason and suggest alternatives to the model (try a different approach, explain to user why permission is needed, etc.).

Write your solution in your IDE first, then check:

[View Answer](../../answers/09-permissions-and-safety/answer-82.md#exercise-4)
