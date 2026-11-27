import type { Server, WebSocketHandler } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildApi, sameOrigin } from "./api.ts";
import { Auth } from "./auth.ts";
import { CollabHub, type WsClientData } from "./collab.ts";
import { openDatabase } from "./database.ts";
import { handleMcp } from "./mcp.ts";
import { NotesStore } from "./notes.ts";
import { Passkeys } from "./passkeys.ts";
import { WEB_UI_HTML } from "./ui.ts";

export type { App } from "./api.ts";

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

  const api = buildApi({ auth, notes, passkeys, collab, clock, origin: options.origin });

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
    if (url.pathname.startsWith("/api/")) {
      // Elysia finds the path by skipping a fixed-length scheme and host, so give it a URL with a
      // normal host; checks read the real Host header, which stays as sent.
      return api.handle(new Request(new URL(`${url.pathname}${url.search}`, "http://localhost"), req));
    }
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
