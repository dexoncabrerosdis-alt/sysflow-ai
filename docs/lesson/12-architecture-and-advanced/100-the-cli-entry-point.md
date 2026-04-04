# Lesson 100: The CLI Entry Point

## cli.tsx: Where Everything Starts

When you type `claude` in your terminal, you're invoking a single file: `cli.tsx`. This is the front door to the entire system. Every feature, every tool, every agent loop begins here — but `cli.tsx` itself does remarkably little. Its job is to get out of the way as fast as possible.

```typescript
#!/usr/bin/env node

// cli.tsx — the entry point
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  // We're the main process, not a worker
  startCapturingEarlyInput();
  await handleFastPaths();
  const { main } = await import("./main.js");
  await main();
}
```

That's the skeleton. Three steps: capture input, check fast paths, load and run the real application. Let's examine each.

## Fast Paths: Skip the Heavy Stuff

Most CLI invocations need the full application — the React UI, the agent loop, the tool system. But some don't. Fast paths handle these lightweight cases before loading any heavy modules:

```typescript
async function handleFastPaths(): Promise<void> {
  const args = process.argv.slice(2);

  // --version: print and exit
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  // --help with no other args: print usage
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  // MCP server mode: run as a Model Context Protocol server
  if (args.includes("mcp") || args.includes("--mcp")) {
    const { runMcpServer } = await import("./mcp-server/index.js");
    await runMcpServer();
    process.exit(0);
  }

  // Bridge mode: act as a bridge for another process
  if (args.includes("--bridge")) {
    const { runBridge } = await import("./bridge.js");
    await runBridge();
    process.exit(0);
  }

  // Daemon mode: background process for session management
  if (args.includes("--daemon")) {
    const { runDaemon } = await import("./daemon.js");
    await runDaemon();
    process.exit(0);
  }
}
```

Fast paths use dynamic `import()` so that the MCP server code, bridge code, and daemon code are only loaded when needed. Running `claude --version` should return in milliseconds, not seconds.

## Capturing Early Input

Here's a subtle problem: the user types `claude` and presses Enter. While the application loads (importing modules, parsing config, mounting the React tree), the user might start typing their prompt. Those keystrokes arrive at `stdin` before any listener is attached. Without intervention, they'd be lost.

`startCapturingEarlyInput` solves this by immediately buffering stdin:

```typescript
let earlyInputBuffer: Buffer[] = [];
let earlyInputCapture: boolean = false;

function startCapturingEarlyInput(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    earlyInputCapture = true;

    process.stdin.on("data", (chunk: Buffer) => {
      if (earlyInputCapture) {
        earlyInputBuffer.push(chunk);
      }
    });
  }
}

// Called later by the REPL when it's ready to accept input
export function flushEarlyInput(): Buffer[] {
  earlyInputCapture = false;
  const buffered = earlyInputBuffer;
  earlyInputBuffer = [];
  return buffered;
}
```

When the React REPL component mounts, it calls `flushEarlyInput()` and replays the buffered keystrokes. The user never notices the delay. This is a small detail that dramatically improves perceived responsiveness.

## Dynamic Import of main.js

After fast paths are handled, the entry point dynamically imports `main.js`:

```typescript
const { main } = await import("./main.js");
await main();
```

Why dynamic import instead of a static `import main from "./main.js"` at the top? Because static imports are evaluated eagerly. If `main.js` imports React, Ink, the tool system, the API client, and everything else — all of that loads even for `claude --version`. Dynamic import defers this cost to when it's actually needed.

## main(): Where the Real Work Begins

The `main()` function in `main.tsx` is where the application actually assembles itself. It's a carefully ordered sequence:

```typescript
export async function main(): Promise<void> {
  // 1. Security: prevent DLL hijacking on Windows
  if (process.platform === "win32") {
    setNoDefaultCurrentDirectoryInExePath();
  }

  // 2. Parse CLI arguments with Commander
  const program = new Command()
    .name("claude")
    .description("Claude Code — AI coding agent")
    .version(VERSION)
    .option("-m, --model <model>", "Model to use")
    .option("-p, --prompt <prompt>", "Initial prompt (non-interactive)")
    .option("--resume <sessionId>", "Resume a previous session")
    .option("--plan", "Start in plan mode")
    .option("--max-turns <n>", "Maximum agent turns", parseInt)
    .option("--allowedTools <tools...>", "Pre-approved tools")
    .option("--output-format <format>", "Output format: text, json, stream-json")
    .option("--no-permissions", "Skip permission prompts (CI mode)")
    .parse(process.argv);

  const opts = program.opts();

  // 3. Load configuration
  const settings = await getInitialSettings(opts);

  // 4. Signal handling
  setupSignalHandlers();

  // 5. Session management
  const session = opts.resume
    ? await resumeSession(opts.resume)
    : createNewSession();

  // 6. Detect execution mode
  if (opts.prompt && !process.stdin.isTTY) {
    // Piped input: non-interactive mode
    await runNonInteractive(opts, settings, session);
  } else {
    // Interactive: launch the full terminal UI
    await launchRepl(opts, settings, session);
  }
}
```

## Security: NoDefaultCurrentDirectoryInExePath

This one line prevents a real attack vector on Windows:

```typescript
function setNoDefaultCurrentDirectoryInExePath(): void {
  // Prevents Windows from searching the current directory for executables
  // before searching PATH. Without this, a malicious file named "git.exe"
  // in the project directory could be executed instead of the real git.
  process.env.NoDefaultCurrentDirectoryInExePath = "1";
}
```

When Claude Code runs `git status` via a tool, Windows would normally search the current directory first. An attacker could place a malicious `git.exe` in a repository. This environment variable tells Windows to skip the current directory and go straight to PATH.

## Signal Handling

The agent needs to handle interrupts gracefully — the user pressing Ctrl+C shouldn't leave orphaned processes or corrupted state:

```typescript
function setupSignalHandlers(): void {
  let isExiting = false;

  process.on("SIGINT", async () => {
    if (isExiting) {
      // Second Ctrl+C: force exit
      process.exit(1);
    }
    isExiting = true;

    // First Ctrl+C: graceful shutdown
    // Cancel any in-flight API requests
    abortController?.abort();

    // Kill any running child processes (tool executions)
    await killActiveProcesses();

    // Save session state for potential resume
    await saveSessionState();

    process.exit(0);
  });

  // Handle terminal close
  process.on("SIGHUP", () => {
    saveSessionStateSync();
    process.exit(0);
  });

  // Handle uncaught errors
  process.on("uncaughtException", (error) => {
    logFatalError(error);
    process.exit(1);
  });
}
```

The double Ctrl+C pattern is standard in CLI tools: first press attempts graceful shutdown, second press forces immediate exit.

## Session Detection and Resume

Sessions allow users to continue previous conversations:

```typescript
async function resumeSession(sessionId: string): Promise<Session> {
  const sessionPath = path.join(SESSIONS_DIR, `${sessionId}.json`);

  if (!fs.existsSync(sessionPath)) {
    console.error(`Session ${sessionId} not found`);
    process.exit(1);
  }

  const data = JSON.parse(await fs.readFile(sessionPath, "utf-8"));

  return {
    id: data.id,
    messages: data.messages,
    model: data.model,
    cwd: data.cwd,
    createdAt: new Date(data.createdAt),
    resumedAt: new Date(),
  };
}

function createNewSession(): Session {
  return {
    id: crypto.randomUUID(),
    messages: [],
    model: null, // Will be set from config
    cwd: process.cwd(),
    createdAt: new Date(),
    resumedAt: null,
  };
}
```

## Configuration Loading

Config comes from multiple sources, merged in priority order:

```typescript
async function getInitialSettings(cliOpts: CLIOptions): Promise<Settings> {
  // Priority (highest to lowest):
  // 1. CLI flags
  // 2. Environment variables (CLAUDE_CODE_*)
  // 3. Project config (.claude/config.json)
  // 4. User config (~/.claude/settings.json)
  // 5. Defaults

  const defaults = getDefaultSettings();
  const userConfig = await loadUserConfig();
  const projectConfig = await loadProjectConfig();
  const envConfig = loadEnvConfig();
  const cliConfig = parseCLIConfig(cliOpts);

  return deepMerge(defaults, userConfig, projectConfig, envConfig, cliConfig);
}
```

## Non-Interactive Mode

When piped input is detected or `--prompt` is used with `--output-format`, the application skips the React UI entirely:

```typescript
async function runNonInteractive(
  opts: CLIOptions,
  settings: Settings,
  session: Session,
): Promise<void> {
  const prompt = opts.prompt || await readStdin();

  const events = query(
    { role: "user", content: prompt },
    {
      model: settings.model,
      maxTurns: opts.maxTurns ?? Infinity,
      allowedTools: opts.allowedTools ?? [],
    }
  );

  switch (opts.outputFormat) {
    case "json":
      const result = await collectEvents(events);
      console.log(JSON.stringify(result));
      break;

    case "stream-json":
      for await (const event of events) {
        console.log(JSON.stringify(event));
      }
      break;

    default:
      for await (const event of events) {
        if (event.type === "assistant_text") {
          process.stdout.write(event.content);
        }
      }
      break;
  }
}
```

This is how `echo "fix the bug" | claude --output-format json` works — same query engine, no UI.

## The Full Flow

From `claude` to running code:

```
$ claude "fix the tests"
        │
        ▼
   cli.tsx (entry point)
        │
        ├── startCapturingEarlyInput()
        ├── handleFastPaths() — not --version, not MCP, continue
        │
        ▼
   import("./main.js")
        │
        ▼
   main()
        ├── Security setup (Windows DLL protection)
        ├── Commander: parse args → { prompt: "fix the tests" }
        ├── getInitialSettings() → merged config
        ├── setupSignalHandlers() → SIGINT, SIGHUP
        ├── createNewSession() → { id: "abc-123", ... }
        │
        ├── stdin.isTTY? Yes → Interactive mode
        │
        ▼
   launchRepl(opts, settings, session)
        │
        ▼
   React Ink mounts <App> → <REPL>
        │
        ├── flushEarlyInput() → replay buffered keystrokes
        ├── User prompt is submitted
        │
        ▼
   query() → async generator → StreamEvents
        │
        ▼
   Agent loop begins...
```

Every step is deliberate. Fast paths avoid loading unnecessary code. Early input capture prevents lost keystrokes. Dynamic imports defer heavy module loading. Signal handlers ensure graceful shutdown. And at the end, it all funnels into the same `query()` function you studied in the previous lessons.

## Key Takeaways

1. **`cli.tsx` is minimal** — its job is to route to the right mode quickly
2. **Fast paths** prevent loading the full app for simple operations
3. **Early input capture** buffers keystrokes before the UI is ready
4. **Dynamic imports** defer heavy module loading until needed
5. **Security is proactive** — Windows DLL hijacking prevention is set before any tools run
6. **Signal handling** implements graceful shutdown with a force-exit escape hatch
7. **Non-interactive mode** uses the same `query()` engine without any UI

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Fast Path Architecture
**Question:** Why does `cli.tsx` use dynamic `import()` instead of static imports at the top of the file? What would happen to `claude --version` startup time if all imports were static? How does this relate to the general principle of lazy loading?

[View Answer](../../answers/12-architecture-and-advanced/answer-100.md#exercise-1)

### Exercise 2 — Build an Early Input Buffer
**Challenge:** Implement a complete `EarlyInputCapture` class that buffers stdin keystrokes before the application is ready. It should: (1) start capturing immediately when constructed, (2) handle raw mode for TTY terminals, (3) detect Ctrl+C (byte `0x03`) and exit the process, (4) provide a `flush()` method that returns all buffered input and stops capturing, and (5) handle the case where stdin is not a TTY (piped input). Write tests that verify buffered keystrokes are correctly replayed.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-100.md#exercise-2)

### Exercise 3 — Implement Signal Handling
**Challenge:** Write a `SignalManager` class that implements the double Ctrl+C pattern: first press triggers graceful shutdown (cancel in-flight requests, save session, kill child processes), second press forces immediate exit. Include a timeout — if graceful shutdown takes longer than 5 seconds, force exit automatically. The class should accept cleanup callbacks and execute them in order during graceful shutdown.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-100.md#exercise-3)

### Exercise 4 — Build a CLI Router
**Challenge:** Implement a `handleFastPaths` function that supports at least 5 fast-path modes (`--version`, `--help`, `mcp`, `--bridge`, `--daemon`). Each mode should use dynamic imports (simulate with async factory functions). The router must: parse `process.argv`, support both `--flag` and short `-f` forms, handle unknown flags gracefully, and measure + log the time taken for the fast path to complete. Include proper exit codes for each mode.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-100.md#exercise-4)

### Exercise 5 — Non-Interactive Mode with Output Formats
**Challenge:** Implement a `runNonInteractive` function that reads a prompt from either a CLI flag or stdin, runs it through a mock `query()` async generator, and supports three output formats: `text` (plain assistant text to stdout), `json` (collect all events, output a single JSON object), and `stream-json` (output each event as a JSON line / NDJSON). Handle errors by writing to stderr and setting a non-zero exit code. Include a `--max-turns` flag that limits the agent loop.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-100.md#exercise-5)
