# Architecture

NaNotes separates platform shell behavior from local note-file semantics.

## Platform shell

The desktop shell (`desktop/`, Electron) owns window creation, hotkey registration, and native file access. It exposes the same command bridge the earlier Tauri app had (`window.__TAURI_INTERNALS__`), so the React app calls `@tauri-apps/api` the same way on desktop and on Android, which still runs the Tauri app in `src-tauri/`. The React app should not assume macOS-only APIs directly; platform-specific behavior belongs in the shell.

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
