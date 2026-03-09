export default {
  name: "001_create_sessions",
  up: `
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      run_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'unknown',
      error TEXT,
      files_modified TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions (project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at DESC);
  `
}
