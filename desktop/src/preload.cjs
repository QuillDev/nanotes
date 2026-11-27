// Runs before the app's page and gives it `window.nanotesDesktop` (typed in shared/ipc.ts):
// every command goes over one IPC channel, and a failed command rejects with its plain message.
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("nanotesDesktop", {
  platform: process.platform,
  invoke: (command, args) =>
    ipcRenderer.invoke("nanotes:invoke", command, args ?? {}).then(reply => (reply.ok ? reply.value : Promise.reject(new Error(reply.error)))),
  onUpdateProgress: listener => {
    const forward = (_event, progress) => listener(progress)
    ipcRenderer.on("nanotes:update-progress", forward)
    return () => ipcRenderer.off("nanotes:update-progress", forward)
  },
})
