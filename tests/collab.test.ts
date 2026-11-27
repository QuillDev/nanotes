import { describe, expect, test } from "bun:test";
import { createApp } from "../server/app.ts";
import { CollabClient } from "../src/collab.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(20);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

interface TestHarness {
  baseUrl: string;
  cookie: string;
  createDeviceToken: (name: string) => Promise<string>;
  createNote: (path: string, content: string) => Promise<{ id: string }>;
  deleteNote: (id: string) => Promise<void>;
  getNoteContent: (id: string) => Promise<string>;
  close: () => void;
}

async function startHarness(): Promise<TestHarness> {
  const passwordHash = await Bun.password.hash("test-secret");
  const app = createApp({
    databasePath: ":memory:",
    passwordHash,
    mcpToken: "mcp-secret",
    secureCookies: false,
    origin: "http://127.0.0.1",
    flushDebounceMs: 25,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
    websocket: app.websocket,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-secret" }),
  });
  expect(loginRes.status).toBe(200);
  const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toContain("nanotes_session=");

  return {
    baseUrl,
    cookie,
    async createDeviceToken(name: string) {
      const res = await fetch(`${baseUrl}/api/devices`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name }),
      });
      expect(res.status).toBe(201);
      const data = (await res.json()) as { token: string };
      return data.token;
    },
    async createNote(path: string, content: string) {
      const res = await fetch(`${baseUrl}/api/notes`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ path, content }),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string };
    },
    async deleteNote(id: string) {
      const res = await fetch(`${baseUrl}/api/notes/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(res.status).toBe(200);
    },
    async getNoteContent(id: string) {
      const res = await fetch(`${baseUrl}/api/notes/${encodeURIComponent(id)}`, {
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { content: string };
      return data.content;
    },
    close() {
      server.stop(true);
      app.close();
    },
  };
}

function forceDropSocket(client: CollabClient): void {
  const ws = (client as unknown as { ws: WebSocket | null }).ws;
  if (!ws) throw new Error("Expected active WebSocket to drop");
  ws.close(4000, "simulated network drop");
}

describe("collab client reconnect and presence", () => {
  test("reconnecting peer restores its cursor presence to other peers without moving", async () => {
    const harness = await startHarness();
    const clients: CollabClient[] = [];
    try {
      const [tokenA, tokenB] = await Promise.all([
        harness.createDeviceToken("Laptop A"),
        harness.createDeviceToken("Desktop B"),
      ]);
      const note = await harness.createNote("presence.md", "hello");

      const clientA = new CollabClient({ serverUrl: harness.baseUrl, token: tokenA });
      const clientB = new CollabClient({ serverUrl: harness.baseUrl, token: tokenB });
      clients.push(clientA, clientB);

      let readyA = false;
      let readyB = false;
      const sessA = clientA.openNote(note.id, { peerName: "Laptop A", onReady: () => { readyA = true; } });
      const sessB = clientB.openNote(note.id, { peerName: "Desktop B", onReady: () => { readyB = true; } });

      await waitUntil(
        () =>
          readyA &&
          readyB &&
          sessB.awareness.getStates().has(sessA.doc.clientID) &&
          sessA.awareness.getStates().has(sessB.doc.clientID),
        "initial mutual presence",
      );

      forceDropSocket(clientA);
      await waitUntil(() => !sessB.awareness.getStates().has(sessA.doc.clientID), "peer B sees peer A leave");

      await waitUntil(
        () => clientA.status === "connected" && sessB.awareness.getStates().has(sessA.doc.clientID),
        "peer B sees peer A return after reconnect",
      );

      const restoredUser = sessB.awareness.getStates().get(sessA.doc.clientID)?.["user"] as
        | { name?: string }
        | undefined;
      expect(restoredUser?.name).toBe("Laptop A");
    } finally {
      for (const c of clients) c.close();
      harness.close();
    }
  });

  test("disconnecting clears remote cursors and reconnecting restores only peers still in the room", async () => {
    const harness = await startHarness();
    const clients: CollabClient[] = [];
    try {
      const [tokenA, tokenB, tokenC] = await Promise.all([
        harness.createDeviceToken("Peer A"),
        harness.createDeviceToken("Peer B"),
        harness.createDeviceToken("Peer C"),
      ]);
      const note = await harness.createNote("ghosts.md", "shared note");

      const clientA = new CollabClient({ serverUrl: harness.baseUrl, token: tokenA });
      const clientB = new CollabClient({ serverUrl: harness.baseUrl, token: tokenB });
      const clientC = new CollabClient({ serverUrl: harness.baseUrl, token: tokenC });
      clients.push(clientA, clientB, clientC);

      const sessA = clientA.openNote(note.id, { peerName: "Peer A" });
      const sessB = clientB.openNote(note.id, { peerName: "Peer B" });
      const sessC = clientC.openNote(note.id, { peerName: "Peer C" });

      await waitUntil(
        () =>
          sessA.awareness.getStates().has(sessB.doc.clientID) &&
          sessA.awareness.getStates().has(sessC.doc.clientID),
        "peer A sees both peer B and peer C",
      );

      // Drop A: A immediately clears stale remote cursors.
      forceDropSocket(clientA);
      await waitUntil(
        () =>
          clientA.status === "disconnected" &&
          !sessA.awareness.getStates().has(sessB.doc.clientID) &&
          !sessA.awareness.getStates().has(sessC.doc.clientID),
        "peer A clears remote cursors on disconnect",
      );

      // While A is offline, B leaves the room permanently while C stays.
      clientB.close();
      await waitUntil(() => !sessC.awareness.getStates().has(sessB.doc.clientID), "peer B removed on server");

      // After A reconnects, A sees C again (even though C's clock did not advance) and never revives B.
      await waitUntil(
        () => clientA.status === "connected" && sessA.awareness.getStates().has(sessC.doc.clientID),
        "peer A restores still-active peer C on reconnect",
      );
      expect(sessA.awareness.getStates().has(sessB.doc.clientID)).toBe(false);
    } finally {
      for (const c of clients) c.close();
      harness.close();
    }
  });

  test("offline local edits and concurrent remote edits converge after reconnect", async () => {
    const harness = await startHarness();
    const clients: CollabClient[] = [];
    try {
      const [tokenA, tokenB] = await Promise.all([
        harness.createDeviceToken("Offline A"),
        harness.createDeviceToken("Online B"),
      ]);
      const note = await harness.createNote("merge.md", "start\nend");

      const clientA = new CollabClient({ serverUrl: harness.baseUrl, token: tokenA });
      const clientB = new CollabClient({ serverUrl: harness.baseUrl, token: tokenB });
      clients.push(clientA, clientB);

      let readyA = false;
      let readyB = false;
      const sessA = clientA.openNote(note.id, { peerName: "Offline A", onReady: () => { readyA = true; } });
      const sessB = clientB.openNote(note.id, { peerName: "Online B", onReady: () => { readyB = true; } });

      await waitUntil(() => readyA && readyB, "both sessions ready");

      forceDropSocket(clientA);
      await waitUntil(() => clientA.status === "disconnected", "peer A disconnected");

      // Concurrent edits on opposite ends of the document while A is offline.
      sessA.ytext.insert(0, "A: ");
      sessB.ytext.insert(sessB.ytext.length, " :B");

      await waitUntil(
        () =>
          clientA.status === "connected" &&
          sessA.ytext.toString() === "A: start\nend :B" &&
          sessB.ytext.toString() === "A: start\nend :B",
        "peers converge after reconnect",
      );

      await waitUntil(
        async () => (await harness.getNoteContent(note.id)) === "A: start\nend :B",
        "server persists merged note content",
      );
      expect(await harness.getNoteContent(note.id)).toBe("A: start\nend :B");
    } finally {
      for (const c of clients) c.close();
      harness.close();
    }
  });

  test("reconnecting to a note deleted while offline notifies the session without surfacing an error", async () => {
    const harness = await startHarness();
    const clients: CollabClient[] = [];
    try {
      const tokenA = await harness.createDeviceToken("Peer A");
      const note = await harness.createNote("deleted.md", "bye");

      const errors: string[] = [];
      const clientA = new CollabClient({
        serverUrl: harness.baseUrl,
        token: tokenA,
        onError: (msg) => errors.push(msg),
      });
      clients.push(clientA);

      let readyA = false;
      let deletedA = false;
      clientA.openNote(note.id, {
        peerName: "Peer A",
        onReady: () => { readyA = true; },
        onDeleted: () => { deletedA = true; },
      });

      await waitUntil(() => readyA, "peer A joined note");

      forceDropSocket(clientA);
      await waitUntil(() => clientA.status === "disconnected", "peer A disconnected");

      await harness.deleteNote(note.id);

      await waitUntil(() => deletedA, "peer A notified of remote deletion on reconnect");
      expect(errors).toEqual([]);
    } finally {
      for (const c of clients) c.close();
      harness.close();
    }
  });
});
