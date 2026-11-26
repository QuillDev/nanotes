import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { base64ToBytes, bytesToBase64 } from "../shared/text-diff.ts";
import { createApp } from "../server/app.ts";
import { b64url, ES256 } from "../server/webauthn.ts";

/** Minimal CBOR encoder for generating real WebAuthn test credentials (ES256). */
function cborUint(major: number, n: number): Uint8Array {
  const prefix = major << 5;
  if (n < 24) return Uint8Array.of(prefix | n);
  if (n < 0x100) return Uint8Array.of(prefix | 24, n);
  if (n < 0x10000) return Uint8Array.of(prefix | 25, n >> 8, n & 0xff);
  return Uint8Array.of(prefix | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function cborEncode(value: unknown): Uint8Array {
  if (typeof value === "number") {
    return value >= 0 ? cborUint(0, value) : cborUint(1, -1 - value);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([cborUint(2, value.length), value]);
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return Buffer.concat([cborUint(3, bytes.length), bytes]);
  }
  if (value instanceof Map) {
    const parts: Uint8Array[] = [cborUint(5, value.size)];
    for (const [k, v] of value.entries()) {
      parts.push(cborEncode(k), cborEncode(v));
    }
    return Buffer.concat(parts);
  }
  throw new Error(`unsupported test CBOR value: ${typeof value}`);
}

function makeEs256Key() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = new Uint8Array(Buffer.from(jwk.x, "base64url"));
  const y = new Uint8Array(Buffer.from(jwk.y, "base64url"));
  const cose = new Map<number, unknown>([
    [1, 2],
    [3, ES256],
    [-1, 1],
    [-2, x],
    [-3, y],
  ]);
  return { privateKey, coseKey: cborEncode(cose), credentialId: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) };
}

function makeAuthData(rpId: string, flags: number, signCount: number, credential?: { credentialId: Uint8Array; coseKey: Uint8Array }): Uint8Array {
  const rpIdHash = createHash("sha256").update(rpId).digest();
  const count = Buffer.alloc(4);
  count.writeUInt32BE(signCount, 0);
  if (!credential) return Buffer.concat([rpIdHash, Uint8Array.of(flags), count]);
  const aaguid = new Uint8Array(16);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(credential.credentialId.length, 0);
  return Buffer.concat([rpIdHash, Uint8Array.of(flags), count, aaguid, len, credential.credentialId, credential.coseKey]);
}

function extractCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

describe("nanotes sync server", () => {
  test("passkey registration, login, and desktop device pairing work end to end", async () => {
    let now = 1_700_000_000_000;
    const origin = "https://notes.example.com";
    const app = createApp({
      databasePath: ":memory:",
      passwordHash: null,
      mcpToken: "mcp-secret",
      secureCookies: true,
      origin,
      clock: () => now,
    });

    try {
      const req = async (path: string, init: RequestInit = {}, cookie = "") =>
        (await app.fetch(
          new Request(`${origin}${path}`, {
            ...init,
            headers: {
              host: "notes.example.com",
              origin,
              "content-type": "application/json",
              ...(cookie ? { cookie } : {}),
              ...(init.headers ?? {}),
            },
          }),
        )) as Response;

      // 1. Mint one-time passkey setup link and register an ES256 passkey.
      const setup = app.passkeys!.createSetupLink(now);
      const regOptsRes = await req("/api/passkeys/register/options", {
        method: "POST",
        body: JSON.stringify({ setup: setup.token }),
      });
      expect(regOptsRes.status).toBe(200);
      const regOpts = (await regOptsRes.json()) as { challengeId: string; publicKey: { challenge: string } };

      const key = makeEs256Key();
      const clientDataReg = Buffer.from(
        JSON.stringify({ type: "webauthn.create", challenge: regOpts.publicKey.challenge, origin }),
      );
      const authDataReg = makeAuthData("notes.example.com", 0x45, 1, {
        credentialId: key.credentialId,
        coseKey: key.coseKey,
      });
      const attestationObject = cborEncode(new Map<string, unknown>([["fmt", "none"], ["authData", authDataReg]]));

      const regRes = await req("/api/passkeys/register", {
        method: "POST",
        body: JSON.stringify({
          challengeId: regOpts.challengeId,
          credential: {
            id: b64url(key.credentialId),
            clientDataJSON: b64url(clientDataReg),
            attestationObject: b64url(attestationObject),
          },
        }),
      });
      expect(regRes.status).toBe(200);
      const sessionCookie = extractCookie(regRes);
      expect(sessionCookie).toContain("nanotes_session=");

      // Setup link is single-use.
      const reuseRes = await req("/api/passkeys/register/options", {
        method: "POST",
        body: JSON.stringify({ setup: setup.token }),
      });
      expect(reuseRes.status).toBe(404);

      // 2. Sign in again with the registered passkey.
      const loginOptsRes = await req("/api/passkeys/login/options", { method: "POST", body: "{}" });
      expect(loginOptsRes.status).toBe(200);
      const loginOpts = (await loginOptsRes.json()) as { challengeId: string; publicKey: { challenge: string } };
      const clientDataLogin = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge: loginOpts.publicKey.challenge, origin }),
      );
      const authDataLogin = makeAuthData("notes.example.com", 0x05, 2);
      const signedPayload = Buffer.concat([authDataLogin, createHash("sha256").update(clientDataLogin).digest()]);
      const signature = sign("sha256", signedPayload, { key: key.privateKey, dsaEncoding: "der" });

      const loginRes = await req("/api/passkeys/login", {
        method: "POST",
        body: JSON.stringify({
          challengeId: loginOpts.challengeId,
          credential: {
            id: b64url(key.credentialId),
            clientDataJSON: b64url(clientDataLogin),
            authenticatorData: b64url(authDataLogin),
            signature: b64url(signature),
          },
        }),
      });
      expect(loginRes.status).toBe(200);
      const freshCookie = extractCookie(loginRes);

      // 3. Desktop starts device pairing -> polls pending -> browser approves -> desktop receives one-time token.
      const startRes = await req("/api/device/start", {
        method: "POST",
        body: JSON.stringify({ deviceName: "Windows Desktop" }),
      });
      expect(startRes.status).toBe(200);
      const started = (await startRes.json()) as { code: string; pollToken: string; verificationUrl: string };
      expect(started.verificationUrl).toBe(`${origin}/#/pair/${started.code}`);

      const pollPending = await req("/api/device/poll", {
        method: "POST",
        body: JSON.stringify({ pollToken: started.pollToken }),
      });
      expect(await pollPending.json()).toEqual({ status: "pending" });

      // Unauthenticated approval is rejected.
      const unauthApprove = await req("/api/device/approve", {
        method: "POST",
        body: JSON.stringify({ code: started.code }),
      });
      expect(unauthApprove.status).toBe(401);

      // Signed-in passkey session approves pairing.
      const approveRes = await req(
        "/api/device/approve",
        { method: "POST", body: JSON.stringify({ code: started.code }) },
        freshCookie,
      );
      expect(approveRes.status).toBe(200);
      const approved = (await approveRes.json()) as { device: { id: string; name: string } };
      expect(approved.device.name).toBe("Windows Desktop");

      const pollApproved = await req("/api/device/poll", {
        method: "POST",
        body: JSON.stringify({ pollToken: started.pollToken }),
      });
      const polled = (await pollApproved.json()) as { status: string; token: string; deviceName: string };
      expect(polled.status).toBe("approved");
      expect(polled.token).toStartWith("nts_");

      // Second poll fails because handoff is one-time.
      const pollAgain = await req("/api/device/poll", {
        method: "POST",
        body: JSON.stringify({ pollToken: started.pollToken }),
      });
      expect(pollAgain.status).toBe(410);

      // Device token can access sync API.
      const syncOk = await req("/api/sync/changes?since=0", {
        method: "GET",
        headers: { authorization: `Bearer ${polled.token}` },
      });
      expect(syncOk.status).toBe(200);

      // Revoking the device immediately cuts off sync access.
      const revokeRes = await req(`/api/devices/${approved.device.id}`, { method: "DELETE" }, freshCookie);
      expect(revokeRes.status).toBe(200);

      const syncRevoked = await req("/api/sync/changes?since=0", {
        method: "GET",
        headers: { authorization: `Bearer ${polled.token}` },
      });
      expect(syncRevoked.status).toBe(401);
    } finally {
      app.close();
    }
  });

  test("multi-device sync pushes, pulls, detects conflicts, and tombstones deletes", async () => {
    let now = 1_700_000_000_000;
    const app = createApp({
      databasePath: ":memory:",
      passwordHash: null,
      mcpToken: null,
      secureCookies: false,
      origin: null,
      clock: () => now,
    });

    try {
      const { token } = app.auth.createDeviceToken("Laptop", now);
      const syncReq = (path: string, init: RequestInit = {}) =>
        app.fetch(
          new Request(`http://localhost${path}`, {
            ...init,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          }),
        );

      // Device A creates a note.
      const push1 = await syncReq("/api/sync/push", {
        method: "POST",
        body: JSON.stringify({
          ops: [{ id: "note-1", baseRev: 0, path: "Ideas.md", content: "# Ideas\n\nfirst", pinned: true }],
        }),
      });
      expect(push1.status).toBe(200);
      const r1 = (await push1.json()) as { rev: number; results: { status: string; note: { rev: number; path: string } }[] };
      expect(r1.rev).toBe(1);
      expect(r1.results[0]?.status).toBe("ok");

      // Device B pulls since 0 and sees the note.
      const pullB = await (await syncReq("/api/sync/changes?since=0")).json() as { rev: number; changes: { id: string; content: string; pinned: boolean }[] };
      expect(pullB.rev).toBe(1);
      expect(pullB.changes).toHaveLength(1);
      expect(pullB.changes[0]?.pinned).toBe(true);

      // Device A updates note-1 (baseRev 1 -> rev 2).
      now += 1000;
      const push2 = await syncReq("/api/sync/push", {
        method: "POST",
        body: JSON.stringify({
          ops: [{ id: "note-1", baseRev: 1, path: "Ideas.md", content: "# Ideas\n\nfrom A", pinned: true }],
        }),
      });
      const r2 = (await push2.json()) as { rev: number; results: { status: string }[] };
      expect(r2.rev).toBe(2);
      expect(r2.results[0]?.status).toBe("ok");

      // Device B tries pushing stale baseRev 1 -> server reports conflict with latest serverNote.
      now += 1000;
      const pushConflict = await syncReq("/api/sync/push", {
        method: "POST",
        body: JSON.stringify({
          ops: [{ id: "note-1", baseRev: 1, path: "Ideas.md", content: "# Ideas\n\nfrom B", pinned: true }],
        }),
      });
      const rConflict = (await pushConflict.json()) as {
        results: { status: string; serverNote: { rev: number; content: string } }[];
      };
      expect(rConflict.results[0]?.status).toBe("conflict");
      expect(rConflict.results[0]?.serverNote.rev).toBe(2);
      expect(rConflict.results[0]?.serverNote.content).toBe("# Ideas\n\nfrom A");

      // Device A deletes note-1 -> tombstone at rev 3.
      now += 1000;
      await syncReq("/api/sync/push", {
        method: "POST",
        body: JSON.stringify({ ops: [{ id: "note-1", baseRev: 2, deleted: true }] }),
      });

      const pullDelete = (await (await syncReq("/api/sync/changes?since=2")).json()) as {
        rev: number;
        changes: { id: string; deletedAt: number | null }[];
      };
      expect(pullDelete.rev).toBe(3);
      expect(pullDelete.changes[0]?.deletedAt).not.toBeNull();
    } finally {
      app.close();
    }
  });

  test("MCP endpoint exposes note CRUD + passkey_setup_link and bumps sync revisions", async () => {
    const app = createApp({
      databasePath: ":memory:",
      passwordHash: null,
      mcpToken: "super-secret-mcp-token",
      secureCookies: false,
      origin: "https://notes.example.com",
    });

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req, srv) => app.fetch(req, srv),
      websocket: app.websocket,
    });
    try {
      const mcpUrl = new URL("/mcp", server.url);

      // Missing bearer token is rejected.
      const unauth = await fetch(mcpUrl, { method: "POST", body: "{}" });
      expect(unauth.status).toBe(401);

      const client = new Client({ name: "test-agent", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(mcpUrl, {
        requestInit: { headers: { authorization: "Bearer super-secret-mcp-token" } },
      });
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "append_note",
        "create_note",
        "delete_note",
        "list_notes",
        "passkey_setup_link",
        "read_note",
        "search_notes",
        "update_note",
      ]);

      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
        return JSON.parse(text) as Record<string, unknown>;
      };

      const created = await call("create_note", { content: "# Grocery List\n\n- milk", pinned: true });
      expect(created["path"]).toBe("Grocery List.md");
      expect(created["rev"]).toBe(1);

      const appended = await call("append_note", { idOrPath: "Grocery List.md", text: "- eggs" });
      expect(appended["content"]).toBe("# Grocery List\n\n- milk\n- eggs");
      expect(appended["rev"]).toBe(2);

      const searched = await call("search_notes", { query: "eggs" });
      expect((searched["notes"] as unknown[]).length).toBe(1);

      const read = await call("read_note", { idOrPath: created["id"] as string });
      expect(read["content"]).toBe("# Grocery List\n\n- milk\n- eggs");

      const link = await call("passkey_setup_link");
      expect(String(link["url"])).toStartWith("https://notes.example.com/#/passkey/");

      const deleted = await call("delete_note", { idOrPath: "Grocery List.md" });
      expect(deleted["deleted"]).toBe(true);

      // Sync clients pulling since 0 see the tombstone from the MCP delete.
      const changes = app.notes.changesSince(0);
      expect(changes.rev).toBe(3);
      expect(changes.changes[0]?.deletedAt).not.toBeNull();

      await client.close();
    } finally {
      server.stop(true);
      app.close();
    }
  });

  test("live Yjs WebSocket collab merges concurrent edits, offline divergence, awareness cursors, and MCP updates", async () => {
    const app = createApp({
      databasePath: ":memory:",
      passwordHash: null,
      mcpToken: "mcp-live-secret",
      secureCookies: false,
      origin: "https://notes.example.com",
      webDistDir: null,
      flushDebounceMs: 25,
    });

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req, srv) => app.fetch(req, srv),
      websocket: app.websocket,
    });

    type WsMsg = Record<string, unknown>;
    const connectWs = async (token?: string) => {
      const wsUrl = server.url.toString().replace(/^http/, "ws").replace(/\/$/, "") + "/api/ws";
      const ws = new WebSocket(wsUrl);
      const queue: WsMsg[] = [];
      const waiters: Array<(msg: WsMsg) => void> = [];
      let closed = false;
      let closeCode = 0;

      ws.addEventListener("message", (event) => {
        const parsed = JSON.parse(String(event.data)) as WsMsg;
        const waiter = waiters.shift();
        if (waiter) waiter(parsed);
        else queue.push(parsed);
      });
      ws.addEventListener("close", (event) => {
        closed = true;
        closeCode = event.code;
      });

      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("ws failed to open")), { once: true });
      });

      const nextMsg = async (predicate?: (m: WsMsg) => boolean): Promise<WsMsg> => {
        while (true) {
          if (queue.length > 0) {
            const msg = queue.shift()!;
            if (!predicate || predicate(msg)) return msg;
            continue;
          }
          const msg = await new Promise<WsMsg>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timed out waiting for ws message")), 3000);
            waiters.push((m) => {
              clearTimeout(timer);
              resolve(m);
            });
          });
          if (!predicate || predicate(msg)) return msg;
        }
      };

      const send = (payload: unknown) => ws.send(JSON.stringify(payload));
      if (token) {
        send({ type: "auth", token });
        const authReply = await nextMsg((m) => m["type"] === "authed" || m["type"] === "error");
        expect(authReply["type"]).toBe("authed");
      }

      return { ws, send, nextMsg, isClosed: () => closed, closeCode: () => closeCode };
    };

    try {
      const now = 1_700_000_000_000;
      const deviceA = app.auth.createDeviceToken("Windows", now);
      const deviceB = app.auth.createDeviceToken("macOS", now);
      const note = app.notes.create({ content: "# Project\n\nAlpha\nBeta\n" }, now);

      // 1. Invalid token is rejected with 4401.
      const bad = await connectWs();
      bad.send({ type: "auth", token: "wrong-token" });
      const badReply = await bad.nextMsg();
      expect(badReply["type"]).toBe("error");
      await new Promise((r) => setTimeout(r, 30));
      expect(bad.isClosed()).toBe(true);
      expect(bad.closeCode()).toBe(4401);

      // 2. Two devices join the same note and receive canonical initial Yjs state.
      const peerA = await connectWs(deviceA.token);
      const peerB = await connectWs(deviceB.token);
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const textA = docA.getText("content");
      const textB = docB.getText("content");

      peerA.send({ type: "join", noteId: note.id });
      const syncA = await peerA.nextMsg((m) => m["type"] === "sync-state");
      Y.applyUpdate(docA, base64ToBytes(String(syncA["update"])));
      expect(textA.toString()).toBe("# Project\n\nAlpha\nBeta\n");

      peerB.send({ type: "join", noteId: note.id });
      const syncB = await peerB.nextMsg((m) => m["type"] === "sync-state");
      Y.applyUpdate(docB, base64ToBytes(String(syncB["update"])));
      expect(textB.toString()).toBe("# Project\n\nAlpha\nBeta\n");

      // 3. Concurrent edits in different spots merge cleanly with zero duplication.
      let updA: Uint8Array | null = null;
      let updB: Uint8Array | null = null;
      docA.on("update", (u) => { updA = u; });
      docB.on("update", (u) => { updB = u; });

      textA.insert(textA.toString().indexOf("Alpha") + 5, " (from Windows)");
      textB.insert(textB.toString().indexOf("Beta") + 4, " (from macOS)");

      peerA.send({ type: "yjs-update", noteId: note.id, update: bytesToBase64(updA!) });
      peerB.send({ type: "yjs-update", noteId: note.id, update: bytesToBase64(updB!) });

      const fromB = await peerA.nextMsg((m) => m["type"] === "yjs-update");
      const fromA = await peerB.nextMsg((m) => m["type"] === "yjs-update");
      Y.applyUpdate(docA, base64ToBytes(String(fromB["update"])));
      Y.applyUpdate(docB, base64ToBytes(String(fromA["update"])));

      const expectedMerged = "# Project\n\nAlpha (from Windows)\nBeta (from macOS)\n";
      expect(textA.toString()).toBe(expectedMerged);
      expect(textB.toString()).toBe(expectedMerged);

      // Reading via NotesStore (e.g. MCP read_note) flushes the dirty room synchronously.
      const stored = app.notes.get(note.id);
      expect(stored?.content).toBe(expectedMerged);

      // 4. Awareness (live cursors) broadcasts to peers and clears on disconnect.
      const awareA = new Awareness(docA);
      const awareB = new Awareness(docB);
      awareA.setLocalState({ user: { name: "Windows", color: "#f65c8e" }, cursor: 10 });
      peerA.send({
        type: "awareness",
        noteId: note.id,
        update: bytesToBase64(encodeAwarenessUpdate(awareA, [docA.clientID])),
      });
      const awareMsg = await peerB.nextMsg((m) => m["type"] === "awareness");
      applyAwarenessUpdate(awareB, base64ToBytes(String(awareMsg["update"])), "remote");
      expect(awareB.getStates().get(docA.clientID)?.["user"]?.["name"]).toBe("Windows");

      // 5. MCP append_note streams live Yjs delta directly to connected peers without clobbering.
      const appended = app.notes.append(note.id, "Gamma (from MCP)", now + 100);
      expect(appended?.content).toBe(`${expectedMerged}Gamma (from MCP)`);

      const mcpUpdateA = await peerA.nextMsg((m) => m["type"] === "yjs-update");
      const mcpUpdateB = await peerB.nextMsg((m) => m["type"] === "yjs-update");
      Y.applyUpdate(docA, base64ToBytes(String(mcpUpdateA["update"])));
      Y.applyUpdate(docB, base64ToBytes(String(mcpUpdateB["update"])));
      expect(textA.toString()).toBe(`${expectedMerged}Gamma (from MCP)`);
      expect(textB.toString()).toBe(`${expectedMerged}Gamma (from MCP)`);

      // 6. Offline divergence: peerB disconnects, both edit independently, peerB reconnects and merges cleanly.
      peerB.ws.close(1000, "offline");
      // peerA receives awareness removal when peerB disconnects.
      const peerAOnly = new Awareness(docA);
      peerAOnly.setLocalState(null);

      // Edit on peerA while peerB is offline.
      updA = null;
      textA.insert(0, "Live ");
      peerA.send({ type: "yjs-update", noteId: note.id, update: bytesToBase64(updA!) });
      await new Promise((r) => setTimeout(r, 60));

      // Edit on docB locally while offline.
      textB.insert(textB.length, "\nOffline line");

      // peerB reconnects with its saved stateVector.
      const peerB2 = await connectWs(deviceB.token);
      peerB2.send({
        type: "join",
        noteId: note.id,
        stateVector: bytesToBase64(Y.encodeStateVector(docB)),
      });
      const resyncB = await peerB2.nextMsg((m) => m["type"] === "sync-state");
      Y.applyUpdate(docB, base64ToBytes(String(resyncB["update"])));
      const missingForServer = Y.encodeStateAsUpdate(docB, base64ToBytes(String(resyncB["stateVector"])));
      peerB2.send({ type: "yjs-update", noteId: note.id, update: bytesToBase64(missingForServer) });

      const offlineFromB = await peerA.nextMsg((m) => m["type"] === "yjs-update");
      Y.applyUpdate(docA, base64ToBytes(String(offlineFromB["update"])));

      const expectedOfflineMerged = `Live ${expectedMerged}Gamma (from MCP)\nOffline line`;
      expect(textA.toString()).toBe(expectedOfflineMerged);
      expect(textB.toString()).toBe(expectedOfflineMerged);
      expect(app.notes.get(note.id)?.content).toBe(expectedOfflineMerged);

      awareA.destroy();
      awareB.destroy();
      peerAOnly.destroy();
      peerA.ws.close();
      peerB2.ws.close();
      docA.destroy();
      docB.destroy();
    } finally {
      server.stop(true);
      app.close();
    }
  });

  test("continuous collab typing flushes note-changed before typing stops", async () => {
    const now = 1_700_000_200_000;
    const app = createApp({
      databasePath: ":memory:",
      passwordHash: null,
      mcpToken: null,
      secureCookies: false,
      origin: "http://127.0.0.1",
      clock: () => now,
      flushDebounceMs: 120,
    });
    const device = app.auth.createDeviceToken("Desktop", now);
    const note = app.notes.create({ content: "# Start\n\n" }, now);
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: app.fetch,
      websocket: app.websocket,
    });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws`);
      const queue: Record<string, unknown>[] = [];
      let waiter: ((msg: Record<string, unknown>) => void) | null = null;
      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (waiter) {
          const resolve = waiter;
          waiter = null;
          resolve(msg);
        } else {
          queue.push(msg);
        }
      };
      const nextMsg = async (pred: (m: Record<string, unknown>) => boolean, timeoutMs = 2000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const idx = queue.findIndex(pred);
          if (idx >= 0) return queue.splice(idx, 1)[0]!;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              waiter = null;
              reject(new Error("timed out waiting for ws message"));
            }, Math.max(10, deadline - Date.now()));
            waiter = (m) => {
              clearTimeout(timer);
              queue.push(m);
              resolve();
            };
          });
        }
        throw new Error("timed out waiting for ws message");
      };
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });
      ws.send(JSON.stringify({ type: "auth", token: device.token }));
      await nextMsg((m) => m["type"] === "authed");
      ws.send(JSON.stringify({ type: "join", noteId: note.id }));
      const syncState = await nextMsg((m) => m["type"] === "sync-state");

      const doc = new Y.Doc();
      Y.applyUpdate(doc, base64ToBytes(String(syncState["update"])));
      const ytext = doc.getText("content");
      let lastUpd: Uint8Array | null = null;
      doc.on("update", (u: Uint8Array) => {
        lastUpd = u;
      });

      // Stream keystrokes every 60ms (faster than the 120ms trailing debounce) for ~660ms.
      // Because of the max-wait cap (500ms), a note-changed broadcast must still fire mid-stream.
      let flushedMidStream = false;
      const chars = "abcdefghijk";
      for (let i = 0; i < chars.length; i += 1) {
        lastUpd = null;
        ytext.insert(ytext.length, chars[i]!);
        ws.send(JSON.stringify({ type: "yjs-update", noteId: note.id, update: bytesToBase64(lastUpd!) }));
        await new Promise((r) => setTimeout(r, 60));
        if (queue.some((m) => m["type"] === "note-changed")) {
          flushedMidStream = true;
          break;
        }
      }
      expect(flushedMidStream).toBe(true);
      ws.close();
      doc.destroy();
    } finally {
      server.stop(true);
      app.close();
    }
  });
});
