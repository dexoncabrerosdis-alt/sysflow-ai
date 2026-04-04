# Answers: Lesson 78 — Codebase Exploration

## Exercise 1
**Question:** List the five phases of the codebase exploration strategy and explain what each provides.

**Answer:** (1) **Structure** (GlobTool) — Lists the top-level directory to understand project layout, language, and high-level organization. Previous phases don't exist; this is the starting point. (2) **Anchors** (GlobTool) — Searches for disproportionately informative files like README.md, package.json, CLAUDE.md, and config files. The structure phase showed *what exists*; this phase identifies *what's worth reading*. (3) **Read** (Read tool) — Reads the anchor files discovered in Phase 2 to extract project purpose, dependencies, build commands, and conventions. Structure and anchors showed *names*; reading provides *content*. (4) **Search** (GrepTool/GlobTool) — Performs task-specific searches based on knowledge gained from reading. Previous phases gave broad understanding; search narrows to the specific code relevant to the user's request. (5) **Navigate** (LSPTool) — Uses semantic code intelligence for precise definition lookups, reference finding, and type information. Search found text matches; navigation provides *semantic understanding* like type signatures and aliased references.

---

## Exercise 2
**Challenge:** Write an `inferProjectType` function from file paths.

**Answer:**
```typescript
type ProjectType =
  | "next.js"
  | "react-vite"
  | "react-cra"
  | "vue"
  | "angular"
  | "svelte-kit"
  | "express"
  | "django"
  | "flask"
  | "fastapi"
  | "rust"
  | "go"
  | "unknown";

function inferProjectType(filePaths: string[]): ProjectType {
  const lower = filePaths.map((f) => f.toLowerCase().replace(/\\/g, "/"));
  const has = (needle: string) => lower.some((f) => f.includes(needle));
  const hasExact = (name: string) =>
    lower.some((f) => f.endsWith(`/${name}`) || f === name);

  if (hasExact("next.config.js") || hasExact("next.config.mjs") || hasExact("next.config.ts")) {
    return "next.js";
  }
  if (hasExact("angular.json")) return "angular";
  if (hasExact("svelte.config.js") || hasExact("svelte.config.ts")) return "svelte-kit";
  if (hasExact("nuxt.config.ts") || hasExact("nuxt.config.js")) return "vue";

  if (hasExact("vite.config.ts") || hasExact("vite.config.js")) {
    if (has(".tsx") || has(".jsx")) return "react-vite";
    if (has(".vue")) return "vue";
  }

  if (hasExact("manage.py")) return "django";
  if (has("fastapi") || (hasExact("main.py") && has("uvicorn"))) return "fastapi";
  if (has("flask")) return "flask";

  if (hasExact("cargo.toml")) return "rust";
  if (hasExact("go.mod")) return "go";

  if (hasExact("package.json")) {
    if (has(".tsx") || has(".jsx")) return "react-cra";
    return "express";
  }

  return "unknown";
}

// Tests
console.assert(
  inferProjectType(["next.config.mjs", "src/app/page.tsx", "package.json"]) === "next.js"
);
console.assert(
  inferProjectType(["vite.config.ts", "src/App.tsx", "package.json"]) === "react-vite"
);
console.assert(
  inferProjectType(["manage.py", "myapp/models.py", "requirements.txt"]) === "django"
);
console.assert(
  inferProjectType(["Cargo.toml", "src/main.rs"]) === "rust"
);
```
**Explanation:** The function uses priority-ordered heuristics: framework-specific config files (most specific) are checked first, then general patterns. The `hasExact` helper matches file names at the end of paths, avoiding false positives from directory names. Vite projects require a secondary check for `.tsx`/`.vue` files to distinguish React from Vue. The fallback chain ensures that even generic Node projects get classified rather than returning "unknown."

---

## Exercise 3
**Challenge:** Write a `buildProjectContext` function from package.json.

**Answer:**
```typescript
interface ProjectContext {
  name: string;
  framework: string;
  testRunner: string;
  buildTool: string;
  cssSolution: string;
  language: string;
}

function buildProjectContext(pkg: Record<string, any>): ProjectContext {
  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };
  const hasDep = (name: string) => name in allDeps;

  const framework = hasDep("next")
    ? "Next.js"
    : hasDep("@angular/core")
      ? "Angular"
      : hasDep("vue")
        ? "Vue"
        : hasDep("svelte")
          ? "Svelte"
          : hasDep("react")
            ? "React"
            : hasDep("express")
              ? "Express"
              : hasDep("fastify")
                ? "Fastify"
                : "Unknown";

  const testRunner = hasDep("vitest")
    ? "Vitest"
    : hasDep("jest")
      ? "Jest"
      : hasDep("mocha")
        ? "Mocha"
        : hasDep("ava")
          ? "Ava"
          : "None detected";

  const buildTool = hasDep("vite")
    ? "Vite"
    : hasDep("webpack")
      ? "Webpack"
      : hasDep("esbuild")
        ? "esbuild"
        : hasDep("rollup")
          ? "Rollup"
          : hasDep("turbo")
            ? "Turborepo"
            : "None detected";

  const cssSolution = hasDep("tailwindcss")
    ? "Tailwind CSS"
    : hasDep("styled-components")
      ? "styled-components"
      : hasDep("@emotion/react")
        ? "Emotion"
        : hasDep("sass")
          ? "Sass"
          : "CSS (plain)";

  const language = hasDep("typescript") ? "TypeScript" : "JavaScript";

  return {
    name: pkg.name || "unknown",
    framework,
    testRunner,
    buildTool,
    cssSolution,
    language,
  };
}

// Test
const ctx = buildProjectContext({
  name: "taskflow",
  dependencies: { react: "^18.2.0", "react-dom": "^18.2.0", zustand: "^4.4.0", tailwindcss: "^3.3.0" },
  devDependencies: { vitest: "^1.0.0", typescript: "^5.3.0", vite: "^5.0.0" },
});

console.assert(ctx.framework === "React");
console.assert(ctx.testRunner === "Vitest");
console.assert(ctx.buildTool === "Vite");
console.assert(ctx.cssSolution === "Tailwind CSS");
console.assert(ctx.language === "TypeScript");
```
**Explanation:** The function merges `dependencies` and `devDependencies` into a single lookup map, then uses priority-ordered checks for each category. Frameworks are checked most-specific-first (Next.js before React, since Next.js projects also have React as a dependency). The result gives the agent a concise project summary without reading any source code — just from the dependency manifest.

---

## Exercise 4
**Challenge:** Write an `estimateExplorationCost` function.

**Answer:**
```typescript
type ExplorationDepth = "minimal" | "moderate" | "deep";

interface ExplorationEstimate {
  depth: ExplorationDepth;
  estimatedToolCalls: number;
  estimatedTimeSeconds: number;
  phases: string[];
}

function estimateExplorationCost(taskDescription: string): ExplorationEstimate {
  const lower = taskDescription.toLowerCase();

  const deepKeywords = [
    "refactor", "restructure", "migrate", "architecture",
    "redesign", "rewrite", "overhaul", "modularize",
  ];
  const moderateKeywords = [
    "add", "implement", "create", "build", "feature",
    "integrate", "update", "extend", "enhance",
  ];
  const minimalKeywords = [
    "fix", "typo", "rename", "update", "change", "tweak",
    "comment", "lint", "format", "bump",
  ];

  const matchCount = (keywords: string[]) =>
    keywords.filter((kw) => lower.includes(kw)).length;

  const deepScore = matchCount(deepKeywords);
  const moderateScore = matchCount(moderateKeywords);
  const minimalScore = matchCount(minimalKeywords);

  if (deepScore > 0 || lower.includes("across") || lower.includes("entire")) {
    return {
      depth: "deep",
      estimatedToolCalls: 16,
      estimatedTimeSeconds: 8,
      phases: ["structure", "anchors", "read", "search", "navigate"],
    };
  }

  if (moderateScore > minimalScore) {
    return {
      depth: "moderate",
      estimatedToolCalls: 8,
      estimatedTimeSeconds: 4,
      phases: ["structure", "anchors", "read", "search"],
    };
  }

  return {
    depth: "minimal",
    estimatedToolCalls: 2,
    estimatedTimeSeconds: 1,
    phases: ["search", "read"],
  };
}

// Tests
const r1 = estimateExplorationCost("Fix the typo in README.md");
console.assert(r1.depth === "minimal");

const r2 = estimateExplorationCost("Add error handling to the API routes");
console.assert(r2.depth === "moderate");

const r3 = estimateExplorationCost("Refactor the entire authentication architecture");
console.assert(r3.depth === "deep");
```
**Explanation:** The estimator uses keyword matching to classify tasks into three tiers. Deep tasks involve structural changes that require understanding the full codebase. Moderate tasks are feature work that needs understanding of the relevant subsystem. Minimal tasks target a specific known location. The `phases` array shows which exploration phases are needed — minimal tasks skip the broad discovery phases entirely. Words like "across" and "entire" trigger deep exploration even without matching a specific keyword.
