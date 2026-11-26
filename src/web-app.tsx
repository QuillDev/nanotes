import React from "react";
import { createRoot } from "react-dom/client";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import {
  CollabClient,
  NoteCollabSession,
  type CollabConnectionStatus,
  type LiveNoteEvent,
} from "./collab";
import "./web-app.css";

interface LoginMethods {
  passkey: boolean;
  passkeyConfigured: boolean;
  password: boolean;
}

interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface NoteSummary {
  id: string;
  path: string;
  title: string;
  pinned: boolean;
  rev: number;
  updatedAt: number;
  size: number;
}

type Route =
  | { kind: "home" }
  | { kind: "passkey"; token: string }
  | { kind: "pair"; code: string };

function parseRoute(): Route {
  const hash = window.location.hash.replace(/^#/, "");
  const passkeyMatch = /^\/passkey\/([^/]+)$/.exec(hash);
  if (passkeyMatch) return { kind: "passkey", token: decodeURIComponent(passkeyMatch[1]!) };
  const pairMatch = /^\/pair\/([^/]+)$/.exec(hash);
  if (pairMatch) return { kind: "pair", code: decodeURIComponent(pairMatch[1]!) };
  return { kind: "home" };
}

function b64urlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function api<T = Record<string, unknown>>(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: T }> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const res = await fetch(path, { credentials: "same-origin", ...init, headers });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

const webHighlight = HighlightStyle.define([
  { tag: tags.heading1, color: "#ffffff", fontSize: "1.45em", fontWeight: "700" },
  { tag: tags.heading2, color: "#f6f7fb", fontSize: "1.25em", fontWeight: "700" },
  { tag: tags.heading3, color: "#eceef5", fontSize: "1.1em", fontWeight: "650" },
  { tag: tags.strong, color: "#ffffff", fontWeight: "700" },
  { tag: tags.emphasis, color: "#f8b4cb", fontStyle: "italic" },
  { tag: tags.strikethrough, color: "#8b91a7", textDecoration: "line-through" },
  { tag: tags.monospace, color: "#ff9fc0", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  { tag: tags.link, color: "#ff7aa5", textDecoration: "underline" },
  { tag: tags.url, color: "#ff7aa5" },
  { tag: tags.quote, color: "#b5bbcf", fontStyle: "italic" },
  { tag: tags.meta, color: "#686e85" },
  { tag: tags.processingInstruction, color: "#686e85" },
]);

const webEditorTheme = EditorView.theme(
  {
    "&": {
      color: "#eceef5",
      fontSize: "15px",
      lineHeight: "1.65",
      height: "100%",
    },
    ".cm-content": {
      caretColor: "#f65c8e",
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      minHeight: "100%",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#f65c8e",
      borderLeftWidth: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "rgba(246, 92, 142, 0.28) !important",
    },
    ".cm-placeholder": {
      color: "#686e85",
    },
  },
  { dark: true },
);

function LiveNoteEditor({ session }: { session: NoteCollabSession }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    const parent = containerRef.current;
    if (!parent) return;

    const state = EditorState.create({
      doc: session.ytext.toString(),
      extensions: [
        drawSelection(),
        cmPlaceholder("Start typing…"),
        keymap.of([...defaultKeymap, ...yUndoManagerKeymap]),
        markdown({ codeLanguages: languages }),
        syntaxHighlighting(webHighlight),
        EditorView.lineWrapping,
        webEditorTheme,
        yCollab(session.ytext, session.awareness, { undoManager: session.undoManager }),
      ],
    });

    const view = new EditorView({ state, parent });
    return () => {
      view.destroy();
    };
  }, [session]);

  return <div className="editorHost" ref={containerRef} />;
}

function sortNotes(list: NoteSummary[]): NoteSummary[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

function WebApp() {
  const [route, setRoute] = React.useState<Route>(parseRoute);
  const [methods, setMethods] = React.useState<LoginMethods>({
    passkey: false,
    passkeyConfigured: false,
    password: false,
  });
  const [signedIn, setSignedIn] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [devices, setDevices] = React.useState<DeviceInfo[]>([]);
  const [newToken, setNewToken] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState<NoteSummary[]>([]);
  const [query, setQuery] = React.useState("");
  const [activeNoteId, setActiveNoteId] = React.useState<string | null>(null);
  const [liveSession, setLiveSession] = React.useState<NoteCollabSession | null>(null);
  const [collabStatus, setCollabStatus] = React.useState<CollabConnectionStatus>("disconnected");
  const [showDevices, setShowDevices] = React.useState(false);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const collabRef = React.useRef<CollabClient | null>(null);

  React.useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const loadSession = React.useCallback(async () => {
    setLoading(true);
    const [methodsRes, devicesRes, notesRes] = await Promise.all([
      api<LoginMethods>("/api/login/methods"),
      api<{ devices: DeviceInfo[] }>("/api/devices"),
      api<{ notes: NoteSummary[] }>("/api/notes"),
    ]);
    if (methodsRes.ok) setMethods(methodsRes.data);
    if (devicesRes.ok) {
      setSignedIn(true);
      setDevices(devicesRes.data.devices ?? []);
      const list = sortNotes(notesRes.ok ? (notesRes.data.notes ?? []) : []);
      setNotes(list);
      setActiveNoteId((prev) => (prev && list.some((n) => n.id === prev) ? prev : (list[0]?.id ?? null)));
    } else {
      setSignedIn(false);
    }
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // Persistent live WebSocket connection once signed in.
  React.useEffect(() => {
    if (!signedIn) {
      collabRef.current?.close();
      collabRef.current = null;
      setLiveSession(null);
      setCollabStatus("disconnected");
      return;
    }

    const client = new CollabClient({
      serverUrl: "",
      onStatus: setCollabStatus,
      onNoteChanged: (event: LiveNoteEvent) => {
        setNotes((prev) => {
          if (event.deletedAt !== null) {
            return prev.filter((item) => item.id !== event.id);
          }
          const summary: NoteSummary = {
            id: event.id,
            path: event.path,
            title: event.title,
            pinned: event.pinned,
            rev: event.rev,
            updatedAt: event.updatedAt,
            size: event.size,
          };
          const exists = prev.some((item) => item.id === event.id);
          const next = exists
            ? prev.map((item) => (item.id === event.id ? summary : item))
            : [summary, ...prev];
          return sortNotes(next);
        });
      },
      onError: (msg) => setError(msg),
    });
    collabRef.current = client;
    return () => {
      client.close();
      if (collabRef.current === client) collabRef.current = null;
    };
  }, [signedIn]);

  // Attach live Yjs room for the selected note.
  React.useEffect(() => {
    const client = collabRef.current;
    if (!signedIn || !client || !activeNoteId || showDevices || route.kind !== "home") {
      setLiveSession(null);
      return;
    }

    let cancelled = false;
    const isMobile = /android|iphone|ipad/i.test(navigator.userAgent);
    const session = client.openNote(activeNoteId, {
      peerName: isMobile ? "Mobile" : "Web",
      onReady: () => {
        if (!cancelled) setLiveSession(session);
      },
      onDeleted: () => {
        if (!cancelled) {
          setLiveSession(null);
          setActiveNoteId((prev) => (prev === activeNoteId ? null : prev));
        }
      },
    });
    if (session.ready) {
      setLiveSession(session);
    } else {
      setLiveSession(null);
    }

    return () => {
      cancelled = true;
      session.destroy();
    };
  }, [activeNoteId, route.kind, showDevices, signedIn]);

  const registerPasskey = React.useCallback(
    async (token: string) => {
      setError("");
      setMessage("");
      const opts = await api<{
        challengeId: string;
        publicKey: {
          challenge: string;
          rp: PublicKeyCredentialRpEntity;
          user: { id: string; name: string; displayName: string };
          pubKeyCredParams: PublicKeyCredentialParameters[];
          excludeCredentials?: { id: string; type: PublicKeyCredentialType }[];
          authenticatorSelection?: AuthenticatorSelectionCriteria;
          timeout?: number;
          attestation?: AttestationConveyancePreference;
        };
        error?: string;
      }>("/api/passkeys/register/options", {
        method: "POST",
        body: JSON.stringify({ setup: token }),
      });
      if (!opts.ok) {
        setError(opts.data.error || "Invalid or expired link");
        return;
      }
      try {
        const pk = opts.data.publicKey;
        const cred = (await navigator.credentials.create({
          publicKey: {
            ...pk,
            challenge: b64urlToBytes(pk.challenge),
            user: { ...pk.user, id: b64urlToBytes(pk.user.id) },
            excludeCredentials: (pk.excludeCredentials ?? []).map((item) => ({
              ...item,
              id: b64urlToBytes(item.id),
            })),
          },
        })) as PublicKeyCredential | null;
        if (!cred) return;
        const response = cred.response as AuthenticatorAttestationResponse;
        const finish = await api<{ error?: string }>("/api/passkeys/register", {
          method: "POST",
          body: JSON.stringify({
            challengeId: opts.data.challengeId,
            credential: {
              id: bytesToB64url(cred.rawId),
              clientDataJSON: bytesToB64url(response.clientDataJSON),
              attestationObject: bytesToB64url(response.attestationObject),
            },
          }),
        });
        if (!finish.ok) {
          setError(finish.data.error || "Passkey registration failed");
          return;
        }
        window.location.hash = "#/";
        setMessage("Passkey registered.");
        await loadSession();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Passkey canceled");
      }
    },
    [loadSession],
  );

  const signInPasskey = React.useCallback(async () => {
    setError("");
    const opts = await api<{
      challengeId: string;
      publicKey: {
        challenge: string;
        rpId: string;
        allowCredentials?: { id: string; type: PublicKeyCredentialType }[];
        userVerification?: UserVerificationRequirement;
        timeout?: number;
      };
      error?: string;
    }>("/api/passkeys/login/options", { method: "POST", body: "{}" });
    if (!opts.ok) {
      setError(opts.data.error || "Could not start passkey sign-in");
      return;
    }
    try {
      const pk = opts.data.publicKey;
      const cred = (await navigator.credentials.get({
        publicKey: {
          ...pk,
          challenge: b64urlToBytes(pk.challenge),
          allowCredentials: (pk.allowCredentials ?? []).map((item) => ({
            ...item,
            id: b64urlToBytes(item.id),
          })),
        },
      })) as PublicKeyCredential | null;
      if (!cred) return;
      const response = cred.response as AuthenticatorAssertionResponse;
      const finish = await api<{ error?: string }>("/api/passkeys/login", {
        method: "POST",
        body: JSON.stringify({
          challengeId: opts.data.challengeId,
          credential: {
            id: bytesToB64url(cred.rawId),
            clientDataJSON: bytesToB64url(response.clientDataJSON),
            authenticatorData: bytesToB64url(response.authenticatorData),
            signature: bytesToB64url(response.signature),
          },
        }),
      });
      if (!finish.ok) {
        setError(finish.data.error || "Passkey sign-in failed");
        return;
      }
      await loadSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Passkey canceled");
    }
  }, [loadSession]);

  const createNote = React.useCallback(async () => {
    setError("");
    const res = await api<NoteSummary & { error?: string }>("/api/notes", {
      method: "POST",
      body: JSON.stringify({ content: "# Untitled\n\n" }),
    });
    if (!res.ok) {
      setError(res.data.error || "Could not create note");
      return;
    }
    setShowDevices(false);
    setSidebarOpen(false);
    setNotes((prev) => sortNotes([res.data, ...prev.filter((n) => n.id !== res.data.id)]));
    setActiveNoteId(res.data.id);
  }, []);

  const togglePin = React.useCallback(async (note: NoteSummary) => {
    await api(`/api/notes/${encodeURIComponent(note.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ pinned: !note.pinned }),
    });
  }, []);

  const removeNote = React.useCallback(
    async (note: NoteSummary) => {
      await api(`/api/notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
      setNotes((prev) => {
        const rest = prev.filter((item) => item.id !== note.id);
        if (activeNoteId === note.id) {
          setActiveNoteId(rest[0]?.id ?? null);
        }
        return rest;
      });
    },
    [activeNoteId],
  );

  const visibleNotes = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return notes;
    return notes.filter((n) => `${n.title} ${n.path}`.toLowerCase().includes(needle));
  }, [notes, query]);

  if (route.kind === "passkey") {
    return (
      <div className="authPage">
        <div className="authInner">
          <div className="authHeader">
            <h1 className="brand">
              <span><span className="na">na</span>notes</span>
            </h1>
          </div>
          <div className="stack">
            <p className="muted">Register a passkey for this nanotes sync server.</p>
            <div className="actions">
              <button className="btn btn-primary" type="button" onClick={() => void registerPasskey(route.token)}>
                Add passkey
              </button>
            </div>
            {error ? <div className="error">{error}</div> : null}
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="authPage">
        <div className="authInner">
          <div className="authHeader">
            <h1 className="brand">
              <span><span className="na">na</span>notes</span>
            </h1>
          </div>
          <p className="muted">Loading…</p>
        </div>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="authPage">
        <div className="authInner">
          <div className="authHeader">
            <h1 className="brand">
              <span><span className="na">na</span>notes</span>
            </h1>
          </div>
          <div className="stack">
            <p className="muted">
              {route.kind === "pair"
                ? `Sign in to approve device ${route.code}.`
                : "Sign in to edit and sync your notes."}
            </p>
            {methods.passkey ? (
              <div className="actions">
                <button className="btn btn-primary" type="button" onClick={() => void signInPasskey()}>
                  Sign in with passkey
                </button>
              </div>
            ) : null}
            {methods.password ? (
              <form
                className="stack"
                onSubmit={async (event) => {
                  event.preventDefault();
                  setError("");
                  const res = await api<{ error?: string }>("/api/login", {
                    method: "POST",
                    body: JSON.stringify({ password }),
                  });
                  if (!res.ok) {
                    setError(res.data.error || "Sign in failed");
                    return;
                  }
                  setPassword("");
                  await loadSession();
                }}
              >
                <input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{ height: 38, padding: "0 12px" }}
                />
                <div className="actions">
                  <button className={methods.passkey ? "btn" : "btn btn-primary"} type="submit">
                    Sign in with password
                  </button>
                </div>
              </form>
            ) : null}
            {!methods.passkey && !methods.password ? (
              <p className="muted">
                No passkey registered yet. Run the setup-link command on the server or call passkey_setup_link over MCP.
              </p>
            ) : null}
            {error ? <div className="error">{error}</div> : null}
          </div>
        </div>
      </div>
    );
  }

  if (route.kind === "pair") {
    return (
      <div className="authPage">
        <div className="authInner">
          <div className="authHeader">
            <h1 className="brand">
              <span><span className="na">na</span>notes</span>
            </h1>
          </div>
          <div className="stack">
            <p className="muted">Approve desktop sync for this pairing code:</p>
            <div className="codeBox">{route.code}</div>
            <div className="actions">
              <button
                className="btn btn-primary"
                type="button"
                onClick={async () => {
                  setError("");
                  setMessage("");
                  const res = await api<{ device?: DeviceInfo; error?: string }>("/api/device/approve", {
                    method: "POST",
                    body: JSON.stringify({ code: route.code }),
                  });
                  if (!res.ok) {
                    setError(res.data.error || "Could not approve device");
                    return;
                  }
                  setMessage(`Approved ${res.data.device?.name || "device"}. You can return to nanotes.`);
                  window.location.hash = "#/";
                  await loadSession();
                }}
              >
                Approve device
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => {
                  window.location.hash = "#/";
                }}
              >
                Cancel
              </button>
            </div>
            {error ? <div className="error">{error}</div> : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace">
      <header className="topbar">
        <div className="topbarLeft">
          <button
            className="btn btn-ghost menuToggle"
            type="button"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            Notes
          </button>
          <h1 className="brand">
            <span><span className="na">na</span>notes</span>
            <span
              className={`liveDot liveDot-${collabStatus}`}
              title={collabStatus === "connected" ? "Live sync connected" : `Sync: ${collabStatus}`}
            />
          </h1>
        </div>
        <div className="topbarRight">
          <button className="btn btn-primary" type="button" onClick={() => void createNote()}>
            New
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => {
              setShowDevices((v) => !v);
              setSidebarOpen(false);
            }}
          >
            {showDevices ? "Editor" : "Devices"}
          </button>
          <button
            className="btn btn-ghost"
            type="button"
            onClick={async () => {
              await api("/api/logout", { method: "POST", body: "{}" });
              setSignedIn(false);
              setNotes([]);
              setActiveNoteId(null);
              setLiveSession(null);
              setNewToken(null);
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {showDevices ? (
        <div className="devicesPanel">
          <div className="devicesInner stack">
            {message ? <div className="ok">{message}</div> : null}
            {error ? <div className="error">{error}</div> : null}
            <div className="actions">
              <button
                className="btn"
                type="button"
                onClick={async () => {
                  const name = window.prompt("Device label", "Manual token");
                  if (name === null) return;
                  const res = await api<{ token?: string; error?: string }>("/api/devices", {
                    method: "POST",
                    body: JSON.stringify({ name }),
                  });
                  if (!res.ok) {
                    setError(res.data.error || "Could not create token");
                    return;
                  }
                  setNewToken(res.data.token ?? null);
                  await loadSession();
                }}
              >
                New sync token
              </button>
              {methods.passkeyConfigured ? (
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={async () => {
                    const res = await api<{ url?: string; error?: string }>("/api/passkeys/setup-link", {
                      method: "POST",
                      body: "{}",
                    });
                    if (!res.ok) {
                      setError(res.data.error || "Passkeys not configured");
                      return;
                    }
                    setMessage(`One-time passkey setup link: ${res.data.url}`);
                  }}
                >
                  Add passkey
                </button>
              ) : null}
            </div>
            {newToken ? (
              <div className="stack">
                <p className="muted">Copy this token now (shown once):</p>
                <div className="codeBox">{newToken}</div>
              </div>
            ) : null}
            {devices.length === 0 ? (
              <p className="muted">No devices connected yet.</p>
            ) : (
              <div>
                {devices.map((device) => (
                  <div className="deviceRow" key={device.id}>
                    <div>
                      <div>{device.name}</div>
                      <div className="muted">
                        {device.lastUsedAt
                          ? `Last synced ${new Date(device.lastUsedAt).toLocaleString()}`
                          : "Never synced"}
                      </div>
                    </div>
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={async () => {
                        await api(`/api/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
                        await loadSession();
                      }}
                    >
                      Revoke
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="workspaceBody">
          <aside className={sidebarOpen ? "sidebar sidebar-open" : "sidebar"}>
            <div className="sidebarSearch">
              <input
                type="search"
                placeholder="Search notes…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="noteList">
              {visibleNotes.length === 0 ? (
                <p className="muted" style={{ padding: 12 }}>
                  No notes yet.
                </p>
              ) : (
                visibleNotes.map((note) => (
                  <div
                    className={note.id === activeNoteId ? "noteRow noteRow-active" : "noteRow"}
                    key={note.id}
                  >
                    <button
                      className="noteRowMain"
                      type="button"
                      onClick={() => {
                        setActiveNoteId(note.id);
                        setSidebarOpen(false);
                      }}
                    >
                      <span className="noteRowTitle">{note.title}</span>
                      <span className="noteRowPath">{note.path}</span>
                    </button>
                    <button
                      className={note.pinned ? "iconBtn iconBtn-pinned" : "iconBtn"}
                      type="button"
                      title={note.pinned ? "Unpin" : "Pin"}
                      onClick={() => void togglePin(note)}
                    >
                      ★
                    </button>
                    <button
                      className="iconBtn"
                      type="button"
                      title="Delete note"
                      onClick={() => void removeNote(note)}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>

          <main className="editorPane" onClick={() => sidebarOpen && setSidebarOpen(false)}>
            {message ? (
              <div className="ok" style={{ padding: "8px 16px" }}>
                {message}
              </div>
            ) : null}
            {error ? (
              <div className="error" style={{ padding: "8px 16px" }}>
                {error}
              </div>
            ) : null}
            {liveSession ? (
              <LiveNoteEditor key={liveSession.noteId} session={liveSession} />
            ) : activeNoteId ? (
              <div className="editorEmpty">Connecting to live note…</div>
            ) : (
              <div className="editorEmpty">
                <div className="stack" style={{ justifyItems: "center" }}>
                  <div>Select a note or create a new one.</div>
                  <button className="btn btn-primary" type="button" onClick={() => void createNote()}>
                    New note
                  </button>
                </div>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WebApp />
  </React.StrictMode>,
);
