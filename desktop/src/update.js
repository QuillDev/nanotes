// Self-updates from the release's `latest.json`, the same manifest and minisign key the earlier
// app used, so old installs update straight into this one. Windows runs the new
// installer; macOS swaps the .app bundle in place. Linux updates through its package.
import { execFile, spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"

import { verifyStagedSignature } from "./minisign.js"

export const ENDPOINT = "https://github.com/QuillDev/nanotes/releases/latest/download/latest.json"

const parseVersion = version => String(version).replace(/^v/, "").split(/[.+-]/).slice(0, 3).map(Number)

/** Whether `candidate` (x.y.z) is newer than `current`. */
export function newer(candidate, current) {
  const [a, b] = [parseVersion(candidate), parseVersion(current)]
  for (let i = 0; i < 3; i += 1) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  return false
}

/** This install's key in the manifest, or null where the app doesn't replace itself. */
export function platformKey(platform = process.platform, arch = process.arch, packaged = true) {
  if (!packaged) return null
  if (platform === "darwin") return arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64"
  if (platform === "win32") return "windows-x86_64"
  return null
}

/** The update `manifest` offers this install, or null. */
export function pick(manifest, currentVersion, key) {
  const entry = key ? manifest?.platforms?.[key] : null
  if (!entry?.url || !entry?.signature || !manifest.version || !newer(manifest.version, currentVersion)) return null
  return { version: String(manifest.version).replace(/^v/, ""), date: manifest.pub_date ?? null, body: manifest.notes ?? null, url: entry.url, signature: entry.signature }
}

/** A fixed name for the download: never taken from the URL, so it can't leave the temp folder. */
export const downloadName = (platform = process.platform) => ({ darwin: "update.app.tar.gz", win32: "update.exe" })[platform] ?? "update.bin"

/** `publicKey` is the base64 minisign public key (pubkey.txt). */
export class Updater {
  constructor({ currentVersion, publicKey, key = platformKey(), endpoint = ENDPOINT, tempRoot = tmpdir(), quit, log = () => {} }) {
    this.currentVersion = currentVersion
    this.publicKey = publicKey
    this.key = key
    this.endpoint = endpoint
    this.tempRoot = tempRoot
    this.quit = quit
    this.log = log
    this.pending = new Map()
    this.nextRid = 1
  }

  /** The update this install can take (the `update_check` command), or null. */
  async check() {
    const resp = await fetch(this.endpoint, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" } })
    if (!resp.ok) throw new Error(`update check failed (${resp.status})`)
    const update = pick(await resp.json(), this.currentVersion, this.key)
    if (!update) return null
    const rid = this.nextRid++
    this.pending.set(rid, update)
    return { rid, currentVersion: this.currentVersion, version: update.version, date: update.date, body: update.body }
  }

  close(rid) {
    this.pending.delete(rid)
  }

  /** Downloads, verifies and installs update `rid`; `emit` gets Started/Progress/Finished events. */
  async downloadAndInstall(rid, emit) {
    const update = this.pending.get(rid)
    if (!update) throw new Error("update is no longer available")
    const dir = await mkdtemp(join(this.tempRoot, "nanotes-update-"))
    const file = join(dir, downloadName())
    try {
      const resp = await fetch(update.url, { signal: AbortSignal.timeout(15 * 60_000) })
      if (!resp.ok || !resp.body) throw new Error(`update download failed (${resp.status})`)
      const length = Number(resp.headers.get("content-length")) || null
      emit({ event: "Started", data: { contentLength: length } })
      const progress = new Transform({
        transform(chunk, _encoding, done) {
          emit({ event: "Progress", data: { chunkLength: chunk.length } })
          done(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(resp.body), progress, createWriteStream(file))
      emit({ event: "Finished" })
      const valid = await verifyStagedSignature(file, update.signature, this.publicKey, AbortSignal.timeout(5 * 60_000))
      if (!valid) throw new Error("update signature is invalid")
      await this.install(file, dir)
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw error
    }
  }

  async install(file, dir) {
    if (process.platform === "win32") {
      // The installer replaces the app and starts it again once it's done.
      spawn(file, ["/S", "--force-run"], { detached: true, stdio: "ignore" }).unref()
      this.quit()
      return
    }
    if (process.platform === "darwin") {
      await installMacBundle(file, dir, process.execPath)
      return
    }
    throw new Error("this install updates through its package manager")
  }
}

/** Extracts the .app.tar.gz next to the running bundle and swaps it in. */
export async function installMacBundle(archive, dir, execPath) {
  const bundle = execPath.replace(/(\.app)\/Contents\/MacOS\/[^/]+$/, "$1")
  if (bundle === execPath) throw new Error("not running from an app bundle")
  const unpack = join(dir, "unpacked")
  await mkdir(unpack, { recursive: true })
  await promisify(execFile)("tar", ["-xzf", archive, "-C", unpack])
  const fresh = join(unpack, bundle.split("/").at(-1))
  const old = join(dirname(bundle), `.${bundle.split("/").at(-1)}.old-${process.pid}`)
  await rename(bundle, old)
  try {
    await rename(fresh, bundle)
  } catch {
    // Different volume: copy instead, then put the old one back on failure.
    try {
      await promisify(execFile)("cp", ["-R", fresh, bundle])
    } catch (error) {
      await rename(old, bundle)
      throw error
    }
  }
  await rm(old, { recursive: true, force: true })
  await promisify(execFile)("xattr", ["-dr", "com.apple.quarantine", bundle]).catch(() => undefined)
}
