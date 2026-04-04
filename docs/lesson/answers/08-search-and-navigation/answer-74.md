# Answers: Lesson 74 — GlobTool (Finding Files by Name)

## Exercise 1
**Question:** Why does GlobTool auto-prepend `**/` to patterns, and why are results sorted by modification time instead of alphabetically?

**Answer:** Auto-prepending `**/` enables recursive searching by default. Without it, a pattern like `*.test.ts` would only match files in the current directory, missing deeply nested test files like `src/auth/__tests__/login.test.ts`. This eliminates a common failure mode where the model forgets to add `**/` and gets zero results for nested files. Results are sorted by modification time (newest first) because the most recently edited files are usually the most relevant to the current task. If a developer is working on `Button.tsx` and asks about related files, the files they touched most recently should appear first, not files sorted alphabetically that may be irrelevant.

---

## Exercise 2
**Challenge:** Write the `normalizePattern` function that auto-prepends `**/` to glob patterns.

**Answer:**
```typescript
function normalizePattern(pattern: string): string {
  if (pattern.length === 0) {
    return "**/*";
  }

  if (pattern.startsWith("**/") || pattern.startsWith("/")) {
    return pattern;
  }

  if (pattern.startsWith("!")) {
    const inner = pattern.slice(1);
    if (inner.startsWith("**/") || inner.startsWith("/")) {
      return pattern;
    }
    return `!**/${inner}`;
  }

  return `**/${pattern}`;
}

// Tests
console.assert(normalizePattern("*.ts") === "**/*.ts");
console.assert(normalizePattern("**/src/*.ts") === "**/src/*.ts");
console.assert(normalizePattern("/absolute/path") === "/absolute/path");
console.assert(normalizePattern("!*.test.ts") === "!**/*.test.ts");
console.assert(normalizePattern("") === "**/*");
console.assert(normalizePattern("src/index.ts") === "**/src/index.ts");
```
**Explanation:** The function checks three conditions before prepending: empty strings get a catch-all pattern, patterns already starting with `**/` or `/` are left as-is, and negation patterns (starting with `!`) have `**/` inserted after the `!`. All other patterns get `**/` prepended to enable recursive matching.

---

## Exercise 3
**Challenge:** Write GlobTool calls for monorepo discovery and a `classifyProjectType` function.

**Answer:**
```typescript
// Step 1: Find all package.json files to identify packages
GlobTool({ pattern: "packages/*/package.json" })

// Step 2: Find configuration files
GlobTool({ pattern: "*.config.{js,ts,json,mjs,cjs}" })

// Step 3: Find entry points
GlobTool({ pattern: "{index,main,app}.{ts,tsx,js,jsx}" })

// Project type classifier
function classifyProjectType(filePaths: string[]): string {
  const fileSet = new Set(filePaths.map((f) => f.toLowerCase()));
  const hasFile = (pattern: string) =>
    filePaths.some((f) => f.toLowerCase().includes(pattern));

  if (hasFile("next.config")) return "next.js";
  if (hasFile("nuxt.config")) return "nuxt";
  if (hasFile("angular.json")) return "angular";
  if (hasFile("svelte.config")) return "svelte-kit";
  if (hasFile("vite.config") && hasFile(".tsx")) return "react-vite";
  if (hasFile("manage.py")) return "django";
  if (hasFile("requirements.txt") || hasFile("pyproject.toml")) return "python";
  if (hasFile("cargo.toml")) return "rust";
  if (hasFile("go.mod")) return "go";
  if (hasFile("package.json") && hasFile(".tsx")) return "react";
  if (hasFile("package.json")) return "node";

  return "unknown";
}
```
**Explanation:** The GlobTool calls progressively discover the monorepo structure: first package boundaries, then configuration, then entry points. The classifier uses a priority-ordered heuristic — `next.config` is checked before generic `react` because Next.js projects also contain React files. The check order matters: more specific frameworks are detected before general ones.

---

## Exercise 4
**Challenge:** Implement `sortByMtime` with truncation.

**Answer:**
```typescript
import * as fs from "fs/promises";
import * as path from "path";

const MAX_GLOB_RESULTS = 10000;

interface GlobResult {
  files: string[];
  truncated: boolean;
  totalCount: number;
}

async function sortByMtime(
  files: string[],
  cwd: string
): Promise<GlobResult> {
  const withStats = await Promise.all(
    files.map(async (f) => {
      try {
        const stats = await fs.stat(path.join(cwd, f));
        return { file: f, mtime: stats.mtimeMs };
      } catch {
        return { file: f, mtime: 0 };
      }
    })
  );

  const sorted = withStats
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.file);

  if (sorted.length > MAX_GLOB_RESULTS) {
    return {
      files: sorted.slice(0, MAX_GLOB_RESULTS),
      truncated: true,
      totalCount: sorted.length,
    };
  }

  return {
    files: sorted,
    truncated: false,
    totalCount: sorted.length,
  };
}

function formatGlobOutput(result: GlobResult): string {
  let output = result.files.join("\n");

  if (result.truncated) {
    output +=
      `\n\n... truncated. ${result.totalCount} total matches. ` +
      `Use a more specific pattern to narrow results.`;
  }

  return output;
}
```
**Explanation:** The function stats each file in parallel using `Promise.all` for performance. Failed stats (e.g., broken symlinks) get `mtime: 0` so they sort to the end rather than crashing. After sorting newest-first, the `MAX_GLOB_RESULTS` cap prevents excessive output. The formatter appends a truncation notice that guides the model toward more specific patterns rather than trying to paginate.
