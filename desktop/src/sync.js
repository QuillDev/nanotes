// Note sync with a nanotes server: pull changes since a cursor, push local edits, keep
// conflicting local copies, and track note ids in `<notes>/.nanotes-sync.json`.
import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"

import { atomicWrite, markdownEntries, notesRoot, relativeNotePath, resolveNotePath, sanitizeFilename, uniqueNotePath } from "./notes.js"

const SYNC_STATE_FILE = ".nanotes-sync.json"
const YJS_STATE_DIR = ".nanotes-yjs"
const TIMEOUT_MS = 20_000

export const sha256Hex = content => createHash("sha256").update(content, "utf8").digest("hex")

export function normalizeServerUrl(raw) {
  const trimmed = raw.trim().replace(/\/+$/, "")
  if (!trimmed) throw new Error("sync server URL is empty")
  if (!/^https?:\/\//.test(trimmed)) throw new Error("sync server URL must start with http:// or https://")
  return trimmed
}

const statePath = root => join(root, SYNC_STATE_FILE)

function yjsStatePath(root, noteId) {
  const id = noteId.trim()
  if (!id || /[\\/]/.test(id) || id.includes("..") || id.startsWith(".")) throw new Error("invalid note id")
  return join(root, YJS_STATE_DIR, `${id}.bin`)
}

function readState(root) {
  try {
    const state = JSON.parse(readFileSync(statePath(root), "utf8"))
    return state && typeof state === "object" && state.notes ? state : null
  } catch {
    return null
  }
}

const saveState = (root, state) => atomicWrite(statePath(root), JSON.stringify(state, null, 2))

function loadState(root, serverUrl) {
  const state = readState(root)
  if (state?.serverUrl === serverUrl) return { state, loaded: true }
  return { state: { serverUrl, cursor: 0, notes: {} }, loaded: false }
}

const tracked = note => ({ syncedPath: "", ...note })

export function noteIdForPath(notesDir, notePath) {
  const target = notePath.trim()
  if (!target) return null
  const state = readState(notesRoot(notesDir))
  if (!state) return null
  for (const [id, note] of Object.entries(state.notes)) if (!note.deleted && note.path === target) return id
  return null
}

export function readYjsStateHex(notesDir, noteId) {
  const path = yjsStatePath(notesRoot(notesDir), noteId)
  return existsSync(path) ? readFileSync(path).toString("hex") : null
}

export function writeYjsStateHex(notesDir, noteId, stateHex) {
  const hex = stateHex.trim()
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("invalid hex state")
  atomicWrite(yjsStatePath(notesRoot(notesDir), noteId), Buffer.from(hex, "hex"))
}

export function markNoteSynced(notesDir, noteId, path, rev, content) {
  const root = notesRoot(notesDir)
  const state = readState(root)
  if (!state) return
  const entry = tracked(state.notes[noteId] ?? { path: "", rev: 0, contentHash: "", pinned: false, deleted: false })
  if (path.trim()) {
    entry.path = path
    entry.syncedPath = path
  }
  if (rev > entry.rev) entry.rev = rev
  entry.contentHash = sha256Hex(content)
  entry.deleted = false
  state.notes[noteId] = entry
  saveState(root, state)
}

/** Keeps a note's id on its file when a heading change renames it, so sync pushes a rename. */
export function trackLocalRename(root, oldPath, newPath) {
  if (oldPath === newPath) return
  const state = readState(root)
  if (!state) return
  let changed = false
  for (const note of Object.values(state.notes)) {
    if (!note.deleted && note.path === oldPath) {
      note.path = newPath
      changed = true
    }
  }
  if (changed) saveState(root, state)
}

function defaultDeviceName(platform = process.platform) {
  const os = { darwin: "macOS", win32: "Windows" }[platform] ?? "Linux"
  const host = (process.env.COMPUTERNAME || process.env.HOSTNAME || hostname() || "").trim()
  return host ? `nanotes (${os} · ${host})` : `nanotes (${os})`
}

async function request(url, { method = "GET", token, body } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers["content-type"] = "application/json"
  return fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) })
}

function conflictCopyPath(root, originalPath) {
  const stem = originalPath.replace(/\.(md|MD)$/, "")
  const label = `${sanitizeFilename(stem)} conflict ${Math.floor(Date.now() / 1000) % 100_000}`
  return uniqueNotePath(root, label, null)
}

function localMarkdownFiles(root) {
  const files = new Map()
  for (const entry of markdownEntries(root)) files.set(entry.relative, readFileSync(entry.path, "utf8"))
  return files
}

const readOr = (path, fallback) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return fallback
  }
}

function writeRemoteFile(root, path, content) {
  const target = resolveNotePath(root, path)
  atomicWrite(target, content)
  return relativeNotePath(root, target)
}

// Each pulled change returns { pulled, conflicts, activeChanged } counts for its note.

async function applyRemoteDelete(ctx, remote, prev) {
  const { root, pinned, trash } = ctx
  const result = { pulled: 0, conflicts: 0, activeChanged: false }
  try {
    rmSync(yjsStatePath(root, remote.id), { force: true })
  } catch {
    // Ignore invalid ids from the server.
  }
  if (prev && !prev.deleted) {
    const prevFile = join(root, prev.path)
    if (!existsSync(prevFile)) {
      pinned.delete(prev.path)
    } else if (sha256Hex(readOr(prevFile, "")) === prev.contentHash) {
      await trash(prevFile).catch(() => rmSync(prevFile, { force: true }))
      pinned.delete(prev.path)
      result.activeChanged = ctx.activePath === prev.path
      result.pulled = 1
    } else {
      // Edited here after the remote delete: keep the local file as a new untracked note.
      result.conflicts = 1
    }
  }
  return { result, path: remote.path, extra: { pinned: false, deleted: true } }
}

/** A note open in a live Yjs session: Yjs owns its content; reconcile pin/rev only. */
function applyLiveNote(ctx, remote, prev) {
  const localPath = prev?.path ?? remote.path
  if (remote.pinned) ctx.pinned.add(localPath)
  else ctx.pinned.delete(localPath)
  return { result: { pulled: 0, conflicts: 0, activeChanged: false }, path: localPath, extra: { pinned: remote.pinned, deleted: false } }
}

function applyTrackedChange(ctx, remote, prev) {
  const { root, pinned } = ctx
  const result = { pulled: 0, conflicts: 0, activeChanged: false }
  const prevFile = join(root, prev.path)
  const localExists = existsSync(prevFile)
  const localContent = localExists ? readOr(prevFile, "") : ""
  const localHash = sha256Hex(localContent)
  if (localExists && localHash !== prev.contentHash && localHash !== remote.contentHash) {
    writeFileSync(conflictCopyPath(root, prev.path), localContent)
    result.conflicts = 1
  }
  if (prev.path !== remote.path && existsSync(prevFile)) {
    rmSync(prevFile, { force: true })
    pinned.delete(prev.path)
    if (ctx.activePath === prev.path) {
      ctx.activePath = remote.path
      result.activeChanged = true
    }
  }
  if (!localExists || localHash !== remote.contentHash || prev.path !== remote.path) {
    writeRemoteFile(root, remote.path, remote.content)
    result.activeChanged ||= ctx.activePath === remote.path
    result.pulled = 1
  }
  if (remote.pinned) pinned.add(remote.path)
  else pinned.delete(remote.path)
  return { result, path: remote.path, extra: { pinned: remote.pinned, deleted: false } }
}

function applyNewNote(ctx, remote) {
  const { root } = ctx
  const result = { pulled: 0, conflicts: 0, activeChanged: false }
  const dest = join(root, remote.path)
  const localContent = existsSync(dest) ? readOr(dest, "") : null
  if (localContent === null || sha256Hex(localContent) !== remote.contentHash) {
    // Never fork an empty local scratch file into a conflict copy.
    if (localContent?.trim()) {
      writeFileSync(conflictCopyPath(root, remote.path), localContent)
      result.conflicts = 1
    }
    writeRemoteFile(root, remote.path, remote.content)
    result.activeChanged = localContent !== null && ctx.activePath === remote.path
    result.pulled = 1
  }
  if (remote.pinned) ctx.pinned.add(remote.path)
  return { result, path: remote.path, extra: { pinned: remote.pinned, deleted: false } }
}

function applyRemoteChange(ctx, remote) {
  const prev = ctx.state.notes[remote.id]
  if (remote.deletedAt != null) return applyRemoteDelete(ctx, remote, prev)
  if (ctx.liveNoteId === remote.id) return applyLiveNote(ctx, remote, prev)
  return prev ? applyTrackedChange(ctx, remote, prev) : applyNewNote(ctx, remote)
}

async function pullChanges(ctx) {
  const { base, token, state } = ctx
  const resp = await request(`${base}/api/sync/changes?since=${state.cursor}`, { token })
  if (!resp.ok) throw new Error(`sync pull failed (${resp.status})`)
  const payload = await resp.json()
  const totals = { pulled: 0, conflicts: 0, activeChanged: false }
  for (const remote of payload.changes) {
    const { result, path, extra } = await applyRemoteChange(ctx, remote)
    totals.pulled += result.pulled
    totals.conflicts += result.conflicts
    totals.activeChanged ||= result.activeChanged
    state.notes[remote.id] = { path, syncedPath: remote.path, rev: remote.rev, contentHash: remote.contentHash, ...extra }
  }
  state.cursor = Math.max(state.cursor, payload.rev)
  return totals
}

function pushOps(state, files, pinned, liveNoteId) {
  const trackedPaths = new Set()
  const ops = []
  for (const [id, note] of Object.entries(state.notes)) {
    if (note.deleted) continue
    trackedPaths.add(note.path)
    const isLive = liveNoteId === id
    const content = files.get(note.path)
    if (content === undefined) {
      if (!isLive) ops.push({ id, baseRev: note.rev, path: note.path, deleted: true })
      continue
    }
    const isPinned = pinned.has(note.path)
    const renamed = Boolean(note.syncedPath) && note.syncedPath !== note.path
    if (isLive) {
      if (isPinned !== note.pinned) ops.push({ id, baseRev: note.rev, pinned: isPinned })
    } else if (sha256Hex(content) !== note.contentHash || isPinned !== note.pinned || renamed) {
      ops.push({ id, baseRev: note.rev, path: note.path, content, pinned: isPinned })
    }
  }
  for (const [path, content] of files) {
    if (!trackedPaths.has(path)) ops.push({ id: randomUUID(), baseRev: 0, path, content, pinned: pinned.has(path) })
  }
  return ops
}

/** Records what the server accepted; returns whether any op conflicted and how many applied. */
function applyPushResults(ctx, results) {
  const { root, state } = ctx
  let hadConflict = false
  let applied = 0
  ctx.activeChanged = false
  for (const item of results) {
    if (item.status === "conflict") {
      hadConflict = true
      continue
    }
    const note = item.note
    if (!note) continue
    const prev = state.notes[item.id]
    if (prev && !prev.deleted && prev.path !== note.path && note.deletedAt == null) {
      const oldFile = join(root, prev.path)
      if (existsSync(oldFile)) {
        try {
          renameSync(oldFile, join(root, note.path))
        } catch {
          // Leave the file; the next sync reconciles it.
        }
      }
      if (ctx.pinned.delete(prev.path)) ctx.pinned.add(note.path)
      if (ctx.activePath === prev.path) {
        ctx.activePath = note.path
        ctx.activeChanged = true
      }
    }
    state.notes[note.id] = { path: note.path, syncedPath: note.path, rev: note.rev, contentHash: note.contentHash, pinned: note.pinned, deleted: note.deletedAt != null }
    applied += 1
  }
  return { hadConflict, applied }
}

export async function syncNotes({ notesDir, serverUrl, syncToken, pinnedPaths, activeNotePath, liveNoteId, trash }) {
  const base = normalizeServerUrl(serverUrl)
  const token = syncToken.trim()
  if (!token) throw new Error("sync token is empty")
  const root = notesRoot(notesDir)
  const { state, loaded } = loadState(root, base)
  const initial = JSON.stringify(state)
  const ctx = { base, token, root, state, pinned: new Set(pinnedPaths), activePath: activeNotePath ?? null, liveNoteId: liveNoteId ?? null, trash }

  let { pulled, conflicts, activeChanged } = await pullChanges(ctx)
  let pushed = 0

  // One retry when a concurrent edit raced between pull and push.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ops = pushOps(state, localMarkdownFiles(root), ctx.pinned, ctx.liveNoteId)
    if (ops.length === 0) break
    const resp = await request(`${base}/api/sync/push`, { method: "POST", token, body: { ops } })
    if (!resp.ok) throw new Error(`sync push failed (${resp.status})`)
    const result = await resp.json()
    const { hadConflict, applied } = applyPushResults(ctx, result.results)
    pushed += applied
    activeChanged ||= ctx.activeChanged
    if (hadConflict && attempt === 0) {
      const again = await pullChanges(ctx)
      pulled += again.pulled
      conflicts += again.conflicts
      activeChanged ||= again.activeChanged
    } else {
      state.cursor = Math.max(state.cursor, result.rev)
      break
    }
  }

  if (!loaded || JSON.stringify(state) !== initial) saveState(root, state)

  const activeNoteId = ctx.activePath
    ? (Object.entries(state.notes).find(([, note]) => !note.deleted && note.path === ctx.activePath)?.[0] ?? null)
    : null
  return {
    pulled,
    pushed,
    conflicts,
    rev: state.cursor,
    pinnedPaths: [...ctx.pinned].toSorted(),
    activeNotePath: ctx.activePath,
    activeNoteId,
    activeNoteChanged: activeChanged,
  }
}

export async function startPairing(serverUrl, deviceName) {
  const base = normalizeServerUrl(serverUrl)
  const name = deviceName?.trim() || defaultDeviceName()
  const resp = await request(`${base}/api/device/start`, { method: "POST", body: { deviceName: name } })
  if (!resp.ok) throw new Error(`could not start sign-in (${resp.status})`)
  return resp.json()
}

export async function pollPairing(serverUrl, pollToken) {
  const base = normalizeServerUrl(serverUrl)
  const resp = await request(`${base}/api/device/poll`, { method: "POST", body: { pollToken } })
  if (resp.status === 410) return { status: "expired", token: null, deviceName: null }
  if (!resp.ok) throw new Error(`sign-in poll failed (${resp.status})`)
  return resp.json()
}

export async function renameDevice(serverUrl, syncToken, deviceName) {
  const base = normalizeServerUrl(serverUrl)
  const token = syncToken.trim()
  if (!token) throw new Error("sync token is empty")
  const name = [...deviceName.trim()].slice(0, 80).join("")
  if (!name) throw new Error("device name is empty")
  const resp = await request(`${base}/api/device`, { method: "PATCH", token, body: { name } })
  if (!resp.ok) throw new Error(`could not rename device (${resp.status})`)
  return (await resp.json()).device.name
}
