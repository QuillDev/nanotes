import React from "react";
import { createRoot } from "react-dom/client";
import {
  CollabClient,
  NoteCollabSession,
  type CollabConnectionStatus,
  type LiveNoteEvent,
} from "./collab";
import { Button, Input } from "nakomponents";
import { Pin, X } from "lucide-react";
import { TokenLabelDialog } from "./components/TokenLabelDialog";
import { apiClient, failure, segment } from "./lib/api";
import type { DeviceInfo } from "../server/auth.ts";
import type { NoteSummary } from "../server/notes.ts";
import "./web-app.css";

const loadLiveNoteEditor = () => import("./web-editor");
const LiveNoteEditor = React.lazy(loadLiveNoteEditor);

class EditorErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="editorEmpty">
          <div className="stack" style={{ justifyItems: "center" }}>
            <div>The editor could not load. A new version may have been deployed.</div>
            <Button size="sm"
              type="button"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const api = apiClient(window.location.origin);

type LoginMethods = NonNullable<Awaited<ReturnType<typeof api.login.methods.get>>["data"]>;

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

function sortNotes(list: NoteSummary[]): NoteSummary[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

const CLIENT_NAME_STORAGE_KEY = "nanotes:clientName";
const DEFAULT_CLIENT_NAME = /android|iphone|ipad/i.test(navigator.userAgent) ? "Mobile" : "Web";

function readStoredClientName(): string {
  try {
    return window.localStorage.getItem(CLIENT_NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
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
  const [clientName, setClientName] = React.useState<string>(readStoredClientName);
  const clientNameRef = React.useRef(clientName);
  clientNameRef.current = clientName;
  const [editingDeviceId, setEditingDeviceId] = React.useState<string | null>(null);
  const [editingDeviceName, setEditingDeviceName] = React.useState("");
  const [newToken, setNewToken] = React.useState<string | null>(null);
  const [tokenDialogOpen, setTokenDialogOpen] = React.useState(false);
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
      api.login.methods.get(),
      api.devices.get(),
      api.notes.get(),
    ]);
    if (methodsRes.data) setMethods(methodsRes.data);
    if (devicesRes.data) {
      void loadLiveNoteEditor().catch(() => {});
      setSignedIn(true);
      setDevices(devicesRes.data.devices);
      const list = sortNotes(notesRes.data?.notes ?? []);
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
    const session = client.openNote(activeNoteId, {
      peerName: clientNameRef.current.trim() || DEFAULT_CLIENT_NAME,
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

  React.useEffect(() => {
    const trimmed = clientName.trim().slice(0, 80);
    try {
      if (trimmed) {
        window.localStorage.setItem(CLIENT_NAME_STORAGE_KEY, trimmed);
      } else {
        window.localStorage.removeItem(CLIENT_NAME_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures in restricted browsing modes.
    }
    liveSession?.setPeerName(trimmed || DEFAULT_CLIENT_NAME);
  }, [clientName, liveSession]);

  const registerPasskey = React.useCallback(
    async (token: string) => {
      setError("");
      setMessage("");
      const opts = await api.passkeys.register.options.post({ setup: token });
      if (!opts.data) {
        setError(failure(opts.error, "Invalid or expired link"));
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
        const finish = await api.passkeys.register.post({
          challengeId: opts.data.challengeId,
          credential: {
            id: bytesToB64url(cred.rawId),
            clientDataJSON: bytesToB64url(response.clientDataJSON),
            attestationObject: bytesToB64url(response.attestationObject),
          },
        });
        if (finish.error) {
          setError(failure(finish.error, "Passkey registration failed"));
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
    const opts = await api.passkeys.login.options.post();
    if (!opts.data) {
      setError(failure(opts.error, "Could not start passkey sign-in"));
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
      const finish = await api.passkeys.login.post({
        challengeId: opts.data.challengeId,
        credential: {
          id: bytesToB64url(cred.rawId),
          clientDataJSON: bytesToB64url(response.clientDataJSON),
          authenticatorData: bytesToB64url(response.authenticatorData),
          signature: bytesToB64url(response.signature),
        },
      });
      if (finish.error) {
        setError(failure(finish.error, "Passkey sign-in failed"));
        return;
      }
      await loadSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Passkey canceled");
    }
  }, [loadSession]);

  const createToken = React.useCallback(
    async (name: string) => {
      const res = await api.devices.post({ name });
      if (!res.data) {
        setError(failure(res.error, "Could not create token"));
        return;
      }
      setNewToken(res.data.token);
      await loadSession();
    },
    [loadSession],
  );

  const createNote = React.useCallback(async () => {
    setError("");
    const res = await api.notes.post({ content: "# Untitled\n\n" });
    if (!res.data) {
      setError(failure(res.error, "Could not create note"));
      return;
    }
    const { content, ...created } = res.data;
    const summary: NoteSummary = { ...created, size: new TextEncoder().encode(content).length };
    setShowDevices(false);
    setSidebarOpen(false);
    setNotes((prev) => sortNotes([summary, ...prev.filter((n) => n.id !== summary.id)]));
    setActiveNoteId(summary.id);
  }, []);

  const togglePin = React.useCallback(async (note: NoteSummary) => {
    setError("");
    const res = await api.notes({ id: segment(note.id) }).patch({ pinned: !note.pinned });
    if (res.error) {
      setError(failure(res.error, "Could not update pin state"));
    }
  }, []);

  const notesRef = React.useRef(notes);
  notesRef.current = notes;

  const removeNote = React.useCallback(
    async (note: NoteSummary) => {
      setError("");
      const res = await api.notes({ id: segment(note.id) }).delete();
      if (res.error) {
        setError(failure(res.error, "Could not delete note"));
        return;
      }
      const nextNotes = notesRef.current.filter((item) => item.id !== note.id);
      setNotes(nextNotes);
      if (activeNoteId === note.id) {
        setActiveNoteId(nextNotes[0]?.id ?? null);
      }
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
              <Button size="sm" type="button" onClick={() => void registerPasskey(route.token)}>
                Add passkey
              </Button>
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
                <Button size="sm" type="button" onClick={() => void signInPasskey()}>
                  Sign in with passkey
                </Button>
              </div>
            ) : null}
            {methods.password ? (
              <form
                className="stack"
                onSubmit={async (event) => {
                  event.preventDefault();
                  setError("");
                  const res = await api.login.post({ password });
                  if (res.error) {
                    setError(failure(res.error, "Sign in failed"));
                    return;
                  }
                  setPassword("");
                  await loadSession();
                }}
              >
                <Input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <div className="actions">
                  <Button size="sm" variant={methods.passkey ? "outline" : "default"} type="submit">
                    Sign in with password
                  </Button>
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
              <Button size="sm"
                type="button"
                onClick={async () => {
                  setError("");
                  setMessage("");
                  const res = await api.device.approve.post({ code: route.code });
                  if (!res.data) {
                    setError(failure(res.error, "Could not approve device"));
                    return;
                  }
                  setMessage(`Approved ${res.data.device.name || "device"}. You can return to nanotes.`);
                  window.location.hash = "#/";
                  await loadSession();
                }}
              >
                Approve device
              </Button>
              <Button size="sm" variant="ghost"
                type="button"
                onClick={() => {
                  window.location.hash = "#/";
                }}
              >
                Cancel
              </Button>
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
          <Button
            size="sm"
            variant="ghost"
            className="menuToggle"
            type="button"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            Notes
          </Button>
          <h1 className="brand">
            <span><span className="na">na</span>notes</span>
            <span
              className={`liveDot liveDot-${collabStatus}`}
              title={collabStatus === "connected" ? "Live sync connected" : `Sync: ${collabStatus}`}
            />
          </h1>
        </div>
        <div className="topbarRight">
          <Button size="sm" type="button" onClick={() => void createNote()}>
            New
          </Button>
          <Button size="sm" variant="ghost"
            type="button"
            onClick={() => {
              setShowDevices((v) => !v);
              setSidebarOpen(false);
            }}
          >
            {showDevices ? "Editor" : "Devices"}
          </Button>
          <Button size="sm" variant="ghost"
            type="button"
            onClick={async () => {
              await api.logout.post();
              setSignedIn(false);
              setNotes([]);
              setActiveNoteId(null);
              setLiveSession(null);
              setNewToken(null);
            }}
          >
            Sign out
          </Button>
        </div>
      </header>

      {showDevices ? (
        <div className="devicesPanel">
          <div className="devicesInner stack">
            {message ? <div className="ok">{message}</div> : null}
            {error ? <div className="error">{error}</div> : null}
            <label className="deviceField">
              <span className="muted">This browser</span>
              <Input
                type="text"
                maxLength={80}
                placeholder={DEFAULT_CLIENT_NAME}
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
              />
            </label>
            <div className="actions">
              <Button size="sm" variant="outline"
                type="button"
                onClick={() => setTokenDialogOpen(true)}
              >
                New sync token
              </Button>
              {methods.passkeyConfigured ? (
                <Button size="sm" variant="ghost"
                  type="button"
                  onClick={async () => {
                    const res = await api.passkeys["setup-link"].post();
                    if (!res.data) {
                      setError(failure(res.error, "Passkeys not configured"));
                      return;
                    }
                    setMessage(`One-time passkey setup link: ${res.data.url}`);
                  }}
                >
                  Add passkey
                </Button>
              ) : null}
            </div>
            <TokenLabelDialog
              open={tokenDialogOpen}
              onOpenChange={setTokenDialogOpen}
              onCreate={(name) => void createToken(name)}
            />
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
                    {editingDeviceId === device.id ? (
                      <form
                        className="deviceEditForm"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const trimmed = editingDeviceName.trim();
                          if (!trimmed) return;
                          setError("");
                          const res = await api.devices({ id: segment(device.id) }).patch({ name: trimmed });
                          if (!res.data) {
                            setError(failure(res.error, "Could not rename device"));
                            return;
                          }
                          const updated = res.data.device;
                          setDevices((prev) => prev.map((item) => (item.id === device.id ? updated : item)));
                          setEditingDeviceId(null);
                        }}
                      >
                        <Input
                          type="text"
                          maxLength={80}
                          autoFocus
                          value={editingDeviceName}
                          onChange={(e) => setEditingDeviceName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") setEditingDeviceId(null);
                          }}
                        />
                        <div className="actions">
                          <Button size="sm" type="submit" disabled={!editingDeviceName.trim()}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost"
                            type="button"
                            onClick={() => setEditingDeviceId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div>
                          <div>{device.name}</div>
                          <div className="muted">
                            {device.lastUsedAt
                              ? `Last synced ${new Date(device.lastUsedAt).toLocaleString()}`
                              : "Never synced"}
                          </div>
                        </div>
                        <div className="actions">
                          <Button size="sm" variant="ghost"
                            type="button"
                            onClick={() => {
                              setEditingDeviceId(device.id);
                              setEditingDeviceName(device.name);
                            }}
                          >
                            Rename
                          </Button>
                          <Button size="sm" variant="ghost"
                            type="button"
                            onClick={async () => {
                              await api.devices({ id: segment(device.id) }).delete();
                              await loadSession();
                            }}
                          >
                            Revoke
                          </Button>
                        </div>
                      </>
                    )}
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
              <Input
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
                    <Button
                      className={note.pinned ? "iconBtn iconBtn-pinned" : "iconBtn"}
                      size="icon-xs"
                      variant="ghost"
                      type="button"
                      title={note.pinned ? "Unpin" : "Pin"}
                      aria-label={note.pinned ? "Unpin" : "Pin"}
                      onClick={() => void togglePin(note)}
                    >
                      <Pin fill={note.pinned ? "currentColor" : "none"} />
                    </Button>
                    <Button
                      className="iconBtn"
                      size="icon-xs"
                      variant="ghost"
                      type="button"
                      title="Delete note"
                      aria-label="Delete note"
                      onClick={() => void removeNote(note)}
                    >
                      <X />
                    </Button>
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
              <EditorErrorBoundary key={liveSession.noteId}>
                <React.Suspense fallback={<div className="editorEmpty">Loading editor…</div>}>
                  <LiveNoteEditor
                    key={liveSession.noteId}
                    session={liveSession}
                    onTitleChange={(title) => {
                      const id = liveSession.noteId;
                      setNotes((prev) =>
                        prev.map((item) => (item.id === id && item.title !== title ? { ...item, title } : item)),
                      );
                    }}
                  />
                </React.Suspense>
              </EditorErrorBoundary>
            ) : activeNoteId ? (
              <div className="editorEmpty">Connecting to live note…</div>
            ) : (
              <div className="editorEmpty">
                <div className="stack" style={{ justifyItems: "center" }}>
                  <div>Select a note or create a new one.</div>
                  <Button size="sm" type="button" onClick={() => void createNote()}>
                    New note
                  </Button>
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
