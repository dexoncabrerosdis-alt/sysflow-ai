export default {
  name: "006_create_context_entries",
  up: `
    CREATE TABLE IF NOT EXISTS context_entries (
      id SERIAL PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      category TEXT NOT NULL DEFAULT 'general',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_context_project ON context_entries (project_id);
    CREATE INDEX IF NOT EXISTS idx_context_category ON context_entries (category);
    CREATE INDEX IF NOT EXISTS idx_context_tags ON context_entries USING GIN (tags);
  `
}
