# Lesson 53: Project Memory — CLAUDE.md

## The Problem: Agents Forget

Every conversation with an LLM starts from zero. The model doesn't remember that your project uses Prettier with tabs, that the `api/` folder is off-limits for refactoring, or that you prefer `const` over `let`. Without persistent memory, you repeat the same instructions every session.

Claude Code solves this with **CLAUDE.md** — a markdown file in your project that the agent reads on every session start and includes in the system prompt.

## What CLAUDE.md Looks Like

```markdown
# CLAUDE.md

## Project Overview
This is a Next.js 14 app with App Router. TypeScript strict mode.
PostgreSQL with Drizzle ORM. Tests use Vitest.

## Code Style
- Use `const` for all declarations unless reassignment is needed.
- Prefer named exports over default exports.
- Use `type` imports: `import type { Foo } from './types'`
- Error handling: always use custom error classes from `src/errors/`

## Architecture Rules
- API routes go in `src/app/api/[resource]/route.ts`
- Business logic goes in `src/services/`, NOT in route handlers
- Database queries go in `src/db/queries/`, NOT in services directly
- Never import from `src/db/` in React components

## Testing
- Every new feature needs tests in `__tests__/` adjacent to the source
- Use `createTestContext()` helper for database tests
- Run `pnpm test` to verify, `pnpm test:e2e` for E2E

## Common Gotchas
- The `auth` middleware runs before all API routes — check `src/middleware.ts`
- Drizzle migrations are in `drizzle/migrations/`, run with `pnpm db:migrate`
- Environment variables are validated in `src/env.ts` — add new ones there first
```

This file is plain markdown. No special syntax, no configuration language. The user writes natural language instructions, and the agent follows them.

## Discovery: Finding CLAUDE.md Files

Claude Code doesn't just look in the project root. It searches multiple locations:

```typescript
async function getClaudeMds(
  projectRoot: string
): Promise<ClaudeMdFile[]> {
  const files: ClaudeMdFile[] = [];

  // 1. Project root CLAUDE.md
  const rootPath = path.join(projectRoot, "CLAUDE.md");
  const rootContent = await readFileSafe(rootPath);
  if (rootContent) {
    files.push({
      path: rootPath,
      content: rootContent,
      source: "project-root",
    });
  }

  // 2. Parent directories (monorepo support)
  let dir = path.dirname(projectRoot);
  while (dir !== path.dirname(dir)) {
    const parentPath = path.join(dir, "CLAUDE.md");
    const parentContent = await readFileSafe(parentPath);
    if (parentContent) {
      files.push({
        path: parentPath,
        content: parentContent,
        source: "parent-directory",
      });
    }
    dir = path.dirname(dir);
  }

  // 3. Home directory (user-global instructions)
  const homePath = path.join(os.homedir(), "CLAUDE.md");
  const homeContent = await readFileSafe(homePath);
  if (homeContent) {
    files.push({
      path: homePath,
      content: homeContent,
      source: "home-directory",
    });
  }

  // 4. Additional configured directories
  const additionalDirs = getAdditionalMemoryDirs();
  for (const additionalDir of additionalDirs) {
    const additionalPath = path.join(additionalDir, "CLAUDE.md");
    const additionalContent = await readFileSafe(additionalPath);
    if (additionalContent) {
      files.push({
        path: additionalPath,
        content: additionalContent,
        source: "additional-directory",
      });
    }
  }

  return files;
}
```

The search order creates a **hierarchy**:

```
~/.CLAUDE.md                    → Global user preferences
/repo/CLAUDE.md                 → Monorepo-level instructions
/repo/packages/api/CLAUDE.md    → Package-specific instructions (project root)
```

All discovered files are combined, giving the model layered context.

## Loading and Filtering

Not all CLAUDE.md content should be injected. Files might be too large, contain sensitive data, or be irrelevant:

```typescript
interface ClaudeMdFile {
  path: string;
  content: string;
  source: string;
}

function filterInjectedMemoryFiles(
  files: ClaudeMdFile[],
  maxTokens: number
): ClaudeMdFile[] {
  const filtered: ClaudeMdFile[] = [];
  let totalTokens = 0;

  // Priority: project root > parent > home > additional
  const priorityOrder = [
    "project-root",
    "parent-directory",
    "home-directory",
    "additional-directory",
  ];

  const sorted = [...files].sort(
    (a, b) =>
      priorityOrder.indexOf(a.source) -
      priorityOrder.indexOf(b.source)
  );

  for (const file of sorted) {
    const tokens = estimateTokens(file.content);

    if (totalTokens + tokens > maxTokens) {
      console.warn(
        `Skipping ${file.path}: would exceed token budget ` +
        `(${totalTokens + tokens} > ${maxTokens})`
      );
      continue;
    }

    filtered.push(file);
    totalTokens += tokens;
  }

  return filtered;
}
```

The token budget prevents a massive CLAUDE.md from consuming the entire context window. Project-root files take priority because they're most relevant.

## Injection via loadMemoryPrompt()

The filtered CLAUDE.md content is injected into the system prompt through a dedicated function:

```typescript
async function loadMemoryPrompt(
  projectRoot: string
): Promise<string> {
  const files = await getClaudeMds(projectRoot);

  if (files.length === 0) return "";

  const filtered = filterInjectedMemoryFiles(files, 4000);

  const sections = filtered.map(file => {
    const label = getSourceLabel(file);
    return `### ${label}\n\n${file.content}`;
  });

  return `## Project Memory\n\n${sections.join("\n\n---\n\n")}`;
}

function getSourceLabel(file: ClaudeMdFile): string {
  switch (file.source) {
    case "project-root":
      return `Project Instructions (${file.path})`;
    case "parent-directory":
      return `Parent Project Instructions (${file.path})`;
    case "home-directory":
      return `User Global Instructions (${file.path})`;
    default:
      return `Additional Instructions (${file.path})`;
  }
}
```

The output in the system prompt looks like:

```
## Project Memory

### Project Instructions (/home/user/my-app/CLAUDE.md)

This is a Next.js 14 app with App Router. TypeScript strict mode.
...

---

### User Global Instructions (/home/user/CLAUDE.md)

I prefer concise code comments. Use American English spelling.
Always suggest running tests after changes.
```

## Caching CLAUDE.md for the Classifier

Claude Code's tool classifier (which decides if a tool call needs permission) also needs CLAUDE.md content. To avoid reading the file twice, the content is cached:

```typescript
let cachedClaudeMdContent: string | null = null;

function setCachedClaudeMdContent(content: string): void {
  cachedClaudeMdContent = content;
}

function getCachedClaudeMdContent(): string | null {
  return cachedClaudeMdContent;
}

// During prompt assembly:
async function loadAndCacheMemory(root: string): Promise<string> {
  const content = await loadMemoryPrompt(root);
  setCachedClaudeMdContent(content);
  return content;
}

// During tool classification:
function classifyToolCall(toolCall: ToolCall): PermissionLevel {
  const memory = getCachedClaudeMdContent();
  // Use memory content to check if the user has allowed
  // certain operations in CLAUDE.md
  return classify(toolCall, memory);
}
```

## CLAUDE.md Best Practices

### What to Include

```markdown
# Good CLAUDE.md content

## Tech Stack
- Framework, language, versions
- Database, ORM, migrations
- Testing framework and patterns

## Code Conventions
- Naming: camelCase for variables, PascalCase for components
- Import ordering rules
- Error handling patterns

## Architecture
- Directory structure and purpose of each folder
- Where new code should go
- Boundaries between layers

## Commands
- How to run tests, build, lint, deploy
- Common development workflows

## Gotchas
- Known quirks, workarounds, legacy decisions
- Things that look wrong but are intentional
```

### What NOT to Include

```markdown
# Bad CLAUDE.md content

## Secrets (NEVER do this)
API_KEY=sk-1234567890
DATABASE_URL=postgres://admin:password@prod-db:5432

## Extremely verbose documentation (wastes context window)
[5,000 words about the history of the project]

## Contradictory instructions
Always use semicolons.
Never use semicolons.

## Instructions for other tools (confuses the model)
VSCode settings: { "editor.tabSize": 2 }
ESLint config goes in .eslintrc.json...
```

## Monorepo Support

In monorepos, different packages may have different conventions:

```
/monorepo/
  CLAUDE.md                  → "This is a pnpm monorepo"
  packages/
    api/
      CLAUDE.md              → "Express + Prisma. Run tests with pnpm test"
    web/
      CLAUDE.md              → "Next.js App Router. Use server components by default"
    shared/
      CLAUDE.md              → "Pure TypeScript. No framework deps. 100% test coverage required"
```

When the user opens the agent in `/monorepo/packages/api/`, the discovery function finds:

1. `/monorepo/packages/api/CLAUDE.md` (project root)
2. `/monorepo/CLAUDE.md` (parent directory)

Both are loaded, giving the model package-specific context plus monorepo-wide context.

## Dynamic Memory: How CLAUDE.md Changes

Unlike static prompt sections, CLAUDE.md is dynamic because the user can edit it at any time:

```typescript
// Turn 1: User starts session
// CLAUDE.md says: "Use Vitest for testing"
// Agent runs: vitest run

// User edits CLAUDE.md between turns, adds:
// "Actually, we migrated to Jest. Use Jest for all tests."

// Turn 5: User says "add tests"
// Agent re-reads CLAUDE.md, sees the update
// Agent runs: jest
```

This is why CLAUDE.md is in the **dynamic** section of the system prompt — it's reloaded on every turn (or at least on a short cache interval).

## Watching for CLAUDE.md Changes

Some implementations watch the file for changes to provide immediate feedback:

```typescript
import { watch } from "fs";

function watchClaudeMd(projectRoot: string): void {
  const claudeMdPath = path.join(projectRoot, "CLAUDE.md");

  watch(claudeMdPath, (eventType) => {
    if (eventType === "change") {
      cachedClaudeMdContent = null;
      console.log("CLAUDE.md changed — will reload on next turn");
    }
  });
}
```

## Building Your Own Memory System

If you're building a coding agent, here's a minimal memory system:

```typescript
interface MemoryConfig {
  projectRoot: string;
  maxTokens: number;
  fileName: string;
}

class ProjectMemory {
  private config: MemoryConfig;
  private cache: string | null = null;

  constructor(config: MemoryConfig) {
    this.config = config;
  }

  async load(): Promise<string> {
    const memoryPath = path.join(
      this.config.projectRoot,
      this.config.fileName
    );

    try {
      const content = await fs.readFile(memoryPath, "utf-8");
      const tokens = estimateTokens(content);

      if (tokens > this.config.maxTokens) {
        console.warn(
          `Memory file exceeds budget: ${tokens} > ${this.config.maxTokens}`
        );
        return content.slice(0, this.config.maxTokens * 4);
      }

      this.cache = content;
      return content;
    } catch {
      return "";
    }
  }

  getForSystemPrompt(): string {
    if (!this.cache) return "";
    return `## Project Instructions\n\n${this.cache}`;
  }
}
```

## What's Next

CLAUDE.md gives users control over agent behavior. But the agent also needs to control its own output. Lesson 54 covers the **output style and efficiency sections** — how the system prompt shapes the model's verbosity, formatting, and communication style.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — CLAUDE.md Discovery Hierarchy
**Question:** In a monorepo at `/repo/packages/api/`, the agent discovers CLAUDE.md files in three locations: the package directory, the repo root, and the home directory. In what priority order are they loaded, and why does project-root take precedence over parent directories?

[View Answer](../../answers/05-prompt-engineering/answer-53.md#exercise-1)

### Exercise 2 — What to Include vs. Exclude
**Question:** Categorize each of the following as "good for CLAUDE.md" or "bad for CLAUDE.md" and explain why: (a) API_KEY=sk-12345, (b) "Use Vitest for all tests", (c) a 5,000-word history of the project, (d) "Never modify files in src/legacy/", (e) ESLint configuration JSON, (f) "Run pnpm db:migrate after schema changes".

[View Answer](../../answers/05-prompt-engineering/answer-53.md#exercise-2)

### Exercise 3 — Build a Memory Loader
**Challenge:** Write a function `loadMemoryPrompt(projectRoot: string): Promise<string>` that discovers CLAUDE.md files in the project root and home directory, filters them by a token budget (max 4,000 tokens estimated), and assembles them into a formatted "## Project Memory" section with source labels.

Write your solution in your IDE first, then check:

[View Answer](../../answers/05-prompt-engineering/answer-53.md#exercise-3)

### Exercise 4 — Dynamic Memory and Caching
**Question:** Why is CLAUDE.md content placed in the dynamic section of the system prompt rather than the static section? What would happen if CLAUDE.md were treated as static content?

[View Answer](../../answers/05-prompt-engineering/answer-53.md#exercise-4)
