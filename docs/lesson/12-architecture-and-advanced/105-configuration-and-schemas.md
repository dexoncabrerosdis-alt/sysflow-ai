# Lesson 105: Configuration and Schemas

## The Configuration Problem

Claude Code has dozens of configurable settings: model selection, API keys, permission policies, tool restrictions, MCP servers, UI preferences, context limits, and more. These settings come from five different sources, each with different precedence. And they must be validated at load time — a typo in a config file shouldn't crash the agent 20 minutes into a session.

This lesson covers how Claude Code uses Zod v4 for schema-based configuration: type-safe, validated, and self-documenting.

## Zod v4 for Configuration Schemas

Zod is a TypeScript-first schema validation library. You define a schema, and Zod gives you:
1. Runtime validation
2. TypeScript type inference
3. Detailed error messages
4. Default values
5. Type coercion

```typescript
import { z } from "zod";

const SettingsSchema = z.object({
  // Model settings
  model: z.string().default("claude-sonnet-4-20250514"),
  smallModel: z.string().default("claude-haiku-4-20250514"),
  maxTokens: z.number().int().positive().default(16384),
  maxTurns: z.number().int().positive().default(100),

  // API settings
  apiKey: z.string().optional(),
  apiBaseUrl: z.string().url().optional(),
  organizationId: z.string().optional(),

  // Permission policies
  permissions: z.object({
    autoApprove: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    defaultBehavior: z.enum(["ask", "deny", "allow"]).default("ask"),
  }).default({}),

  // Tool configuration
  tools: z.object({
    disabled: z.array(z.string()).default([]),
    bash: z.object({
      allowedCommands: z.array(z.string()).optional(),
      blockedCommands: z.array(z.string()).default(["rm -rf /"]),
      timeout: z.number().positive().default(120000),
    }).default({}),
  }).default({}),

  // MCP servers
  mcpServers: z.record(
    z.string(),
    z.object({
      command: z.string(),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).default({}),
    })
  ).default({}),

  // UI preferences
  ui: z.object({
    theme: z.enum(["dark", "light", "auto"]).default("auto"),
    showTokenUsage: z.boolean().default(true),
    verbose: z.boolean().default(false),
    markdownRenderer: z.enum(["rich", "plain"]).default("rich"),
  }).default({}),

  // Context management
  context: z.object({
    maxContextTokens: z.number().positive().default(100000),
    compactThreshold: z.number().positive().default(80000),
    historySnipEnabled: z.boolean().default(true),
  }).default({}),
});

// TypeScript type is inferred from the schema
type SettingsJson = z.infer<typeof SettingsSchema>;
```

The `z.infer` type is the key: the TypeScript type is derived from the schema, so they can never go out of sync. If you add a field to the schema, the type updates automatically.

## Multiple Config Sources

Configuration comes from five sources, merged in priority order:

```typescript
enum ConfigSource {
  Defaults = 0,     // Schema defaults
  UserConfig = 1,   // ~/.claude/settings.json
  ProjectConfig = 2, // .claude/config.json
  EnvVars = 3,      // CLAUDE_CODE_* environment variables
  CLIFlags = 4,     // --model, --max-turns, etc.
}

async function getInitialSettings(cliOpts: CLIOptions): Promise<SettingsJson> {
  // 1. Start with schema defaults
  const defaults = SettingsSchema.parse({});

  // 2. Load user-level config
  const userConfigPath = path.join(os.homedir(), ".claude", "settings.json");
  const userConfig = await loadAndValidateConfig(userConfigPath);

  // 3. Load project-level config
  const projectConfigPath = path.join(process.cwd(), ".claude", "config.json");
  const projectConfig = await loadAndValidateConfig(projectConfigPath);

  // 4. Parse environment variables
  const envConfig = parseEnvConfig();

  // 5. Parse CLI flags
  const cliConfig = parseCLIFlags(cliOpts);

  // Merge in priority order (later overrides earlier)
  const merged = deepMerge(defaults, userConfig, projectConfig, envConfig, cliConfig);

  // Final validation
  return SettingsSchema.parse(merged);
}
```

## Validation at Load Time

Every config source is validated when loaded:

```typescript
async function loadAndValidateConfig(
  filePath: string,
): Promise<Partial<SettingsJson>> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  let raw: unknown;
  try {
    const content = await fs.readFile(filePath, "utf-8");
    raw = JSON.parse(content);
  } catch (error) {
    console.warn(`Warning: Could not parse ${filePath}: ${error}`);
    return {};
  }

  // Partial validation — config files don't need every field
  const PartialSettingsSchema = SettingsSchema.partial();
  const result = PartialSettingsSchema.safeParse(raw);

  if (!result.success) {
    console.warn(`Warning: Invalid config in ${filePath}:`);
    for (const issue of result.error.issues) {
      console.warn(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    return {};
  }

  return result.data;
}
```

`safeParse` returns `{ success: true, data }` or `{ success: false, error }` instead of throwing. This means a bad config file generates a warning, not a crash.

## CLAUDE_CODE_* Environment Variables

Environment variables follow a naming convention that maps to config paths:

```typescript
function parseEnvConfig(): Partial<SettingsJson> {
  const config: Record<string, unknown> = {};

  const envMap: Record<string, string> = {
    CLAUDE_CODE_MODEL: "model",
    CLAUDE_CODE_SMALL_MODEL: "smallModel",
    CLAUDE_CODE_MAX_TOKENS: "maxTokens",
    CLAUDE_CODE_MAX_TURNS: "maxTurns",
    CLAUDE_CODE_API_KEY: "apiKey",
    CLAUDE_CODE_API_BASE_URL: "apiBaseUrl",
    CLAUDE_CODE_THEME: "ui.theme",
    CLAUDE_CODE_VERBOSE: "ui.verbose",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "context.maxContextTokens",
    CLAUDE_CODE_COMPACT_THRESHOLD: "context.compactThreshold",
    CLAUDE_CODE_PERMISSIONS_DEFAULT: "permissions.defaultBehavior",
    CLAUDE_CODE_BASH_TIMEOUT: "tools.bash.timeout",
  };

  for (const [envVar, configPath] of Object.entries(envMap)) {
    const value = process.env[envVar];
    if (value !== undefined) {
      setNestedValue(config, configPath, coerceValue(value, configPath));
    }
  }

  return config as Partial<SettingsJson>;
}

function coerceValue(value: string, path: string): unknown {
  // Determine expected type from schema path
  const schemaField = getSchemaField(SettingsSchema, path);

  if (schemaField instanceof z.ZodNumber) {
    const num = Number(value);
    if (isNaN(num)) throw new Error(`${path}: expected number, got "${value}"`);
    return num;
  }

  if (schemaField instanceof z.ZodBoolean) {
    return value === "true" || value === "1";
  }

  if (schemaField instanceof z.ZodArray) {
    return value.split(",").map(s => s.trim());
  }

  return value;
}
```

Usage: `CLAUDE_CODE_MODEL=claude-opus-4-20250514 claude "fix the bug"`.

## Schema Evolution via Migrations

When the config schema changes between versions, migrations transform old configs:

```typescript
interface ConfigMigration {
  version: number;
  description: string;
  migrate: (config: Record<string, unknown>) => Record<string, unknown>;
}

const CONFIG_MIGRATIONS: ConfigMigration[] = [
  {
    version: 2,
    description: "Rename 'maxContextSize' to 'context.maxContextTokens'",
    migrate: (config) => {
      if ("maxContextSize" in config) {
        return {
          ...config,
          context: {
            ...(config.context as Record<string, unknown> ?? {}),
            maxContextTokens: config.maxContextSize,
          },
        };
      }
      return config;
    },
  },
  {
    version: 3,
    description: "Move 'autoApproveTools' into 'permissions.autoApprove'",
    migrate: (config) => {
      if ("autoApproveTools" in config) {
        return {
          ...config,
          permissions: {
            ...(config.permissions as Record<string, unknown> ?? {}),
            autoApprove: config.autoApproveTools,
          },
        };
      }
      return config;
    },
  },
];

function applyMigrations(
  config: Record<string, unknown>,
  currentVersion: number,
): Record<string, unknown> {
  let migrated = { ...config };
  const configVersion = (config._version as number) ?? 1;

  for (const migration of CONFIG_MIGRATIONS) {
    if (migration.version > configVersion && migration.version <= currentVersion) {
      migrated = migration.migrate(migrated);
    }
  }

  migrated._version = currentVersion;
  return migrated;
}
```

## Deep Merge Strategy

Merging configs isn't a simple `Object.assign`. Arrays replace (not concatenate), objects merge recursively, and `undefined` values are skipped:

```typescript
function deepMerge<T extends Record<string, unknown>>(
  ...sources: Partial<T>[]
): T {
  const result = {} as Record<string, unknown>;

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;

      if (Array.isArray(value)) {
        // Arrays replace entirely
        result[key] = [...value];
      } else if (value !== null && typeof value === "object" && !isSet(value)) {
        // Objects merge recursively
        result[key] = deepMerge(
          (result[key] as Record<string, unknown>) ?? {},
          value as Record<string, unknown>
        );
      } else {
        // Primitives and Sets replace
        result[key] = value;
      }
    }
  }

  return result as T;
}
```

## Config Propagation

Once loaded, settings propagate through the system via the app state store:

```typescript
// At startup
const settings = await getInitialSettings(cliOpts);

// Into the state store
appStateStore.setState(prev => ({
  ...prev,
  model: settings.model,
  apiKey: settings.apiKey,
  tools: assembleToolPool(settings),
  features: settings.features ?? {},
}));

// Into the query loop
const events = query(message, {
  model: appState.model,
  maxTurns: settings.maxTurns,
  maxTokens: settings.maxTokens,
});

// Into tool execution
const toolContext: ToolContext = {
  cwd: settings.cwd ?? process.cwd(),
  bashTimeout: settings.tools.bash.timeout,
  permissions: settings.permissions,
};
```

Settings flow downward. Components read from the store. The query loop receives settings as parameters. Tools receive them in their execution context. Nobody reaches up to read a config file directly.

## Real Config File Examples

```json
// ~/.claude/settings.json (user-level)
{
  "model": "claude-sonnet-4-20250514",
  "ui": {
    "theme": "dark",
    "showTokenUsage": true
  },
  "permissions": {
    "defaultBehavior": "ask"
  }
}
```

```json
// .claude/config.json (project-level)
{
  "tools": {
    "bash": {
      "allowedCommands": ["npm", "git", "node", "npx"],
      "timeout": 60000
    }
  },
  "mcpServers": {
    "database": {
      "command": "npx",
      "args": ["@company/db-mcp-server"]
    }
  },
  "context": {
    "maxContextTokens": 120000
  }
}
```

## Key Takeaways

1. **Zod schemas** provide runtime validation AND TypeScript types from one source
2. **Five config sources** merge in priority order: defaults → user → project → env → CLI
3. **`safeParse`** validates without crashing — bad config files produce warnings
4. **Environment variables** use `CLAUDE_CODE_*` prefix with automatic type coercion
5. **Migrations** transform old configs when the schema changes between versions
6. **Deep merge** handles nested objects recursively with array-replace semantics
7. **Config propagates via state store** — never read config files directly from components

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Config Source Priority
**Question:** List the five configuration sources in Claude Code from lowest to highest priority. Why do CLI flags override environment variables, which override project config? Give a concrete scenario where this priority order prevents a problem.

[View Answer](../../answers/12-architecture-and-advanced/answer-105.md#exercise-1)

### Exercise 2 — Build a Zod Configuration Schema
**Challenge:** Define a complete Zod schema for an agent's configuration with at least 4 nested sections: `model` (model name, max tokens, temperature), `permissions` (auto-approve list, deny list, default behavior enum), `tools` (disabled list, bash timeout, bash allowed commands), and `ui` (theme enum, verbose boolean, markdown renderer enum). Use `.default()` on every field. Infer the TypeScript type with `z.infer`. Then write a validation function that uses `safeParse` and returns detailed, human-readable error messages for each invalid field.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-105.md#exercise-2)

### Exercise 3 — Environment Variable Parser
**Challenge:** Implement a `parseEnvConfig` function that reads `AGENT_*` prefixed environment variables and maps them to a nested config object. Support these types: strings, numbers (auto-coerce), booleans (`"true"`/`"1"` → `true`), and comma-separated arrays. Use a mapping object that defines `AGENT_MODEL` → `model.name`, `AGENT_MAX_TOKENS` → `model.maxTokens`, etc. Handle type coercion errors gracefully with warnings instead of crashes.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-105.md#exercise-3)

### Exercise 4 — Config Migration System
**Challenge:** Implement a versioned config migration system. Define at least 3 migrations that transform old config shapes to new ones (e.g., rename a field, restructure a nested object, convert a string to an array). The `applyMigrations` function should: check the config's `_version` field, apply only migrations newer than that version in order, update the version after migration, and log each applied migration. Write tests that verify a v1 config is correctly migrated to v4 through all intermediate steps.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-105.md#exercise-4)

### Exercise 5 — Deep Merge with Config Semantics
**Challenge:** Implement a `deepMerge` function with config-specific merge semantics: objects merge recursively, arrays replace entirely (not concatenate), `undefined` values are skipped, `null` explicitly deletes a key, Sets and Maps replace entirely, and primitive values override. Write tests covering: nested object merge, array replacement, null deletion, undefined skip, and a full 5-source merge that simulates defaults → user → project → env → CLI priority.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-105.md#exercise-5)
