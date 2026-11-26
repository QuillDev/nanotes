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

export class NotesStore {
  constructor(private readonly database: Database) {}

  currentRev(): number {
    return Number(readSetting(this.database, "sync_rev") ?? "0");
  }

  private nextRev(): number {
    const next = this.currentRev() + 1;
    writeSetting(this.database, "sync_rev", String(next));
    return next;
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

  list(query?: string, limit = 200): NoteSummary[] {
    const rows = this.database
      .query<NoteRow, []>("SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC")
      .all();
    const needle = (query ?? "").trim().toLowerCase();
    const filtered = needle
      ? rows.filter((row) => `${row.title} ${row.path} ${row.content}`.toLowerCase().includes(needle))
      : rows;
    return filtered.slice(0, limit).map((row) => ({
      id: row.id,
      path: row.path,
      title: row.title,
      pinned: row.pinned !== 0,
      rev: row.rev,
      updatedAt: row.updated_at,
      size: Buffer.byteLength(row.content, "utf8"),
    }));
  }

  get(idOrPath: string): SyncedNote | null {
    const byId = this.database
      .query<NoteRow, [string]>("SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL")
      .get(idOrPath);
    if (byId) return rowToNote(byId);
    const byPath = this.database
      .query<NoteRow, [string]>("SELECT * FROM notes WHERE path = ? AND deleted_at IS NULL")
      .get(idOrPath);
    return byPath ? rowToNote(byPath) : null;
  }

  changesSince(sinceRev: number): { rev: number; changes: SyncedNote[] } {
    const rev = this.currentRev();
    const rows = this.database
      .query<NoteRow, [number]>("SELECT * FROM notes WHERE rev > ? ORDER BY rev ASC")
      .all(sinceRev);
    return { rev, changes: rows.map(rowToNote) };
  }

  create(input: { content: string; path?: string; pinned?: boolean }, now: number): SyncedNote {
    return this.database.transaction(() => {
      const id = randomUUID();
      const desired = normalizeNotePath(input.path, input.content);
      const path = this.uniqueActivePath(desired, id);
      const title = titleFromContent(input.content);
      const hash = sha256Hex(input.content);
      const rev = this.nextRev();
      const pinned = input.pinned ? 1 : 0;
      this.database
        .query(
          `INSERT INTO notes (id, path, title, content, content_hash, pinned, rev, deleted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, path, title, input.content, hash, pinned, rev, now, now);
      return rowToNote(this.database.query<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow);
    })();
  }

  update(
    idOrPath: string,
    changes: { content?: string; pinned?: boolean; path?: string },
    now: number,
  ): SyncedNote | null {
    return this.database.transaction(() => {
      const current = this.get(idOrPath);
      if (!current) return null;
      const content = changes.content ?? current.content;
      const title = titleFromContent(content);
      const desiredPath =
        changes.path !== undefined
          ? normalizeNotePath(changes.path, content)
          : changes.content !== undefined
            ? normalizeNotePath(undefined, content)
            : current.path;
      const path = this.uniqueActivePath(desiredPath, current.id);
      const pinned = changes.pinned !== undefined ? (changes.pinned ? 1 : 0) : current.pinned ? 1 : 0;
      const hash = sha256Hex(content);
      const rev = this.nextRev();
      this.database
        .query(
          `UPDATE notes
           SET path = ?, title = ?, content = ?, content_hash = ?, pinned = ?, rev = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(path, title, content, hash, pinned, rev, now, current.id);
      return rowToNote(this.database.query<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?").get(current.id) as NoteRow);
    })();
  }

  append(idOrPath: string, text: string, now: number): SyncedNote | null {
    const current = this.get(idOrPath);
    if (!current) return null;
    const separator = current.content.length === 0 || current.content.endsWith("\n") ? "" : "\n";
    return this.update(current.id, { content: `${current.content}${separator}${text}` }, now);
  }

  remove(idOrPath: string, now: number): SyncedNote | null {
    return this.database.transaction(() => {
      const current = this.get(idOrPath);
      if (!current) return null;
      const rev = this.nextRev();
      this.database
        .query(
          `UPDATE notes
           SET content = '', content_hash = ?, pinned = 0, deleted_at = ?, rev = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(sha256Hex(""), now, rev, now, current.id);
      return rowToNote(this.database.query<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?").get(current.id) as NoteRow);
    })();
  }

  push(ops: readonly SyncPushOp[], now: number): { rev: number; results: SyncPushResult[] } {
    return this.database.transaction(() => {
      const results: SyncPushResult[] = [];
      for (const op of ops) {
        const id = op.id.trim() || randomUUID();
        const existing = this.database.query<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?").get(id);

        if (existing) {
          if (existing.rev !== op.baseRev) {
            results.push({ id, status: "conflict", serverNote: rowToNote(existing) });
            continue;
          }
          const rev = this.nextRev();
          if (op.deleted) {
            this.database
              .query(
                `UPDATE notes
                 SET content = '', content_hash = ?, pinned = 0, deleted_at = ?, rev = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(sha256Hex(""), now, rev, now, id);
          } else {
            const content = op.content ?? existing.content;
            const desiredPath = normalizeNotePath(op.path ?? existing.path, content);
            const path = this.uniqueActivePath(desiredPath, id);
            const title = titleFromContent(content);
            const hash = sha256Hex(content);
            const pinned = op.pinned !== undefined ? (op.pinned ? 1 : 0) : existing.pinned;
            this.database
              .query(
                `UPDATE notes
                 SET path = ?, title = ?, content = ?, content_hash = ?, pinned = ?, deleted_at = NULL, rev = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .run(path, title, content, hash, pinned, rev, now, id);
          }
          const updated = this.database.query<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow;
          results.push({ id, status: "ok", note: rowToNote(updated) });
          continue;
        }

        if (op.deleted) {
          const rev = this.nextRev();
          const path = normalizeNotePath(op.path, "");
          this.database
            .query(
              `INSERT INTO notes (id, path, title, content, content_hash, pinned, rev, deleted_at, created_at, updated_at)
               VALUES (?, ?, 'Untitled', '', ?, 0, ?, ?, ?, ?)`,
            )
            .run(id, path, sha256Hex(""), rev, now, now, now);
          const created = this.database.query<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow;
          results.push({ id, status: "ok", note: rowToNote(created) });
          continue;
        }

        const content = op.content ?? "";
        const desiredPath = normalizeNotePath(op.path, content);
        const path = this.uniqueActivePath(desiredPath, id);
        const title = titleFromContent(content);
        const hash = sha256Hex(content);
        const pinned = op.pinned ? 1 : 0;
        const rev = this.nextRev();
        this.database
          .query(
            `INSERT INTO notes (id, path, title, content, content_hash, pinned, rev, deleted_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(id, path, title, content, hash, pinned, rev, now, now);
        const created = this.database.query<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow;
        results.push({ id, status: "ok", note: rowToNote(created) });
      }
      return { rev: this.currentRev(), results };
    })();
  }
}
