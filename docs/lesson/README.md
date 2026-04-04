# Claude Code: End-to-End Course — From Beginner to Professional

A comprehensive 108-lesson course that teaches you how AI coding agents work by studying the architecture and implementation of Claude Code — one of the most sophisticated AI coding agents ever built.

## Who This Course Is For

- **Beginners** who want to understand how AI coding agents work under the hood
- **Intermediate developers** who want to build their own AI agents
- **Advanced engineers** who want to match the quality of production-grade AI systems

## Before You Begin — Read This First

### Grab a Notebook and Pen

Seriously. Before you open Lesson 01, get a **physical notebook and a pen**. Not a notes app — a real notebook.

After every lesson, **write down in your own words**:
1. The one main concept you learned
2. One thing that surprised you
3. One question you still have

This takes 2 minutes per lesson. It is the single most effective thing you can do to retain what you learn. Your brain builds muscle memory through writing, not just reading.

### How the Exercises Work

Every lesson ends with a **Practice Exercises** section. There are two types:

**Type 1: Knowledge Questions** — These test your understanding. Read the question, think about your answer (write it in your notebook!), then click the answer link to check yourself.

**Type 2: Code Challenges** — These ask you to write actual code. Open your IDE/editor, write the code, test it if you can, then click the answer link to compare. Don't peek at the answer first — struggling is how you learn.

Answers are in the `answers/` folder, organized by module. Each answer file contains all answers for that lesson.

> **The Rule**: Try EVERY exercise before looking at the answer. If you skip exercises, you will forget 80% of what you read within a week. If you do them, you'll remember 80% a month later. Your choice.

### Set Up Your Learning Environment

1. A text editor or IDE (VS Code, Cursor, etc.)
2. Node.js or Bun installed (for running code examples)
3. A terminal window open
4. Your notebook and pen next to your keyboard

---

## How to Read This Course

Lessons are designed to be read **in order**. Each lesson builds on concepts introduced in previous ones. Don't skip ahead — concepts are only explained when they're first introduced.

Each lesson includes:
- Simple explanations of new concepts
- Simplified code examples to build intuition
- Real code from Claude Code showing how it's done in production
- **Practice exercises** with linked answers (knowledge questions + code challenges)
- Key takeaways and what to remember

---

## Course Outline

### Module 01 — Foundations
*What are AI coding agents? How do they work at a high level?*

| # | Lesson | What You'll Learn |
|---|--------|------------------|
| 01 | [What Is an AI Coding Agent?](./01-foundations/01-what-is-an-ai-coding-agent.md) | The basic concept of an AI that writes code |
| 02 | [The Terminal and CLI Basics](./01-foundations/02-terminal-and-cli-basics.md) | How command-line interfaces work |
| 03 | [How LLMs Generate Text](./01-foundations/03-how-llms-generate-text.md) | Tokens, prompts, and completions |
| 04 | [Messages and Conversations](./01-foundations/04-messages-and-conversations.md) | How chat-based AI maintains context |
| 05 | [What Is Tool Use?](./01-foundations/05-what-is-tool-use.md) | How AI can call functions and interact with the world |
| 06 | [JSON as the Communication Language](./01-foundations/06-json-communication.md) | Why agents use JSON to communicate |
| 07 | [Request-Response vs Streaming](./01-foundations/07-request-response-vs-streaming.md) | Two ways AI can deliver results |
| 08 | [What Makes a Good AI Agent?](./01-foundations/08-what-makes-a-good-agent.md) | Quality principles that separate great agents from bad ones |
| 09 | [Claude Code Architecture Overview](./01-foundations/09-claude-code-architecture-overview.md) | Bird's-eye view of how Claude Code is built |
| 10 | [Your First Tiny Agent](./01-foundations/10-your-first-tiny-agent.md) | Build a minimal agent in 50 lines of code |

### Module 02 — The Agent Loop
*The beating heart of every AI agent: the loop that drives everything.*

| # | Lesson | What You'll Learn |
|---|--------|------------------|
| 11 | [What Is an Agent Loop?](./02-the-agent-loop/11-what-is-an-agent-loop.md) | The fundamental pattern behind all AI agents |
| 12 | [A Simple Agent Loop](./02-the-agent-loop/12-a-simple-agent-loop.md) | Build a basic loop step by step |
| 13 | [Async Generators in TypeScript](./02-the-agent-loop/13-async-generators.md) | The programming pattern that powers Claude Code's loop |
| 14 | [The Query Function](./02-the-agent-loop/14-the-query-function.md) | How Claude Code's main loop works |
| 15 | [Stream Events and Yielding](./02-the-agent-loop/15-stream-events-and-yielding.md) | How the loop communicates with the outside world |
| 16 | [Loop State Management](./02-the-agent-loop/16-loop-state-management.md) | What the loop remembers between iterations |
| 17 | [Terminal and Continue Reasons](./02-the-agent-loop/17-terminal-and-continue-reasons.md) | How the loop decides to stop or keep going |
| 18 | [Turn Counting and Limits](./02-the-agent-loop/18-turn-counting-and-limits.md) | Preventing infinite loops |
| 19 | [The QueryEngine Class](./02-the-agent-loop/19-the-query-engine.md) | The SDK wrapper around the loop |
| 20 | [Loop Lifecycle: Start to Finish](./02-the-agent-loop/20-loop-lifecycle.md) | Complete walkthrough of one full loop cycle |

### Module 03 — The Tool System
*How the agent interacts with the real world: reading files, running commands, searching code.*

| # | Lesson | What You'll Learn |
|---|--------|------------------|
| 21 | [What Are Tools?](./03-tool-system/21-what-are-tools.md) | Functions the AI can call to do real work |
| 22 | [Anatomy of a Tool](./03-tool-system/22-anatomy-of-a-tool.md) | The structure every tool follows |
| 23 | [Input Validation with Zod](./03-tool-system/23-input-validation-with-zod.md) | How schemas prevent bad tool calls |
| 24 | [The buildTool Factory](./03-tool-system/24-the-build-tool-factory.md) | How Claude Code creates tools with defaults |
| 25 | [The Tool Registry](./03-tool-system/25-the-tool-registry.md) | How tools are registered and discovered |
| 26 | [Read-Only vs Write Tools](./03-tool-system/26-read-only-vs-write-tools.md) | Why the distinction matters |
| 27 | [Concurrency Safety](./03-tool-system/27-concurrency-safety.md) | Which tools can safely run in parallel |
| 28 | [Tool Partitioning](./03-tool-system/28-tool-partitioning.md) | The algorithm that groups tools into batches |
| 29 | [Parallel Tool Execution](./03-tool-system/29-parallel-tool-execution.md) | Running multiple tools at once |
| 30 | [Streaming Tool Execution](./03-tool-system/30-streaming-tool-execution.md) | Executing tools while the model is still talking |
| 31 | [Tool Error Handling](./03-tool-system/31-tool-error-handling.md) | What happens when tools fail |
| 32 | [Tool Hooks: Pre and Post](./03-tool-system/32-tool-hooks.md) | Extending tool behavior with hooks |
| 33 | [Tool Result Processing](./03-tool-system/33-tool-result-processing.md) | How tool outputs are prepared for the model |
| 34 | [Built-in Tools Overview](./03-tool-system/34-built-in-tools-overview.md) | Tour of all 40+ tools |
| 35 | [Creating a Custom Tool](./03-tool-system/35-creating-a-custom-tool.md) | Build your own tool from scratch |

### Module 04 — Model Integration
*How the agent talks to AI models: API calls, streaming, retries.*

| # | Lesson | What You'll Learn |
|---|--------|------------------|
| 36 | [LLM APIs 101](./04-model-integration/36-llm-apis-101.md) | How to call an AI model's API |
| 37 | [Streaming API Responses](./04-model-integration/37-streaming-api-responses.md) | Getting responses token by token |
| 38 | [The Claude API Service](./04-model-integration/38-the-claude-api-service.md) | How Claude Code calls the Anthropic API |
| 39 | [Message Formatting for APIs](./04-model-integration/39-message-formatting.md) | Preparing messages for the API |
| 40 | [Token Counting and Estimation](./04-model-integration/40-token-counting.md) | Knowing how much context you're using |
| 41 | [Model Selection and Routing](./04-model-integration/41-model-selection-and-routing.md) | Choosing the right model at the right time |
| 42 | [The Retry System](./04-model-integration/42-the-retry-system.md) | Never give up on the first failure |
| 43 | [Rate Limiting and Backoff](./04-model-integration/43-rate-limiting-and-backoff.md) | Handling API rate limits gracefully |
| 44 | [Fallback Models](./04-model-integration/44-fallback-models.md) | Switching models when the primary fails |
| 45 | [Cost Tracking](./04-model-integration/45-cost-tracking.md) | Monitoring how much the agent spends |

### Module 05 — Prompt Engineering
*The art and science of telling the AI what to do and how to behave.*

| # | Lesson | What You'll Learn |
|---|--------|------------------|
| 46 | [System Prompts 101](./05-prompt-engineering/46-system-prompts-101.md) | What system prompts are and why they matter |
| 47 | [Claude Code's Prompt Structure](./05-prompt-engineering/47-prompt-structure.md) | How the system prompt is organized into sections |
| 48 | [The Identity Section](./05-prompt-engineering/48-the-identity-section.md) | Who the agent thinks it is |
| 49 | [Tool Instructions in Prompts](./05-prompt-engineering/49-tool-instructions.md) | Teaching the model how to use its tools |
| 50 | [Dynamic vs Static Prompt Sections](./05-prompt-engineering/50-dynamic-vs-static-sections.md) | What changes vs what stays the same |
| 51 | [Prompt Caching](./05-prompt-engineering/51-prompt-caching.md) | Saving money by reusing prompt tokens |
| 52 | [Environment Context Injection](./05-prompt-engineering/52-environment-context.md) | Telling the model about its world |
| 53 | [Project Memory (CLAUDE.md)](./05-prompt-engineering/53-project-memory.md) | Persistent per-project instructions |
| 54 | [Output Style and Efficiency](./05-prompt-engineering/54-output-style-and-efficiency.md) | Controlling how the model responds |
| 55 | [The System Prompt Assembly Pipeline](./05-prompt-engineering/55-prompt-assembly-pipeline.md) | How all pieces come together |

### Module 06 — Context Management
*Managing the AI's memory: what it remembers, what it forgets, and when.*

| # | Lesson | What You'll Learn |
|---|--------|------------------|
| 56 | [Why Context Management Matters](./06-context-management/56-why-context-matters.md) | The fundamental problem of limited memory |
| 57 | [Token Budgets and Limits](./06-context-management/57-token-budgets-and-limits.md) | How much the model can remember at once |
| 58 | [Tool Result Budgets](./06-context-management/58-tool-result-budgets.md) | Capping individual tool output sizes |
| 59 | [Microcompact](./06-context-management/59-microcompact.md) | Clearing old tool results to save space |
| 60 | [Autocompact](./06-context-management/60-autocompact.md) | Automatic conversation summarization |
| 61 | [The Compaction Summary](./06-context-management/61-compaction-summary.md) | How conversations are summarized |
| 62 | [Reactive Compact](./06-context-management/62-reactive-compact.md) | Emergency compaction when context overflows |
| 63 | [Context Collapse](./06-context-management/63-context-collapse.md) | Progressive context reduction |
| 64 | [Snip: Removing Old Messages](./06-context-management/64-snip.md) | Cutting out old history |
| 65 | [The Full Compaction Pipeline](./06-context-management/65-full-compaction-pipeline.md) | How all five layers work together |

### Module 07 — File Operations
*Reading, writing, and editing code files — the agent's core job.*

| # | Lesson | What You'll Learn |
|---|--------|------------------|
| 66 | [Reading Files](./07-file-operations/66-reading-files.md) | How the agent reads source code |
| 67 | [Writing New Files](./07-file-operations/67-writing-files.md) | Creating files from scratch |
| 68 | [The File Edit Model](./07-file-operations/68-the-file-edit-model.md) | old_string → new_string replacement |
| 69 | [String Matching and Quote Normalization](./07-file-operations/69-string-matching.md) | Finding text even when quotes differ |
| 70 | [Read-Before-Edit Enforcement](./07-file-operations/70-read-before-edit.md) | Preventing hallucinated edits |
| 71 | [Diff and Patch Generation](./07-file-operations/71-diff-and-patch.md) | Showing what changed |
| 72 | [Notebook Editing](./07-file-operations/72-notebook-editing.md) | Editing Jupyter notebooks |

### Module 08 — Search and Navigation
*Finding things in large codebases.*

| # | Lesson | What You'll Learn |
|---|--------|------------------|
| 73 | [The GrepTool (Ripgrep)](./08-search-and-navigation/73-grep-tool.md) | Searching file contents with regex |
| 74 | [The GlobTool](./08-search-and-navigation/74-glob-tool.md) | Finding files by name patterns |
| 75 | [Web Search and Fetch](./08-search-and-navigation/75-web-search-and-fetch.md) | Accessing the internet |
| 76 | [Search Pagination and Limits](./08-search-and-navigation/76-search-pagination.md) | Handling large result sets |
| 77 | [LSP Integration](./08-search-and-navigation/77-lsp-integration.md) | Language-aware code navigation |
| 78 | [Codebase Exploration Strategies](./08-search-and-navigation/78-codebase-exploration.md) | How the agent understands new codebases |

### Module 09 — Permissions and Safety
*Keeping the agent safe: what it can and cannot do.*

| # | Lesson | What You'll Learn |
|---|--------|------------------|
| 79 | [Why Permissions Matter](./09-permissions-and-safety/79-why-permissions-matter.md) | The risks of unchecked AI agents |
| 80 | [Permission Modes](./09-permissions-and-safety/80-permission-modes.md) | Default, plan, auto, and bypass modes |
| 81 | [Per-Tool Permission Checks](./09-permissions-and-safety/81-per-tool-permissions.md) | Allow, deny, and ask rules |
| 82 | [The Interactive Permission Flow](./09-permissions-and-safety/82-interactive-permission-flow.md) | Asking the user for approval |
| 83 | [Bash Command Classification](./09-permissions-and-safety/83-bash-classification.md) | Extra scrutiny for shell commands |
| 84 | [Security: Prompt Injection Defense](./09-permissions-and-safety/84-prompt-injection-defense.md) | Protecting against malicious input |
| 85 | [The Cyber Risk Instruction](./09-permissions-and-safety/85-cyber-risk-instruction.md) | Security-focused system prompt framing |

### Module 10 — Error Handling
*When things go wrong: retries, recovery, and graceful degradation.*

| # | Lesson | What You'll Learn |
|---|--------|------------------|
| 86 | [Error Philosophy](./10-error-handling/86-error-philosophy.md) | Why robust error handling is the difference between good and great |
| 87 | [The withRetry System](./10-error-handling/87-the-with-retry-system.md) | Exponential backoff and retry strategies |
| 88 | [Max Output Token Recovery](./10-error-handling/88-max-output-token-recovery.md) | When the model's response gets cut off |
| 89 | [Context Overflow Recovery](./10-error-handling/89-context-overflow-recovery.md) | When the conversation gets too long |
| 90 | [Streaming Error Handling](./10-error-handling/90-streaming-errors.md) | Errors during real-time streaming |
| 91 | [The Abort System](./10-error-handling/91-the-abort-system.md) | Clean cancellation of operations |
| 92 | [Circuit Breakers](./10-error-handling/92-circuit-breakers.md) | Stopping cascading failures |

### Module 11 — Multi-Agent and Tasks
*Beyond a single agent: coordination, sub-agents, and task management.*

| # | Lesson | What You'll Learn |
|---|--------|------------------|
| 93 | [Plan Mode](./11-multi-agent-and-tasks/93-plan-mode.md) | Think before you act |
| 94 | [The Coordinator Pattern](./11-multi-agent-and-tasks/94-the-coordinator-pattern.md) | One agent directing many |
| 95 | [Sub-Agents](./11-multi-agent-and-tasks/95-sub-agents.md) | Spawning agents for subtasks |
| 96 | [Task Management](./11-multi-agent-and-tasks/96-task-management.md) | Creating, tracking, and completing tasks |
| 97 | [The Skill System](./11-multi-agent-and-tasks/97-the-skill-system.md) | Reusable patterns and workflows |
| 98 | [Background Processing](./11-multi-agent-and-tasks/98-background-processing.md) | Work that happens in the background |

### Module 12 — Architecture and Advanced Topics
*The big picture: how everything fits together and advanced patterns.*

| # | Lesson | What You'll Learn |
|---|--------|------------------|
| 99 | [Event-Driven Architecture](./12-architecture-and-advanced/99-event-driven-architecture.md) | Why events, not callbacks |
| 100 | [The CLI Entry Point](./12-architecture-and-advanced/100-the-cli-entry-point.md) | How Claude Code starts up |
| 101 | [React Ink: Terminal UIs](./12-architecture-and-advanced/101-react-ink-terminal-ui.md) | Building beautiful terminal interfaces |
| 102 | [Multiple Interfaces: CLI, Web, SDK](./12-architecture-and-advanced/102-multiple-interfaces.md) | One core, many faces |
| 103 | [MCP: Model Context Protocol](./12-architecture-and-advanced/103-mcp-integration.md) | Connecting to external tools |
| 104 | [State Management](./12-architecture-and-advanced/104-state-management.md) | How the app tracks everything |
| 105 | [Configuration and Schemas](./12-architecture-and-advanced/105-configuration-and-schemas.md) | Validated settings with Zod |
| 106 | [Feature Flags](./12-architecture-and-advanced/106-feature-flags.md) | Progressive rollout of new features |
| 107 | [Commands System](./12-architecture-and-advanced/107-commands-system.md) | Slash commands and user interaction |
| 108 | [Building Your Own Agent](./12-architecture-and-advanced/108-building-your-own-agent.md) | Putting it all together |

---

## How Long Does This Take?

- **Casual pace**: 4-6 weeks (2-3 lessons per day)
- **Intensive pace**: 2 weeks (8-10 lessons per day)
- **Reference mode**: Jump to any module you need

## Prerequisites

- Basic programming knowledge (any language)
- Familiarity with TypeScript is helpful but not required
- A terminal/command line (any OS)

---

*This course is based on the Claude Code source code (2026 build). All code examples are real production code or simplified versions of it.*
