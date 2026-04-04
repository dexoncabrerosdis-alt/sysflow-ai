# Answers: Lesson 53 — Project Memory (CLAUDE.md)

## Exercise 1
**Question:** Discovery hierarchy and priority order in a monorepo.

**Answer:** The discovery order from highest to lowest priority is: (1) **Package directory** (`/repo/packages/api/CLAUDE.md`) — project root, highest priority because it contains the most specific, directly relevant instructions for the code the user is currently working in. (2) **Repo root** (`/repo/CLAUDE.md`) — parent directory, contains monorepo-wide conventions like "use pnpm" or shared coding standards. (3) **Home directory** (`~/.CLAUDE.md`) — user-global preferences like "I prefer concise responses" or "Use American English." Project-root takes precedence because specificity matters: the API package might use Express + Prisma while the web package uses Next.js. General monorepo instructions apply to everything, but package-specific instructions override them when there's a conflict. All files are loaded and combined, giving the model layered context.

---

## Exercise 2
**Question:** Categorize each item as good or bad for CLAUDE.md.

**Answer:** (a) **API_KEY=sk-12345 → BAD.** Never put secrets in CLAUDE.md. It's a plain text file often committed to version control. The agent might also echo it in responses. (b) **"Use Vitest for all tests" → GOOD.** Concise, actionable instruction that prevents the model from guessing the test framework. (c) **5,000-word project history → BAD.** Wastes context window tokens. CLAUDE.md should be concise — key facts, not narratives. At ~1,250 tokens per 5,000 words, this consumes significant budget. (d) **"Never modify files in src/legacy/" → GOOD.** Clear boundary that prevents the agent from touching code it shouldn't. (e) **ESLint configuration JSON → BAD.** This is configuration for another tool, not instructions for the agent. It confuses the model and wastes tokens. The agent can read `.eslintrc.json` directly if needed. (f) **"Run pnpm db:migrate after schema changes" → GOOD.** Useful operational knowledge the agent needs to complete database-related tasks correctly.

---

## Exercise 3
**Challenge:** Write a `loadMemoryPrompt` function with discovery, filtering, and formatting.

**Answer:**
```typescript
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

interface ClaudeMdFile {
  path: string;
  content: string;
  source: string;
}

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function loadMemoryPrompt(projectRoot: string): Promise<string> {
  const files: ClaudeMdFile[] = [];

  const rootContent = await readFileSafe(path.join(projectRoot, "CLAUDE.md"));
  if (rootContent) {
    files.push({
      path: path.join(projectRoot, "CLAUDE.md"),
      content: rootContent,
      source: "Project Instructions",
    });
  }

  const homeContent = await readFileSafe(
    path.join(os.homedir(), "CLAUDE.md")
  );
  if (homeContent) {
    files.push({
      path: path.join(os.homedir(), "CLAUDE.md"),
      content: homeContent,
      source: "User Global Instructions",
    });
  }

  if (files.length === 0) return "";

  const maxTokens = 4000;
  const filtered: ClaudeMdFile[] = [];
  let totalTokens = 0;

  for (const file of files) {
    const tokens = estimateTokens(file.content);
    if (totalTokens + tokens > maxTokens) continue;
    filtered.push(file);
    totalTokens += tokens;
  }

  const sections = filtered.map(
    (f) => `### ${f.source} (${f.path})\n\n${f.content}`
  );

  return `## Project Memory\n\n${sections.join("\n\n---\n\n")}`;
}
```
**Explanation:** The function discovers CLAUDE.md in the project root (highest priority) and home directory. Files are filtered against a 4,000-token budget — project-root files are included first since they're most relevant. Each file gets a labeled header so the model knows where each instruction came from.

---

## Exercise 4
**Question:** Why is CLAUDE.md in the dynamic section rather than the static section?

**Answer:** CLAUDE.md is dynamic because the user can edit it at any time between turns. If it were treated as static: (1) **Changes wouldn't take effect** — A user who adds "Actually, we migrated to Jest" to CLAUDE.md between turns would still see the agent using Vitest, because the static content was cached on the first turn and not re-read. (2) **Cache would break unpredictably** — If CLAUDE.md were in the static section and the file changed, the static content would differ from the cached prefix, causing a cache miss. But unlike intentional dynamic sections, this cache break would be unexpected and could happen mid-session. By placing CLAUDE.md in the dynamic section, it's re-read on every turn (or on a short cache interval), ensuring the agent always has the latest instructions while the truly static sections maintain their cache.
