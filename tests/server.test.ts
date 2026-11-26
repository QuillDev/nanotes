import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
      const req = (path: string, init: RequestInit = {}, cookie = "") =>
        app.fetch(
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
        );

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

    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
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
});
