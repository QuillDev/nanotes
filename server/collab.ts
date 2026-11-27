import type { ServerWebSocket } from "bun";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { applyTextDiff, base64ToBytes, bytesToBase64 } from "../shared/text-diff.ts";
import type { Auth } from "./auth.ts";
import type { NotesStore, SyncedNote } from "./notes.ts";

const AUTH_TIMEOUT_MS = 10_000;
const FLUSH_DEBOUNCE_MS = 150;
const FLUSH_MAX_WAIT_MS = 500;
const MAX_UPDATE_BYTES = 5 * 1024 * 1024;
const SERVER_DIFF_ORIGIN = Symbol("server-external-diff");

export interface WsClientData {
  id: string;
  authed: boolean;
  deviceId: string | null;
  deviceName: string;
  rooms: Set<string>;
  authTimer: ReturnType<typeof setTimeout> | null;
}

interface Room {
  noteId: string;
  doc: Y.Doc;
  awareness: Awareness;
  clients: Set<ServerWebSocket<WsClientData>>;
  clientAwarenessIds: Map<ServerWebSocket<WsClientData>, Set<number>>;
  dirty: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  maxFlushTimer: ReturnType<typeof setTimeout> | null;
}

function sendRaw(ws: ServerWebSocket<WsClientData>, encoded: string): void {
  try {
    ws.send(encoded);
  } catch {
    // Ignore sends to closing sockets; close handler will clean up.
  }
}

function sendJson(ws: ServerWebSocket<WsClientData>, payload: unknown): void {
  sendRaw(ws, JSON.stringify(payload));
}

function noteEventPayload(note: SyncedNote) {
  return {
    type: "note-changed",
    note: {
      id: note.id,
      path: note.path,
      title: note.title,
      pinned: note.pinned,
      rev: note.rev,
      updatedAt: note.updatedAt,
      deletedAt: note.deletedAt,
      size: Buffer.byteLength(note.content, "utf8"),
    },
  };
}

export class CollabHub {
  private readonly clients = new Set<ServerWebSocket<WsClientData>>();
  private readonly rooms = new Map<string, Room>();
  private readonly dirtyRooms = new Set<Room>();
  private readonly flushDebounceMs: number;

  constructor(
    private readonly notes: NotesStore,
    private readonly auth: Auth,
    private readonly clock: () => number,
    options?: { flushDebounceMs?: number },
  ) {
    this.flushDebounceMs = options?.flushDebounceMs ?? FLUSH_DEBOUNCE_MS;
  }

  createClientData(authed: boolean, deviceName: string, deviceId: string | null = null): WsClientData {
    return {
      id: randomUUID(),
      authed,
      deviceId,
      deviceName,
      rooms: new Set<string>(),
      authTimer: null,
    };
  }

  notifyDeviceRenamed(deviceId: string, deviceName: string): void {
    const encoded = JSON.stringify({ type: "device-renamed", deviceName });
    for (const ws of this.clients) {
      if (ws.data.authed && ws.data.deviceId === deviceId) {
        ws.data.deviceName = deviceName;
        sendRaw(ws, encoded);
      }
    }
  }

  disconnectDevice(deviceId: string): void {
    const notice = JSON.stringify({ type: "error", message: "device revoked" });
    for (const ws of [...this.clients]) {
      if (ws.data.deviceId === deviceId) {
        ws.data.authed = false;
        sendRaw(ws, notice);
        try {
          ws.close(4401, "device revoked");
        } catch {
          // Ignore already closed sockets.
        }
      }
    }
  }

  /** Runs socket work in turn with note reads and writes (see `NotesStore.exclusive`). */
  private run(task: () => Promise<void>): void {
    this.notes.exclusive(task).catch((cause: unknown) => console.error("collab:", cause));
  }

  private async currentRev(): Promise<number> {
    await this.flushNote();
    return this.notes.revision();
  }

  onOpen(ws: ServerWebSocket<WsClientData>): void {
    this.clients.add(ws);
    if (ws.data.authed) {
      this.run(async () => sendJson(ws, { type: "authed", rev: await this.currentRev(), deviceName: ws.data.deviceName }));
      return;
    }
    ws.data.authTimer = setTimeout(() => {
      if (!ws.data.authed) {
        sendJson(ws, { type: "error", message: "authentication timeout" });
        ws.close(4401, "authentication timeout");
      }
    }, AUTH_TIMEOUT_MS);
  }

  onClose(ws: ServerWebSocket<WsClientData>): void {
    if (ws.data.authTimer) {
      clearTimeout(ws.data.authTimer);
      ws.data.authTimer = null;
    }
    this.run(async () => {
      for (const noteId of [...ws.data.rooms]) {
        // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop
        await this.leaveRoom(ws, noteId);
      }
      this.clients.delete(ws);
    });
  }

  onMessage(ws: ServerWebSocket<WsClientData>, raw: string | Buffer): void {
    this.run(() => this.handleMessage(ws, raw));
  }

  private async handleMessage(ws: ServerWebSocket<WsClientData>, raw: string | Buffer): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      sendJson(ws, { type: "error", message: "invalid JSON message" });
      return;
    }

    const type = msg["type"];
    if (type === "ping") {
      sendJson(ws, { type: "pong" });
      return;
    }

    if (type === "auth") {
      if (ws.data.authed) {
        sendJson(ws, { type: "authed", rev: await this.currentRev(), deviceName: ws.data.deviceName });
        return;
      }
      const token = msg["token"];
      if (typeof token !== "string") {
        sendJson(ws, { type: "error", message: "token required" });
        ws.close(4401, "unauthorized");
        return;
      }
      const device = await this.auth.verifyDeviceToken(token, this.clock());
      if (!device) {
        sendJson(ws, { type: "error", message: "invalid device token" });
        ws.close(4401, "unauthorized");
        return;
      }
      ws.data.authed = true;
      ws.data.deviceId = device.id;
      ws.data.deviceName = device.name;
      if (ws.data.authTimer) {
        clearTimeout(ws.data.authTimer);
        ws.data.authTimer = null;
      }
      sendJson(ws, { type: "authed", rev: await this.currentRev(), deviceName: device.name });
      return;
    }

    if (!ws.data.authed) {
      sendJson(ws, { type: "error", message: "authenticate first" });
      return;
    }

    if (type === "join") {
      const noteId = msg["noteId"];
      if (typeof noteId !== "string" || !noteId.trim()) {
        sendJson(ws, { type: "error", message: "noteId required" });
        return;
      }
      const stateVector = typeof msg["stateVector"] === "string" ? msg["stateVector"] : undefined;
      await this.joinRoom(ws, noteId.trim(), stateVector);
      return;
    }

    if (type === "leave") {
      const noteId = msg["noteId"];
      if (typeof noteId === "string" && noteId.trim()) {
        await this.leaveRoom(ws, noteId.trim());
      }
      return;
    }

    if (type === "yjs-update") {
      const noteId = msg["noteId"];
      const encoded = msg["update"];
      if (typeof noteId !== "string" || typeof encoded !== "string") return;
      this.handleYjsUpdate(ws, noteId.trim(), encoded);
      return;
    }

    if (type === "awareness") {
      const noteId = msg["noteId"];
      const encoded = msg["update"];
      if (typeof noteId !== "string" || typeof encoded !== "string") return;
      this.handleAwarenessUpdate(ws, noteId.trim(), encoded);
      return;
    }
  }

  private async getOrLoadRoom(noteId: string): Promise<{ room: Room; note: SyncedNote } | null> {
    const note = await this.notes.getRaw(noteId);
    if (!note || note.deletedAt !== null) return null;

    const existing = this.rooms.get(noteId);
    if (existing) {
      return { room: existing, note };
    }

    const doc = new Y.Doc();
    const persisted = await this.notes.getYjsState(noteId);
    if (persisted && persisted.byteLength > 0) {
      Y.applyUpdate(doc, persisted);
      // Reconcile if content was ever updated without yjs_state (e.g. legacy DB migration).
      const ytext = doc.getText("content");
      if (ytext.toString() !== note.content) {
        applyTextDiff(ytext, note.content, SERVER_DIFF_ORIGIN);
        await this.notes.saveYjsState(noteId, Y.encodeStateAsUpdate(doc));
      }
    } else {
      if (note.content.length > 0) {
        doc.getText("content").insert(0, note.content);
      }
      await this.notes.saveYjsState(noteId, Y.encodeStateAsUpdate(doc));
    }

    const awareness = new Awareness(doc);
    // Server itself doesn't hold a cursor.
    awareness.setLocalState(null);

    const room: Room = {
      noteId,
      doc,
      awareness,
      clients: new Set(),
      clientAwarenessIds: new Map(),
      dirty: false,
      flushTimer: null,
      maxFlushTimer: null,
    };

    awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = [...added, ...updated, ...removed];
        if (changed.length === 0) return;
        const sender = origin as ServerWebSocket<WsClientData> | null;
        if (sender && room.clients.has(sender)) {
          let ids = room.clientAwarenessIds.get(sender);
          if (!ids) {
            ids = new Set();
            room.clientAwarenessIds.set(sender, ids);
          }
          for (const id of added) ids.add(id);
          for (const id of updated) ids.add(id);
          for (const id of removed) ids.delete(id);
        }
        const update = bytesToBase64(encodeAwarenessUpdate(awareness, changed));
        const frame = JSON.stringify({ type: "awareness", noteId, update });
        for (const client of room.clients) {
          if (client !== sender) {
            sendRaw(client, frame);
          }
        }
      },
    );

    this.rooms.set(noteId, room);
    return { room, note };
  }

  private async joinRoom(ws: ServerWebSocket<WsClientData>, noteId: string, stateVectorB64?: string): Promise<void> {
    const loaded = await this.getOrLoadRoom(noteId);
    if (!loaded) {
      sendJson(ws, { type: "error", noteId, message: "note not found" });
      return;
    }
    const { room, note } = loaded;
    room.clients.add(ws);
    ws.data.rooms.add(noteId);

    let diff: Uint8Array;
    if (stateVectorB64) {
      try {
        diff = Y.encodeStateAsUpdate(room.doc, base64ToBytes(stateVectorB64));
      } catch {
        diff = Y.encodeStateAsUpdate(room.doc);
      }
    } else {
      diff = Y.encodeStateAsUpdate(room.doc);
    }

    sendJson(ws, {
      type: "sync-state",
      noteId,
      update: bytesToBase64(diff),
      stateVector: bytesToBase64(Y.encodeStateVector(room.doc)),
      rev: note.rev,
      path: note.path,
      title: note.title,
      pinned: note.pinned,
    });

    const activeAwarenessIds = Array.from(room.awareness.getStates().keys());
    if (activeAwarenessIds.length > 0) {
      sendJson(ws, {
        type: "awareness",
        noteId,
        update: bytesToBase64(encodeAwarenessUpdate(room.awareness, activeAwarenessIds)),
      });
    }
  }

  private async leaveRoom(ws: ServerWebSocket<WsClientData>, noteId: string): Promise<void> {
    ws.data.rooms.delete(noteId);
    const room = this.rooms.get(noteId);
    if (!room) return;
    room.clients.delete(ws);

    const ownedIds = room.clientAwarenessIds.get(ws);
    room.clientAwarenessIds.delete(ws);
    if (ownedIds && ownedIds.size > 0) {
      removeAwarenessStates(room.awareness, Array.from(ownedIds), null);
    }

    if (room.clients.size === 0) {
      await this.flushRoom(room);
      this.destroyRoom(room);
    }
  }

  private handleYjsUpdate(ws: ServerWebSocket<WsClientData>, noteId: string, encoded: string): void {
    const room = this.rooms.get(noteId);
    if (!room || !room.clients.has(ws)) {
      sendJson(ws, { type: "error", noteId, message: "join note before sending updates" });
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(encoded);
    } catch {
      sendJson(ws, { type: "error", noteId, message: "invalid base64 update" });
      return;
    }
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPDATE_BYTES) return;

    try {
      Y.applyUpdate(room.doc, bytes, ws);
    } catch {
      sendJson(ws, { type: "error", noteId, message: "corrupt yjs update" });
      return;
    }

    const frame = JSON.stringify({ type: "yjs-update", noteId, update: encoded });
    for (const peer of room.clients) {
      if (peer !== ws) {
        sendRaw(peer, frame);
      }
    }

    room.dirty = true;
    this.dirtyRooms.add(room);
    this.scheduleFlush(room);
  }

  private handleAwarenessUpdate(ws: ServerWebSocket<WsClientData>, noteId: string, encoded: string): void {
    const room = this.rooms.get(noteId);
    if (!room || !room.clients.has(ws)) return;
    try {
      const bytes = base64ToBytes(encoded);
      if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) return;
      applyAwarenessUpdate(room.awareness, bytes, ws);
    } catch {
      // Ignore malformed awareness frames.
    }
  }

  private scheduleFlush(room: Room): void {
    if (room.flushTimer) clearTimeout(room.flushTimer);
    room.flushTimer = setTimeout(() => {
      room.flushTimer = null;
      this.run(() => this.flushRoom(room));
    }, this.flushDebounceMs);
    if (!room.maxFlushTimer) {
      const maxWait = Math.max(this.flushDebounceMs, FLUSH_MAX_WAIT_MS);
      room.maxFlushTimer = setTimeout(() => {
        room.maxFlushTimer = null;
        this.run(() => this.flushRoom(room));
      }, maxWait);
    }
  }

  async flushNote(noteId?: string): Promise<void> {
    if (this.dirtyRooms.size === 0) return;
    if (noteId) {
      const room = this.rooms.get(noteId);
      if (room) {
        await this.flushRoom(room);
        return;
      }
    }
    for (const room of [...this.dirtyRooms]) {
      // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop
      await this.flushRoom(room);
    }
  }

  private async flushRoom(room: Room): Promise<void> {
    if (room.flushTimer) {
      clearTimeout(room.flushTimer);
      room.flushTimer = null;
    }
    if (room.maxFlushTimer) {
      clearTimeout(room.maxFlushTimer);
      room.maxFlushTimer = null;
    }
    if (!room.dirty) return;
    room.dirty = false;
    this.dirtyRooms.delete(room);

    const content = room.doc.getText("content").toString();
    const state = Y.encodeStateAsUpdate(room.doc);
    const saved = await this.notes.saveFromCollab(room.noteId, state, content, this.clock());
    if (saved) {
      this.broadcastNoteChanged(saved);
    }
  }

  private destroyRoom(room: Room): void {
    if (room.flushTimer) {
      clearTimeout(room.flushTimer);
      room.flushTimer = null;
    }
    if (room.maxFlushTimer) {
      clearTimeout(room.maxFlushTimer);
      room.maxFlushTimer = null;
    }
    room.dirty = false;
    this.dirtyRooms.delete(room);
    room.awareness.destroy();
    room.doc.destroy();
    this.rooms.delete(room.noteId);
  }

  /**
   * Called when MCP or REST writes plain Markdown content directly to a note.
   * Diffs the change onto the note's Y.Doc, saves yjs_state, and streams live updates to connected peers.
   */
  async applyExternalContent(note: SyncedNote): Promise<void> {
    if (note.deletedAt !== null) {
      const room = this.rooms.get(note.id);
      if (room) {
        for (const client of [...room.clients]) {
          client.data.rooms.delete(note.id);
        }
        this.destroyRoom(room);
      }
      this.broadcastNoteChanged(note);
      return;
    }

    const activeRoom = this.rooms.get(note.id);
    if (activeRoom) {
      let emittedUpdate: Uint8Array | null = null;
      const listener = (update: Uint8Array, origin: unknown) => {
        if (origin === SERVER_DIFF_ORIGIN) {
          emittedUpdate = update;
        }
      };
      activeRoom.doc.on("update", listener);
      try {
        applyTextDiff(activeRoom.doc.getText("content"), note.content, SERVER_DIFF_ORIGIN);
      } finally {
        activeRoom.doc.off("update", listener);
      }
      await this.notes.saveYjsState(note.id, Y.encodeStateAsUpdate(activeRoom.doc));
      activeRoom.dirty = false;
      this.dirtyRooms.delete(activeRoom);
      if (activeRoom.flushTimer) {
        clearTimeout(activeRoom.flushTimer);
        activeRoom.flushTimer = null;
      }
      if (activeRoom.maxFlushTimer) {
        clearTimeout(activeRoom.maxFlushTimer);
        activeRoom.maxFlushTimer = null;
      }
      if (emittedUpdate) {
        const frame = JSON.stringify({
          type: "yjs-update",
          noteId: note.id,
          update: bytesToBase64(emittedUpdate),
          rev: note.rev,
          path: note.path,
        });
        for (const client of activeRoom.clients) {
          sendRaw(client, frame);
        }
      }
    } else {
      const doc = new Y.Doc();
      try {
        const persisted = await this.notes.getYjsState(note.id);
        if (persisted && persisted.byteLength > 0) {
          Y.applyUpdate(doc, persisted);
        }
        applyTextDiff(doc.getText("content"), note.content, SERVER_DIFF_ORIGIN);
        await this.notes.saveYjsState(note.id, Y.encodeStateAsUpdate(doc));
      } finally {
        doc.destroy();
      }
    }

    this.broadcastNoteChanged(note);
  }

  broadcastNoteChanged(note: SyncedNote): void {
    const encoded = JSON.stringify(noteEventPayload(note));
    for (const client of this.clients) {
      if (client.data.authed) {
        sendRaw(client, encoded);
      }
    }
  }

  /** Inside exclusive. */
  async close(): Promise<void> {
    await this.flushNote();
    for (const room of [...this.rooms.values()]) {
      this.destroyRoom(room);
    }
    for (const client of [...this.clients]) {
      if (client.data.authTimer) {
        clearTimeout(client.data.authTimer);
        client.data.authTimer = null;
      }
      try {
        client.close(1001, "server shutting down");
      } catch {
        // Ignore already closed sockets.
      }
    }
    this.clients.clear();
  }
}
