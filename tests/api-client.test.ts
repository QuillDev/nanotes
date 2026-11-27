import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp } from "../server/app.ts";
import type { WsClientData } from "../server/collab.ts";
import { apiClient, failure, segment } from "../src/lib/api.ts";

/** A fetch that adds one header, the way a browser adds its cookie or the desktop its token. */
const withHeader = (name: string, value: () => string): typeof fetch =>
  Object.assign(
    (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (value()) headers.set(name, value());
      return fetch(input, { ...init, headers });
    },
    { preconnect: fetch.preconnect },
  );

// The web app's typed client against the real server over HTTP.
describe("typed API client", () => {
  const dir = mkdtempSync(join(tmpdir(), "nanotes-eden-"));
  let app: Awaited<ReturnType<typeof createApp>>;
  let server: Server<WsClientData>;
  let origin = "";
  let cookie = "";

  beforeAll(async () => {
    app = await createApp({
      databasePath: join(dir, "db.sqlite"),
      passwordHash: await Bun.password.hash("pw"),
      mcpToken: null,
      secureCookies: false,
      origin: null,
      webDistDir: null,
    });
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req, srv) => app.fetch(req, srv), websocket: app.websocket });
    origin = server.url.origin;
  });

  afterAll(async () => {
    server.stop(true);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("signs in, manages notes and devices, and syncs with responses typed by the server", async () => {
    const api = apiClient(origin, withHeader("cookie", () => cookie));

    const signedOut = await api.notes.get();
    expect(signedOut.status).toBe(401);
    expect(failure(signedOut.error, "")).toBe("sign in required");

    const wrong = await api.login.post({ password: "nope" });
    expect(wrong.status).toBe(401);
    expect(failure(wrong.error, "")).toBe("wrong password");

    const login = await api.login.post({ password: "pw" });
    expect(login.data).toEqual({ ok: true });
    cookie = (login.response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const methods = await api.login.methods.get();
    expect(methods.data).toEqual({ passkey: false, passkeyConfigured: false, password: true });

    const created = await api.notes.post({ content: "# Groceries\n\neggs", path: "My list.md" });
    expect(created.status).toBe(201);
    const note = created.data!;
    expect(note.title).toBe("Groceries");

    const byPath = await api.notes({ id: segment("My list.md") }).get();
    expect(byPath.data?.id).toBe(note.id);

    const pinned = await api.notes({ id: segment(note.id) }).patch({ pinned: true });
    expect(pinned.data?.pinned).toBe(true);

    const listed = await api.notes.get({ query: { q: "groc" } });
    expect(listed.data?.notes.map((item) => [item.title, item.pinned])).toEqual([["Groceries", true]]);

    // @ts-expect-error content must be a string; the server rejects it too.
    const badBody = await api.notes.post({ content: 5 });
    expect(badBody.status).toBe(400);

    const token = await api.devices.post({ name: "Laptop" });
    expect(token.status).toBe(201);
    const deviceToken = token.data!.token;

    const renamed = await api.devices({ id: segment(token.data!.device.id) }).patch({ name: "Work laptop" });
    expect(renamed.data?.device.name).toBe("Work laptop");

    const bearer = apiClient(origin, withHeader("authorization", () => `Bearer ${deviceToken}`));
    const changes = await bearer.sync.changes.get({ query: { since: "0" } });
    expect(changes.data?.changes.map((item) => item.path)).toEqual(["My list.md"]);
    const pushed = await bearer.sync.push.post({ ops: [{ id: "laptop-1", baseRev: 0, path: "From laptop.md", content: "# From laptop" }] });
    expect(pushed.data?.results[0]?.status).toBe("ok");

    const removed = await api.notes({ id: segment(note.id) }).delete();
    expect(removed.data).toEqual({ ok: true });
    const missing = await api.notes({ id: segment(note.id) }).get();
    expect(missing.status).toBe(404);
    expect(failure(missing.error, "")).toBe("note not found");

    const revoked = await api.devices({ id: segment(token.data!.device.id) }).delete();
    expect(revoked.data).toEqual({ ok: true });
    expect((await bearer.sync.changes.get({ query: {} })).status).toBe(401);
  });
});

describe("routing with short Host headers", () => {
  test("a short host or a prefixed path never reaches signed-in routes without a session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nanotes-host-"));
    const app = await createApp({ databasePath: join(dir, "db.sqlite"), passwordHash: null, mcpToken: null, secureCookies: false, origin: null, webDistDir: null });
    try {
      await app.notes.create({ content: "# Secret\n\nhidden" }, Date.now());
      const call = (url: string, host: string) => app.fetch(new Request(url, { headers: { host } }));
      const blocked = await Promise.all(
        [
          ["http://a/api/notes", "a"],
          ["http://a/xx/api/notes", "a"],
          ["http://a/api/api/notes", "a"],
          ["http://a:1/api/notes", "a:1"],
          ["http://localhost/xx/api/notes", "localhost"],
        ].map(async ([url, host]) => {
          const res = await call(url as string, host as string);
          return { status: res.status, text: await res.text() };
        }),
      );
      for (const { status, text } of blocked) {
        expect([401, 404]).toContain(status);
        expect(text).not.toContain("Secret");
      }
      // The same API answers the same way whatever the host's length.
      const methods = await Promise.all(
        ["a", "localhost", "notes.example.test"].map(async (host) => {
          const res = await call(`http://${host}/api/login/methods`, host);
          return { status: res.status, body: await res.json() };
        }),
      );
      for (const { status, body } of methods) {
        expect(status).toBe(200);
        expect(body).toEqual({ passkey: false, passkeyConfigured: false, password: false });
      }
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
