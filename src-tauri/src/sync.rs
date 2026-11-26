use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{notes_root, relative_note_path, resolve_note_path, sanitize_filename, unique_note_path};

const SYNC_STATE_FILE: &str = ".nanotes-sync.json";
const YJS_STATE_DIR: &str = ".nanotes-yjs";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackedNote {
    path: String,
    #[serde(default)]
    synced_path: String,
    rev: i64,
    content_hash: String,
    pinned: bool,
    deleted: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalSyncState {
    server_url: String,
    cursor: i64,
    notes: HashMap<String, TrackedNote>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteNote {
    id: String,
    path: String,
    content: String,
    content_hash: String,
    pinned: bool,
    rev: i64,
    deleted_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangesResponse {
    rev: i64,
    changes: Vec<RemoteNote>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PushOp {
    id: String,
    base_rev: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pinned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted: Option<bool>,
}

#[derive(Debug, Serialize)]
struct PushRequest {
    ops: Vec<PushOp>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushResultItem {
    id: String,
    status: String,
    note: Option<RemoteNote>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushResponse {
    rev: i64,
    results: Vec<PushResultItem>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStartResult {
    pub code: String,
    pub poll_token: String,
    pub verification_url: String,
    pub expires_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPollResult {
    pub status: String,
    pub token: Option<String>,
    pub device_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub pulled: usize,
    pub pushed: usize,
    pub conflicts: usize,
    pub rev: i64,
    pub pinned_paths: Vec<String>,
    pub active_note_path: Option<String>,
    pub active_note_id: Option<String>,
    pub active_note_changed: bool,
}

fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

fn normalize_server_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("sync server URL is empty".to_string());
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("sync server URL must start with http:// or https://".to_string());
    }
    Ok(trimmed.to_string())
}

fn sync_state_path(root: &Path) -> PathBuf {
    root.join(SYNC_STATE_FILE)
}

fn yjs_state_path(root: &Path, note_id: &str) -> Result<PathBuf, String> {
    let trimmed = note_id.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.starts_with('.')
    {
        return Err("invalid note id".to_string());
    }
    Ok(root.join(YJS_STATE_DIR).join(format!("{trimmed}.bin")))
}

fn load_existing_sync_state(root: &Path) -> Option<LocalSyncState> {
    fs::read_to_string(sync_state_path(root))
        .ok()
        .and_then(|raw| serde_json::from_str::<LocalSyncState>(&raw).ok())
}

pub fn note_id_for_path(notes_dir: &str, note_path: &str) -> Result<Option<String>, String> {
    let trimmed = note_path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let root = notes_root(notes_dir)?;
    let Some(state) = load_existing_sync_state(&root) else {
        return Ok(None);
    };
    for (id, tracked) in state.notes {
        if !tracked.deleted && tracked.path == trimmed {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

pub fn read_yjs_state_hex(notes_dir: &str, note_id: &str) -> Result<Option<String>, String> {
    let root = notes_root(notes_dir)?;
    let path = yjs_state_path(&root, note_id)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    Ok(Some(hex::encode(bytes)))
}

pub fn write_yjs_state_hex(notes_dir: &str, note_id: &str, state_hex: &str) -> Result<(), String> {
    let root = notes_root(notes_dir)?;
    let path = yjs_state_path(&root, note_id)?;
    let bytes = hex::decode(state_hex.trim()).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let tmp = path.with_extension("bin.tmp");
    fs::write(&tmp, bytes).map_err(|error| error.to_string())?;
    fs::rename(&tmp, &path).map_err(|error| error.to_string())
}

pub fn mark_note_synced(
    notes_dir: &str,
    note_id: &str,
    path: &str,
    rev: i64,
    content: &str,
) -> Result<(), String> {
    let root = notes_root(notes_dir)?;
    let Some(mut state) = load_existing_sync_state(&root) else {
        return Ok(());
    };
    let hash = sha256_hex(content);
    let entry = state.notes.entry(note_id.to_string()).or_default();
    if !path.trim().is_empty() {
        entry.path = path.to_string();
        entry.synced_path = path.to_string();
    }
    if rev > entry.rev {
        entry.rev = rev;
    }
    entry.content_hash = hash;
    entry.deleted = false;
    save_sync_state(&root, &state)
}

fn load_sync_state(root: &Path, server_url: &str) -> LocalSyncState {
    let path = sync_state_path(root);
    let parsed = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<LocalSyncState>(&raw).ok());
    match parsed {
        Some(state) if state.server_url == server_url => state,
        _ => LocalSyncState {
            server_url: server_url.to_string(),
            cursor: 0,
            notes: HashMap::new(),
        },
    }
}

fn save_sync_state(root: &Path, state: &LocalSyncState) -> Result<(), String> {
    let content = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    fs::write(sync_state_path(root), content).map_err(|error| error.to_string())
}

/// Keeps the tracked note ID attached to its file when `write_note` renames a note
/// after its heading changes, so sync pushes a rename instead of delete + create.
pub fn track_local_rename(root: &Path, old_path: &str, new_path: &str) {
    if old_path == new_path {
        return;
    }
    let state_path = sync_state_path(root);
    let Ok(raw) = fs::read_to_string(&state_path) else {
        return;
    };
    let Ok(mut state) = serde_json::from_str::<LocalSyncState>(&raw) else {
        return;
    };
    let mut changed = false;
    for tracked in state.notes.values_mut() {
        if !tracked.deleted && tracked.path == old_path {
            tracked.path = new_path.to_string();
            changed = true;
        }
    }
    if changed {
        let _ = save_sync_state(root, &state);
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let builder = reqwest::Client::builder().timeout(Duration::from_secs(20));

    // On Android, rustls-platform-verifier requires JNI initialization and a bundled
    // Kotlin helper or it panics on the first HTTPS request. Use Mozilla's bundled
    // roots directly on Android so HTTPS works out of the box.
    #[cfg(target_os = "android")]
    let builder = {
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
        builder.tls_backend_preconfigured(tls)
    };

    builder.build().map_err(|error| error.to_string())
}

fn default_device_name() -> String {
    let os = if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "android") {
        "Android"
    } else {
        "Linux"
    };
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    match host {
        Some(name) => format!("nanotes ({os} · {name})"),
        None => format!("nanotes ({os})"),
    }
}

fn conflict_copy_path(root: &Path, original_path: &str) -> PathBuf {
    let stem = original_path
        .strip_suffix(".md")
        .or_else(|| original_path.strip_suffix(".MD"))
        .unwrap_or(original_path);
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let label = format!("{} conflict {}", sanitize_filename(stem), secs % 100_000);
    unique_note_path(root, &label, None)
}

fn local_markdown_files(root: &Path) -> Result<HashMap<String, String>, String> {
    let mut files = HashMap::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') || path.is_dir() {
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let rel = relative_note_path(root, &path)?;
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        files.insert(rel, content);
    }
    Ok(files)
}

fn write_remote_file(root: &Path, path: &str, content: &str) -> Result<String, String> {
    let safe_path = resolve_note_path(&root.to_string_lossy(), path)?;
    fs::write(&safe_path, content).map_err(|error| error.to_string())?;
    relative_note_path(root, &safe_path)
}

async fn pull_changes(
    client: &reqwest::Client,
    server_url: &str,
    sync_token: &str,
    root: &Path,
    state: &mut LocalSyncState,
    pinned_set: &mut HashSet<String>,
    active_path: &mut Option<String>,
    live_note_id: Option<&str>,
) -> Result<(usize, usize, bool), String> {
    let url = format!("{server_url}/api/sync/changes?since={}", state.cursor);
    let resp = client
        .get(&url)
        .bearer_auth(sync_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("sync pull failed ({})", resp.status().as_u16()));
    }
    let payload: ChangesResponse = resp.json().await.map_err(|error| error.to_string())?;

    let mut pulled = 0usize;
    let mut conflicts = 0usize;
    let mut active_changed = false;

    for remote in payload.changes {
        let tracked = state.notes.get(&remote.id).cloned();

        if remote.deleted_at.is_some() {
            if let Ok(yjs_path) = yjs_state_path(root, &remote.id) {
                let _ = fs::remove_file(yjs_path);
            }
            if let Some(prev) = tracked {
                if !prev.deleted {
                    let prev_file = root.join(&prev.path);
                    if prev_file.exists() {
                        let local_content = fs::read_to_string(&prev_file).unwrap_or_default();
                        if sha256_hex(&local_content) == prev.content_hash {
                            let _ = crate::move_to_trash(&prev_file).or_else(|_| fs::remove_file(&prev_file).map_err(|error| error.to_string()));
                            pinned_set.remove(&prev.path);
                            if active_path.as_deref() == Some(prev.path.as_str()) {
                                active_changed = true;
                            }
                            pulled += 1;
                        } else {
                            // Modified locally after remote delete: keep local file as a new untracked note.
                            conflicts += 1;
                        }
                    } else {
                        pinned_set.remove(&prev.path);
                    }
                }
            }
            state.notes.insert(
                remote.id,
                TrackedNote {
                    synced_path: remote.path.clone(),
                    path: remote.path,
                    rev: remote.rev,
                    content_hash: remote.content_hash,
                    pinned: false,
                    deleted: true,
                },
            );
            continue;
        }

        // If this note is actively open in a live Yjs WebSocket session, Yjs owns its
        // content merging and local disk mirroring; only reconcile pin/rev metadata here.
        if live_note_id == Some(remote.id.as_str()) {
            let local_path = tracked
                .as_ref()
                .map(|prev| prev.path.clone())
                .unwrap_or_else(|| remote.path.clone());
            if remote.pinned {
                pinned_set.insert(local_path.clone());
            } else {
                pinned_set.remove(&local_path);
            }
            state.notes.insert(
                remote.id,
                TrackedNote {
                    synced_path: remote.path,
                    path: local_path,
                    rev: remote.rev,
                    content_hash: remote.content_hash,
                    pinned: remote.pinned,
                    deleted: false,
                },
            );
            continue;
        }

        match tracked {
            Some(prev) => {
                let prev_file = root.join(&prev.path);
                let local_exists = prev_file.exists();
                let local_content = if local_exists {
                    fs::read_to_string(&prev_file).unwrap_or_default()
                } else {
                    String::new()
                };
                let local_hash = sha256_hex(&local_content);
                let modified_locally = local_exists && local_hash != prev.content_hash && local_hash != remote.content_hash;

                if modified_locally {
                    let copy_path = conflict_copy_path(root, &prev.path);
                    fs::write(&copy_path, &local_content).map_err(|error| error.to_string())?;
                    conflicts += 1;
                }

                if prev.path != remote.path && prev_file.exists() {
                    let _ = fs::remove_file(&prev_file);
                    pinned_set.remove(&prev.path);
                    if active_path.as_deref() == Some(prev.path.as_str()) {
                        *active_path = Some(remote.path.clone());
                        active_changed = true;
                    }
                }

                if !local_exists || local_hash != remote.content_hash || prev.path != remote.path {
                    write_remote_file(root, &remote.path, &remote.content)?;
                    if active_path.as_deref() == Some(remote.path.as_str()) {
                        active_changed = true;
                    }
                    pulled += 1;
                }

                if remote.pinned {
                    pinned_set.insert(remote.path.clone());
                } else {
                    pinned_set.remove(&remote.path);
                }

                state.notes.insert(
                    remote.id,
                    TrackedNote {
                        synced_path: remote.path.clone(),
                        path: remote.path,
                        rev: remote.rev,
                        content_hash: remote.content_hash,
                        pinned: remote.pinned,
                        deleted: false,
                    },
                );
            }
            None => {
                let dest = root.join(&remote.path);
                if dest.exists() {
                    let local_content = fs::read_to_string(&dest).unwrap_or_default();
                    let local_hash = sha256_hex(&local_content);
                    if local_hash != remote.content_hash {
                        // Never fork an empty local scratch file into a conflict copy.
                        if !local_content.trim().is_empty() {
                            let copy_path = conflict_copy_path(root, &remote.path);
                            fs::write(&copy_path, &local_content).map_err(|error| error.to_string())?;
                            conflicts += 1;
                        }
                        write_remote_file(root, &remote.path, &remote.content)?;
                        if active_path.as_deref() == Some(remote.path.as_str()) {
                            active_changed = true;
                        }
                        pulled += 1;
                    }
                } else {
                    write_remote_file(root, &remote.path, &remote.content)?;
                    pulled += 1;
                }

                if remote.pinned {
                    pinned_set.insert(remote.path.clone());
                }

                state.notes.insert(
                    remote.id,
                    TrackedNote {
                        synced_path: remote.path.clone(),
                        path: remote.path,
                        rev: remote.rev,
                        content_hash: remote.content_hash,
                        pinned: remote.pinned,
                        deleted: false,
                    },
                );
            }
        }
    }

    state.cursor = state.cursor.max(payload.rev);
    Ok((pulled, conflicts, active_changed))
}

pub async fn start_pairing(server_url: &str, device_name: Option<&str>) -> Result<PairingStartResult, String> {
    let base = normalize_server_url(server_url)?;
    let client = http_client()?;
    let name = device_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(default_device_name);

    let resp = client
        .post(format!("{base}/api/device/start"))
        .json(&serde_json::json!({ "deviceName": name }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("could not start sign-in ({})", resp.status().as_u16()));
    }
    resp.json::<PairingStartResult>()
        .await
        .map_err(|error| error.to_string())
}

pub async fn poll_pairing(server_url: &str, poll_token: &str) -> Result<PairingPollResult, String> {
    let base = normalize_server_url(server_url)?;
    let client = http_client()?;
    let resp = client
        .post(format!("{base}/api/device/poll"))
        .json(&serde_json::json!({ "pollToken": poll_token }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if resp.status().as_u16() == 410 {
        return Ok(PairingPollResult {
            status: "expired".to_string(),
            token: None,
            device_name: None,
        });
    }
    if !resp.status().is_success() {
        return Err(format!("sign-in poll failed ({})", resp.status().as_u16()));
    }
    resp.json::<PairingPollResult>()
        .await
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
struct RenameDevicePayload {
    device: RenameDeviceInfo,
}

#[derive(Deserialize)]
struct RenameDeviceInfo {
    name: String,
}

pub async fn rename_device(
    server_url: &str,
    sync_token: &str,
    device_name: &str,
) -> Result<String, String> {
    let base = normalize_server_url(server_url)?;
    let token = sync_token.trim();
    if token.is_empty() {
        return Err("sync token is empty".to_string());
    }
    let clean_name: String = device_name.trim().chars().take(80).collect();
    if clean_name.is_empty() {
        return Err("device name is empty".to_string());
    }
    let client = http_client()?;
    let resp = client
        .patch(format!("{base}/api/device"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "name": clean_name }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("could not rename device ({})", resp.status().as_u16()));
    }
    let payload = resp
        .json::<RenameDevicePayload>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(payload.device.name)
}

pub async fn sync_notes(
    notes_dir: &str,
    server_url: &str,
    sync_token: &str,
    pinned_paths: Vec<String>,
    active_note_path: Option<String>,
    live_note_id: Option<String>,
) -> Result<SyncResult, String> {
    let base = normalize_server_url(server_url)?;
    let token = sync_token.trim();
    if token.is_empty() {
        return Err("sync token is empty".to_string());
    }

    let root = notes_root(notes_dir)?;
    let client = http_client()?;
    let mut state = load_sync_state(&root, &base);
    let mut pinned_set: HashSet<String> = pinned_paths.into_iter().collect();
    let mut active_path = active_note_path;
    let live_id_ref = live_note_id.as_deref();

    let (mut pulled, mut conflicts, mut active_changed) = pull_changes(
        &client,
        &base,
        token,
        &root,
        &mut state,
        &mut pinned_set,
        &mut active_path,
        live_id_ref,
    )
    .await?;

    let mut pushed = 0usize;

    // Allow one retry if a concurrent edit raced between pull and push.
    for attempt in 0..2 {
        let local_files = local_markdown_files(&root)?;
        let mut tracked_paths: HashMap<String, String> = HashMap::new();
        let mut ops: Vec<PushOp> = Vec::new();

        for (id, tracked) in &state.notes {
            if tracked.deleted {
                continue;
            }
            tracked_paths.insert(tracked.path.clone(), id.clone());
            let is_live = live_id_ref == Some(id.as_str());
            match local_files.get(&tracked.path) {
                None => {
                    if !is_live {
                        ops.push(PushOp {
                            id: id.clone(),
                            base_rev: tracked.rev,
                            path: Some(tracked.path.clone()),
                            content: None,
                            pinned: None,
                            deleted: Some(true),
                        });
                    }
                }
                Some(content) => {
                    let hash = sha256_hex(content);
                    let pinned = pinned_set.contains(&tracked.path);
                    let renamed = !tracked.synced_path.is_empty() && tracked.synced_path != tracked.path;
                    if is_live {
                        if pinned != tracked.pinned {
                            ops.push(PushOp {
                                id: id.clone(),
                                base_rev: tracked.rev,
                                path: None,
                                content: None,
                                pinned: Some(pinned),
                                deleted: None,
                            });
                        }
                    } else if hash != tracked.content_hash || pinned != tracked.pinned || renamed {
                        ops.push(PushOp {
                            id: id.clone(),
                            base_rev: tracked.rev,
                            path: Some(tracked.path.clone()),
                            content: Some(content.clone()),
                            pinned: Some(pinned),
                            deleted: None,
                        });
                    }
                }
            }
        }

        for (rel_path, content) in &local_files {
            if tracked_paths.contains_key(rel_path) {
                continue;
            }
            let id = Uuid::new_v4().to_string();
            let pinned = pinned_set.contains(rel_path);
            ops.push(PushOp {
                id,
                base_rev: 0,
                path: Some(rel_path.clone()),
                content: Some(content.clone()),
                pinned: Some(pinned),
                deleted: None,
            });
        }

        if ops.is_empty() {
            break;
        }

        let resp = client
            .post(format!("{base}/api/sync/push"))
            .bearer_auth(token)
            .json(&PushRequest { ops })
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("sync push failed ({})", resp.status().as_u16()));
        }
        let push_resp: PushResponse = resp.json().await.map_err(|error| error.to_string())?;

        let mut had_conflict = false;
        for item in push_resp.results {
            if item.status == "conflict" {
                had_conflict = true;
                continue;
            }
            if let Some(note) = item.note {
                if let Some(prev) = state.notes.get(&item.id) {
                    if !prev.deleted && prev.path != note.path && note.deleted_at.is_none() {
                        let old_file = root.join(&prev.path);
                        if old_file.exists() {
                            let _ = fs::rename(&old_file, root.join(&note.path));
                        }
                        if pinned_set.remove(&prev.path) {
                            pinned_set.insert(note.path.clone());
                        }
                        if active_path.as_deref() == Some(prev.path.as_str()) {
                            active_path = Some(note.path.clone());
                            active_changed = true;
                        }
                    }
                }
                state.notes.insert(
                    note.id,
                    TrackedNote {
                        synced_path: note.path.clone(),
                        path: note.path,
                        rev: note.rev,
                        content_hash: note.content_hash,
                        pinned: note.pinned,
                        deleted: note.deleted_at.is_some(),
                    },
                );
                pushed += 1;
            }
        }

        if had_conflict && attempt == 0 {
            let (p, c, ac) = pull_changes(
                &client,
                &base,
                token,
                &root,
                &mut state,
                &mut pinned_set,
                &mut active_path,
                live_id_ref,
            )
            .await?;
            pulled += p;
            conflicts += c;
            active_changed = active_changed || ac;
        } else {
            state.cursor = state.cursor.max(push_resp.rev);
            break;
        }
    }

    save_sync_state(&root, &state)?;

    let mut final_pinned: Vec<String> = pinned_set.into_iter().collect();
    final_pinned.sort();

    let active_note_id = active_path.as_deref().and_then(|target| {
        state
            .notes
            .iter()
            .find(|(_, tracked)| !tracked.deleted && tracked.path == target)
            .map(|(id, _)| id.clone())
    });

    Ok(SyncResult {
        pulled,
        pushed,
        conflicts,
        rev: state.cursor,
        pinned_paths: final_pinned,
        active_note_path: active_path,
        active_note_id,
        active_note_changed: active_changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nanotes-sync-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn track_local_rename_updates_local_path_while_preserving_synced_path() {
        let root = temp_dir("rename");
        let mut state = LocalSyncState {
            server_url: "https://notes.example.com".to_string(),
            cursor: 3,
            notes: HashMap::new(),
        };
        state.notes.insert(
            "id-1".to_string(),
            TrackedNote {
                path: "Old Title.md".to_string(),
                synced_path: "Old Title.md".to_string(),
                rev: 3,
                content_hash: sha256_hex("# Old Title\n"),
                pinned: false,
                deleted: false,
            },
        );
        save_sync_state(&root, &state).unwrap();

        track_local_rename(&root, "Old Title.md", "New Title.md");

        let reloaded = load_sync_state(&root, "https://notes.example.com");
        let tracked = reloaded.notes.get("id-1").unwrap();
        assert_eq!(tracked.path, "New Title.md");
        assert_eq!(tracked.synced_path, "Old Title.md");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn normalize_server_url_rejects_invalid_schemes_and_trims_slash() {
        assert_eq!(
            normalize_server_url("https://notes.example.com/").unwrap(),
            "https://notes.example.com"
        );
        assert!(normalize_server_url("").is_err());
        assert!(normalize_server_url("ftp://notes.example.com").is_err());
    }

    #[test]
    fn http_client_initializes_tls_provider_cleanly() {
        let client = http_client();
        assert!(client.is_ok());
    }

    #[test]
    fn yjs_state_round_trips_and_rejects_path_traversal() {
        let root = temp_dir("yjs");
        let dir = root.to_string_lossy().to_string();

        assert_eq!(read_yjs_state_hex(&dir, "note-123").unwrap(), None);
        write_yjs_state_hex(&dir, "note-123", "deadbeef0102").unwrap();
        assert_eq!(
            read_yjs_state_hex(&dir, "note-123").unwrap().as_deref(),
            Some("deadbeef0102")
        );

        assert!(write_yjs_state_hex(&dir, "../escape", "00").is_err());
        assert!(read_yjs_state_hex(&dir, ".hidden").is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mark_note_synced_and_lookup_keep_note_id_aligned() {
        let root = temp_dir("mark-synced");
        let dir = root.to_string_lossy().to_string();
        let state = LocalSyncState {
            server_url: "https://notes.example.com".to_string(),
            cursor: 1,
            notes: HashMap::new(),
        };
        save_sync_state(&root, &state).unwrap();

        mark_note_synced(&dir, "id-live", "Live Note.md", 4, "# Live Note\n\nHi").unwrap();
        assert_eq!(
            note_id_for_path(&dir, "Live Note.md").unwrap().as_deref(),
            Some("id-live")
        );
        let reloaded = load_sync_state(&root, "https://notes.example.com");
        let entry = reloaded.notes.get("id-live").unwrap();
        assert_eq!(entry.rev, 4);
        assert_eq!(entry.content_hash, sha256_hex("# Live Note\n\nHi"));

        let _ = fs::remove_dir_all(&root);
    }
}
