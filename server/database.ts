import { Database as BunSqlite, type SQLQueryBindings } from "bun:sqlite";
import {
  CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresDialect,
  type QueryResult,
  type RawBuilder,
  sql,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { Pool, types } from "pg";
import { z } from "zod";
import type { Database } from "./schemas.ts";

export type { Database } from "./schemas.ts";

/** A connection to nanotes' database, or a transaction on it. */
export type Db = Kysely<Database>;

/** Each migration is a list of statements, run in one transaction with the version bump. */
const SQLITE_MIGRATIONS: readonly (readonly RawBuilder<unknown>[])[] = [
  [
    sql`CREATE TABLE kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    sql`CREATE TABLE notes (
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
    )`,
    sql`CREATE INDEX notes_rev ON notes (rev)`,
    sql`CREATE UNIQUE INDEX notes_active_path ON notes (path) WHERE deleted_at IS NULL`,
    sql`CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    sql`CREATE TABLE passkeys (
      id BLOB PRIMARY KEY,
      cose_key BLOB NOT NULL,
      sign_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`,
    sql`CREATE TABLE passkey_setup_links (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    )`,
    sql`CREATE TABLE device_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`,
    sql`CREATE TABLE device_pairings (
      code TEXT PRIMARY KEY,
      poll_token_hash TEXT NOT NULL UNIQUE,
      device_name TEXT NOT NULL,
      approved_token TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ],
  [sql`ALTER TABLE notes ADD COLUMN yjs_state BLOB`],
  [
    sql`CREATE INDEX IF NOT EXISTS notes_active_order
      ON notes (pinned DESC, updated_at DESC)
      WHERE deleted_at IS NULL`,
  ],
];

/** The same schema for Postgres, step for step: millisecond times are BIGINT and blobs are BYTEA. */
const POSTGRES_MIGRATIONS: readonly (readonly RawBuilder<unknown>[])[] = [
  [
    sql`CREATE TABLE kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    sql`CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      rev BIGINT NOT NULL,
      deleted_at BIGINT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
    sql`CREATE INDEX notes_rev ON notes (rev)`,
    sql`CREATE UNIQUE INDEX notes_active_path ON notes (path) WHERE deleted_at IS NULL`,
    sql`CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    )`,
    sql`CREATE TABLE passkeys (
      id BYTEA PRIMARY KEY,
      cose_key BYTEA NOT NULL,
      sign_count BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT
    )`,
    sql`CREATE TABLE passkey_setup_links (
      token_hash TEXT PRIMARY KEY,
      expires_at BIGINT NOT NULL,
      used_at BIGINT
    )`,
    sql`CREATE TABLE device_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT
    )`,
    sql`CREATE TABLE device_pairings (
      code TEXT PRIMARY KEY,
      poll_token_hash TEXT NOT NULL UNIQUE,
      device_name TEXT NOT NULL,
      approved_token TEXT,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL
    )`,
  ],
  [sql`ALTER TABLE notes ADD COLUMN yjs_state BYTEA`],
  [
    sql`CREATE INDEX IF NOT EXISTS notes_active_order
      ON notes (pinned DESC, updated_at DESC)
      WHERE deleted_at IS NULL`,
  ],
];

class BunSqliteConnection implements DatabaseConnection {
  readonly #db: BunSqlite;

  constructor(db: BunSqlite) {
    this.#db = db;
  }

  executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const stmt = this.#db.query(compiledQuery.sql);
    const params = compiledQuery.parameters as SQLQueryBindings[];
    if (stmt.columnNames.length > 0) {
      const rows = stmt.all(...params) as R[];
      return Promise.resolve({ rows });
    }
    const result = stmt.run(...params);
    return Promise.resolve({
      numAffectedRows: BigInt(result.changes),
      insertId: BigInt(result.lastInsertRowid),
      rows: [],
    });
  }

  async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    const stmt = this.#db.query(compiledQuery.sql);
    const params = compiledQuery.parameters as SQLQueryBindings[];
    for (const row of stmt.iterate(...params)) {
      yield { rows: [row as R] };
    }
  }
}

/** One bun:sqlite connection, handed to one query or transaction at a time. */
class BunSqliteDriver implements Driver {
  readonly #db: BunSqlite;
  readonly #connection: BunSqliteConnection;
  #lock: Promise<void> = Promise.resolve();
  #releaseLock: (() => void) | null = null;

  constructor(path: string) {
    this.#db = new BunSqlite(path, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.#connection = new BunSqliteConnection(this.#db);
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>((res) => {
      release = res;
    });
    await previous;
    this.#releaseLock = release;
    return this.#connection;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  releaseConnection(): Promise<void> {
    const release = this.#releaseLock;
    this.#releaseLock = null;
    release?.();
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.#db.close();
    return Promise.resolve();
  }
}

const INT8_OID = 20;

function postgresPool(connectionString: string): Pool {
  const getTypeParser = ((oid: number, format?: "text" | "binary") =>
    oid === INT8_OID ? Number : types.getTypeParser(oid, format)) as typeof types.getTypeParser;
  // Millisecond times and revisions are BIGINT; read them back as numbers, as SQLite does.
  return new Pool({ connectionString, types: { getTypeParser } });
}

export function isPostgresUrl(target: string): boolean {
  return /^postgres(ql)?:\/\//i.test(target);
}

export function isPostgres(db: Db): boolean {
  return db.getExecutor().adapter instanceof PostgresAdapter;
}

const VersionSchema = z.object({ version: z.number() });

async function schemaVersion(db: Db): Promise<number> {
  if (!isPostgres(db)) {
    const row = await queryOne(db, sql`SELECT user_version AS version FROM pragma_user_version`, VersionSchema);
    return row?.version ?? 0;
  }
  await sql`CREATE TABLE IF NOT EXISTS nanotes_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)`.execute(db);
  const row = await queryOne(db, sql`SELECT version FROM nanotes_schema WHERE id = 1`, VersionSchema);
  return row?.version ?? 0;
}

async function setSchemaVersion(db: Db, version: number): Promise<void> {
  if (!isPostgres(db)) {
    await sql`PRAGMA user_version = ${sql.lit(version)}`.execute(db);
    return;
  }
  await sql`INSERT INTO nanotes_schema (id, version) VALUES (1, ${version})
    ON CONFLICT (id) DO UPDATE SET version = excluded.version`.execute(db);
}

async function migrate(db: Db): Promise<void> {
  const migrations = isPostgres(db) ? POSTGRES_MIGRATIONS : SQLITE_MIGRATIONS;
  const version = await schemaVersion(db);
  for (let index = version; index < migrations.length; index += 1) {
    // Each step builds on the one before, so they run in order.
    // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop
    await db.transaction().execute(async (trx) => {
      for (const statement of migrations[index] ?? []) {
        // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop
        await statement.execute(trx);
      }
      await setSchemaVersion(trx, index + 1);
    });
  }
}

/**
 * Opens nanotes' database and brings its schema up to date. A `postgres://` or `postgresql://`
 * URL connects to Postgres; anything else is a SQLite file path (or `:memory:`).
 */
export async function openDatabase(target: string): Promise<Db> {
  const db = isPostgresUrl(target)
    ? new Kysely<Database>({ dialect: new PostgresDialect({ pool: postgresPool(target) }) })
    : new Kysely<Database>({
        dialect: {
          createAdapter: () => new SqliteAdapter(),
          createDriver: () => new BunSqliteDriver(target),
          createIntrospector: (kysely) => new SqliteIntrospector(kysely),
          createQueryCompiler: () => new SqliteQueryCompiler(),
        },
      });
  try {
    await migrate(db);
  } catch (cause) {
    await db.destroy();
    throw cause;
  }
  return db;
}

/** Run a raw Kysely SQL query and parse every row with a Zod schema. */
export async function queryRows<T extends z.ZodType>(db: Db, query: RawBuilder<unknown>, schema: T): Promise<z.infer<T>[]> {
  const { rows } = await query.execute(db);
  return rows.map((row) => schema.parse(row));
}

/** Run a raw Kysely SQL query and parse the first row with a Zod schema (or null). */
export async function queryOne<T extends z.ZodType>(db: Db, query: RawBuilder<unknown>, schema: T): Promise<z.infer<T> | null> {
  const { rows } = await query.execute(db);
  const first = rows[0];
  return first === undefined ? null : schema.parse(first);
}

const SettingSchema = z.object({ value: z.string() });

export async function readSetting(db: Db, key: string): Promise<string | null> {
  const row = await queryOne(db, sql`SELECT value FROM kv WHERE key = ${key}`, SettingSchema);
  return row ? row.value : null;
}

export async function writeSetting(db: Db, key: string, value: string): Promise<void> {
  await db
    .insertInto("kv")
    .values({ key, value })
    .onConflict((conflict) => conflict.column("key").doUpdateSet({ value: (eb) => eb.ref("excluded.value") }))
    .execute();
}
