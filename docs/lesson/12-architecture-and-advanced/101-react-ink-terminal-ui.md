# Lesson 101: React Ink — The Terminal UI

## React for the Terminal

You know React renders to the DOM. You know React Native renders to mobile views. React Ink renders to the terminal. Same component model, same hooks, same reconciler — different output target.

Instead of `<div>` and `<span>`, you write `<Box>` and `<Text>`. Instead of CSS flexbox in a browser, Ink uses Yoga (Facebook's layout engine) to compute flexbox layouts and renders them as terminal escape codes.

```typescript
import { render, Box, Text } from "ink";

function App() {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="blue">Claude Code</Text>
      <Text dimColor>AI coding agent for your terminal</Text>
    </Box>
  );
}

render(<App />);
```

This renders as styled text in your terminal — bold blue "Claude Code" with dimmed subtitle, proper padding. No curses library. No manual escape codes. Just React.

## Why React in a CLI?

This seems like overkill. Why not just `console.log`? Because Claude Code's terminal UI is complex:

- **Streaming text** that updates in real-time as the model generates
- **Tool execution panels** that show progress and results
- **Permission prompts** that capture user input mid-stream
- **Multi-line input** with syntax highlighting
- **Status bars** showing token counts and model info
- **Error boundaries** that catch rendering failures gracefully

Managing this with `console.log` and ANSI escape codes would be a nightmare. React gives you:

1. **Component model**: Each UI element is isolated and reusable
2. **State management**: `useState` and `useReducer` handle complex state transitions
3. **Effects**: `useEffect` manages side effects like subscriptions and timers
4. **Reconciliation**: Only the parts that changed get re-rendered
5. **Composition**: Build complex UIs from simple pieces

## The Component Tree

Claude Code's terminal UI is a tree of React components:

```
<App>
├── <AppStateProvider>          // Global state context
│   ├── <ErrorBoundary>         // Catch rendering errors
│   │   ├── <REPL>              // Main REPL loop
│   │   │   ├── <MessageHistory>  // Past messages
│   │   │   │   ├── <UserMessage>
│   │   │   │   ├── <AssistantMessage>
│   │   │   │   │   ├── <MarkdownRenderer>
│   │   │   │   │   └── <ToolResults>
│   │   │   │   │       ├── <FileEditResult>
│   │   │   │   │       ├── <BashResult>
│   │   │   │   │       └── <SearchResult>
│   │   │   │   └── <AssistantMessage>
│   │   │   ├── <StreamingMessage>  // Current generation
│   │   │   │   ├── <MarkdownRenderer>
│   │   │   │   └── <Spinner>
│   │   │   ├── <PermissionPrompt>  // Tool approval
│   │   │   └── <InputBox>          // User input
│   │   └── <StatusBar>            // Token count, model info
│   └── <ErrorFallback>
└── <FocusManager>              // Keyboard focus routing
```

## launchRepl(): Mounting the React Tree

The REPL is mounted the same way you'd mount a React app in a browser — just with Ink's `render` instead of `ReactDOM.render`:

```typescript
import { render } from "ink";

async function launchRepl(
  opts: CLIOptions,
  settings: Settings,
  session: Session,
): Promise<void> {
  // Flush any keystrokes captured before the UI was ready
  const earlyInput = flushEarlyInput();

  const { waitUntilExit } = render(
    <AppStateProvider initialSettings={settings} session={session}>
      <App
        initialPrompt={opts.prompt}
        earlyInput={earlyInput}
        session={session}
      />
    </AppStateProvider>,
    {
      // Ink render options
      exitOnCtrlC: false, // We handle Ctrl+C ourselves
    }
  );

  // Block until the app exits
  await waitUntilExit();
}
```

`waitUntilExit()` returns a promise that resolves when the Ink app unmounts. This keeps the process alive for the lifetime of the REPL.

## The REPL Component

The REPL is the heart of the interactive UI. It manages the conversation loop:

```typescript
function REPL({ initialPrompt, earlyInput, session }: REPLProps) {
  const [messages, setMessages] = useState<Message[]>(session.messages);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const appState = useAppState();

  const handleSubmit = useCallback(async (input: string) => {
    const userMessage: MessageParam = { role: "user", content: input };
    setMessages(prev => [...prev, { role: "user", content: input }]);
    setIsStreaming(true);

    const events = query(userMessage, {
      model: appState.model,
      messages: messages,
      tools: appState.tools,
    });

    for await (const event of events) {
      switch (event.type) {
        case "assistant_text":
          setMessages(prev => updateLastAssistant(prev, event.content));
          break;

        case "tool_use":
          setMessages(prev => addToolUse(prev, event));
          break;

        case "permission_request":
          setPendingPermission(event);
          // The generator is paused here — it won't advance
          // until the permission is resolved
          break;

        case "turn_complete":
          setIsStreaming(false);
          break;
      }
    }
  }, [messages, appState]);

  return (
    <Box flexDirection="column">
      <MessageHistory messages={messages} />
      {isStreaming && <StreamingIndicator />}
      {pendingPermission && (
        <PermissionPrompt
          request={pendingPermission}
          onResolve={(granted) => {
            setPendingPermission(null);
            // Permission response is sent back through the generator
          }}
        />
      )}
      <InputBox onSubmit={handleSubmit} earlyInput={earlyInput} />
    </Box>
  );
}
```

## Custom Hooks

Claude Code uses custom hooks to encapsulate complex behavior:

```typescript
function useStreamingText(events: AsyncGenerator<StreamEvent>) {
  const [text, setText] = useState("");
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      for await (const event of events) {
        if (cancelled) break;
        if (event.type === "assistant_text") {
          setText(prev => prev + event.content);
        }
        if (event.type === "turn_complete") {
          setIsComplete(true);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [events]);

  return { text, isComplete };
}
```

```typescript
function useTokenCounter() {
  const [usage, setUsage] = useState<TokenUsage>({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });

  const addUsage = useCallback((turnUsage: TokenUsage) => {
    setUsage(prev => ({
      input: prev.input + turnUsage.input,
      output: prev.output + turnUsage.output,
      cacheRead: prev.cacheRead + turnUsage.cacheRead,
      cacheWrite: prev.cacheWrite + turnUsage.cacheWrite,
    }));
  }, []);

  const cost = useMemo(() => calculateCost(usage), [usage]);

  return { usage, cost, addUsage };
}
```

## The Rendering Pipeline

Here's what happens when React state changes in a terminal app:

```
1. State change: setText("Hello, world!")
         │
         ▼
2. React reconciliation: diff the virtual tree
         │
         ▼
3. Ink layout: Yoga computes flexbox positions
         │
         ▼
4. Ink rendering: convert components to styled strings
         │
         ▼
5. Diff output: compare new output with previous terminal state
         │
         ▼
6. Terminal write: emit ANSI escape codes for changes only
         │
         ▼
7. Terminal displays updated content
```

Step 5 is critical: Ink doesn't clear and redraw the entire terminal on every update. It computes the minimal set of changes (similar to how React computes minimal DOM updates) and only writes the escape codes needed to apply those changes. This prevents flickering and keeps rendering fast.

## Markdown Rendering

Assistant messages are markdown, rendered to terminal with styling:

```typescript
function MarkdownRenderer({ content }: { content: string }) {
  const parsed = parseMarkdown(content);

  return (
    <Box flexDirection="column">
      {parsed.map((block, i) => {
        switch (block.type) {
          case "paragraph":
            return <Text key={i}>{block.text}</Text>;

          case "code":
            return (
              <Box key={i} borderStyle="round" borderColor="gray" padding={1}>
                <Text>
                  {highlightSyntax(block.code, block.language)}
                </Text>
              </Box>
            );

          case "heading":
            return (
              <Text key={i} bold color="blue">
                {"#".repeat(block.level)} {block.text}
              </Text>
            );

          case "list":
            return (
              <Box key={i} flexDirection="column" marginLeft={2}>
                {block.items.map((item, j) => (
                  <Text key={j}>• {item}</Text>
                ))}
              </Box>
            );
        }
      })}
    </Box>
  );
}
```

## Input Handling

The input box handles multi-line editing, history, and key bindings:

```typescript
function InputBox({ onSubmit, earlyInput }: InputBoxProps) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  useInput((value, key) => {
    if (key.return && !key.shift) {
      if (input.trim()) {
        onSubmit(input);
        setHistory(prev => [input, ...prev]);
        setInput("");
        setHistoryIndex(-1);
      }
    } else if (key.upArrow && input === "") {
      // Navigate history
      const newIndex = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(newIndex);
      setInput(history[newIndex] ?? "");
    } else if (key.escape) {
      setInput("");
    } else {
      setInput(prev => prev + value);
    }
  });

  // Replay early input that was captured before the UI was ready
  useEffect(() => {
    if (earlyInput.length > 0) {
      const text = Buffer.concat(earlyInput).toString("utf-8");
      setInput(text);
    }
  }, []);

  return (
    <Box borderStyle="round" borderColor="cyan">
      <Text color="cyan" bold>{"❯ "}</Text>
      <Text>{input}</Text>
      <Cursor />
    </Box>
  );
}
```

## Key Takeaways

1. **React Ink** renders React components to terminal escape codes
2. **Same React** — components, hooks, state, effects, reconciliation
3. **The REPL component** orchestrates the conversation loop with `for await...of`
4. **Custom hooks** encapsulate streaming, token counting, and input handling
5. **Minimal redraws** — Ink diffs terminal output like React diffs the DOM
6. **Markdown rendering** converts assistant output to styled terminal text
7. **Early input replay** ensures keystrokes aren't lost during startup

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — React Ink Rendering Pipeline
**Question:** Describe the 7-step rendering pipeline from a React state change to terminal output in Ink. Why is step 5 (diff output) critical for terminal UIs, and how does it prevent flickering? How does this compare to React DOM's reconciliation?

[View Answer](../../answers/12-architecture-and-advanced/answer-101.md#exercise-1)

### Exercise 2 — Build a Streaming Message Component
**Challenge:** Using React Ink primitives (`Box`, `Text`, and hooks), implement a `StreamingMessage` component that: (1) accepts an `AsyncGenerator<StreamEvent>` as a prop, (2) accumulates `assistant_text` events into displayed text, (3) shows a spinning indicator while streaming is active, (4) displays a "Done" message with token count when `turn_complete` arrives, and (5) properly cleans up the async iteration on unmount. Use the `useStreamingText` custom hook pattern from the lesson.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-101.md#exercise-2)

### Exercise 3 — Build a REPL Input Component
**Challenge:** Implement an `InputBox` component with Ink's `useInput` hook that supports: Enter to submit, Shift+Enter for newline, Escape to clear, Up/Down arrow for history navigation, and replay of early input buffers passed as a prop. The component should display a styled prompt indicator and the current input text with a cursor character.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-101.md#exercise-3)

### Exercise 4 — Build a useTokenCounter Hook
**Challenge:** Implement a `useTokenCounter` custom hook that tracks cumulative token usage across multiple turns. It should accept a `pricing` configuration object and return `{ usage, cost, addUsage, reset }`. The `cost` should be computed with `useMemo` and automatically update when usage or pricing changes. Write a test that simulates 3 turns of token usage and verifies the cumulative cost calculation.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-101.md#exercise-4)

### Exercise 5 — Terminal Markdown Renderer
**Challenge:** Build a `MarkdownRenderer` component that converts a subset of markdown to styled Ink components. Support: headings (bold, colored by level), paragraphs (plain text), code blocks (bordered box with syntax language label), bullet lists (indented with bullet character), and bold/italic inline formatting. The renderer should accept a raw markdown string and output a `Box` containing the parsed and styled elements.

Write your solution in your IDE first, then check:

[View Answer](../../answers/12-architecture-and-advanced/answer-101.md#exercise-5)
