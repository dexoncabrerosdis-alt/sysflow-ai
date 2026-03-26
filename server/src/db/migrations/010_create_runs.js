export default {
  name: "010_create_runs",
  up: `
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      model TEXT NOT NULL,
      content TEXT NOT NULL,
      command TEXT,
      cwd TEXT,
      sysbase_path TEXT,
      user_id TEXT,
      chat_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_runs_project_id ON runs (project_id);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
    CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs (created_at DESC);
  `
}
