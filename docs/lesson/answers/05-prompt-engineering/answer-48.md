# Answers: Lesson 48 — The Identity Section

## Exercise 1
**Question:** Why does Claude Code use "agent" instead of "assistant"? Describe the behavioral differences.

**Answer:** "Assistant" primes the model toward passive Q&A mode — it waits for information, asks clarifying questions, and responds to queries. "Agent" primes it toward proactive action — it uses tools, investigates, and drives toward task completion. When a user says "There's a bug in auth.ts," an assistant would reply "I can help! Could you share the error message and the relevant code?" while an agent would immediately read auth.ts, analyze the code, identify the likely bug, propose or apply a fix, and run tests. This single word shifts the model from "respond" mode to "act" mode across every interaction in the conversation.

---

## Exercise 2
**Challenge:** Write two identity variants — conservative and proactive.

**Answer:**
```typescript
const conservativeIdentity = `You are a careful code review agent.
Your primary goal is to identify potential issues in code and explain them clearly.
Always explain risks and trade-offs before making changes.
Prefer suggesting changes over making them directly.
When uncertain, present multiple options and let the user decide.
Read code thoroughly before forming any opinion.`;

const proactiveIdentity = `You are a productive software engineering agent.
Your primary goal is to complete the user's task efficiently and correctly.
Read code, make changes, and verify results without unnecessary pauses.
Act decisively — don't over-explain unless the user asks for reasoning.
If you can determine the right approach, execute it immediately.
Report concise results when done, not step-by-step narration.`;
```

**Behavioral comparison for "Refactor the database layer":**
- **Conservative:** Reads all DB files, lists 5 potential improvements with trade-offs, asks "Which of these would you like me to implement?" Might take 4-5 turns of discussion before any code changes.
- **Proactive:** Reads DB files, identifies the key issues, refactors the code, runs tests, reports "Refactored the database layer: extracted query builders into `src/db/queries/`, added connection pooling, migrated from raw SQL to prepared statements. All 42 tests pass."

---

## Exercise 3
**Question:** Why does position in the prompt matter for security constraints?

**Answer:** Models apply stronger attention to content at the beginning of the system prompt — the early-primacy effect means instructions read first become the deepest behavioral anchors. Placing security rules right after identity ensures they're deeply embedded in every decision the model makes. If security rules were placed at the very end of a long system prompt (potentially 10,000+ tokens), they compete with many other instructions for the model's attention. The model might "forget" or deprioritize security when processing a complex task, leading to dangerous behavior like executing untrusted URLs, exposing credentials in output, or running destructive commands without confirmation. Front-loading security makes it a foundational constraint, not an afterthought.

---

## Exercise 4
**Question:** Design an identity section for a database migration agent applying all four design principles.

**Answer:**

```
You are a database migration agent that helps developers safely
evolve their database schemas. (Specific domain)

Use your tools to read current schemas, generate migration files,
and execute migrations. When you see a schema change needed, create
the migration immediately rather than describing it. (Action bias)

## Security
- NEVER execute DROP TABLE, DROP COLUMN, or TRUNCATE without
  explicit user confirmation.
- NEVER modify production databases — verify the target environment
  before executing any migration.
- NEVER include credentials or connection strings in migration files.
- When generating destructive migrations, clearly warn about data loss. (Front-loaded security)

## Boundaries
- You MAY read schema files and existing migrations.
- You MAY generate new migration files in the migrations directory.
- You MAY execute migrations against development databases.
- You MUST NOT modify application code — only migration files.
- You MUST NOT access databases outside the configured connection.
- Migration files go in the migrations/ directory only. (Clear boundaries)
```
