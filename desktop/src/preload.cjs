// Runs before the app's page. The page (src/) talks to the desktop through @tauri-apps/api,
// which calls `window.__TAURI_INTERNALS__`; this recreates the parts it uses on top of one IPC
// channel, so the same frontend runs here unchanged.
const { contextBridge, ipcRenderer } = require("electron")

let deliver = () => {}
ipcRenderer.on("nanotes:callback", (_event, id, payload) => deliver(id, payload))

contextBridge.exposeInMainWorld("nanotesDesktop", {
  invoke: (command, argsJson) => ipcRenderer.invoke("nanotes", command, argsJson),
  onCallback: handler => {
    deliver = handler
  },
  platform: process.platform,
})

contextBridge.executeInMainWorld({
  func: () => {
    const bridge = window.nanotesDesktop
    const callbacks = new Map()
    let nextId = 1
    bridge.onCallback((id, payload) => {
      const entry = callbacks.get(id)
      if (!entry) return
      if (entry.once) callbacks.delete(id)
      entry.callback(payload)
    })
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      // JSON on this side keeps Channel objects' own serialization ("__CHANNEL__:<id>").
      invoke: (command, args) =>
        bridge.invoke(command, JSON.stringify(args ?? {})).then(reply => (reply.ok ? reply.value : Promise.reject(reply.error))),
      transformCallback: (callback, once = false) => {
        const id = nextId++
        callbacks.set(id, { callback: callback ?? (() => {}), once })
        return id
      },
      unregisterCallback: id => callbacks.delete(id),
      convertFileSrc: (path, protocol = "asset") => `${protocol}://localhost/${encodeURIComponent(path)}`,
    }
    // Tauri marked drag strips with an attribute; Electron drags by CSS.
    const style = document.createElement("style")
    style.textContent =
      "[data-tauri-drag-region]{-webkit-app-region:drag}" +
      "[data-tauri-drag-region] :is(button,input,a,[role=option],.island){-webkit-app-region:no-drag}"
    document.addEventListener("DOMContentLoaded", () => document.head.append(style), { once: true })
  },
})
