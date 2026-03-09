export default {
  name: "002_create_run_actions",
  up: `
    CREATE TABLE IF NOT EXISTS run_actions (
      id SERIAL PRIMARY KEY,
      run_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      path TEXT,
      command TEXT,
      extra JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_run_actions_run_id ON run_actions (run_id);
    CREATE INDEX IF NOT EXISTS idx_run_actions_project_id ON run_actions (project_id);
  `
}
