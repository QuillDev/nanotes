import { Elysia, status as respond, t } from "elysia";
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

const credentialBody = t.Object({
  challengeId: t.Optional(t.Unknown()),
  credential: t.Optional(t.Record(t.String(), t.Unknown())),
});

const noteFields = {
  content: t.Optional(t.String()),
  path: t.Optional(t.String()),
  pinned: t.Optional(t.Boolean()),
};

const OP_ERROR = "each op requires string id and numeric baseRev";
const pushOp = t.Object(
  {
    id: t.String({ error: OP_ERROR }),
    baseRev: t.Number({ error: OP_ERROR }),
    path: t.Optional(t.String()),
    content: t.Optional(t.String()),
    pinned: t.Optional(t.Boolean()),
    deleted: t.Optional(t.Boolean()),
  },
  { error: OP_ERROR },
);

const nameBody = t.Object({ name: t.String({ error: "name required" }) }, { error: "name required" });

function originGate({ request }: { request: Request }): void {
  if (!sameOrigin(request)) deny(403, "cross-origin request");
}

function gates({ auth, passkeys, clock }: ApiDeps) {
  return {
    passkeys: ({ request }: { request: Request }): void => {
      if (passkeys === null) deny(404, "passkeys are not configured");
      originGate({ request });
    },
    session: ({ request }: { request: Request }): void => {
      if (!auth.isSignedIn(request, clock())) deny(401, "sign in required");
      if (request.method !== "GET") originGate({ request });
    },
    sync: ({ request }: { request: Request }): void => {
      if (!auth.isSyncAuthorized(request, clock())) deny(401, "sync authorization required");
    },
    device: ({ request }: { request: Request }): void => {
      if (!auth.deviceFromRequest(request, clock())) deny(401, "device authorization required");
    },
  };
}

/** Runs a WebAuthn ceremony step; a bad credential becomes `{ webauthnError }`. */
function ceremony<T>(step: () => T): T | { readonly webauthnError: string } {
  try {
    return step();
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
    .get("/login/methods", () => ({
      passkey: deps.passkeys?.any() ?? false,
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
        body: t.Object({ password: t.String({ error: "password required" }) }, { error: "password required" }),
      },
    )
    .post(
      "/logout",
      ({ request, set }) => {
        set.headers["set-cookie"] = auth.signOut(request);
        return { ok: true as const };
      },
      { transform: originGate },
    )
    .post(
      "/passkeys/login/options",
      ({ status }) => (passkeys.any() ? passkeys.loginOptions(clock()) : status(404, fail("no passkey registered"))),
      { transform: gate.passkeys },
    )
    .post(
      "/passkeys/login",
      ({ body, set, status }) => {
        const now = clock();
        const ok = ceremony(() => passkeys.login(body.challengeId, body.credential ?? {}, now));
        if (typeof ok === "object") return status(400, fail(ok.webauthnError));
        if (!ok) return status(401, fail("unknown passkey"));
        set.headers["set-cookie"] = auth.startSession(now);
        return { ok: true as const };
      },
      { transform: gate.passkeys, body: credentialBody },
    )
    .post(
      "/passkeys/register/options",
      ({ body, status }) => passkeys.registerOptions(body.setup, clock()) ?? status(404, fail("setup link is invalid or expired")),
      { transform: gate.passkeys, body: t.Object({ setup: t.String({ error: "setup token required" }) }, { error: "setup token required" }) },
    )
    .post(
      "/passkeys/register",
      ({ body, set, status }) => {
        const now = clock();
        const ok = ceremony(() => passkeys.register(body.challengeId, body.credential ?? {}, now));
        if (typeof ok === "object") return status(400, fail(ok.webauthnError));
        if (!ok) return status(404, fail("setup link was already used or expired"));
        set.headers["set-cookie"] = auth.startSession(now);
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
      ({ body, request, status }) => {
        const started = auth.startPairing(body.deviceName ?? "nanotes desktop", clock());
        if ("limited" in started) return status(429, fail("too many pairing requests, try again shortly"));
        return {
          code: started.code,
          pollToken: started.pollToken,
          expiresAt: started.expiresAt,
          verificationUrl: `${requestOrigin(request, origin)}/#/pair/${started.code}`,
        };
      },
      { body: t.Object({ deviceName: t.Optional(t.String()) }) },
    )
    .post(
      "/device/poll",
      ({ body, status }) => {
        if (!body.pollToken) return status(400, fail("pollToken required"));
        const result = auth.pollPairing(body.pollToken, clock());
        if (result.status === "expired") return status(410, fail("pairing expired"));
        return result;
      },
      { body: t.Object({ pollToken: t.String({ error: "pollToken required" }) }, { error: "pollToken required" }) },
    )
    .get(
      "/sync/changes",
      ({ query }) => {
        const since = Number(query.since ?? "0");
        return notes.changesSince(Number.isFinite(since) ? Math.max(0, Math.floor(since)) : 0);
      },
      { transform: gate.sync, query: t.Object({ since: t.Optional(t.String()) }) },
    )
    .post("/sync/push", ({ body }) => notes.push(body.ops, clock()), {
      transform: gate.sync,
      body: t.Object({ ops: t.Array(pushOp, { error: "ops array required" }) }, { error: "ops array required" }),
    })
    .patch(
      "/device",
      ({ body, request, status }) => {
        const device = auth.deviceFromRequest(request, clock()) as { id: string };
        if (!body.name.trim()) return status(400, fail("name required"));
        const updated = auth.renameDevice(device.id, body.name);
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
      .post("/passkeys/setup-link", ({ status }) => {
        if (passkeys === null) return status(404, fail("passkeys are not configured"));
        const { url, expiresAt } = passkeys.createSetupLink(clock());
        return { url, expiresAt };
      })
      .post(
        "/device/approve",
        ({ body, status }) => {
          if (!body.code.trim()) return status(400, fail("code required"));
          const device = auth.approvePairing(body.code, clock());
          return device ? { ok: true as const, device } : status(404, fail("pairing code is invalid or expired"));
        },
        { body: t.Object({ code: t.String({ error: "code required" }) }, { error: "code required" }) },
      )
      .get("/devices", () => ({ devices: auth.listDevices() }))
      .post("/devices", ({ body, status }) => status(201, auth.createDeviceToken(body.name ?? "nanotes device", clock())), {
        body: t.Object({ name: t.Optional(t.String()) }),
      })
      .patch(
        "/devices/:id",
        ({ params, body, status }) => {
          if (!body.name.trim()) return status(400, fail("name required"));
          const updated = auth.renameDevice(params.id, body.name);
          if (!updated) return status(404, fail("device not found"));
          collab.notifyDeviceRenamed(updated.id, updated.name);
          return { ok: true as const, device: updated };
        },
        { body: nameBody },
      )
      .delete("/devices/:id", ({ params, status }) => {
        if (!auth.revokeDevice(params.id)) return status(404, fail("device not found"));
        collab.disconnectDevice(params.id);
        return { ok: true as const };
      })
      .get("/notes", ({ query }) => notes.listWithRev(query.q), { query: t.Object({ q: t.Optional(t.String()) }) })
      .post(
        "/notes",
        ({ body, status }) => status(201, notes.create({ content: body.content ?? "", path: body.path, pinned: body.pinned === true }, clock())),
        { body: t.Object(noteFields) },
      )
      .get("/notes/:id", ({ params, status }) => notes.get(params.id) ?? status(404, fail("note not found")))
      .patch("/notes/:id", ({ params, body, status }) => notes.update(params.id, body, clock()) ?? status(404, fail("note not found")), {
        body: t.Object(noteFields),
      })
      .delete("/notes/:id", ({ params, status }) => (notes.remove(params.id, clock()) ? { ok: true as const } : status(404, fail("note not found")))),
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
    .onError(({ code, error, request, status }) => {
      if (code === "VALIDATION") return status(400, fail(typeof error.customError === "string" ? error.customError : "invalid request"));
      if (code === "NOT_FOUND") {
        // Unknown routes answer like the signed-in area they'd fall into.
        if (!auth.isSignedIn(request, clock())) return status(401, fail("sign in required"));
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
