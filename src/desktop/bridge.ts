import type { DesktopArgs, DesktopCommand, DesktopResult, UpdateProgress } from '../../shared/ipc';

// The desktop app's preload script sets this; in a browser tab it's undefined.
const desktop = window.nanotesDesktop;

export const IS_DESKTOP = desktop !== undefined;

/** Runs a desktop command; rejects with an Error carrying the main process's message. */
export function invoke<K extends DesktopCommand>(command: K, ...args: DesktopArgs<K>): Promise<DesktopResult<K>> {
  if (!desktop) {
    return Promise.reject(new Error(`${command} needs the desktop app`));
  }
  return desktop.invoke(command, ...args);
}

export function onUpdateProgress(listener: (progress: UpdateProgress) => void): () => void {
  return desktop ? desktop.onUpdateProgress(listener) : () => undefined;
}

/** The URL the desktop app serves a local file at (images in notes). */
export function assetUrl(path: string): string {
  return `asset://localhost/${encodeURIComponent(path)}`;
}
