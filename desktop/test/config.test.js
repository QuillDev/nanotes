import assert from "node:assert/strict"
import { mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { autostartEntry, normalizeAppConfig, readAppConfig, readWindowFrame, toAccelerator, writeAppConfig, writeWindowFrame } from "../src/config.js"

test("stored hotkeys become Electron accelerators", () => {
  assert.equal(toAccelerator("alt+KeyN"), "Alt+N")
  assert.equal(toAccelerator("super+shift+Digit2"), "Super+Shift+2")
  assert.equal(toAccelerator("control+alt+Space"), "Control+Alt+Space")
  assert.equal(toAccelerator("control+ArrowUp"), "Control+Up")
  assert.equal(toAccelerator("alt+Slash"), "Alt+/")
  assert.equal(toAccelerator("shift+F5"), "Shift+F5")
  assert.throws(() => toAccelerator("hyper+KeyN"), /Invalid hotkey/)
  assert.throws(() => toAccelerator("alt+"), /Invalid hotkey/)
})

test("settings round-trip and bad values fall back to defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "nanotes-config-"))
  assert.equal(readAppConfig(dir).notesDir, "~/.nanotes")
  writeAppConfig(dir, { notesDir: "~/notes", notePath: "a/b.md", glassOpacity: 5, glassBlur: -1, glassTint: "red", syncDeviceName: ` ${"x".repeat(90)} `, pinnedPaths: ["A.md", 3] })
  const config = readAppConfig(dir)
  assert.equal(config.notesDir, "~/notes")
  assert.equal(config.notePath, "Untitled.md")
  assert.equal(config.glassOpacity, 0.96)
  assert.equal(config.glassBlur, 0)
  assert.equal(config.glassTint, "#09090b")
  assert.equal(config.syncDeviceName.length, 80)
  assert.deepEqual(config.pinnedPaths, ["A.md"])
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "settings.json")).mode & 0o777, 0o600)
  writeFileSync(join(dir, "settings.json"), "{not json")
  assert.deepEqual(readAppConfig(dir), normalizeAppConfig({}))
})

test("a saved window frame is reused only while it's on a screen", () => {
  const dir = mkdtempSync(join(tmpdir(), "nanotes-frame-"))
  const screen = { x: 0, y: 0, width: 3024, height: 1898 }
  writeWindowFrame(dir, { x: 2086, y: 696, width: 760, height: 960 })
  assert.deepEqual(readWindowFrame(dir, [screen]), { x: 2086, y: 696, width: 760, height: 960 })
  writeWindowFrame(dir, { x: 2945, y: 100, width: 760, height: 960 })
  assert.equal(readWindowFrame(dir, [screen]), null)
  assert.deepEqual(readWindowFrame(dir, [screen, { x: 3024, y: 0, width: 1920, height: 1080 }]).x, 2945)
  writeFileSync(join(dir, "window-frame.json"), '{"x":0,"y":0,"width":"wide"}')
  assert.equal(readWindowFrame(dir, [screen]), null)
})

test("the Linux autostart entry quotes paths with spaces and keeps launch flags", () => {
  assert.match(autostartEntry("/opt/NaNotes/nanotes"), /^Exec=\/opt\/NaNotes\/nanotes$/m)
  assert.match(autostartEntry("/opt/NaNotes/nanotes", ["--no-sandbox"]), /^Exec=\/opt\/NaNotes\/nanotes --no-sandbox$/m)
  assert.match(autostartEntry("/home/a b/NaNotes.AppImage"), /^Exec="\/home\/a b\/NaNotes.AppImage"$/m)
})
