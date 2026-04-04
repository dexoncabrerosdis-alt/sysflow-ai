# Lesson 54: Output Style and Efficiency

## The Verbosity Problem

Language models are trained on human text, which tends to be verbose, polite, and repetitive. Without explicit guidance, a coding agent produces responses like:

```
Great question! I'd be happy to help you with that. Let me take a look
at the file you mentioned. I'll start by reading it to understand the
current implementation, and then I'll suggest some changes that might
help resolve the issue you're experiencing.

[reads file]

Okay, I've read the file! Here's what I found. The file contains a
React component that renders a form. I noticed that on line 42, there's
a potential issue with the state management. Let me explain what's
happening and then I'll propose a fix...
```

This wastes tokens (the user pays for them), wastes screen space, and wastes time. The output style and efficiency sections exist to prevent this.

## getOutputEfficiencySection()

This section establishes the rules for concise output:

```typescript
function getOutputEfficiencySection(): string {
  return `## Output Efficiency

Your responses should be concise and focused. Follow these rules:

- Do NOT start responses with filler phrases like "Great question!",
  "Sure, I'd be happy to help!", "Of course!", or "Certainly!".
- Do NOT repeat the user's question back to them.
- Do NOT narrate your thought process unless the user asks you to
  explain your reasoning.
- When showing code changes, show ONLY the changed lines with
  enough context to locate the change (typically 2-3 lines above
  and below). Do NOT reproduce entire files.
- When reporting tool results, summarize the key findings.
  Do NOT paste raw tool output unless the user asks for it.
- Use markdown formatting (code blocks, lists, headers) only
  when it genuinely improves readability. Not every response
  needs headers.
- If the answer is simple, give a simple answer. One sentence
  is fine when one sentence suffices.`;
}
```

### Before and After

```typescript
// WITHOUT efficiency instructions:
// User: "What's in package.json?"
// Agent: "I'll read the package.json file for you to see what's inside.
//         Let me go ahead and do that now.
//         [reads file]
//         I've successfully read the package.json file! Here's a summary
//         of what I found:
//         ## package.json Contents
//         ### Name and Version
//         The package is named 'my-app' at version 1.0.0.
//         ### Dependencies
//         Here are the dependencies listed in the file:
//         ..."

// WITH efficiency instructions:
// User: "What's in package.json?"
// Agent: [reads file]
// Agent: "my-app v1.0.0. Dependencies: react, next, prisma.
//         Dev deps: typescript, vitest, eslint. Scripts: dev, build,
//         test, lint."
```

## getSimpleToneAndStyleSection()

While efficiency controls *volume*, tone and style controls *how* the model communicates:

```typescript
function getSimpleToneAndStyleSection(): string {
  return `## Tone and Style

- Be direct. Get to the point immediately.
- Use a professional, collaborative tone — like a senior
  engineer pair-programming with the user.
- Do not be sycophantic. Skip praise for questions.
- When explaining code changes, focus on WHAT changed and
  WHY, not a line-by-line walkthrough.
- Use technical terminology accurately. Don't simplify
  for the sake of simplification — the user is a developer.
- When uncertain, say so directly rather than hedging with
  "It's possible that..." or "You might want to consider..."
  Just state the uncertainty and your best recommendation.
- Use code blocks for any code, file paths, commands, or
  technical identifiers. Do not use code blocks for emphasis
  on regular English words.`;
}
```

The tone section sets the **persona** — not a bubbly assistant but a competent engineer who communicates efficiently.

## Output Style Configuration

Beyond the default style, Claude Code supports configurable output preferences:

```typescript
interface OutputStyleConfig {
  verbosity: "concise" | "normal" | "verbose";
  codeComments: boolean;
  explanations: "minimal" | "standard" | "detailed";
  markdown: boolean;
}

function getOutputStyleConfig(config: OutputStyleConfig): string {
  const parts: string[] = [];

  switch (config.verbosity) {
    case "concise":
      parts.push(
        "Be extremely concise. One-line answers when possible. " +
        "Skip all pleasantries and meta-commentary."
      );
      break;
    case "verbose":
      parts.push(
        "Provide detailed explanations. Include reasoning, " +
        "alternatives considered, and potential trade-offs."
      );
      break;
    default:
      parts.push(
        "Use moderate verbosity. Explain non-obvious decisions " +
        "but skip obvious narration."
      );
  }

  if (!config.codeComments) {
    parts.push(
      "Do NOT add comments to code unless they explain " +
      "non-obvious logic. Avoid narrating what the code does."
    );
  }

  switch (config.explanations) {
    case "minimal":
      parts.push(
        "Only explain when asked. Let the code speak for itself."
      );
      break;
    case "detailed":
      parts.push(
        "Explain each significant change: what it does, why " +
        "it's needed, and any alternatives you considered."
      );
      break;
  }

  if (!config.markdown) {
    parts.push(
      "Minimize markdown formatting. Use plain text where possible. " +
      "Only use code blocks for actual code."
    );
  }

  return parts.join("\n");
}
```

## The keepCodingInstructions Flag

Some configurations prioritize continuous coding without pausing for explanations:

```typescript
function getKeepCodingInstructions(): string {
  return `## Continuous Coding Mode

When working on a multi-step task:
- Complete all steps without pausing for confirmation
  unless a step is destructive or ambiguous.
- Do not summarize each step as you go. Report results
  at the end.
- If you encounter an error, try to fix it yourself
  before reporting to the user.
- Keep working until the task is complete or you are
  genuinely stuck.

Only stop and ask when:
- The task is ambiguous and could go multiple ways
- A destructive operation needs confirmation
- You've exhausted your approaches and need input`;
}
```

This changes the agent's behavior from step-by-step with confirmations to flowing task completion:

```typescript
// Without keepCoding:
// Agent: "I'll start by reading the file."
// [reads file]
// Agent: "I found the issue. Should I fix it?"
// User: "Yes"
// Agent: "I'll update the function. Here's what I'll change..."
// [edits file]
// Agent: "Done! Should I run the tests?"
// User: "Yes"

// With keepCoding:
// Agent: [reads file, identifies issue, fixes it, runs tests]
// Agent: "Fixed the null check on line 42 in auth.ts.
//         Tests pass (24/24)."
```

## Brief Mode

An even more extreme conciseness setting:

```typescript
function getBriefModeInstructions(): string {
  return `## Brief Mode

You are in brief mode. Extreme conciseness is required:
- Maximum 3 sentences for any explanation.
- Prefer bullet points over paragraphs.
- Code changes: show diff-style output only.
- Tool results: one-line summaries.
- Skip all greetings, confirmations, and wrap-up text.
- If the task is done, just say "Done." or report
  the result in one line.`;
}
```

## Language Preference

The system prompt can instruct the model to respond in a specific language:

```typescript
function getLanguageSection(
  language: string | null
): string {
  if (!language) return "";

  return `## Language

Respond in ${language}. Use ${language} for all explanations,
questions, and commentary. Code itself (variable names,
comments in code) should remain in English unless the user
explicitly requests otherwise.`;
}
```

This is important for international users. The model's code stays in English (for compatibility), but its communication adapts:

```
// Language: Japanese
// User: "テストを追加して" (Add tests)
// Agent: "テストファイルを作成します。" (I'll create a test file.)
// [creates file with English code, Japanese explanation]
```

## How These Sections Interact

The style sections form a layered system. More specific instructions override more general ones:

```typescript
function assembleStyleSections(config: AgentConfig): string[] {
  const sections: string[] = [];

  // Base layer: always included
  sections.push(getOutputEfficiencySection());
  sections.push(getSimpleToneAndStyleSection());

  // Configuration layer: based on settings
  if (config.outputStyle) {
    sections.push(getOutputStyleConfig(config.outputStyle));
  }

  // Mode layer: brief or keepCoding override defaults
  if (config.briefMode) {
    sections.push(getBriefModeInstructions());
  }

  if (config.keepCoding) {
    sections.push(getKeepCodingInstructions());
  }

  // Language: always last (applies to all output)
  if (config.language) {
    sections.push(getLanguageSection(config.language));
  }

  return sections;
}
```

The layering means:
1. **Efficiency** rules always apply (no filler, no repetition)
2. **Tone** always applies (professional, direct)
3. **Style config** adjusts verbosity within those bounds
4. **Brief/keepCoding** modes tighten further
5. **Language** wraps the final output

## Measuring Output Quality

You can evaluate the effectiveness of style instructions by measuring output characteristics:

```typescript
interface OutputMetrics {
  tokenCount: number;
  fillerPhraseCount: number;
  codeBlockCount: number;
  questionCount: number;
  averageSentenceLength: number;
}

function analyzeOutput(response: string): OutputMetrics {
  const fillerPhrases = [
    "I'd be happy to",
    "Great question",
    "Sure thing",
    "Of course",
    "Let me",
    "I'll go ahead and",
    "Certainly",
  ];

  return {
    tokenCount: estimateTokens(response),
    fillerPhraseCount: fillerPhrases.reduce(
      (count, phrase) =>
        count + (response.toLowerCase().includes(phrase.toLowerCase()) ? 1 : 0),
      0
    ),
    codeBlockCount: (response.match(/```/g) || []).length / 2,
    questionCount: (response.match(/\?/g) || []).length,
    averageSentenceLength:
      response.split(/[.!?]+/).reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) /
      (response.split(/[.!?]+/).length || 1),
  };
}
```

Good metrics for a coding agent:
- Low filler phrase count (ideally 0)
- Token count proportional to task complexity
- Code blocks only for actual code
- Few questions (agent should act, not ask)

## Common Anti-Patterns

### The Over-Eager Helper

```
// BAD: Efficiency rules prevent this
"Absolutely! I'd love to help you fix that bug! Let me dive right
in and take a look at the code. This is going to be fun! 🚀"
```

### The Narrating Professor

```
// BAD: Tone rules prevent this
"First, let me explain what I'm going to do. I'm going to open the
file, which means I'll use the FileRead tool to access its contents.
Then, I'll analyze the code to find the issue. After that..."
```

### The Wall of Code

```
// BAD: Output rules prevent this
"Here's the complete updated file:"
[entire 500-line file, 3 lines changed]
```

### The Hedge Machine

```
// BAD: Directness rules prevent this
"It's possible that there might be a potential issue that could
perhaps be related to what seems like it might be a null reference
that possibly occurs under certain conditions."
```

## What's Next

You now understand how every section of the system prompt works individually: identity, tools, environment, memory, and output style. In Lesson 55, we'll see how all these pieces come together in the **prompt assembly pipeline** — the `buildEffectiveSystemPrompt()` function that turns configuration into a complete, cache-optimized prompt.

---

## Practice Exercises

> **Remember**: Try each exercise before looking at the answer. Write knowledge answers in your notebook. Code challenges go in your IDE.

### Exercise 1 — Before and After
**Question:** Rewrite this model response to comply with the output efficiency rules: "Great question! I'd be happy to help you with that. Let me take a look at the package.json file to see what dependencies you have. I'll use the FileRead tool to read it now. [reads file] Okay, I've successfully read the file! Here's what I found. The package is named 'my-app' at version 2.0.0. Here are all the dependencies listed..."

[View Answer](../../answers/05-prompt-engineering/answer-54.md#exercise-1)

### Exercise 2 — Style Layer Ordering
**Question:** Explain the five-layer style system (efficiency → tone → style config → brief/keepCoding → language) and why they're applied in this order. What would go wrong if the language layer were applied first?

[View Answer](../../answers/05-prompt-engineering/answer-54.md#exercise-2)

### Exercise 3 — Output Style Config Generator
**Challenge:** Write a `getOutputStyleConfig(config: {verbosity: "concise" | "normal" | "verbose", codeComments: boolean, explanations: "minimal" | "standard" | "detailed"}): string` function that generates the appropriate style instructions for each configuration combination.

Write your solution in your IDE first, then check:

[View Answer](../../answers/05-prompt-engineering/answer-54.md#exercise-3)

### Exercise 4 — Identify Anti-Patterns
**Question:** Identify which of the four anti-patterns (Over-Eager Helper, Narrating Professor, Wall of Code, Hedge Machine) each response exhibits, and write a corrected version: (a) "Absolutely! Let me dive into that for you! 🚀" (b) "It's possible that there might perhaps be a null reference issue that could potentially cause problems." (c) "Here's the complete updated file: [entire 200-line file with 2 lines changed]"

[View Answer](../../answers/05-prompt-engineering/answer-54.md#exercise-4)
