export default {
  name: "011_create_tool_results",
  up: `
    CREATE TABLE IF NOT EXISTS tool_results (
      id SERIAL PRIMARY KEY,
      run_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      result JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tool_results_run_id ON tool_results (run_id);
  `
}
