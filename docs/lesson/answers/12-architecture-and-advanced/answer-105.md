# Answers: Lesson 105 — Configuration and Schemas

## Exercise 1
**Question:** List the five configuration sources in Claude Code from lowest to highest priority. Why do CLI flags override everything else? Give a concrete scenario where this priority order prevents a problem.

**Answer:** From lowest to highest priority: (1) **Schema defaults** — hardcoded sensible fallbacks, (2) **User config** (`~/.claude/settings.json`) — personal preferences, (3) **Project config** (`.claude/config.json`) — team/repository settings, (4) **Environment variables** (`CLAUDE_CODE_*`) — session/deployment overrides, (5) **CLI flags** (`--model`, `--max-turns`) — immediate, explicit overrides. CLI flags are highest because they represent the user's explicit, immediate intent for this specific invocation. A concrete scenario: a project config sets `model: "claude-haiku-4-20250514"` for cost savings, but a developer debugging a complex issue types `claude --model claude-opus-4-20250514 "debug this memory leak"`. The CLI flag overrides the project config for this single run. Without this priority order, the developer couldn't override the team setting without editing the project config file (which might be committed to git), or the team config couldn't override the user's personal preference for a specific project.

---

## Exercise 2
**Challenge:** Build a complete Zod configuration schema with validation and type inference.

**Answer:**

```typescript
import { z } from "zod";

const AgentConfigSchema = z.object({
  model: z.object({
    name: z.string().default("claude-sonnet-4-20250514"),
    maxTokens: z.number().int().positive().max(200000).default(16384),
    temperature: z.number().min(0).max(1).default(0),
  }).default({}),

  permissions: z.object({
    autoApprove: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    defaultBehavior: z.enum(["ask", "deny", "allow"]).default("ask"),
  }).default({}),

  tools: z.object({
    disabled: z.array(z.string()).default([]),
    bash: z.object({
      timeout: z.number().positive().default(120000),
      allowedCommands: z.array(z.string()).optional(),
      blockedCommands: z.array(z.string()).default(["rm -rf /"]),
    }).default({}),
  }).default({}),

  ui: z.object({
    theme: z.enum(["dark", "light", "auto"]).default("auto"),
    verbose: z.boolean().default(false),
    markdownRenderer: z.enum(["rich", "plain"]).default("rich"),
  }).default({}),
});

type AgentConfig = z.infer<typeof AgentConfigSchema>;

function validateConfig(raw: unknown): {
  success: boolean;
  config?: AgentConfig;
  errors?: string[];
} {
  const result = AgentConfigSchema.safeParse(raw);

  if (result.success) {
    return { success: true, config: result.data };
  }

  const errors = result.error.issues.map(issue => {
    const path = issue.path.join(".");
    switch (issue.code) {
      case "invalid_type":
        return `${path}: expected ${issue.expected}, got ${issue.received}`;
      case "invalid_enum_value":
        return `${path}: must be one of [${(issue as any).options?.join(", ")}], got "${issue.received}"`;
      case "too_small":
        return `${path}: value is too small (minimum: ${(issue as any).minimum})`;
      case "too_big":
        return `${path}: value is too large (maximum: ${(issue as any).maximum})`;
      default:
        return `${path}: ${issue.message}`;
    }
  });

  return { success: false, errors };
}

// Test
const result = validateConfig({
  model: { maxTokens: -5, temperature: 2.5 },
  permissions: { defaultBehavior: "yolo" },
});

if (!result.success) {
  console.log("Validation errors:");
  result.errors?.forEach(e => console.log(`  ${e}`));
  // Output:
  //   model.maxTokens: value is too small (minimum: 1)
  //   model.temperature: value is too large (maximum: 1)
  //   permissions.defaultBehavior: must be one of [ask, deny, allow], got "yolo"
}
```

**Explanation:** The Zod schema defines the complete configuration structure with defaults on every field, ensuring `AgentConfigSchema.parse({})` returns a fully-populated config. `z.infer` extracts the TypeScript type automatically. The `validateConfig` function uses `safeParse` to avoid throwing and maps Zod's `ZodIssue` objects to human-readable strings that include the field path and a clear description of the problem. The error messages are specific to the issue code (type mismatch, enum violation, range violation) rather than generic.

---

## Exercise 3
**Challenge:** Implement an environment variable parser with type coercion.

**Answer:**

```typescript
interface EnvMapping {
  envVar: string;
  configPath: string;
  type: "string" | "number" | "boolean" | "array";
}

const ENV_MAPPINGS: EnvMapping[] = [
  { envVar: "AGENT_MODEL", configPath: "model.name", type: "string" },
  { envVar: "AGENT_MAX_TOKENS", configPath: "model.maxTokens", type: "number" },
  { envVar: "AGENT_TEMPERATURE", configPath: "model.temperature", type: "number" },
  { envVar: "AGENT_PERMISSION_DEFAULT", configPath: "permissions.defaultBehavior", type: "string" },
  { envVar: "AGENT_AUTO_APPROVE", configPath: "permissions.autoApprove", type: "array" },
  { envVar: "AGENT_DENY_TOOLS", configPath: "permissions.deny", type: "array" },
  { envVar: "AGENT_VERBOSE", configPath: "ui.verbose", type: "boolean" },
  { envVar: "AGENT_THEME", configPath: "ui.theme", type: "string" },
  { envVar: "AGENT_BASH_TIMEOUT", configPath: "tools.bash.timeout", type: "number" },
  { envVar: "AGENT_DISABLED_TOOLS", configPath: "tools.disabled", type: "array" },
];

function coerceValue(
  value: string,
  type: EnvMapping["type"],
  envVar: string
): unknown | undefined {
  switch (type) {
    case "string":
      return value;

    case "number": {
      const num = Number(value);
      if (isNaN(num)) {
        console.warn(`Warning: ${envVar}="${value}" is not a valid number, ignoring`);
        return undefined;
      }
      return num;
    }

    case "boolean":
      return value === "true" || value === "1";

    case "array":
      return value
        .split(",")
        .map(s => s.trim())
        .filter(s => s.length > 0);

    default:
      return value;
  }
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
}

function parseEnvConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  for (const mapping of ENV_MAPPINGS) {
    const rawValue = process.env[mapping.envVar];
    if (rawValue === undefined) continue;

    const coerced = coerceValue(rawValue, mapping.type, mapping.envVar);
    if (coerced === undefined) continue;

    setNestedValue(config, mapping.configPath, coerced);
  }

  return config;
}

// Usage
// AGENT_MODEL=claude-opus-4-20250514 AGENT_MAX_TOKENS=32768 AGENT_VERBOSE=true agent
const envConfig = parseEnvConfig();
// Result: { model: { name: "claude-opus-4-20250514", maxTokens: 32768 }, ui: { verbose: true } }
```

**Explanation:** The mapping array defines the relationship between environment variable names and config paths, plus the expected type. `coerceValue` converts the raw string to the appropriate type, with graceful error handling — an invalid number logs a warning and returns `undefined` instead of crashing. `setNestedValue` builds the nested object structure from a dot-separated path. The function only includes values that are actually set in the environment, producing a sparse partial config suitable for merging.

---

## Exercise 4
**Challenge:** Implement a versioned config migration system with tests.

**Answer:**

```typescript
interface Migration {
  version: number;
  description: string;
  migrate: (config: Record<string, unknown>) => Record<string, unknown>;
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description: "Rename 'modelName' to 'model.name'",
    migrate: (config) => {
      if ("modelName" in config) {
        const { modelName, ...rest } = config;
        return {
          ...rest,
          model: {
            ...(rest.model as Record<string, unknown> ?? {}),
            name: modelName,
          },
        };
      }
      return config;
    },
  },
  {
    version: 3,
    description: "Convert 'autoApproveTools' string to 'permissions.autoApprove' array",
    migrate: (config) => {
      if ("autoApproveTools" in config) {
        const { autoApproveTools, ...rest } = config;
        const tools = typeof autoApproveTools === "string"
          ? autoApproveTools.split(",").map(s => (s as string).trim())
          : autoApproveTools;
        return {
          ...rest,
          permissions: {
            ...(rest.permissions as Record<string, unknown> ?? {}),
            autoApprove: tools,
          },
        };
      }
      return config;
    },
  },
  {
    version: 4,
    description: "Move 'bashTimeout' into 'tools.bash.timeout'",
    migrate: (config) => {
      if ("bashTimeout" in config) {
        const { bashTimeout, ...rest } = config;
        return {
          ...rest,
          tools: {
            ...(rest.tools as Record<string, unknown> ?? {}),
            bash: {
              ...((rest.tools as Record<string, unknown>)?.bash as Record<string, unknown> ?? {}),
              timeout: bashTimeout,
            },
          },
        };
      }
      return config;
    },
  },
];

function applyMigrations(
  config: Record<string, unknown>,
  targetVersion: number
): Record<string, unknown> {
  let migrated = { ...config };
  const configVersion = (config._version as number) ?? 1;

  const applicableMigrations = MIGRATIONS
    .filter(m => m.version > configVersion && m.version <= targetVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of applicableMigrations) {
    console.log(`Applying migration v${migration.version}: ${migration.description}`);
    migrated = migration.migrate(migrated);
  }

  migrated._version = targetVersion;
  return migrated;
}

// Tests
function testMigrations() {
  // V1 config with all old-style fields
  const v1Config: Record<string, unknown> = {
    _version: 1,
    modelName: "claude-sonnet-4-20250514",
    autoApproveTools: "Read,Write,Bash",
    bashTimeout: 60000,
    theme: "dark",
  };

  // Migrate v1 → v4 through all steps
  const v4Config = applyMigrations(v1Config, 4);

  console.assert(v4Config._version === 4, "Version updated to 4");
  console.assert(!("modelName" in v4Config), "modelName removed");
  console.assert(
    (v4Config.model as any)?.name === "claude-sonnet-4-20250514",
    "model.name set"
  );
  console.assert(!("autoApproveTools" in v4Config), "autoApproveTools removed");
  console.assert(
    Array.isArray((v4Config.permissions as any)?.autoApprove),
    "permissions.autoApprove is array"
  );
  console.assert(
    (v4Config.permissions as any)?.autoApprove?.length === 3,
    "3 auto-approve tools"
  );
  console.assert(!("bashTimeout" in v4Config), "bashTimeout removed");
  console.assert(
    (v4Config.tools as any)?.bash?.timeout === 60000,
    "tools.bash.timeout set"
  );
  console.assert(v4Config.theme === "dark", "Unrelated fields preserved");

  // V3 config should only apply migration v4
  const v3Config: Record<string, unknown> = {
    _version: 3,
    model: { name: "claude-sonnet-4-20250514" },
    bashTimeout: 90000,
  };
  const v3To4 = applyMigrations(v3Config, 4);
  console.assert(
    (v3To4.tools as any)?.bash?.timeout === 90000,
    "v3→v4 migration applied"
  );
  console.assert(v3To4._version === 4, "Version updated");

  console.log("All migration tests passed");
}

testMigrations();
```

**Explanation:** Each migration is a pure function that transforms the config shape. `applyMigrations` filters to only the migrations between the current version and the target, sorts them, and applies them sequentially. Each migration destructures the old field out and reconstructs the config with the new shape, preserving unrelated fields via spread. The tests verify the full v1→v4 path (applying all 3 migrations) and a partial v3→v4 path (applying only 1 migration), ensuring migrations are additive and composable.

---

## Exercise 5
**Challenge:** Implement `deepMerge` with config-specific semantics and full 5-source merge test.

**Answer:**

```typescript
function deepMerge<T extends Record<string, unknown>>(
  ...sources: Partial<T>[]
): T {
  const result: Record<string, unknown> = {};

  for (const source of sources) {
    if (!source) continue;

    for (const [key, value] of Object.entries(source)) {
      // Skip undefined — don't override with nothing
      if (value === undefined) continue;

      // null means explicit deletion
      if (value === null) {
        delete result[key];
        continue;
      }

      // Arrays replace entirely
      if (Array.isArray(value)) {
        result[key] = [...value];
        continue;
      }

      // Sets and Maps replace entirely
      if (value instanceof Set || value instanceof Map) {
        result[key] = value;
        continue;
      }

      // Plain objects merge recursively
      if (typeof value === "object") {
        const existing = result[key];
        if (existing && typeof existing === "object" && !Array.isArray(existing)) {
          result[key] = deepMerge(
            existing as Record<string, unknown>,
            value as Record<string, unknown>
          );
        } else {
          result[key] = deepMerge({}, value as Record<string, unknown>);
        }
        continue;
      }

      // Primitives override
      result[key] = value;
    }
  }

  return result as T;
}

// Tests
function testDeepMerge() {
  // Test nested object merge
  const a = { model: { name: "sonnet", maxTokens: 8000 } };
  const b = { model: { maxTokens: 16384 } };
  const merged = deepMerge(a, b);
  console.assert((merged.model as any).name === "sonnet", "Nested: keeps name");
  console.assert((merged.model as any).maxTokens === 16384, "Nested: overrides maxTokens");

  // Test array replacement (not concatenation)
  const c = { tools: ["Read", "Write"] };
  const d = { tools: ["Bash"] };
  const merged2 = deepMerge(c, d);
  console.assert((merged2.tools as string[]).length === 1, "Array replaces");
  console.assert((merged2.tools as string[])[0] === "Bash", "Array has new value");

  // Test null deletion
  const e = { model: "sonnet", theme: "dark" };
  const f = { theme: null };
  const merged3 = deepMerge(e, f as any);
  console.assert(merged3.model === "sonnet", "Null: keeps other keys");
  console.assert(!("theme" in merged3), "Null: deletes key");

  // Test undefined skip
  const g = { model: "sonnet", verbose: true };
  const h = { model: undefined, verbose: false };
  const merged4 = deepMerge(g, h);
  console.assert(merged4.model === "sonnet", "Undefined: keeps original");
  console.assert(merged4.verbose === false, "Undefined: other values apply");

  // Full 5-source merge simulation
  const defaults = { model: { name: "haiku", maxTokens: 4096 }, ui: { theme: "auto" }, verbose: false };
  const userConfig = { model: { name: "sonnet" }, ui: { theme: "dark" } };
  const projectConfig = { model: { maxTokens: 16384 }, tools: ["Read", "Bash"] };
  const envConfig = { verbose: true };
  const cliFlags = { model: { name: "opus" } };

  const final = deepMerge(defaults, userConfig, projectConfig, envConfig, cliFlags);
  console.assert((final.model as any).name === "opus", "CLI wins for model.name");
  console.assert((final.model as any).maxTokens === 16384, "Project wins for maxTokens");
  console.assert((final.ui as any).theme === "dark", "User wins for theme");
  console.assert(final.verbose === true, "Env wins for verbose");
  console.assert((final.tools as string[]).length === 2, "Project sets tools");

  console.log("All deepMerge tests passed");
}

testDeepMerge();
```

**Explanation:** The merge function handles five value types differently: `undefined` is skipped (doesn't override), `null` explicitly deletes a key, arrays replace entirely (config semantics — you want to replace an allow-list, not append to it), Sets/Maps replace entirely, and plain objects recurse. The 5-source test demonstrates the full priority chain: CLI flag `opus` overrides user config `sonnet` which overrides default `haiku` for the model name, while project config's `maxTokens: 16384` overrides the default `4096` because no higher-priority source specifies it.
