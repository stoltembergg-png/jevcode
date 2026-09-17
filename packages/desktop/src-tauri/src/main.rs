#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
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
    let map = store_read(&app, &name)?;
    Ok(map.get(&key).map(|value| match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }))
}

#[tauri::command]
fn store_set(app: AppHandle, name: String, key: String, value: String) -> Result<(), String> {
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

fn main() {
    tauri::Builder::default()
        // Must be registered before the deep-link plugin so second launches are
        // forwarded into the running instance instead of spawning a new process.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let urls: Vec<String> = argv.into_iter().filter(|arg| arg.starts_with("opencode://")).collect();
            if !urls.is_empty() {
                let _ = app.emit("deep-link", urls);
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(ShellState::default())
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
  try {
    await invoke("log_stub", { message: "eval " + JSON.stringify(report) });
  } catch (error) {
    try { await window.__TAURI_INTERNALS__.invoke("log_stub", { message: "eval-error " + String(error) }) } catch {}
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
            log_stub
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
                *emitter.state::<ShellState>().pending_deep_links.lock().unwrap() = urls.clone();
                let _ = emitter.emit("deep-link", urls);
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
