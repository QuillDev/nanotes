# NaNotes

NaNotes is a Nako-styled floating Markdown scratchpad backed by a local notes folder. It's built for people who want a quick, always-a-hotkey-away notepad whose notes stay as plain `.md` files — one file per note, no proprietary database.

Press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> from any macOS app and a dark, pink-on-black overlay appears on top of whatever you're doing. Type Markdown, autosave to a local file, and dismiss it with <kbd>Escape</kbd>. It runs quietly in the background and stays out of the Dock and app switcher.

## Features

- **Global hotkey overlay** — <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> toggles a floating, always-on-top window over any app.
- **Plain Markdown files** — every note is a normal `.md` file in a folder you choose. Edit them with any other tool too.
- **Auto-naming** — a note's filename is derived from its first line and renamed automatically when that line changes.
- **Fuzzy search** — <kbd>Cmd</kbd>+<kbd>P</kbd> searches note titles and contents and shows the top matches.
- **Live Markdown editing** — single-pane CodeMirror editor that styles Markdown inline as you type.
- **Launch at login** — opt in from settings (<kbd>Cmd</kbd>+<kbd>O</kbd>) to keep NaNotes running in the background.

## Requirements

- macOS (Apple Silicon or Intel)
- Xcode Command Line Tools — `xcode-select --install`

## Install

### Homebrew (recommended)

NaNotes is distributed as a build-from-source Homebrew formula, so the install compiles it locally (Homebrew pulls in the Rust and Node build tools for you).

```bash
brew install quilldev/tap/nanotes
```

The build takes a few minutes the first time. When it finishes, launch NaNotes from Spotlight/Launchpad, or add it to your Applications folder:

```bash
ln -sf "$(brew --prefix)/opt/nanotes/NaNotes.app" /Applications/NaNotes.app
```

To update later:

```bash
brew upgrade nanotes
```

### Build from source

If you'd rather build it yourself:

```bash
git clone https://github.com/QuillDev/nanotes.git
cd nanotes
bun install
bun run tauri:build
```

The bundled app is written to `src-tauri/target/release/bundle/macos/NaNotes.app`. Copy it into `/Applications` to install.

## Usage

| Shortcut | Action |
| --- | --- |
| <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> | Show / hide the overlay (works from any app) |
| <kbd>Cmd</kbd>+<kbd>P</kbd> | Fuzzy-search notes |
| <kbd>Cmd</kbd>+<kbd>O</kbd> | Open settings |
| <kbd>Escape</kbd> | Hide the overlay |

On first launch NaNotes creates its notes folder at `~/.nanotes`. Change the location any time from settings; the folder is created if it doesn't exist.

## How notes are stored

The notes folder is the single source of truth. NaNotes reads and writes ordinary `.md` files, one per note. The first line of a note is its title, and saving renames the file when that first line changes. Search is computed from the files on disk at query time, so notes you edit in other apps show up too.

## Development

```bash
bun install
bun run dev      # run the app with hot reload
```

Verify a change before committing:

```bash
bun run check                                    # type-check + build the UI
cargo check --manifest-path src-tauri/Cargo.toml # check the Rust shell
cargo test  --manifest-path src-tauri/Cargo.toml # run the Rust tests
```

## Architecture

See [docs/architecture.md](docs/architecture.md). In short: the Rust/Tauri shell owns platform behavior (window, global hotkey, file I/O), while the React app owns the portable editor, autosave, and settings.

NaNotes is macOS-first today. Linux is a possible future shell target — see the architecture doc for the roadmap.

## License

[MIT](LICENSE)
