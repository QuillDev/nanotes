import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { Updater, newer, pick, platformKey } from "../src/update.js"

const publicKey = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "pubkey.txt"), "utf8").trim()
let server
let base
const manifest = () => ({
  version: "0.4.0",
  notes: "notes",
  pub_date: "2026-11-27T00:00:00Z",
  platforms: { "windows-x86_64": { url: `${base}/NaNotes_0.4.0_x64-setup.exe`, signature: Buffer.from("not a minisign signature").toString("base64") } },
})

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/latest.json") return res.end(JSON.stringify(manifest()))
    res.setHeader("content-length", "1024")
    return res.end(Buffer.alloc(1024))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

test("versions compare numerically", () => {
  assert.equal(newer("0.4.0", "0.3.14"), true)
  assert.equal(newer("0.3.14", "0.3.14"), false)
  assert.equal(newer("v0.10.0", "0.9.9"), true)
  assert.equal(newer("0.3.9", "0.3.14"), false)
})

test("only Mac and Windows app installs replace themselves", () => {
  assert.equal(platformKey("darwin", "arm64"), "darwin-aarch64")
  assert.equal(platformKey("darwin", "x64"), "darwin-x86_64")
  assert.equal(platformKey("win32", "x64"), "windows-x86_64")
  assert.equal(platformKey("linux", "x64"), null)
  assert.equal(platformKey("win32", "x64", false), null)
})

test("the manifest offers an update only for this platform and a newer version", () => {
  base = "https://example.test"
  assert.equal(pick(manifest(), "0.3.14", "windows-x86_64").version, "0.4.0")
  assert.equal(pick(manifest(), "0.4.0", "windows-x86_64"), null)
  assert.equal(pick(manifest(), "0.3.14", "darwin-aarch64"), null)
  assert.equal(pick(manifest(), "0.3.14", null), null)
})

test("a check returns the update and a download with a bad signature never installs", async () => {
  base = `http://127.0.0.1:${server.address().port}`
  let installed = false
  const updater = new Updater({ currentVersion: "0.3.14", publicKey, key: "windows-x86_64", endpoint: `${base}/latest.json`, quit: () => {} })
  updater.install = async () => {
    installed = true
  }
  const found = await updater.check()
  assert.equal(found.version, "0.4.0")
  assert.equal(found.currentVersion, "0.3.14")
  const events = []
  await assert.rejects(updater.downloadAndInstall(found.rid, event => events.push(event.event)), /signature is invalid/)
  assert.equal(installed, false)
  assert.deepEqual([events[0], events.at(-1)], ["Started", "Finished"])
  updater.close(found.rid)
  await assert.rejects(updater.downloadAndInstall(found.rid, () => {}), /no longer available/)
  const current = new Updater({ currentVersion: "0.4.0", publicKey, key: "windows-x86_64", endpoint: `${base}/latest.json`, quit: () => {} })
  assert.equal(await current.check(), null)
})

test("a download URL with encoded path separators never writes outside the temp folder", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "nanotes-update-test-"))
  const tempRoot = join(sandbox, "a", "b")
  mkdirSync(tempRoot, { recursive: true })
  for (const name of ["..%2F..%2Fescape.txt", "..%5C..%5Cescape.txt"]) {
    const updater = new Updater({ currentVersion: "0.3.14", publicKey, key: "windows-x86_64", endpoint: `${base}/latest.json`, tempRoot, quit: () => {} })
    const found = await updater.check()
    updater.pending.get(found.rid).url = `${base}/a/${name}`
    await assert.rejects(updater.downloadAndInstall(found.rid, () => {}), /signature is invalid/)
  }
  const files = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name))
      else files.push(join(dir, entry.name))
    }
  }
  walk(sandbox)
  assert.deepEqual(files, [])
  assert.equal(existsSync(join(tmpdir(), "escape.txt")), false)
})
