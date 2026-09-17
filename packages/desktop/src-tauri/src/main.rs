#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use rusqlite::OptionalExtension;
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

/// The local server coordinates chosen at startup. Kept so an unexpected sidecar
/// termination can be recovered on the same port (the renderer's URL stays valid).
#[derive(Clone)]
struct Endpoint {
    port: u16,
    username: String,
    password: String,
}

#[derive(Default)]
struct ShellState {
    child: Mutex<Option<CommandChild>>,
    ready: Mutex<Option<Ready>>,
    window_id: Mutex<Option<String>>,
    pending_deep_links: Mutex<Vec<String>>,
    endpoint: Mutex<Option<Endpoint>>,
    stopping: Mutex<bool>,
    zoom: Mutex<f64>,
    fullscreen: Mutex<bool>,
    job: Mutex<Option<isize>>,
}

/// Binds the sidecar to a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so a
/// hard kill of the shell (crash, Task Manager, CI teardown) also kills the server
/// instead of leaving an orphan that locks `target/debug/opencode-cli.exe`.
#[cfg(windows)]
fn bind_sidecar_to_job(pid: u32) -> Option<isize> {
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("[shell] job object: create failed");
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            CloseHandle(job);
            eprintln!("[shell] job object: limit failed");
            return None;
        }
        let process: HANDLE = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid);
        if process.is_null() {
            CloseHandle(job);
            eprintln!("[shell] job object: OpenProcess failed");
            return None;
        }
        let assigned = AssignProcessToJobObject(job, process);
        CloseHandle(process);
        if assigned == 0 {
            CloseHandle(job);
            eprintln!("[shell] job object: assign failed");
            return None;
        }
        println!("[shell] sidecar {pid} bound to a kill-on-close job object");
        Some(job as isize)
    }
}

#[cfg(not(windows))]
fn bind_sidecar_to_job(_pid: u32) -> Option<isize> {
    None
}

#[cfg(windows)]
fn close_job(handle: isize) {
    use windows_sys::Win32::Foundation::CloseHandle;
    unsafe {
        CloseHandle(handle as *mut core::ffi::c_void);
    }
}

#[cfg(not(windows))]
fn close_job(_handle: isize) {}

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
    let endpoint = Endpoint {
        port: 0,
        username: "opencode".to_string(),
        password: uuid::Uuid::new_v4().to_string(),
    };
    let port = match free_port() {
        Ok(port) => port,
        Err(error) => {
            eprintln!("[shell] no free port: {error}");
            return;
        }
    };
    let endpoint = Endpoint { port, ..endpoint };
    *app.state::<ShellState>().endpoint.lock().unwrap() = Some(endpoint.clone());
    spawn_sidecar(app, endpoint, 0);
}

/// Spawns the sidecar for a given endpoint. On unexpected termination it is
/// restarted on the same port (up to two attempts) instead of leaving the app
/// connected to a dead server.
fn spawn_sidecar(app: &AppHandle, endpoint: Endpoint, attempt: u32) {
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
                    &endpoint.port.to_string(),
                    "--print-logs",
                ])
                .env("OPENCODE_SERVER_USERNAME", endpoint.username.clone())
                .env("OPENCODE_SERVER_PASSWORD", endpoint.password.clone());
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
    let pid = child.pid();
    println!("[shell] sidecar spawned pid={pid} port={}", endpoint.port);
    *app.state::<ShellState>().child.lock().unwrap() = Some(child);

    // Bind the child to a kill-on-close job (replacing any job from a previous
    // sidecar, which also cleans up stragglers from an earlier restart).
    {
        let state = app.state::<ShellState>();
        if let Some(previous) = state.job.lock().unwrap().take() {
            close_job(previous);
        }
        if let Some(job) = bind_sidecar_to_job(pid) {
            *state.job.lock().unwrap() = Some(job);
        }
    }

    // Drain output and react to unexpected termination.
    let handle = app.clone();
    let endpoint_for_drain = endpoint.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => println!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end()),
                CommandEvent::Stderr(line) => eprintln!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end()),
                CommandEvent::Terminated(payload) => {
                    println!("[shell] sidecar terminated: {payload:?}");
                    let state = handle.state::<ShellState>();
                    state.child.lock().unwrap().take();
                    *state.ready.lock().unwrap() = None;
                    let stopping = *state.stopping.lock().unwrap();
                    if stopping {
                        return;
                    }
                    let _ = handle.emit("sidecar-terminated", ());
                    if attempt < 2 {
                        println!("[shell] restarting sidecar (attempt {})", attempt + 1);
                        spawn_sidecar(&handle, endpoint_for_drain.clone(), attempt + 1);
                    } else {
                        eprintln!("[shell] sidecar restart limit reached");
                    }
                }
                _ => {}
            }
        }
    });

    // Health poll (also re-runs after a restart so `server-ready` fires again).
    let poll_handle = app.clone();
    let poll_endpoint = endpoint.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        loop {
            if started.elapsed() > READY_TIMEOUT {
                eprintln!("[shell] server did not become healthy within {}s", READY_TIMEOUT.as_secs());
                return;
            }
            if let Ok(200) = http_health(poll_endpoint.port, &poll_endpoint.password) {
                let url = format!("http://127.0.0.1:{}", poll_endpoint.port);
                println!("[shell] server ready at {url}");
                *poll_handle.state::<ShellState>().ready.lock().unwrap() = Some(Ready {
                    url: url.clone(),
                    username: poll_endpoint.username.clone(),
                    password: poll_endpoint.password.clone(),
                });
                let _ = poll_handle.emit("server-ready", json!({ "url": url }));
                return;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    });
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
    if cfg!(debug_assertions) {
        println!("[store] get {name} {key}");
    }
    let map = store_read(&app, &name)?;
    Ok(map.get(&key).map(|value| match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }))
}

#[tauri::command]
fn store_set(app: AppHandle, name: String, key: String, value: String) -> Result<(), String> {
    if cfg!(debug_assertions) {
        println!("[store] set {name} {key}");
    }
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

/// Development helper: lets the renderer report diagnostics to stdout. Silent in
/// release builds.
#[tauri::command]
fn log_stub(message: String) {
    if cfg!(debug_assertions) {
        println!("[stub] {message}");
    }
}

#[tauri::command]
fn set_zoom(app: AppHandle, state: State<'_, ShellState>, window: tauri::WebviewWindow, factor: f64) -> Result<(), String> {
    window.set_zoom(factor).map_err(|error| error.to_string())?;
    *state.zoom.lock().unwrap() = factor;
    let _ = app.emit("zoom-factor-changed", factor);
    Ok(())
}

#[tauri::command]
fn kill_sidecar(state: State<'_, ShellState>) {
    *state.stopping.lock().unwrap() = true;
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
        let refs: Vec<&str> = extensions.iter().map(|value| value.as_str()).collect();
        // The label comes from the native translations bundle; without it the filter
        // is skipped rather than hardcoding English here (AGENTS.md).
        let i18n = app.state::<NativeI18n>();
        if let Some(label) = native_t(&i18n, "desktop.dialog.files", &[]) {
            builder = builder.add_filter(label, &refs);
        }
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
#[allow(dead_code)]
fn resolve_cmd_shim(_path: &str) -> Option<String> {
    None
}

// ---------------------------------------------------------------------------
// Drafts (sqlite) — same schema as packages/desktop/src/main/draft-store.ts so
// an existing Electron drafts.sqlite keeps working unchanged.
// ---------------------------------------------------------------------------

const DRAFTS_FILE: &str = "drafts.sqlite";

struct DraftStore {
    conn: Mutex<rusqlite::Connection>,
}

impl DraftStore {
    fn open(path: &std::path::Path) -> Result<Self, String> {
        let conn = rusqlite::Connection::open(path).map_err(|error| format!("open drafts db: {error}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS document (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS blob (id TEXT PRIMARY KEY, data BLOB NOT NULL);",
        )
        .map_err(|error| format!("init drafts db: {error}"))?;
        let store = Self { conn: Mutex::new(conn) };
        if let Err(error) = store.gc_orphan_blobs() {
            eprintln!("[drafts] gc failed: {error}");
        }
        Ok(store)
    }

    /// Removes blobs no document references (mirrors the startup GC in draft-store.ts).
    fn gc_orphan_blobs(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let mut used = HashSet::new();
        {
            let mut statement = conn.prepare("SELECT value FROM document").map_err(|error| error.to_string())?;
            let values = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            for value in values {
                let value = value.map_err(|error| error.to_string())?;
                if let Ok(parsed) = serde_json::from_str::<Value>(&value) {
                    collect_blob_ids(&parsed, &mut used);
                }
            }
        }
        let orphans: Vec<String> = {
            let mut statement = conn.prepare("SELECT id FROM blob").map_err(|error| error.to_string())?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            ids.filter_map(|id| id.ok()).filter(|id| !used.contains(id)).collect()
        };
        for id in &orphans {
            conn.execute("DELETE FROM blob WHERE id = ?1", [id]).map_err(|error| error.to_string())?;
        }
        if !orphans.is_empty() {
            println!("[drafts] removed {} orphan blob(s)", orphans.len());
        }
        Ok(())
    }
}

fn collect_blob_ids(value: &Value, used: &mut HashSet<String>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::Object(blob)) = map.get("blob") {
                if let Some(Value::String(id)) = blob.get("id") {
                    used.insert(id.clone());
                }
            }
            for child in map.values() {
                collect_blob_ids(child, used);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_blob_ids(item, used)),
        _ => {}
    }
}

#[tauri::command]
fn draft_get(state: State<'_, DraftStore>, key: String) -> Result<Option<String>, String> {
    let conn = state.conn.lock().unwrap();
    conn.query_row("SELECT value FROM document WHERE key = ?1", [&key], |row| row.get::<_, String>(0))
        .optional()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn draft_set(state: State<'_, DraftStore>, key: String, value: String) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO document (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn draft_delete(state: State<'_, DraftStore>, key: String) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute("DELETE FROM document WHERE key = ?1", [&key])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Blobs arrive as a raw request body (`invoke("draft_blob_put", new Uint8Array(...))`).
#[tauri::command]
fn draft_blob_put(state: State<'_, DraftStore>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(value) => {
            serde_json::from_value::<Vec<u8>>(value.clone()).map_err(|error| error.to_string())?
        }
    };
    use sha2::{Digest, Sha256};
    let id = Sha256::digest(&data)
        .iter()
        .fold(String::with_capacity(64), |mut acc, byte| {
            use std::fmt::Write as _;
            let _ = write!(acc, "{byte:02x}");
            acc
        });
    let conn = state.conn.lock().unwrap();
    conn.execute("INSERT OR IGNORE INTO blob (id, data) VALUES (?1, ?2)", rusqlite::params![id, data])
        .map_err(|error| error.to_string())?;
    Ok(id)
}

#[tauri::command]
fn draft_blob_has(state: State<'_, DraftStore>, id: String) -> Result<bool, String> {
    let conn = state.conn.lock().unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(1) FROM blob WHERE id = ?1", [&id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(count > 0)
}

#[tauri::command]
fn draft_blob_get(state: State<'_, DraftStore>, id: String) -> Result<tauri::ipc::Response, String> {
    let conn = state.conn.lock().unwrap();
    let data: Vec<u8> = conn
        .query_row("SELECT data FROM blob WHERE id = ?1", [&id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(tauri::ipc::Response::new(data))
}

// ---------------------------------------------------------------------------
// Window state — geometry persisted in the app data dir (Electron used
// electron-window-state with a different file shape, so this starts fresh).
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    maximized: bool,
}

fn window_state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("window-state.json"))
}

fn read_window_state(app: &AppHandle) -> Option<WindowState> {
    let text = std::fs::read_to_string(window_state_path(app)?).ok()?;
    serde_json::from_str(&text).ok()
}

fn restore_window_state(app: &AppHandle) {
    let Some(state) = read_window_state(app) else { return };
    let Some(window) = app.get_webview_window("main") else { return };
    if state.width > 0 && state.height > 0 {
        let _ = window.set_size(tauri::LogicalSize::new(state.width as f64, state.height as f64));
    }
    if state.x != 0 || state.y != 0 {
        let _ = window.set_position(tauri::LogicalPosition::new(state.x as f64, state.y as f64));
    }
    if state.maximized {
        let _ = window.maximize();
    }
    println!("[window] restored {}x{} at {},{} (maximized={})", state.width, state.height, state.x, state.y, state.maximized);
}

fn save_window_state(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let Some(path) = window_state_path(app) else { return };
    let (maximized, minimized) = (
        window.is_maximized().unwrap_or(false),
        window.is_minimized().unwrap_or(false),
    );
    lock_window_state(&path, &window, maximized, minimized);
}

fn lock_window_state(path: &std::path::Path, window: &tauri::WebviewWindow, maximized: bool, minimized: bool) {
    let mut state = read_window_state_from(path).unwrap_or_default();
    let scale = window.scale_factor().unwrap_or(1.0);
    let has_bounds = state.width > 0 && state.height > 0;
    // Keep the last normal bounds; when the window is maximized or minimized but we
    // have never recorded bounds, fall back to the current geometry so the file
    // never persists zeros.
    if (!maximized && !minimized) || !has_bounds {
        if let Ok(size) = window.inner_size().map(|size| size.to_logical::<f64>(scale)) {
            state.width = size.width.round() as u32;
            state.height = size.height.round() as u32;
        }
        if let Ok(position) = window.outer_position().map(|position| position.to_logical::<f64>(scale)) {
            state.x = position.x.round() as i32;
            state.y = position.y.round() as i32;
        }
    }
    state.maximized = maximized;
    if let Ok(text) = serde_json::to_string(&state) {
        if let Err(error) = std::fs::write(path, text) {
            eprintln!("[window] failed to save state: {error}");
        } else {
            println!("[window] saved state");
        }
    }
}

fn read_window_state_from(path: &std::path::Path) -> Option<WindowState> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

// ---------------------------------------------------------------------------
// Native translations and the macOS application menu
//
// Mirrors native-translations.ts and menu.ts: the renderer supplies a typed
// message bundle plus the shared menu specification (both from
// @opencode-ai/app); labels are resolved here with `native_t`, and menu clicks
// either forward a renderer command (`menu-command`) or run a shell action.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct NativeI18n {
    locale: Mutex<String>,
    messages: Mutex<HashMap<String, String>>,
    menu: Mutex<Vec<Value>>,
}

#[tauri::command]
fn set_native_translations(
    app: AppHandle,
    state: State<'_, NativeI18n>,
    bundle: Value,
) -> Result<(), String> {
    let locale = bundle.get("locale").and_then(Value::as_str).unwrap_or("en").to_string();
    let messages = bundle
        .get("messages")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string())))
                .collect::<HashMap<String, String>>()
        })
        .unwrap_or_default();
    println!("[i18n] bundle received locale={locale} keys={}", messages.len());
    *state.locale.lock().unwrap() = locale;
    *state.messages.lock().unwrap() = messages;
    rebuild_native_menu(&app);
    Ok(())
}

#[tauri::command]
fn set_native_menu(app: AppHandle, state: State<'_, NativeI18n>, items: Vec<Value>) -> Result<(), String> {
    println!("[menu] spec received: {} submenu(s)", items.len());
    *state.menu.lock().unwrap() = items;
    rebuild_native_menu(&app);
    Ok(())
}

/// Mirrors formatDesktopNativeMessage: `{{name}}` placeholders.
fn native_t(state: &NativeI18n, key: &str, params: &[(&str, String)]) -> Option<String> {
    let messages = state.messages.lock().unwrap();
    let template = messages.get(key)?;
    let mut text = template.clone();
    for (name, value) in params {
        text = text.replace(&format!("{{{{{name}}}}}"), value);
    }
    Some(text)
}

fn menu_label(state: &NativeI18n, key: &str) -> String {
    state
        .messages
        .lock()
        .unwrap()
        .get(key)
        .cloned()
        .unwrap_or_else(|| key.to_string())
}

/// Maps the app's mac-style accelerators to Tauri's parser tokens.
fn parse_accelerator(input: &str) -> Option<String> {
    let mut modifiers = Vec::new();
    let mut key = None;
    for token in input.split('+') {
        match token {
            "Cmd" | "Command" => modifiers.push("Command"),
            "CmdOrCtrl" => modifiers.push("CmdOrCtrl"),
            "Ctrl" | "Control" => modifiers.push("Control"),
            "Option" | "Alt" => modifiers.push("Alt"),
            "Shift" => modifiers.push("Shift"),
            "" => {}
            other => {
                key = Some(match other {
                    "S" | "s" => "KeyS",
                    "O" | "o" => "KeyO",
                    "N" | "n" => "KeyN",
                    "0" => "Digit0",
                    "+" | "=" => "Equal",
                    "-" => "Minus",
                    "," => "Comma",
                    "`" => "Backquote",
                    "[" => "BracketLeft",
                    "]" => "BracketRight",
                    "Up" => "ArrowUp",
                    "Down" => "ArrowDown",
                    _ => return None,
                })
            }
        }
    }
    let key = key?;
    let mut parts = modifiers;
    parts.push(key);
    Some(parts.join("+"))
}

fn predefined_item(app: &AppHandle, role: &str) -> Option<tauri::menu::PredefinedMenuItem<tauri::Wry>> {
    use tauri::menu::PredefinedMenuItem;
    match role {
        "about" => PredefinedMenuItem::about(app, None, None).ok(),
        "hide" => PredefinedMenuItem::hide(app, None).ok(),
        "hideOthers" => PredefinedMenuItem::hide_others(app, None).ok(),
        "unhide" => PredefinedMenuItem::show_all(app, None).ok(),
        "quit" => PredefinedMenuItem::quit(app, None).ok(),
        "close" => PredefinedMenuItem::close_window(app, None).ok(),
        "minimize" => PredefinedMenuItem::minimize(app, None).ok(),
        "undo" => PredefinedMenuItem::undo(app, None).ok(),
        "redo" => PredefinedMenuItem::redo(app, None).ok(),
        "cut" => PredefinedMenuItem::cut(app, None).ok(),
        "copy" => PredefinedMenuItem::copy(app, None).ok(),
        "paste" => PredefinedMenuItem::paste(app, None).ok(),
        "selectAll" => PredefinedMenuItem::select_all(app, None).ok(),
        "togglefullscreen" => PredefinedMenuItem::fullscreen(app, None).ok(),
        _ => None,
    }
}

fn rebuild_native_menu(app: &AppHandle) {
    let state = app.state::<NativeI18n>();
    let spec = state.menu.lock().unwrap().clone();
    if spec.is_empty() {
        return;
    }

    let mut builder = tauri::menu::MenuBuilder::new(app);
    let mut count = 0usize;
    for submenu in &spec {
        let label = submenu
            .get("labelKey")
            .and_then(Value::as_str)
            .map(|key| menu_label(&state, key))
            .unwrap_or_default();
        let mut built = tauri::menu::SubmenuBuilder::new(app, label);
        if let Some(entries) = submenu.get("items").and_then(Value::as_array) {
            for entry in entries {
                if entry.get("type").and_then(Value::as_str) == Some("separator") {
                    if let Ok(item) = tauri::menu::PredefinedMenuItem::separator(app) {
                        built = built.item(&item);
                        count += 1;
                    }
                    continue;
                }
                let label_key = entry.get("labelKey").and_then(Value::as_str);
                let label = label_key.map(|key| menu_label(&state, key)).unwrap_or_default();
                if let Some(role) = entry.get("role").and_then(Value::as_str) {
                    if let Some(item) = predefined_item(app, role) {
                        built = built.item(&item);
                        count += 1;
                        continue;
                    }
                }
                let id = entry
                    .get("command")
                    .and_then(Value::as_str)
                    .map(|command| format!("cmd:{command}"))
                    .or_else(|| entry.get("action").and_then(Value::as_str).map(|action| format!("act:{action}")))
                    .or_else(|| entry.get("href").and_then(Value::as_str).map(|href| format!("href:{href}")));
                let Some(id) = id else { continue };
                let mut item = tauri::menu::MenuItemBuilder::with_id(id, label);
                if let Some(accelerator) = entry
                    .get("accelerator")
                    .and_then(|value| value.get("macos"))
                    .and_then(Value::as_str)
                    .and_then(parse_accelerator)
                {
                    item = item.accelerator(accelerator);
                }
                if let Ok(item) = item.build(app) {
                    built = built.item(&item);
                    count += 1;
                }
            }
        }
        if let Ok(submenu) = built.build() {
            builder = builder.item(&submenu);
        }
    }

    match builder.build() {
        Ok(menu) => {
            if cfg!(target_os = "macos") {
                match app.set_menu(menu) {
                    Ok(_) => println!("[menu] applied {count} item(s)"),
                    Err(error) => eprintln!("[menu] failed to apply: {error}"),
                }
            } else {
                // Matches Electron: no native application menu outside macOS.
                println!("[menu] built {count} item(s) (not applied on this platform)");
            }
        }
        Err(error) => eprintln!("[menu] failed to build: {error}"),
    }
}

/// Mirrors desktop-menu-actions.ts (shell-side actions only; commands go to the renderer).
fn run_menu_action(app: &AppHandle, action: &str) {
    let window = app.get_webview_window("main");
    let clamp = |value: f64| value.clamp(0.2, 10.0);
    let state = app.state::<ShellState>();
    let current_zoom = *state.zoom.lock().unwrap();
    match action {
        "view.reload" => {
            if let Some(window) = &window {
                let _ = window.reload();
            }
        }
        "view.toggleDevTools" => {
            if let Some(window) = &window {
                if window.is_devtools_open() {
                    window.close_devtools();
                } else {
                    window.open_devtools();
                }
            }
        }
        "view.resetZoom" | "view.zoomIn" | "view.zoomOut" => {
            let next = match action {
                "view.resetZoom" => 1.0,
                "view.zoomIn" => clamp(current_zoom + 0.2),
                _ => clamp(current_zoom - 0.2),
            };
            if let Some(window) = &window {
                if window.set_zoom(next).is_ok() {
                    *state.zoom.lock().unwrap() = next;
                    let _ = app.emit("zoom-factor-changed", next);
                }
            }
        }
        "view.toggleFullscreen" => {
            if let Some(window) = &window {
                let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
            }
        }
        "window.minimize" => {
            if let Some(window) = &window {
                let _ = window.minimize();
            }
        }
        "window.toggleMaximize" => {
            if let Some(window) = &window {
                if window.is_maximized().unwrap_or(false) {
                    let _ = window.unmaximize();
                } else {
                    let _ = window.maximize();
                }
            }
        }
        "window.close" => {
            if let Some(window) = &window {
                let _ = window.close();
            }
        }
        "window.new" => println!("[menu] window.new is not supported yet"),
        "app.checkForUpdates" => println!("[menu] updater is not wired yet"),
        "app.relaunch" => {
            *state.stopping.lock().unwrap() = true;
            if let Some(child) = state.child.lock().unwrap().take() {
                let _ = child.kill();
            }
            if let Ok(exe) = std::env::current_exe() {
                let _ = std::process::Command::new(exe).spawn();
            }
            app.exit(0);
        }
        other if other.starts_with("edit.") => {
            if let Some(window) = &window {
                let command = match other {
                    "edit.undo" => "undo",
                    "edit.redo" => "redo",
                    "edit.cut" => "cut",
                    "edit.copy" => "copy",
                    "edit.paste" => "paste",
                    "edit.delete" => "delete",
                    "edit.selectAll" => "selectAll",
                    _ => return,
                };
                let _ = window.eval(format!("document.execCommand('{command}')"));
            }
        }
        other => println!("[menu] unhandled action {other}"),
    }
}

fn main() {
    let builder = tauri::Builder::default()
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init());

    // Decorum drives the Windows overlay caption controls. Its macOS/cocoa path
    // dereferences a null pointer with a decorationless window, so it is Windows-only
    // (macOS gets its traffic lights from the window config instead).
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_decorum::init());

    builder
        .manage(ShellState::default())
        .manage(PickedFiles::default())
        .manage(NativeI18n::default())
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            match id.split_once(':') {
                Some(("cmd", command)) => {
                    let _ = app.emit("menu-command", command.to_string());
                }
                Some(("act", action)) => run_menu_action(app, action),
                Some(("href", href)) => {
                    let _ = app.opener().open_url(href.to_string(), None::<String>);
                }
                _ => {}
            }
        })
        // Development diagnostics: log page loads and run a probe script inside the
        // page so the shell can be verified without looking at the screen. Compiled
        // out of release builds.
        .on_page_load(|webview, payload| {
            if !cfg!(debug_assertions) {
                return;
            }
            println!("[page] {:?} {}", payload.event(), payload.url());
            if let tauri::webview::PageLoadEvent::Finished = payload.event() {
                let _ = webview.eval(
                    r##"(async () => {
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
  // Temporary self-test for the Windows overlay titlebar and window background.
  try {
    const container = document.querySelector('[data-tauri-decorum-tb]');
    const buttons = Array.from(
      document.querySelectorAll('#decorum-tb-minimize, #decorum-tb-maximize, #decorum-tb-close, .decorum-tb-btn'),
    );
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const containerStyle = container ? getComputedStyle(container) : null;
    const info = {
      container: container
        ? { class: container.className, display: containerStyle.display, position: containerStyle.position, top: containerStyle.top, right: containerStyle.right, rect: rect(container) }
        : null,
      buttons: buttons.map((button) => ({
        id: button.id,
        display: getComputedStyle(button).display,
        visibility: getComputedStyle(button).visibility,
        rect: rect(button),
      })),
      styleSheets: document.styleSheets.length,
    };
    await window.api.setBackgroundColor('#101418');
    await invoke("log_stub", { message: "titlebar self-test " + JSON.stringify({ ...info, background: "ok" }) });
  } catch (error) {
    await invoke("log_stub", { message: "titlebar self-test failed " + String(error) });
  }
  // Temporary self-test for the updater slice.
  try {
    const state = await window.api.updater.check();
    await invoke("log_stub", { message: "updater self-test " + JSON.stringify(state) });
  } catch (error) {
    await invoke("log_stub", { message: "updater self-test failed " + String(error) });
  }
  // Temporary self-test for the native i18n/menu commands.
  try {
    await invoke("set_native_translations", { bundle: { locale: "en", messages: { "desktop.dialog.files": "Files" } } });
    await invoke("set_native_menu", { items: [] });
    await invoke("log_stub", { message: "i18n/menu commands ok" });
  } catch (error) {
    await invoke("log_stub", { message: "i18n/menu commands failed " + String(error) });
  }
  // Temporary self-test for the drafts slice (sqlite + blobs).
  try {
    await invoke("draft_set", { key: "p2.selftest", value: "ok" });
    const value = await invoke("draft_get", { key: "p2.selftest" });
    const blobId = await invoke("draft_blob_put", new TextEncoder().encode("blob-data"));
    const has = await invoke("draft_blob_has", { id: blobId });
    const bytes = await invoke("draft_blob_get", { id: blobId });
    const text = new TextDecoder().decode(new Uint8Array(bytes));
    const missing = await invoke("draft_blob_has", { id: "0".repeat(64) });
    await invoke("draft_delete", { key: "p2.selftest" });
    await invoke("log_stub", { message: "draft self-test " + JSON.stringify({ value, blobId: blobId.slice(0, 12), has, text, missing }) });
  } catch (error) {
    await invoke("log_stub", { message: "draft self-test failed " + String(error) });
  }
})()"##,
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
            resolve_app_path,
            draft_get,
            draft_set,
            draft_delete,
            draft_blob_put,
            draft_blob_has,
            draft_blob_get,
            set_native_translations,
            set_native_menu
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            *handle.state::<ShellState>().window_id.lock().unwrap() = Some(uuid::Uuid::new_v4().to_string());

            // Drafts database (same file/schema as the Electron shell).
            if let Ok(dir) = handle.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                match DraftStore::open(&dir.join(DRAFTS_FILE)) {
                    Ok(store) => {
                        handle.manage(store);
                    }
                    Err(error) => eprintln!("[drafts] disabled: {error}"),
                }
            }

            restore_window_state(&handle);

            // Windows parity with Electron's `titleBarOverlay`: decorum draws the
            // native-style caption controls into `[data-tauri-decorum-tb]`.
            #[cfg(windows)]
            {
                use tauri_plugin_decorum::WebviewWindowExt;
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.create_overlay_titlebar();
                }
            }

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
        .run(|app, event| match event {
            // The window still exists here, unlike `Exit` (where it is already gone).
            tauri::RunEvent::WindowEvent { label, event, .. } => {
                if label == "main" {
                    match event {
                        tauri::WindowEvent::CloseRequested { .. } => save_window_state(app),
                        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_) => {
                            // OS-driven fullscreen changes (green button, snap) reach the
                            // renderer through the same event the Electron shell used.
                            if let Some(window) = app.get_webview_window("main") {
                                let current = window.is_fullscreen().unwrap_or(false);
                                let state = app.state::<ShellState>();
                                let mut last = state.fullscreen.lock().unwrap();
                                if *last != current {
                                    *last = current;
                                    let _ = app.emit("window-fullscreen-changed", current);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            tauri::RunEvent::ExitRequested { .. } => {
                *app.state::<ShellState>().stopping.lock().unwrap() = true;
                save_window_state(app);
            }
            tauri::RunEvent::Exit => {
                *app.state::<ShellState>().stopping.lock().unwrap() = true;
                if let Some(child) = app.state::<ShellState>().child.lock().unwrap().take() {
                    let pid = child.pid();
                    let _ = child.kill();
                    println!("[shell] sidecar killed pid={pid}");
                }
            }
            _ => {}
        });
}
