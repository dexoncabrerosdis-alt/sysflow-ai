# Answers: Lesson 34 — Built-In Tools Overview

## Exercise 1
**Question:** Describe the typical tool usage pattern and its four stages. Give a concrete example.

**Answer:** The pattern is **Explore → Understand → Act → Verify**:

1. **Explore** — Discover the project structure and find relevant files using search tools (Glob, Grep).
2. **Understand** — Read the relevant files to comprehend the existing code, its context, and dependencies (Read).
3. **Act** — Make the necessary changes using write tools (Edit, Write, Bash).
4. **Verify** — Confirm the changes work by reading the modified files, running tests, or building (Read, Bash).

The model follows this pattern instead of jumping to writing code because it needs context. Without exploring first, it might edit the wrong file, use incorrect import paths, duplicate existing functionality, or break conventions the project follows.

**Concrete example — "Fix the broken import in App.tsx":**

```
1. Explore:  Glob("src/**/App.tsx")           → finds src/components/App.tsx
2. Understand: Read("src/components/App.tsx")  → sees broken import on line 3
             Grep("export.*utils", "src/")   → finds the correct export path
3. Act:      Edit("src/components/App.tsx",
               old: "import { utils } from '../utls';",
               new: "import { utils } from '../utils';")
4. Verify:   Bash("npm run build")            → build succeeds, import fixed
```

---

## Exercise 2
**Challenge:** Plan a tool sequence for adding a `/api/users/:id` endpoint.

**Answer:**

```
// EXPLORE — discover project structure
1. Glob({ pattern: "src/**/*route*" })
   → finds src/routes/index.ts, src/routes/api.ts

2. Grep({ pattern: "app\\.(get|post|put)", path: "src/routes/" })
   → finds existing endpoint patterns

// UNDERSTAND — read relevant files
3. Read({ file_path: "src/routes/api.ts" })
   → understand existing API structure, middleware, patterns

4. Read({ file_path: "src/models/User.ts" })
   → understand the User model schema

5. Grep({ pattern: "getUser|findUser", path: "src/" })
   → check if a user-fetching utility already exists

// ACT — implement the endpoint
6. Edit({
     file_path: "src/routes/api.ts",
     old_string: "// User routes",
     new_string: `// User routes\nrouter.get('/users/:id', async (req, res) => {\n  const user = await User.findById(req.params.id);\n  if (!user) return res.status(404).json({ error: 'User not found' });\n  res.json(user);\n});`
   })

// VERIFY — ensure it works
7. Bash({ command: "npm run build" })
   → compile check

8. Bash({ command: "npm test -- --grep 'users'" })
   → run relevant tests

9. Read({ file_path: "src/routes/api.ts" })
   → re-read to verify the edit looks correct
```

**Explanation:** The sequence follows explore (2 calls) → understand (3 calls) → act (1 call) → verify (3 calls). The model checks existing patterns before writing, ensuring consistency. It also verifies via both build and test.

---

## Exercise 3
**Challenge:** Classify 10 tools.

**Answer:**

| # | Tool | isReadOnly | isConcurrencySafe | Explanation |
|---|------|-----------|-------------------|-------------|
| 1 | Read | `true` | `true` | Only reads file contents; reads don't conflict |
| 2 | Write | `false` | `false` | Creates/overwrites files; concurrent writes to same file = race condition |
| 3 | Grep | `true` | `true` | Regex search is read-only; each search is independent |
| 4 | Bash | `false` | `false` | Can run arbitrary commands with side effects; commands may conflict |
| 5 | WebFetch | `true` | `true` | Fetches remote content without modifying local state; requests are independent |
| 6 | Edit | `false` | `false` | Modifies files via search-and-replace; concurrent edits to same file = data loss |
| 7 | Glob | `true` | `true` | Finds files by pattern; read-only filesystem traversal |
| 8 | Agent | `false` | `false` | Spawns sub-agents that can themselves use write tools |
| 9 | TodoWrite | `false` | `false` | Modifies the task list state; concurrent updates could conflict |
| 10 | WebSearch | `true` | `true` | Performs web searches; read-only, each request is independent |

---

## Exercise 4
**Challenge:** Define Zod schemas for three new tools.

**Answer:**

```typescript
import { z } from "zod";

// (a) GitDiff — shows diff between two refs
const GitDiffSchema = z.object({
  ref1: z.string().describe(
    "First Git ref to compare (branch name, commit hash, or tag). Example: 'main'"
  ),
  ref2: z.string().optional().describe(
    "Second Git ref to compare. Defaults to HEAD (working directory) if omitted."
  ),
  path: z.string().optional().describe(
    "Limit diff to a specific file or directory path"
  ),
  stat_only: z.boolean().optional().default(false).describe(
    "Show only a summary of changes (files changed, insertions, deletions) instead of full diff"
  ),
});
// isReadOnly: true — only reads Git state
// isConcurrencySafe: true — git diff is a read operation

// (b) JsonQuery — extracts data using JSONPath
const JsonQuerySchema = z.object({
  file_path: z.string().describe(
    "Absolute path to the JSON file to query"
  ),
  query: z.string().describe(
    "JSONPath expression to evaluate. Examples: '$.store.book[0].title', '$.users[?(@.age > 18)]'"
  ),
  format: z.enum(["json", "text"]).optional().default("json").describe(
    "Output format. 'json' returns formatted JSON, 'text' returns values as plain text."
  ),
});
// isReadOnly: true — only reads and queries files
// isConcurrencySafe: true — read-only, stateless

// (c) ImageResize — resizes an image file
const ImageResizeSchema = z.object({
  input_path: z.string().describe(
    "Absolute path to the source image file"
  ),
  output_path: z.string().describe(
    "Absolute path where the resized image will be saved"
  ),
  width: z.number().int().positive().optional().describe(
    "Target width in pixels. Omit to auto-calculate from height while preserving aspect ratio."
  ),
  height: z.number().int().positive().optional().describe(
    "Target height in pixels. Omit to auto-calculate from width while preserving aspect ratio."
  ),
  quality: z.number().int().min(1).max(100).optional().default(85).describe(
    "Output quality (1-100). Only applies to JPEG and WebP formats. Default: 85"
  ),
});
// isReadOnly: false — writes a new file to disk
// isConcurrencySafe: false — writes to filesystem
```

**Explanation:** Each schema uses descriptive `.describe()` text with examples where helpful (JSONPath, Git refs). Optional fields have sensible defaults. The ImageResize tool allows omitting either width or height for aspect-ratio preservation. Flags are chosen based on whether the tool modifies state.
