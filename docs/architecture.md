# Architecture

NaNotes separates platform shell behavior from local note-file semantics.

## Platform shell

Tauri owns window creation, hotkey registration, and native file access. The React app should not assume macOS-only APIs directly; platform-specific behavior belongs in the Rust shell or a small adapter layer.

NaNotes runs like a lightweight background utility rather than a document app: it starts hidden, stays out of the Dock/taskbar, and registers a global shortcut so the note overlay opens on demand. Login startup is handled through Tauri's autostart plugin instead of a hand-written LaunchAgent.

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

Linux support should be a shell target, not a rewrite of note semantics. Likely options are Tauri on Linux first, with platform-specific handling for global shortcuts and always-on-top behavior under X11/Wayland.
