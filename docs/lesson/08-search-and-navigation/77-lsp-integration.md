# Lesson 77: LSP Integration — Semantic Code Navigation

## Beyond Text Search

GrepTool finds text patterns. But code isn't just text — it has **structure**. Consider searching for `"User"`:

```
grep results:
  src/models/User.ts:5:      export class User {           ← definition
  src/models/User.ts:12:     // User authentication logic  ← comment
  src/api/routes.ts:8:       import { User } from ...      ← import
  src/api/routes.ts:23:      const user = new User()       ← usage
  src/tests/user.test.ts:5:  describe("User", () => {      ← test label
  src/types.ts:30:           type UserRole = ...            ← different type entirely
```

Grep can't distinguish between definitions, usages, comments, and unrelated matches. The **Language Server Protocol (LSP)** can. It understands code semantically — which symbol is defined where, what references it, and what type it has.

---

## What Is LSP?

The Language Server Protocol is a standard created by Microsoft that separates language intelligence from editors. A language server runs as a separate process and provides:

| Capability | What It Does |
|-----------|-------------|
| **Go to Definition** | Jump from usage to where a symbol is defined |
| **Find References** | Find all places a symbol is used |
| **Hover** | Get type information and documentation for a symbol |
| **Diagnostics** | Errors, warnings, and hints |
| **Completions** | Auto-complete suggestions |
| **Rename** | Safely rename a symbol across the entire project |
| **Document Symbols** | List all symbols in a file (functions, classes, variables) |

The protocol uses JSON-RPC over stdin/stdout. Every modern editor (VS Code, Neovim, Emacs) uses LSP for language features.

---

## LSPTool: Exposing LSP to the Agent

Claude Code wraps LSP capabilities in a tool:

```typescript
const inputSchema = z.strictObject({
  action: z
    .enum([
      "definition",
      "references",
      "hover",
      "diagnostics",
      "document_symbols",
    ])
    .describe("The LSP action to perform"),
  file_path: z
    .string()
    .describe("The file containing the symbol"),
  line: z
    .number()
    .int()
    .nonnegative()
    .describe("0-based line number of the symbol"),
  character: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("0-based character offset within the line"),
  language: z
    .string()
    .optional()
    .describe("Language ID (typescript, python, rust, etc.)"),
});
```

### Feature-Gated

LSPTool is not always available:

```typescript
export class LSPTool extends Tool {
  get isEnabled(): boolean {
    return featureFlags.get("ENABLE_LSP_TOOL") === true;
  }
}
```

Why gate it? Because:
1. The language server must be running (resource overhead)
2. Not all languages have mature LSP implementations
3. The server needs project setup (tsconfig, pyproject.toml, etc.)
4. Startup time can be significant for large projects

---

## LSP Actions in Detail

### Go to Definition

```typescript
async function goToDefinition(
  filePath: string,
  line: number,
  character: number
): Promise<Location[]> {
  const result = await lspClient.sendRequest("textDocument/definition", {
    textDocument: { uri: `file://${filePath}` },
    position: { line, character },
  });

  return Array.isArray(result) ? result : [result];
}
```

Example usage:

```typescript
// The model sees: import { validateToken } from "../auth/utils"
// It wants to know what validateToken does

LSPTool({
  action: "definition",
  file_path: "src/api/routes.ts",
  line: 3,
  character: 10,  // cursor on "validateToken"
})

// Returns:
// src/auth/utils.ts:45:0 — export function validateToken(token: string): boolean
```

This is far more precise than `GrepTool({ pattern: "function validateToken" })` — LSP follows the actual import resolution, handling re-exports, barrel files, and aliased imports.

### Find References

```typescript
async function findReferences(
  filePath: string,
  line: number,
  character: number
): Promise<Location[]> {
  const result = await lspClient.sendRequest("textDocument/references", {
    textDocument: { uri: `file://${filePath}` },
    position: { line, character },
    context: { includeDeclaration: true },
  });

  return result;
}
```

Example:

```typescript
LSPTool({
  action: "references",
  file_path: "src/auth/utils.ts",
  line: 45,
  character: 16,  // cursor on "validateToken"
})

// Returns:
// src/auth/utils.ts:45:16 — definition
// src/api/routes.ts:3:9   — import
// src/api/routes.ts:28:5  — usage in handleAuth
// src/middleware/auth.ts:12:3 — usage in authMiddleware
// src/tests/auth.test.ts:8:5 — usage in test
```

Compare this to grep: LSP only returns *actual references* to the symbol, not string matches in comments, documentation, or unrelated code.

### Hover (Type Information)

```typescript
async function hover(
  filePath: string,
  line: number,
  character: number
): Promise<string> {
  const result = await lspClient.sendRequest("textDocument/hover", {
    textDocument: { uri: `file://${filePath}` },
    position: { line, character },
  });

  return result?.contents?.value || "No hover information available";
}
```

Example:

```typescript
LSPTool({
  action: "hover",
  file_path: "src/api/routes.ts",
  line: 28,
  character: 20,  // cursor on "validateToken(token)"
})

// Returns:
// function validateToken(token: string): boolean
// ---
// Validates a JWT token and returns true if valid.
// @param token - The JWT token string
// @returns true if the token is valid and not expired
```

The model gets the function signature AND its documentation without reading the source file.

### Diagnostics

```typescript
async function getDiagnostics(filePath: string): Promise<Diagnostic[]> {
  const result = await lspClient.sendRequest(
    "textDocument/diagnostic",
    {
      textDocument: { uri: `file://${filePath}` },
    }
  );

  return result.items.map((d) => ({
    line: d.range.start.line,
    character: d.range.start.character,
    severity: d.severity, // 1=error, 2=warning, 3=info, 4=hint
    message: d.message,
    source: d.source, // "typescript", "eslint", etc.
  }));
}
```

Example:

```typescript
LSPTool({
  action: "diagnostics",
  file_path: "src/api/routes.ts",
})

// Returns:
// Line 15, Col 5: ERROR — Property 'name' does not exist on type 'User' (typescript)
// Line 23, Col 1: WARNING — 'config' is declared but never used (typescript)
// Line 31, Col 10: INFO — Prefer 'const' over 'let' (eslint)
```

This gives the agent precise error information without running a build or test command.

### Document Symbols

```typescript
async function getDocumentSymbols(filePath: string): Promise<Symbol[]> {
  const result = await lspClient.sendRequest(
    "textDocument/documentSymbol",
    {
      textDocument: { uri: `file://${filePath}` },
    }
  );

  return flattenSymbols(result);
}
```

Example:

```typescript
LSPTool({
  action: "document_symbols",
  file_path: "src/auth/handler.ts",
})

// Returns:
// Class: AuthHandler (line 10)
//   Method: handleLogin (line 15)
//   Method: handleLogout (line 35)
//   Method: refreshToken (line 52)
//   Property: tokenStore (line 11)
// Function: createAuthHandler (line 70)
// Interface: AuthConfig (line 75)
```

This gives the model a structural overview of a file without reading the entire content — useful for large files where you want to know what's defined before deciding what to read.

---

## Why LSP Is Better Than Text Search for Navigation

| Task | GrepTool | LSPTool |
|------|----------|---------|
| Find function definition | Searches for `"function name"` — may find comments, strings | Follows actual symbol resolution |
| Find all usages | Matches the string — includes false positives | Returns only semantic references |
| Get type info | Cannot determine types | Returns full type signatures |
| Handle re-exports | Would miss re-exported symbols | Follows the entire export chain |
| Handle aliases | `import { User as U }` — grep for "User" misses usages of "U" | Tracks the alias |

### Example: Aliased Import

```typescript
// In routes.ts:
import { validateToken as checkToken } from "../auth/utils";

// Later:
if (checkToken(token)) { ... }
```

- `GrepTool({ pattern: "validateToken" })` → finds the import but NOT the usage
- `LSPTool({ action: "references" })` on `validateToken` → finds BOTH the import AND all usages of `checkToken`

---

## How the Agent Combines LSP with Other Tools

LSP doesn't replace text search — it complements it:

```
Task: "Rename the validateToken function to verifyToken"

Step 1: LSPTool({ action: "references", ... })
        → Find all 12 references across 5 files

Step 2: For each file, Read the relevant section

Step 3: For each reference, Edit with old_string → new_string
        (or use LSP rename if available)
```

Without LSP, the agent would use grep to find references — and might miss aliased imports, dynamic references, or references in files that don't match a simple text pattern.

---

## Limitations

LSP is powerful but not always available or perfect:

1. **Language support varies** — TypeScript has excellent LSP; some languages have basic support
2. **Project must be configured** — tsconfig.json, pyproject.toml must be set up correctly
3. **Startup time** — language servers can take seconds to initialize for large projects
4. **Incomplete indexes** — for very large monorepos, LSP might not index everything
5. **Dynamic languages** — Python and JavaScript have weaker type resolution than TypeScript or Rust

The agent falls back to text search when LSP is unavailable or returns incomplete results.

---

## Key Takeaways

1. **LSP provides semantic understanding** — definition, references, types, diagnostics — that text search cannot match.

2. **Feature-gated** because it requires a running language server with project setup.

3. **Five actions**: definition (where is it?), references (who uses it?), hover (what type?), diagnostics (what's wrong?), document_symbols (what's in this file?).

4. **Handles aliases and re-exports** that text search misses entirely.

5. **Complements, not replaces** text search — the agent uses both based on what's needed.

---

## What's Next

The final lesson in this module brings everything together: Lesson 78 covers **codebase exploration strategies** — the systematic approach the agent uses to understand a new codebase by combining directory listing, glob, grep, file reading, and LSP.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Five LSP Actions
**Question:** Name the five LSP actions exposed by LSPTool and give a concrete development scenario where each one would be more useful than GrepTool.

[View Answer](../../answers/08-search-and-navigation/answer-77.md#exercise-1)

### Exercise 2 — Format LSP Locations
**Challenge:** Write a `formatLSPLocations` function that takes an array of LSP `Location` objects (each with `uri`, `range.start.line`, `range.start.character`) and formats them as a human-readable string, one location per line, like `src/auth/utils.ts:45:16`.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-77.md#exercise-2)

### Exercise 3 — Safe Symbol Rename
**Challenge:** Write a `safeRenameSymbol` function that uses LSP to find all references to a symbol, then generates an array of file edits (each with `filePath`, `oldText`, `newText`). Handle the case where a reference is an aliased import (`import { old as alias }`) — the alias should NOT be renamed.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-77.md#exercise-3)

### Exercise 4 — LSP vs Grep Comparison
**Challenge:** Given this code scenario where `validateToken` is imported as `checkToken` in another file, write both a GrepTool call and an LSPTool call to find all usages. Then write a `findAllReferences` function that tries LSP first and falls back to grep if LSP is unavailable.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-77.md#exercise-4)
