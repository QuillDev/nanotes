import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { atomicWrite, expandHome, listNotes, readNote, suggestPaths, writeNote } from "../src/notes.js"

const vault = () => mkdtempSync(join(tmpdir(), "nanotes-vault-"))

test("saving renames the file after the note's first line", () => {
  const dir = vault()
  const first = writeNote(dir, "Untitled.md", "# First Title\n\nbody")
  assert.deepEqual(first, { path: "First Title.md", title: "First Title" })
  const renames = []
  const second = writeNote(dir, first.path, "# Renamed Title\n\nbody", { onRename: (_root, from, to) => renames.push([from, to]) })
  assert.equal(second.path, "Renamed Title.md")
  assert.deepEqual(readdirSync(dir), ["Renamed Title.md"])
  assert.deepEqual(renames, [["First Title.md", "Renamed Title.md"]])
})

test("a new note never overwrites an existing Untitled.md", () => {
  const dir = vault()
  writeFileSync(join(dir, "Untitled.md"), "# Untitled\n\nkeep me")
  const saved = writeNote(dir, "", "fresh")
  assert.notEqual(saved.path, "Untitled.md")
  assert.equal(readFileSync(join(dir, "Untitled.md"), "utf8"), "# Untitled\n\nkeep me")
  assert.equal(readFileSync(join(dir, saved.path), "utf8"), "fresh")
})

test("reading a missing note creates it and paths can't leave the folder", () => {
  const dir = vault()
  assert.equal(readNote(dir, "New.md"), "# Untitled\n\n")
  assert.ok(existsSync(join(dir, "New.md")))
  assert.throws(() => readNote(dir, "../escape.md"), /cannot contain/)
})

test("search returns the ten best fuzzy matches", () => {
  const dir = vault()
  for (let i = 0; i < 12; i += 1) writeNote(dir, `note-${i}.md`, `# Project Alpha ${i}\n\nsearchable body`)
  writeNote(dir, "other.md", "# Groceries\n\neggs")
  const results = listNotes(dir, "pa")
  assert.equal(results.length, 10)
  assert.ok(results.every(note => note.title.startsWith("Project Alpha")))
  assert.deepEqual(listNotes(dir, "eggs gro").map(note => note.title), ["Groceries"])
  assert.deepEqual(listNotes(dir, "zzzz"), [])
})

test("an empty search lists the most recent notes, skipping dotfiles and other files", () => {
  const dir = vault()
  for (let i = 0; i < 12; i += 1) {
    const path = join(dir, `note-${String(i).padStart(2, "0")}.md`)
    atomicWrite(path, `# Note Title ${i}\n\nbody`)
    utimesSync(path, 1000 + i, 1000 + i)
  }
  writeFileSync(join(dir, ".hidden.md"), "# Secret\n")
  writeFileSync(join(dir, "readme.txt"), "# Not markdown\n")
  const results = listNotes(dir, "")
  assert.equal(results.length, 10)
  assert.equal(results[0].title, "Note Title 11")
  assert.ok(results.every(note => note.path.endsWith(".md") && !note.path.startsWith(".")))
})

test("atomic writes leave no temp files behind", () => {
  const dir = vault()
  atomicWrite(join(dir, "Sample.md"), "# First\n")
  atomicWrite(join(dir, "Sample.md"), "# Second\n")
  assert.equal(readFileSync(join(dir, "Sample.md"), "utf8"), "# Second\n")
  assert.deepEqual(readdirSync(dir), ["Sample.md"])
})

test("path completion lists matching folders first and honours the filter", () => {
  const dir = vault()
  mkdirSync(join(dir, "Alpha"))
  writeFileSync(join(dir, "alpha-note.md"), "x")
  writeFileSync(join(dir, "beta.md"), "x")
  assert.deepEqual(suggestPaths(`${dir}/al`).map(s => s.value), [`${dir}/Alpha/`, `${dir}/alpha-note.md`])
  assert.deepEqual(suggestPaths(`${dir}/al`, "dirs").map(s => s.value), [`${dir}/Alpha/`])
  assert.deepEqual(suggestPaths(`${dir}/al`, "files").map(s => s.value), [`${dir}/alpha-note.md`])
  assert.deepEqual(suggestPaths("just a note"), [])
})

test("~ expands to the home folder with either separator", () => {
  assert.equal(expandHome("~/.nanotes", "/users/quill"), "/users/quill/.nanotes")
  assert.equal(expandHome("~\\.nanotes", "/users/quill"), "/users/quill/.nanotes")
  assert.equal(expandHome("~", "/users/quill"), "/users/quill")
  assert.equal(expandHome("~/.nanotes", ""), "~/.nanotes")
})
