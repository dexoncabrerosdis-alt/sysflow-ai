# Answers: Lesson 100 — The CLI Entry Point

## Exercise 1
**Question:** Why does `cli.tsx` use dynamic `import()` instead of static imports at the top of the file? What would happen to `claude --version` startup time if all imports were static? How does this relate to the general principle of lazy loading?

**Answer:** Static `import` statements at the top of a file are evaluated eagerly — Node must load, parse, and execute every imported module (and their transitive dependencies) before any code in the file runs. If `cli.tsx` statically imported `main.js`, which imports React, Ink, the tool system, the API client, Zod schemas, and MCP libraries, then even `claude --version` would pay the cost of loading all those modules — potentially adding 1-2 seconds of startup time. Dynamic `import()` defers module loading to the moment the code path is actually reached. This is the general principle of lazy loading: don't pay for what you don't use. The fast path for `--version` only needs to read a constant and print it, so it should complete in milliseconds. Dynamic imports ensure that the heavy application code is only loaded when the user actually needs the full REPL or agent loop.

---

## Exercise 2
**Challenge:** Implement a complete `EarlyInputCapture` class that buffers stdin keystrokes before the application is ready.

**Answer:**

```typescript
class EarlyInputCapture {
  private buffer: Buffer[] = [];
  private capturing = false;
  private dataHandler: ((chunk: Buffer) => void) | null = null;

  start(): void {
    if (!process.stdin.isTTY) {
      return; // Piped input — don't capture in raw mode
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    this.capturing = true;

    this.dataHandler = (chunk: Buffer) => {
      if (!this.capturing) return;

      // Detect Ctrl+C (byte 0x03) — exit immediately
      if (chunk.length === 1 && chunk[0] === 0x03) {
        process.stdin.setRawMode(false);
        process.exit(130); // 128 + SIGINT(2) = 130
      }

      this.buffer.push(chunk);
    };

    process.stdin.on("data", this.dataHandler);
  }

  flush(): Buffer[] {
    this.capturing = false;

    if (this.dataHandler) {
      process.stdin.removeListener("data", this.dataHandler);
      this.dataHandler = null;
    }

    const buffered = this.buffer;
    this.buffer = [];
    return buffered;
  }

  get isCapturing(): boolean {
    return this.capturing;
  }

  get bufferedLength(): number {
    return this.buffer.reduce((sum, buf) => sum + buf.length, 0);
  }
}

// Usage at startup
const earlyInput = new EarlyInputCapture();
earlyInput.start();

// ... later, when the REPL is ready:
const buffered = earlyInput.flush();
const text = Buffer.concat(buffered).toString("utf-8");
inputBox.setInitialValue(text);
```

**Explanation:** The class immediately sets stdin to raw mode (so keystrokes arrive individually without waiting for Enter) and begins buffering chunks. Ctrl+C detection is critical — without it, the user couldn't interrupt the application during the loading phase. The `flush()` method returns all buffered data and detaches the listener so the REPL's own input handler can take over. For piped input (not a TTY), raw mode isn't set because the input isn't interactive keystrokes.

---

## Exercise 3
**Challenge:** Write a `SignalManager` class with double Ctrl+C pattern and graceful shutdown.

**Answer:**

```typescript
type CleanupFn = () => Promise<void>;

class SignalManager {
  private cleanupFns: CleanupFn[] = [];
  private isShuttingDown = false;
  private forceTimeoutMs: number;

  constructor(options: { forceTimeoutMs?: number } = {}) {
    this.forceTimeoutMs = options.forceTimeoutMs ?? 5000;
  }

  onCleanup(fn: CleanupFn): void {
    this.cleanupFns.push(fn);
  }

  install(): void {
    process.on("SIGINT", () => this.handleSigint());
    process.on("SIGHUP", () => this.handleSighup());
    process.on("uncaughtException", (error) => {
      console.error("Fatal error:", error.message);
      process.exit(1);
    });
  }

  private async handleSigint(): Promise<void> {
    if (this.isShuttingDown) {
      console.error("\nForce exiting...");
      process.exit(1);
    }

    this.isShuttingDown = true;
    console.error("\nShutting down gracefully... (press Ctrl+C again to force)");

    const forceTimer = setTimeout(() => {
      console.error("\nGraceful shutdown timed out. Force exiting.");
      process.exit(1);
    }, this.forceTimeoutMs);

    try {
      for (const fn of this.cleanupFns) {
        await fn();
      }
    } catch (error) {
      console.error("Error during cleanup:", error);
    } finally {
      clearTimeout(forceTimer);
      process.exit(0);
    }
  }

  private handleSighup(): void {
    // Terminal closed — synchronous cleanup only
    for (const fn of this.cleanupFns) {
      try {
        // Best-effort synchronous cleanup
        fn().catch(() => {});
      } catch {}
    }
    process.exit(0);
  }
}

// Usage
const signals = new SignalManager({ forceTimeoutMs: 5000 });
signals.onCleanup(async () => {
  abortController.abort(); // Cancel in-flight API requests
});
signals.onCleanup(async () => {
  await killActiveProcesses(); // Kill tool child processes
});
signals.onCleanup(async () => {
  await saveSessionState(session); // Persist session for resume
});
signals.install();
```

**Explanation:** The `isShuttingDown` flag implements the double Ctrl+C pattern: first press sets the flag and begins graceful shutdown, second press checks the flag and force-exits. The `forceTimer` ensures that even if cleanup callbacks hang (e.g., a network request that won't complete), the process exits after 5 seconds. Cleanup functions are executed in registration order, allowing prioritization (cancel requests first, then kill processes, then save state). SIGHUP (terminal close) does best-effort cleanup without waiting.

---

## Exercise 4
**Challenge:** Build a CLI router with fast paths, dynamic imports, short flags, and timing.

**Answer:**

```typescript
interface FastPathHandler {
  flags: string[];
  description: string;
  handler: () => Promise<void>;
}

const FAST_PATHS: FastPathHandler[] = [
  {
    flags: ["--version", "-v"],
    description: "Print version and exit",
    handler: async () => {
      const VERSION = "1.0.0";
      console.log(VERSION);
    },
  },
  {
    flags: ["--help", "-h"],
    description: "Print usage and exit",
    handler: async () => {
      const { printUsage } = await import("./help.js");
      printUsage();
    },
  },
  {
    flags: ["mcp", "--mcp"],
    description: "Run as MCP server",
    handler: async () => {
      const { runMcpServer } = await import("./mcp-server/index.js");
      await runMcpServer();
    },
  },
  {
    flags: ["--bridge", "-b"],
    description: "Run in bridge mode",
    handler: async () => {
      const { runBridge } = await import("./bridge.js");
      await runBridge();
    },
  },
  {
    flags: ["--daemon", "-d"],
    description: "Run as background daemon",
    handler: async () => {
      const { runDaemon } = await import("./daemon.js");
      await runDaemon();
    },
  },
];

async function handleFastPaths(): Promise<boolean> {
  const args = process.argv.slice(2);

  for (const fastPath of FAST_PATHS) {
    const matched = fastPath.flags.some(flag => args.includes(flag));
    if (!matched) continue;

    const start = performance.now();

    try {
      await fastPath.handler();
      const elapsed = (performance.now() - start).toFixed(1);
      if (process.env.CLAUDE_DEBUG) {
        console.error(`[fast-path] ${fastPath.flags[0]} completed in ${elapsed}ms`);
      }
      process.exit(0);
    } catch (error) {
      console.error(`Error in fast path ${fastPath.flags[0]}:`, error);
      process.exit(1);
    }
  }

  // Check for unknown flags
  const unknownFlags = args.filter(
    a => a.startsWith("-") && !FAST_PATHS.some(fp => fp.flags.includes(a))
  );
  if (unknownFlags.length > 0) {
    const known = FAST_PATHS.flatMap(fp => fp.flags).join(", ");
    // Don't error — unknown flags are passed to Commander in main()
  }

  return false; // No fast path matched
}
```

**Explanation:** The router iterates through registered fast paths and checks if any of their flags appear in `process.argv`. Each handler uses dynamic imports so only the matched mode's code is loaded. Timing is measured with `performance.now()` and logged when `CLAUDE_DEBUG` is set. Exit codes distinguish success (0) from failure (1). Unknown flags aren't rejected here because they may be valid Commander flags handled later in `main()`.

---

## Exercise 5
**Challenge:** Implement `runNonInteractive` with three output formats and error handling.

**Answer:**

```typescript
interface NonInteractiveOptions {
  prompt?: string;
  outputFormat: "text" | "json" | "stream-json";
  model: string;
  maxTurns: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function runNonInteractive(options: NonInteractiveOptions): Promise<void> {
  const prompt = options.prompt || await readStdin();

  if (!prompt) {
    console.error("Error: No prompt provided. Use --prompt or pipe input.");
    process.exit(1);
  }

  const events = query(
    { role: "user", content: prompt },
    {
      model: options.model,
      maxTurns: options.maxTurns,
      permissions: "auto-approve-all",
    }
  );

  try {
    switch (options.outputFormat) {
      case "text": {
        for await (const event of events) {
          if (event.type === "assistant_text") {
            process.stdout.write(event.content);
          }
          if (event.type === "error") {
            console.error(`\nError: ${event.error.message}`);
            process.exit(1);
          }
        }
        process.stdout.write("\n");
        break;
      }

      case "json": {
        let text = "";
        const toolResults: unknown[] = [];
        let usage = { input: 0, output: 0 };

        for await (const event of events) {
          switch (event.type) {
            case "assistant_text":
              text += event.content;
              break;
            case "tool_result":
              toolResults.push({ tool: event.tool, result: event.result });
              break;
            case "turn_complete":
              usage = event.usage;
              break;
            case "error":
              console.error(JSON.stringify({ error: event.error.message }));
              process.exit(1);
          }
        }

        console.log(JSON.stringify({ text, toolResults, usage }, null, 2));
        break;
      }

      case "stream-json": {
        for await (const event of events) {
          console.log(JSON.stringify(event));

          if (event.type === "error") {
            process.exit(1);
          }
        }
        break;
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      })
    );
    process.exit(1);
  }
}
```

**Explanation:** The function first resolves the prompt from either a CLI flag or stdin (for piped input like `echo "fix bug" | claude`). The three output formats serve different use cases: `text` is human-readable, `json` collects everything into a single structured object (useful for scripting), and `stream-json` outputs one JSON object per line in NDJSON format (useful for real-time processing by other tools). Errors are written to stderr and trigger non-zero exit codes so shell scripts can detect failures. The `auto-approve-all` permission mode is appropriate for non-interactive/CI use where there's no human to prompt.
