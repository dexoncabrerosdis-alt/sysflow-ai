# Lesson 78: Codebase Exploration — How the Agent Maps Unknown Territory

## The Cold Start Problem

When the agent encounters a codebase for the first time, it knows nothing. No file structure, no language, no framework, no conventions. Yet the user expects it to start making useful changes within seconds.

This lesson covers the **exploration strategy** — the systematic approach the agent uses to build a mental model of a codebase from zero context. It combines every tool we've covered in Modules 07 and 08 into a coherent workflow.

---

## The Five-Phase Exploration Strategy

```
Phase 1: Structure   → List directories, understand layout
Phase 2: Anchors     → Find key files (README, package.json, configs)
Phase 3: Read        → Read important files for context
Phase 4: Search      → Grep/Glob for specific patterns
Phase 5: Navigate    → Use LSP for definitions and references
```

Each phase narrows the focus. The agent starts broad and drills down based on what it discovers.

---

## Phase 1: Directory Structure

The first thing the agent does is understand the project layout:

```typescript
// Agent's first move: list the top-level directory
GlobTool({ pattern: "*", path: "/project" })
```

This reveals the project skeleton:

```
.git/
.github/
src/
tests/
docs/
package.json
tsconfig.json
README.md
.eslintrc.json
docker-compose.yml
```

From this listing alone, the agent infers:
- **Language**: TypeScript (tsconfig.json)
- **Package manager**: npm/yarn (package.json)
- **Has CI/CD**: .github directory
- **Has Docker**: docker-compose.yml
- **Has docs**: docs/ directory
- **Has tests**: tests/ directory

### Going One Level Deeper

```typescript
// Understand the source structure
GlobTool({ pattern: "src/*" })
```

```
src/components/
src/hooks/
src/pages/
src/utils/
src/api/
src/styles/
src/App.tsx
src/index.tsx
```

Now the agent knows: this is a **React application** with a standard directory structure.

---

## Phase 2: Anchor Files

Certain files are disproportionately informative. The agent searches for them:

```typescript
// Find all anchor files in parallel
GlobTool({ pattern: "README*" })
GlobTool({ pattern: "package.json" })
GlobTool({ pattern: "CLAUDE.md" })
GlobTool({ pattern: "*.config.{js,ts,json,mjs,cjs}" })
GlobTool({ pattern: ".env.example" })
```

### The CLAUDE.md Discovery

Claude Code has a special convention: `CLAUDE.md` files contain project-specific instructions for the agent. The agent looks for these at every level:

```typescript
// Search for CLAUDE.md at project root and in subdirectories
GlobTool({ pattern: "CLAUDE.md" })
```

```
CLAUDE.md                    → Project-wide instructions
src/CLAUDE.md                → Source-specific conventions
src/components/CLAUDE.md     → Component conventions
tests/CLAUDE.md              → Testing conventions
```

These files might contain:

```markdown
# Project: TaskFlow

## Build
- `npm run dev` for development
- `npm run build` for production
- `npm test` for testing

## Conventions
- Use functional components with hooks
- State management via Zustand (not Redux)
- API calls go through src/api/client.ts
- All components need tests
```

This context gets injected into the system prompt, giving the agent project-specific knowledge.

### package.json as Intelligence

```typescript
Read({ file_path: "package.json" })
```

```json
{
  "name": "taskflow",
  "dependencies": {
    "react": "^18.2.0",
    "zustand": "^4.4.0",
    "react-router-dom": "^6.20.0",
    "tailwindcss": "^3.3.0"
  },
  "devDependencies": {
    "vitest": "^1.0.0",
    "typescript": "^5.3.0",
    "@testing-library/react": "^14.0.0"
  },
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run",
    "lint": "eslint src/"
  }
}
```

From this single file, the agent learns:
- **Framework**: React 18
- **State management**: Zustand (not Redux, not Context)
- **Routing**: React Router v6
- **Styling**: Tailwind CSS
- **Build tool**: Vite
- **Test framework**: Vitest with Testing Library
- **TypeScript version**: 5.3

---

## Phase 3: Reading Key Files

Armed with structural knowledge, the agent reads the most important files:

```typescript
// These reads happen in parallel
Read({ file_path: "README.md" })
Read({ file_path: "tsconfig.json" })
Read({ file_path: "src/App.tsx" })
```

The README provides project purpose and setup instructions. The tsconfig reveals compilation settings. App.tsx shows the routing structure and top-level architecture.

### Strategic Partial Reads

For large files, the agent reads strategically:

```typescript
// Just the first 50 lines for an overview
Read({ file_path: "src/api/client.ts", limit: 50 })

// Just the exports (usually at the bottom)
Read({ file_path: "src/utils/index.ts", offset: -30 })
```

---

## Phase 4: Targeted Search

Once the agent understands the structure, it searches for specifics related to the user's task:

### Finding Relevant Code

```typescript
// User asked: "Add a dark mode toggle"

// Find existing theme/color references
GrepTool({ pattern: "theme|darkMode|colorScheme", glob: "*.{ts,tsx}" })

// Find the settings page (if it exists)
GlobTool({ pattern: "*settings*" })
GlobTool({ pattern: "*preferences*" })

// Find where styles are configured
GrepTool({ pattern: "tailwind.config|colors|palette", glob: "*.{js,ts,json}" })
```

### Scoping Impact

```typescript
// How many components would be affected?
GrepTool({
  pattern: "className=",
  output_mode: "count",
  glob: "*.tsx",
})
// → 87 files with className — dark mode affects all of them

// Find the CSS/style entry point
GlobTool({ pattern: "*.css", path: "src/styles" })
// → globals.css, variables.css
```

---

## Phase 5: Semantic Navigation

When LSP is available, the agent uses it for precise navigation:

```typescript
// Found a zustand store — understand its structure
LSPTool({
  action: "document_symbols",
  file_path: "src/stores/themeStore.ts",
})
// → useThemeStore, toggleTheme, ThemeState

// Who uses the theme store?
LSPTool({
  action: "references",
  file_path: "src/stores/themeStore.ts",
  line: 5,
  character: 14, // on "useThemeStore"
})
// → 12 components import useThemeStore
```

---

## How Context Feeds the System Prompt

The information gathered during exploration doesn't just live in conversation history — key parts are injected into the system prompt for persistent access:

```
System Prompt Assembly:
├── Base instructions (static)
├── Tool descriptions (static)
├── CLAUDE.md content (from exploration)      ← discovered context
├── Project type heuristics (from package.json) ← inferred context
└── Recent file reads (from readFileState)      ← working context
```

```typescript
function buildProjectContext(explorationResults: ExplorationData): string {
  const sections: string[] = [];

  // From CLAUDE.md files
  if (explorationResults.claudeMd) {
    sections.push(explorationResults.claudeMd);
  }

  // From package.json inference
  if (explorationResults.packageJson) {
    const pkg = explorationResults.packageJson;
    sections.push(
      `Project: ${pkg.name}`,
      `Language: TypeScript`,
      `Framework: ${inferFramework(pkg)}`,
      `Test runner: ${inferTestRunner(pkg)}`,
    );
  }

  return sections.join("\n");
}
```

---

## Exploration Cost Analysis

Exploration isn't free — each tool call costs time and tokens. The agent balances thoroughness against efficiency:

```
Minimal exploration (simple task):
  1 GlobTool + 1 Read ≈ 2 tool calls, ~1 second
  "Fix the typo in README.md"

Moderate exploration (feature work):
  3 GlobTool + 2 GrepTool + 3 Read ≈ 8 tool calls, ~4 seconds
  "Add error handling to the API routes"

Deep exploration (architecture task):
  5 GlobTool + 4 GrepTool + 5 Read + 2 LSP ≈ 16 tool calls, ~8 seconds
  "Refactor the authentication system"
```

The agent calibrates exploration depth to task complexity. A typo fix doesn't need to understand the entire codebase.

---

## Exploration Patterns for Common Project Types

### React/Next.js

```
1. GlobTool("package.json")           → Identify framework and dependencies
2. GlobTool("src/app/*")              → App Router structure (Next.js 13+)
   OR GlobTool("src/pages/*")         → Pages Router structure
3. GlobTool("*.config.*")             → Build and tool configuration
4. GrepTool("createContext|useStore") → State management pattern
5. Read("src/app/layout.tsx")         → Root layout, providers, theme
```

### Python/Django

```
1. GlobTool("*.py", path=".")          → Find Python files
2. GlobTool("requirements*.txt")       → Dependencies
   OR GlobTool("pyproject.toml")
3. GlobTool("manage.py")              → Django project root
4. GlobTool("*/models.py")            → Database models
5. GlobTool("*/urls.py")              → URL routing
6. Read("settings.py")                → Project configuration
```

### Rust

```
1. Read("Cargo.toml")                 → Dependencies and project metadata
2. GlobTool("src/**/*.rs")            → Source structure
3. Read("src/main.rs")                → Entry point
   OR Read("src/lib.rs")
4. GrepTool("pub fn|pub struct")      → Public API surface
5. GlobTool("tests/**/*.rs")          → Test structure
```

### Go

```
1. Read("go.mod")                     → Module name and dependencies
2. GlobTool("**/*.go")                → Source structure
3. GlobTool("cmd/*")                  → Entry points
4. GrepTool("func main")             → Main functions
5. GrepTool("type.*struct")          → Data structures
```

---

## Anti-Patterns: What Not to Do

### Don't Read Everything

```
❌ Read every file in src/ "to be thorough"
✓  Read key files, then search for specifics
```

Reading every file wastes context on irrelevant code. The agent should be surgical.

### Don't Skip Exploration

```
❌ Immediately start editing based on assumptions
✓  At minimum, read the target file before editing (enforced by readFileState)
```

### Don't Explore Irrelevant Areas

```
User: "Fix the login button color"

❌ Read the database models, API routes, and deployment config
✓  GlobTool("*login*"), GlobTool("*button*"), then read the matches
```

Exploration should be guided by the task.

---

## The Full Exploration Flow

```
User sends task
       │
       ▼
┌──────────────┐
│ Is codebase   │──yes──→ Skip to Phase 4 (targeted search)
│ already known? │        (readFileState has entries)
└──────┬───────┘
       │ no
       ▼
┌──────────────┐
│ Phase 1:      │ GlobTool("*") → directory structure
│ Structure     │
└──────┬───────┘
       ▼
┌──────────────┐
│ Phase 2:      │ GlobTool("README*", "package.json", "CLAUDE.md")
│ Anchors       │
└──────┬───────┘
       ▼
┌──────────────┐
│ Phase 3:      │ Read key files (README, config, entry point)
│ Read          │
└──────┬───────┘
       ▼
┌──────────────┐
│ Phase 4:      │ GrepTool/GlobTool for task-specific patterns
│ Search        │
└──────┬───────┘
       ▼
┌──────────────┐
│ Phase 5:      │ LSPTool for definitions, references, types
│ Navigate      │ (if available)
└──────┬───────┘
       ▼
   Begin task execution
```

---

## Key Takeaways

1. **Five-phase exploration** (Structure → Anchors → Read → Search → Navigate) systematically builds understanding from zero context.

2. **CLAUDE.md discovery** provides project-specific agent instructions that feed into the system prompt.

3. **package.json / Cargo.toml / go.mod** are gold mines — they reveal language, framework, dependencies, build tools, and test runners.

4. **Exploration depth scales with task complexity** — a typo fix needs minimal exploration; an architecture refactor needs deep understanding.

5. **Anti-patterns**: don't read everything, don't skip exploration, don't explore areas irrelevant to the task.

6. **All tools work together**: Glob finds files by name, Grep searches contents, Read provides full context, LSP provides semantic understanding.

---

## Module 08 Summary

Over these six lessons, we've covered the complete search and navigation system:

- **GrepTool** (Lesson 73): Content search powered by ripgrep — regex, context lines, multiple output modes
- **GlobTool** (Lesson 74): File name search with pattern matching and smart defaults
- **Web tools** (Lesson 75): Internet search, URL fetching, and browser automation
- **Pagination** (Lesson 76): head_limit, offset, and the "has more" system
- **LSP** (Lesson 77): Semantic navigation — definitions, references, types, diagnostics
- **Exploration** (Lesson 78): The five-phase strategy for understanding new codebases

Together with Module 07's file operations, the agent now has a complete toolkit for finding, reading, understanding, and modifying code. In Module 09, we'll explore how **permissions and safety** govern when the agent is allowed to use these powerful capabilities.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Five Phases of Exploration
**Question:** List the five phases of the codebase exploration strategy. For each phase, name the primary tool used and explain what information it provides that the previous phase couldn't.

[View Answer](../../answers/08-search-and-navigation/answer-78.md#exercise-1)

### Exercise 2 — Infer Project Type
**Challenge:** Write an `inferProjectType` function that takes an array of file paths (from a GlobTool call) and returns a project type string like `"react"`, `"next.js"`, `"express"`, `"django"`, `"rust"`, or `"unknown"`. Use heuristics based on the presence of key files (`next.config.js`, `manage.py`, `Cargo.toml`, etc.).

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-78.md#exercise-2)

### Exercise 3 — Build Project Context from package.json
**Challenge:** Write a `buildProjectContext` function that takes a parsed `package.json` object and returns a structured summary including: project name, framework (React, Vue, Angular, etc.), test runner (Jest, Vitest, Mocha), build tool (Webpack, Vite, esbuild), and CSS solution (Tailwind, styled-components, etc.).

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-78.md#exercise-3)

### Exercise 4 — Exploration Cost Estimator
**Challenge:** Write an `estimateExplorationCost` function that takes a task description and returns an estimated number of tool calls and time. Categorize tasks as "minimal" (typo fix: ~2 calls), "moderate" (feature work: ~8 calls), or "deep" (architecture refactor: ~16 calls) based on keyword analysis.

Write your solution in your IDE first, then check:

[View Answer](../../answers/08-search-and-navigation/answer-78.md#exercise-4)
