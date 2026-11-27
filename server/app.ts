import type { Server, WebSocketHandler } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Auth } from "./auth.ts";
import { CollabHub, type WsClientData } from "./collab.ts";
import { openDatabase } from "./database.ts";
import { handleMcp } from "./mcp.ts";
import { NotesStore, type SyncPushOp } from "./notes.ts";
import { Passkeys } from "./passkeys.ts";
import { WEB_UI_HTML } from "./ui.ts";
import { WebAuthnError } from "./webauthn.ts";

export interface AppOptions {
  readonly databasePath: string;
  readonly passwordHash: string | null;
  readonly mcpToken: string | null;
  readonly secureCookies: boolean;
  /** Public origin (https://...); passkey auth is enabled when set. */
  readonly origin: string | null;
  readonly clock?: () => number;
  readonly webDistDir?: string | null;
  readonly flushDebounceMs?: number;
}

const LIVE_WEB_SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#09090b" />
  <title>nanotes</title>
  <link rel="stylesheet" href="/assets/web-app.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/assets/web-app.js"></script>
</body>
</html>
`;

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, init);
}

function error(status: number, message: string): Response {
  return json({ error: message }, { status });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await req.json();
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function requestOrigin(req: Request, configuredOrigin: string | null): string {
  if (configuredOrigin) return new URL(configuredOrigin).origin;
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}

export function createApp(options: AppOptions): {
  fetch: (req: Request, server?: Server<WsClientData>) => Promise<Response>;
  websocket: WebSocketHandler<WsClientData>;
  close: () => void;
  notes: NotesStore;
  auth: Auth;
  passkeys: Passkeys | null;
  collab: CollabHub;
} {
  const clock = options.clock ?? Date.now;
  const database = openDatabase(options.databasePath);
  const notes = new NotesStore(database);
  const auth = new Auth(database, {
    passwordHash: options.passwordHash,
    mcpToken: options.mcpToken,
    secureCookies: options.secureCookies,
  });
  const passkeys = options.origin ? new Passkeys(database, options.origin) : null;
  const collab = new CollabHub(notes, auth, clock, {
    flushDebounceMs: options.flushDebounceMs,
  });
  notes.setHooks({
    beforeRead: (noteId) => collab.flushNote(noteId),
    onExternalContent: (note) => collab.applyExternalContent(note),
    onNoteChanged: (note) => collab.broadcastNoteChanged(note),
  });
  const webDistDir = options.webDistDir === undefined ? join(import.meta.dir, "..", "dist-web") : options.webDistDir;

  function ceremony(step: () => Response): Response {
    try {
      return step();
    } catch (cause) {
      if (cause instanceof WebAuthnError) return error(400, cause.message);
      throw cause;
    }
  }

  async function api(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const now = clock();

    if (path === "/api/login/methods" && req.method === "GET") {
      return json({
        passkey: passkeys?.any() ?? false,
        passkeyConfigured: passkeys !== null,
        password: auth.passwordEnabled(),
      });
    }

    if (path === "/api/login" && req.method === "POST") {
      if (!sameOrigin(req)) return error(403, "cross-origin request");
      if (!auth.passwordEnabled()) return error(404, "password login is disabled");
      const password = (await body(req))["password"];
      if (typeof password !== "string") return error(400, "password required");
      const result = await auth.signInWithPassword(password, now);
      if (result === null) return error(401, "wrong password");
      if ("limited" in result) return error(429, "too many attempts, try again later");
      return json({ ok: true }, { headers: { "set-cookie": result.cookie } });
    }

    if (path === "/api/logout" && req.method === "POST") {
      if (!sameOrigin(req)) return error(403, "cross-origin request");
      return json({ ok: true }, { headers: { "set-cookie": auth.signOut(req) } });
    }

    if (path === "/api/passkeys/login/options" && req.method === "POST") {
      if (passkeys === null) return error(404, "passkeys are not configured");
      if (!sameOrigin(req)) return error(403, "cross-origin request");
      if (!passkeys.any()) return error(404, "no passkey registered");
      return json(passkeys.loginOptions(now));
    }

    if (path === "/api/passkeys/login" && req.method === "POST") {
      if (passkeys === null) return error(404, "passkeys are not configured");
      if (!sameOrigin(req)) return error(403, "cross-origin request");
      const payload = await body(req);
      const credential = typeof payload["credential"] === "object" && payload["credential"] !== null ? (payload["credential"] as Record<string, unknown>) : {};
      return ceremony(() => {
        if (!passkeys.login(payload["challengeId"], credential, now)) return error(401, "unknown passkey");
        return json({ ok: true }, { headers: { "set-cookie": auth.startSession(now) } });
      });
    }

    if (path === "/api/passkeys/register/options" && req.method === "POST") {
      if (passkeys === null) return error(404, "passkeys are not configured");
      if (!sameOrigin(req)) return error(403, "cross-origin request");
      const setup = (await body(req))["setup"];
      if (typeof setup !== "string") return error(400, "setup token required");
      const opts = passkeys.registerOptions(setup, now);
      return opts ? json(opts) : error(404, "setup link is invalid or expired");
    }

    if (path === "/api/passkeys/register" && req.method === "POST") {
      if (passkeys === null) return error(404, "passkeys are not configured");
      if (!sameOrigin(req)) return error(403, "cross-origin request");
      const payload = await body(req);
      const credential = typeof payload["credential"] === "object" && payload["credential"] !== null ? (payload["credential"] as Record<string, unknown>) : {};
      return ceremony(() => {
        if (!passkeys.register(payload["challengeId"], credential, now)) return error(404, "setup link was already used or expired");
        return json({ ok: true }, { headers: { "set-cookie": auth.startSession(now) } });
      });
    }

    // Desktop pairing endpoints (public start/poll; approval requires authenticated browser session).
    if (path === "/api/device/start" && req.method === "POST") {
      const payload = await body(req);
      const deviceName = typeof payload["deviceName"] === "string" ? payload["deviceName"] : "nanotes desktop";
      const started = auth.startPairing(deviceName, now);
      if ("limited" in started) return error(429, "too many pairing requests, try again shortly");
      const origin = requestOrigin(req, options.origin);
      return json({
        code: started.code,
        pollToken: started.pollToken,
        expiresAt: started.expiresAt,
        verificationUrl: `${origin}/#/pair/${started.code}`,
      });
    }

    if (path === "/api/device/poll" && req.method === "POST") {
      const pollToken = (await body(req))["pollToken"];
      if (typeof pollToken !== "string" || !pollToken) return error(400, "pollToken required");
      const result = auth.pollPairing(pollToken, now);
      if (result.status === "expired") return error(410, "pairing expired");
      return json(result);
    }

    // Sync protocol endpoints: require device bearer token OR browser session.
    if (path === "/api/sync/changes" && req.method === "GET") {
      if (!auth.isSyncAuthorized(req, now)) return error(401, "sync authorization required");
      const sinceRaw = url.searchParams.get("since") ?? "0";
      const since = Number.isFinite(Number(sinceRaw)) ? Math.max(0, Math.floor(Number(sinceRaw))) : 0;
      return json(notes.changesSince(since));
    }

    if (path === "/api/sync/push" && req.method === "POST") {
      if (!auth.isSyncAuthorized(req, now)) return error(401, "sync authorization required");
      const payload = await body(req);
      const opsRaw = payload["ops"];
      if (!Array.isArray(opsRaw)) return error(400, "ops array required");
      const ops: SyncPushOp[] = [];
      for (const item of opsRaw) {
        if (typeof item !== "object" || item === null) return error(400, "invalid op");
        const rec = item as Record<string, unknown>;
        if (typeof rec["id"] !== "string" || typeof rec["baseRev"] !== "number") {
          return error(400, "each op requires string id and numeric baseRev");
        }
        ops.push({
          id: rec["id"],
          baseRev: rec["baseRev"],
          ...(typeof rec["path"] === "string" ? { path: rec["path"] } : {}),
          ...(typeof rec["content"] === "string" ? { content: rec["content"] } : {}),
          ...(typeof rec["pinned"] === "boolean" ? { pinned: rec["pinned"] } : {}),
          ...(rec["deleted"] === true ? { deleted: true } : {}),
        });
      }
      return json(notes.push(ops, now));
    }

    if (path === "/api/device" && req.method === "PATCH") {
      const device = auth.deviceFromRequest(req, now);
      if (!device) return error(401, "device authorization required");
      const name = (await body(req))["name"];
      if (typeof name !== "string" || !name.trim()) return error(400, "name required");
      const updated = auth.renameDevice(device.id, name);
      if (!updated) return error(404, "device not found");
      collab.notifyDeviceRenamed(updated.id, updated.name);
      return json({ ok: true, device: updated });
    }

    // Browser-session-authenticated management & notes endpoints.
    if (!auth.isSignedIn(req, now)) return error(401, "sign in required");

    if (req.method !== "GET" && !sameOrigin(req)) return error(403, "cross-origin request");

    if (path === "/api/passkeys/setup-link" && req.method === "POST") {
      if (passkeys === null) return error(404, "passkeys are not configured");
      const { url: setupUrl, expiresAt } = passkeys.createSetupLink(now);
      return json({ url: setupUrl, expiresAt });
    }

    if (path === "/api/device/approve" && req.method === "POST") {
      const code = (await body(req))["code"];
      if (typeof code !== "string" || !code.trim()) return error(400, "code required");
      const device = auth.approvePairing(code, now);
      return device ? json({ ok: true, device }) : error(404, "pairing code is invalid or expired");
    }

    if (path === "/api/devices" && req.method === "GET") {
      return json({ devices: auth.listDevices() });
    }

    if (path === "/api/devices" && req.method === "POST") {
      const name = (await body(req))["name"];
      const created = auth.createDeviceToken(typeof name === "string" ? name : "nanotes device", now);
      return json(created, { status: 201 });
    }

    const deviceMatch = /^\/api\/devices\/([^/]+)$/.exec(path);
    if (deviceMatch && req.method === "PATCH") {
      const id = decodeURIComponent(deviceMatch[1] as string);
      const name = (await body(req))["name"];
      if (typeof name !== "string" || !name.trim()) return error(400, "name required");
      const updated = auth.renameDevice(id, name);
      if (!updated) return error(404, "device not found");
      collab.notifyDeviceRenamed(updated.id, updated.name);
      return json({ ok: true, device: updated });
    }

    if (deviceMatch && req.method === "DELETE") {
      const id = decodeURIComponent(deviceMatch[1] as string);
      const revoked = auth.revokeDevice(id);
      if (revoked) collab.disconnectDevice(id);
      return revoked ? json({ ok: true }) : error(404, "device not found");
    }

    if (path === "/api/notes" && req.method === "GET") {
      const query = url.searchParams.get("q") ?? undefined;
      return json(notes.listWithRev(query));
    }

    if (path === "/api/notes" && req.method === "POST") {
      const payload = await body(req);
      const content = typeof payload["content"] === "string" ? payload["content"] : "";
      const notePath = typeof payload["path"] === "string" ? payload["path"] : undefined;
      const pinned = payload["pinned"] === true;
      return json(notes.create({ content, path: notePath, pinned }, now), { status: 201 });
    }

    const noteMatch = /^\/api\/notes\/([^/]+)$/.exec(path);
    if (noteMatch && req.method === "GET") {
      const note = notes.get(decodeURIComponent(noteMatch[1] as string));
      return note ? json(note) : error(404, "note not found");
    }

    if (noteMatch && req.method === "PATCH") {
      const id = decodeURIComponent(noteMatch[1] as string);
      const payload = await body(req);
      const updated = notes.update(
        id,
        {
          ...(typeof payload["content"] === "string" ? { content: payload["content"] } : {}),
          ...(typeof payload["path"] === "string" ? { path: payload["path"] } : {}),
          ...(typeof payload["pinned"] === "boolean" ? { pinned: payload["pinned"] } : {}),
        },
        now,
      );
      return updated ? json(updated) : error(404, "note not found");
    }

    if (noteMatch && req.method === "DELETE") {
      const removed = notes.remove(decodeURIComponent(noteMatch[1] as string), now);
      return removed ? json({ ok: true }) : error(404, "note not found");
    }

    return error(404, "not found");
  }

  async function fetch(req: Request, server?: Server<WsClientData>): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/api/ws") {
      if (!server) return error(426, "websocket upgrade required");
      const now = clock();
      const device = auth.deviceFromRequest(req, now);
      let authed = false;
      let deviceName = "Web";
      if (device) {
        authed = true;
        deviceName = device.name;
      } else if (auth.isSignedIn(req, now)) {
        if (!sameOrigin(req)) return error(403, "cross-origin websocket");
        authed = true;
        deviceName = "Web";
      }
      const upgraded = server.upgrade(req, {
        data: collab.createClientData(authed, deviceName, device ? device.id : null),
      });
      return upgraded ? (undefined as unknown as Response) : error(400, "websocket upgrade failed");
    }
    if (url.pathname === "/mcp") {
      if (!auth.mcpEnabled()) return error(404, "not found");
      if (!auth.hasMcpToken(req)) return error(401, "bearer token required");
      return handleMcp(req, notes, passkeys, clock);
    }
    if (url.pathname.startsWith("/api/")) return api(req, url);
    if (webDistDir && url.pathname.startsWith("/assets/")) {
      const fileName = url.pathname.slice("/assets/".length);
      if (/^[A-Za-z0-9._-]+\.(js|css)$/.test(fileName) && !fileName.includes("..")) {
        const fullPath = join(webDistDir, fileName);
        if (existsSync(fullPath)) {
          const contentType = fileName.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
          const isEntry = fileName === "web-app.js" || fileName === "web-app.css";
          const cacheControl = isEntry ? "no-cache" : "public, max-age=31536000, immutable";
          return new Response(Bun.file(fullPath), {
            headers: { "content-type": contentType, "cache-control": cacheControl },
          });
        }
      }
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const hasLiveWeb = Boolean(webDistDir && existsSync(join(webDistDir, "web-app.js")));
      return new Response(hasLiveWeb ? LIVE_WEB_SHELL_HTML : WEB_UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    return error(404, "not found");
  }

  const websocket: WebSocketHandler<WsClientData> = {
    open: (ws) => collab.onOpen(ws),
    message: (ws, message) => collab.onMessage(ws, message),
    close: (ws) => collab.onClose(ws),
  };

  return {
    fetch,
    websocket,
    close: () => {
      collab.close();
      database.close();
    },
    notes,
    auth,
    passkeys,
    collab,
  };
}
