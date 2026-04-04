# Lesson 97 — The Skill System: Extending the Agent Without Changing Core Code

An agent's capabilities are defined by its tools and system prompt. Adding a new
capability — say, a standardized commit workflow — traditionally means writing
a new tool, updating the prompt, and redeploying. The skill system provides a
lighter-weight alternative: **discoverable, user-defined patterns** that the
agent can find and follow at runtime.

## What Is a Skill?

A skill is a markdown file (typically `SKILL.md`) that contains instructions
the agent can read and follow. Skills live in known directories, plugins, or
built-in locations. The agent discovers them, reads them using its normal file
tools, and follows the instructions as if a user had given them.

```
project/
├── .cursor/
│   └── skills/
│       ├── commit/
│       │   └── SKILL.md        ← "How to make good commits in this project"
│       ├── deploy/
│       │   └── SKILL.md        ← "How to deploy this project"
│       └── test/
│           └── SKILL.md        ← "How to run and write tests"
├── src/
└── package.json
```

A skill file might look like:

```markdown
# Commit Skill

When making commits in this project, follow these rules:

1. Run `npm run lint` before committing
2. Run `npm test` to ensure tests pass
3. Use conventional commit format: `type(scope): message`
   - Types: feat, fix, docs, style, refactor, test, chore
4. Keep commits atomic — one logical change per commit
5. Never commit directly to main; create a feature branch
6. After committing, run `npm run build` to verify the build

## Commit Message Examples

- `feat(auth): add JWT refresh token rotation`
- `fix(api): handle null response from payment gateway`
- `refactor(db): extract connection pooling into separate module`
```

This is not code the agent executes. It is *instructions* the agent reads and
follows using its existing tools (shell, file write, etc.).

## SkillTool: Discovery and Execution

The `SkillTool` is the interface between the agent and available skills:

```typescript
const SkillTool = {
  name: "skill",
  description:
    "Discover and execute a skill. Skills are reusable workflows " +
    "and patterns defined in SKILL.md files. Use this to find " +
    "established patterns for common tasks like committing, " +
    "deploying, testing, etc.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "read", "execute"],
        description: "What to do with the skill",
      },
      skillName: {
        type: "string",
        description: "Name of the skill (for read/execute)",
      },
    },
    required: ["action"],
  },
};
```

When the agent needs to commit code and a commit skill exists, it calls:

```typescript
{ name: "skill", params: { action: "read", skillName: "commit" } }
```

The tool reads the SKILL.md file and returns its contents. The agent then
follows the instructions using its normal tools.

## getSkills(): Loading From Multiple Sources

Skills come from multiple locations, with a priority order:

```typescript
interface SkillSource {
  type: "project" | "user" | "plugin" | "builtin";
  path: string;
  priority: number;
}

async function getSkills(): Promise<Skill[]> {
  const sources: SkillSource[] = [
    // Project-local skills (highest priority)
    { type: "project", path: ".cursor/skills", priority: 1 },
    { type: "project", path: ".claude/skills", priority: 1 },

    // User-level skills
    { type: "user", path: "~/.cursor/skills", priority: 2 },
    { type: "user", path: "~/.claude/skills", priority: 2 },

    // Plugin-provided skills
    ...getPluginSkillPaths().map((p) => ({
      type: "plugin" as const,
      path: p,
      priority: 3,
    })),

    // Built-in skills (lowest priority)
    { type: "builtin", path: BUILTIN_SKILLS_DIR, priority: 4 },
  ];

  const skills: Skill[] = [];

  for (const source of sources) {
    const resolved = resolvePath(source.path);
    if (await directoryExists(resolved)) {
      const entries = await readDirectory(resolved);
      for (const entry of entries) {
        if (entry.isDirectory) {
          const skillFile = path.join(resolved, entry.name, "SKILL.md");
          if (await fileExists(skillFile)) {
            skills.push({
              name: entry.name,
              source: source.type,
              priority: source.priority,
              path: skillFile,
            });
          }
        }
      }
    }
  }

  // Sort by priority (project skills override user skills, etc.)
  skills.sort((a, b) => a.priority - b.priority);

  // Deduplicate by name (first occurrence wins due to sort)
  return deduplicateByName(skills);
}
```

Project-level skills override user-level skills, which override plugin skills,
which override built-ins. This lets teams enforce project-specific workflows
while individuals maintain personal preferences as fallbacks.

## Skill Commands: Slash-Command Shortcuts

Some skills map to slash commands for quick invocation:

```typescript
const SKILL_COMMANDS: Record<string, string> = {
  "/commit": "commit",
  "/verify": "verify",
  "/deploy": "deploy",
  "/test": "test",
  "/review": "review",
};

function handleSlashCommand(input: string): ToolCall | null {
  const command = input.trim().split(" ")[0];
  const skillName = SKILL_COMMANDS[command];

  if (skillName) {
    return {
      name: "skill",
      params: { action: "execute", skillName },
    };
  }

  return null;
}
```

When the user types `/commit`, the agent reads and follows the commit skill
without needing to discover it through the normal tool-selection process.

## Dynamic Skill Discovery During File Operations

The agent does not only discover skills when explicitly asked. It can detect
relevant skills while performing file operations:

```typescript
async function onFileAccess(filePath: string, skills: Skill[]): Promise<void> {
  const dir = path.dirname(filePath);
  const nearbySkillFile = path.join(dir, "SKILL.md");

  if (await fileExists(nearbySkillFile)) {
    const skill = await readSkillFile(nearbySkillFile);
    if (!skills.some((s) => s.path === nearbySkillFile)) {
      skills.push({
        name: path.basename(dir),
        source: "discovered",
        priority: 0,   // highest — it's right next to the file being edited
        path: nearbySkillFile,
      });
    }
  }
}
```

If the agent edits a file in `src/database/` and there is a
`src/database/SKILL.md` explaining the database conventions, the agent
discovers and reads it automatically. This is how skills integrate with the
agent's normal workflow without requiring explicit invocation.

## startSkillDiscoveryPrefetch: Proactive Loading

Waiting until the agent needs a skill adds latency. `startSkillDiscoveryPrefetch`
scans for skills at startup in a fire-and-forget promise, caching results so that
later `list` calls are instant:

```typescript
async function startSkillDiscoveryPrefetch(cwd: string): Promise<void> {
  const prefetchPromise = getSkills().then((skills) => {
    skillCache.set(cwd, skills);
    return skills;
  });

  prefetchPromise.catch((err) => {
    console.warn("Skill prefetch failed:", err.message);
  });
}
```

## resolveSkillModelOverride: Model-Specific Behavior

Some skills behave differently depending on the model. A skill might have
simpler instructions for a fast model and more nuanced ones for a capable
model:

```typescript
interface SkillContent {
  default: string;
  modelOverrides?: Record<string, string>;
}

function resolveSkillModelOverride(
  skill: SkillContent,
  currentModel: string
): string {
  // Check for model-specific override
  if (skill.modelOverrides) {
    for (const [modelPattern, content] of Object.entries(skill.modelOverrides)) {
      if (currentModel.includes(modelPattern)) {
        return content;
      }
    }
  }

  return skill.default;
}
```

A SKILL.md might use front-matter to provide a terse haiku override ("Run tests,
report pass/fail") alongside a detailed opus override that includes root cause
analysis and automatic fix attempts.

## How Skills Extend Without Core Changes

Instead of writing tool code, updating the system prompt, and redeploying, you
write a markdown file and place it in the skills directory. Any team member can
create skills — no developer access required, no deployment needed, and skills
are per-project rather than global. A team lead enforces a review checklist, a
developer adds a personal commit style, an organization distributes skills via
plugins — all without touching the agent's source code.

## What You Have Learned

- Skills are markdown instruction files (`SKILL.md`) the agent reads and follows
- `getSkills()` loads skills from project, user, plugin, and built-in sources
  with a priority ordering
- Slash commands (like `/commit`) provide shortcuts to common skills
- Skills are discovered dynamically when the agent accesses files near a SKILL.md
- `startSkillDiscoveryPrefetch` pre-loads skills at startup to avoid latency
- `resolveSkillModelOverride` allows model-specific skill behavior
- Skills extend agent capabilities without code changes or redeployment

---

*Next lesson: background processing — work that happens while the user waits.*

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Skill Loader
**Challenge:** Implement `getSkills()` that discovers SKILL.md files from four source directories (project, user, plugin, builtin) with priority ordering. Project-level skills should override user-level skills with the same name. Return a deduplicated, priority-sorted array of skill objects. Test with a mock filesystem.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-97.md#exercise-1)

### Exercise 2 — Slash Command Router
**Challenge:** Implement a `SlashCommandRouter` that maps user input starting with `/` to skill invocations. Support: `/commit`, `/test`, `/deploy`, `/review`, and a `/help` command that lists all available slash commands. Handle unknown commands gracefully with suggestions.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-97.md#exercise-2)

### Exercise 3 — Dynamic Skill Discovery
**Challenge:** Implement `onFileAccess()` that checks for SKILL.md files near accessed files and registers them as discovered skills with highest priority. Include deduplication (don't re-register the same skill path twice) and a `getDiscoveredSkills()` method that returns all dynamically found skills during the session.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-97.md#exercise-3)

### Exercise 4 — Model Override Resolution
**Challenge:** Implement `resolveSkillModelOverride()` that selects model-specific skill content. A SKILL.md can include front-matter with model overrides (e.g., a terse version for Haiku, a detailed version for Opus). Parse the front-matter, match against the current model string, and return the appropriate content. Fall back to the default content if no match.

Write your solution in your IDE first, then check:

[View Answer](../../answers/11-multi-agent-and-tasks/answer-97.md#exercise-4)

### Exercise 5 — Skill vs Tool
**Question:** Skills and tools both extend the agent's capabilities. Explain in 4-5 sentences: what makes skills fundamentally different from tools? When should a capability be implemented as a skill (SKILL.md) versus a tool (code with parameters and execution logic)? Give one example of each.

[View Answer](../../answers/11-multi-agent-and-tasks/answer-97.md#exercise-5)
