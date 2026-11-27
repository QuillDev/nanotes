import { Elysia, status as respond } from "elysia";
import { z } from "zod";
import type { Auth } from "./auth.ts";
import type { CollabHub } from "./collab.ts";
import type { NotesStore } from "./notes.ts";
import type { Passkeys } from "./passkeys.ts";
import { WebAuthnError } from "./webauthn.ts";

export interface ApiDeps {
  readonly auth: Auth;
  readonly notes: NotesStore;
  readonly passkeys: Passkeys | null;
  readonly collab: CollabHub;
  readonly clock: () => number;
  /** Public origin from settings; pairing links fall back to the request's own origin. */
  readonly origin: string | null;
}

const fail = (message: string) => ({ error: message });

/** Ends the request from a `transform` check, before the body is validated. */
function deny(code: 401 | 403 | 404, message: string): never {
  throw respond(code, fail(message));
}

export function sameOrigin(req: Request): boolean {
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

/** JSON bodies that are missing or not an object read as `{}`, as they always have. */
async function parseObject({ request }: { request: Request }): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A field or body that fails without its own message answers "invalid request". */
const INVALID = { error: "invalid request" };

const credentialBody = z.object(
  {
    challengeId: z.unknown().optional(),
    credential: z.record(z.string(), z.unknown(), INVALID).optional(),
  },
  INVALID,
);

const noteBody = z.object(
  {
    content: z.string(INVALID).optional(),
    path: z.string(INVALID).optional(),
    pinned: z.boolean(INVALID).optional(),
  },
  INVALID,
);

const OP_ERROR = "each op requires string id and numeric baseRev";
const pushOp = z.object(
  {
    id: z.string({ error: OP_ERROR }),
    baseRev: z.number({ error: OP_ERROR }),
    path: z.string(INVALID).optional(),
    content: z.string(INVALID).optional(),
    pinned: z.boolean(INVALID).optional(),
    deleted: z.boolean(INVALID).optional(),
  },
  { error: OP_ERROR },
);

const nameBody = z.object({ name: z.string({ error: "name required" }) }, { error: "name required" });

function originGate({ request }: { request: Request }): void {
  if (!sameOrigin(request)) deny(403, "cross-origin request");
}

function gates({ auth, passkeys, clock }: ApiDeps) {
  return {
    passkeys: ({ request }: { request: Request }): void => {
      if (passkeys === null) deny(404, "passkeys are not configured");
      originGate({ request });
    },
    session: async ({ request }: { request: Request }): Promise<void> => {
      if (!(await auth.isSignedIn(request, clock()))) deny(401, "sign in required");
      if (request.method !== "GET") originGate({ request });
    },
    sync: async ({ request }: { request: Request }): Promise<void> => {
      if (!(await auth.isSyncAuthorized(request, clock()))) deny(401, "sync authorization required");
    },
    device: async ({ request }: { request: Request }): Promise<void> => {
      if (!(await auth.deviceFromRequest(request, clock()))) deny(401, "device authorization required");
    },
  };
}

/** Runs a WebAuthn ceremony step; a bad credential becomes `{ webauthnError }`. */
async function ceremony<T>(step: () => Promise<T>): Promise<T | { readonly webauthnError: string }> {
  try {
    return await step();
  } catch (cause) {
    if (cause instanceof WebAuthnError) return { webauthnError: cause.message };
    throw cause;
  }
}

/** Sign-in: password, passkeys and sign-out. */
function signInRoutes(deps: ApiDeps) {
  const { auth, clock } = deps;
  const passkeys = deps.passkeys as Passkeys;
  const gate = gates(deps);
  return new Elysia()
    .get("/login/methods", async () => ({
      passkey: (await deps.passkeys?.any()) ?? false,
      passkeyConfigured: deps.passkeys !== null,
      password: auth.passwordEnabled(),
    }))
    .post(
      "/login",
      async ({ body, set, status }) => {
        const result = await auth.signInWithPassword(body.password, clock());
        if (result === null) return status(401, fail("wrong password"));
        if ("limited" in result) return status(429, fail("too many attempts, try again later"));
        set.headers["set-cookie"] = result.cookie;
        return { ok: true as const };
      },
      {
        transform: ({ request }) => {
          originGate({ request });
          if (!auth.passwordEnabled()) deny(404, "password login is disabled");
        },
        body: z.object({ password: z.string({ error: "password required" }) }, { error: "password required" }),
      },
    )
    .post(
      "/logout",
      async ({ request, set }) => {
        set.headers["set-cookie"] = await auth.signOut(request);
        return { ok: true as const };
      },
      { transform: originGate },
    )
    .post(
      "/passkeys/login/options",
      async ({ status }) => ((await passkeys.any()) ? passkeys.loginOptions(clock()) : status(404, fail("no passkey registered"))),
      { transform: gate.passkeys },
    )
    .post(
      "/passkeys/login",
      async ({ body, set, status }) => {
        const now = clock();
        const ok = await ceremony(() => passkeys.login(body.challengeId, body.credential ?? {}, now));
        if (typeof ok === "object") return status(400, fail(ok.webauthnError));
        if (!ok) return status(401, fail("unknown passkey"));
        set.headers["set-cookie"] = await auth.startSession(now);
        return { ok: true as const };
      },
      { transform: gate.passkeys, body: credentialBody },
    )
    .post(
      "/passkeys/register/options",
      async ({ body, status }) => (await passkeys.registerOptions(body.setup, clock())) ?? status(404, fail("setup link is invalid or expired")),
      { transform: gate.passkeys, body: z.object({ setup: z.string({ error: "setup token required" }) }, { error: "setup token required" }) },
    )
    .post(
      "/passkeys/register",
      async ({ body, set, status }) => {
        const now = clock();
        const ok = await ceremony(() => passkeys.register(body.challengeId, body.credential ?? {}, now));
        if (typeof ok === "object") return status(400, fail(ok.webauthnError));
        if (!ok) return status(404, fail("setup link was already used or expired"));
        set.headers["set-cookie"] = await auth.startSession(now);
        return { ok: true as const };
      },
      { transform: gate.passkeys, body: credentialBody },
    );
}

/** Desktop pairing (public start/poll) and the sync protocol (device token or browser session). */
function deviceRoutes(deps: ApiDeps) {
  const { auth, notes, collab, clock, origin } = deps;
  const gate = gates(deps);
  return new Elysia()
    .post(
      "/device/start",
      async ({ body, request, status }) => {
        const started = await auth.startPairing(body.deviceName ?? "nanotes desktop", clock());
        if ("limited" in started) return status(429, fail("too many pairing requests, try again shortly"));
        return {
          code: started.code,
          pollToken: started.pollToken,
          expiresAt: started.expiresAt,
          verificationUrl: `${requestOrigin(request, origin)}/#/pair/${started.code}`,
        };
      },
      { body: z.object({ deviceName: z.string(INVALID).optional() }, INVALID) },
    )
    .post(
      "/device/poll",
      async ({ body, status }) => {
        if (!body.pollToken) return status(400, fail("pollToken required"));
        const result = await auth.pollPairing(body.pollToken, clock());
        if (result.status === "expired") return status(410, fail("pairing expired"));
        return result;
      },
      { body: z.object({ pollToken: z.string({ error: "pollToken required" }) }, { error: "pollToken required" }) },
    )
    .get(
      "/sync/changes",
      ({ query }) => {
        const since = Number(query.since ?? "0");
        return notes.changesSince(Number.isFinite(since) ? Math.max(0, Math.floor(since)) : 0);
      },
      { transform: gate.sync, query: z.object({ since: z.string(INVALID).optional() }, INVALID) },
    )
    .post("/sync/push", ({ body }) => notes.push(body.ops, clock()), {
      transform: gate.sync,
      body: z.object({ ops: z.array(pushOp, { error: "ops array required" }) }, { error: "ops array required" }),
    })
    .patch(
      "/device",
      async ({ body, request, status }) => {
        const device = await auth.deviceFromRequest(request, clock());
        if (!device) return status(401, fail("device authorization required"));
        if (!body.name.trim()) return status(400, fail("name required"));
        const updated = await auth.renameDevice(device.id, body.name);
        if (!updated) return status(404, fail("device not found"));
        collab.notifyDeviceRenamed(updated.id, updated.name);
        return { ok: true as const, device: updated };
      },
      { transform: gate.device, body: nameBody },
    );
}

/** Signed-in browser: passkey setup, devices and notes. */
function sessionRoutes(deps: ApiDeps) {
  const { auth, notes, passkeys, collab, clock } = deps;
  return new Elysia().guard({ transform: gates(deps).session }, (signedIn) =>
    signedIn
      .post("/passkeys/setup-link", async ({ status }) => {
        if (passkeys === null) return status(404, fail("passkeys are not configured"));
        const { url, expiresAt } = await passkeys.createSetupLink(clock());
        return { url, expiresAt };
      })
      .post(
        "/device/approve",
        async ({ body, status }) => {
          if (!body.code.trim()) return status(400, fail("code required"));
          const device = await auth.approvePairing(body.code, clock());
          return device ? { ok: true as const, device } : status(404, fail("pairing code is invalid or expired"));
        },
        { body: z.object({ code: z.string({ error: "code required" }) }, { error: "code required" }) },
      )
      .get("/devices", async () => ({ devices: await auth.listDevices() }))
      .post("/devices", async ({ body, status }) => status(201, await auth.createDeviceToken(body.name ?? "nanotes device", clock())), {
        body: z.object({ name: z.string(INVALID).optional() }, INVALID),
      })
      .patch(
        "/devices/:id",
        async ({ params, body, status }) => {
          if (!body.name.trim()) return status(400, fail("name required"));
          const updated = await auth.renameDevice(params.id, body.name);
          if (!updated) return status(404, fail("device not found"));
          collab.notifyDeviceRenamed(updated.id, updated.name);
          return { ok: true as const, device: updated };
        },
        { body: nameBody },
      )
      .delete("/devices/:id", async ({ params, status }) => {
        if (!(await auth.revokeDevice(params.id))) return status(404, fail("device not found"));
        collab.disconnectDevice(params.id);
        return { ok: true as const };
      })
      .get("/notes", ({ query }) => notes.listWithRev(query.q), { query: z.object({ q: z.string(INVALID).optional() }, INVALID) })
      .post(
        "/notes",
        async ({ body, status }) =>
          status(201, await notes.create({ content: body.content ?? "", path: body.path, pinned: body.pinned === true }, clock())),
        { body: noteBody },
      )
      .get("/notes/:id", async ({ params, status }) => (await notes.get(params.id)) ?? status(404, fail("note not found")))
      .patch(
        "/notes/:id",
        async ({ params, body, status }) => (await notes.update(params.id, body, clock())) ?? status(404, fail("note not found")),
        { body: noteBody },
      )
      .delete("/notes/:id", async ({ params, status }) =>
        (await notes.remove(params.id, clock())) ? { ok: true as const } : status(404, fail("note not found")),
      ),
  );
}

/**
 * The REST API under /api (everything but the /api/ws socket). Checks that came before body
 * validation (origin, sign-in, disabled features) run in `transform`, which Elysia runs first,
 * and end the request by throwing, so status codes match the order they always had.
 */
export function buildApi(deps: ApiDeps) {
  const { auth, clock } = deps;
  return new Elysia({ prefix: "/api" })
    .onParse(({ request, contentType }) => (contentType || request.method !== "GET" ? parseObject({ request }) : undefined))
    .onError(async ({ code, error, request, status }) => {
      if (code === "VALIDATION") return status(400, fail(typeof error.customError === "string" ? error.customError : "invalid request"));
      if (code === "NOT_FOUND") {
        // Unknown routes answer like the signed-in area they'd fall into.
        if (!(await auth.isSignedIn(request, clock()))) return status(401, fail("sign in required"));
        if (request.method !== "GET" && !sameOrigin(request)) return status(403, fail("cross-origin request"));
        return status(404, fail("not found"));
      }
      return undefined;
    })
    .use(signInRoutes(deps))
    .use(deviceRoutes(deps))
    .use(sessionRoutes(deps));
}

/** The API's type, for Eden clients (`treaty<App>(origin)`). */
export type App = ReturnType<typeof buildApi>;
