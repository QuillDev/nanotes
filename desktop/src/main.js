// nanotes on the desktop: the app's own web build in a small always-on-top window, plus what a
// browser tab can't do (the notes folder on disk, a global hotkey, launch at login, updates).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, extname, join, normalize, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { BrowserWindow, app, globalShortcut, ipcMain, net, protocol, screen, shell } from "electron"

import { createCommands } from "./commands.js"
import { IDENTIFIER, autostartEntry, readWindowFrame, toAccelerator, writeWindowFrame } from "./config.js"
import { Updater } from "./update.js"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const MAC = process.platform === "darwin"
const WINDOWS = process.platform === "win32"
const WIDTH = 560
const HEIGHT = 760
const log = message => console.error(`nanotes: ${message}`)

// Settings and the window frame stay where the earlier app kept them.
app.setPath("userData", join(app.getPath("appData"), IDENTIFIER))
if (!app.requestSingleInstanceLock()) app.exit(0)

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  { scheme: "asset", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

/** The built frontend (vite's dist/): packaged next to the app, or the repo's own in development. */
const pagesDir = () => (app.isPackaged ? join(process.resourcesPath, "app") : join(root, "..", "dist"))
const configDir = () => app.getPath("userData")

let mainWindow = null
let hotkey = null
let quitting = false

// ---- the window ----

function workAreas() {
  return screen.getAllDisplays().map(display => display.workArea)
}

function createWindow() {
  const frame = readWindowFrame(configDir(), workAreas())
  mainWindow = new BrowserWindow({
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
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  })
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.setAlwaysOnTop(true, "floating")
  mainWindow.once("ready-to-show", () => showWindow())

  let saveTimer = null
  const saveFrame = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => writeWindowFrame(configDir(), mainWindow.getBounds()), 250)
  }
  mainWindow.on("move", saveFrame)
  mainWindow.on("resize", saveFrame)
  mainWindow.on("close", event => {
    clearTimeout(saveTimer)
    writeWindowFrame(configDir(), mainWindow.getBounds())
    if (quitting) return
    event.preventDefault()
    mainWindow.hide()
  })

  // Links never navigate the app window; they open in the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: "deny" }
  })
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://")) {
      event.preventDefault()
      openExternal(url)
    }
  })

  const devUrl = app.isPackaged ? null : process.env.NANOTES_DEV_URL
  void mainWindow.loadURL(devUrl || "app://nanotes/index.html")
}

function showWindow() {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function toggleWindow() {
  if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide()
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

const pubkey = () => readFileSync(join(root, "pubkey.txt"), "utf8").trim()
let updater = null

const commands = createCommands({
  configDir,
  trash: path => shell.trashItem(path),
  openExternal,
  openPath: path => shell.openPath(path),
  hideWindow: () => mainWindow?.hide(),
  appVersion: () => app.getVersion(),
  relaunch: () => {
    quitting = true
    app.relaunch()
    app.exit(0)
  },
  setHotkey,
  clearHotkey,
  autostartEnabled,
  setAutostart,
  updater: () => updater,
})

ipcMain.handle("nanotes:invoke", async (event, command, args) => {
  // Only the app's own top frame may ask, not an iframe a note's content could load.
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    return { ok: false, error: "not allowed" }
  }
  if (!Object.hasOwn(commands, command)) return { ok: false, error: `${command} is not available in this app` }
  try {
    const onUpdateProgress = progress => event.sender.send("nanotes:update-progress", progress)
    const value = await commands[command](args ?? {}, onUpdateProgress)
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
  // Images in notes: files under the home folder.
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
