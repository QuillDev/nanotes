// Everything the page may ask the desktop app for. desktop/src/commands.js implements each command,
// desktop/src/preload.cjs carries them over one IPC channel, and src/desktop/bridge.ts calls them,
// so tsc checks both ends against this one map.

export interface NoteEntry {
  path: string;
  title: string;
  modifiedMs: number;
}

export interface NoteSaveResult {
  path: string;
  title: string;
}

export interface AppConfig {
  notesDir: string;
  notePath: string;
  hotkey: string;
  pinnedPaths: string[];
  glassTint: string;
  glassOpacity: number;
  glassBlur: number;
  syncUrl: string;
  syncToken: string;
  syncDeviceName: string;
}

export interface PathSuggestion {
  value: string;
  label: string;
  isDir: boolean;
}

export interface PairingStartResult {
  code: string;
  pollToken: string;
  verificationUrl: string;
  expiresAt: number;
}

export interface PairingPollResult {
  status: 'pending' | 'approved' | 'expired';
  token?: string | null;
  deviceName?: string | null;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  conflicts: number;
  rev: number;
  pinnedPaths: string[];
  activeNotePath?: string | null;
  activeNoteId?: string | null;
  activeNoteChanged: boolean;
}

/** An update the desktop app found; `rid` names it for `update_install` and `update_close`. */
export interface AvailableUpdate {
  rid: number;
  currentVersion: string;
  version: string;
  date: string | null;
  body: string | null;
}

export type UpdateProgress =
  | { event: 'Started'; data: { contentLength: number | null } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

type NoteRef = { notesDir: string; notePath: string };

export interface DesktopCommands {
  read_note: { args: NoteRef; result: string };
  write_note: { args: NoteRef & { content: string }; result: NoteSaveResult };
  delete_note: { args: NoteRef; result: null };
  list_notes: { args: { notesDir: string; query: string }; result: NoteEntry[] };
  suggest_paths: { args: { input: string; filter: 'all' | 'dirs' | 'files' }; result: PathSuggestion[] };
  read_app_config: { args: void; result: AppConfig };
  write_app_config: { args: { config: AppConfig }; result: null };
  set_hotkey: { args: { accelerator: string }; result: null };
  clear_hotkey: { args: void; result: null };
  sync_start_pairing: { args: { serverUrl: string; deviceName?: string }; result: PairingStartResult };
  sync_poll_pairing: { args: { serverUrl: string; pollToken: string }; result: PairingPollResult };
  sync_rename_device: { args: { serverUrl: string; syncToken: string; deviceName: string }; result: string };
  sync_now: {
    args: {
      notesDir: string;
      serverUrl: string;
      syncToken: string;
      pinnedPaths: string[];
      activeNotePath: string | null;
      liveNoteId: string | null;
    };
    result: SyncResult;
  };
  sync_note_id_for_path: { args: NoteRef; result: string | null };
  sync_read_yjs_state: { args: { notesDir: string; noteId: string }; result: string | null };
  sync_write_yjs_state: { args: { notesDir: string; noteId: string; stateHex: string }; result: null };
  sync_mark_note_synced: {
    args: { notesDir: string; noteId: string; path: string; rev: number; content: string };
    result: null;
  };
  autostart_is_enabled: { args: void; result: boolean };
  autostart_set: { args: { enabled: boolean }; result: null };
  open_url: { args: { url: string }; result: null };
  open_path: { args: { path: string }; result: null };
  hide_window: { args: void; result: null };
  home_dir: { args: void; result: string };
  app_version: { args: void; result: string };
  relaunch: { args: void; result: null };
  update_check: { args: void; result: AvailableUpdate | null };
  update_install: { args: { rid: number }; result: null };
  update_close: { args: { rid: number }; result: null };
}

export type DesktopCommand = keyof DesktopCommands;
export type DesktopArgs<K extends DesktopCommand> = DesktopCommands[K]['args'] extends void
  ? []
  : [args: DesktopCommands[K]['args']];
export type DesktopResult<K extends DesktopCommand> = DesktopCommands[K]['result'];

/** What the main process implements: one function per command. `update_install` also gets progress. */
export type DesktopCommandHandlers = {
  [K in DesktopCommand]: (
    args: DesktopCommands[K]['args'] extends void ? Record<string, never> : DesktopCommands[K]['args'],
    onUpdateProgress: (progress: UpdateProgress) => void,
  ) => DesktopResult<K> | void | Promise<DesktopResult<K> | void>;
};

// Keyed by command, so a command added to the map above without being listed here fails tsc.
const COMMAND_SET: Record<DesktopCommand, true> = {
  read_note: true,
  write_note: true,
  delete_note: true,
  list_notes: true,
  suggest_paths: true,
  read_app_config: true,
  write_app_config: true,
  set_hotkey: true,
  clear_hotkey: true,
  sync_start_pairing: true,
  sync_poll_pairing: true,
  sync_rename_device: true,
  sync_now: true,
  sync_note_id_for_path: true,
  sync_read_yjs_state: true,
  sync_write_yjs_state: true,
  sync_mark_note_synced: true,
  autostart_is_enabled: true,
  autostart_set: true,
  open_url: true,
  open_path: true,
  hide_window: true,
  home_dir: true,
  app_version: true,
  relaunch: true,
  update_check: true,
  update_install: true,
  update_close: true,
};

export const DESKTOP_COMMANDS = Object.keys(COMMAND_SET) as DesktopCommand[];

/** `window.nanotesDesktop`, set by the preload script in the desktop app only. */
export interface DesktopBridge {
  readonly platform: string;
  invoke<K extends DesktopCommand>(command: K, ...args: DesktopArgs<K>): Promise<DesktopResult<K>>;
  /** Download progress of `update_install`; returns the unsubscribe. */
  onUpdateProgress(listener: (progress: UpdateProgress) => void): () => void;
}

declare global {
  interface Window {
    nanotesDesktop?: DesktopBridge;
  }
}
