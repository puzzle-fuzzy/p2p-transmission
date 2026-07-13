import type { Database } from "bun:sqlite";

export const applyMigrations = (database: Database) => {
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY,
      avatar_seed TEXT NOT NULL,
      display_name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      sender_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      invite_digest BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_participants (
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      visitor_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('sender', 'receiver')),
      joined_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('connecting', 'online')),
      attach_deadline_at INTEGER,
      PRIMARY KEY (room_code, visitor_id)
    );

    CREATE TABLE IF NOT EXISTS room_join_requests (
      request_id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
      visitor_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'finalized')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      UNIQUE (room_code, visitor_id)
    );

    CREATE INDEX IF NOT EXISTS idx_visitors_last_seen ON visitors(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_rooms_expires_at ON rooms(expires_at);
    CREATE INDEX IF NOT EXISTS idx_join_requests_expires_at ON room_join_requests(expires_at);
  `);

  const version = database.query<{ version: number }, []>(
    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
  ).get()?.version ?? 0;
  if (version < 1) {
    database.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(1, Date.now());
  }
};
