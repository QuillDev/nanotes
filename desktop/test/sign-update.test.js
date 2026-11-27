import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { test } from "node:test"

import { parsePublicKey, verifySignature } from "../src/minisign.js"
import { parseSecretKey, signFile } from "../scripts/sign-update.mjs"

// Throwaway keys made with the signer the release used before (`signer generate`): one with an
// empty password, like the release key, and one with the password "hunter2".
const here = dirname(fileURLToPath(import.meta.url))
const fixture = name => readFileSync(join(here, "fixtures", name), "utf8")
const script = join(here, "..", "scripts", "sign-update.mjs")

test("a release file signed by sign-update.mjs passes the app's update check, and a changed file fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nanotes-sign-"))
  const file = join(dir, "NaNotes_0.4.0_x64-setup.exe")
  const data = Buffer.alloc(300_000, 7)
  writeFileSync(file, data)

  await promisify(execFile)(process.execPath, [script, file], { env: { ...process.env, NANOTES_UPDATE_KEY: fixture("test-signing.key") } })

  const signature = readFileSync(`${file}.sig`, "utf8")
  const publicKey = parsePublicKey(fixture("test-signing.key.pub"))
  assert.equal(verifySignature(data, signature, publicKey), true)
  data[1234] ^= 1
  assert.equal(verifySignature(data, signature, publicKey), false)
  assert.equal(verifySignature(Buffer.alloc(300_000, 7), signature, parsePublicKey(fixture("test-signing-password.key.pub"))), false)
})

test("a password-protected key signs with its password and refuses a wrong one", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "nanotes-sign-")), "NaNotes_0.4.0_aarch64.app.tar.gz")
  writeFileSync(file, "bundle")
  assert.throws(() => parseSecretKey(fixture("test-signing-password.key"), "wrong"), /wrong password/)
  const signature = await signFile(file, parseSecretKey(fixture("test-signing-password.key"), "hunter2"))
  assert.equal(verifySignature(Buffer.from("bundle"), signature, parsePublicKey(fixture("test-signing-password.key.pub"))), true)
})
