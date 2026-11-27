import { Database } from "bun:sqlite";

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX notes_rev ON notes (rev);
  CREATE UNIQUE INDEX notes_active_path ON notes (path) WHERE deleted_at IS NULL;

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE passkeys (
    id BLOB PRIMARY KEY,
    cose_key BLOB NOT NULL,
    sign_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE passkey_setup_links (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE device_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE device_pairings (
    code TEXT PRIMARY KEY,
    poll_token_hash TEXT NOT NULL UNIQUE,
    device_name TEXT NOT NULL,
    approved_token TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE notes ADD COLUMN yjs_state BLOB;
  `,
  `
  CREATE INDEX IF NOT EXISTS notes_active_order
    ON notes (pinned DESC, updated_at DESC)
    WHERE deleted_at IS NULL;
  `,
];

export function openDatabase(path: string): Database {
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const version = (database.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let index = version; index < MIGRATIONS.length; index += 1) {
    database.transaction(() => {
      database.exec(MIGRATIONS[index] as string);
      database.exec(`PRAGMA user_version = ${index + 1}`);
    })();
  }
  return database;
}

export function readSetting(database: Database, key: string): string | null {
  const row = database.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function writeSetting(database: Database, key: string, value: string): void {
  database.query("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
