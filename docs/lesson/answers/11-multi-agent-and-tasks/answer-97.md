# Answers: Lesson 97 — The Skill System

## Exercise 1
**Challenge:** Implement `getSkills()` with multi-source discovery and priority deduplication.

**Answer:**
```typescript
interface Skill {
  name: string;
  source: "project" | "user" | "plugin" | "builtin" | "discovered";
  priority: number;
  path: string;
}

interface SkillSource {
  type: Skill["source"];
  path: string;
  priority: number;
}

async function getSkills(
  fileSystem: {
    directoryExists: (path: string) => Promise<boolean>;
    readDirectory: (path: string) => Promise<{ name: string; isDirectory: boolean }[]>;
    fileExists: (path: string) => Promise<boolean>;
  },
  resolvePath: (p: string) => string
): Promise<Skill[]> {
  const sources: SkillSource[] = [
    { type: "project", path: ".cursor/skills", priority: 1 },
    { type: "project", path: ".claude/skills", priority: 1 },
    { type: "user", path: "~/.cursor/skills", priority: 2 },
    { type: "user", path: "~/.claude/skills", priority: 2 },
    { type: "builtin", path: "__builtin__/skills", priority: 4 },
  ];

  const skills: Skill[] = [];

  for (const source of sources) {
    const resolved = resolvePath(source.path);

    if (!(await fileSystem.directoryExists(resolved))) continue;

    const entries = await fileSystem.readDirectory(resolved);

    for (const entry of entries) {
      if (!entry.isDirectory) continue;

      const skillFile = `${resolved}/${entry.name}/SKILL.md`;
      if (await fileSystem.fileExists(skillFile)) {
        skills.push({
          name: entry.name,
          source: source.type,
          priority: source.priority,
          path: skillFile,
        });
      }
    }
  }

  // Sort by priority (lowest number = highest priority)
  skills.sort((a, b) => a.priority - b.priority);

  // Deduplicate by name — first occurrence wins (already sorted by priority)
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (seen.has(skill.name)) return false;
    seen.add(skill.name);
    return true;
  });
}

// Test
async function testGetSkills() {
  const mockFS = {
    dirs: new Set(["proj/.cursor/skills", "proj/.cursor/skills/commit", "home/.cursor/skills", "home/.cursor/skills/commit"]),
    files: new Set(["proj/.cursor/skills/commit/SKILL.md", "home/.cursor/skills/commit/SKILL.md"]),
    directoryExists: async (p: string) => mockFS.dirs.has(p),
    readDirectory: async (p: string) => {
      if (p === "proj/.cursor/skills") return [{ name: "commit", isDirectory: true }];
      if (p === "home/.cursor/skills") return [{ name: "commit", isDirectory: true }];
      return [];
    },
    fileExists: async (p: string) => mockFS.files.has(p),
  };

  const resolvePath = (p: string) => p.replace("~", "home").replace(/^\./, "proj");

  const skills = await getSkills(mockFS, resolvePath);

  console.assert(skills.length === 1, "Duplicate 'commit' should be deduplicated");
  console.assert(skills[0].source === "project", "Project-level should win");

  console.log("Skill loader tests passed.");
}
```

**Explanation:** Skills are collected from all source directories, sorted by priority (project > user > plugin > builtin), then deduplicated by name. The first occurrence wins, so a project-level `commit` skill overrides a user-level one with the same name.

---

## Exercise 2
**Challenge:** Implement `SlashCommandRouter`.

**Answer:**
```typescript
class SlashCommandRouter {
  private commands: Record<string, string> = {
    "/commit": "commit",
    "/test": "test",
    "/deploy": "deploy",
    "/review": "review",
  };

  route(input: string): {
    matched: boolean;
    skillName?: string;
    helpText?: string;
    suggestion?: string;
  } {
    const trimmed = input.trim();

    if (!trimmed.startsWith("/")) {
      return { matched: false };
    }

    const command = trimmed.split(/\s+/)[0].toLowerCase();

    if (command === "/help") {
      return {
        matched: true,
        helpText: this.generateHelp(),
      };
    }

    const skillName = this.commands[command];
    if (skillName) {
      return { matched: true, skillName };
    }

    // Unknown command — suggest closest match
    const suggestion = this.findClosestCommand(command);
    return {
      matched: false,
      suggestion: suggestion
        ? `Unknown command "${command}". Did you mean "${suggestion}"?`
        : `Unknown command "${command}". Type /help for available commands.`,
    };
  }

  registerCommand(command: string, skillName: string): void {
    this.commands[command.startsWith("/") ? command : `/${command}`] = skillName;
  }

  private generateHelp(): string {
    const lines = ["Available commands:"];
    for (const [cmd, skill] of Object.entries(this.commands)) {
      lines.push(`  ${cmd.padEnd(12)} → runs the "${skill}" skill`);
    }
    lines.push(`  /help        → shows this help message`);
    return lines.join("\n");
  }

  private findClosestCommand(input: string): string | null {
    const commands = Object.keys(this.commands);
    for (const cmd of commands) {
      if (cmd.startsWith(input) || input.startsWith(cmd)) return cmd;
    }
    // Simple Levenshtein-like: check if input is within 2 chars of any command
    for (const cmd of commands) {
      if (Math.abs(cmd.length - input.length) <= 2) {
        let diffs = 0;
        for (let i = 0; i < Math.min(cmd.length, input.length); i++) {
          if (cmd[i] !== input[i]) diffs++;
        }
        if (diffs <= 2) return cmd;
      }
    }
    return null;
  }
}
```

**Explanation:** The router matches `/command` prefixes to skill names, handles `/help` specially, and provides fuzzy suggestions for unknown commands. The `registerCommand()` method allows dynamic expansion from discovered skills or plugins.

---

## Exercise 3
**Challenge:** Implement dynamic skill discovery via `onFileAccess()`.

**Answer:**
```typescript
class DynamicSkillDiscovery {
  private discoveredPaths = new Set<string>();
  private discoveredSkills: Skill[] = [];

  async onFileAccess(
    filePath: string,
    fileExists: (path: string) => Promise<boolean>
  ): Promise<Skill | null> {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    const skillFile = `${dir}/SKILL.md`;

    if (this.discoveredPaths.has(skillFile)) return null;

    if (await fileExists(skillFile)) {
      const skillName = dir.substring(dir.lastIndexOf("/") + 1);
      const skill: Skill = {
        name: skillName,
        source: "discovered",
        priority: 0, // highest priority
        path: skillFile,
      };

      this.discoveredPaths.add(skillFile);
      this.discoveredSkills.push(skill);
      return skill;
    }

    // Also check parent directory
    const parentDir = dir.substring(0, dir.lastIndexOf("/"));
    const parentSkillFile = `${parentDir}/SKILL.md`;

    if (!this.discoveredPaths.has(parentSkillFile) && await fileExists(parentSkillFile)) {
      const skillName = parentDir.substring(parentDir.lastIndexOf("/") + 1);
      const skill: Skill = {
        name: skillName,
        source: "discovered",
        priority: 0,
        path: parentSkillFile,
      };

      this.discoveredPaths.add(parentSkillFile);
      this.discoveredSkills.push(skill);
      return skill;
    }

    return null;
  }

  getDiscoveredSkills(): Skill[] {
    return [...this.discoveredSkills];
  }
}

// Test
async function testDynamicDiscovery() {
  const discovery = new DynamicSkillDiscovery();
  const mockFiles = new Set(["src/database/SKILL.md"]);
  const fileExists = async (p: string) => mockFiles.has(p);

  const skill1 = await discovery.onFileAccess("src/database/connection.ts", fileExists);
  console.assert(skill1 !== null, "Should discover database SKILL.md");
  console.assert(skill1!.name === "database");
  console.assert(skill1!.priority === 0, "Discovered skills get highest priority");

  // Second access to same area should not re-discover
  const skill2 = await discovery.onFileAccess("src/database/pool.ts", fileExists);
  console.assert(skill2 === null, "Should not re-discover");

  console.assert(discovery.getDiscoveredSkills().length === 1);
  console.log("Dynamic discovery tests passed.");
}
```

**Explanation:** When the agent reads or writes a file, `onFileAccess` checks for a SKILL.md in the same directory and parent directory. Discovered skills get priority 0 (highest) because they're contextually adjacent to the work being done. The path set prevents rediscovery on subsequent file accesses in the same directory.

---

## Exercise 4
**Challenge:** Implement `resolveSkillModelOverride()` with front-matter parsing.

**Answer:**
```typescript
interface ParsedSkill {
  default: string;
  modelOverrides: Record<string, string>;
}

function parseSkillFile(content: string): ParsedSkill {
  const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!frontMatterMatch) {
    return { default: content, modelOverrides: {} };
  }

  const frontMatter = frontMatterMatch[1];
  const body = frontMatterMatch[2];
  const overrides: Record<string, string> = {};

  // Parse model overrides from front-matter
  const overrideBlocks = frontMatter.split(/\nmodel_override_/);
  for (const block of overrideBlocks.slice(1)) {
    const nameMatch = block.match(/^(\w+):\s*\|\n([\s\S]*?)(?=\nmodel_override_|$)/);
    if (nameMatch) {
      overrides[nameMatch[1]] = nameMatch[2].trim();
    }
  }

  return { default: body.trim(), modelOverrides: overrides };
}

function resolveSkillModelOverride(
  skill: ParsedSkill,
  currentModel: string
): string {
  for (const [modelPattern, content] of Object.entries(skill.modelOverrides)) {
    if (currentModel.toLowerCase().includes(modelPattern.toLowerCase())) {
      return content;
    }
  }
  return skill.default;
}

// Test
function testModelOverride() {
  const skillContent = `---
model_override_haiku: |
  Run tests. Report pass/fail.
model_override_opus: |
  Run the full test suite. For any failure, analyze the root cause,
  attempt an automatic fix, re-run the failing test, and report
  detailed results including code changes made.
---
# Test Skill

Run the project's test suite and report results.
Ensure all tests pass before committing.`;

  const parsed = parseSkillFile(skillContent);

  const haikuVersion = resolveSkillModelOverride(parsed, "claude-haiku-3-20250307");
  console.assert(haikuVersion.includes("Run tests. Report pass/fail"));

  const opusVersion = resolveSkillModelOverride(parsed, "claude-opus-4-20250514");
  console.assert(opusVersion.includes("root cause"));

  const sonnetVersion = resolveSkillModelOverride(parsed, "claude-sonnet-4-20250514");
  console.assert(sonnetVersion.includes("Run the project's test suite"), "Should fall back to default");

  console.log("Model override tests passed.");
}
```

**Explanation:** The front-matter parser extracts model-specific overrides keyed by model name fragments. The resolver does a substring match against the current model — `"haiku"` matches `"claude-haiku-3-20250307"`. This lets skill authors write concise instructions for fast models and detailed instructions for capable models without duplicating the full SKILL.md.

---

## Exercise 5
**Question:** Skills vs Tools — what's the fundamental difference?

**Answer:** Skills are **instructions** (markdown files the agent reads and follows using existing tools), while tools are **capabilities** (code with defined parameters, input validation, and execution logic that the model calls directly). Skills extend the agent's behavior without any code changes — anyone can write a SKILL.md and drop it in the skills directory. Tools require implementation, registration in the tool list, and redeployment. A "commit" workflow is best as a skill: it's a sequence of existing tool calls (run lint, run tests, format commit message, execute git commands) that varies by project. A "read_file" operation is best as a tool: it requires actual code to interact with the filesystem, handle errors, and return structured results. The rule of thumb: if the capability is a *sequence of existing operations with project-specific rules*, make it a skill. If it requires *new code to interact with systems*, make it a tool.
