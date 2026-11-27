import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { readSetting, writeSetting } from "./database.ts";

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

interface NoteRow {
  id: string;
  path: string;
  title: string;
  content: string;
  content_hash: string;
  pinned: number;
  rev: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

interface NoteSummaryRow {
  id: string;
  path: string;
  title: string;
  pinned: number;
  rev: number;
  updated_at: number;
  size: number;
}

interface NoteSummaryContentRow extends NoteSummaryRow {
  content: string;
}

const NOTE_COLUMNS = "id, path, title, content, content_hash, pinned, rev, deleted_at, created_at, updated_at";
const SUMMARY_COLUMNS = "id, path, title, pinned, rev, updated_at, length(CAST(content AS BLOB)) AS size";

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
  beforeRead?: (noteId?: string) => void;
  onExternalContent?: (note: SyncedNote) => void;
  onNoteChanged?: (note: SyncedNote) => void;
}

export class NotesStore {
  private hooks: NotesHooks | null = null;

  constructor(private readonly database: Database) {}

  setHooks(hooks: NotesHooks): void {
    this.hooks = hooks;
  }

  currentRev(): number {
    this.hooks?.beforeRead?.();
    return Number(readSetting(this.database, "sync_rev") ?? "0");
  }

  private rawRev(): number {
    return Number(readSetting(this.database, "sync_rev") ?? "0");
  }

  private nextRev(): number {
    const next = this.rawRev() + 1;
    writeSetting(this.database, "sync_rev", String(next));
    return next;
  }

  getRaw(id: string): SyncedNote | null {
    const row = this.database
      .query<NoteRow, [string]>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`)
      .get(id);
    return row ? rowToNote(row) : null;
  }

  getYjsState(id: string): Uint8Array | null {
    const row = this.database
      .query<{ yjs_state: Uint8Array | null }, [string]>("SELECT yjs_state FROM notes WHERE id = ?")
      .get(id);
    if (!row || !row.yjs_state) return null;
    return row.yjs_state instanceof Uint8Array ? row.yjs_state : new Uint8Array(row.yjs_state);
  }

  saveYjsState(id: string, state: Uint8Array): void {
    this.database.query("UPDATE notes SET yjs_state = ? WHERE id = ?").run(state, id);
  }

  saveFromCollab(id: string, yjsState: Uint8Array, content: string, now: number): SyncedNote | null {
    return this.database.transaction(() => {
      const existing = this.database
        .query<{ path: string; pinned: number; created_at: number }, [string]>(
          "SELECT path, pinned, created_at FROM notes WHERE id = ? AND deleted_at IS NULL",
        )
        .get(id);
      if (!existing) return null;
      const title = titleFromContent(content);
      const desiredPath = normalizeNotePath(undefined, content);
      const path = desiredPath === existing.path ? existing.path : this.uniqueActivePath(desiredPath, id);
      const hash = sha256Hex(content);
      const rev = this.nextRev();
      this.database
        .query(
          `UPDATE notes
           SET path = ?, title = ?, content = ?, content_hash = ?, yjs_state = ?, rev = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(path, title, content, hash, yjsState, rev, now, id);
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
    })();
  }

  private uniqueActivePath(desiredPath: string, excludeId: string | null): string {
    const stem = desiredPath.toLowerCase().endsWith(".md") ? desiredPath.slice(0, -3) : desiredPath;
    for (let index = 0; ; index += 1) {
      const candidate = index === 0 ? `${stem}.md` : `${stem} ${index}.md`;
      const existing = this.database
        .query<{ id: string }, [string]>("SELECT id FROM notes WHERE path = ? AND deleted_at IS NULL")
        .get(candidate);
      if (!existing || existing.id === excludeId) return candidate;
    }
  }

  private queryList(query?: string, limit = 200): NoteSummary[] {
    const needle = (query ?? "").trim().toLowerCase();
    if (!needle) {
      return this.database
        .query<NoteSummaryRow, [number]>(
          `SELECT ${SUMMARY_COLUMNS}
           FROM notes
           WHERE deleted_at IS NULL
           ORDER BY pinned DESC, updated_at DESC
           LIMIT ?`,
        )
        .all(limit)
        .map(rowToSummary);
    }

    // ASCII needles match identically under SQLite's lower(), keeping full note bodies out of JS memory.
    if (!/[^\x00-\x7f]/.test(needle)) {
      return this.database
        .query<NoteSummaryRow, [string, number]>(
          `SELECT ${SUMMARY_COLUMNS}
           FROM notes
           WHERE deleted_at IS NULL
             AND instr(lower(title || ' ' || path || ' ' || content), ?) > 0
           ORDER BY pinned DESC, updated_at DESC
           LIMIT ?`,
        )
        .all(needle, limit)
        .map(rowToSummary);
    }

    const rows = this.database
      .query<NoteSummaryContentRow, []>(
        `SELECT ${SUMMARY_COLUMNS}, content
         FROM notes
         WHERE deleted_at IS NULL
         ORDER BY pinned DESC, updated_at DESC`,
      )
      .all();
    const matched: NoteSummary[] = [];
    for (const row of rows) {
      if (`${row.title} ${row.path} ${row.content}`.toLowerCase().includes(needle)) {
        matched.push(rowToSummary(row));
        if (matched.length >= limit) break;
      }
    }
    return matched;
  }

  list(query?: string, limit = 200): NoteSummary[] {
    this.hooks?.beforeRead?.();
    return this.queryList(query, limit);
  }

  listWithRev(query?: string, limit = 200): { rev: number; notes: NoteSummary[] } {
    this.hooks?.beforeRead?.();
    return {
      rev: this.rawRev(),
      notes: this.queryList(query, limit),
    };
  }

  get(idOrPath: string): SyncedNote | null {
    this.hooks?.beforeRead?.(idOrPath);
    const byId = this.database
      .query<NoteRow, [string]>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ? AND deleted_at IS NULL`)
      .get(idOrPath);
    if (byId) return rowToNote(byId);
    const byPath = this.database
      .query<NoteRow, [string]>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE path = ? AND deleted_at IS NULL`)
      .get(idOrPath);
    return byPath ? rowToNote(byPath) : null;
  }

  changesSince(sinceRev: number): { rev: number; changes: SyncedNote[] } {
    this.hooks?.beforeRead?.();
    const rev = this.rawRev();
    const rows = this.database
      .query<NoteRow, [number]>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE rev > ? ORDER BY rev ASC`)
      .all(sinceRev);
    return { rev, changes: rows.map(rowToNote) };
  }

  create(input: { content: string; path?: string; pinned?: boolean }, now: number): SyncedNote {
    const created = this.database.transaction((): SyncedNote => {
      const id = randomUUID();
      const desired = normalizeNotePath(input.path, input.content);
      const path = this.uniqueActivePath(desired, id);
      const title = titleFromContent(input.content);
      const hash = sha256Hex(input.content);
      const rev = this.nextRev();
      const pinned = Boolean(input.pinned);
      this.database
        .query(
          `INSERT INTO notes (id, path, title, content, content_hash, pinned, rev, deleted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, path, title, input.content, hash, pinned ? 1 : 0, rev, now, now);
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
    })();
    this.hooks?.onExternalContent?.(created);
    return created;
  }

  update(
    idOrPath: string,
    changes: { content?: string; pinned?: boolean; path?: string },
    now: number,
  ): SyncedNote | null {
    this.hooks?.beforeRead?.(idOrPath);
    const updated = this.database.transaction((): SyncedNote | null => {
      const current = this.database
        .query<NoteRow, [string]>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ? AND deleted_at IS NULL`)
        .get(idOrPath)
        ?? this.database
          .query<NoteRow, [string]>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE path = ? AND deleted_at IS NULL`)
          .get(idOrPath);
      if (!current) return null;
      const content = changes.content ?? current.content;
      const title = titleFromContent(content);
      const desiredPath =
        changes.path !== undefined
          ? normalizeNotePath(changes.path, content)
          : changes.content !== undefined
            ? normalizeNotePath(undefined, content)
            : current.path;
      const path = desiredPath === current.path ? current.path : this.uniqueActivePath(desiredPath, current.id);
      const pinned = changes.pinned !== undefined ? changes.pinned : current.pinned !== 0;
      const hash = changes.content !== undefined ? sha256Hex(content) : current.content_hash;
      const rev = this.nextRev();
      this.database
        .query(
          `UPDATE notes
           SET path = ?, title = ?, content = ?, content_hash = ?, pinned = ?, rev = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(path, title, content, hash, pinned ? 1 : 0, rev, now, current.id);
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
    })();
    if (updated) {
      if (changes.content !== undefined) {
        this.hooks?.onExternalContent?.(updated);
      } else {
        this.hooks?.onNoteChanged?.(updated);
      }
    }
    return updated;
  }

  append(idOrPath: string, text: string, now: number): SyncedNote | null {
    const current = this.get(idOrPath);
    if (!current) return null;
    const separator = current.content.length === 0 || current.content.endsWith("\n") ? "" : "\n";
    return this.update(current.id, { content: `${current.content}${separator}${text}` }, now);
  }

  remove(idOrPath: string, now: number): SyncedNote | null {
    this.hooks?.beforeRead?.(idOrPath);
    const removed = this.database.transaction((): SyncedNote | null => {
      const current = this.database
        .query<NoteRow, [string]>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ? AND deleted_at IS NULL`)
        .get(idOrPath)
        ?? this.database
          .query<NoteRow, [string]>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE path = ? AND deleted_at IS NULL`)
          .get(idOrPath);
      if (!current) return null;
      const rev = this.nextRev();
      const emptyHash = sha256Hex("");
      this.database
        .query(
          `UPDATE notes
           SET content = '', content_hash = ?, yjs_state = NULL, pinned = 0, deleted_at = ?, rev = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(emptyHash, now, rev, now, current.id);
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
    })();
    if (removed) {
      this.hooks?.onExternalContent?.(removed);
    }
    return removed;
  }

  push(ops: readonly SyncPushOp[], now: number): { rev: number; results: SyncPushResult[] } {
    this.hooks?.beforeRead?.();
    const contentChanged: SyncedNote[] = [];
    const metaChanged: SyncedNote[] = [];
    const output = this.database.transaction(() => {
      const results: SyncPushResult[] = [];
      for (const op of ops) {
        const id = op.id.trim() || randomUUID();
        const existing = this.database
          .query<NoteRow, [string]>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`)
          .get(id);

        if (existing) {
          if (existing.rev !== op.baseRev) {
            results.push({ id, status: "conflict", serverNote: rowToNote(existing) });
            continue;
          }
          const rev = this.nextRev();
          let updated: SyncedNote;
          if (op.deleted) {
            const emptyHash = sha256Hex("");
            this.database
              .query(
                `UPDATE notes
                 SET content = '', content_hash = ?, yjs_state = NULL, pinned = 0, deleted_at = ?, rev = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(emptyHash, now, rev, now, id);
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
                : this.uniqueActivePath(desiredPath, id);
            const title = titleFromContent(content);
            const hash = op.content !== undefined ? sha256Hex(content) : existing.content_hash;
            const pinned = op.pinned !== undefined ? op.pinned : existing.pinned !== 0;
            this.database
              .query(
                `UPDATE notes
                 SET path = ?, title = ?, content = ?, content_hash = ?, pinned = ?, deleted_at = NULL, rev = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(path, title, content, hash, pinned ? 1 : 0, rev, now, id);
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
          if (op.deleted || op.content !== undefined) {
            contentChanged.push(updated);
          } else {
            metaChanged.push(updated);
          }
          results.push({ id, status: "ok", note: updated });
          continue;
        }

        if (op.deleted) {
          const rev = this.nextRev();
          const path = normalizeNotePath(op.path, "");
          const emptyHash = sha256Hex("");
          this.database
            .query(
              `INSERT INTO notes (id, path, title, content, content_hash, pinned, rev, deleted_at, created_at, updated_at)
               VALUES (?, ?, 'Untitled', '', ?, 0, ?, ?, ?, ?)`,
            )
            .run(id, path, emptyHash, rev, now, now, now);
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
          contentChanged.push(created);
          results.push({ id, status: "ok", note: created });
          continue;
        }

        const content = op.content ?? "";
        const desiredPath = normalizeNotePath(op.path, content);
        const path = this.uniqueActivePath(desiredPath, id);
        const title = titleFromContent(content);
        const hash = sha256Hex(content);
        const pinned = Boolean(op.pinned);
        const rev = this.nextRev();
        this.database
          .query(
            `INSERT INTO notes (id, path, title, content, content_hash, pinned, rev, deleted_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(id, path, title, content, hash, pinned ? 1 : 0, rev, now, now);
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
        contentChanged.push(created);
        results.push({ id, status: "ok", note: created });
      }
      return { rev: this.rawRev(), results };
    })();

    for (const note of contentChanged) this.hooks?.onExternalContent?.(note);
    for (const note of metaChanged) this.hooks?.onNoteChanged?.(note);
    return output;
  }
}
