<div align="center">

# Sysflow

### The AI coding agent that works **inside your terminal** — not above it.

Build faster, stay in control, and let AI execute real work on your machine with full visibility.

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://postgresql.org/)
[![Google Gemini](https://img.shields.io/badge/Gemini-8E75B2?style=flat-square&logo=googlegemini&logoColor=white)](https://ai.google.dev/)
[![OpenRouter](https://img.shields.io/badge/OpenRouter-6366F1?style=flat-square&logo=openai&logoColor=white)](https://openrouter.ai/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white)](https://docker.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

**Prompt it. Watch it think. Let it ship.**

</div>

---

## Why Sysflow exists

Most AI coding tools feel impressive in demos and frustrating in real work.

They hide too much.  
They lock you into one model.  
They act like magic until they break something you care about.

**Sysflow was built for developers who want speed without surrendering control.**

It is an AI coding agent that runs from your terminal, understands your project, proposes actions, and executes work locally on your machine. You see the loop. You keep ownership of the environment. And instead of hoping the AI did the right thing, you can actually follow what it’s doing.

This is not “AI that writes snippets.”

This is **AI that can move work forward**.

---

## What makes Sysflow different

### 1. It runs where real work happens
Sysflow lives in the CLI, inside the project you are already working on. No context switching. No bloated browser workflow. No fake “developer experience” built for screenshots.

### 2. The AI decides — your machine executes
The model does not directly touch your files. It returns actions. The CLI executes them locally. That means more transparency, more trust, and less black-box behavior.

### 3. You choose the brain
Use Gemini, OpenRouter, and an architecture that is already designed for multi-provider support. You are not trapped in a one-model product.

### 4. It remembers the work
Session history is persisted, so Sysflow can carry context across prompts in the same chat session instead of starting from zero every time.

### 5. It is built like a product, not a hack
Auth, usage tracking, billing, project context, session handling, model routing, local execution — this is not just an experiment. It is the foundation of a serious AI developer product.

---

## The promise

**Sysflow helps developers go from idea to working code with less friction, less repetition, and more control.**

Whether you are scaffolding a backend, refactoring a file, planning a feature, or iterating inside an existing repo, Sysflow is designed to feel like a capable technical operator sitting in your terminal with you.

Not replacing you.  
Not fighting you.  
**Accelerating you.**

---

## Core capabilities

- **Terminal-native AI workflow** — run prompts directly from your CLI
- **Local tool execution** — file writes and command execution happen on your machine
- **Project-aware context** — scans your working directory to understand the repo
- **Persistent session memory** — remembers prior work inside the same chat flow
- **Model switching** — choose between available providers and models
- **Interactive and one-shot modes** — use it for fast commands or longer working sessions
- **File targeting with `@mentions`** — reference files directly in prompts
- **Planning + implementation flow** — create plans, then execute against them
- **Authentication and billing support** — ready for real user accounts and subscription logic
- **Docker-friendly setup** — easy local bootstrapping for the stack

---

## How it works

At a high level, Sysflow is made of two parts:

### CLI Client
The CLI is what you use day to day. It:
- runs in your terminal
- scans your project
- sends prompts and context to the server
- displays reasoning and actions
- executes tools locally on your machine

### API Server
The server handles orchestration. It:
- authenticates users
- checks usage limits
- loads session history
- manages project context
- routes requests to AI providers
- normalizes responses
- tracks usage and billing

### The loop

```text
You type a prompt
      ↓
CLI scans project context
      ↓
Server loads auth, usage, memory, and model
      ↓
AI decides the next action
      ↓
CLI executes that action locally
      ↓
Result is sent back
      ↓
Loop continues until the task is complete
```

The key idea is simple:

The model thinks. The CLI acts. You stay in control.

Quick start
Prerequisites
Node.js 20+
PostgreSQL 15+ or Docker
An API key for at least one provider
1. Clone the repo
git clone https://github.com/dexonapi-alt/sysflow-ai.git
cd sysflow-ai
2. Start PostgreSQL
docker compose up -d postgres
3. Set up the server
cd server
npm install
cp .env.example .env

Fill in your environment variables in server/.env.

4. Start the server
npm run dev
5. Set up the CLI

Open a new terminal:

cd cli-client
npm install
npm link

This makes the sys command available globally.

6. Start using Sysflow
sys register
sys login
sys model
cd ~/my-project
sys "create a REST API with Express"
Example workflows
One-shot execution
sys "create an express server with a health check endpoint"
Interactive mode
sys

Useful when you want to keep iterating in one session.

Switch models
sys model

Or set one directly:

sys model gemini-flash
Target a specific file
sys "refactor @src/app.js to use async/await"
Plan first, then implement

Inside interactive mode:

/plan build a REST API for user management
/implement build a REST API for user management
CLI commands
Command	What it does
sys	Start interactive mode
sys "prompt"	Run a one-shot prompt
sys register	Create an account
sys login	Log in
sys logout	Clear local auth
sys whoami	View account and usage
sys model	Open model picker
sys billing	Manage subscription
sys usage	View token usage
sys chats	Manage chat sessions
sys delete-chat	Delete active chat
Interactive commands
Command	What it does
/model	Open the model picker
/model gemini-flash	Switch model directly
/plan ...	Create a plan
/implement ...	Execute a saved plan
/continue	Continue the last interrupted run
/exit or /quit	Leave interactive mode
Available models

Current visible options include:

openrouter-auto — best available model via OpenRouter
gemini-flash — fast direct Gemini option

The codebase is also structured for broader provider support, including additional hidden or placeholder model paths.

Tech stack
Server
Fastify
TypeScript
PostgreSQL
Stripe
AI providers
Google Gemini
OpenRouter
Anthropic-ready provider structure
CLI
Node.js
TypeScript
Chalk
Ora
WebSocket support
Tooling
Docker
tsx
Architecture
sysflow-ai/
├── cli-client/        # Terminal client and local execution layer
├── server/            # API server and orchestration engine
├── docs/              # Project documentation
├── docker-compose.yml
└── README.md
Server responsibilities
auth and identity
model orchestration
session history
project context loading
usage tracking
billing logic
provider normalization
CLI responsibilities
terminal interface
local tool execution
project scanning
prompt submission
interactive workflow
Environment variables

Create server/.env from the example file:

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=sysflow

# AI Providers
GEMINI_API_KEY=
OPENROUTER_API_KEY=

# Auth
JWT_SECRET=change-me-in-production

# Billing
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
Who this is for

Sysflow is for:

developers who want AI help without losing control
builders who prefer the terminal over glossy dashboards
teams exploring AI-native developer workflows
founders creating serious coding agents, not toy wrappers
anyone who believes speed matters, but trust matters more
Current direction

Sysflow is already more than a CLI wrapper. It is shaping into a full execution layer for AI-assisted development — one where model flexibility, local action, persistent memory, and product-grade orchestration come together in one system.

That matters because the future of developer tools will not be won by whoever has the flashiest demo.

It will be won by whoever builds the tool developers trust enough to use every day.

That is what Sysflow is aiming to become.

Documentation
docs/general-doc.md — full product and architecture guide
docs/server.md — server deep dive
docs/cli-client.md — CLI deep dive
License

MIT

<div align="center">
Build faster. Stay in control. Ship with confidence.

Sysflow — AI execution for developers who still want the last word.

</div> 