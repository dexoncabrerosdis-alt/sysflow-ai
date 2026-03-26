export default {
  name: "012_create_tasks",
  up: `
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      model TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      goal TEXT NOT NULL DEFAULT '',
      steps JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'running',
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks (run_id);
  `
}
