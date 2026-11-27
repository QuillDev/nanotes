#!/usr/bin/env node
// Signs release files for the in-app updater: writes `<file>.sig` next to each file, the same
// minisign signature the release has always shipped (prehashed "ED": Ed25519 over the BLAKE2b-512
// of the file, base64 of the whole .sig text), so desktop/src/minisign.js and installs already out
// there accept it.
//
// usage: NANOTES_UPDATE_KEY=<key> [NANOTES_UPDATE_KEY_PASSWORD=<pw>] node sign-update.mjs <file>...
// The key is the base64 minisign secret key file the release workflow holds as a repo secret.
import { createPrivateKey, scryptSync, sign } from "node:crypto"
import { createReadStream, writeFileSync } from "node:fs"
import { basename } from "node:path"
import { fileURLToPath } from "node:url"

import blake from "blakejs"

/** libsodium's scrypt parameter choice for minisign's opslimit/memlimit. */
function scryptParams(opslimit, memlimit) {
  const ops = Math.max(opslimit, 32768)
  const r = 8
  let logN = 1
  if (ops < memlimit / 32) {
    const maxN = Math.floor(ops / (r * 4))
    while (logN < 63 && 2 ** logN <= Math.floor(maxN / 2)) logN += 1
    return { N: 2 ** logN, r, p: 1 }
  }
  const maxN = Math.floor(memlimit / (r * 128))
  while (logN < 63 && 2 ** logN <= Math.floor(maxN / 2)) logN += 1
  const maxrp = Math.min(Math.floor(ops / 4 / 2 ** logN), 0x3fffffff)
  return { N: 2 ** logN, r, p: Math.max(1, Math.floor(maxrp / r)) }
}

/** Opens the base64 minisign secret key file `encoded`, decrypting it with `password`. */
export function parseSecretKey(encoded, password = "") {
  const lines = Buffer.from(encoded.trim(), "base64").toString("utf8").trim().split("\n")
  const blob = Buffer.from(lines.at(-1).trim(), "base64")
  if (blob.length !== 158 || blob.subarray(0, 2).toString() !== "Ed" || blob.subarray(4, 6).toString() !== "B2") {
    throw new Error("not a minisign secret key")
  }
  const kdf = blob.subarray(2, 4).toString("latin1")
  const keynum = Buffer.from(blob.subarray(54))
  if (kdf === "Sc") {
    const { N, r, p } = scryptParams(Number(blob.readBigUInt64LE(38)), Number(blob.readBigUInt64LE(46)))
    const stream = scryptSync(password, blob.subarray(6, 38), keynum.length, { N, r, p, maxmem: 256 * N * r + (1 << 20) })
    for (let i = 0; i < keynum.length; i += 1) keynum[i] ^= stream[i]
  } else if (kdf !== "\0\0") {
    throw new Error("unsupported minisign key encryption")
  }
  const keyId = keynum.subarray(0, 8)
  const secret = keynum.subarray(8, 72)
  const checksum = Buffer.from(blake.blake2b(Buffer.concat([blob.subarray(0, 2), keyId, secret]), undefined, 32))
  if (!checksum.equals(keynum.subarray(72))) throw new Error("wrong password for the signing key")
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: secret.subarray(0, 32).toString("base64url"), x: secret.subarray(32).toString("base64url") },
    format: "jwk",
  })
  return { keyId: Buffer.from(keyId), key }
}

async function blake2b512File(path) {
  const state = blake.blake2bInit(64)
  for await (const chunk of createReadStream(path)) blake.blake2bUpdate(state, chunk)
  return Buffer.from(blake.blake2bFinal(state))
}

/** The `.sig` contents for `path`: base64 of the minisign signature text. */
export async function signFile(path, secretKey, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = sign(null, await blake2b512File(path), secretKey.key)
  const trustedComment = `timestamp:${timestamp}\tfile:${basename(path)}`
  const globalSignature = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), secretKey.key)
  const text = [
    "untrusted comment: signature from nanotes secret key",
    Buffer.concat([Buffer.from("ED"), secretKey.keyId, signature]).toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSignature.toString("base64"),
    "",
  ].join("\n")
  return Buffer.from(text).toString("base64")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2)
  const encoded = process.env.NANOTES_UPDATE_KEY
  if (!encoded || files.length === 0) {
    console.error("usage: NANOTES_UPDATE_KEY=<key> node sign-update.mjs <file>...")
    process.exit(2)
  }
  const secretKey = parseSecretKey(encoded, process.env.NANOTES_UPDATE_KEY_PASSWORD ?? "")
  const signatures = await Promise.all(files.map(file => signFile(file, secretKey)))
  files.forEach((file, i) => {
    writeFileSync(`${file}.sig`, signatures[i])
    console.log(`signed ${file}`)
  })
}
