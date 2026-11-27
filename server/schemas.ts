import { z } from "zod";

/** BLOB / BYTEA: bun:sqlite reads Uint8Array, pg reads Buffer (a Uint8Array). */
const bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array, "expected bytes");

export const KvRowSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export const NoteRowSchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  content: z.string(),
  content_hash: z.string(),
  pinned: z.number(),
  rev: z.number(),
  deleted_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  yjs_state: bytes.nullable(),
});

export const SessionRowSchema = z.object({
  token_hash: z.string(),
  expires_at: z.number(),
  created_at: z.number(),
});

export const PasskeyRowSchema = z.object({
  id: bytes,
  cose_key: bytes,
  sign_count: z.number(),
  created_at: z.number(),
  last_used_at: z.number().nullable(),
});

export const PasskeySetupLinkRowSchema = z.object({
  token_hash: z.string(),
  expires_at: z.number(),
  used_at: z.number().nullable(),
});

export const DeviceTokenRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  token_hash: z.string(),
  created_at: z.number(),
  last_used_at: z.number().nullable(),
});

export const DevicePairingRowSchema = z.object({
  code: z.string(),
  poll_token_hash: z.string(),
  device_name: z.string(),
  approved_token: z.string().nullable(),
  expires_at: z.number(),
  created_at: z.number(),
});

/** Kysely's view of the schema, derived from the row schemas above. */
export interface Database {
  kv: z.infer<typeof KvRowSchema>;
  notes: z.infer<typeof NoteRowSchema>;
  sessions: z.infer<typeof SessionRowSchema>;
  passkeys: z.infer<typeof PasskeyRowSchema>;
  passkey_setup_links: z.infer<typeof PasskeySetupLinkRowSchema>;
  device_tokens: z.infer<typeof DeviceTokenRowSchema>;
  device_pairings: z.infer<typeof DevicePairingRowSchema>;
}
