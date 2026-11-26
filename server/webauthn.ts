/**
 * Passkey registration and sign-in verification (WebAuthn level 2, attestation "none").
 * Supports ES256 and RS256 credentials with user presence and verification required.
 */
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { CborError, decode, decodeAll, type CborValue } from "./cbor.ts";

export const ES256 = -7;
export const RS256 = -257;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class WebAuthnError extends Error {}

export function b64url(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

export function unb64url(text: unknown): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) throw new WebAuthnError("malformed base64url");
  return new Uint8Array(Buffer.from(text, "base64url"));
}

interface AuthData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId: Uint8Array | null;
  coseKey: Uint8Array | null;
}

function parseAuthData(raw: Uint8Array): AuthData {
  if (raw.length < 37) throw new WebAuthnError("authenticator data too short");
  const flags = raw[32] as number;
  const data: AuthData = {
    rpIdHash: raw.slice(0, 32),
    flags,
    signCount: new DataView(raw.buffer, raw.byteOffset + 33, 4).getUint32(0),
    credentialId: null,
    coseKey: null,
  };
  if (flags & FLAG_AT) {
    if (raw.length < 55) throw new WebAuthnError("attested credential data too short");
    const length = ((raw[53] as number) << 8) | (raw[54] as number);
    if (55 + length > raw.length) throw new WebAuthnError("credential id truncated");
    data.credentialId = raw.slice(55, 55 + length);
    try {
      const [, end] = decode(raw, 55 + length);
      data.coseKey = raw.slice(55 + length, end);
    } catch (cause) {
      if (cause instanceof CborError) throw new WebAuthnError("malformed credential public key");
      throw cause;
    }
  }
  return data;
}

function checkClientData(raw: Uint8Array, ceremony: string, challenge: Uint8Array, origins: ReadonlySet<string>): void {
  let client: Record<string, unknown>;
  try {
    client = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    throw new WebAuthnError("client data is not JSON");
  }
  if (client["type"] !== ceremony) throw new WebAuthnError("wrong ceremony type");
  if (!Buffer.from(unb64url(client["challenge"])).equals(Buffer.from(challenge))) throw new WebAuthnError("challenge mismatch");
  if (typeof client["origin"] !== "string" || !origins.has(client["origin"])) throw new WebAuthnError("origin mismatch");
  if (client["crossOrigin"] === true) throw new WebAuthnError("cross-origin ceremony");
}

function checkFlagsAndRp(data: AuthData, rpId: string): void {
  if (!Buffer.from(data.rpIdHash).equals(createHash("sha256").update(rpId).digest())) throw new WebAuthnError("RP ID mismatch");
  if (!(data.flags & FLAG_UP)) throw new WebAuthnError("user not present");
  if (!(data.flags & FLAG_UV)) throw new WebAuthnError("user not verified");
}

function bytes(value: CborValue | undefined): Uint8Array | null {
  return value instanceof Uint8Array ? value : null;
}

function publicKey(coseKey: Uint8Array): KeyObject {
  let cose: CborValue;
  try {
    cose = decodeAll(coseKey);
  } catch {
    throw new WebAuthnError("malformed credential public key");
  }
  if (!(cose instanceof Map)) throw new WebAuthnError("credential public key is not a COSE map");
  const alg = cose.get(3);
  if (alg === ES256 && cose.get(1) === 2 && cose.get(-1) === 1) {
    const x = bytes(cose.get(-2));
    const y = bytes(cose.get(-3));
    if (!x || !y || x.length !== 32 || y.length !== 32) throw new WebAuthnError("bad EC2 key");
    try {
      return createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(x), y: b64url(y) }, format: "jwk" });
    } catch {
      throw new WebAuthnError("bad EC2 key");
    }
  }
  if (alg === RS256 && cose.get(1) === 3) {
    const n = bytes(cose.get(-1));
    const e = bytes(cose.get(-2));
    if (!n || !e) throw new WebAuthnError("bad RSA key");
    try {
      return createPublicKey({ key: { kty: "RSA", n: b64url(n), e: b64url(e) }, format: "jwk" });
    } catch {
      throw new WebAuthnError("bad RSA key");
    }
  }
  throw new WebAuthnError("unsupported key type");
}

export interface Registered {
  readonly credentialId: Uint8Array;
  readonly coseKey: Uint8Array;
  readonly signCount: number;
}

export interface Ceremony {
  readonly challenge: Uint8Array;
  readonly origins: ReadonlySet<string>;
  readonly rpId: string;
}

export function verifyRegistration(
  credential: { clientDataJSON: Uint8Array; attestationObject: Uint8Array },
  ceremony: Ceremony,
): Registered {
  checkClientData(credential.clientDataJSON, "webauthn.create", ceremony.challenge, ceremony.origins);
  let attestation: CborValue;
  try {
    attestation = decodeAll(credential.attestationObject);
  } catch {
    throw new WebAuthnError("attestation object is not CBOR");
  }
  const authData = attestation instanceof Map ? bytes(attestation.get("authData")) : null;
  if (!authData) throw new WebAuthnError("attestation object has no authenticator data");
  const data = parseAuthData(authData);
  checkFlagsAndRp(data, ceremony.rpId);
  if (!data.credentialId || !data.coseKey) throw new WebAuthnError("no attested credential");
  publicKey(data.coseKey);
  return { credentialId: data.credentialId, coseKey: data.coseKey, signCount: data.signCount };
}

export function verifyAssertion(
  credential: { clientDataJSON: Uint8Array; authenticatorData: Uint8Array; signature: Uint8Array },
  ceremony: Ceremony,
  stored: { coseKey: Uint8Array; signCount: number },
): number {
  checkClientData(credential.clientDataJSON, "webauthn.get", ceremony.challenge, ceremony.origins);
  const data = parseAuthData(credential.authenticatorData);
  checkFlagsAndRp(data, ceremony.rpId);
  const key = publicKey(stored.coseKey);
  const signed = Buffer.concat([credential.authenticatorData, createHash("sha256").update(credential.clientDataJSON).digest()]);
  const ok =
    key.asymmetricKeyType === "ec"
      ? verify("sha256", signed, { key, dsaEncoding: "der" }, credential.signature)
      : verify("sha256", signed, key, credential.signature);
  if (!ok) throw new WebAuthnError("bad signature");
  if ((data.signCount || stored.signCount) && data.signCount <= stored.signCount) {
    throw new WebAuthnError("signature counter went backwards");
  }
  return data.signCount;
}
