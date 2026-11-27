import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import { type Db, queryOne, queryRows, readSetting, writeSetting } from "./database.ts";
import { PasskeyRowSchema, PasskeySetupLinkRowSchema } from "./schemas.ts";
import { b64url, ES256, RS256, unb64url, verifyAssertion, verifyRegistration, WebAuthnError } from "./webauthn.ts";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SETUP_LINK_TTL_MS = 24 * 60 * 60 * 1000;

interface Challenge {
  readonly kind: "register" | "login";
  readonly challenge: Uint8Array;
  readonly expiresAt: number;
  readonly setupToken: string | null;
}

const PasskeyIdSchema = PasskeyRowSchema.pick({ id: true });
const StoredKeySchema = PasskeyRowSchema.pick({ cose_key: true, sign_count: true });
const SetupLinkExpirySchema = PasskeySetupLinkRowSchema.pick({ expires_at: true });

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class Passkeys {
  readonly origin: string;
  private readonly rpId: string;
  private readonly origins: Set<string>;
  private readonly challenges = new Map<string, Challenge>();

  constructor(
    private readonly database: Db,
    origin: string,
  ) {
    const url = new URL(origin);
    this.origin = url.origin;
    this.rpId = url.hostname;
    this.origins = new Set([url.origin]);
  }

  async any(): Promise<boolean> {
    return (await queryOne(this.database, sql`SELECT id FROM passkeys LIMIT 1`, PasskeyIdSchema)) !== null;
  }

  async createSetupLink(now: number): Promise<{ url: string; token: string; expiresAt: number }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + SETUP_LINK_TTL_MS;
    await this.database.insertInto("passkey_setup_links").values({ token_hash: hashToken(token), expires_at: expiresAt, used_at: null }).execute();
    return { url: `${this.origin}/#/passkey/${token}`, token, expiresAt };
  }

  private async setupLinkValid(token: string, now: number): Promise<boolean> {
    const row = await queryOne(
      this.database,
      sql`SELECT expires_at FROM passkey_setup_links WHERE token_hash = ${hashToken(token)} AND used_at IS NULL`,
      SetupLinkExpirySchema,
    );
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

  private async userId(): Promise<string> {
    const existing = await readSetting(this.database, "passkey_user_id");
    if (existing) return existing;
    const id = randomBytes(16).toString("base64url");
    await writeSetting(this.database, "passkey_user_id", id);
    return id;
  }

  async registerOptions(setupToken: string, now: number) {
    if (!(await this.setupLinkValid(setupToken, now))) return null;
    const { id, challenge } = this.issue("register", now, setupToken);
    const [existing, userId] = await Promise.all([
      queryRows(this.database, sql`SELECT id FROM passkeys`, PasskeyIdSchema),
      this.userId(),
    ]);
    return {
      challengeId: id,
      publicKey: {
        challenge: b64url(challenge),
        rp: { id: this.rpId, name: "nanotes" },
        user: { id: userId, name: "nanotes", displayName: "nanotes" },
        pubKeyCredParams: [
          { type: "public-key" as const, alg: ES256 },
          { type: "public-key" as const, alg: RS256 },
        ],
        authenticatorSelection: { residentKey: "required" as const, userVerification: "required" as const },
        attestation: "none" as const,
        excludeCredentials: existing.map((row) => ({ type: "public-key" as const, id: b64url(row.id) })),
        timeout: CHALLENGE_TTL_MS,
      },
    };
  }

  async register(challengeId: unknown, credential: Record<string, unknown>, now: number): Promise<boolean> {
    const entry = this.take(challengeId, "register", now);
    const registered = verifyRegistration(
      { clientDataJSON: unb64url(credential["clientDataJSON"]), attestationObject: unb64url(credential["attestationObject"]) },
      { challenge: entry.challenge, origins: this.origins, rpId: this.rpId },
    );
    return this.database.transaction().execute(async (trx) => {
      const used = await trx
        .updateTable("passkey_setup_links")
        .set({ used_at: now })
        .where("token_hash", "=", hashToken(entry.setupToken as string))
        .where("used_at", "is", null)
        .where("expires_at", ">", now)
        .executeTakeFirst();
      if (used.numUpdatedRows !== 1n) return false;
      await trx
        .insertInto("passkeys")
        .values({
          id: registered.credentialId,
          cose_key: registered.coseKey,
          sign_count: registered.signCount,
          created_at: now,
          last_used_at: null,
        })
        .execute();
      return true;
    });
  }

  loginOptions(now: number) {
    const { id, challenge } = this.issue("login", now, null);
    return {
      challengeId: id,
      publicKey: { challenge: b64url(challenge), rpId: this.rpId, userVerification: "required" as const, allowCredentials: [] as { id: string; type: "public-key" }[], timeout: CHALLENGE_TTL_MS },
    };
  }

  async login(challengeId: unknown, credential: Record<string, unknown>, now: number): Promise<boolean> {
    const entry = this.take(challengeId, "login", now);
    const credentialId = unb64url(credential["id"]);
    const stored = await queryOne(this.database, sql`SELECT cose_key, sign_count FROM passkeys WHERE id = ${credentialId}`, StoredKeySchema);
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
    await this.database.updateTable("passkeys").set({ sign_count: signCount, last_used_at: now }).where("id", "=", credentialId).execute();
    return true;
  }
}
