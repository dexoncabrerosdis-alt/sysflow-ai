# Lesson 107: The Commands System

## Slash Commands

When you type `/help` or `/model` or `/compact` in Claude Code's REPL, you're using the command system. Commands are actions that don't go through the AI model — they execute immediately, modifying app state, triggering operations, or displaying information.

Commands are the user's direct control interface. The model suggests and executes tools. The user executes commands.

## Command Structure

Every command follows a simple interface:

```typescript
interface Command {
  name: string;
  description: string;
  aliases?: string[];
  hidden?: boolean;
  isEnabled?: (state: AppState) => boolean;
  argDescription?: string;
  handler: (args: string, context: CommandContext) => Promise<CommandResult>;
}

interface CommandContext {
  appState: AppState;
  setState: (updater: (prev: AppState) => AppState) => void;
  query: typeof query; // Access to the agent loop
  session: Session;
  mcpConnections: McpConnection[];
}

type CommandResult =
  | { type: "message"; content: string }
  | { type: "silent" } // No output
  | { type: "error"; message: string }
  | { type: "exit" };
```

A command receives the raw argument string and a context object with everything it needs. It returns a result that tells the REPL what to display.

## COMMANDS(): The Command Registry

All commands are defined in a memoized function that returns the full list:

```typescript
let cachedCommands: Command[] | null = null;

function COMMANDS(): Command[] {
  if (cachedCommands) return cachedCommands;

  cachedCommands = [
    // Session commands
    {
      name: "clear",
      description: "Clear conversation history and start fresh",
      handler: async (_args, ctx) => {
        ctx.setState(prev => ({
          ...prev,
          messages: [],
          tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          turnCount: 0,
        }));
        return { type: "message", content: "Conversation cleared." };
      },
    },
    {
      name: "compact",
      description: "Compact conversation to save context window",
      argDescription: "[custom instructions for compaction]",
      handler: async (args, ctx) => {
        const instructions = args || undefined;
        const compacted = await compactMessages(
          ctx.appState.messages,
          { customInstructions: instructions }
        );
        ctx.setState(prev => ({ ...prev, messages: compacted }));
        const saved = ctx.appState.messages.length - compacted.length;
        return {
          type: "message",
          content: `Compacted ${saved} messages. Context usage reduced.`,
        };
      },
    },

    // Model commands
    {
      name: "model",
      description: "Switch the active model",
      argDescription: "<model-name>",
      handler: async (args, ctx) => {
        const modelName = args.trim();
        if (!modelName) {
          return {
            type: "message",
            content: `Current model: ${ctx.appState.model}\n` +
              `Available: ${AVAILABLE_MODELS.join(", ")}`,
          };
        }
        const resolved = resolveModelName(modelName);
        if (!resolved) {
          return { type: "error", message: `Unknown model: ${modelName}` };
        }
        ctx.setState(prev => ({ ...prev, model: resolved }));
        return { type: "message", content: `Switched to ${resolved}` };
      },
    },

    // Mode commands
    {
      name: "plan",
      description: "Toggle plan mode (think before acting)",
      handler: async (_args, ctx) => {
        const newMode = ctx.appState.inputMode === "plan" ? "normal" : "plan";
        ctx.setState(prev => ({ ...prev, inputMode: newMode }));
        return {
          type: "message",
          content: newMode === "plan"
            ? "Plan mode ON — I'll explain my approach before making changes."
            : "Plan mode OFF — back to normal execution.",
        };
      },
    },

    // Information commands
    {
      name: "help",
      description: "Show available commands",
      handler: async (_args, _ctx) => {
        const commands = getCommands(_ctx.appState);
        const lines = commands
          .filter(cmd => !cmd.hidden)
          .map(cmd => {
            const args = cmd.argDescription ? ` ${cmd.argDescription}` : "";
            return `  /${cmd.name}${args} — ${cmd.description}`;
          });
        return { type: "message", content: lines.join("\n") };
      },
    },
    {
      name: "status",
      description: "Show session status and token usage",
      handler: async (_args, ctx) => {
        const { tokenUsage, model, turnCount, toolCallCount } = ctx.appState;
        const cost = calculateCost(tokenUsage, model);
        return {
          type: "message",
          content: [
            `Model: ${model}`,
            `Turns: ${turnCount}`,
            `Tool calls: ${toolCallCount}`,
            `Tokens: ${tokenUsage.input} in / ${tokenUsage.output} out`,
            `Cache: ${tokenUsage.cacheRead} read / ${tokenUsage.cacheWrite} write`,
            `Estimated cost: $${cost.toFixed(4)}`,
          ].join("\n"),
        };
      },
    },

    // Tool management
    {
      name: "permissions",
      description: "Manage tool permissions",
      argDescription: "[grant|deny|reset] [tool-name]",
      handler: async (args, ctx) => {
        const [action, toolName] = args.split(/\s+/);

        if (!action) {
          const granted = [...ctx.appState.grantedPermissions].join(", ") || "none";
          const denied = [...ctx.appState.deniedPermissions].join(", ") || "none";
          return {
            type: "message",
            content: `Granted: ${granted}\nDenied: ${denied}`,
          };
        }

        switch (action) {
          case "grant":
            ctx.setState(prev => ({
              ...prev,
              grantedPermissions: new Set([...prev.grantedPermissions, toolName]),
            }));
            return { type: "message", content: `Granted: ${toolName}` };

          case "deny":
            ctx.setState(prev => ({
              ...prev,
              deniedPermissions: new Set([...prev.deniedPermissions, toolName]),
            }));
            return { type: "message", content: `Denied: ${toolName}` };

          case "reset":
            ctx.setState(prev => ({
              ...prev,
              grantedPermissions: new Set(),
              deniedPermissions: new Set(),
            }));
            return { type: "message", content: "All permissions reset." };

          default:
            return { type: "error", message: `Unknown action: ${action}` };
        }
      },
    },

    // MCP commands
    {
      name: "mcp",
      description: "Manage MCP server connections",
      argDescription: "[list|connect|disconnect] [server-name]",
      handler: async (args, ctx) => {
        const [action, serverName] = args.split(/\s+/);

        if (!action || action === "list") {
          const servers = ctx.mcpConnections.map(c =>
            `  ${c.serverName}: ${c.state.status}`
          );
          return {
            type: "message",
            content: servers.length
              ? `MCP Servers:\n${servers.join("\n")}`
              : "No MCP servers configured.",
          };
        }
        // ... connect/disconnect handlers
        return { type: "silent" };
      },
    },

    // Session commands
    {
      name: "resume",
      description: "Resume a previous session",
      argDescription: "[session-id]",
      handler: async (args, ctx) => {
        if (!args.trim()) {
          const sessions = await listRecentSessions(5);
          const lines = sessions.map(s =>
            `  ${s.id.slice(0, 8)} — ${s.createdAt.toLocaleDateString()} ` +
            `(${s.messages.length} messages)`
          );
          return {
            type: "message",
            content: `Recent sessions:\n${lines.join("\n")}\n\n` +
              `Use /resume <id> to resume.`,
          };
        }
        const session = await loadSession(args.trim());
        if (!session) {
          return { type: "error", message: `Session not found: ${args}` };
        }
        ctx.setState(prev => ({
          ...prev,
          messages: session.messages,
          sessionId: session.id,
        }));
        return {
          type: "message",
          content: `Resumed session ${session.id.slice(0, 8)} ` +
            `(${session.messages.length} messages).`,
        };
      },
    },

    // Exit
    {
      name: "exit",
      description: "Exit Claude Code",
      aliases: ["quit", "q"],
      handler: async () => {
        return { type: "exit" };
      },
    },
  ];

  return cachedCommands;
}
```

## loadAllCommands(): Merging Command Sources

Commands come from multiple sources beyond the built-in list:

```typescript
async function loadAllCommands(
  settings: Settings,
  mcpConnections: McpConnection[],
): Promise<Command[]> {
  const builtIn = COMMANDS();

  // Project-specific commands from .claude/commands/
  const projectCommands = await loadProjectCommands();

  // User-defined commands from ~/.claude/commands/
  const userCommands = await loadUserCommands();

  // Plugin commands (third-party extensions)
  const pluginCommands = await loadPluginCommands(settings);

  // Skill commands (from .cursor/skills/)
  const skillCommands = await loadSkillCommands();

  // MCP-provided commands
  const mcpCommands = await loadMcpCommands(mcpConnections);

  // Merge with built-in taking priority on name conflicts
  return deduplicateByName([
    ...builtIn,
    ...projectCommands,
    ...userCommands,
    ...pluginCommands,
    ...skillCommands,
    ...mcpCommands,
  ]);
}
```

Project commands are markdown files that define custom slash commands:

```markdown
<!-- .claude/commands/deploy.md -->
# /deploy

Deploy the current branch to staging.

## Prompt

Run the following deployment steps:
1. Run all tests with `npm test`
2. Build the production bundle with `npm run build`
3. Deploy to staging with `npm run deploy:staging`
4. Verify the deployment by checking the health endpoint

Report each step's status as you go.
```

These markdown files are loaded as commands that inject the prompt content into the conversation:

```typescript
async function loadProjectCommands(): Promise<Command[]> {
  const commandsDir = path.join(process.cwd(), ".claude", "commands");
  if (!fs.existsSync(commandsDir)) return [];

  const files = await fs.readdir(commandsDir);
  return files
    .filter(f => f.endsWith(".md"))
    .map(f => {
      const content = fs.readFileSync(path.join(commandsDir, f), "utf-8");
      const name = path.basename(f, ".md");
      const { description, prompt } = parseCommandMarkdown(content);

      return {
        name,
        description: description || `Custom command: ${name}`,
        source: "project",
        handler: async (args, ctx) => {
          const fullPrompt = prompt.replace("$ARGS", args);
          // Inject as a user message — the agent will execute it
          ctx.setState(prev => ({
            ...prev,
            messages: [...prev.messages, { role: "user", content: fullPrompt }],
          }));
          return { type: "silent" };
        },
      };
    });
}
```

## getCommands(): Filtering by Availability

Not all commands are available at all times. `getCommands` filters by state:

```typescript
function getCommands(appState: AppState): Command[] {
  const allCommands = loadAllCommandsCached();

  return allCommands.filter(cmd => {
    // Check if the command has an availability condition
    if (cmd.isEnabled && !cmd.isEnabled(appState)) {
      return false;
    }

    return true;
  });
}
```

Example of conditional availability:

```typescript
{
  name: "compact",
  description: "Compact conversation to save context",
  isEnabled: (state) => state.messages.length > 2,
  // No point showing /compact with an empty conversation
  handler: async (args, ctx) => { /* ... */ },
},
{
  name: "resume",
  description: "Resume a previous session",
  isEnabled: (state) => state.messages.length === 0,
  // Only show /resume at the start of a session
  handler: async (args, ctx) => { /* ... */ },
}
```

## Command Parsing and Dispatch

When the user types input starting with `/`, the REPL dispatches to the command system:

```typescript
async function handleInput(
  input: string,
  context: CommandContext,
): Promise<InputResult> {
  // Check if it's a command
  if (input.startsWith("/")) {
    const [commandName, ...argParts] = input.slice(1).split(/\s+/);
    const args = argParts.join(" ");

    // Find the command (check name and aliases)
    const commands = getCommands(context.appState);
    const command = commands.find(
      cmd => cmd.name === commandName ||
             cmd.aliases?.includes(commandName)
    );

    if (!command) {
      // Fuzzy match suggestion
      const closest = findClosestCommand(commandName, commands);
      return {
        type: "error",
        message: closest
          ? `Unknown command: /${commandName}. Did you mean /${closest}?`
          : `Unknown command: /${commandName}. Type /help for available commands.`,
      };
    }

    const result = await command.handler(args, context);
    return result;
  }

  // Not a command — treat as a user message to the agent
  return { type: "user_message", content: input };
}
```

## How Commands Interact with App State

Commands are the primary way users directly modify app state. The pattern is consistent:

```
User types /command  →  handler receives context  →  setState()  →  UI re-renders
```

```typescript
// /model sonnet → changes model in state → status bar updates
ctx.setState(prev => ({ ...prev, model: "claude-sonnet-4-20250514" }));

// /clear → resets messages → message history clears
ctx.setState(prev => ({ ...prev, messages: [], turnCount: 0 }));

// /plan → toggles mode → mode indicator updates
ctx.setState(prev => ({
  ...prev,
  inputMode: prev.inputMode === "plan" ? "normal" : "plan",
}));
```

Commands never directly manipulate the UI. They change state, and the UI reacts.

## Tab Completion

Commands support tab completion for a smoother experience:

```typescript
function getCompletions(
  partial: string,
  appState: AppState,
): string[] {
  if (!partial.startsWith("/")) return [];

  const prefix = partial.slice(1).toLowerCase();
  const commands = getCommands(appState);

  return commands
    .filter(cmd => cmd.name.startsWith(prefix) && !cmd.hidden)
    .map(cmd => `/${cmd.name}`);
}
```

## Key Takeaways

1. **Commands are direct user actions** — they bypass the AI model entirely
2. **Simple interface**: name, description, handler function, optional availability check
3. **`COMMANDS()`** is memoized — the list is built once and cached
4. **Multiple sources**: built-in, project, user, plugin, skill, and MCP commands
5. **Project commands** are markdown files that inject prompts into the conversation
6. **`getCommands()`** filters by availability based on current app state
7. **Commands modify state** — they never directly manipulate the UI
8. **Fuzzy matching** helps users find commands they've mistyped

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Commands vs Tools
**Question:** What is the fundamental difference between a slash command and a tool in an AI agent? Why do commands bypass the AI model entirely while tools are invoked by the model? Give three examples of actions that should be commands and three that should be tools, explaining your reasoning.

[View Answer](../../answers/12-architecture-and-advanced/answer-107.md#exercise-1)

### Exercise 2 — Build a Command Registry
**Challenge:** Implement a complete command system with: a `Command` interface (name, description, aliases, isEnabled, handler), a `CommandRegistry` class that supports `register()`, `getAll()`, `getAvailable(state)`, and `findByName(input)`, a `dispatch` function that parses `/command args` input, finds the matching command (by name or alias), executes the handler, and returns the `CommandResult`. Include fuzzy matching that suggests the closest command when an unknown command is typed.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-107.md#exercise-2)

### Exercise 3 — Implement Core Commands
**Challenge:** Implement five commands using the `Command` interface: `/clear` (resets messages and token usage), `/model <name>` (switches model with validation against an allowed list), `/status` (displays model, turn count, token usage, and estimated cost), `/compact [instructions]` (simulates message compaction), and `/exit` (returns exit result). Each command should properly update state via `setState` and return appropriate `CommandResult` objects. Include the `isEnabled` check for `/compact` (only when messages exist).

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-107.md#exercise-3)

### Exercise 4 — Markdown Project Commands
**Challenge:** Implement the project command loading system: write a `loadProjectCommands` function that reads `.md` files from a `.claude/commands/` directory, parses each file to extract a description and prompt template, and creates `Command` objects that inject the prompt into the conversation. The prompt template should support a `$ARGS` placeholder that gets replaced with the command's arguments. Include a test with a sample `deploy.md` command file.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-107.md#exercise-4)

### Exercise 5 — Tab Completion and Command Help
**Challenge:** Build a tab completion system for commands: `getCompletions(partial, state)` returns matching command names for the current input prefix. Then build a formatted help renderer that displays all visible commands grouped by category (session, model, tools, info), with name, aliases, argument description, and description aligned in columns. Hidden commands should be excluded. Include a `getCommandHelp(commandName)` function that shows detailed help for a single command.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-107.md#exercise-5)
