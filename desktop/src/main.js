// nanotes on the desktop: the app's own web build in a small always-on-top window, plus what a
// browser tab can't do (the notes folder on disk, a global hotkey, launch at login, updates).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, extname, join, normalize, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { BrowserWindow, app, globalShortcut, ipcMain, net, protocol, screen, shell } from "electron"

import { IDENTIFIER, autostartEntry, readAppConfig, readWindowFrame, toAccelerator, writeAppConfig, writeWindowFrame } from "./config.js"
import { deleteNote, listNotes, readNote, suggestPaths, writeNote } from "./notes.js"
import { markNoteSynced, noteIdForPath, pollPairing, readYjsStateHex, renameDevice, startPairing, syncNotes, trackLocalRename, writeYjsStateHex } from "./sync.js"
import { Updater } from "./update.js"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const MAC = process.platform === "darwin"
const WINDOWS = process.platform === "win32"
const WIDTH = 560
const HEIGHT = 760
const log = message => console.error(`nanotes: ${message}`)

// Settings and the window frame stay where the earlier (Tauri) app kept them.
app.setPath("userData", join(app.getPath("appData"), IDENTIFIER))
if (!app.requestSingleInstanceLock()) app.exit(0)

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  { scheme: "asset", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

/** The built frontend (vite's dist/): packaged next to the app, or the repo's own in development. */
const pagesDir = () => (app.isPackaged ? join(process.resourcesPath, "app") : join(root, "..", "dist"))
const configDir = () => app.getPath("userData")

let window = null
let hotkey = null
let quitting = false

// ---- the window ----

function workAreas() {
  return screen.getAllDisplays().map(display => display.workArea)
}

function createWindow() {
  const frame = readWindowFrame(configDir(), workAreas())
  window = new BrowserWindow({
    width: frame?.width ?? WIDTH,
    height: frame?.height ?? HEIGHT,
    x: frame?.x,
    y: frame?.y,
    minWidth: 380,
    minHeight: 480,
    title: "NaNotes",
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    acceptFirstMouse: true,
    // macOS keeps its traffic lights over the page; Windows draws none, with acrylic behind
    // the page's glass; Linux keeps the system frame.
    ...(MAC ? { titleBarStyle: "hidden" } : {}),
    ...(WINDOWS ? { frame: false, transparent: true, backgroundMaterial: "acrylic", backgroundColor: "#00000000" } : { backgroundColor: "#09090b" }),
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, spellcheck: false },
  })
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  window.setAlwaysOnTop(true, "floating")
  window.once("ready-to-show", () => showWindow())

  let saveTimer = null
  const saveFrame = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => writeWindowFrame(configDir(), window.getBounds()), 250)
  }
  window.on("move", saveFrame)
  window.on("resize", saveFrame)
  window.on("close", event => {
    clearTimeout(saveTimer)
    writeWindowFrame(configDir(), window.getBounds())
    if (quitting) return
    event.preventDefault()
    window.hide()
  })

  // Links never navigate the app window; they open in the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://")) {
      event.preventDefault()
      openExternal(url)
    }
  })

  const devUrl = app.isPackaged ? null : process.env.NANOTES_DEV_URL
  void window.loadURL(devUrl || "app://nanotes/index.html")
}

function showWindow() {
  if (!window) return
  window.show()
  window.focus()
}

function toggleWindow() {
  if (window?.isVisible() && window.isFocused()) window.hide()
  else showWindow()
}

function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
}

// ---- global hotkey ----

function setHotkey(value) {
  const accelerator = toAccelerator(value)
  clearHotkey()
  if (!globalShortcut.register(accelerator, toggleWindow)) throw new Error(`Couldn't register ${value}: another app may be using it`)
  hotkey = accelerator
}

function clearHotkey() {
  if (hotkey) globalShortcut.unregister(hotkey)
  hotkey = null
}

// ---- launch at login ----

const linuxAutostartPath = () => join(app.getPath("appData"), "autostart", "nanotes.desktop")

function autostartEnabled() {
  if (process.platform !== "linux") return app.getLoginItemSettings().openAtLogin
  try {
    readFileSync(linuxAutostartPath())
    return true
  } catch {
    return false
  }
}

function setAutostart(enabled) {
  if (process.platform !== "linux") {
    app.setLoginItemSettings({ openAtLogin: enabled })
    return
  }
  if (!enabled) {
    rmSync(linuxAutostartPath(), { force: true })
    return
  }
  mkdirSync(dirname(linuxAutostartPath()), { recursive: true })
  // Keep --no-sandbox when this copy needed it to start (Ubuntu's restricted user namespaces).
  const args = app.commandLine.hasSwitch("no-sandbox") ? ["--no-sandbox"] : []
  writeFileSync(linuxAutostartPath(), autostartEntry(process.env.APPIMAGE || process.execPath, args))
}

// ---- what the page may ask ----

const trash = path => shell.trashItem(path)
const pubkey = () => readFileSync(join(root, "pubkey.txt"), "utf8").trim()
let updater = null

/** Sends Tauri channel messages: `ref` is "__CHANNEL__:<id>" from the page's Channel object. */
function channel(sender, ref) {
  const id = Number(String(ref ?? "").replace("__CHANNEL__:", ""))
  let index = 0
  return {
    send: message => sender.send("nanotes:callback", id, { index: index++, message }),
    end: () => sender.send("nanotes:callback", id, { index: index++, end: true }),
  }
}

const COMMANDS = {
  read_note: ({ notesDir, notePath }) => readNote(notesDir, notePath),
  write_note: ({ notesDir, notePath, content }) => writeNote(notesDir, notePath, content, { onRename: trackLocalRename }),
  delete_note: ({ notesDir, notePath }) => deleteNote(notesDir, notePath, trash),
  list_notes: ({ notesDir, query }) => listNotes(notesDir, query ?? ""),
  suggest_paths: ({ input, filter }) => suggestPaths(input, filter ?? "all"),
  read_app_config: () => readAppConfig(configDir()),
  write_app_config: ({ config }) => writeAppConfig(configDir(), config),
  set_hotkey: ({ accelerator }) => setHotkey(accelerator),
  clear_hotkey: () => clearHotkey(),
  sync_start_pairing: ({ serverUrl, deviceName }) => startPairing(serverUrl, deviceName),
  sync_poll_pairing: ({ serverUrl, pollToken }) => pollPairing(serverUrl, pollToken),
  sync_rename_device: ({ serverUrl, syncToken, deviceName }) => renameDevice(serverUrl, syncToken, deviceName),
  sync_now: args => syncNotes({ ...args, trash }),
  sync_note_id_for_path: ({ notesDir, notePath }) => noteIdForPath(notesDir, notePath),
  sync_read_yjs_state: ({ notesDir, noteId }) => readYjsStateHex(notesDir, noteId),
  sync_write_yjs_state: ({ notesDir, noteId, stateHex }) => writeYjsStateHex(notesDir, noteId, stateHex),
  sync_mark_note_synced: ({ notesDir, noteId, path, rev, content }) => markNoteSynced(notesDir, noteId, path, rev, content),
  "plugin:autostart|is_enabled": () => autostartEnabled(),
  "plugin:autostart|enable": () => setAutostart(true),
  "plugin:autostart|disable": () => setAutostart(false),
  "plugin:opener|open_url": ({ url }) => openExternal(url),
  "plugin:opener|open_path": async ({ path }) => {
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  },
  "plugin:window|hide": () => window?.hide(),
  "plugin:path|resolve_directory": ({ directory }) => {
    if (directory !== 21) throw new Error("only the home directory is available")
    return homedir()
  },
  "plugin:app|version": () => app.getVersion(),
  "plugin:process|restart": () => {
    quitting = true
    app.relaunch()
    app.exit(0)
  },
  "plugin:updater|check": () => updater.check(),
  "plugin:updater|download_and_install": async ({ rid, onEvent }, event) => {
    const events = channel(event.sender, onEvent)
    try {
      await updater.downloadAndInstall(rid, events.send)
    } finally {
      events.end()
    }
  },
  "plugin:resources|close": ({ rid }) => updater.close(rid),
}

ipcMain.handle("nanotes", async (event, command, argsJson) => {
  // Only the app's own top frame may ask, not an iframe a note's content could load.
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    return { ok: false, error: "not allowed" }
  }
  const handler = COMMANDS[command]
  if (!handler) return { ok: false, error: `${command} is not available in this app` }
  try {
    const value = await handler(JSON.parse(argsJson || "{}"), event)
    return { ok: true, value: value ?? null }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// ---- local pages and files ----

/** Serves `dir`'s files for `request`, refusing anything outside it. */
function serveFrom(dir, relativePath) {
  const target = normalize(join(dir, relativePath))
  if (target !== dir && !target.startsWith(dir + sep)) return new Response("not found", { status: 404 })
  return net.fetch(pathToFileURL(target).toString())
}

function registerProtocols() {
  protocol.handle("app", request => {
    const { pathname } = new URL(request.url)
    const path = decodeURIComponent(pathname)
    return serveFrom(pagesDir(), extname(path) ? path : "/index.html")
  })
  // Images in notes, as Tauri's asset protocol served them: files under the home folder.
  protocol.handle("asset", request => {
    const path = normalize(decodeURIComponent(new URL(request.url).pathname.slice(1)))
    if (!path.startsWith(homedir() + sep)) return new Response("not found", { status: 404 })
    return serveFrom(homedir(), path.slice(homedir().length))
  })
}

// ---- lifecycle ----

app.on("second-instance", () => showWindow())
app.on("activate", () => showWindow())
app.on("before-quit", () => {
  quitting = true
})
app.on("will-quit", () => globalShortcut.unregisterAll())
app.on("window-all-closed", () => {
  // The app lives on through its hotkey; closing only hides the window.
})

async function start() {
  await app.whenReady()
  if (MAC) app.dock?.hide()
  registerProtocols()
  updater = new Updater({
    currentVersion: app.getVersion(),
    publicKey: pubkey(),
    key: app.isPackaged ? undefined : null,
    quit: () => {
      quitting = true
      app.quit()
    },
    log,
  })
  createWindow()
}

start().catch(error => log(error.stack ?? String(error)))
