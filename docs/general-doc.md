# Sysflow Documentation

**Version 0.1.0** | Last updated: March 2026

Sysflow is an AI coding agent that runs in your terminal. You type what you want built, and the agent creates files, installs packages, and writes code for you — all from the command line.

This document covers everything: how to set it up, how to use it, how every part works, and how to add new things.

---

## Table of Contents

1. [What is Sysflow?](#1-what-is-sysflow)
2. [How It Works (The Big Picture)](#2-how-it-works-the-big-picture)
3. [Project Structure](#3-project-structure)
4. [Setup & Installation](#4-setup--installation)
5. [Using the CLI](#5-using-the-cli)
6. [Available Models](#6-available-models)
7. [The Agent Loop](#7-the-agent-loop)
8. [Available Tools](#8-available-tools)
9. [Server Architecture](#9-server-architecture)
10. [Model Providers](#10-model-providers)
11. [Authentication & Billing](#11-authentication--billing)
12. [Session History & Memory](#12-session-history--memory)
13. [The sysbase Folder](#13-the-sysbase-folder)
14. [Database](#14-database)
15. [Docker](#15-docker)
16. [Environment Variables](#16-environment-variables)
17. [Adding a New Model Provider](#17-adding-a-new-model-provider)
18. [Troubleshooting](#18-troubleshooting)
19. [File Reference](#19-file-reference)

---

## 1. What is Sysflow?

Sysflow is a two-part system:

1. **A CLI tool** (`sys`) that you run in your terminal inside any project folder.
2. **An API server** that talks to AI models, manages auth/billing, and persists session history in PostgreSQL.

You type a prompt like `sys "create a hello world express server"`, and Sysflow will:
- Ask an AI model what to do
- Create files, install packages, and run commands on your machine
- Show you each step as it happens
- Remember what it did across prompts (session history)
- Tell you when it's done

Think of it like having a junior developer inside your terminal that follows your instructions.

---

## 2. How It Works (The Big Picture)

Here's the full request flow when you run a command:

```
You type: sys "create an express server"
         |
         v
   ┌──────────────────┐
   │    CLI Client      │  (cli-client)
   │                    │
   │  1. Scans your project folder (file tree)
   │  2. Sends prompt + file tree + model to server
   └────────┬─────────┘
            |  HTTP POST /agent/run { type: "user_message" }
            v
   ┌──────────────────┐
   │    API Server      │  (server)
   │                    │
   │  3. Authenticates user (JWT)
   │  4. Checks usage limits (free: 10 prompts/day)
   │  5. Creates a task and run
   │  6. Loads session history from PostgreSQL
   │  7. Loads project context (patterns, fixes, memories)
   │  8. Sends everything to the AI model (Gemini / OpenRouter)
   └────────┬─────────┘
            |  API call to AI provider
            v
   ┌──────────────────┐
   │    AI Model        │  (Gemini, OpenRouter, etc.)
   │                    │
   │  9. Receives: system prompt + tools + context + your prompt
   │  10. Decides what action to take
   │  11. Returns structured JSON response
   └────────┬─────────┘
            |
            v
   ┌──────────────────┐
   │    API Server      │
   │                    │
   │  12. Logs token usage + cost
   │  13. Normalizes response to standard format
   │  14. Sends action back to CLI
   └────────┬─────────┘
            |  HTTP response { status: "needs_tool", tool: "write_file", args: {...} }
            v
   ┌──────────────────┐
   │    CLI Client      │
   │                    │
   │  15. Displays reasoning (typing animation)
   │  16. Displays tool action (+ create src/app.js +12)
   │  17. Executes the tool LOCALLY (creates the file on your disk)
   │  18. Sends tool result back to server
   └────────┬─────────┘
            |  HTTP POST /agent/run { type: "tool_result" }
            v
   ┌──────────────────┐
   │    API Server      │
   │                    │
   │  19. Records action in session history
   │  20. Sends tool result to AI model
   │  21. AI decides next action
   │  22. Repeat steps 12-18...
   │
   │  Until AI responds with "completed" or "failed"
   └──────────────────┘
            |
            v
   ┌──────────────────┐
   │    CLI Client      │
   │                    │
   │  23. Shows completion message
   │  24. Saves session to database
   │  25. Returns to prompt
   └──────────────────┘
```

**Key point:** The AI model never touches your files directly. It only *decides* what to do. The CLI client is the one that actually creates files, runs commands, etc. on your machine.

**Key point:** The server persists session history in PostgreSQL, so the AI remembers what it did across prompts within the same chat session.

---

## 3. Project Structure

```
sysflow/
├── README.md                  ← Quick start and overview
├── DOCUMENTATION.md           ← Legacy docs (see docs/general-doc.md instead)
├── docker-compose.yml         ← Docker setup for PostgreSQL + server
├── .gitignore
│
├── cli-client/                ← The CLI tool (what you type commands into)
│   ├── bin/
│   │   └── sys.js             ← Global entry point (#!/usr/bin/env node)
│   ├── src/
│   │   ├── index.js           ← CLI argument routing → commands or interactive mode
│   │   ├── agent/             ← AI agent loop
│   │   │   ├── agent.js       ← Main loop: display reasoning, execute tools, repeat
│   │   │   ├── executor.js    ← Tool dispatcher (routes to tool functions)
│   │   │   └── tools.js       ← Tool implementations (file I/O, commands, search)
│   │   ├── commands/          ← CLI subcommands
│   │   │   ├── auth.js        ← sys login, register, logout, whoami
│   │   │   ├── billing.js     ← sys billing (plan picker, usage display)
│   │   │   ├── chats.js       ← sys chats (list, create, switch, delete)
│   │   │   └── model.js       ← sys model (interactive model picker)
│   │   ├── cli/               ← Terminal UI
│   │   │   ├── ui.js          ← Interactive readline loop (the "| " prompt)
│   │   │   └── parser.js      ← CLI argument and slash-command parser
│   │   └── lib/               ← Shared utilities
│   │       ├── server.js      ← HTTP client for server communication
│   │       └── sysbase.js     ← Local config management
│   └── package.json
│
├── server/                    ← The API server (talks to AI models, manages state)
│   ├── .env                   ← API keys and DB credentials (never commit)
│   ├── .env.example           ← Template for .env
│   ├── Dockerfile             ← Docker image for the server
│   ├── src/
│   │   ├── index.js           ← Fastify setup, route registration, startup
│   │   ├── services/          ← Core business logic
│   │   │   ├── context.js     ← Loads project context (memories, fixes, sysbase)
│   │   │   └── task.js        ← Creates task objects with steps
│   │   ├── routes/            ← HTTP endpoints
│   │   │   ├── agent.js       ← POST /agent/run — main AI endpoint
│   │   │   ├── auth.js        ← POST /auth/register, /auth/login
│   │   │   ├── chats.js       ← CRUD /chats
│   │   │   └── billing.js     ← Stripe billing, webhooks, usage, plans
│   │   ├── handlers/          ← Request orchestration (called by routes)
│   │   │   ├── user-message.js ← Handles new user prompts → creates run, calls AI
│   │   │   └── tool-result.js  ← Handles tool results → calls AI for next action
│   │   ├── providers/         ← AI model adapters
│   │   │   ├── adapter.js     ← Routes model ID to correct provider
│   │   │   ├── gemini.js      ← Google Gemini (Flash, Pro)
│   │   │   ├── openrouter.js  ← OpenRouter (Llama, Mistral, Gemini via OR)
│   │   │   ├── claude-sonnet.js ← Anthropic Claude Sonnet 4
│   │   │   ├── claude-opus.js ← Anthropic Claude Opus 4
│   │   │   ├── swe.js         ← Mock provider for testing
│   │   │   └── normalize.js   ← Normalizes provider responses to client format
│   │   ├── store/             ← Data access layer (DB + in-memory)
│   │   │   ├── sessions.js    ← Session history (PostgreSQL)
│   │   │   ├── context.js     ← Context entries (PostgreSQL)
│   │   │   ├── subscriptions.js ← Plans, billing, usage limits (PostgreSQL)
│   │   │   ├── usage.js       ← Token usage tracking
│   │   │   ├── runs.js        ← In-memory run state
│   │   │   ├── tasks.js       ← In-memory task state
│   │   │   ├── tool-results.js ← In-memory tool results
│   │   │   ├── memory.js      ← In-memory project memory
│   │   │   └── checkout-events.js ← SSE event emitter for Stripe checkout
│   │   └── db/                ← Database layer
│   │       ├── connection.js  ← PostgreSQL pool, query helper, migration runner
│   │       └── migrations/    ← Schema migrations (001–009)
│   └── package.json
│
└── docs/                      ← Developer documentation
    ├── general-doc.md         ← This file — comprehensive guide
    ├── server.md              ← Server architecture deep dive
    └── cli-client.md          ← CLI architecture deep dive
```

---

## 4. Setup & Installation

### Prerequisites
- **Node.js** 20+ (18 minimum)
- **PostgreSQL** 15+
- **npm** (comes with Node.js)
- An API key for at least one AI provider

### Step 1: Install the API server

```bash
cd sysflow/server
npm install
```

### Step 2: Set up the database

**Option A: Docker (recommended)**
```bash
cd sysflow
docker compose up -d postgres
```

**Option B: Local PostgreSQL**

Make sure PostgreSQL is running. The server auto-creates the `sysflow` database and runs all migrations on startup.

### Step 3: Add your API keys

Copy the example env file and fill in your keys:

```bash
cd sysflow/server
cp .env.example .env
```

Edit `.env`:

```env
# Database (defaults work with Docker)
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=sysflow

# AI Providers (at least one required)
GEMINI_API_KEY=your-google-gemini-key-here
OPENROUTER_API_KEY=your-openrouter-key-here

# Auth
JWT_SECRET=change-me-in-production

# Stripe (optional — for billing)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

**Where to get keys:**
- **Gemini:** Go to [aistudio.google.com](https://aistudio.google.com/apikey) → "Get API key" → Free
- **OpenRouter:** Go to [openrouter.ai/keys](https://openrouter.ai/keys) → Sign up → Free (no credit card)

You only need one. If you have both, you can switch between them.

### Step 4: Start the API server

```bash
cd sysflow/server
npm run dev
```

You should see:
```
[db] Database "sysflow" already exists.
[db] Connected to PostgreSQL at ...
[db] All migrations up to date.
Sysflow API listening on http://localhost:3000
```

**Leave this terminal open.** The server must be running for the CLI to work.

### Step 5: Install the CLI tool

Open a **new terminal** (keep the server running in the first one):

```bash
cd sysflow/cli-client
npm install
npm link
```

The `npm link` command makes the `sys` command available everywhere on your machine.

### Step 6: Create an account and verify

```bash
sys register        # Create account (email + password)
sys login           # Log in (gets JWT token)
sys whoami          # Verify — shows your account + usage info
sys model           # Pick a model
sys "hello world"   # Test it
```

---

## 5. Using the CLI

### One-shot mode (quick commands)

Run a single prompt and exit:

```bash
sys "create an express server with a health check endpoint"
```

### Set the AI model

Use the interactive arrow-key picker:

```bash
sys model
```

This shows all available models. Use **up/down arrows** to navigate, **Enter** to select. After picking a model, it asks if you want reasoning mode on or off.

Or set directly:

```bash
sys model gemini-flash
```

**Reasoning mode** shows the AI's thinking process before each action (dim text like `I need to create the package.json first`). Turning it off makes output cleaner and slightly faster.

### Interactive mode

Start a session where you can type multiple prompts:

```bash
sys
```

This shows a prompt like:

```
  sys v0.1  myproject  model: gemini-flash  user: you@email.com  chat: my-chat
  type a prompt and press enter. /model, /plan, /exit

  |
```

Type your prompt and press Enter. Type `/exit` to quit.

### CLI commands

| Command | What it does |
|---------|-------------|
| `sys` | Interactive mode |
| `sys "prompt"` | One-shot agent run |
| `sys login` | Log in with email/password |
| `sys register` | Create a new account |
| `sys logout` | Clear auth tokens |
| `sys whoami` | Show account info + usage |
| `sys model` | Interactive model picker |
| `sys model gemini-flash` | Switch model directly |
| `sys billing` | Manage subscription plan |
| `sys usage` | Show token usage summary |
| `sys chats` | List/create/switch chat sessions |
| `sys delete-chat` | Delete active chat |

### Commands inside interactive mode

| Command | What it does |
|---------|-------------|
| `/model` | Open the model picker |
| `/model gemini-flash` | Switch model directly |
| `/plan build a REST API` | Create a plan and save it to sysbase |
| `/implement build a REST API` | Implement a previously created plan |
| `/continue` | Continue from the last interrupted run |
| `/exit` or `/quit` | Exit interactive mode |

### File mentions

You can reference files in your prompt with `@`:

```bash
sys "refactor @src/app.js to use async/await"
```

The agent reads the file content and includes it in the prompt to the AI model.

---

## 6. Available Models

Currently two providers are enabled:

| Model ID | Name | Provider | Notes |
|----------|------|----------|-------|
| `openrouter-auto` | Auto (OpenRouter) | OpenRouter | Best available model, auto-selected |
| `gemini-flash` | Gemini 2.5 Flash | Google (direct) | Fast & free — Google AI direct |

Additional models exist in the server but are hidden from the picker for now:

| Model ID | Name | Provider | Status |
|----------|------|----------|--------|
| `gemini-pro` | Gemini Pro | Google | Hidden — slower, lower rate limits |
| `llama-70b` | Llama 3.3 70B | OpenRouter | Hidden |
| `mistral-small` | Mistral Small | OpenRouter | Hidden |
| `gemini-flash-or` | Gemini Flash (OR) | OpenRouter | Hidden — Gemini via OpenRouter |
| `claude-sonnet-4` | Claude Sonnet 4 | Anthropic | Hidden — placeholder |
| `claude-opus-4` | Claude Opus 4 | Anthropic | Hidden — placeholder |
| `swe` | SWE (Mock) | Built-in | Mock provider for testing |

### Which model should I use?

- **General use?** → `openrouter-auto` (picks the best available model)
- **Fast & free?** → `gemini-flash` (Google direct API)
- **Testing without API keys?** → Enable `swe` in `sysbase.js` (returns scripted steps)

### Rate limits

- **Gemini Flash:** 15 requests/minute, 1000/day (free tier)
- **OpenRouter free models:** ~20/minute, varies by model

If you hit a rate limit, wait a minute or switch models.

---

## 7. The Agent Loop

This is the core of how Sysflow works. The detailed flow:

### 1. You type a prompt
```bash
sys "create a hello world express server"
```

### 2. The CLI scans your project
Before sending anything to the server, the CLI scans your current folder and builds a tree of all files and folders (excluding `node_modules`, `.git`, and `sysbase`).

### 3. The CLI sends everything to the server
```
POST /agent/run
{
  type: "user_message",
  content: "create a hello world express server",
  model: "gemini-flash",
  projectId: "my-project",
  cwd: "/Users/you/my-project",
  sysbasePath: "/Users/you/my-project/sysbase",
  directoryTree: [ { name: "package.json", type: "file" }, ... ],
  chatUid: "abc-123"   // if logged in with active chat
}
```

### 4. The server processes the request
1. **Authenticates** — extracts user from JWT token
2. **Checks usage limits** — free plan: 10 prompts/day; paid plans: credit-based
3. **Flushes orphaned runs** — saves any interrupted sessions to history
4. **Creates a task** — title, goal, and initial steps
5. **Loads project context** — memories, fix files from sysbase
6. **Loads session history** — last 20 sessions from PostgreSQL (so the AI remembers)
7. **Loads project knowledge** — patterns, fixes from context_entries table
8. **Calls the AI model** via the provider adapter

### 5. The AI responds with an action
```json
{
  "kind": "needs_tool",
  "reasoning": "I need to create package.json first with express as a dependency",
  "tool": "write_file",
  "args": { "path": "package.json", "content": "{\n  \"name\": \"hello-world\"..." },
  "content": "Creating package.json"
}
```

### 6. The server normalizes and returns
```json
{
  "status": "needs_tool",
  "runId": "uuid-abc-123",
  "tool": "write_file",
  "args": { "path": "package.json", "content": "..." },
  "reasoning": "I need to create package.json first...",
  "task": { "title": "Run: create a hello world express server", "steps": [...] }
}
```

### 7. The CLI displays and executes
```
    I need to create package.json first...        ← reasoning (dim, typing animation)
    + create package.json +8                       ← tool label (green)
```
The CLI creates the actual file on disk, then sends the result back:

```
POST /agent/run
{
  type: "tool_result",
  runId: "uuid-abc-123",
  tool: "write_file",
  result: { path: "package.json", success: true }
}
```

### 8. The server asks the AI again
The server passes the tool result to the AI model, which decides the next action.

### 9. Repeat until done
This loop continues until the AI responds with `"kind": "completed"` or `"kind": "failed"`.

When completed:
- The session is saved to PostgreSQL (prompt, actions, files modified, outcome)
- The AI may auto-save learned patterns to the context_entries table

### Safety features

- **Loop guard:** If a tool fails 3 times in a row, the agent stops automatically
- **Command safety:** Long-running commands (`npm start`, `node server.js`) are detected and skipped — the AI tells the user to run them manually
- **30-second timeout:** Normal commands timeout after 30s to prevent hangs
- **Dedup guard:** If the AI returns the exact same action twice, the duplicate display is skipped

---

## 8. Available Tools

These are the actions the AI can ask the CLI to perform. The CLI executes them locally on your machine.

| Tool | What it does | Example args |
|------|-------------|-------------|
| `list_directory` | Lists files and folders in a directory | `{ "path": "." }` |
| `read_file` | Reads one file | `{ "path": "src/app.js" }` |
| `batch_read` | Reads multiple files at once | `{ "paths": ["src/app.js", "package.json"] }` |
| `write_file` | Creates or overwrites a file | `{ "path": "app.js", "content": "..." }` |
| `edit_file` | Replaces the full content of a file | `{ "path": "app.js", "patch": "..." }` |
| `create_directory` | Creates a folder (and parent folders) | `{ "path": "src/utils" }` |
| `search_code` | Searches for a text pattern in files | `{ "directory": ".", "pattern": "TODO" }` |
| `run_command` | Runs a shell command | `{ "command": "npm install", "cwd": "." }` |
| `move_file` | Moves or renames a file | `{ "from": "old.js", "to": "new.js" }` |
| `delete_file` | Deletes a file | `{ "path": "temp.js" }` |
| `file_exists` | Checks if a file exists | `{ "path": "package.json" }` |

### Command execution details

The `run_command` tool uses `child_process.spawn` (not `exec`) for proper process control:

- **Long-running detection:** Commands matching patterns like `npm start`, `npm run dev`, `node server.js`, `python app.py` are detected and skipped. The AI is instructed to tell the user to run them manually.
- **30-second timeout:** If a command hasn't finished in 30 seconds, the process is killed and partial output is returned.
- **Output capture:** stdout and stderr are captured and sent back to the server as part of the tool result, so the AI can see what happened.

---

## 9. Server Architecture

The API server is built with [Fastify](https://fastify.dev/) and uses PostgreSQL for persistence.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/agent/run` | Main AI endpoint (user messages + tool results) |
| `POST` | `/auth/register` | Create account |
| `POST` | `/auth/login` | Login, returns JWT |
| `GET` | `/chats` | List chat sessions |
| `POST` | `/chats` | Create/find chat |
| `DELETE` | `/chats/:id` | Delete chat |
| `POST` | `/billing/checkout` | Create Stripe checkout session |
| `POST` | `/billing/webhook` | Stripe webhook handler |
| `GET` | `/billing/plans` | List available plans |
| `GET` | `/billing/usage` | Get usage summary |
| `GET` | `/billing/checkout-stream` | SSE for checkout completion |
| `GET` | `/health` | Health check |

### Request flow for POST /agent/run

The server looks at the `type` field in the request body:

**`type: "user_message"` → `handlers/user-message.js`**
```
1. extractUser() — JWT auth (optional, backward compatible)
2. resolveChat() — find/create chat session
3. checkUsageAllowed() — billing limits check
4. createTask() — build task with title, goal, steps
5. loadProjectContext() — load memories, fix files from sysbase
6. buildSessionSummary() — load last 20 sessions from PostgreSQL
7. buildContextForPrompt() — load relevant context_entries
8. callModelAdapter() — route to correct AI provider
9. persistModelUsage() — log tokens + cost to usage_logs
10. mapNormalizedResponseToClient() — format response
```

**`type: "tool_result"` → `handlers/tool-result.js`**
```
1. saveToolResult() — store in memory
2. getRun() — load active run state
3. recordRunAction() — log action for session history
4. loadRunContext() — build context with previous tool results
5. callModelAdapter() — call AI with tool result
6. persistModelUsage() — log tokens + cost
7. If completed/failed:
   - saveSessionEntry() — persist to PostgreSQL
   - autoSaveContext() — AI saves learned patterns
   - finalizeRun(), finalizeTask()
8. mapNormalizedResponseToClient()
```

### Normalized responses

Every model provider returns data in its own format. `providers/normalize.js` converts them to a standard format the CLI understands:

```javascript
{
  status: "needs_tool" | "completed" | "waiting_for_user" | "failed",
  runId: "uuid",
  tool: "write_file",       // only if status is "needs_tool"
  args: { ... },             // only if status is "needs_tool"
  reasoning: "...",          // AI's thinking (optional)
  message: "...",            // completion message (if completed)
  error: "..."              // only if status is "failed"
}
```

---

## 10. Model Providers

A "provider" is code that talks to a specific AI service. Each provider:

1. Takes the user's prompt and context
2. Builds a system prompt with tool definitions and rules
3. Manages multi-turn conversation history per run
4. Calls the AI API and parses the response
5. Returns a normalized response object

### Provider Adapter (`providers/adapter.js`)

This is the router. It looks at the model name and calls the right provider:

```
gemini-flash, gemini-pro              → gemini.js
openrouter-auto, llama-70b,
  mistral-small, gemini-flash-or      → openrouter.js
claude-sonnet-4                       → claude-sonnet.js
claude-opus-4                         → claude-opus.js
swe                                   → swe.js (mock)
```

### Gemini Provider (`providers/gemini.js`)

Talks to Google's Gemini API using the official `@google/generative-ai` SDK.

**How it works:**
- Uses **structured output** (`responseSchema`) to force Gemini to return JSON in a specific shape
- The AI's tool arguments are returned as a JSON string in a field called `args_json`, which the provider parses
- Supports **multi-turn chat** — keeps a chat session alive so the AI remembers previous tool results within the same run
- Requires `GEMINI_API_KEY` in `.env`

**System prompt includes:**
- All available tool definitions
- Rules: one action at a time, never modify sysbase, verify before completing
- Terminal command rules: never run `npm start`, `node server.js`, etc.
- Memory rules: use session history, don't re-read files you just wrote

**Rate limit handling:** If Gemini returns a 429 error, the provider catches it and returns a friendly error message.

### OpenRouter Provider (`providers/openrouter.js`)

Talks to OpenRouter's API using standard `fetch`. OpenRouter uses the OpenAI-compatible API format.

**How it works:**
- Sends messages in OpenAI's `messages` format: `[{ role: "system", ... }, { role: "user", ... }]`
- Uses `response_format: { type: "json_object" }` to force JSON output
- Supports **multi-turn conversation** by keeping message history in memory per run
- Has **retry logic** — if a network request fails, retries up to 2 times with exponential delay
- Has a **2-minute timeout** per request
- Requires `OPENROUTER_API_KEY` in `.env`

**Conversation history:** The provider stores the full message array per `runId`. On tool results, it appends the result as a user message and gets the next assistant response. History is cleared when the run completes or fails.

### SWE Provider (`providers/swe.js`)

A **mock provider** that doesn't call any AI. It returns scripted steps for testing. Useful for:
- Testing the CLI and server without burning API credits
- Verifying the tool execution pipeline works
- Developing new features without needing an API key

### Claude Providers (`claude-sonnet.js`, `claude-opus.js`)

Connected to Anthropic's API. Requires `ANTHROPIC_API_KEY` in `.env`. Currently hidden from the model picker.

---

## 11. Authentication & Billing

### Authentication

The server uses **JWT tokens** for auth:

1. `sys register` → `POST /auth/register` — creates user with bcrypt-hashed password
2. `sys login` → `POST /auth/login` — returns JWT token
3. Token is stored locally in `~/.sysflow/auth.json`
4. All subsequent requests include `Authorization: Bearer <token>`
5. Auth is optional — the CLI works without login (backward compatible)

### Billing Plans

| Plan | Price | Limits |
|------|-------|--------|
| **Free** | $0 | 10 prompts/day, cost logged as $0 |
| **Lite** | $20/mo | $20 credit (2000 cents) |
| **Pro** | $60/mo | $60 credit (6000 cents) |
| **Team** | $200/mo | $200 credit (20000 cents) |

### How billing works

- **Free plan:** Each user prompt (not each LLM call) increments `free_prompts_today`. Cost is logged as $0 in `usage_logs`.
- **Paid plans:** Each LLM call calculates cost based on model-specific token pricing and deducts from `subscriptions.credits_used_cents`.
- **Usage check:** Before processing a new prompt, the server calls `checkUsageAllowed()` to verify the user has remaining prompts/credits. Returns 429 if exceeded.

### Stripe integration

- `sys billing` → shows plan picker with box-drawing UI
- Selecting a paid plan creates a Stripe checkout session
- The CLI opens the checkout URL and listens via SSE for completion
- Stripe webhook (`POST /billing/webhook`) updates the subscription in the database
- Subscription reconciliation runs on each check to sync with Stripe

---

## 12. Session History & Memory

### Session history (PostgreSQL)

After each completed/failed run, a session entry is saved to the `sessions` table:
- Prompt, outcome (completed/failed/interrupted), error message
- Files modified, timestamp
- All tool actions recorded in `run_actions` table

Before each new prompt, the server loads the last **20 sessions** and includes them in the AI's context. This means the AI knows:
- What it did in previous prompts
- Which files it created/modified
- Command outputs from previous runs
- What failed and why

### Orphaned sessions

If a run is interrupted (user closes the terminal mid-execution), the in-memory actions are saved as "interrupted" sessions the next time you send a prompt. This prevents the AI from losing context.

### Context entries (PostgreSQL)

The AI can auto-save patterns, fixes, and learnings to the `context_entries` table. Before each prompt, relevant entries are loaded (filtered by category and keywords) and included in the context. Categories:
- **pattern** — coding patterns, architectural decisions
- **fix** — bug fixes, gotchas
- **memory** — general project knowledge

### In-memory state

Some state is only kept in memory (resets on server restart):
- Active runs and tasks
- Tool results per run
- Project memory buffer

---

## 13. The sysbase Folder

When you first run `sys` in a project folder, it creates a `sysbase/` directory:

```
your-project/
├── sysbase/
│   ├── .meta/
│   │   ├── project.json     ← Project settings (default model, created date)
│   │   ├── models.json      ← Selected model and reasoning preference
│   │   └── chat.json        ← Active chat session
│   ├── plans/               ← Saved plans (from /plan command)
│   ├── patterns/            ← Learned code patterns
│   ├── fixes/               ← Saved fix files
│   ├── architecture/        ← Architecture decisions
│   ├── decisions/           ← Design decisions
│   └── archive/             ← Archived/stashed content
├── src/
├── package.json
└── ...
```

### Global config

Auth state is stored globally (not per-project):

```
~/.sysflow/
└── auth.json          ← JWT token, user info
```

### What's stored in .meta/

**project.json:**
```json
{
  "defaultModel": "openrouter-auto",
  "initializedAt": "2026-03-09T00:00:00.000Z",
  "cwd": "/Users/you/myproject"
}
```

**models.json:**
```json
{
  "available": ["openrouter-auto", "gemini-flash"],
  "selected": "openrouter-auto",
  "reasoning": true
}
```

**chat.json:**
```json
{
  "chatUid": "abc-123",
  "title": "my-chat",
  "savedAt": "2026-03-09T00:00:00.000Z"
}
```

---

## 14. Database

Sysflow uses **PostgreSQL** for persistent storage. The server auto-creates the database and runs migrations on startup.

### Tables

| Table | Purpose |
|-------|---------|
| `_migrations` | Tracks which migrations have run |
| `sessions` | Completed/failed/interrupted run summaries |
| `run_actions` | Per-step tool actions within runs |
| `users` | User accounts (email, bcrypt-hashed password) |
| `chats` | Chat sessions per user per project |
| `context_entries` | AI-learned patterns, fixes, memories |
| `subscriptions` | User plan, Stripe IDs, credits used |
| `usage_logs` | Per-LLM-call token usage and cost |

### Migrations

Migrations are in `server/src/db/migrations/` (001–009). They run automatically on server startup. The migration runner:
1. Creates a `_migrations` tracking table if it doesn't exist
2. Checks which migrations have already run
3. Runs new ones in order
4. Records each completed migration

### Connection

The server uses a connection pool (`pg.Pool`). Config comes from environment variables with sensible defaults:
- `DB_HOST` (default: `localhost`)
- `DB_PORT` (default: `5432`)
- `DB_USER` (default: `postgres`)
- `DB_PASSWORD` (default: `postgres`)
- `DB_NAME` (default: `sysflow`)

---

## 15. Docker

The project includes a `docker-compose.yml` for easy setup:

```bash
# Start PostgreSQL + server
docker compose up -d

# Start only PostgreSQL (if running server locally)
docker compose up -d postgres
```

### Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| `postgres` | `postgres:16-alpine` | 5432 | PostgreSQL database |
| `server` | Built from `server/Dockerfile` | 3000 | Sysflow API server |

### Data persistence

PostgreSQL data is stored in a Docker volume (`pgdata`), so it persists across container restarts.

---

## 16. Environment Variables

### Server-side (.env file)

These go in `server/.env` (see `server/.env.example`):

| Variable | Required? | Default | Description |
|----------|-----------|---------|-------------|
| `DB_HOST` | No | `localhost` | PostgreSQL host |
| `DB_PORT` | No | `5432` | PostgreSQL port |
| `DB_USER` | No | `postgres` | PostgreSQL user |
| `DB_PASSWORD` | No | `postgres` | PostgreSQL password |
| `DB_NAME` | No | `sysflow` | PostgreSQL database name |
| `GEMINI_API_KEY` | If using Gemini | — | Google AI Studio API key |
| `OPENROUTER_API_KEY` | If using OpenRouter | — | OpenRouter API key |
| `ANTHROPIC_API_KEY` | If using Claude | — | Anthropic API key |
| `JWT_SECRET` | Recommended | `sysflow-secret-change-me` | Secret for JWT signing |
| `STRIPE_SECRET_KEY` | If using billing | — | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | If using billing | — | Stripe webhook signing secret |

**You need at least one AI provider key.** If you only want to use OpenRouter, you don't need a Gemini key, and vice versa.

### Client-side (environment)

These are optional and can be set in your shell:

| Variable | Default | Description |
|----------|---------|-------------|
| `SYS_SERVER_URL` | `http://localhost:3000` | URL of the API server |

---

## 17. Adding a New Model Provider

If you want to add support for a new AI service, follow these steps:

### Step 1: Create the provider file

Create a new file in `server/src/providers/`. For example, `my-provider.js`:

```javascript
// Conversation history per run
const runHistories = new Map()

const SYSTEM_PROMPT = `You are an AI coding agent...`
// Copy the system prompt from openrouter.js or gemini.js and adjust as needed.
// It must include tool definitions, terminal command rules, and memory rules.

export async function callMyProviderAdapter(payload) {
  // payload contains:
  //   .model         - the model ID (e.g. "my-model")
  //   .runId         - unique ID for this run
  //   .userMessage   - the user's prompt
  //   .directoryTree - array of { name, type } for the project
  //   .context       - project context and memory
  //   .toolResult    - if this is a continuation, the previous tool result
  //   .task          - task metadata
  //   .userId        - authenticated user ID (or null)
  //   .chatId        - active chat ID (or null)

  // Your code here: call the AI API, parse the response

  // Return a normalized response:
  return {
    kind: "needs_tool",  // or "completed" or "failed"
    tool: "write_file",
    args: { path: "app.js", content: "..." },
    content: "Creating app.js",
    reasoning: "I need to create the main file",
    usage: { inputTokens: 100, outputTokens: 50 }
  }
}
```

### Step 2: Add it to the adapter router

Edit `server/src/providers/adapter.js`:

```javascript
import { callMyProviderAdapter } from "./my-provider.js"

// Inside the switch statement:
case "my-model":
  return callMyProviderAdapter(payload)
```

### Step 3: Add it to the client model list

Edit `cli-client/src/lib/sysbase.js`, add to the `MODELS` array:

```javascript
{ id: "my-model", label: "My Model", desc: "Description here", visible: true }
```

### Step 4: Add any API keys to .env

If your provider needs an API key, add it to `server/.env` and read it with `process.env.MY_API_KEY`.

### That's it

Restart the server (`npm run dev`), and you can now use `sys model my-model`.

---

## 18. Troubleshooting

### "Server error 500" or "API key is not set"

The server needs to be restarted after adding or changing API keys in `.env`. Stop the server (Ctrl+C) and run `npm run dev` again.

### "Rate limit hit" or 429 error

You've made too many requests in a short time. Wait 1-2 minutes and try again. Or switch to a different model:

```bash
sys model openrouter-auto
```

### "Usage limit reached"

You've hit your plan's daily/credit limit. The CLI will show your current plan and remaining credits. Upgrade with `sys billing` or wait until tomorrow (free plan resets daily).

### "fetch failed" or "network error"

The server might have lost connection to the AI provider. The OpenRouter provider retries automatically (up to 2 times). If it keeps failing:
- Check your internet connection
- The free model might be overloaded — try a different one
- Restart the server

### "Connection error: Unexpected token '<'"

The server is returning HTML error pages instead of JSON. This usually means the server is running but routes aren't registered. Restart the server and check for startup errors.

### The AI created files in the wrong place

The system prompt tells the AI not to do this, but cheaper/free models sometimes ignore instructions. Try a more capable model.

### "Unknown model: xyz"

You typed a model name that doesn't exist. Run `sys model` to see all available models.

### The agent seems stuck (spinner keeps spinning)

The AI model is still thinking. Free models can be slow (10-30 seconds per response). The client has a 5-minute timeout. If it takes longer than that, it will error out.

### "3 consecutive errors" and the agent stops

The same tool failed 3 times in a row. This usually means the AI is sending bad arguments. Check the server logs for details. This safety feature prevents infinite loops.

### Command hangs / run_command never returns

Long-running commands (`npm start`, `node server.js`) are automatically detected and skipped. If a regular command hangs, it will be killed after 30 seconds with partial output.

### Database connection errors

Make sure PostgreSQL is running:
```bash
# Docker
docker compose up -d postgres

# Check if running
docker compose ps
```

---

## 19. File Reference

### CLI Client (`cli-client/`)

| File | Purpose |
|------|---------|
| `bin/sys.js` | Global entry point. Makes `sys` available as a terminal command. |
| `src/index.js` | Parses CLI arguments and routes to the right command or agent. |
| `src/agent/agent.js` | Main agent loop. Sends prompts, displays reasoning, executes tools, shows output with spinners. |
| `src/agent/executor.js` | Takes a tool action from the server and calls the matching tool function. Sends result back. |
| `src/agent/tools.js` | Low-level tool functions: read, write, delete, move, search, run commands, scan directories. |
| `src/commands/auth.js` | Login, register, logout, whoami commands. |
| `src/commands/billing.js` | Plan picker UI (box-drawing), usage display, Stripe checkout flow. |
| `src/commands/chats.js` | Chat session management: list, create, switch, delete, ensureActiveChat. |
| `src/commands/model.js` | Interactive arrow-key model picker with reasoning toggle. |
| `src/cli/ui.js` | Interactive mode. Shows prompt, reads input, runs agent in a loop. |
| `src/cli/parser.js` | Turns raw input into structured command objects. |
| `src/lib/server.js` | HTTP client. POSTs to `/agent/run` with JWT auth and 5-minute timeout. |
| `src/lib/sysbase.js` | Manages sysbase folder, model list, auth tokens, chat state. |

### API Server (`server/`)

| File | Purpose |
|------|---------|
| `.env` | API keys and DB credentials. Never commit this. |
| `.env.example` | Template for `.env`. |
| `Dockerfile` | Docker image definition for the server. |
| `src/index.js` | Starts Fastify, registers routes, initializes database. |
| `src/services/context.js` | Loads project context: memories, fix files from sysbase. |
| `src/services/task.js` | Creates task objects from user prompts (title, goal, steps). |
| `src/routes/agent.js` | `POST /agent/run` — routes to user-message or tool-result handler. |
| `src/routes/auth.js` | Register, login endpoints. JWT extraction helper (`extractUser`). |
| `src/routes/chats.js` | CRUD for chat sessions. |
| `src/routes/billing.js` | Stripe checkout, webhooks, plan listing, usage summary, SSE. |
| `src/handlers/user-message.js` | Handles new prompts: creates run, loads context, calls AI. |
| `src/handlers/tool-result.js` | Handles tool results: records action, calls AI, finalizes if done. |
| `src/providers/adapter.js` | Routes model names to the correct provider function. |
| `src/providers/normalize.js` | Converts any provider's response to the standard client format. |
| `src/providers/gemini.js` | Google Gemini provider. Official SDK, structured output, multi-turn. |
| `src/providers/openrouter.js` | OpenRouter provider. Fetch, OpenAI format, retry logic, multi-turn. |
| `src/providers/swe.js` | Mock provider for testing. |
| `src/providers/claude-sonnet.js` | Anthropic Claude Sonnet 4 provider. |
| `src/providers/claude-opus.js` | Anthropic Claude Opus 4 provider. |
| `src/store/sessions.js` | Session history: save, load, summarize (PostgreSQL). |
| `src/store/context.js` | Context entries: patterns, fixes, memories (PostgreSQL). |
| `src/store/subscriptions.js` | Plans, billing limits, Stripe sync (PostgreSQL). |
| `src/store/usage.js` | Token usage tracking and cost calculation. |
| `src/store/runs.js` | In-memory run state. |
| `src/store/tasks.js` | In-memory task state. |
| `src/store/tool-results.js` | In-memory tool results per run. |
| `src/store/memory.js` | In-memory project memory. |
| `src/store/checkout-events.js` | SSE event emitter for Stripe checkout. |
| `src/db/connection.js` | PostgreSQL pool, query helper, migration runner. |
| `src/db/migrations/` | Schema migrations 001–009. |

---

## Quick Start Summary

```bash
# Terminal 1: Start PostgreSQL (Docker)
cd sysflow
docker compose up -d postgres

# Terminal 1: Start the server
cd server
npm install
cp .env.example .env     # Fill in your API key(s)
npm run dev

# Terminal 2: Install and use the CLI
cd sysflow/cli-client
npm install
npm link

# Create account and start coding
sys register
sys login
sys model                # Pick a model
cd ~/your-project
sys "create a REST API with Express"
```

That's it. The agent will start creating files and running commands in your project folder.
