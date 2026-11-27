import { afterAll, describe, expect, test } from "bun:test";
import { Database as BunSqlite } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { z } from "zod";
import { createApp } from "../server/app.ts";
import { openDatabase, queryOne, queryRows } from "../server/database.ts";
import { NoteRowSchema, PasskeyRowSchema } from "../server/schemas.ts";
import { engines, releaseTestDatabases, testDatabase } from "./databases.ts";

afterAll(releaseTestDatabases);

/** The first schema nanotes ever shipped, as an old server left it on disk. */
const LEGACY_V1 = `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE notes (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    content_hash TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL,
    deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX notes_rev ON notes (rev);
  CREATE UNIQUE INDEX notes_active_path ON notes (path) WHERE deleted_at IS NULL;
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE passkeys (id BLOB PRIMARY KEY, cose_key BLOB NOT NULL, sign_count INTEGER NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER);
  CREATE TABLE passkey_setup_links (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER);
  CREATE TABLE device_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER);
  CREATE TABLE device_pairings (code TEXT PRIMARY KEY, poll_token_hash TEXT NOT NULL UNIQUE, device_name TEXT NOT NULL, approved_token TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
  PRAGMA user_version = 1;
`;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("existing SQLite databases", () => {
  test("a database written by an old server upgrades in place and keeps serving its notes and devices", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nanotes-legacy-"));
    const path = join(dir, "nanotes.sqlite");
    const now = 1_700_000_000_000;
    const legacy = new BunSqlite(path, { create: true });
    legacy.exec(LEGACY_V1);
    legacy
      .query("INSERT INTO notes VALUES ('n1', 'Groceries.md', 'Groceries', ?, ?, 1, 4, NULL, ?, ?)")
      .run("# Groceries\n\neggs", sha256("# Groceries\n\neggs"), now, now);
    legacy.query("INSERT INTO kv VALUES ('sync_rev', '4')").run();
    legacy.query("INSERT INTO device_tokens VALUES ('d1', 'Laptop', ?, ?, NULL)").run(sha256("nts_old-token"), now);
    legacy.close();

    const options = { databasePath: path, passwordHash: null, mcpToken: null, secureCookies: false, origin: null, webDistDir: null };
    const bearer = { authorization: "Bearer nts_old-token" };
    try {
      const app = await createApp({ ...options, clock: () => now });
      const changes = await app.fetch(new Request("http://localhost/api/sync/changes?since=0", { headers: bearer }));
      expect(changes.status).toBe(200);
      expect(await changes.json()).toMatchObject({
        rev: 4,
        changes: [{ id: "n1", path: "Groceries.md", content: "# Groceries\n\neggs", pinned: true, rev: 4 }],
      });
      const pushed = await app.fetch(
        new Request("http://localhost/api/sync/push", {
          method: "POST",
          headers: { ...bearer, "content-type": "application/json" },
          body: JSON.stringify({ ops: [{ id: "n1", baseRev: 4, content: "# Groceries\n\neggs\nmilk" }] }),
        }),
      );
      expect(await pushed.json()).toMatchObject({ rev: 5, results: [{ id: "n1", status: "ok" }] });
      await app.close();

      // Reopening a migrated database runs no migration twice and keeps the write.
      const reopened = await createApp({ ...options, clock: () => now });
      expect((await reopened.notes.get("Groceries.md"))?.content).toBe("# Groceries\n\neggs\nmilk");
      await reopened.close();
      const upgraded = new BunSqlite(path, { readonly: true });
      expect(upgraded.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.each(engines())("Zod-parsed rows on %s", (engine) => {
  test("rows come back typed, blobs as bytes, and a row that breaks its schema is refused", async () => {
    const db = await openDatabase(await testDatabase(engine));
    try {
      const key = Uint8Array.of(0, 1, 2, 255);
      const now = 1_700_000_000_000;
      await db.insertInto("passkeys").values({ id: key, cose_key: key, sign_count: 7, created_at: now, last_used_at: null }).execute();
      const passkey = await queryOne(db, sql`SELECT * FROM passkeys WHERE id = ${key}`, PasskeyRowSchema);
      expect(passkey).not.toBeNull();
      expect(new Uint8Array(passkey!.cose_key)).toEqual(key);
      expect(passkey).toMatchObject({ sign_count: 7, created_at: now, last_used_at: null });

      expect(await queryRows(db, sql`SELECT * FROM notes`, NoteRowSchema)).toEqual([]);
      expect(await queryOne(db, sql`SELECT * FROM notes`, NoteRowSchema)).toBeNull();

      const wrongShape = z.object({ id: z.string() });
      await expect(queryRows(db, sql`SELECT sign_count AS id FROM passkeys`, wrongShape)).rejects.toThrow(z.ZodError);
    } finally {
      await db.destroy();
    }
  });
});
