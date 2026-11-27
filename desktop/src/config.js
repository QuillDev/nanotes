// App settings, the saved window frame, hotkey strings and the Linux autostart entry.
// Files live in the same config folder the earlier app used, so updates keep them.
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { atomicWrite } from "./notes.js"

export const IDENTIFIER = "moe.quill.nanotes"
export const DEFAULT_HOTKEY = "alt+KeyN"
const DEFAULT_TINT = "#09090b"

export const DEFAULT_CONFIG = Object.freeze({
  notesDir: "~/.nanotes",
  notePath: "Untitled.md",
  hotkey: DEFAULT_HOTKEY,
  pinnedPaths: [],
  glassTint: DEFAULT_TINT,
  glassOpacity: 0.32,
  glassBlur: 0,
  syncUrl: "",
  syncToken: "",
  syncDeviceName: "",
})

const text = (value, fallback) => (typeof value === "string" ? value : fallback)
const number = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback)
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function normalizeAppConfig(raw) {
  const config = raw && typeof raw === "object" ? raw : {}
  const notesDir = text(config.notesDir, "").trim() ? config.notesDir : DEFAULT_CONFIG.notesDir
  const notePath = text(config.notePath, "")
  const hotkey = text(config.hotkey, "")
  const tint = text(config.glassTint, "")
  return {
    notesDir,
    notePath: notePath.trim() && !notePath.includes("/") ? notePath : DEFAULT_CONFIG.notePath,
    hotkey: hotkey.trim() ? hotkey : DEFAULT_HOTKEY,
    pinnedPaths: Array.isArray(config.pinnedPaths) ? config.pinnedPaths.filter(path => typeof path === "string") : [],
    glassTint: /^#[0-9a-fA-F]{6}$/.test(tint) ? tint : DEFAULT_TINT,
    glassOpacity: clamp(number(config.glassOpacity, 0.32), 0.12, 0.96),
    glassBlur: clamp(number(config.glassBlur, 0), 0, 40),
    syncUrl: text(config.syncUrl, ""),
    syncToken: text(config.syncToken, ""),
    syncDeviceName: [...text(config.syncDeviceName, "").trim()].slice(0, 80).join(""),
  }
}

export function readAppConfig(dir) {
  try {
    return normalizeAppConfig(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")))
  } catch {
    return normalizeAppConfig({})
  }
}

export function writeAppConfig(dir, config) {
  // Owner-only: it holds the sync token.
  atomicWrite(join(dir, "settings.json"), JSON.stringify(normalizeAppConfig(config), null, 2), 0o600)
}

// ---- window frame ----

export const isPlausibleFrame = frame =>
  [frame?.x, frame?.y, frame?.width, frame?.height].every(Number.isInteger) && frame.width >= 300 && frame.height >= 300

/** Whether at least 80x80 of `frame` lands inside the work area `area`. */
export function frameIsVisibleOn(frame, area) {
  const width = Math.min(frame.x + frame.width, area.x + area.width) - Math.max(frame.x, area.x)
  const height = Math.min(frame.y + frame.height, area.y + area.height) - Math.max(frame.y, area.y)
  return width >= 80 && height >= 80
}

/** The saved frame, when it's sane and still on one of `areas`. */
export function readWindowFrame(dir, areas) {
  try {
    const frame = JSON.parse(readFileSync(join(dir, "window-frame.json"), "utf8"))
    return isPlausibleFrame(frame) && areas.some(area => frameIsVisibleOn(frame, area)) ? frame : null
  } catch {
    return null
  }
}

export function writeWindowFrame(dir, frame) {
  if (isPlausibleFrame(frame)) atomicWrite(join(dir, "window-frame.json"), JSON.stringify(frame, null, 2))
}

// ---- hotkeys ----

const MODIFIERS = { super: "Super", meta: "Super", cmd: "Super", command: "Super", control: "Control", ctrl: "Control", alt: "Alt", option: "Alt", shift: "Shift", commandorcontrol: "CommandOrControl", cmdorctrl: "CommandOrControl" }

const CODES = {
  Space: "Space", Enter: "Return", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", Delete: "Delete",
  Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";",
  Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
}

function keyFor(code) {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]
  const numpad = /^Numpad([0-9])$/.exec(code)
  if (numpad) return `num${numpad[1]}`
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return CODES[code] ?? null
}

/** The app's stored hotkey ("alt+KeyN", key by physical code) as an Electron accelerator ("Alt+N"). */
export function toAccelerator(hotkey) {
  const parts = hotkey.split("+").map(part => part.trim()).filter(Boolean)
  const key = parts.pop()
  const modifiers = parts.map(part => MODIFIERS[part.toLowerCase()])
  const mapped = key ? keyFor(key) ?? (key.length === 1 ? key.toUpperCase() : null) : null
  if (!mapped || modifiers.some(modifier => !modifier)) throw new Error(`Invalid hotkey '${hotkey}'`)
  return [...modifiers, mapped].join("+")
}

// ---- launch at login (Linux) ----

const quoteArg = part => (/[\s"]/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part)

/** The XDG autostart entry that starts `exec` (with `args`) at login. */
export function autostartEntry(exec, args = []) {
  return ["[Desktop Entry]", "Type=Application", "Name=NaNotes", `Exec=${[exec, ...args].map(quoteArg).join(" ")}`, "X-GNOME-Autostart-enabled=true", ""].join("\n")
}
