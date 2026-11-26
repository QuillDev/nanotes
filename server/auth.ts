import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "nanotes_session";
const SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 10;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const PAIRING_WINDOW_MS = 5 * 60 * 1000;
const PAIRING_LIMIT = 20;

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

export class Auth {
  private failures: number[] = [];
  private pairingStarts: number[] = [];

  constructor(
    private readonly database: Database,
    private readonly options: AuthOptions,
  ) {}

  passwordEnabled(): boolean {
    return this.options.passwordHash !== null;
  }

  mcpEnabled(): boolean {
    return this.options.mcpToken !== null;
  }

  isSignedIn(req: Request, now: number): boolean {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return false;
    const row = this.database
      .query<{ expires_at: number }, [string]>("SELECT expires_at FROM sessions WHERE token_hash = ?")
      .get(hashToken(token));
    return row !== null && row.expires_at > now;
  }

  verifyDeviceToken(token: string, now: number): { id: string; name: string } | null {
    const trimmed = token.trim();
    if (!trimmed) return null;
    const hash = hashToken(trimmed);
    const row = this.database
      .query<{ id: string; name: string }, [string]>("SELECT id, name FROM device_tokens WHERE token_hash = ?")
      .get(hash);
    if (!row) return null;
    this.database.query("UPDATE device_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
    return row;
  }

  hasDeviceToken(req: Request, now: number): boolean {
    const token = bearerToken(req);
    if (!token) return false;
    return this.verifyDeviceToken(token, now) !== null;
  }

  deviceFromRequest(req: Request, now: number): { id: string; name: string } | null {
    const token = bearerToken(req);
    if (!token) return null;
    return this.verifyDeviceToken(token, now);
  }

  isSyncAuthorized(req: Request, now: number): boolean {
    return this.hasDeviceToken(req, now) || this.isSignedIn(req, now);
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
    return { cookie: this.startSession(now) };
  }

  startSession(now: number): string {
    const token = randomBytes(32).toString("base64url");
    this.database
      .query("INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)")
      .run(hashToken(token), now + SESSION_LIFETIME_MS, now);
    this.database.query("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    return this.cookie(token, SESSION_LIFETIME_MS / 1000);
  }

  signOut(req: Request): string {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) this.database.query("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    return this.cookie("", 0);
  }

  createDeviceToken(name: string, now: number): { device: DeviceInfo; token: string } {
    const cleanName = name.trim().slice(0, 80) || "nanotes device";
    const id = randomBytes(12).toString("base64url");
    const token = `nts_${randomBytes(32).toString("base64url")}`;
    this.database
      .query("INSERT INTO device_tokens (id, name, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, NULL)")
      .run(id, cleanName, hashToken(token), now);
    return {
      device: { id, name: cleanName, createdAt: now, lastUsedAt: null },
      token,
    };
  }

  listDevices(): DeviceInfo[] {
    return this.database
      .query<{ id: string; name: string; created_at: number; last_used_at: number | null }, []>(
        "SELECT id, name, created_at, last_used_at FROM device_tokens ORDER BY created_at DESC",
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      }));
  }

  renameDevice(id: string, name: string): DeviceInfo | null {
    const cleanName = name.trim().slice(0, 80);
    if (!cleanName) return null;
    const result = this.database.query("UPDATE device_tokens SET name = ? WHERE id = ?").run(cleanName, id);
    if (result.changes === 0) return null;
    const row = this.database
      .query<{ id: string; name: string; created_at: number; last_used_at: number | null }, [string]>(
        "SELECT id, name, created_at, last_used_at FROM device_tokens WHERE id = ?",
      )
      .get(id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    };
  }

  revokeDevice(id: string): boolean {
    const result = this.database.query("DELETE FROM device_tokens WHERE id = ?").run(id);
    return result.changes > 0;
  }

  startPairing(deviceName: string, now: number): PairingStart | { limited: true } {
    this.pairingStarts = this.pairingStarts.filter((at) => at > now - PAIRING_WINDOW_MS);
    if (this.pairingStarts.length >= PAIRING_LIMIT) return { limited: true };
    this.pairingStarts.push(now);

    this.database.query("DELETE FROM device_pairings WHERE expires_at <= ?").run(now);
    const cleanName = deviceName.trim().slice(0, 80) || "nanotes device";
    const code = pairingCode();
    const pollToken = randomBytes(32).toString("base64url");
    const expiresAt = now + PAIRING_TTL_MS;
    this.database
      .query(
        "INSERT INTO device_pairings (code, poll_token_hash, device_name, approved_token, expires_at, created_at) VALUES (?, ?, ?, NULL, ?, ?)",
      )
      .run(code, hashToken(pollToken), cleanName, expiresAt, now);
    return { code, pollToken, expiresAt };
  }

  pairingInfo(code: string, now: number): { code: string; deviceName: string; expiresAt: number } | null {
    const row = this.database
      .query<{ code: string; device_name: string; expires_at: number; approved_token: string | null }, [string]>(
        "SELECT code, device_name, expires_at, approved_token FROM device_pairings WHERE code = ?",
      )
      .get(code.trim().toUpperCase());
    if (!row || row.expires_at <= now || row.approved_token !== null) return null;
    return { code: row.code, deviceName: row.device_name, expiresAt: row.expires_at };
  }

  approvePairing(code: string, now: number): DeviceInfo | null {
    const normalized = code.trim().toUpperCase();
    return this.database.transaction(() => {
      const row = this.database
        .query<{ device_name: string; expires_at: number; approved_token: string | null }, [string]>(
          "SELECT device_name, expires_at, approved_token FROM device_pairings WHERE code = ?",
        )
        .get(normalized);
      if (!row || row.expires_at <= now || row.approved_token !== null) return null;
      const { device, token } = this.createDeviceToken(row.device_name, now);
      this.database.query("UPDATE device_pairings SET approved_token = ? WHERE code = ?").run(token, normalized);
      return device;
    })();
  }

  pollPairing(pollToken: string, now: number): PairingPollResult {
    const hash = hashToken(pollToken);
    return this.database.transaction(() => {
      const row = this.database
        .query<{ code: string; device_name: string; approved_token: string | null; expires_at: number }, [string]>(
          "SELECT code, device_name, approved_token, expires_at FROM device_pairings WHERE poll_token_hash = ?",
        )
        .get(hash);
      if (!row || row.expires_at <= now) {
        if (row) this.database.query("DELETE FROM device_pairings WHERE code = ?").run(row.code);
        return { status: "expired" } as const;
      }
      if (row.approved_token === null) return { status: "pending" } as const;
      // One-time handoff: remove the pairing row as soon as the device claims its token.
      this.database.query("DELETE FROM device_pairings WHERE code = ?").run(row.code);
      return { status: "approved", token: row.approved_token, deviceName: row.device_name } as const;
    })();
  }

  private cookie(value: string, maxAgeSeconds: number): string {
    const secure = this.options.secureCookies ? "; Secure" : "";
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
  }
}
