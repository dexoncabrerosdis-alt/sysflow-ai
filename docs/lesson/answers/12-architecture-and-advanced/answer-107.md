# Answers: Lesson 107 — Commands System

## Exercise 1
**Question:** What is the fundamental difference between a slash command and a tool? Why do commands bypass the AI model? Give three examples of each with reasoning.

**Answer:** A slash command is a **user-initiated direct action** — the user explicitly types `/command` and it executes immediately without any AI involvement. A tool is a **model-invoked capability** — the AI model decides to call it as part of reasoning through a task. Commands bypass the model because they are control-plane operations: the user wants to directly manipulate the agent's state, configuration, or session — not ask the AI to do it. This is faster, deterministic, and gives the user direct control.

Three actions that should be commands: (1) `/model sonnet` — switching models is a user preference, not something the AI should decide; (2) `/clear` — resetting conversation history is a session management action; (3) `/exit` — terminating the program is purely a user control decision. Three actions that should be tools: (1) `Read` (reading files) — the model decides which files are relevant to the task; (2) `Bash` (running commands) — the model determines what commands to run as part of its solution; (3) `Write` (editing files) — the model generates the code changes to apply. The dividing line: commands are meta-actions about the agent itself, tools are capabilities the agent uses to accomplish tasks.

---

## Exercise 2
**Challenge:** Build a command registry with dispatch and fuzzy matching.

**Answer:**

```typescript
interface Command {
  name: string;
  description: string;
  aliases?: string[];
  hidden?: boolean;
  category?: string;
  argDescription?: string;
  isEnabled?: (state: AppState) => boolean;
  handler: (args: string, context: CommandContext) => Promise<CommandResult>;
}

type CommandResult =
  | { type: "message"; content: string }
  | { type: "silent" }
  | { type: "error"; message: string }
  | { type: "exit" };

class CommandRegistry {
  private commands: Command[] = [];

  register(command: Command): void {
    this.commands.push(command);
  }

  getAll(): Command[] {
    return [...this.commands];
  }

  getAvailable(state: AppState): Command[] {
    return this.commands.filter(cmd =>
      !cmd.isEnabled || cmd.isEnabled(state)
    );
  }

  findByName(input: string): Command | undefined {
    const name = input.toLowerCase();
    return this.commands.find(
      cmd => cmd.name === name || cmd.aliases?.includes(name)
    );
  }

  findClosest(input: string): string | undefined {
    const name = input.toLowerCase();
    let bestMatch: string | undefined;
    let bestDistance = Infinity;

    for (const cmd of this.commands) {
      if (cmd.hidden) continue;
      const dist = levenshtein(name, cmd.name);
      if (dist < bestDistance && dist <= 3) {
        bestDistance = dist;
        bestMatch = cmd.name;
      }
    }

    return bestMatch;
  }
}

function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

async function dispatch(
  input: string,
  registry: CommandRegistry,
  context: CommandContext
): Promise<CommandResult> {
  if (!input.startsWith("/")) {
    return { type: "error", message: "Not a command (must start with /)" };
  }

  const [rawName, ...argParts] = input.slice(1).split(/\s+/);
  const commandName = rawName.toLowerCase();
  const args = argParts.join(" ");

  const command = registry.findByName(commandName);

  if (!command) {
    const closest = registry.findClosest(commandName);
    const suggestion = closest ? ` Did you mean /${closest}?` : "";
    return {
      type: "error",
      message: `Unknown command: /${commandName}.${suggestion} Type /help for available commands.`,
    };
  }

  if (command.isEnabled && !command.isEnabled(context.appState)) {
    return {
      type: "error",
      message: `/${command.name} is not available right now.`,
    };
  }

  return await command.handler(args, context);
}
```

**Explanation:** The `CommandRegistry` stores commands and provides lookup by name or alias. `findClosest` uses Levenshtein distance for fuzzy matching, only suggesting commands within 3 edits to avoid false positives. The `dispatch` function parses the `/command args` format, finds the matching command, checks availability, and executes the handler. The result type is a discriminated union that tells the REPL how to respond — show a message, do nothing, show an error, or exit.

---

## Exercise 3
**Challenge:** Implement five core commands with state management.

**Answer:**

```typescript
const AVAILABLE_MODELS = [
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-20250514",
];

const MODEL_PRICING: Record<string, { inputPer1k: number; outputPer1k: number }> = {
  "claude-opus-4-20250514": { inputPer1k: 0.015, outputPer1k: 0.075 },
  "claude-sonnet-4-20250514": { inputPer1k: 0.003, outputPer1k: 0.015 },
  "claude-haiku-4-20250514": { inputPer1k: 0.00025, outputPer1k: 0.00125 },
};

const coreCommands: Command[] = [
  {
    name: "clear",
    description: "Clear conversation history and start fresh",
    category: "session",
    handler: async (_args, ctx) => {
      ctx.setState(prev => ({
        ...prev,
        messages: [],
        tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        turnCount: 0,
        toolCallCount: 0,
      }));
      return { type: "message", content: "Conversation cleared." };
    },
  },

  {
    name: "model",
    description: "Switch the active model",
    category: "model",
    argDescription: "<model-name>",
    handler: async (args, ctx) => {
      const modelName = args.trim();

      if (!modelName) {
        const lines = [
          `Current model: ${ctx.appState.model}`,
          `Available models:`,
          ...AVAILABLE_MODELS.map(m => `  - ${m}${m === ctx.appState.model ? " (active)" : ""}`),
        ];
        return { type: "message", content: lines.join("\n") };
      }

      const match = AVAILABLE_MODELS.find(
        m => m === modelName || m.includes(modelName)
      );

      if (!match) {
        return {
          type: "error",
          message: `Unknown model: "${modelName}". Available: ${AVAILABLE_MODELS.join(", ")}`,
        };
      }

      ctx.setState(prev => ({ ...prev, model: match }));
      return { type: "message", content: `Switched to ${match}` };
    },
  },

  {
    name: "status",
    description: "Show session status and token usage",
    category: "info",
    handler: async (_args, ctx) => {
      const { tokenUsage, model, turnCount, toolCallCount } = ctx.appState;
      const pricing = MODEL_PRICING[model];
      const cost = pricing
        ? (tokenUsage.input * pricing.inputPer1k / 1000) +
          (tokenUsage.output * pricing.outputPer1k / 1000)
        : 0;

      const lines = [
        `Model: ${model}`,
        `Turns: ${turnCount}`,
        `Tool calls: ${toolCallCount}`,
        `Tokens: ${tokenUsage.input.toLocaleString()} in / ${tokenUsage.output.toLocaleString()} out`,
        `Estimated cost: $${cost.toFixed(4)}`,
      ];
      return { type: "message", content: lines.join("\n") };
    },
  },

  {
    name: "compact",
    description: "Compact conversation to save context window",
    category: "session",
    argDescription: "[custom instructions]",
    isEnabled: (state) => state.messages.length > 2,
    handler: async (args, ctx) => {
      const beforeCount = ctx.appState.messages.length;
      // Simulate compaction — in practice, this calls the compaction function
      const compactedMessages = ctx.appState.messages.slice(-Math.ceil(beforeCount * 0.3));

      ctx.setState(prev => ({ ...prev, messages: compactedMessages }));

      const saved = beforeCount - compactedMessages.length;
      return {
        type: "message",
        content: `Compacted ${saved} messages (${beforeCount} → ${compactedMessages.length}). ` +
          `Context usage reduced.${args ? ` Instructions: "${args}"` : ""}`,
      };
    },
  },

  {
    name: "exit",
    description: "Exit the application",
    category: "session",
    aliases: ["quit", "q"],
    handler: async () => {
      return { type: "exit" };
    },
  },
];
```

**Explanation:** Each command follows the same pattern: receive args and context, update state via `ctx.setState`, return a `CommandResult`. The `/model` command supports both listing (no args) and switching (with partial name matching). `/status` computes cost from token usage and model pricing. `/compact` has an `isEnabled` guard that hides it when there are fewer than 3 messages. `/exit` uses aliases so `/quit` and `/q` also work. All state changes go through `setState` — commands never manipulate the UI directly.

---

## Exercise 4
**Challenge:** Implement markdown project command loading.

**Answer:**

```typescript
import * as fs from "fs";
import * as path from "path";

interface ParsedCommandFile {
  name: string;
  description: string;
  prompt: string;
}

function parseCommandMarkdown(content: string, filename: string): ParsedCommandFile {
  const lines = content.split("\n");
  let description = "";
  let prompt = "";
  let inPromptSection = false;

  for (const line of lines) {
    if (line.startsWith("# /")) {
      continue; // Skip title
    }

    if (line.trim().toLowerCase() === "## prompt") {
      inPromptSection = true;
      continue;
    }

    if (inPromptSection) {
      prompt += line + "\n";
    } else if (line.trim() && !description) {
      description = line.trim();
    }
  }

  return {
    name: path.basename(filename, ".md"),
    description: description || `Custom command: ${path.basename(filename, ".md")}`,
    prompt: prompt.trim(),
  };
}

async function loadProjectCommands(
  projectDir: string = process.cwd()
): Promise<Command[]> {
  const commandsDir = path.join(projectDir, ".claude", "commands");

  if (!fs.existsSync(commandsDir)) return [];

  const files = fs.readdirSync(commandsDir).filter(f => f.endsWith(".md"));
  const commands: Command[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(commandsDir, file), "utf-8");
      const parsed = parseCommandMarkdown(content, file);

      commands.push({
        name: parsed.name,
        description: parsed.description,
        category: "project",
        handler: async (args, ctx) => {
          const fullPrompt = parsed.prompt.replace(/\$ARGS/g, args);

          ctx.setState(prev => ({
            ...prev,
            messages: [
              ...prev.messages,
              { role: "user" as const, content: fullPrompt },
            ],
          }));

          return { type: "silent" };
        },
      });
    } catch (error) {
      console.warn(`Failed to load command from ${file}: ${error}`);
    }
  }

  return commands;
}

// Example: .claude/commands/deploy.md
const exampleDeployMd = `
# /deploy

Deploy the current branch to staging.

## Prompt

Run the following deployment steps for $ARGS:
1. Run all tests with \`npm test\`
2. Build the production bundle with \`npm run build\`
3. Deploy to staging with \`npm run deploy:staging\`
4. Verify the deployment by checking the health endpoint

Report each step's status as you go.
`.trim();

// Test
function testProjectCommands() {
  const parsed = parseCommandMarkdown(exampleDeployMd, "deploy.md");
  console.assert(parsed.name === "deploy", "Name extracted");
  console.assert(parsed.description.includes("Deploy"), "Description extracted");
  console.assert(parsed.prompt.includes("$ARGS"), "Prompt has $ARGS");
  console.assert(parsed.prompt.includes("npm test"), "Prompt has steps");

  const resolved = parsed.prompt.replace(/\$ARGS/g, "production");
  console.assert(resolved.includes("production"), "$ARGS replaced");
  console.assert(!resolved.includes("$ARGS"), "No remaining $ARGS");

  console.log("Project command tests passed");
}

testProjectCommands();
```

**Explanation:** The markdown parser extracts three parts: the command name (from the filename), a description (first non-heading text), and the prompt template (everything under the `## Prompt` heading). The `$ARGS` placeholder allows the user to pass arguments: `/deploy production` replaces `$ARGS` with "production". The handler injects the resolved prompt as a user message into the conversation — the AI model then processes it as if the user typed the expanded prompt. The `type: "silent"` return means the command itself produces no output; the AI's response is the output.

---

## Exercise 5
**Challenge:** Build tab completion and formatted help output.

**Answer:**

```typescript
function getCompletions(partial: string, state: AppState): string[] {
  if (!partial.startsWith("/")) return [];

  const prefix = partial.slice(1).toLowerCase();
  const available = registry.getAvailable(state);

  return available
    .filter(cmd => !cmd.hidden && cmd.name.startsWith(prefix))
    .map(cmd => `/${cmd.name}`)
    .sort();
}

interface CommandGroup {
  category: string;
  label: string;
  commands: Command[];
}

function groupCommands(commands: Command[]): CommandGroup[] {
  const categoryLabels: Record<string, string> = {
    session: "Session",
    model: "Model & Config",
    tools: "Tools & Permissions",
    info: "Information",
    project: "Project Commands",
  };

  const groups = new Map<string, Command[]>();
  for (const cmd of commands) {
    if (cmd.hidden) continue;
    const cat = cmd.category ?? "other";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(cmd);
  }

  return [...groups.entries()].map(([category, cmds]) => ({
    category,
    label: categoryLabels[category] ?? category,
    commands: cmds.sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

function renderHelp(state: AppState): string {
  const available = registry.getAvailable(state).filter(cmd => !cmd.hidden);
  const groups = groupCommands(available);

  const maxNameLen = Math.max(
    ...available.map(cmd => {
      const aliases = cmd.aliases ? ` (${cmd.aliases.map(a => "/" + a).join(", ")})` : "";
      const argDesc = cmd.argDescription ? ` ${cmd.argDescription}` : "";
      return `/${cmd.name}${argDesc}${aliases}`.length;
    })
  );

  const lines: string[] = ["Available Commands:", ""];

  for (const group of groups) {
    lines.push(`  ${group.label}:`);

    for (const cmd of group.commands) {
      const aliases = cmd.aliases ? ` (${cmd.aliases.map(a => "/" + a).join(", ")})` : "";
      const argDesc = cmd.argDescription ? ` ${cmd.argDescription}` : "";
      const nameCol = `/${cmd.name}${argDesc}${aliases}`;
      const padding = " ".repeat(Math.max(2, maxNameLen - nameCol.length + 4));
      lines.push(`    ${nameCol}${padding}${cmd.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function getCommandHelp(commandName: string): string {
  const cmd = registry.findByName(commandName);
  if (!cmd) return `Unknown command: /${commandName}`;

  const lines = [
    `/${cmd.name}${cmd.argDescription ? ` ${cmd.argDescription}` : ""}`,
    "",
    cmd.description,
  ];

  if (cmd.aliases?.length) {
    lines.push("", `Aliases: ${cmd.aliases.map(a => "/" + a).join(", ")}`);
  }

  if (cmd.category) {
    lines.push(`Category: ${cmd.category}`);
  }

  return lines.join("\n");
}

// Usage
console.log(renderHelp(appState));
// Output:
// Available Commands:
//
//   Session:
//     /clear                              Clear conversation history and start fresh
//     /compact [custom instructions]      Compact conversation to save context window
//     /exit (/quit, /q)                   Exit the application
//
//   Model & Config:
//     /model <model-name>                 Switch the active model
//
//   Information:
//     /status                             Show session status and token usage
```

**Explanation:** `getCompletions` filters available, non-hidden commands by prefix for tab completion. `groupCommands` organizes commands by category with display labels. `renderHelp` formats all commands into a columnar display with proper alignment — the name+aliases column is padded to align descriptions. Hidden commands are excluded from both completions and help output. `getCommandHelp` provides detailed information about a single command, useful for `/help model`. The category system keeps the help output organized as the command count grows.
