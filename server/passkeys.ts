import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { readSetting, writeSetting } from "./database.ts";
import { b64url, ES256, RS256, unb64url, verifyAssertion, verifyRegistration, WebAuthnError } from "./webauthn.ts";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SETUP_LINK_TTL_MS = 24 * 60 * 60 * 1000;

interface Challenge {
  readonly kind: "register" | "login";
  readonly challenge: Uint8Array;
  readonly expiresAt: number;
  readonly setupToken: string | null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class Passkeys {
  readonly origin: string;
  private readonly rpId: string;
  private readonly origins: Set<string>;
  private readonly challenges = new Map<string, Challenge>();

  constructor(
    private readonly database: Database,
    origin: string,
  ) {
    const url = new URL(origin);
    this.origin = url.origin;
    this.rpId = url.hostname;
    this.origins = new Set([url.origin]);
  }

  any(): boolean {
    return this.database.query("SELECT 1 FROM passkeys LIMIT 1").get() !== null;
  }

  createSetupLink(now: number): { url: string; token: string; expiresAt: number } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + SETUP_LINK_TTL_MS;
    this.database.query("INSERT INTO passkey_setup_links (token_hash, expires_at) VALUES (?, ?)").run(hashToken(token), expiresAt);
    return { url: `${this.origin}/#/passkey/${token}`, token, expiresAt };
  }

  private setupLinkValid(token: string, now: number): boolean {
    const row = this.database
      .query<{ expires_at: number }, [string]>("SELECT expires_at FROM passkey_setup_links WHERE token_hash = ? AND used_at IS NULL")
      .get(hashToken(token));
    return row !== null && row.expires_at > now;
  }

  private issue(kind: Challenge["kind"], now: number, setupToken: string | null): { id: string; challenge: Uint8Array } {
    for (const [id, entry] of this.challenges) if (entry.expiresAt <= now) this.challenges.delete(id);
    const id = randomBytes(16).toString("base64url");
    const challenge = new Uint8Array(randomBytes(32));
    this.challenges.set(id, { kind, challenge, expiresAt: now + CHALLENGE_TTL_MS, setupToken });
    return { id, challenge };
  }

  private take(id: unknown, kind: Challenge["kind"], now: number): Challenge {
    const entry = typeof id === "string" ? this.challenges.get(id) : undefined;
    if (entry) this.challenges.delete(id as string);
    if (!entry || entry.kind !== kind || entry.expiresAt <= now) throw new WebAuthnError("challenge expired, try again");
    return entry;
  }

  private userId(): string {
    const existing = readSetting(this.database, "passkey_user_id");
    if (existing) return existing;
    const id = randomBytes(16).toString("base64url");
    writeSetting(this.database, "passkey_user_id", id);
    return id;
  }

  registerOptions(setupToken: string, now: number): object | null {
    if (!this.setupLinkValid(setupToken, now)) return null;
    const { id, challenge } = this.issue("register", now, setupToken);
    const existing = this.database.query<{ id: Uint8Array }, []>("SELECT id FROM passkeys").all();
    return {
      challengeId: id,
      publicKey: {
        challenge: b64url(challenge),
        rp: { id: this.rpId, name: "nanotes" },
        user: { id: this.userId(), name: "nanotes", displayName: "nanotes" },
        pubKeyCredParams: [
          { type: "public-key", alg: ES256 },
          { type: "public-key", alg: RS256 },
        ],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        attestation: "none",
        excludeCredentials: existing.map((row) => ({ type: "public-key", id: b64url(row.id) })),
        timeout: CHALLENGE_TTL_MS,
      },
    };
  }

  register(challengeId: unknown, credential: Record<string, unknown>, now: number): boolean {
    const entry = this.take(challengeId, "register", now);
    const registered = verifyRegistration(
      { clientDataJSON: unb64url(credential["clientDataJSON"]), attestationObject: unb64url(credential["attestationObject"]) },
      { challenge: entry.challenge, origins: this.origins, rpId: this.rpId },
    );
    return this.database.transaction(() => {
      const used = this.database
        .query("UPDATE passkey_setup_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
        .run(now, hashToken(entry.setupToken as string), now);
      if (used.changes !== 1) return false;
      this.database
        .query("INSERT INTO passkeys (id, cose_key, sign_count, created_at) VALUES (?, ?, ?, ?)")
        .run(registered.credentialId, registered.coseKey, registered.signCount, now);
      return true;
    })();
  }

  loginOptions(now: number): object {
    const { id, challenge } = this.issue("login", now, null);
    return {
      challengeId: id,
      publicKey: { challenge: b64url(challenge), rpId: this.rpId, userVerification: "required", allowCredentials: [], timeout: CHALLENGE_TTL_MS },
    };
  }

  login(challengeId: unknown, credential: Record<string, unknown>, now: number): boolean {
    const entry = this.take(challengeId, "login", now);
    const credentialId = unb64url(credential["id"]);
    const stored = this.database
      .query<{ cose_key: Uint8Array; sign_count: number }, [Uint8Array]>("SELECT cose_key, sign_count FROM passkeys WHERE id = ?")
      .get(credentialId);
    if (!stored) return false;
    const signCount = verifyAssertion(
      {
        clientDataJSON: unb64url(credential["clientDataJSON"]),
        authenticatorData: unb64url(credential["authenticatorData"]),
        signature: unb64url(credential["signature"]),
      },
      { challenge: entry.challenge, origins: this.origins, rpId: this.rpId },
      { coseKey: stored.cose_key, signCount: stored.sign_count },
    );
    this.database.query("UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?").run(signCount, now, credentialId);
    return true;
  }
}
