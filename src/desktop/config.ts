import type React from 'react';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';

export interface NoteState {
  notesDir: string;
  notePath: string;
  content: string;
  savedContent: string;
  status: 'idle' | 'loading' | 'saving' | 'saved' | 'error';
  message: string;
}

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

export interface HiddenRange {
  from: number;
  to: number;
}

export interface PathSuggestion {
  value: string;
  label: string;
  isDir: boolean;
}

export interface AndroidUpdateCandidate {
  version: string;
  apkUrl: string;
  sha256: string;
}

export interface AndroidUpdaterBridge {
  checkForUpdate: (requestId: string) => void;
  downloadAndInstall: (version: string, apkUrl: string, sha256: string) => void;
}

export type AndroidUpdaterEvent =
  | {
      type: 'check';
      requestId: string;
      available?: boolean;
      version?: string;
      apkUrl?: string;
      sha256?: string;
      error?: string;
    }
  | { type: 'install-started' }
  | { type: 'install-progress'; percent: number }
  | { type: 'install-permission' }
  | { type: 'install-cancelled' }
  | { type: 'install-success' }
  | { type: 'install-error'; message?: string };

export type ShellStyle = React.CSSProperties & {
  '--glass-bg': string;
  '--glass-blur': string;
  '--glass-softness': string;
};

declare global {
  interface Window {
    NanotesAndroidUpdater?: AndroidUpdaterBridge;
    __nanotesAndroidUpdaterEvent?: (event: AndroidUpdaterEvent) => void;
  }
}

export const DEFAULT_NOTES_DIR = '~/.nanotes';
export const DEFAULT_NOTE = 'Untitled.md';
export const SAVE_DELAY_MS = 500;
export const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
export const IS_WINDOWS = /Win/i.test(navigator.userAgent);
export const IS_ANDROID = /Android/i.test(navigator.userAgent);
export const DEFAULT_CLIENT_NAME = IS_MAC ? 'macOS' : IS_WINDOWS ? 'Windows' : IS_ANDROID ? 'Android' : 'Linux';
// Matches the Rust DEFAULT_HOTKEY: Option/Alt + N. Stored in the plugin's
// accelerator format ("alt+KeyN") so it round-trips straight to `set_hotkey`.
export const DEFAULT_HOTKEY = 'alt+KeyN';
export const DEFAULT_GLASS_TINT = '#09090c';
export const DEFAULT_GLASS_OPACITY = 0.32;
export const DEFAULT_GLASS_BLUR = 0;
export const IS_TAURI = '__TAURI_INTERNALS__' in window;

export const HOTKEY_MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

const HOTKEY_SYMBOLS: Record<string, string> = {
  super: '⌘',
  cmd: '⌘',
  command: '⌘',
  meta: '⌘',
  commandorcontrol: '⌘',
  cmdorctrl: '⌘',
  control: '⌃',
  ctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
};

// Display name for the note currently in the editor: the first line with any
// leading "#" markers stripped, mirroring the backend's title_from_content so
// the topbar label matches what search shows. Falls back to "Untitled".
export function titleFromContent(content: string): string {
  const newline = content.indexOf('\n');
  const firstLine = (newline === -1 ? content : content.slice(0, newline)).trim();
  const withoutHeading = firstLine.replace(/^#+/, '').trim();
  return withoutHeading || 'Untitled';
}

// Render an accelerator like "alt+KeyN" as platform-native UI text: "Alt+N" on
// Linux/Windows and compact macOS glyphs like "⌥N" on macOS.
export function formatHotkey(accelerator: string): string {
  const parts = accelerator.split('+').map(part => {
    const normalized = part.toLowerCase();
    if (!IS_MAC) {
      const superLabel = IS_WINDOWS ? 'Win' : 'Super';
      const nonMacLabels: Record<string, string> = {
        super: superLabel,
        cmd: superLabel,
        command: superLabel,
        meta: superLabel,
        commandorcontrol: 'Ctrl',
        cmdorctrl: 'Ctrl',
        control: 'Ctrl',
        ctrl: 'Ctrl',
        alt: 'Alt',
        option: 'Alt',
        shift: 'Shift',
      };
      const nonMacLabel = nonMacLabels[normalized];
      if (nonMacLabel) {
        return nonMacLabel;
      }
    }
    const symbol = HOTKEY_SYMBOLS[normalized];
    if (symbol) {
      return symbol;
    }
    const keyMatch = /^Key([A-Z])$/.exec(part);
    if (keyMatch) {
      return keyMatch[1];
    }
    const digitMatch = /^Digit([0-9])$/.exec(part);
    if (digitMatch) {
      return digitMatch[1];
    }
    return part;
  });
  return parts.join(IS_MAC ? '' : '+');
}

export function appShortcutLabel(key: string): string {
  return `${IS_MAC ? '⌘' : 'Ctrl+'}${key}`;
}

export function glassBackground(tint: string, opacity: number): string {
  const hex = tint.replace('#', '');
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

export function defaultAppConfig(): AppConfig {
  return {
    notesDir: DEFAULT_NOTES_DIR,
    notePath: DEFAULT_NOTE,
    hotkey: DEFAULT_HOTKEY,
    pinnedPaths: [],
    glassTint: DEFAULT_GLASS_TINT,
    glassOpacity: DEFAULT_GLASS_OPACITY,
    glassBlur: DEFAULT_GLASS_BLUR,
    syncUrl: '',
    syncToken: '',
    syncDeviceName: '',
  };
}

export function normalizeAppConfig(config: Partial<AppConfig> | null | undefined): AppConfig {
  const defaults = defaultAppConfig();
  const notesDir = config?.notesDir?.trim() || defaults.notesDir;
  const notePath = config?.notePath?.trim();
  const hotkey = config?.hotkey?.trim() || defaults.hotkey;
  const glassTint = config?.glassTint?.trim();
  const glassOpacity = Number(config?.glassOpacity);
  const glassBlur = Number(config?.glassBlur);
  return {
    notesDir,
    notePath: notePath && !notePath.includes('/') ? notePath : defaults.notePath,
    hotkey,
    pinnedPaths: Array.isArray(config?.pinnedPaths)
      ? config.pinnedPaths.filter(path => typeof path === 'string')
      : [],
    glassTint: glassTint && /^#[0-9a-fA-F]{6}$/.test(glassTint) ? glassTint : defaults.glassTint,
    glassOpacity: Number.isFinite(glassOpacity)
      ? Math.min(0.96, Math.max(0.12, glassOpacity))
      : defaults.glassOpacity,
    glassBlur: Number.isFinite(glassBlur) ? Math.min(40, Math.max(0, glassBlur)) : defaults.glassBlur,
    syncUrl: typeof config?.syncUrl === 'string' ? config.syncUrl.trim() : '',
    syncToken: typeof config?.syncToken === 'string' ? config.syncToken.trim() : '',
    syncDeviceName: typeof config?.syncDeviceName === 'string' ? config.syncDeviceName.trim().slice(0, 80) : '',
  };
}

export function browserPreviewConfig(): AppConfig {
  const pinnedRaw = window.localStorage.getItem('nanotes:browserPreviewPinnedPaths');
  let pinnedPaths: string[] = [];
  try {
    pinnedPaths = pinnedRaw ? (JSON.parse(pinnedRaw) as string[]) : [];
  } catch {
    pinnedPaths = [];
  }
  return normalizeAppConfig({
    notesDir: window.localStorage.getItem('nanotes:browserPreviewNotesDir') ?? undefined,
    notePath: window.localStorage.getItem('nanotes:browserPreviewNotePath') ?? undefined,
    hotkey: window.localStorage.getItem('nanotes:browserPreviewHotkey') ?? undefined,
    pinnedPaths,
    glassTint: window.localStorage.getItem('nanotes:browserPreviewGlassTint') ?? undefined,
    glassOpacity: Number(window.localStorage.getItem('nanotes:browserPreviewGlassOpacity')),
    glassBlur: Number(window.localStorage.getItem('nanotes:browserPreviewGlassBlur')),
    syncDeviceName: window.localStorage.getItem('nanotes:browserPreviewSyncDeviceName') ?? undefined,
  });
}

export function writeBrowserPreviewConfig(config: AppConfig) {
  window.localStorage.setItem('nanotes:browserPreviewNotesDir', config.notesDir);
  window.localStorage.setItem('nanotes:browserPreviewNotePath', config.notePath);
  window.localStorage.setItem('nanotes:browserPreviewHotkey', config.hotkey);
  window.localStorage.setItem('nanotes:browserPreviewPinnedPaths', JSON.stringify(config.pinnedPaths));
  window.localStorage.setItem('nanotes:browserPreviewGlassTint', config.glassTint);
  window.localStorage.setItem('nanotes:browserPreviewGlassOpacity', String(config.glassOpacity));
  window.localStorage.setItem('nanotes:browserPreviewGlassBlur', String(config.glassBlur));
  window.localStorage.setItem('nanotes:browserPreviewSyncDeviceName', config.syncDeviceName);
}

let homeDirCache: string | null = null;

// Expands a leading `~` to the absolute home directory (Tauri only).
export async function expandHome(path: string): Promise<string> {
  if (!path.startsWith('~')) {
    return path;
  }
  if (!homeDirCache) {
    homeDirCache = (await homeDir()).replace(/\/+$/, '');
  }
  return homeDirCache + path.slice(1);
}

export function openExternalUrl(url: string) {
  if (IS_TAURI) {
    void openUrl(url).catch(() => undefined);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

// Opens a Markdown link/image target with whatever the OS associates it with:
// web URLs go to the browser; a local file path (e.g. an image) opens in the
// system default app for that type — the image viewer for a `.png`, etc.
export function openLinkTarget(target: string) {
  const trimmed = target.trim();
  if (/^(https?:|mailto:|data:|blob:|asset:|tauri:)/i.test(trimmed)) {
    openExternalUrl(trimmed);
    return;
  }
  if (!IS_TAURI) {
    window.open(trimmed, '_blank', 'noopener,noreferrer');
    return;
  }
  void expandHome(trimmed)
    .then(path => openPath(path))
    .catch(() => undefined);
}

export async function hideOverlay() {
  if (IS_TAURI) {
    await getCurrentWindow().hide();
  }
}
