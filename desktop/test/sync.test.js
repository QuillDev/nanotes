// Syncs two local vaults through the real nanotes server (run with Bun from the repo root).
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { writeNote } from "../src/notes.js"
import { normalizeServerUrl, noteIdForPath, readYjsStateHex, syncNotes, trackLocalRename, writeYjsStateHex } from "../src/sync.js"

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const bun = process.env.BUN ?? "bun"
let server
let base

// The server picks its own free port and prints its URL once it's listening.
before(async () => {
  const hash = execFileSync(bun, ["-e", 'console.log(await Bun.password.hash("pw"))'], { encoding: "utf8" }).trim()
  server = spawn(bun, ["run", "server/main.ts"], {
    cwd: repo,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, NANOTES_DATABASE: join(mkdtempSync(join(tmpdir(), "nanotes-db-")), "db.sqlite"), NANOTES_PASSWORD_HASH: hash, NANOTES_SECURE_COOKIES: "false", NANOTES_PORT: "0" },
  })
  base = await new Promise((resolve, reject) => {
    let output = ""
    server.stdout.on("data", chunk => {
      output += chunk
      const match = /listening on (http:\/\/\S+?)\/?\s/.exec(output)
      if (match) resolve(match[1].replace("localhost", "127.0.0.1"))
    })
    server.once("exit", code => reject(new Error(`server exited (${code}): ${output}`)))
  })
})

after(() => server?.kill())

async function deviceToken(name) {
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ password: "pw" }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ")
  const created = await fetch(`${base}/api/devices`, { method: "POST", headers: { "content-type": "application/json", origin: base, cookie }, body: JSON.stringify({ name }) })
  return (await created.json()).token
}

// Deleted notes go to a "trash" folder outside the vault, like the system trash.
const trashed = []
const trash = async path => {
  trashed.push(readFileSync(path, "utf8"))
  rmSync(path)
}

const sync = (notesDir, syncToken, extra = {}) => syncNotes({ notesDir, serverUrl: `${base}/`, syncToken, pinnedPaths: [], trash, ...extra })
const files = dir => readdirSync(dir).filter(name => !name.startsWith(".")).toSorted()
const read = (dir, name) => readFileSync(join(dir, name), "utf8")

test("two devices exchange new notes, edits, renames, pins, deletes and conflicts", async () => {
  const [laptop, desktop] = [mkdtempSync(join(tmpdir(), "nanotes-a-")), mkdtempSync(join(tmpdir(), "nanotes-b-"))]
  const [tokenA, tokenB] = [await deviceToken("laptop"), await deviceToken("desktop")]

  writeNote(laptop, "", "# Groceries\n\neggs")
  const first = await sync(laptop, tokenA, { pinnedPaths: ["Groceries.md"] })
  assert.equal(first.pushed, 1)

  const pulled = await sync(desktop, tokenB)
  assert.equal(pulled.pulled, 1)
  assert.deepEqual(pulled.pinnedPaths, ["Groceries.md"])
  assert.equal(read(desktop, "Groceries.md"), "# Groceries\n\neggs")

  // An edit and a heading rename on the desktop arrive on the laptop as one renamed note.
  writeNote(desktop, "Groceries.md", "# Shopping\n\neggs\nmilk", { onRename: trackLocalRename })
  await sync(desktop, tokenB, { pinnedPaths: ["Shopping.md"] })
  const renamed = await sync(laptop, tokenA, { pinnedPaths: ["Groceries.md"], activeNotePath: "Groceries.md" })
  assert.deepEqual(files(laptop), ["Shopping.md"])
  assert.equal(read(laptop, "Shopping.md"), "# Shopping\n\neggs\nmilk")
  assert.equal(renamed.activeNotePath, "Shopping.md")
  assert.equal(renamed.activeNoteChanged, true)
  assert.equal(renamed.activeNoteId, noteIdForPath(laptop, "Shopping.md"))

  // Both edit before syncing: the second keeps its text as a conflict copy.
  writeFileSync(join(laptop, "Shopping.md"), "# Shopping\n\nlaptop edit")
  writeFileSync(join(desktop, "Shopping.md"), "# Shopping\n\ndesktop edit")
  await sync(laptop, tokenA, { pinnedPaths: ["Shopping.md"] })
  const conflicted = await sync(desktop, tokenB, { pinnedPaths: ["Shopping.md"] })
  assert.equal(conflicted.conflicts, 1)
  assert.equal(read(desktop, "Shopping.md"), "# Shopping\n\nlaptop edit")
  const copy = files(desktop).find(name => name.includes("conflict"))
  assert.equal(read(desktop, copy), "# Shopping\n\ndesktop edit")

  // A delete on the laptop sends the desktop's unchanged copy to the trash.
  await sync(desktop, tokenB, { pinnedPaths: ["Shopping.md"] })
  await sync(laptop, tokenA)
  rmSync(join(laptop, "Shopping.md"))
  await sync(laptop, tokenA)
  await sync(desktop, tokenB)
  assert.ok(!existsSync(join(desktop, "Shopping.md")))
  assert.ok(trashed.includes("# Shopping\n\nlaptop edit"))
})

test("sync refuses bad server addresses and tokens", async () => {
  assert.equal(normalizeServerUrl(" https://notes.example.test/ "), "https://notes.example.test")
  assert.throws(() => normalizeServerUrl(""), /empty/)
  assert.throws(() => normalizeServerUrl("ftp://notes.example.test"), /http/)
  await assert.rejects(syncNotes({ notesDir: mkdtempSync(join(tmpdir(), "nanotes-c-")), serverUrl: base, syncToken: "nts_wrong", pinnedPaths: [], trash }), /sync pull failed \(401\)/)
})

test("live-editing state is stored per note id and can't escape the vault", () => {
  const dir = mkdtempSync(join(tmpdir(), "nanotes-yjs-"))
  assert.equal(readYjsStateHex(dir, "note-123"), null)
  writeYjsStateHex(dir, "note-123", "deadbeef0102")
  assert.equal(readYjsStateHex(dir, "note-123"), "deadbeef0102")
  assert.throws(() => writeYjsStateHex(dir, "../escape", "00"), /invalid note id/)
  assert.throws(() => readYjsStateHex(dir, ".hidden"), /invalid note id/)
})
