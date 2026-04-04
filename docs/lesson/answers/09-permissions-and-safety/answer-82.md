# Answers: Lesson 82 — Interactive Permission Flow

## Exercise 1
**Question:** What are the three resolution paths when a permission check returns "ask"?

**Answer:** (1) **Interactive terminal** — When the agent runs in a terminal with a human present (`isInteractive: true`), the user is prompted directly with keyboard choices: allow once, always allow, deny, or explain. (2) **Bridge/UI connection** — When connected to a UI frontend like VS Code (`hasBridge: true`), the permission request is sent as a structured message over the bridge (WebSocket, IPC, etc.) and the UI displays a dialog. The user's response flows back through the bridge. (3) **Non-interactive fallback** — When neither terminal nor bridge is available (e.g., a headless script that forgot to set bypass mode), the action is automatically denied with the message "No interactive session available to approve this action." This is a safety default: if nobody can approve, the answer is no.

---

## Exercise 2
**Challenge:** Implement `resolveAskPermission`.

**Answer:**
```typescript
interface PermissionContext {
  options: {
    isInteractive: boolean;
    hasBridge: boolean;
  };
  rules: {
    alwaysAllow: PermissionRule[];
  };
  abortSignal: AbortSignal;
  bridge?: PermissionBridge;
}

interface UseCanUseToolResult {
  permitted: boolean;
  input?: Record<string, unknown>;
  error?: { message: string; reason: string };
}

async function resolveAskPermission(
  tool: { name: string },
  input: Record<string, unknown>,
  context: PermissionContext
): Promise<UseCanUseToolResult> {
  if (context.options.isInteractive) {
    return await handleInteractivePermission(tool, input, context);
  }

  if (context.options.hasBridge && context.bridge) {
    return await handleBridgePermission(tool, input, context);
  }

  return {
    permitted: false,
    error: {
      message: "Permission denied: no interactive session available.",
      reason: "non_interactive",
    },
  };
}

async function handleInteractivePermission(
  tool: { name: string },
  input: Record<string, unknown>,
  context: PermissionContext
): Promise<UseCanUseToolResult> {
  const suggestedPattern = derivePattern(tool.name, input);
  const display = `Agent wants to execute: ${tool.name}`;
  const detail = JSON.stringify(input, null, 2);

  console.log(`\n${display}\n${detail}`);

  const choices = [
    { key: "y", label: "Allow once" },
    { key: "a", label: `Always allow: ${suggestedPattern}` },
    { key: "n", label: "Deny" },
    { key: "e", label: "Ask agent to explain" },
  ];

  const choice = await promptUserChoice(choices, context.abortSignal);

  switch (choice) {
    case "y":
      return { permitted: true, input };

    case "a":
      context.rules.alwaysAllow.push({
        tool: tool.name,
        pattern: suggestedPattern,
      });
      return { permitted: true, input };

    case "n":
      return {
        permitted: false,
        error: { message: "User denied the action.", reason: "user_denied" },
      };

    case "e":
      return {
        permitted: false,
        error: {
          message: "User wants an explanation before approving.",
          reason: "explanation_requested",
        },
      };

    default:
      return {
        permitted: false,
        error: { message: "Unknown choice.", reason: "unknown" },
      };
  }
}

async function promptUserChoice(
  choices: { key: string; label: string }[],
  signal: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort);

    const handler = (key: string) => {
      if (choices.some((c) => c.key === key)) {
        cleanup();
        resolve(key);
      }
    };

    function cleanup() {
      signal.removeEventListener("abort", onAbort);
      process.stdin.off("keypress", handler);
    }

    for (const c of choices) {
      console.log(`  ${c.key}  ${c.label}`);
    }

    process.stdin.on("keypress", handler);
  });
}
```
**Explanation:** The function routes to one of three paths based on context. The interactive path displays choices and waits for a keypress. The "always allow" choice mutates the rules array in-place, so the rule takes effect immediately for subsequent checks. The "explain" choice returns a special error that the agent loop can detect and handle by asking the model to justify the action. The `AbortSignal` integration ensures that if the user cancels the entire session, the pending prompt is cleaned up properly.

---

## Exercise 3
**Challenge:** Implement a `WebSocketPermissionBridge`.

**Answer:**
```typescript
interface PermissionBridge {
  requestPermission(
    request: PermissionRequest,
    signal: AbortSignal
  ): Promise<PermissionResponse>;
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

class WebSocketPermissionBridge implements PermissionBridge {
  private ws: WebSocket;
  private pendingRequests: Map<string, {
    resolve: (resp: PermissionResponse) => void;
    reject: (err: Error) => void;
  }> = new Map();

  constructor(ws: WebSocket) {
    this.ws = ws;

    this.ws.addEventListener("message", (event) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "permission_response") {
        const pending = this.pendingRequests.get(data.requestId);
        if (pending) {
          this.pendingRequests.delete(data.requestId);
          pending.resolve(data.response);
        }
      }
    });

    this.ws.addEventListener("close", () => {
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error("WebSocket closed"));
        this.pendingRequests.delete(id);
      }
    });
  }

  async requestPermission(
    request: PermissionRequest,
    signal: AbortSignal
  ): Promise<PermissionResponse> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return { approved: false, createRule: false, reason: "Connection lost" };
    }

    return new Promise<PermissionResponse>((resolve, reject) => {
      this.pendingRequests.set(request.id, { resolve, reject });

      const onAbort = () => {
        this.pendingRequests.delete(request.id);
        resolve({ approved: false, createRule: false, reason: "Aborted" });
      };
      signal.addEventListener("abort", onAbort, { once: true });

      this.ws.send(JSON.stringify({
        type: "permission_request",
        ...request,
      }));
    });
  }
}
```
**Explanation:** The bridge sends permission requests as JSON messages over the WebSocket and tracks pending requests by ID. When a response arrives, it resolves the matching promise. Connection loss automatically denies all pending requests (fail-safe). The `AbortSignal` integration allows the agent to cancel pending permission requests. If the WebSocket is not open when a request arrives, it immediately returns a denial rather than queuing — this prevents indefinite hangs.

---

## Exercise 4
**Challenge:** Write a `createDenialToolResult` function.

**Answer:**
```typescript
interface ToolResultMessage {
  type: "tool_result";
  tool_use_id: string;
  content: Array<{ type: "text"; text: string }>;
  is_error: boolean;
}

function createDenialToolResult(
  toolUseId: string,
  toolName: string,
  reason: string
): ToolResultMessage {
  const suggestions = getDenialSuggestions(toolName);

  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: [
      {
        type: "text",
        text:
          `Permission denied: the tool "${toolName}" was not allowed to execute.\n` +
          `Reason: ${reason}\n\n` +
          `Suggestions:\n` +
          suggestions.map((s) => `- ${s}`).join("\n"),
      },
    ],
    is_error: true,
  };
}

function getDenialSuggestions(toolName: string): string[] {
  const base = [
    "Try an alternative approach that doesn't require this permission.",
    "Explain to the user why this action is necessary so they can approve it.",
  ];

  switch (toolName) {
    case "bash":
      return [
        ...base,
        "Consider using a safer command that achieves the same result.",
        "Ask the user to run the command manually if it's critical.",
      ];
    case "write_file":
    case "edit_file":
      return [
        ...base,
        "Show the proposed changes to the user in text form instead.",
      ];
    default:
      return base;
  }
}
```
**Explanation:** The denial result is structured as an error tool result so the model recognizes the action failed. The suggestions guide the model toward productive alternatives rather than just retrying the same blocked action. Tool-specific suggestions (like "ask the user to run the command manually") give the model actionable fallbacks. The `is_error: true` flag helps the model's reasoning distinguish between successful results and permission failures.
