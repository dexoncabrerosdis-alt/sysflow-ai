# Answers: Lesson 77 — LSP Integration

## Exercise 1
**Question:** Name the five LSP actions and give a concrete scenario where each is more useful than GrepTool.

**Answer:** (1) **definition** — When the agent sees `validateToken(token)` in a file and needs to understand the implementation. Grep might find multiple functions with similar names across different modules; LSP follows the actual import chain to the exact definition. (2) **references** — When renaming `handleAuth`. Grep misses aliased imports like `import { handleAuth as authHandler }`; LSP tracks the alias and finds usages of `authHandler` too. (3) **hover** — When the agent needs the type signature of a third-party library function without reading its source. Grep can't determine types; LSP returns the full signature and JSDoc. (4) **diagnostics** — When checking if an edit introduced type errors without running `tsc`. Grep can't detect type mismatches; LSP reports them in real-time. (5) **document_symbols** — When exploring a large file (500+ lines) to understand its structure before reading specific sections. Grep would require guessing function names; LSP lists all classes, methods, and exports hierarchically.

---

## Exercise 2
**Challenge:** Write a `formatLSPLocations` function.

**Answer:**
```typescript
interface LSPLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

function formatLSPLocations(locations: LSPLocation[]): string {
  if (locations.length === 0) {
    return "No locations found.";
  }

  return locations
    .map((loc) => {
      const filePath = loc.uri.replace("file://", "");
      const line = loc.range.start.line + 1;
      const col = loc.range.start.character + 1;
      return `${filePath}:${line}:${col}`;
    })
    .join("\n");
}

// Test
const locations: LSPLocation[] = [
  {
    uri: "file:///project/src/auth/utils.ts",
    range: { start: { line: 44, character: 15 }, end: { line: 44, character: 28 } },
  },
  {
    uri: "file:///project/src/api/routes.ts",
    range: { start: { line: 2, character: 9 }, end: { line: 2, character: 22 } },
  },
];

console.log(formatLSPLocations(locations));
// /project/src/auth/utils.ts:45:16
// /project/src/api/routes.ts:3:10
```
**Explanation:** LSP uses 0-based line and character numbers internally, but developers expect 1-based numbers (matching what editors display). The function adds 1 to both `line` and `character` for human readability. The `file://` prefix is stripped from URIs to produce clean file paths. The output format (`file:line:col`) matches the standard grep/compiler output that developers are familiar with.

---

## Exercise 3
**Challenge:** Write a `safeRenameSymbol` function using LSP references.

**Answer:**
```typescript
interface FileEdit {
  filePath: string;
  oldText: string;
  newText: string;
}

interface LSPReference {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  context?: string;
}

async function safeRenameSymbol(
  filePath: string,
  line: number,
  character: number,
  oldName: string,
  newName: string,
  lspClient: LSPClient
): Promise<FileEdit[]> {
  const references = await lspClient.sendRequest("textDocument/references", {
    textDocument: { uri: `file://${filePath}` },
    position: { line, character },
    context: { includeDeclaration: true },
  });

  const edits: FileEdit[] = [];

  for (const ref of references) {
    const refPath = ref.uri.replace("file://", "");
    const refLine = await readLine(refPath, ref.range.start.line);

    const isAliasedImport = /import\s*\{[^}]*\bas\s+\w+/.test(refLine) &&
      refLine.includes(`${oldName} as `);

    if (isAliasedImport) {
      edits.push({
        filePath: refPath,
        oldText: `${oldName} as `,
        newText: `${newName} as `,
      });
    } else {
      edits.push({
        filePath: refPath,
        oldText: oldName,
        newText: newName,
      });
    }
  }

  return edits;
}

async function readLine(filePath: string, lineNumber: number): Promise<string> {
  const content = await fs.readFile(filePath, "utf-8");
  return content.split("\n")[lineNumber] || "";
}
```
**Explanation:** The function fetches all references via LSP (which handles aliases properly), then examines each reference line to determine if it's an aliased import. For aliased imports like `import { validateToken as checkToken }`, only the original name in the import statement is renamed — the alias `checkToken` stays the same since it's the consumer's chosen name. For all other references (definitions, usages), a straightforward rename is applied.

---

## Exercise 4
**Challenge:** Write both GrepTool and LSPTool calls for an aliased import scenario, then a fallback function.

**Answer:**
```typescript
// Scenario: validateToken is imported as checkToken in routes.ts
// import { validateToken as checkToken } from "../auth/utils";
// if (checkToken(token)) { ... }

// GrepTool approach — MISSES aliased usages
GrepTool({ pattern: "validateToken", output_mode: "files_with_matches" })
// Finds: auth/utils.ts (definition), routes.ts (import line only)
// Misses: routes.ts line with checkToken(token)

// LSPTool approach — finds ALL references including aliases
LSPTool({
  action: "references",
  file_path: "src/auth/utils.ts",
  line: 45,
  character: 16,
})
// Finds: auth/utils.ts:45 (definition), routes.ts:3 (import), routes.ts:28 (checkToken usage)

// Fallback function
interface Reference {
  filePath: string;
  line: number;
  character: number;
  source: "lsp" | "grep";
}

async function findAllReferences(
  filePath: string,
  line: number,
  character: number,
  symbolName: string,
  lspAvailable: boolean
): Promise<Reference[]> {
  if (lspAvailable) {
    try {
      const lspRefs = await lspClient.sendRequest("textDocument/references", {
        textDocument: { uri: `file://${filePath}` },
        position: { line, character },
        context: { includeDeclaration: true },
      });

      return lspRefs.map((ref: LSPLocation) => ({
        filePath: ref.uri.replace("file://", ""),
        line: ref.range.start.line,
        character: ref.range.start.character,
        source: "lsp" as const,
      }));
    } catch {
      // LSP failed — fall through to grep
    }
  }

  const grepOutput = await executeGrep({
    pattern: symbolName,
    output_mode: "content",
  });

  return parseGrepToReferences(grepOutput);
}

function parseGrepToReferences(grepOutput: string): Reference[] {
  return grepOutput
    .split("\n")
    .filter((line) => line.includes(":"))
    .map((line) => {
      const [filePath, lineNum, ...rest] = line.split(":");
      return {
        filePath,
        line: parseInt(lineNum) - 1,
        character: 0,
        source: "grep" as const,
      };
    });
}
```
**Explanation:** The grep call finds string matches but misses `checkToken` usages entirely since the string "validateToken" doesn't appear there. LSP tracks the symbol through its alias chain. The fallback function tries LSP first for accuracy, and if it fails (server not running, timeout, etc.), falls back to grep. The `source` field in the result lets the caller know which method was used — useful for warning about potential false positives/negatives when grep is used.
