use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use nucleo_matcher::{
    pattern::{CaseMatching, Normalization, Pattern},
    Config, Matcher,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WindowEvent};
#[cfg(not(target_os = "linux"))]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const DEFAULT_WINDOW_WIDTH: i32 = 560;
const DEFAULT_WINDOW_HEIGHT: i32 = 760;
/// Default global hotkey that toggles the overlay (Option/Alt + N). The
/// accelerator is parsed by the global-shortcut plugin; the frontend can
/// override it at runtime via the `set_hotkey` command.
#[cfg(not(target_os = "linux"))]
const DEFAULT_HOTKEY: &str = "alt+KeyN";
const MAX_SEARCH_RESULTS: usize = 10;
const MAX_PATH_SUGGESTIONS: usize = 12;

#[derive(Serialize)]
struct NoteEntry {
    path: String,
    title: String,
    #[serde(rename = "modifiedMs")]
    modified_ms: u64,
}

/// Which directory entries `suggest_paths` should return.
#[derive(Deserialize, Clone, Copy, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
enum PathFilter {
    Files,
    Dirs,
    #[default]
    All,
}

impl PathFilter {
    fn keeps(self, is_dir: bool) -> bool {
        match self {
            PathFilter::Files => !is_dir,
            PathFilter::Dirs => is_dir,
            PathFilter::All => true,
        }
    }
}

#[derive(Serialize)]
struct PathSuggestion {
    /// Full text to drop into the input when this suggestion is accepted,
    /// keeping the same `~/`, `/`, or `./` prefix the user typed.
    value: String,
    /// Just the entry's file name, for display.
    label: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
}

#[derive(Serialize)]
struct NoteSaveResult {
    path: String,
    title: String,
}

struct NoteCandidate {
    entry: NoteEntry,
    modified: SystemTime,
    haystack: String,
}

impl AsRef<str> for NoteCandidate {
    fn as_ref(&self) -> &str {
        &self.haystack
    }
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

fn notes_root(notes_dir: &str) -> Result<PathBuf, String> {
    let root = expand_home(notes_dir);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

fn resolve_note_path(notes_dir: &str, note_path: &str) -> Result<PathBuf, String> {
    let root = notes_root(notes_dir)?;
    let relative = Path::new(note_path);
    if relative.is_absolute() || note_path.contains("..") {
        return Err(
            "note path must be relative to the notes folder and cannot contain ..".to_string(),
        );
    }
    Ok(root.join(relative))
}

fn title_from_content(content: &str) -> String {
    let first_line = content.lines().next().unwrap_or("").trim();
    let without_heading = first_line.trim_start_matches('#').trim();
    if without_heading.is_empty() {
        "Untitled".to_string()
    } else {
        without_heading.to_string()
    }
}

fn sanitize_filename(title: &str) -> String {
    let mut sanitized = String::new();
    for character in title.chars() {
        if character.is_ascii_alphanumeric()
            || matches!(character, ' ' | '-' | '_' | '.' | '(' | ')')
        {
            sanitized.push(character);
        } else if !sanitized.ends_with(' ') {
            sanitized.push(' ');
        }
    }

    let sanitized = sanitized
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches('.')
        .trim()
        .to_string();

    if sanitized.is_empty() {
        "Untitled".to_string()
    } else {
        sanitized.chars().take(96).collect()
    }
}

fn unique_note_path(root: &Path, title: &str, current: Option<&Path>) -> PathBuf {
    let stem = sanitize_filename(title);
    let current = current.and_then(|path| path.canonicalize().ok());

    for index in 0.. {
        let file_name = if index == 0 {
            format!("{stem}.md")
        } else {
            format!("{stem} {index}.md")
        };
        let candidate = root.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
        if let (Some(current), Ok(candidate_real)) = (&current, candidate.canonicalize()) {
            if &candidate_real == current {
                return candidate;
            }
        }
    }
    unreachable!("infinite unique filename search should always return")
}

fn relative_note_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|error| error.to_string())
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
}

fn collect_notes(root: &Path) -> Result<Vec<NoteCandidate>, String> {
    let mut notes = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') || path.is_dir() {
            continue;
        }
        if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
            continue;
        }

        let content = fs::read_to_string(&path).unwrap_or_default();
        let title = title_from_content(&content);
        let relative = relative_note_path(root, &path)?;
        let modified = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let modified_ms = modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        let haystack = format!("{title} {relative} {content}").to_lowercase();
        notes.push(NoteCandidate {
            entry: NoteEntry {
                path: relative,
                title,
                modified_ms,
            },
            modified,
            haystack,
        });
    }
    Ok(notes)
}

#[tauri::command]
fn read_note(notes_dir: String, note_path: String) -> Result<String, String> {
    let target = resolve_note_path(&notes_dir, &note_path)?;
    if !target.exists() {
        fs::write(&target, "# Untitled\n\n").map_err(|error| error.to_string())?;
    }
    fs::read_to_string(&target).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_note(
    notes_dir: String,
    note_path: String,
    content: String,
) -> Result<NoteSaveResult, String> {
    let root = notes_root(&notes_dir)?;
    // An empty path means a brand-new note that was never written to disk (the
    // frontend creates new notes purely in memory). Treating its current path as
    // None means `unique_note_path` reserves a fresh filename instead of matching
    // — and potentially overwriting — a real note that happens to be "Untitled".
    let current = if note_path.trim().is_empty() {
        None
    } else {
        Some(resolve_note_path(&notes_dir, &note_path)?)
    };
    let title = title_from_content(&content);
    let target = unique_note_path(&root, &title, current.as_deref());

    fs::write(&target, content).map_err(|error| error.to_string())?;
    if let Some(current) = current {
        if current != target && current.exists() {
            fs::remove_file(&current).map_err(|error| error.to_string())?;
        }
    }

    Ok(NoteSaveResult {
        path: relative_note_path(&root, &target)?,
        title,
    })
}

#[tauri::command]
fn delete_note(notes_dir: String, note_path: String) -> Result<(), String> {
    let target = resolve_note_path(&notes_dir, &note_path)?;
    if !target.exists() {
        return Ok(());
    }
    trash::delete(&target).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_notes(notes_dir: String, query: String) -> Result<Vec<NoteEntry>, String> {
    let root = notes_root(&notes_dir)?;
    let mut notes = collect_notes(&root)?;
    let query = query.trim().to_string();

    if query.is_empty() {
        notes.sort_by_key(|candidate| std::cmp::Reverse(candidate.modified));
        return Ok(notes
            .into_iter()
            .take(MAX_SEARCH_RESULTS)
            .map(|candidate| candidate.entry)
            .collect());
    }

    let mut matcher = Matcher::new(Config::DEFAULT);
    let pattern = Pattern::parse(&query, CaseMatching::Ignore, Normalization::Smart);
    let mut scored = pattern.match_list(notes, &mut matcher);
    // match_list already orders by descending score; keep that, but break ties
    // with most-recently-modified so equally-good matches stay deterministic.
    scored.sort_by(|(candidate_a, score_a), (candidate_b, score_b)| {
        score_b
            .cmp(score_a)
            .then_with(|| candidate_b.modified.cmp(&candidate_a.modified))
    });

    Ok(scored
        .into_iter()
        .take(MAX_SEARCH_RESULTS)
        .map(|(candidate, _)| candidate.entry)
        .collect())
}

#[tauri::command]
fn suggest_paths(
    input: String,
    filter: Option<PathFilter>,
) -> Result<Vec<PathSuggestion>, String> {
    // Only offer completions once the input clearly looks like a filesystem
    // path. Anything else (a bare folder name, empty string) is left alone.
    let looks_like_path = input.starts_with('/')
        || input.starts_with("~/")
        || input.starts_with("./")
        || input.starts_with("../");
    if !looks_like_path {
        return Ok(Vec::new());
    }

    let filter = filter.unwrap_or_default();

    // Split into the directory portion (through the last '/') and the fragment
    // being typed after it. We complete entries of the directory that match the
    // fragment as a case-insensitive prefix.
    let split_at = input.rfind('/').map(|index| index + 1).unwrap_or(0);
    let (base, fragment) = input.split_at(split_at);
    let scan_dir = expand_home(base);

    let fragment_lower = fragment.to_lowercase();
    let mut suggestions = Vec::new();
    for entry in fs::read_dir(&scan_dir).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        // Hide dotfiles unless the user is explicitly typing a leading dot.
        if name.starts_with('.') && !fragment.starts_with('.') {
            continue;
        }
        if !name.to_lowercase().starts_with(&fragment_lower) {
            continue;
        }
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if !filter.keeps(is_dir) {
            continue;
        }
        let mut value = format!("{base}{name}");
        if is_dir {
            value.push('/');
        }
        suggestions.push(PathSuggestion {
            value,
            label: name,
            is_dir,
        });
    }

    // Directories first, then alphabetical, so folder drilling stays on top.
    suggestions.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
    });
    suggestions.truncate(MAX_PATH_SUGGESTIONS);
    Ok(suggestions)
}

fn show_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(true);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(not(target_os = "linux"))]
fn toggle_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => show_overlay(app),
        }
    }
}

fn hide_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn configure_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(true);
        // Size in *logical* points so it matches tauri.conf (and the drag minimum,
        // which is logical). Using PhysicalSize here made the window open at half
        // size on a 2x display — below the minimum the user could drag to.
        let width = f64::from(DEFAULT_WINDOW_WIDTH);
        let height = f64::from(DEFAULT_WINDOW_HEIGHT);
        let _ = window.set_size(LogicalSize::new(width, height));
        if let Some(monitor) = window.current_monitor().ok().flatten() {
            let monitor_size = monitor.size().to_logical::<f64>(monitor.scale_factor());
            let x = ((monitor_size.width - width) / 2.0).max(40.0);
            let y = ((monitor_size.height - height) / 2.0).max(40.0);
            let _ = window.set_position(LogicalPosition::new(x, y));
        }
    }
}

/// Register `accelerator` as the overlay toggle, replacing any shortcut that was
/// previously registered. The accelerator uses the plugin's textual format, e.g.
/// "alt+KeyN" or "super+shift+KeyN".
#[cfg(not(target_os = "linux"))]
fn apply_hotkey(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|err| format!("Invalid hotkey '{accelerator}': {err:?}"))?;
    let global_shortcut = app.global_shortcut();
    // Clear the previous binding so re-registering a new combo doesn't leave the
    // old one live (and so the same combo isn't double-registered, which errors).
    let _ = global_shortcut.unregister_all();
    let app_handle = app.clone();
    global_shortcut
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_overlay(&app_handle);
            }
        })
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
#[cfg(not(target_os = "linux"))]
fn set_hotkey(app: AppHandle, accelerator: String) -> Result<(), String> {
    apply_hotkey(&app, &accelerator)
}

#[tauri::command]
#[cfg(target_os = "linux")]
fn set_hotkey(_app: AppHandle, _accelerator: String) -> Result<(), String> {
    Ok(())
}

/// Temporarily unregister the overlay shortcut so the webview can capture key
/// presses (e.g. while the settings hotkey recorder is listening) instead of the
/// OS swallowing the combo to toggle the window.
#[tauri::command]
#[cfg(not(target_os = "linux"))]
fn clear_hotkey(app: AppHandle) {
    let _ = app.global_shortcut().unregister_all();
}

#[tauri::command]
#[cfg(target_os = "linux")]
fn clear_hotkey(_app: AppHandle) {}

#[cfg(not(target_os = "linux"))]
fn register_hotkey(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    apply_hotkey(app, DEFAULT_HOTKEY)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn register_hotkey(_app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_note,
            write_note,
            list_notes,
            delete_note,
            suggest_paths,
            set_hotkey,
            clear_hotkey
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                if let Some(window) = app.get_webview_window("main") {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                    // Keep the blur pinned to the Active state so focus changes don't
                    // shift the window's translucency (the default follows key-window
                    // state, which made the overlay flicker on focus/blur).
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::HudWindow,
                        Some(NSVisualEffectState::Active),
                        None,
                    );
                }
            }
            configure_window(app.handle());
            // Linux desktop environments, especially Wayland compositors, may not
            // deliver process-registered global shortcuts consistently. On Linux,
            // compositor keybinds should launch NaNotes and the app should show
            // immediately instead of blocking startup while registering a shortcut.
            #[cfg(target_os = "linux")]
            show_overlay(app.handle());
            if let Err(error) = register_hotkey(app.handle()) {
                eprintln!("failed to register NaNotes global hotkey: {error}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building NaNotes")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
                hide_overlay(app_handle);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_notes_dir(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("nanotes-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    #[test]
    fn write_note_renames_file_from_first_line() {
        let notes_dir = temp_notes_dir("rename");
        let first = write_note(
            notes_dir.clone(),
            "Untitled.md".to_string(),
            "# First Title\n\nbody".to_string(),
        )
        .unwrap();
        assert_eq!(first.path, "First Title.md");
        assert!(Path::new(&notes_dir).join("First Title.md").exists());

        let second = write_note(
            notes_dir.clone(),
            first.path,
            "# Renamed Title\n\nbody".to_string(),
        )
        .unwrap();
        assert_eq!(second.path, "Renamed Title.md");
        assert!(Path::new(&notes_dir).join("Renamed Title.md").exists());
        assert!(!Path::new(&notes_dir).join("First Title.md").exists());
    }

    #[test]
    fn write_note_with_empty_path_does_not_clobber_existing_untitled() {
        let notes_dir = temp_notes_dir("new-note");
        // A real note already lives at Untitled.md.
        fs::write(Path::new(&notes_dir).join("Untitled.md"), "# Untitled\n\nkeep me").unwrap();

        // Saving a brand-new note (empty current path) must reserve a fresh name
        // rather than overwrite the existing Untitled.md.
        let saved = write_note(notes_dir.clone(), String::new(), "fresh".to_string()).unwrap();
        assert_ne!(saved.path, "Untitled.md");
        assert_eq!(
            fs::read_to_string(Path::new(&notes_dir).join("Untitled.md")).unwrap(),
            "# Untitled\n\nkeep me",
        );
        assert_eq!(
            fs::read_to_string(Path::new(&notes_dir).join(&saved.path)).unwrap(),
            "fresh",
        );
    }

    #[test]
    fn suggest_paths_completes_directory_entries() {
        let dir = temp_notes_dir("suggest");
        fs::create_dir_all(Path::new(&dir).join("Alpha")).unwrap();
        fs::write(Path::new(&dir).join("alpha-note.md"), "x").unwrap();
        fs::write(Path::new(&dir).join("beta.md"), "x").unwrap();

        let base = format!("{dir}/al");
        let results = suggest_paths(base.clone(), None).unwrap();
        let values: Vec<_> = results.iter().map(|s| s.value.as_str()).collect();
        assert_eq!(values, vec![
            format!("{dir}/Alpha/").as_str(),
            format!("{dir}/alpha-note.md").as_str(),
        ]);
        assert!(results[0].is_dir);
        assert!(!results[1].is_dir);

        // The Dirs filter drops the file, keeping only the directory; Files
        // does the opposite.
        let dirs = suggest_paths(base.clone(), Some(PathFilter::Dirs)).unwrap();
        let dir_values: Vec<_> = dirs.iter().map(|s| s.value.as_str()).collect();
        assert_eq!(dir_values, vec![format!("{dir}/Alpha/").as_str()]);

        let files = suggest_paths(base, Some(PathFilter::Files)).unwrap();
        let file_values: Vec<_> = files.iter().map(|s| s.value.as_str()).collect();
        assert_eq!(file_values, vec![format!("{dir}/alpha-note.md").as_str()]);
    }

    #[test]
    fn suggest_paths_ignores_non_path_input() {
        assert!(suggest_paths("just a note".to_string(), None).unwrap().is_empty());
    }

    #[test]
    fn list_notes_returns_top_fuzzy_matches() {
        let notes_dir = temp_notes_dir("fuzzy");
        for index in 0..12 {
            let title = format!("Project Alpha {index}");
            let _ = write_note(
                notes_dir.clone(),
                format!("note-{index}.md"),
                format!("# {title}\n\nsearchable body"),
            )
            .unwrap();
        }

        let results = list_notes(notes_dir, "pa".to_string()).unwrap();
        assert_eq!(results.len(), 10);
        assert!(results
            .iter()
            .all(|note| note.title.starts_with("Project Alpha")));
    }
}
