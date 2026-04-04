# Lesson 74: GlobTool — Finding Files by Name Pattern

## Content Search vs Name Search

GrepTool (Lesson 73) answers: "Which files *contain* this pattern?"
GlobTool answers: "Which files *exist* matching this name pattern?"

These are fundamentally different operations:

```
GrepTool: "Find files containing 'handleAuth'" → searches inside files
GlobTool: "Find files named '*.test.ts'"       → searches the file system
```

Both are essential for codebase navigation. You use GlobTool to discover structure, and GrepTool to discover content.

---

## The Zod Input Schema

```typescript
const inputSchema = z.strictObject({
  pattern: z
    .string()
    .describe(
      'Glob pattern to match file paths (e.g., "src/**/*.test.ts", "*.json")'
    ),
  path: z
    .string()
    .optional()
    .describe("Directory to search in. Defaults to current working directory."),
});
```

Minimalist by design. The pattern does all the work.

---

## Safety Properties

```typescript
export class GlobTool extends Tool {
  get isConcurrencySafe(): boolean {
    return true;
  }

  get isReadOnly(): boolean {
    return true;
  }
}
```

Like GrepTool, GlobTool is purely read-only and safe for parallel execution.

---

## Glob Pattern Syntax

Glob patterns use a different syntax than regex. Here's what's available:

| Pattern | Meaning | Example |
|---------|---------|---------|
| `*` | Match any characters in a single path segment | `*.ts` matches `app.ts` but not `src/app.ts` |
| `**` | Match any characters across path segments | `**/*.ts` matches `src/app.ts` |
| `?` | Match a single character | `?.ts` matches `a.ts` but not `ab.ts` |
| `{a,b}` | Match either alternative | `*.{ts,js}` matches both `.ts` and `.js` |
| `[abc]` | Match any character in the set | `[Rr]eadme*` matches `README` and `readme` |
| `!` | Negate (in exclude patterns) | `!*.test.ts` excludes test files |

### The ** Auto-Prepend

A key usability feature: patterns that don't start with `**/` get it prepended automatically:

```typescript
function normalizePattern(pattern: string): string {
  if (!pattern.startsWith("**/") && !pattern.startsWith("/")) {
    return `**/${pattern}`;
  }
  return pattern;
}
```

This means the model can write `"*.test.ts"` and it becomes `"**/*.test.ts"` — searching recursively through all subdirectories. Without this, the model would need to remember to add `**/` every time, and forgetting would return no results for nested files.

---

## Default Exclusions

GlobTool excludes directories that would pollute results:

```typescript
const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/.tox/**",
  "**/coverage/**",
  "**/.cache/**",
];
```

These are directories that:
1. Contain generated/vendored code (not useful to read or edit)
2. Can contain thousands of files (slow to scan)
3. Would overwhelm the results with irrelevant matches

The exclusions are hard-coded defaults. The model doesn't need to remember to exclude `node_modules` — it's already handled.

---

## How It Works

```typescript
import { glob } from "glob";

async function executeGlob(input: GlobInput): Promise<string> {
  const pattern = normalizePattern(input.pattern);
  const cwd = input.path || process.cwd();

  const matches = await glob(pattern, {
    cwd,
    ignore: DEFAULT_EXCLUDES,
    nodir: false, // Include directories in results
    dot: false,   // Exclude dotfiles by default
    absolute: false, // Return relative paths
  });

  // Sort by modification time (most recently modified first)
  const sorted = await sortByMtime(matches, cwd);

  return sorted.join("\n");
}

async function sortByMtime(
  files: string[],
  cwd: string
): Promise<string[]> {
  const withStats = await Promise.all(
    files.map(async (f) => {
      const stats = await fs.stat(path.join(cwd, f));
      return { file: f, mtime: stats.mtimeMs };
    })
  );

  return withStats
    .sort((a, b) => b.mtime - a.mtime) // Most recent first
    .map((entry) => entry.file);
}
```

Results are sorted by modification time (most recent first). This is a deliberate UX choice — the most recently modified files are usually the most relevant to the current task.

---

## When to Use Glob vs Grep

### Use GlobTool When:

**Finding project structure files:**
```typescript
GlobTool({ pattern: "package.json" })
// → finds all package.json files in the monorepo
```

**Finding test files for a component:**
```typescript
GlobTool({ pattern: "Button.test.*" })
// → Button.test.tsx, Button.test.snap
```

**Finding configuration files:**
```typescript
GlobTool({ pattern: "*.config.{js,ts,json}" })
// → webpack.config.js, tsconfig.json, jest.config.ts
```

**Discovering directory structure:**
```typescript
GlobTool({ pattern: "src/*" })
// → src/components, src/utils, src/hooks, src/pages
```

### Use GrepTool When:

**Finding where something is used:**
```typescript
GrepTool({ pattern: "import.*Button", glob: "*.tsx" })
// → all files that import Button
```

**Finding function definitions:**
```typescript
GrepTool({ pattern: "export function handleAuth" })
// → the file and line where handleAuth is defined
```

**Finding string literals:**
```typescript
GrepTool({ pattern: "API_BASE_URL" })
// → all files referencing this constant
```

### The Decision Heuristic

```
Do I know the file name (or pattern)?     → GlobTool
Do I know something inside the file?       → GrepTool
Do I need both?                            → GlobTool first, then GrepTool with path filter
```

---

## Common Agent Patterns

### Pattern 1: Discover Then Read

```
Step 1: GlobTool({ pattern: "README*" })
        → README.md, packages/api/README.md

Step 2: Read({ file_path: "README.md" })
        → Read the root README for project overview
```

### Pattern 2: Find Test Files for a Module

```
Step 1: GlobTool({ pattern: "auth*.test.*" })
        → src/auth/auth.test.ts, src/auth/authMiddleware.test.ts

Step 2: Read both test files to understand existing test structure
```

### Pattern 3: Map a Monorepo

```
Step 1: GlobTool({ pattern: "packages/*/package.json" })
        → packages/api/package.json
           packages/web/package.json
           packages/shared/package.json

Step 2: Read each package.json for name and dependencies
```

### Pattern 4: Find Related Files

```
Step 1: GlobTool({ pattern: "Button.*", path: "src/components/Button" })
        → Button.tsx, Button.module.css, Button.stories.tsx, Button.test.tsx

Step 2: Read the ones relevant to the current task
```

---

## Output Format

GlobTool returns one file path per line, sorted by modification time:

```
src/components/Button/Button.tsx
src/components/Button/Button.module.css
src/components/Button/Button.test.tsx
src/components/Button/Button.stories.tsx
src/components/Button/index.ts
```

No line numbers, no content — just paths. This keeps the output compact and lets the model decide which files to read.

When no matches are found:

```
No files matched the pattern "*.xyz" in src/
```

The error message includes the pattern and directory for debugging.

---

## Performance Considerations

Glob operations traverse the filesystem, which can be slow on large projects:

```typescript
const MAX_GLOB_RESULTS = 10000;

async function executeGlob(input: GlobInput): Promise<string> {
  const matches = await glob(pattern, { ...options });

  if (matches.length > MAX_GLOB_RESULTS) {
    const truncated = matches.slice(0, MAX_GLOB_RESULTS);
    return (
      truncated.join("\n") +
      `\n\n... truncated. ${matches.length} total matches. ` +
      `Use a more specific pattern to narrow results.`
    );
  }

  return matches.join("\n");
}
```

The `MAX_GLOB_RESULTS` cap prevents a pattern like `**/*` from returning every file in a massive project. The truncation notice guides the model toward more specific patterns.

---

## Glob + Grep: The Search Duo

The most effective codebase exploration combines both tools:

```
"Find where the database connection is configured"

Step 1: GlobTool({ pattern: "*.config.*" })
        → Discovers config files by name

Step 2: GrepTool({ pattern: "database|connection|DB_", glob: "*.config.*" })
        → Searches config files for database-related terms

Step 3: Read the specific config file that contains the database setup
```

GlobTool narrows the search space; GrepTool finds the specific content. Together they're far more efficient than either alone.

---

## Key Takeaways

1. **GlobTool finds files by name pattern** — complementary to GrepTool which searches file contents.

2. **Auto-prepending `**/`** makes simple patterns like `"*.ts"` work recursively without the model remembering to add it.

3. **Default exclusions** (node_modules, .git, dist, build) keep results clean and fast.

4. **Sorted by mtime** — most recently modified files appear first, which are usually the most relevant.

5. **Glob + Grep together** is the standard pattern for codebase exploration: find files by name, then search their contents.

---

## What's Next

Sometimes the information the agent needs isn't in the codebase at all — it's on the internet. Lesson 75 covers the **web search and fetch tools** that let the agent look up documentation, changelogs, and error messages online.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Auto-Prepend and Sort Order
**Question:** Why does GlobTool auto-prepend `**/` to patterns, and why are results sorted by modification time instead of alphabetically? Give a concrete scenario where each design choice helps the agent.

[View Answer](../../answers/08-search-and-navigation/answer-74.md#exercise-1)

### Exercise 2 — Implement normalizePattern
**Challenge:** Write the `normalizePattern` function that auto-prepends `**/` to glob patterns that don't already start with `**/` or `/`. Include edge cases: what happens with empty strings, patterns starting with `!`, and patterns that already have `**/`?

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-74.md#exercise-2)

### Exercise 3 — Monorepo Discovery
**Challenge:** Write a sequence of GlobTool calls that would discover the structure of an unknown monorepo: find all `package.json` files, find all config files, and find all entry points (`index.ts`, `main.ts`, `app.ts`). Then write a `classifyProjectType` function that takes a list of file paths and infers the project type (React, Node API, Python, Rust, etc.).

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-74.md#exercise-3)

### Exercise 4 — Implement sortByMtime with Truncation
**Challenge:** Implement the `sortByMtime` function that takes an array of file paths and a base directory, stats each file, sorts by modification time (newest first), and returns the sorted paths. Add a `MAX_GLOB_RESULTS` cap that truncates results and appends a notice.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-74.md#exercise-4)
