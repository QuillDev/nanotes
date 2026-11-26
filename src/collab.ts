import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { applyTextDiff, base64ToBytes, bytesToBase64 } from "../shared/text-diff";

export type CollabConnectionStatus = "disconnected" | "connecting" | "connected";

export interface LiveNoteEvent {
  id: string;
  path: string;
  title: string;
  pinned: boolean;
  rev: number;
  updatedAt: number;
  deletedAt: number | null;
  size: number;
}

export interface RemoteNoteMeta {
  rev: number;
  path: string;
  title?: string;
  pinned?: boolean;
}

const REMOTE_ORIGIN = Symbol("yjs-remote");
const LOCAL_DIFF_ORIGIN = Symbol("yjs-local-diff");
const PEER_COLORS = [
  { color: "#f65c8e", light: "rgba(246, 92, 142, 0.24)" },
  { color: "#38bdf8", light: "rgba(56, 189, 248, 0.22)" },
  { color: "#a78bfa", light: "rgba(167, 139, 250, 0.24)" },
  { color: "#34d399", light: "rgba(52, 211, 153, 0.22)" },
  { color: "#fbbf24", light: "rgba(251, 191, 36, 0.22)" },
];

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return out;
}

function toWebSocketUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}/api/ws`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}/api/ws`;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws`;
}

function pickUserColor(seed: number): { color: string; light: string } {
  return PEER_COLORS[Math.abs(seed) % PEER_COLORS.length] ?? PEER_COLORS[0]!;
}

export interface OpenNoteSessionOptions {
  /** Saved local Yjs state bytes from previous syncs, if any. */
  savedYjsState?: Uint8Array | null;
  /** Current local Markdown content (used to reconcile offline/external disk edits). */
  localContent?: string;
  /** Whether localContent has edits made after the last synced disk state. */
  localDirty?: boolean;
  /** Label shown on remote cursors (e.g. "Windows", "macOS", "Web"). */
  peerName: string;
  /** Called whenever the session is ready to mount in CodeMirror (has authoritative initial Yjs state). */
  onReady?: () => void;
  /** Called (debounced) with full encoded Yjs state + text so caller can persist locally. */
  onPersist?: (state: Uint8Array, content: string, rev: number | null, path: string | null) => void;
  /** Called when server sends updated rev/path/title/pinned metadata for this note. */
  onMeta?: (meta: RemoteNoteMeta) => void;
  /** Called when the note is deleted remotely. */
  onDeleted?: () => void;
}

export class NoteCollabSession {
  readonly doc: Y.Doc;
  readonly ytext: Y.Text;
  readonly awareness: Awareness;
  readonly undoManager: Y.UndoManager;
  ready: boolean;
  rev: number | null = null;
  path: string | null = null;

  private destroyed = false;
  private persistTimer: number | null = null;
  private hasSyncedWithServer = false;
  private pendingLocalDiff: string | null = null;
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void;
  private readonly onAwarenessUpdate: (
    changed: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;

  constructor(
    readonly noteId: string,
    private readonly client: CollabClient,
    private readonly options: OpenNoteSessionOptions,
  ) {
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText("content");
    this.awareness = new Awareness(this.doc);
    this.undoManager = new Y.UndoManager(this.ytext);

    const palette = pickUserColor(this.doc.clientID);
    this.awareness.setLocalStateField("user", {
      name: options.peerName,
      color: palette.color,
      colorLight: palette.light,
    });

    if (options.savedYjsState && options.savedYjsState.byteLength > 0) {
      Y.applyUpdate(this.doc, options.savedYjsState, REMOTE_ORIGIN);
      if (options.localContent !== undefined && this.ytext.toString() !== options.localContent) {
        applyTextDiff(this.ytext, options.localContent, LOCAL_DIFF_ORIGIN);
      }
      this.ready = true;
    } else {
      // Wait for server's canonical sync-state before mounting so we never seed a duplicate copy.
      this.ready = false;
      if (options.localDirty && options.localContent !== undefined) {
        this.pendingLocalDiff = options.localContent;
      }
    }

    this.onDocUpdate = (update: Uint8Array, origin: unknown) => {
      if (this.destroyed) return;
      if (origin !== REMOTE_ORIGIN && this.hasSyncedWithServer) {
        this.client.sendYjsUpdate(this.noteId, update);
      }
      this.schedulePersist();
    };

    this.onAwarenessUpdate = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (this.destroyed || origin === REMOTE_ORIGIN) return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;
      this.client.sendAwareness(this.noteId, encodeAwarenessUpdate(this.awareness, changed));
    };

    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
  }

  /** State vector sent on join; omitted if this client has never received canonical Yjs state yet. */
  joinStateVector(): Uint8Array | null {
    return this.ready ? Y.encodeStateVector(this.doc) : null;
  }

  handleSyncState(msg: {
    update: string;
    stateVector: string;
    rev: number;
    path: string;
    title?: string;
    pinned?: boolean;
  }): void {
    if (this.destroyed) return;
    const wasReady = this.ready;
    this.rev = msg.rev;
    this.path = msg.path;

    const remoteDiff = base64ToBytes(msg.update);
    if (remoteDiff.byteLength > 0) {
      Y.applyUpdate(this.doc, remoteDiff, REMOTE_ORIGIN);
    }

    if (!wasReady && this.pendingLocalDiff !== null) {
      const target = this.pendingLocalDiff;
      this.pendingLocalDiff = null;
      applyTextDiff(this.ytext, target, LOCAL_DIFF_ORIGIN);
    }

    this.hasSyncedWithServer = true;
    this.ready = true;

    // Push any local offline updates the server doesn't have yet.
    try {
      const serverVector = base64ToBytes(msg.stateVector);
      const missingForServer = Y.encodeStateAsUpdate(this.doc, serverVector);
      // Empty Yjs update is 2 bytes ([0, 0]).
      if (missingForServer.byteLength > 2) {
        this.client.sendYjsUpdate(this.noteId, missingForServer);
      }
    } catch {
      // Ignore invalid server state vector.
    }

    // Broadcast our own cursor/presence now that we joined.
    this.client.sendAwareness(this.noteId, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));

    this.options.onMeta?.({
      rev: msg.rev,
      path: msg.path,
      title: msg.title,
      pinned: msg.pinned,
    });

    this.schedulePersist(true);
    if (!wasReady) {
      this.options.onReady?.();
    }
  }

  handleRemoteYjsUpdate(updateB64: string, rev?: number, path?: string): void {
    if (this.destroyed) return;
    if (typeof rev === "number") this.rev = rev;
    if (typeof path === "string") this.path = path;
    const bytes = base64ToBytes(updateB64);
    if (bytes.byteLength > 0) {
      Y.applyUpdate(this.doc, bytes, REMOTE_ORIGIN);
    }
    if (typeof rev === "number" && typeof path === "string") {
      this.options.onMeta?.({ rev, path });
    }
  }

  handleRemoteAwareness(updateB64: string): void {
    if (this.destroyed) return;
    try {
      applyAwarenessUpdate(this.awareness, base64ToBytes(updateB64), REMOTE_ORIGIN);
    } catch {
      // Ignore malformed awareness updates.
    }
  }

  handleNoteEvent(event: LiveNoteEvent): void {
    if (this.destroyed || event.id !== this.noteId) return;
    if (event.deletedAt !== null) {
      this.options.onDeleted?.();
      return;
    }
    this.rev = event.rev;
    this.path = event.path;
    this.options.onMeta?.({
      rev: event.rev,
      path: event.path,
      title: event.title,
      pinned: event.pinned,
    });
  }

  private schedulePersist(immediate = false): void {
    if (!this.options.onPersist || !this.ready) return;
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const flush = () => {
      if (this.destroyed || !this.ready) return;
      this.options.onPersist?.(
        Y.encodeStateAsUpdate(this.doc),
        this.ytext.toString(),
        this.rev,
        this.path,
      );
    };
    if (immediate) {
      flush();
      return;
    }
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      flush();
    }, 350);
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
      if (this.ready && this.options.onPersist) {
        this.options.onPersist(
          Y.encodeStateAsUpdate(this.doc),
          this.ytext.toString(),
          this.rev,
          this.path,
        );
      }
    }
    this.destroyed = true;
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.client.detachSession(this);
    this.undoManager.destroy();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

export interface CollabClientOptions {
  /** Base HTTP/HTTPS server URL, or empty string for same-origin web app. */
  serverUrl: string;
  /** Optional device bearer token (desktop); omit for cookie-authenticated web sessions. */
  token?: string;
  onStatus?: (status: CollabConnectionStatus) => void;
  onNoteChanged?: (note: LiveNoteEvent) => void;
  onError?: (message: string) => void;
}

export class CollabClient {
  private ws: WebSocket | null = null;
  private authed = false;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private session: NoteCollabSession | null = null;
  status: CollabConnectionStatus = "disconnected";
  deviceName = "Web";

  constructor(private readonly options: CollabClientOptions) {
    this.connect();
  }

  private setStatus(next: CollabConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.options.onStatus?.(next);
  }

  private send(payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  private connect(): void {
    if (this.closed) return;
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(toWebSocketUrl(this.options.serverUrl));
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error.message : String(error));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.authed = false;

    ws.addEventListener("open", () => {
      if (this.ws !== ws || this.closed) return;
      if (this.options.token) {
        this.send({ type: "auth", token: this.options.token });
      }
      if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => {
        this.send({ type: "ping" });
      }, 25_000);
    });

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws || this.closed) return;
      if (typeof event.data !== "string") return;
      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (typeof parsed !== "object" || parsed === null) return;
        msg = parsed as Record<string, unknown>;
      } catch {
        return;
      }

      const type = msg["type"];
      if (type === "authed") {
        this.authed = true;
        this.reconnectAttempt = 0;
        if (typeof msg["deviceName"] === "string") {
          this.deviceName = msg["deviceName"];
        }
        this.setStatus("connected");
        if (this.session) {
          this.sendJoin(this.session);
        }
        return;
      }

      if (type === "sync-state") {
        const noteId = msg["noteId"];
        if (this.session && this.session.noteId === noteId) {
          this.session.handleSyncState({
            update: String(msg["update"] ?? ""),
            stateVector: String(msg["stateVector"] ?? ""),
            rev: Number(msg["rev"] ?? 0),
            path: String(msg["path"] ?? ""),
            title: typeof msg["title"] === "string" ? msg["title"] : undefined,
            pinned: typeof msg["pinned"] === "boolean" ? msg["pinned"] : undefined,
          });
        }
        return;
      }

      if (type === "yjs-update") {
        const noteId = msg["noteId"];
        if (this.session && this.session.noteId === noteId && typeof msg["update"] === "string") {
          this.session.handleRemoteYjsUpdate(
            msg["update"],
            typeof msg["rev"] === "number" ? msg["rev"] : undefined,
            typeof msg["path"] === "string" ? msg["path"] : undefined,
          );
        }
        return;
      }

      if (type === "awareness") {
        const noteId = msg["noteId"];
        if (this.session && this.session.noteId === noteId && typeof msg["update"] === "string") {
          this.session.handleRemoteAwareness(msg["update"]);
        }
        return;
      }

      if (type === "note-changed" && typeof msg["note"] === "object" && msg["note"] !== null) {
        const note = msg["note"] as LiveNoteEvent;
        this.session?.handleNoteEvent(note);
        this.options.onNoteChanged?.(note);
        return;
      }

      if (type === "error" && typeof msg["message"] === "string") {
        this.options.onError?.(msg["message"]);
      }
    });

    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.authed = false;
      if (this.pingTimer !== null) {
        window.clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.setStatus("disconnected");
      if (!this.closed && event.code !== 4401) {
        this.scheduleReconnect();
      }
    });

    ws.addEventListener("error", () => {
      // Close event handles reconnect cleanly.
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const delay = Math.min(10_000, 1000 * Math.pow(1.8, this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private sendJoin(session: NoteCollabSession): void {
    if (!this.authed) return;
    const sv = session.joinStateVector();
    this.send({
      type: "join",
      noteId: session.noteId,
      ...(sv ? { stateVector: bytesToBase64(sv) } : {}),
    });
  }

  openNote(noteId: string, options: OpenNoteSessionOptions): NoteCollabSession {
    if (this.session) {
      this.session.destroy();
    }
    const session = new NoteCollabSession(noteId, this, options);
    this.session = session;
    if (this.authed) {
      this.sendJoin(session);
    }
    return session;
  }

  detachSession(session: NoteCollabSession): void {
    if (this.session !== session) return;
    this.session = null;
    if (this.authed) {
      this.send({ type: "leave", noteId: session.noteId });
    }
  }

  sendYjsUpdate(noteId: string, update: Uint8Array): void {
    if (!this.authed) return;
    this.send({ type: "yjs-update", noteId, update: bytesToBase64(update) });
  }

  sendAwareness(noteId: string, update: Uint8Array): void {
    if (!this.authed) return;
    this.send({ type: "awareness", noteId, update: bytesToBase64(update) });
  }

  close(): void {
    this.closed = true;
    if (this.session) {
      this.session.destroy();
      this.session = null;
    }
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "client closing");
      } catch {
        // Ignore.
      }
      this.ws = null;
    }
    this.setStatus("disconnected");
  }
}
