// @ts-check
// What the page may ask the desktop app for, one handler per command in shared/ipc.ts.
// main.js passes in the parts that need Electron, so this table runs in plain node too.
import { homedir } from "node:os"

import { readAppConfig, writeAppConfig } from "./config.js"
import { deleteNote, listNotes, readNote, suggestPaths, writeNote } from "./notes.js"
import { markNoteSynced, noteIdForPath, pollPairing, readYjsStateHex, renameDevice, startPairing, syncNotes, trackLocalRename, writeYjsStateHex } from "./sync.js"

/**
 * @param {{
 *   configDir: () => string,
 *   trash: (path: string) => Promise<void>,
 *   openExternal: (url: string) => void,
 *   openPath: (path: string) => Promise<string>,
 *   hideWindow: () => void,
 *   appVersion: () => string,
 *   relaunch: () => void,
 *   setHotkey: (accelerator: string) => void,
 *   clearHotkey: () => void,
 *   autostartEnabled: () => boolean,
 *   setAutostart: (enabled: boolean) => void,
 *   updater: () => import("./update.js").Updater,
 * }} desktop
 * @returns {import("../../shared/ipc.ts").DesktopCommandHandlers}
 */
export function createCommands(desktop) {
  const { trash } = desktop
  return {
    read_note: ({ notesDir, notePath }) => readNote(notesDir, notePath),
    write_note: ({ notesDir, notePath, content }) => writeNote(notesDir, notePath, content, { onRename: trackLocalRename }),
    delete_note: ({ notesDir, notePath }) => deleteNote(notesDir, notePath, trash),
    list_notes: ({ notesDir, query }) => listNotes(notesDir, query ?? ""),
    suggest_paths: ({ input, filter }) => suggestPaths(input, filter ?? "all"),
    read_app_config: () => readAppConfig(desktop.configDir()),
    write_app_config: ({ config }) => writeAppConfig(desktop.configDir(), config),
    set_hotkey: ({ accelerator }) => desktop.setHotkey(accelerator),
    clear_hotkey: () => desktop.clearHotkey(),
    sync_start_pairing: ({ serverUrl, deviceName }) => startPairing(serverUrl, deviceName),
    sync_poll_pairing: ({ serverUrl, pollToken }) => pollPairing(serverUrl, pollToken),
    sync_rename_device: ({ serverUrl, syncToken, deviceName }) => renameDevice(serverUrl, syncToken, deviceName),
    sync_now: args => syncNotes({ ...args, trash }),
    sync_note_id_for_path: ({ notesDir, notePath }) => noteIdForPath(notesDir, notePath),
    sync_read_yjs_state: ({ notesDir, noteId }) => readYjsStateHex(notesDir, noteId),
    sync_write_yjs_state: ({ notesDir, noteId, stateHex }) => writeYjsStateHex(notesDir, noteId, stateHex),
    sync_mark_note_synced: ({ notesDir, noteId, path, rev, content }) => markNoteSynced(notesDir, noteId, path, rev, content),
    autostart_is_enabled: () => desktop.autostartEnabled(),
    autostart_set: ({ enabled }) => desktop.setAutostart(enabled),
    open_url: ({ url }) => desktop.openExternal(url),
    open_path: async ({ path }) => {
      const error = await desktop.openPath(path)
      if (error) throw new Error(error)
    },
    hide_window: () => desktop.hideWindow(),
    home_dir: () => homedir(),
    app_version: () => desktop.appVersion(),
    relaunch: () => desktop.relaunch(),
    update_check: () => desktop.updater().check(),
    update_install: ({ rid }, onUpdateProgress) => desktop.updater().downloadAndInstall(rid, onUpdateProgress),
    update_close: ({ rid }) => desktop.updater().close(rid),
  }
}
