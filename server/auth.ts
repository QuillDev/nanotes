import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import type { z } from "zod";
import type { Db } from "./database.ts";
import { queryOne, queryRows } from "./database.ts";
import { DevicePairingRowSchema, DeviceTokenRowSchema, SessionRowSchema } from "./schemas.ts";

const SESSION_COOKIE = "nanotes_session";
const SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 10;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const PAIRING_WINDOW_MS = 5 * 60 * 1000;
const PAIRING_LIMIT = 20;
const DEVICE_LAST_USED_UPDATE_MS = 60 * 1000;

export interface AuthOptions {
  /** Optional Argon2 password hash (`bun -e 'console.log(await Bun.password.hash("..."))'`). */
  readonly passwordHash: string | null;
  /** Bearer token for `/mcp`; MCP is disabled when unset. */
  readonly mcpToken: string | null;
  readonly secureCookies: boolean;
}

export interface DeviceInfo {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

export interface PairingStart {
  readonly code: string;
  readonly pollToken: string;
  readonly expiresAt: number;
}

export type PairingPollResult =
  | { readonly status: "pending" }
  | { readonly status: "approved"; readonly token: string; readonly deviceName: string }
  | { readonly status: "expired" };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
}

function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function pairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    if (i === 4) out += "-";
    out += alphabet[(raw[i] as number) % alphabet.length];
  }
  return out;
}

const SessionExpirySchema = SessionRowSchema.pick({ expires_at: true });
const DeviceRowSchema = DeviceTokenRowSchema.pick({ id: true, name: true, created_at: true, last_used_at: true });
const PairingRowSchema = DevicePairingRowSchema.pick({ code: true, device_name: true, approved_token: true, expires_at: true });

function toDeviceInfo(row: z.infer<typeof DeviceRowSchema>): DeviceInfo {
  return { id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

/** A concurrent approval claimed the pairing first. */
class PairingTaken extends Error {}

export class Auth {
  private failures: number[] = [];
  private pairingStarts: number[] = [];

  constructor(
    private readonly database: Db,
    private readonly options: AuthOptions,
  ) {}

  passwordEnabled(): boolean {
    return this.options.passwordHash !== null;
  }

  mcpEnabled(): boolean {
    return this.options.mcpToken !== null;
  }

  async isSignedIn(req: Request, now: number): Promise<boolean> {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return false;
    const row = await queryOne(
      this.database,
      sql`SELECT expires_at FROM sessions WHERE token_hash = ${hashToken(token)}`,
      SessionExpirySchema,
    );
    return row !== null && row.expires_at > now;
  }

  async verifyDeviceToken(token: string, now: number): Promise<{ id: string; name: string } | null> {
    const trimmed = token.trim();
    if (!trimmed) return null;
    const row = await queryOne(
      this.database,
      sql`SELECT id, name, created_at, last_used_at FROM device_tokens WHERE token_hash = ${hashToken(trimmed)}`,
      DeviceRowSchema,
    );
    if (!row) return null;
    if (row.last_used_at === null || now - row.last_used_at >= DEVICE_LAST_USED_UPDATE_MS) {
      await this.database.updateTable("device_tokens").set({ last_used_at: now }).where("id", "=", row.id).execute();
    }
    return { id: row.id, name: row.name };
  }

  async hasDeviceToken(req: Request, now: number): Promise<boolean> {
    const token = bearerToken(req);
    if (!token) return false;
    return (await this.verifyDeviceToken(token, now)) !== null;
  }

  async deviceFromRequest(req: Request, now: number): Promise<{ id: string; name: string } | null> {
    const token = bearerToken(req);
    if (!token) return null;
    return this.verifyDeviceToken(token, now);
  }

  async isSyncAuthorized(req: Request, now: number): Promise<boolean> {
    return (await this.hasDeviceToken(req, now)) || (await this.isSignedIn(req, now));
  }

  hasMcpToken(req: Request): boolean {
    const expected = this.options.mcpToken;
    const given = bearerToken(req);
    if (!expected || !given) return false;
    return sameSecret(given, expected);
  }

  async signInWithPassword(password: string, now: number): Promise<{ cookie: string } | { limited: true } | null> {
    if (!this.options.passwordHash) return null;
    this.failures = this.failures.filter((at) => at > now - LOGIN_WINDOW_MS);
    if (this.failures.length >= LOGIN_FAILURE_LIMIT) return { limited: true };
    const ok = await Bun.password.verify(password, this.options.passwordHash).catch(() => false);
    if (!ok) {
      this.failures.push(now);
      return null;
    }
    return { cookie: await this.startSession(now) };
  }

  async startSession(now: number): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.database
      .insertInto("sessions")
      .values({ token_hash: hashToken(token), expires_at: now + SESSION_LIFETIME_MS, created_at: now })
      .execute();
    await this.database.deleteFrom("sessions").where("expires_at", "<=", now).execute();
    return this.cookie(token, SESSION_LIFETIME_MS / 1000);
  }

  async signOut(req: Request): Promise<string> {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await this.database.deleteFrom("sessions").where("token_hash", "=", hashToken(token)).execute();
    return this.cookie("", 0);
  }

  async createDeviceToken(name: string, now: number, database: Db = this.database): Promise<{ device: DeviceInfo; token: string }> {
    const cleanName = name.trim().slice(0, 80) || "nanotes device";
    const id = randomBytes(12).toString("base64url");
    const token = `nts_${randomBytes(32).toString("base64url")}`;
    await database
      .insertInto("device_tokens")
      .values({ id, name: cleanName, token_hash: hashToken(token), created_at: now, last_used_at: null })
      .execute();
    return {
      device: { id, name: cleanName, createdAt: now, lastUsedAt: null },
      token,
    };
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const rows = await queryRows(
      this.database,
      sql`SELECT id, name, created_at, last_used_at FROM device_tokens ORDER BY created_at DESC`,
      DeviceRowSchema,
    );
    return rows.map(toDeviceInfo);
  }

  async renameDevice(id: string, name: string): Promise<DeviceInfo | null> {
    const cleanName = name.trim().slice(0, 80);
    if (!cleanName) return null;
    const row = await queryOne(
      this.database,
      sql`UPDATE device_tokens SET name = ${cleanName} WHERE id = ${id} RETURNING id, name, created_at, last_used_at`,
      DeviceRowSchema,
    );
    return row ? toDeviceInfo(row) : null;
  }

  async revokeDevice(id: string): Promise<boolean> {
    const result = await this.database.deleteFrom("device_tokens").where("id", "=", id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async startPairing(deviceName: string, now: number): Promise<PairingStart | { limited: true }> {
    this.pairingStarts = this.pairingStarts.filter((at) => at > now - PAIRING_WINDOW_MS);
    if (this.pairingStarts.length >= PAIRING_LIMIT) return { limited: true };
    this.pairingStarts.push(now);

    await this.database.deleteFrom("device_pairings").where("expires_at", "<=", now).execute();
    const cleanName = deviceName.trim().slice(0, 80) || "nanotes device";
    const code = pairingCode();
    const pollToken = randomBytes(32).toString("base64url");
    const expiresAt = now + PAIRING_TTL_MS;
    await this.database
      .insertInto("device_pairings")
      .values({
        code,
        poll_token_hash: hashToken(pollToken),
        device_name: cleanName,
        approved_token: null,
        expires_at: expiresAt,
        created_at: now,
      })
      .execute();
    return { code, pollToken, expiresAt };
  }

  async pairingInfo(code: string, now: number): Promise<{ code: string; deviceName: string; expiresAt: number } | null> {
    const row = await queryOne(
      this.database,
      sql`SELECT code, device_name, expires_at, approved_token FROM device_pairings WHERE code = ${code.trim().toUpperCase()}`,
      PairingRowSchema,
    );
    if (!row || row.expires_at <= now || row.approved_token !== null) return null;
    return { code: row.code, deviceName: row.device_name, expiresAt: row.expires_at };
  }

  approvePairing(code: string, now: number): Promise<DeviceInfo | null> {
    const normalized = code.trim().toUpperCase();
    return this.database.transaction().execute(async (trx) => {
      const row = await queryOne(
        trx,
        sql`SELECT code, device_name, expires_at, approved_token FROM device_pairings WHERE code = ${normalized}`,
        PairingRowSchema,
      );
      if (!row || row.expires_at <= now || row.approved_token !== null) return null;
      const { device, token } = await this.createDeviceToken(row.device_name, now, trx);
      // Only the first approval claims the pairing; a concurrent one rolls back its device.
      const claimed = await trx
        .updateTable("device_pairings")
        .set({ approved_token: token })
        .where("code", "=", normalized)
        .where("approved_token", "is", null)
        .executeTakeFirst();
      if (claimed.numUpdatedRows !== 1n) throw new PairingTaken();
      return device;
    }).catch((cause: unknown) => {
      if (cause instanceof PairingTaken) return null;
      throw cause;
    });
  }

  pollPairing(pollToken: string, now: number): Promise<PairingPollResult> {
    const hash = hashToken(pollToken);
    return this.database.transaction().execute(async (trx): Promise<PairingPollResult> => {
      const row = await queryOne(
        trx,
        sql`SELECT code, device_name, approved_token, expires_at FROM device_pairings WHERE poll_token_hash = ${hash}`,
        PairingRowSchema,
      );
      if (!row || row.expires_at <= now) {
        if (row) await trx.deleteFrom("device_pairings").where("code", "=", row.code).execute();
        return { status: "expired" };
      }
      if (row.approved_token === null) return { status: "pending" };
      // One-time handoff: remove the pairing row as soon as the device claims its token.
      const claimed = await trx.deleteFrom("device_pairings").where("code", "=", row.code).executeTakeFirst();
      if (claimed.numDeletedRows !== 1n) return { status: "expired" };
      return { status: "approved", token: row.approved_token, deviceName: row.device_name };
    });
  }

  private cookie(value: string, maxAgeSeconds: number): string {
    const secure = this.options.secureCookies ? "; Secure" : "";
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
  }
}
