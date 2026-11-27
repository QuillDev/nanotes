// The local note vault: Markdown files in one folder, named after their first line.
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, sep } from "node:path"

import { fuzzyScore } from "./fuzzy.js"

const MAX_SEARCH_RESULTS = 10
const MAX_PATH_SUGGESTIONS = 12

export function expandHome(path, home = homedir()) {
  if (path === "~" && home) return home
  if ((path.startsWith("~/") || path.startsWith("~\\")) && home) return join(home, path.slice(2))
  return path
}

export function notesRoot(notesDir) {
  const root = expandHome(notesDir)
  mkdirSync(root, { recursive: true })
  return root
}

export function resolveNotePath(notesDir, notePath) {
  const root = notesRoot(notesDir)
  if (isAbsolute(notePath) || notePath.includes("..")) {
    throw new Error("note path must be relative to the notes folder and cannot contain ..")
  }
  return join(root, notePath)
}

export function titleFromContent(content) {
  const firstLine = (content.split(/\r?\n/, 1)[0] ?? "").trim()
  return firstLine.replace(/^#+/, "").trim() || "Untitled"
}

export function sanitizeFilename(title) {
  let out = ""
  for (const ch of title) {
    if (/[A-Za-z0-9 \-_.()]/.test(ch)) out += ch
    else if (!out.endsWith(" ")) out += " "
  }
  const cleaned = out.split(/\s+/).filter(Boolean).join(" ").replace(/^\.+|\.+$/g, "").trim()
  return cleaned ? [...cleaned].slice(0, 96).join("") : "Untitled"
}

const realpath = path => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** A free `<title>.md` (or `<title> N.md`) in `root`; `current` keeps its own name. */
export function uniqueNotePath(root, title, current) {
  const stem = sanitizeFilename(title)
  const currentReal = current ? realpath(current) : null
  for (let index = 0; ; index += 1) {
    const candidate = join(root, index === 0 ? `${stem}.md` : `${stem} ${index}.md`)
    if (!existsSync(candidate)) return candidate
    if (currentReal && realpath(candidate) === currentReal) return candidate
  }
}

export const relativeNotePath = (root, path) => relative(root, path).split(sep).join("/")

let tempCounter = 0

/** Write through a dot-prefixed sibling and rename, so scans never see a half-written file. */
export function atomicWrite(path, data, mode = 0o666) {
  let target = path
  try {
    if (lstatSync(path).isSymbolicLink()) target = realpath(path) ?? path
  } catch {
    // Missing file: write it fresh.
  }
  mkdirSync(dirname(target), { recursive: true })
  const name = target.split(/[\\/]/).at(-1) || "file"
  const tmp = join(dirname(target), `.${name}.${process.pid}.${tempCounter++}.${randomBytes(3).toString("hex")}.tmp`)
  try {
    writeFileSync(tmp, data, { mode })
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  try {
    renameSync(tmp, target)
  } catch {
    rmSync(tmp, { force: true })
    writeFileSync(target, data, { mode })
    chmodSync(target, mode & 0o777)
  }
}

/** Top-level `.md` files in `root`, skipping dotfiles. */
export function markdownEntries(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith(".") && !entry.isDirectory() && entry.name.endsWith(".md"))
    .map(entry => {
      const path = join(root, entry.name)
      let modifiedMs = 0
      try {
        modifiedMs = Math.trunc(statSync(path).mtimeMs)
      } catch {
        // Vanished between listing and stat.
      }
      return { path, relative: relativeNotePath(root, path), modifiedMs }
    })
}

export function readNote(notesDir, notePath) {
  const target = resolveNotePath(notesDir, notePath)
  if (!existsSync(target)) writeFileSync(target, "# Untitled\n\n")
  return readFileSync(target, "utf8")
}

/** Saves `content`, renaming the file when its first line changed. */
export function writeNote(notesDir, notePath, content, { onRename } = {}) {
  const root = notesRoot(notesDir)
  // An empty path is a new in-memory note: reserve a fresh name, never reuse "Untitled.md".
  const current = notePath.trim() ? resolveNotePath(notesDir, notePath) : null
  const title = titleFromContent(content)
  const target = uniqueNotePath(root, title, current)
  const targetRel = relativeNotePath(root, target)
  atomicWrite(target, content)
  if (current && current !== target && existsSync(current)) {
    onRename?.(root, relativeNotePath(root, current), targetRel)
    rmSync(current)
  }
  return { path: targetRel, title }
}

export async function deleteNote(notesDir, notePath, trash) {
  const target = resolveNotePath(notesDir, notePath)
  if (existsSync(target)) await trash(target)
}

const firstLine = path => {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? ""
  } catch {
    return ""
  }
}

export function listNotes(notesDir, query) {
  const root = notesRoot(notesDir)
  const needle = query.trim()
  const entries = markdownEntries(root)
  if (!needle) {
    entries.sort((a, b) => b.modifiedMs - a.modifiedMs || a.relative.localeCompare(b.relative))
    return entries.slice(0, MAX_SEARCH_RESULTS).map(entry => ({
      path: entry.relative,
      title: titleFromContent(firstLine(entry.path)),
      modifiedMs: entry.modifiedMs,
    }))
  }
  const scored = []
  for (const entry of entries) {
    let content = ""
    try {
      content = readFileSync(entry.path, "utf8")
    } catch {
      continue
    }
    const title = titleFromContent(content)
    const score = fuzzyScore(needle, `${title} ${entry.relative} ${content}`)
    if (score !== null) scored.push({ score, note: { path: entry.relative, title, modifiedMs: entry.modifiedMs } })
  }
  scored.sort((a, b) => b.score - a.score || b.note.modifiedMs - a.note.modifiedMs)
  return scored.slice(0, MAX_SEARCH_RESULTS).map(item => item.note)
}

const looksLikePath = input =>
  /^(\/|~[\\/]|\.{1,2}[\\/])/.test(input) || /^[A-Za-z]:[\\/]/.test(input)

/** Completions for a path being typed; directories first. */
export function suggestPaths(input, filter = "all", home = homedir()) {
  if (!looksLikePath(input)) return []
  const split = Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\")) + 1
  const base = input.slice(0, split)
  const fragment = input.slice(split)
  const separator = base.endsWith("\\") ? "\\" : "/"
  const lower = fragment.toLowerCase()
  const suggestions = []
  for (const entry of readdirSync(expandHome(base, home) || ".", { withFileTypes: true })) {
    if (entry.name.startsWith(".") && !fragment.startsWith(".")) continue
    if (!entry.name.toLowerCase().startsWith(lower)) continue
    const isDir = entry.isDirectory()
    if ((filter === "dirs" && !isDir) || (filter === "files" && isDir)) continue
    suggestions.push({ value: `${base}${entry.name}${isDir ? separator : ""}`, label: entry.name, isDir })
  }
  suggestions.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.label.toLowerCase().localeCompare(b.label.toLowerCase()))
  return suggestions.slice(0, MAX_PATH_SUGGESTIONS)
}
