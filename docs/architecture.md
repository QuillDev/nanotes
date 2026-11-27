# Architecture

NaNotes separates platform shell behavior from local note-file semantics.

## Platform shell

The desktop shell (`desktop/`, Electron) owns window creation, hotkey registration, and native file access. The React app reaches it through `window.nanotesDesktop` (`src/desktop/bridge.ts`); every command, its arguments and its result are defined once in `shared/ipc.ts`, which both the page and the main process's command table (`desktop/src/commands.js`) are type-checked against. The React app should not assume macOS-only APIs directly; platform-specific behavior belongs in the shell.

Android (`android/`) is a Kotlin WebView around the sync server's web app (`src/web-app.tsx`), not the desktop app. It adds only what a browser tab can't: self-updates from GitHub releases through `window.NanotesAndroidUpdater`.

NaNotes runs like a lightweight background utility rather than a document app: it starts hidden, stays out of the Dock/taskbar, and registers a global shortcut so the note overlay opens on demand. Login startup uses the system's login items on macOS and Windows and an XDG autostart entry on Linux.

- global hotkey registration
- always-on-top overlay window configuration
- show/hide/focus behavior
- native file access commands
- future packaging/notarization

## Product core

The React app owns the portable product workflow:

- note editor state
- single-pane live Markdown editing
- debounced autosave
- notes folder/current file settings
- status and conflict UX

## File source of truth

The notes folder remains canonical. NaNotes reads/writes normal `.md` files, one file per note. The first line is treated as the note title; saving renames the file when that first line changes. Search derives from file contents at runtime and returns the top 10 fuzzy matches.

## Linux roadmap

Linux is a shell target, not a rewrite of note semantics. The Electron shell registers the global hotkey on X11; Wayland compositors may block global shortcuts.
