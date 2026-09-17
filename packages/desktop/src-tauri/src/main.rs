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
        .invoke_handler(tauri::generate_handler![
            await_initialization,
            consume_initial_deep_links,
            get_window_id
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
