# Answers: Lesson 101 — React Ink Terminal UI

## Exercise 1
**Question:** Describe the 7-step rendering pipeline from a React state change to terminal output in Ink. Why is step 5 (diff output) critical for terminal UIs, and how does it prevent flickering? How does this compare to React DOM's reconciliation?

**Answer:** The pipeline is: (1) a state change triggers a re-render, (2) React reconciles the virtual component tree by diffing old and new virtual trees, (3) Ink passes the reconciled tree to Yoga (Facebook's layout engine) which computes flexbox positions for each element, (4) Ink converts the positioned components into styled strings with ANSI escape codes, (5) Ink diffs the new terminal output against the previously rendered output, (6) only the changed characters are written to the terminal using cursor positioning escape codes, (7) the terminal displays the updated content. Step 5 is critical because terminals don't have a DOM — if you clear and redraw everything on each update, the screen flickers visibly. By computing the minimal diff of character changes, Ink only moves the cursor to positions that changed and overwrites those specific characters. This is analogous to React DOM's reconciliation (step 2), but at a lower level: React DOM diffs the virtual DOM to compute minimal DOM mutations, while Ink diffs the final rendered string output to compute minimal terminal writes. Both avoid unnecessary full redraws.

---

## Exercise 2
**Challenge:** Build a `StreamingMessage` component with async generator consumption and cleanup.

**Answer:**

```typescript
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

interface StreamEvent {
  type: string;
  content?: string;
  usage?: { input: number; output: number };
}

function useStreamingText(events: AsyncGenerator<StreamEvent> | null) {
  const [text, setText] = useState("");
  const [isComplete, setIsComplete] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<{ input: number; output: number } | null>(null);

  useEffect(() => {
    if (!events) return;
    let cancelled = false;

    (async () => {
      try {
        for await (const event of events) {
          if (cancelled) break;

          if (event.type === "assistant_text" && event.content) {
            setText(prev => prev + event.content);
          }
          if (event.type === "turn_complete") {
            setIsComplete(true);
            if (event.usage) setTokenUsage(event.usage);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setText(prev => prev + `\n[Error: ${error}]`);
          setIsComplete(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [events]);

  return { text, isComplete, tokenUsage };
}

function StreamingMessage({
  events,
}: {
  events: AsyncGenerator<StreamEvent> | null;
}) {
  const { text, isComplete, tokenUsage } = useStreamingText(events);

  return (
    <Box flexDirection="column">
      {text && <Text>{text}</Text>}

      {!isComplete && (
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text dimColor> Generating...</Text>
        </Box>
      )}

      {isComplete && tokenUsage && (
        <Box marginTop={1}>
          <Text dimColor>
            Done — {tokenUsage.input} input tokens, {tokenUsage.output} output tokens
          </Text>
        </Box>
      )}
    </Box>
  );
}
```

**Explanation:** The `useStreamingText` hook encapsulates the async iteration logic. The `cancelled` flag ensures that if the component unmounts mid-stream, the async loop stops and no state updates occur on an unmounted component. The component renders three states: streaming text (accumulated from events), a spinner while not complete, and a summary line with token usage once finished. The cleanup function in `useEffect` sets `cancelled = true` so the `for await` loop exits on the next iteration.

---

## Exercise 3
**Challenge:** Build an `InputBox` component with history navigation and early input replay.

**Answer:**

```typescript
import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";

interface InputBoxProps {
  onSubmit: (input: string) => void;
  earlyInput?: Buffer[];
  prompt?: string;
}

function InputBox({ onSubmit, earlyInput, prompt = "❯" }: InputBoxProps) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [cursorVisible, setCursorVisible] = useState(true);

  // Blink cursor
  useEffect(() => {
    const timer = setInterval(() => setCursorVisible(v => !v), 530);
    return () => clearInterval(timer);
  }, []);

  // Replay early input
  useEffect(() => {
    if (earlyInput && earlyInput.length > 0) {
      const text = Buffer.concat(earlyInput).toString("utf-8");
      setInput(text);
    }
  }, []);

  useInput((value, key) => {
    if (key.return && !key.shift) {
      // Submit on Enter
      if (input.trim()) {
        onSubmit(input);
        setHistory(prev => [input, ...prev]);
        setInput("");
        setHistoryIndex(-1);
      }
    } else if (key.return && key.shift) {
      // Newline on Shift+Enter
      setInput(prev => prev + "\n");
    } else if (key.escape) {
      // Clear on Escape
      setInput("");
      setHistoryIndex(-1);
    } else if (key.upArrow) {
      // Navigate history up
      if (history.length === 0) return;
      const newIndex = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(newIndex);
      setInput(history[newIndex] ?? "");
    } else if (key.downArrow) {
      // Navigate history down
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setInput("");
      } else {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInput(history[newIndex] ?? "");
      }
    } else if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1));
    } else if (!key.ctrl && !key.meta && value) {
      setInput(prev => prev + value);
    }
  });

  const cursor = cursorVisible ? "█" : " ";

  return (
    <Box borderStyle="round" borderColor="cyan">
      <Text color="cyan" bold>{`${prompt} `}</Text>
      <Text>{input}</Text>
      <Text color="cyan">{cursor}</Text>
    </Box>
  );
}
```

**Explanation:** The component manages input text, history array, and history navigation index as state. `useInput` from Ink provides key event handling. History navigation uses an index that increments/decrements to walk through previously submitted inputs. Early input replay happens in a `useEffect` that runs once on mount — it concatenates the buffered keystrokes and sets them as the initial input value. The cursor blinks using a `setInterval` effect that toggles visibility.

---

## Exercise 4
**Challenge:** Build a `useTokenCounter` hook with cumulative tracking and cost calculation.

**Answer:**

```typescript
import { useState, useCallback, useMemo } from "react";

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Pricing {
  inputPer1k: number;
  outputPer1k: number;
  cacheReadPer1k: number;
  cacheWritePer1k: number;
}

function useTokenCounter(pricing: Pricing) {
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

  const reset = useCallback(() => {
    setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  }, []);

  const cost = useMemo(() => {
    return (
      (usage.input * pricing.inputPer1k) / 1000 +
      (usage.output * pricing.outputPer1k) / 1000 +
      (usage.cacheRead * pricing.cacheReadPer1k) / 1000 +
      (usage.cacheWrite * pricing.cacheWritePer1k) / 1000
    );
  }, [usage, pricing]);

  return { usage, cost, addUsage, reset };
}

// Test scenario
function testTokenCounter() {
  const pricing: Pricing = {
    inputPer1k: 0.003,
    outputPer1k: 0.015,
    cacheReadPer1k: 0.0003,
    cacheWritePer1k: 0.00375,
  };

  // Simulated 3 turns:
  // Turn 1: 1000 input, 500 output, 0 cache
  // Turn 2: 800 input, 300 output, 200 cacheRead, 100 cacheWrite
  // Turn 3: 1200 input, 700 output, 500 cacheRead, 0 cacheWrite

  // Expected totals: 3000 input, 1500 output, 700 cacheRead, 100 cacheWrite
  // Cost = (3000*0.003 + 1500*0.015 + 700*0.0003 + 100*0.00375) / 1000
  //      = (9.0 + 22.5 + 0.21 + 0.375) / 1000 = 0.032085

  // In a real test, you'd render a component using the hook and
  // call addUsage three times, then assert cost equals 0.032085
}
```

**Explanation:** The hook uses `useState` for the cumulative token counts and `useMemo` for the derived cost, which recomputes only when `usage` or `pricing` changes. `useCallback` wraps `addUsage` and `reset` to maintain referential stability. The cost formula multiplies each token type by its per-1k rate and divides by 1000. The test scenario shows three turns of usage that should accumulate correctly.

---

## Exercise 5
**Challenge:** Build a terminal markdown renderer using Ink components.

**Answer:**

```typescript
import React from "react";
import { Box, Text } from "ink";

interface MarkdownBlock {
  type: "heading" | "paragraph" | "code" | "list";
  level?: number;
  text?: string;
  code?: string;
  language?: string;
  items?: string[];
}

function parseMarkdown(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2],
      });
      i++;
      continue;
    }

    // Code blocks
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", code: codeLines.join("\n"), language });
      i++; // skip closing ```
      continue;
    }

    // Lists
    if (line.match(/^[-*]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*]\s+/)) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    // Paragraphs (non-empty lines)
    if (line.trim()) {
      const paraLines: string[] = [];
      while (i < lines.length && lines[i].trim() && !lines[i].startsWith("#")) {
        paraLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "paragraph", text: paraLines.join(" ") });
      continue;
    }

    i++;
  }

  return blocks;
}

const HEADING_COLORS = ["blue", "green", "yellow", "cyan", "magenta", "white"];

function MarkdownRenderer({ content }: { content: string }) {
  const blocks = parseMarkdown(content);

  return (
    <Box flexDirection="column" gap={1}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading":
            return (
              <Text
                key={i}
                bold
                color={HEADING_COLORS[(block.level ?? 1) - 1] ?? "white"}
              >
                {"#".repeat(block.level ?? 1)} {block.text}
              </Text>
            );

          case "paragraph":
            return <Text key={i}>{formatInline(block.text ?? "")}</Text>;

          case "code":
            return (
              <Box
                key={i}
                borderStyle="round"
                borderColor="gray"
                flexDirection="column"
                paddingX={1}
              >
                {block.language && (
                  <Text dimColor>{block.language}</Text>
                )}
                <Text>{block.code}</Text>
              </Box>
            );

          case "list":
            return (
              <Box key={i} flexDirection="column" marginLeft={2}>
                {block.items?.map((item, j) => (
                  <Text key={j}>• {formatInline(item)}</Text>
                ))}
              </Box>
            );
        }
      })}
    </Box>
  );
}

function formatInline(text: string): React.ReactNode {
  // Simple bold/italic detection (no nesting)
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    const italicMatch = remaining.match(/\*(.+?)\*/);

    const match = boldMatch && (!italicMatch || boldMatch.index! <= italicMatch.index!)
      ? boldMatch
      : italicMatch;

    if (match && match.index !== undefined) {
      if (match.index > 0) {
        parts.push(<Text key={key++}>{remaining.slice(0, match.index)}</Text>);
      }
      const isBold = match[0].startsWith("**");
      parts.push(
        isBold
          ? <Text key={key++} bold>{match[1]}</Text>
          : <Text key={key++} italic>{match[1]}</Text>
      );
      remaining = remaining.slice(match.index + match[0].length);
    } else {
      parts.push(<Text key={key++}>{remaining}</Text>);
      break;
    }
  }

  return <>{parts}</>;
}
```

**Explanation:** The renderer has two stages: parsing markdown into a structured `MarkdownBlock` array, then rendering each block to the appropriate Ink component. Headings get bold text colored by level. Code blocks are wrapped in a bordered `Box` with the language label. Lists are indented with bullet characters. The `formatInline` function handles bold (`**text**`) and italic (`*text*`) by splitting the text into segments and wrapping matched portions in `<Text bold>` or `<Text italic>`. This approach mirrors how Claude Code's actual markdown renderer works — parse first, render second.
