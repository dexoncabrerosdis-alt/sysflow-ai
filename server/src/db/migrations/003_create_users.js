export default {
  name: "003_create_users",
  up: `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username);
  `
}
