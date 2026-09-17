#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const SIDECAR: &str = "opencode-cli";
const READY_TIMEOUT: Duration = Duration::from_secs(90);

struct Ready {
    url: String,
    username: String,
    password: String,
}

#[derive(Default)]
struct ShellState {
    child: Mutex<Option<CommandChild>>,
    ready: Mutex<Option<Ready>>,
    window_id: Mutex<Option<String>>,
    pending_deep_links: Mutex<Vec<String>>,
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| format!("addr: {e}"))?.port();
    drop(listener);
    Ok(port)
}

fn http_health(port: u16, password: &str) -> Result<u16, String> {
    let auth = base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}"));
    let request = format!(
        "GET /global/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Basic {auth}\r\nConnection: close\r\n\r\n"
    );
    let addr = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|e| format!("addr: {e}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
        .map_err(|e| format!("connect: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .map_err(|e| format!("read: {e}"))?;
    let text = String::from_utf8_lossy(&buf);
    Ok(text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0))
}

/// Spawns the bundled opencode server as a sidecar and waits until it is healthy.
/// Runs on a dedicated thread so the window can paint the loading state immediately.
fn start_sidecar(app: &AppHandle) {
    let state = app.state::<ShellState>();
    let port = match free_port() {
        Ok(port) => port,
        Err(error) => {
            eprintln!("[shell] no free port: {error}");
            return;
        }
    };
    let username = "opencode".to_string();
    let password = uuid::Uuid::new_v4().to_string();
    let state_dir = app.path().app_local_data_dir().ok().map(|dir| dir.join("state"));
    if let Some(dir) = &state_dir {
        let _ = std::fs::create_dir_all(dir);
    }

    let spawned = app
        .shell()
        .sidecar(SIDECAR)
        .map_err(|error| format!("sidecar lookup: {error}"))
        .and_then(|command| {
            let command = command
                .args([
                    "serve",
                    "--hostname",
                    "127.0.0.1",
                    "--port",
                    &port.to_string(),
                    "--print-logs",
                ])
                .env("OPENCODE_SERVER_USERNAME", username.clone())
                .env("OPENCODE_SERVER_PASSWORD", password.clone());
            let command = match &state_dir {
                Some(dir) => command.env("XDG_STATE_HOME", dir.to_string_lossy().to_string()),
                None => command,
            };
            command.spawn().map_err(|error| format!("spawn: {error}"))
        });

    let (mut events, child) = match spawned {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[shell] sidecar failed: {error}");
            return;
        }
    };
    println!("[shell] sidecar spawned pid={} port={port}", child.pid());
    *state.child.lock().unwrap() = Some(child);

    // Drain sidecar output so its pipes never block.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => println!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end()),
                CommandEvent::Stderr(line) => eprintln!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end()),
                _ => {}
            }
        }
    });

    let started = Instant::now();
    loop {
        if started.elapsed() > READY_TIMEOUT {
            eprintln!("[shell] server did not become healthy within {}s", READY_TIMEOUT.as_secs());
            return;
        }
        if let Ok(200) = http_health(port, &password) {
            let url = format!("http://127.0.0.1:{port}");
            println!("[shell] server ready at {url}");
            *app.state::<ShellState>().ready.lock().unwrap() = Some(Ready {
                url: url.clone(),
                username,
                password,
            });
            let _ = app.emit("server-ready", json!({ "url": url }));
            return;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

#[tauri::command]
fn await_initialization(state: State<'_, ShellState>) -> Result<Value, String> {
    let deadline = Instant::now() + READY_TIMEOUT + Duration::from_secs(10);
    loop {
        if let Some(ready) = state.ready.lock().unwrap().as_ref() {
            return Ok(json!({
                "url": ready.url,
                "username": ready.username,
                "password": ready.password,
            }));
        }
        if Instant::now() >= deadline {
            return Err("server did not become ready".into());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[tauri::command]
fn consume_initial_deep_links(state: State<'_, ShellState>) -> Vec<String> {
    std::mem::take(&mut *state.pending_deep_links.lock().unwrap())
}

#[tauri::command]
fn get_window_id(state: State<'_, ShellState>) -> String {
    state.window_id.lock().unwrap().clone().unwrap_or_default()
}

// Keep the same on-disk shape as the Electron shell: one JSON object per store,
// written to `<app data>/<name>` with no extension.
fn store_file(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| format!("app data dir: {error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("mkdir: {error}"))?;
    Ok(dir.join(name))
}

fn store_read(app: &AppHandle, name: &str) -> Result<serde_json::Map<String, Value>, String> {
    let path = store_file(app, name)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => Ok(map),
            Ok(_) => Ok(serde_json::Map::new()),
            Err(error) => Err(format!("parse {}: {error}", path.display())),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Map::new()),
        Err(error) => Err(format!("read {}: {error}", path.display())),
    }
}

fn store_write(app: &AppHandle, name: &str, map: &serde_json::Map<String, Value>) -> Result<(), String> {
    let path = store_file(app, name)?;
    let text = serde_json::to_string_pretty(&Value::Object(map.clone())).map_err(|error| format!("encode: {error}"))?;
    std::fs::write(&path, text).map_err(|error| format!("write {}: {error}", path.display()))
}

#[tauri::command]
fn store_get(app: AppHandle, name: String, key: String) -> Result<Option<String>, String> {
    println!("[store] get {name} {key}");
    let map = store_read(&app, &name)?;
    Ok(map.get(&key).map(|value| match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }))
}

#[tauri::command]
fn store_set(app: AppHandle, name: String, key: String, value: String) -> Result<(), String> {
    println!("[store] set {name} {key}");
    let mut map = store_read(&app, &name)?;
    map.insert(key, Value::String(value));
    store_write(&app, &name, &map)
}

#[tauri::command]
fn store_delete(app: AppHandle, name: String, key: String) -> Result<(), String> {
    let mut map = store_read(&app, &name)?;
    map.remove(&key);
    store_write(&app, &name, &map)
}

#[tauri::command]
fn store_clear(app: AppHandle, name: String) -> Result<(), String> {
    store_write(&app, &name, &serde_json::Map::new())
}

#[tauri::command]
fn store_keys(app: AppHandle, name: String) -> Result<Vec<String>, String> {
    Ok(store_read(&app, &name)?.keys().cloned().collect())
}

#[tauri::command]
fn store_length(app: AppHandle, name: String) -> Result<usize, String> {
    Ok(store_read(&app, &name)?.len())
}

/// Lets the stub page report its checks to stdout so the shell can be verified
/// without looking at the screen.
#[tauri::command]
fn log_stub(message: String) {
    println!("[stub] {message}");
}

#[tauri::command]
fn set_zoom(window: tauri::WebviewWindow, factor: f64) -> Result<(), String> {
    window.set_zoom(factor).map_err(|error| error.to_string())
}

#[tauri::command]
fn kill_sidecar(state: State<'_, ShellState>) {
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        println!("[shell] sidecar killed on request");
    }
    *state.ready.lock().unwrap() = None;
}

// ---------------------------------------------------------------------------
// Native pickers and shell integration
//
// Mirrors packages/desktop/src/main/attachment-picker.ts and ipc.ts: files are
// picked through native dialogs, authorized by a one-shot token with a shared
// byte budget, and read by exact path. Shell actions mirror external-url.ts and
// apps.ts (allowlists, `where` resolution).
// ---------------------------------------------------------------------------

/// Mirrors MAX_ATTACHMENT_BYTES in attachment-picker.ts.
const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Default)]
struct PickedFiles {
    selections: Mutex<HashMap<String, PickedSelection>>,
}

struct PickedSelection {
    paths: HashSet<String>,
    remaining: u64,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DirectoryPickerOptions {
    multiple: Option<bool>,
    title: Option<String>,
    default_path: Option<String>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FilePickerOptions {
    multiple: Option<bool>,
    title: Option<String>,
    default_path: Option<String>,
    extensions: Option<Vec<String>>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SavePickerOptions {
    title: Option<String>,
    default_path: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedFileInfo {
    path: String,
    name: String,
    size: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedFilesResult {
    token: String,
    files: Vec<PickedFileInfo>,
}

#[tauri::command]
async fn open_directory_picker(
    app: AppHandle,
    opts: Option<DirectoryPickerOptions>,
) -> Result<Option<Value>, String> {
    let opts = opts.unwrap_or_default();
    let mut builder = app.dialog().file();
    if let Some(title) = opts.title {
        builder = builder.set_title(title);
    }
    if let Some(directory) = opts.default_path {
        builder = builder.set_directory(directory);
    }
    let multiple = opts.multiple.unwrap_or(false);
    let paths: Vec<PathBuf> = if multiple {
        builder
            .blocking_pick_folders()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|path| path.into_path().ok())
            .collect()
    } else {
        builder
            .blocking_pick_folder()
            .and_then(|path| path.into_path().ok())
            .into_iter()
            .collect()
    };
    if paths.is_empty() {
        return Ok(None);
    }
    let display: Vec<String> = paths.iter().map(|path| path.to_string_lossy().to_string()).collect();
    if multiple {
        Ok(Some(json!(display)))
    } else {
        Ok(Some(json!(display[0])))
    }
}

#[tauri::command]
async fn open_file_picker(
    app: AppHandle,
    state: State<'_, PickedFiles>,
    opts: Option<FilePickerOptions>,
) -> Result<Option<PickedFilesResult>, String> {
    let opts = opts.unwrap_or_default();
    let mut builder = app.dialog().file();
    if let Some(title) = opts.title {
        builder = builder.set_title(title);
    }
    if let Some(directory) = opts.default_path {
        builder = builder.set_directory(directory);
    }
    if let Some(extensions) = opts.extensions.filter(|list| !list.is_empty()) {
        // TODO(i18n): the filter label should come from the native translations bundle.
        let refs: Vec<&str> = extensions.iter().map(|value| value.as_str()).collect();
        builder = builder.add_filter("Files", &refs);
    }
    let mut selected: Vec<PathBuf> = builder
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|path| path.into_path().ok())
        .collect();
    if !opts.multiple.unwrap_or(false) {
        selected.truncate(1);
    }
    if selected.is_empty() {
        return Ok(None);
    }

    let mut files = Vec::new();
    let mut total = 0u64;
    for path in selected {
        let metadata = std::fs::metadata(&path).map_err(|error| format!("stat {}: {error}", path.display()))?;
        total += metadata.len();
        files.push(PickedFileInfo {
            path: path.to_string_lossy().to_string(),
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default(),
            size: metadata.len(),
        });
    }
    if total > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "attachment budget exceeded ({} MB)",
            MAX_ATTACHMENT_BYTES / 1024 / 1024
        ));
    }

    let token = uuid::Uuid::new_v4().to_string();
    state.selections.lock().unwrap().insert(
        token.clone(),
        PickedSelection {
            paths: files.iter().map(|file| file.path.clone()).collect(),
            remaining: MAX_ATTACHMENT_BYTES,
        },
    );
    Ok(Some(PickedFilesResult { token, files }))
}

#[tauri::command]
fn read_picked_file(state: State<'_, PickedFiles>, token: String, path: String) -> Result<tauri::ipc::Response, String> {
    let mut selections = state.selections.lock().unwrap();
    let selection = selections.get_mut(&token).ok_or("file was not selected")?;
    if !selection.paths.remove(&path) {
        return Err("file was not selected".into());
    }
    let metadata = std::fs::metadata(&path).map_err(|error| format!("stat {path}: {error}"))?;
    if metadata.len() > selection.remaining {
        return Err("attachment budget exceeded".into());
    }
    let bytes = std::fs::read(&path).map_err(|error| format!("read {path}: {error}"))?;
    selection.remaining = selection.remaining.saturating_sub(bytes.len() as u64);
    if selection.paths.is_empty() {
        selections.remove(&token);
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn release_picked_files(state: State<'_, PickedFiles>, token: String) {
    state.selections.lock().unwrap().remove(&token);
}

#[tauri::command]
async fn save_file_picker(app: AppHandle, opts: Option<SavePickerOptions>) -> Result<Option<String>, String> {
    let opts = opts.unwrap_or_default();
    let mut builder = app.dialog().file();
    if let Some(title) = opts.title {
        builder = builder.set_title(title);
    }
    if let Some(path) = opts.default_path {
        builder = builder.set_directory(path);
    }
    Ok(builder
        .blocking_save_file()
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().to_string()))
}

/// Mirrors resolveExternalURL in external-url.ts.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|error| format!("invalid url: {error}"))?;
    match parsed.scheme() {
        "http" | "https" | "mailto" => app.opener().open_url(url, None::<String>).map_err(|error| error.to_string()),
        other => Err(format!("scheme not allowed: {other}")),
    }
}

/// Mirrors resolveLocalFilePath in external-url.ts: `file:` with no host only.
#[tauri::command]
fn open_local_file(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|error| format!("invalid url: {error}"))?;
    if parsed.scheme() != "file" || parsed.host_str().is_some() {
        return Err("only local file:// urls are allowed".into());
    }
    let path = parsed.to_file_path().map_err(|_| "invalid file url".to_string())?;
    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<String>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_path(app: AppHandle, path: String, with_app: Option<String>) -> Result<(), String> {
    match with_app {
        None => app
            .opener()
            .open_path(path, None::<String>)
            .map_err(|error| error.to_string()),
        Some(app_name) => {
            let (command, args) = if cfg!(target_os = "macos") {
                ("open".to_string(), vec!["-a".to_string(), app_name, path])
            } else {
                (app_name, vec![path])
            };
            std::process::Command::new(command)
                .args(args)
                .spawn()
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
    }
}

#[tauri::command]
fn reveal_path(app: AppHandle, path: String) -> Result<bool, String> {
    if !std::path::Path::new(&path).exists() {
        return Ok(false);
    }
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn check_app_exists(app_name: String) -> bool {
    if cfg!(target_os = "macos") {
        check_macos_app(&app_name)
    } else {
        true
    }
}

#[cfg(target_os = "macos")]
fn check_macos_app(app_name: &str) -> bool {
    let mut locations = vec![
        PathBuf::from(format!("/Applications/{app_name}.app")),
        PathBuf::from(format!("/System/Applications/{app_name}.app")),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        locations.push(PathBuf::from(home).join("Applications").join(format!("{app_name}.app")));
    }
    if locations.iter().any(|path| path.exists()) {
        return true;
    }
    std::process::Command::new("which")
        .arg(app_name)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn check_macos_app(_app_name: &str) -> bool {
    true
}

#[tauri::command]
async fn resolve_app_path(app_name: String) -> Option<String> {
    if !cfg!(target_os = "windows") {
        return Some(app_name);
    }
    resolve_windows_app_path(&app_name)
}

/// Mirrors resolveWindowsAppPath in apps.ts.
#[cfg(target_os = "windows")]
fn resolve_windows_app_path(app_name: &str) -> Option<String> {
    let output = std::process::Command::new("where").arg(app_name).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let paths: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    let has_ext = |path: &str, ext: &str| path.to_lowercase().ends_with(&format!(".{ext}"));
    if let Some(exe) = paths.iter().find(|path| has_ext(path, "exe")) {
        return Some(exe.clone());
    }
    for path in &paths {
        if has_ext(path, "cmd") || has_ext(path, "bat") {
            if let Some(resolved) = resolve_cmd_shim(path) {
                return Some(resolved);
            }
        }
    }
    let key: String = app_name
        .chars()
        .filter(|value| value.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase();
    if !key.is_empty() {
        for path in &paths {
            let candidate = PathBuf::from(path);
            let mut dirs = vec![candidate.parent().map(PathBuf::from)];
            if let Some(parent) = candidate.parent().and_then(|value| value.parent()) {
                dirs.push(Some(PathBuf::from(parent)));
            }
            for dir in dirs.into_iter().flatten() {
                let Ok(entries) = std::fs::read_dir(&dir) else { continue };
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !name.to_lowercase().ends_with(".exe") {
                        continue;
                    }
                    let stem: String = name
                        .trim_end_matches(".exe")
                        .trim_end_matches(".EXE")
                        .chars()
                        .filter(|value| value.is_ascii_alphanumeric())
                        .collect::<String>()
                        .to_lowercase();
                    if stem.contains(&key) || key.contains(&stem) {
                        return Some(entry.path().to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    paths.first().cloned()
}

#[cfg(not(target_os = "windows"))]
fn resolve_windows_app_path(_app_name: &str) -> Option<String> {
    None
}

/// Resolves `%~dp0` indirection inside .cmd/.bat shims (as apps.ts does).
#[cfg(target_os = "windows")]
fn resolve_cmd_shim(path: &str) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for token in content.split('"').map(|value| value.trim()) {
        let lower = token.to_lowercase();
        if !lower.contains(".exe") {
            continue;
        }
        if let Some(index) = lower.find("%~dp0") {
            let base = PathBuf::from(path).parent()?.to_path_buf();
            let suffix = &token[index + 5..];
            let mut resolved = base;
            for part in suffix.replace('/', "\\").split('\\') {
                if part.is_empty() || part == "." {
                    continue;
                }
                if part == ".." {
                    resolved = resolved.parent().map(PathBuf::from).unwrap_or(resolved);
                } else {
                    resolved = resolved.join(part);
                }
            }
            if resolved.exists() {
                return Some(resolved.to_string_lossy().to_string());
            }
        }
        if PathBuf::from(token).exists() {
            return Some(token.to_string());
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn resolve_cmd_shim(_path: &str) -> Option<String> {
    None
}

fn main() {
    tauri::Builder::default()
        // Must be registered before the deep-link plugin so second launches are
        // forwarded into the running instance instead of spawning a new process.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // The single-instance plugin carries the deep-link feature, so URLs in
            // argv are forwarded to the deep-link plugin's on_open_url handler.
            println!("[shell] second instance: {argv:?}");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(ShellState::default())
        .manage(PickedFiles::default())
        // Diagnostics for the bootstrap phase: log page loads and, once the page is
        // finished, evaluate a probe script that reports what the webview can see.
        .on_page_load(|webview, payload| {
            println!("[page] {:?} {}", payload.event(), payload.url());
            if let tauri::webview::PageLoadEvent::Finished = payload.event() {
                let _ = webview.eval(
                    r#"(async () => {
  const report = {
    hasGlobal: !!window.__TAURI__,
    hasInternals: !!window.__TAURI_INTERNALS__,
    readyState: document.readyState,
    title: document.title,
  };
  const invoke = (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) ||
    (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
  if (!invoke) { console.error("no invoke bridge", report); return }
  // Independent listener so shell-side events can be observed outside the app shim.
  try {
    const listen = window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen;
    if (listen) {
      await listen("deep-link", (event) => {
        invoke("log_stub", { message: "page-listener deep-link " + JSON.stringify(event.payload) });
      });
      report.listener = "installed";
    } else {
      report.listener = "unavailable";
    }
  } catch (error) {
    report.listener = "failed: " + String(error);
  }
  try {
    await invoke("log_stub", { message: "eval " + JSON.stringify(report) });
  } catch (error) {
    try { await window.__TAURI_INTERNALS__.invoke("log_stub", { message: "eval-error " + String(error) }) } catch {}
  }
  // Temporary self-test for the picker/opener slice (dialog flows need a human).
  try {
    const appExists = await invoke("check_app_exists", { appName: "explorer.exe" });
    const appPath = await invoke("resolve_app_path", { appName: "cmd" });
    const revealed = await invoke("reveal_path", { path: "D:\\Projetos\\JevCode\\package.json" });
    await invoke("log_stub", { message: "shell self-test " + JSON.stringify({ appExists, appPath, revealed }) });
  } catch (error) {
    await invoke("log_stub", { message: "shell self-test failed " + String(error) });
  }
})()"#,
                );
            }
        })
        .invoke_handler(tauri::generate_handler![
            await_initialization,
            consume_initial_deep_links,
            get_window_id,
            store_get,
            store_set,
            store_delete,
            store_clear,
            store_keys,
            store_length,
            log_stub,
            set_zoom,
            kill_sidecar,
            open_directory_picker,
            open_file_picker,
            read_picked_file,
            release_picked_files,
            save_file_picker,
            open_external,
            open_local_file,
            open_path,
            reveal_path,
            check_app_exists,
            resolve_app_path
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            *handle.state::<ShellState>().window_id.lock().unwrap() = Some(uuid::Uuid::new_v4().to_string());

            // Deep links: queue whatever launched the app, then forward new ones.
            if let Ok(Some(urls)) = handle.deep_link().get_current() {
                let urls: Vec<String> = urls.into_iter().map(|url| url.to_string()).collect();
                handle.state::<ShellState>().pending_deep_links.lock().unwrap().extend(urls);
            }
            let emitter = handle.clone();
            let _ = handle.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().into_iter().map(|url| url.to_string()).collect();
                println!("[shell] deep link: {urls:?}");
                *emitter.state::<ShellState>().pending_deep_links.lock().unwrap() = urls.clone();
                match emitter.emit("deep-link", urls) {
                    Ok(()) => println!("[shell] deep-link emitted"),
                    Err(error) => println!("[shell] deep-link emit failed: {error}"),
                }
            });

            let sidecar_app = handle.clone();
            std::thread::spawn(move || start_sidecar(&sidecar_app));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(child) = app.state::<ShellState>().child.lock().unwrap().take() {
                    let pid = child.pid();
                    let _ = child.kill();
                    println!("[shell] sidecar killed pid={pid}");
                }
            }
        });
}
