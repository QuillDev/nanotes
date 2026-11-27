import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { type Db, isPostgres, queryOne, queryRows, readSetting, writeSetting } from "./database.ts";
import { NoteRowSchema } from "./schemas.ts";

export interface SyncedNote {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly content: string;
  readonly contentHash: string;
  readonly pinned: boolean;
  readonly rev: number;
  readonly deletedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NoteSummary {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly pinned: boolean;
  readonly rev: number;
  readonly updatedAt: number;
  readonly size: number;
}

export interface SyncPushOp {
  readonly id: string;
  readonly baseRev: number;
  readonly path?: string;
  readonly content?: string;
  readonly pinned?: boolean;
  readonly deleted?: boolean;
}

export type SyncPushResult =
  | { readonly id: string; readonly status: "ok"; readonly note: SyncedNote }
  | { readonly id: string; readonly status: "conflict"; readonly serverNote: SyncedNote };

const NoteSchema = NoteRowSchema.omit({ yjs_state: true });
type NoteRow = z.infer<typeof NoteSchema>;
const NoteSummarySchema = NoteRowSchema.pick({ id: true, path: true, title: true, pinned: true, rev: true, updated_at: true }).extend({
  size: z.number(),
});
type NoteSummaryRow = z.infer<typeof NoteSummarySchema>;
const NoteSummaryContentSchema = NoteSummarySchema.extend({ content: z.string() });
const YjsStateSchema = NoteRowSchema.pick({ yjs_state: true });
const CollabBaseSchema = NoteRowSchema.pick({ path: true, pinned: true, created_at: true });
const NoteIdSchema = NoteRowSchema.pick({ id: true });

const NOTE_COLUMNS = sql.raw("id, path, title, content, content_hash, pinned, rev, deleted_at, created_at, updated_at");

/** Summary columns; `size` is the note's UTF-8 byte length. */
function summaryColumns(db: Db) {
  const size = isPostgres(db) ? sql`octet_length(content)` : sql`length(CAST(content AS BLOB))`;
  return sql`id, path, title, pinned, rev, updated_at, ${size} AS size`;
}

function rowToNote(row: NoteRow): SyncedNote {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash,
    pinned: row.pinned !== 0,
    rev: row.rev,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSummary(row: NoteSummaryRow): NoteSummary {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    pinned: row.pinned !== 0,
    rev: row.rev,
    updatedAt: row.updated_at,
    size: row.size,
  };
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function titleFromContent(content: string): string {
  const firstLine = (content.split(/\r?\n/, 1)[0] ?? "").trim();
  const withoutHeading = firstLine.replace(/^#+/, "").trim();
  return withoutHeading || "Untitled";
}

export function sanitizeFilename(title: string): string {
  let sanitized = "";
  for (const ch of title) {
    if (/[A-Za-z0-9 \-_.()]/.test(ch)) {
      sanitized += ch;
    } else if (!sanitized.endsWith(" ")) {
      sanitized += " ";
    }
  }
  const cleaned = sanitized
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return cleaned ? cleaned.slice(0, 96) : "Untitled";
}

export function normalizeNotePath(rawPath: string | undefined, content: string): string {
  const trimmed = (rawPath ?? "").trim();
  if (trimmed && !trimmed.includes("/") && !trimmed.includes("\\") && !trimmed.includes("..") && !trimmed.startsWith(".")) {
    const stem = trimmed.toLowerCase().endsWith(".md") ? trimmed.slice(0, -3) : trimmed;
    return `${sanitizeFilename(stem)}.md`;
  }
  return `${sanitizeFilename(titleFromContent(content))}.md`;
}

export interface NotesHooks {
  beforeRead?: (noteId?: string) => Promise<void>;
  onExternalContent?: (note: SyncedNote) => Promise<void>;
  onNoteChanged?: (note: SyncedNote) => void;
}

/**
 * Notes and their sync revision. Public reads and writes take turns through `exclusive`, so
 * the live collab rooms (whose hooks run inside them) never see a half-finished change. The
 * collab hub runs its own work through `exclusive` too and calls only the methods marked
 * "inside exclusive".
 */
export class NotesStore {
  private hooks: NotesHooks | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly database: Db) {}

  setHooks(hooks: NotesHooks): void {
    this.hooks = hooks;
  }

  /** Runs `task` once every earlier task has finished. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  currentRev(): Promise<number> {
    return this.exclusive(async () => {
      await this.hooks?.beforeRead?.();
      return this.revision();
    });
  }

  /** The sync revision without flushing collab rooms (inside exclusive). */
  async revision(database: Db = this.database): Promise<number> {
    return Number((await readSetting(database, "sync_rev")) ?? "0");
  }

  private async nextRev(database: Db): Promise<number> {
    const next = (await this.revision(database)) + 1;
    await writeSetting(database, "sync_rev", String(next));
    return next;
  }

  /** Inside exclusive. */
  async getRaw(id: string): Promise<SyncedNote | null> {
    const row = await queryOne(this.database, sql`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ${id}`, NoteSchema);
    return row ? rowToNote(row) : null;
  }

  /** Inside exclusive. */
  async getYjsState(id: string): Promise<Uint8Array | null> {
    const row = await queryOne(this.database, sql`SELECT yjs_state FROM notes WHERE id = ${id}`, YjsStateSchema);
    return row?.yjs_state ?? null;
  }

  /** Inside exclusive. */
  async saveYjsState(id: string, state: Uint8Array): Promise<void> {
    await this.database.updateTable("notes").set({ yjs_state: state }).where("id", "=", id).execute();
  }

  /** Inside exclusive. */
  saveFromCollab(id: string, yjsState: Uint8Array, content: string, now: number): Promise<SyncedNote | null> {
    return this.database.transaction().execute(async (trx) => {
      const existing = await queryOne(
        trx,
        sql`SELECT path, pinned, created_at FROM notes WHERE id = ${id} AND deleted_at IS NULL`,
        CollabBaseSchema,
      );
      if (!existing) return null;
      const title = titleFromContent(content);
      const desiredPath = normalizeNotePath(undefined, content);
      const path = desiredPath === existing.path ? existing.path : await this.uniqueActivePath(trx, desiredPath, id);
      const hash = sha256Hex(content);
      const rev = await this.nextRev(trx);
      await trx
        .updateTable("notes")
        .set({ path, title, content, content_hash: hash, yjs_state: yjsState, rev, updated_at: now })
        .where("id", "=", id)
        .execute();
      return {
        id,
        path,
        title,
        content,
        contentHash: hash,
        pinned: existing.pinned !== 0,
        rev,
        deletedAt: null,
        createdAt: existing.created_at,
        updatedAt: now,
      };
    });
  }

  private async uniqueActivePath(database: Db, desiredPath: string, excludeId: string | null): Promise<string> {
    const stem = desiredPath.toLowerCase().endsWith(".md") ? desiredPath.slice(0, -3) : desiredPath;
    for (let index = 0; ; index += 1) {
      const candidate = index === 0 ? `${stem}.md` : `${stem} ${index}.md`;
      // Each candidate is only tried when the one before it is taken.
      // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop
      const existing = await queryOne(
        database,
        sql`SELECT id FROM notes WHERE path = ${candidate} AND deleted_at IS NULL`,
        NoteIdSchema,
      );
      if (!existing || existing.id === excludeId) return candidate;
    }
  }

  private async queryList(query?: string, limit = 200): Promise<NoteSummary[]> {
    const db = this.database;
    const needle = (query ?? "").trim().toLowerCase();
    if (!needle) {
      const rows = await queryRows(
        db,
        sql`SELECT ${summaryColumns(db)}
           FROM notes
           WHERE deleted_at IS NULL
           ORDER BY pinned DESC, updated_at DESC
           LIMIT ${limit}`,
        NoteSummarySchema,
      );
      return rows.map(rowToSummary);
    }

    // ASCII needles match identically under the database's lower(), keeping full note bodies out of JS memory.
    if (!/[^\x00-\x7f]/.test(needle)) {
      const haystack = sql`lower(title || ' ' || path || ' ' || content)`;
      const position = isPostgres(db) ? sql`strpos(${haystack}, ${needle})` : sql`instr(${haystack}, ${needle})`;
      const rows = await queryRows(
        db,
        sql`SELECT ${summaryColumns(db)}
           FROM notes
           WHERE deleted_at IS NULL
             AND ${position} > 0
           ORDER BY pinned DESC, updated_at DESC
           LIMIT ${limit}`,
        NoteSummarySchema,
      );
      return rows.map(rowToSummary);
    }

    const rows = await queryRows(
      db,
      sql`SELECT ${summaryColumns(db)}, content
         FROM notes
         WHERE deleted_at IS NULL
         ORDER BY pinned DESC, updated_at DESC`,
      NoteSummaryContentSchema,
    );
    const matched: NoteSummary[] = [];
    for (const row of rows) {
      if (`${row.title} ${row.path} ${row.content}`.toLowerCase().includes(needle)) {
        matched.push(rowToSummary(row));
        if (matched.length >= limit) break;
      }
    }
    return matched;
  }

  list(query?: string, limit = 200): Promise<NoteSummary[]> {
    return this.exclusive(async () => {
      await this.hooks?.beforeRead?.();
      return this.queryList(query, limit);
    });
  }

  listWithRev(query?: string, limit = 200): Promise<{ rev: number; notes: NoteSummary[] }> {
    return this.exclusive(async () => {
      await this.hooks?.beforeRead?.();
      const [rev, notes] = await Promise.all([this.revision(), this.queryList(query, limit)]);
      return { rev, notes };
    });
  }

  private async findActive(database: Db, idOrPath: string): Promise<NoteRow | null> {
    return (
      (await queryOne(database, sql`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ${idOrPath} AND deleted_at IS NULL`, NoteSchema)) ??
      (await queryOne(database, sql`SELECT ${NOTE_COLUMNS} FROM notes WHERE path = ${idOrPath} AND deleted_at IS NULL`, NoteSchema))
    );
  }

  private async getActive(idOrPath: string): Promise<SyncedNote | null> {
    await this.hooks?.beforeRead?.(idOrPath);
    const row = await this.findActive(this.database, idOrPath);
    return row ? rowToNote(row) : null;
  }

  get(idOrPath: string): Promise<SyncedNote | null> {
    return this.exclusive(() => this.getActive(idOrPath));
  }

  changesSince(sinceRev: number): Promise<{ rev: number; changes: SyncedNote[] }> {
    return this.exclusive(async () => {
      await this.hooks?.beforeRead?.();
      const [rev, rows] = await Promise.all([
        this.revision(),
        queryRows(this.database, sql`SELECT ${NOTE_COLUMNS} FROM notes WHERE rev > ${sinceRev} ORDER BY rev ASC`, NoteSchema),
      ]);
      return { rev, changes: rows.map(rowToNote) };
    });
  }

  create(input: { content: string; path?: string; pinned?: boolean }, now: number): Promise<SyncedNote> {
    return this.exclusive(async () => {
      const created = await this.database.transaction().execute(async (trx): Promise<SyncedNote> => {
        const id = randomUUID();
        const desired = normalizeNotePath(input.path, input.content);
        const path = await this.uniqueActivePath(trx, desired, id);
        const title = titleFromContent(input.content);
        const hash = sha256Hex(input.content);
        const rev = await this.nextRev(trx);
        const pinned = Boolean(input.pinned);
        await trx
          .insertInto("notes")
          .values({
            id,
            path,
            title,
            content: input.content,
            content_hash: hash,
            pinned: pinned ? 1 : 0,
            rev,
            deleted_at: null,
            created_at: now,
            updated_at: now,
            yjs_state: null,
          })
          .execute();
        return {
          id,
          path,
          title,
          content: input.content,
          contentHash: hash,
          pinned,
          rev,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        };
      });
      await this.hooks?.onExternalContent?.(created);
      return created;
    });
  }

  update(
    idOrPath: string,
    changes: { content?: string; pinned?: boolean; path?: string },
    now: number,
  ): Promise<SyncedNote | null> {
    return this.exclusive(() => this.updateActive(idOrPath, changes, now));
  }

  private async updateActive(
    idOrPath: string,
    changes: { content?: string; pinned?: boolean; path?: string },
    now: number,
  ): Promise<SyncedNote | null> {
    await this.hooks?.beforeRead?.(idOrPath);
    const updated = await this.database.transaction().execute(async (trx): Promise<SyncedNote | null> => {
      const current = await this.findActive(trx, idOrPath);
      if (!current) return null;
      const content = changes.content ?? current.content;
      const title = titleFromContent(content);
      const desiredPath =
        changes.path !== undefined
          ? normalizeNotePath(changes.path, content)
          : changes.content !== undefined
            ? normalizeNotePath(undefined, content)
            : current.path;
      const path = desiredPath === current.path ? current.path : await this.uniqueActivePath(trx, desiredPath, current.id);
      const pinned = changes.pinned !== undefined ? changes.pinned : current.pinned !== 0;
      const hash = changes.content !== undefined ? sha256Hex(content) : current.content_hash;
      const rev = await this.nextRev(trx);
      await trx
        .updateTable("notes")
        .set({ path, title, content, content_hash: hash, pinned: pinned ? 1 : 0, rev, updated_at: now })
        .where("id", "=", current.id)
        .execute();
      return {
        id: current.id,
        path,
        title,
        content,
        contentHash: hash,
        pinned,
        rev,
        deletedAt: null,
        createdAt: current.created_at,
        updatedAt: now,
      };
    });
    if (updated) {
      if (changes.content !== undefined) {
        await this.hooks?.onExternalContent?.(updated);
      } else {
        this.hooks?.onNoteChanged?.(updated);
      }
    }
    return updated;
  }

  append(idOrPath: string, text: string, now: number): Promise<SyncedNote | null> {
    return this.exclusive(async () => {
      const current = await this.getActive(idOrPath);
      if (!current) return null;
      const separator = current.content.length === 0 || current.content.endsWith("\n") ? "" : "\n";
      return this.updateActive(current.id, { content: `${current.content}${separator}${text}` }, now);
    });
  }

  remove(idOrPath: string, now: number): Promise<SyncedNote | null> {
    return this.exclusive(async () => {
      await this.hooks?.beforeRead?.(idOrPath);
      const removed = await this.database.transaction().execute(async (trx): Promise<SyncedNote | null> => {
        const current = await this.findActive(trx, idOrPath);
        if (!current) return null;
        const rev = await this.nextRev(trx);
        const emptyHash = sha256Hex("");
        await trx
          .updateTable("notes")
          .set({ content: "", content_hash: emptyHash, yjs_state: null, pinned: 0, deleted_at: now, rev, updated_at: now })
          .where("id", "=", current.id)
          .execute();
        return {
          id: current.id,
          path: current.path,
          title: current.title,
          content: "",
          contentHash: emptyHash,
          pinned: false,
          rev,
          deletedAt: now,
          createdAt: current.created_at,
          updatedAt: now,
        };
      });
      if (removed) {
        await this.hooks?.onExternalContent?.(removed);
      }
      return removed;
    });
  }

  push(ops: readonly SyncPushOp[], now: number): Promise<{ rev: number; results: SyncPushResult[] }> {
    return this.exclusive(async () => {
      await this.hooks?.beforeRead?.();
      const contentChanged: SyncedNote[] = [];
      const metaChanged: SyncedNote[] = [];
      const output = await this.database.transaction().execute(async (trx) => {
        const results: SyncPushResult[] = [];
        for (const op of ops) {
          // Ops apply in order: each one sees the revisions and paths the ones before it wrote.
          // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop
          const result = await this.applyPushOp(trx, op, now);
          results.push(result.result);
          if (result.changed === "content") contentChanged.push(result.note);
          if (result.changed === "meta") metaChanged.push(result.note);
        }
        return { rev: await this.revision(trx), results };
      });

      for (const note of contentChanged) {
        // Collab rooms take each note's new content in the order the ops wrote it.
        // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop
        await this.hooks?.onExternalContent?.(note);
      }
      for (const note of metaChanged) this.hooks?.onNoteChanged?.(note);
      return output;
    });
  }

  private async applyPushOp(
    trx: Db,
    op: SyncPushOp,
    now: number,
  ): Promise<{ result: SyncPushResult; note: SyncedNote; changed: "content" | "meta" } | { result: SyncPushResult; changed: null }> {
    const id = op.id.trim() || randomUUID();
    const existing = await queryOne(trx, sql`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ${id}`, NoteSchema);

    if (existing) {
      if (existing.rev !== op.baseRev) {
        return { result: { id, status: "conflict", serverNote: rowToNote(existing) }, changed: null };
      }
      const rev = await this.nextRev(trx);
      let updated: SyncedNote;
      if (op.deleted) {
        const emptyHash = sha256Hex("");
        await trx
          .updateTable("notes")
          .set({ content: "", content_hash: emptyHash, yjs_state: null, pinned: 0, deleted_at: now, rev, updated_at: now })
          .where("id", "=", id)
          .execute();
        updated = {
          id,
          path: existing.path,
          title: existing.title,
          content: "",
          contentHash: emptyHash,
          pinned: false,
          rev,
          deletedAt: now,
          createdAt: existing.created_at,
          updatedAt: now,
        };
      } else {
        const content = op.content ?? existing.content;
        const desiredPath = normalizeNotePath(op.path ?? existing.path, content);
        const path =
          existing.deleted_at === null && desiredPath === existing.path
            ? existing.path
            : await this.uniqueActivePath(trx, desiredPath, id);
        const title = titleFromContent(content);
        const hash = op.content !== undefined ? sha256Hex(content) : existing.content_hash;
        const pinned = op.pinned !== undefined ? op.pinned : existing.pinned !== 0;
        await trx
          .updateTable("notes")
          .set({ path, title, content, content_hash: hash, pinned: pinned ? 1 : 0, deleted_at: null, rev, updated_at: now })
          .where("id", "=", id)
          .execute();
        updated = {
          id,
          path,
          title,
          content,
          contentHash: hash,
          pinned,
          rev,
          deletedAt: null,
          createdAt: existing.created_at,
          updatedAt: now,
        };
      }
      const changed = op.deleted || op.content !== undefined ? "content" : "meta";
      return { result: { id, status: "ok", note: updated }, note: updated, changed };
    }

    if (op.deleted) {
      const rev = await this.nextRev(trx);
      const path = normalizeNotePath(op.path, "");
      const emptyHash = sha256Hex("");
      await trx
        .insertInto("notes")
        .values({
          id,
          path,
          title: "Untitled",
          content: "",
          content_hash: emptyHash,
          pinned: 0,
          rev,
          deleted_at: now,
          created_at: now,
          updated_at: now,
          yjs_state: null,
        })
        .execute();
      const created: SyncedNote = {
        id,
        path,
        title: "Untitled",
        content: "",
        contentHash: emptyHash,
        pinned: false,
        rev,
        deletedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      return { result: { id, status: "ok", note: created }, note: created, changed: "content" };
    }

    const content = op.content ?? "";
    const desiredPath = normalizeNotePath(op.path, content);
    const path = await this.uniqueActivePath(trx, desiredPath, id);
    const title = titleFromContent(content);
    const hash = sha256Hex(content);
    const pinned = Boolean(op.pinned);
    const rev = await this.nextRev(trx);
    await trx
      .insertInto("notes")
      .values({
        id,
        path,
        title,
        content,
        content_hash: hash,
        pinned: pinned ? 1 : 0,
        rev,
        deleted_at: null,
        created_at: now,
        updated_at: now,
        yjs_state: null,
      })
      .execute();
    const created: SyncedNote = {
      id,
      path,
      title,
      content,
      contentHash: hash,
      pinned,
      rev,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    return { result: { id, status: "ok", note: created }, note: created, changed: "content" };
  }
}
