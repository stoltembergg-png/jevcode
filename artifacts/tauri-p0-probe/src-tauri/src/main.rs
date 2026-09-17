use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::json;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_shell::ShellExt;

const PASSWORD: &str = "probe-secret-123";

fn port() -> u16 {
    std::env::var("PROBE_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(41234)
}

/// The compiled opencode binary under test.
///
/// CI sets `PROBE_OPENCODE_BIN`. For local runs the fallback is the current
/// platform's build output, resolved from the repository root.
fn opencode_bin() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("PROBE_OPENCODE_BIN") {
        return Ok(PathBuf::from(value));
    }
    let name = if cfg!(windows) { "opencode.exe" } else { "opencode" };
    let platform = if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { "opencode-darwin-arm64" } else { "opencode-darwin-x64" }
    } else if cfg!(windows) {
        if cfg!(target_arch = "aarch64") { "opencode-windows-arm64" } else { "opencode-windows-x64" }
    } else if cfg!(target_arch = "aarch64") {
        "opencode-linux-arm64"
    } else {
        "opencode-linux-x64"
    };
    for base in ["", "../", "../../", "../../../", "../../../../"] {
        let candidate = PathBuf::from(format!("{base}packages/opencode/dist/{platform}/bin/{name}"));
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("sidecar binary not found; set PROBE_OPENCODE_BIN".into())
}

fn probe_dir() -> PathBuf {
    std::env::temp_dir().join("p0-tauri-probe")
}

fn report_path() -> PathBuf {
    std::env::var("PROBE_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("p0-tauri-probe-report.json"))
}

#[derive(Default)]
struct Probe {
    zoom_requested: Mutex<Option<f64>>,
    zoom_native_ok: Mutex<Option<bool>>,
    zoom_native_error: Mutex<Option<String>>,
    zoom_dpr: Mutex<Option<f64>>,
    zoom_css_fallback: Mutex<Option<bool>>,
    sidecar_pids: Mutex<Vec<u32>>,
    spawn_route: Mutex<Option<String>>,
    spawn_errors: Mutex<Vec<String>>,
    health_status: Mutex<Option<u16>>,
    health_body: Mutex<Option<String>>,
    health_error: Mutex<Option<String>>,
}

fn unix_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

/// Kills exactly the process we spawned. `taskkill` does not exist on Unix and a
/// process-group kill is not needed here because the probe only spawns one child.
fn kill_pid(pid: u32) {
    if cfg!(windows) {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F", "/T"])
            .status();
    } else {
        let _ = std::process::Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

/// Applies zoom through the native Tauri API. Falls back to injected CSS `zoom`
/// when the native call fails, recording which path was used.
fn apply_zoom(window: &WebviewWindow, probe: &Probe, factor: f64) -> Result<String, String> {
    *probe.zoom_requested.lock().unwrap() = Some(factor);
    match window.set_zoom(factor) {
        Ok(()) => {
            *probe.zoom_native_ok.lock().unwrap() = Some(true);
            Ok("native:WebviewWindow::set_zoom".into())
        }
        Err(error) => {
            let message = error.to_string();
            *probe.zoom_native_ok.lock().unwrap() = Some(false);
            *probe.zoom_native_error.lock().unwrap() = Some(message.clone());
            let script = format!("document.body.style.zoom = '{factor}'; true");
            match window.eval(&script) {
                Ok(()) => {
                    *probe.zoom_css_fallback.lock().unwrap() = Some(true);
                    Ok(format!("css-fallback after native error: {message}"))
                }
                Err(eval_error) => Err(format!("native: {message}; css fallback: {eval_error}")),
            }
        }
    }
}

#[tauri::command]
fn set_zoom(window: WebviewWindow, state: State<'_, Probe>, factor: f64) -> Result<String, String> {
    apply_zoom(&window, &state, factor)
}

#[tauri::command]
fn get_zoom(state: State<'_, Probe>) -> f64 {
    state.zoom_requested.lock().unwrap().unwrap_or(1.0)
}

#[tauri::command]
fn zoom_readback(state: State<'_, Probe>, dpr: f64) {
    *state.zoom_dpr.lock().unwrap() = Some(dpr);
}

fn try_spawn_plugin(app: &AppHandle) -> Result<u32, String> {
    let (mut rx, child) = app
        .shell()
        .sidecar("opencode-cli")
        .map_err(|e| format!("sidecar lookup: {e}"))?
        .args([
            "serve",
            "--port",
            &port().to_string(),
            "--hostname",
            "127.0.0.1",
        ])
        .env("OPENCODE_SERVER_PASSWORD", PASSWORD)
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;
    let pid = child.pid();
    // Keep the handle alive; cleanup happens by exact PID at the end.
    std::mem::forget(child);
    std::thread::spawn(move || {
        while rx.blocking_recv().is_some() {}
    });
    Ok(pid)
}

fn try_spawn_std() -> Result<u32, String> {
    let bin = opencode_bin()?;
    let child = std::process::Command::new(&bin)
        .args([
            "serve",
            "--port",
            &port().to_string(),
            "--hostname",
            "127.0.0.1",
        ])
        .env("OPENCODE_SERVER_PASSWORD", PASSWORD)
        .current_dir(probe_dir())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn '{}': {e}", bin.display()))?;
    let pid = child.id();
    std::mem::forget(child);
    Ok(pid)
}

fn spawn_sidecar_impl(app: &AppHandle, probe: &Probe) -> Result<(u32, String), String> {
    let mut errors = Vec::new();
    if std::env::var("PROBE_FORCE_STD").is_err() {
        match try_spawn_plugin(app) {
            Ok(pid) => {
                probe.sidecar_pids.lock().unwrap().push(pid);
                let route = "tauri-plugin-shell externalBin (binaries/opencode-cli)".to_string();
                *probe.spawn_route.lock().unwrap() = Some(route.clone());
                return Ok((pid, route));
            }
            Err(e) => errors.push(format!("(a) plugin-shell externalBin: {e}")),
        }
    } else {
        errors.push("(a) plugin-shell externalBin: skipped via PROBE_FORCE_STD".into());
    }
    match try_spawn_std() {
        Ok(pid) => {
            probe.sidecar_pids.lock().unwrap().push(pid);
            let route = "std::process::Command with absolute path".to_string();
            *probe.spawn_route.lock().unwrap() = Some(route.clone());
            return Ok((pid, route));
        }
        Err(e) => errors.push(format!("(b) std::process::Command: {e}")),
    }
    *probe.spawn_errors.lock().unwrap() = errors.clone();
    Err(errors.join(" | "))
}

fn http_get_health() -> Result<(u16, String), String> {
    let auth = base64::engine::general_purpose::STANDARD.encode(format!("opencode:{PASSWORD}"));
    let request = format!(
        "GET /global/health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Basic {auth}\r\nConnection: close\r\n\r\n",
        port()
    );
    let addr = format!("127.0.0.1:{}", port())
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
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    let head: String = text.chars().take(400).collect();
    Ok((status, head))
}

fn wait_health(probe: &Probe, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let mut last_error = None;
    loop {
        match http_get_health() {
            Ok((status, body)) => {
                *probe.health_status.lock().unwrap() = Some(status);
                *probe.health_body.lock().unwrap() = Some(body);
                if status == 200 {
                    return true;
                }
            }
            Err(e) => last_error = Some(e),
        }
        if Instant::now() >= deadline {
            *probe.health_error.lock().unwrap() = last_error;
            return false;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

#[tauri::command]
fn spawn_sidecar(app: AppHandle, state: State<'_, Probe>) -> Result<String, String> {
    let (pid, route) = spawn_sidecar_impl(&app, &state)?;
    Ok(json!({ "pid": pid, "route": route }).to_string())
}

#[tauri::command]
fn health_check(state: State<'_, Probe>) -> Result<String, String> {
    match http_get_health() {
        Ok((status, body)) => {
            *state.health_status.lock().unwrap() = Some(status);
            *state.health_body.lock().unwrap() = Some(body.clone());
            Ok(json!({ "status": status, "body_head": body }).to_string())
        }
        Err(e) => {
            *state.health_error.lock().unwrap() = Some(e.clone());
            Err(e)
        }
    }
}

#[tauri::command]
fn probe_report(state: State<'_, Probe>) -> String {
    build_report(&state, None, None, 0, 0)
}

fn build_report(
    probe: &Probe,
    window_info: Option<serde_json::Value>,
    spawned_at_ms: Option<u128>,
    started_ms: u128,
    duration_ms: u128,
) -> String {
    let value = json!({
        "probe": "p0-tauri-probe",
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "started_at_unix_ms": started_ms,
        "ended_at_unix_ms": unix_ms(),
        "duration_ms": duration_ms,
        "window": window_info,
        "zoom": {
            "api": "tauri::WebviewWindow::set_zoom(factor: f64) -> tauri::Result<()>",
            "native_present_in_crate": true,
            "requested": *probe.zoom_requested.lock().unwrap(),
            "native_set_ok": *probe.zoom_native_ok.lock().unwrap(),
            "native_error": *probe.zoom_native_error.lock().unwrap(),
            "css_fallback_used": *probe.zoom_css_fallback.lock().unwrap(),
            "readback_device_pixel_ratio": *probe.zoom_dpr.lock().unwrap(),
            "readback_note": "No Rust getter exists for zoom; read devicePixelRatio from JS via zoom_readback(). DPR scales with the webview zoom factor (verified on WebView2).",
        },
        "sidecar": {
            "spawned_at_unix_ms": spawned_at_ms,
            "pids": *probe.sidecar_pids.lock().unwrap(),
            "route": *probe.spawn_route.lock().unwrap(),
            "spawn_errors": *probe.spawn_errors.lock().unwrap(),
            "health_url": format!("http://127.0.0.1:{}/global/health", port()),
            "health_status": *probe.health_status.lock().unwrap(),
            "health_error": *probe.health_error.lock().unwrap(),
            "health_body_head": *probe.health_body.lock().unwrap(),
        },
    });
    value.to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Probe::default())
        .invoke_handler(tauri::generate_handler![
            set_zoom,
            get_zoom,
            zoom_readback,
            spawn_sidecar,
            health_check,
            probe_report
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let started_ms = unix_ms();
                let start = Instant::now();
                std::thread::sleep(Duration::from_millis(2500));
                let window = handle.get_webview_window("main");
                let probe = handle.state::<Probe>();

                let window_info = match &window {
                    Some(w) => json!({
                        "created": true,
                        "label": w.label(),
                        "title": w.title().unwrap_or_default(),
                        "inner_size": w.inner_size().map(|s| json!([s.width, s.height])).unwrap_or(json!(null)),
                        "decorations": w.is_decorated().unwrap_or(true),
                        "resizable": w.is_resizable().unwrap_or(false),
                        "scale_factor": w.scale_factor().unwrap_or(0.0),
                    }),
                    None => json!({ "created": false }),
                };

                if let Some(w) = &window {
                    match apply_zoom(w, &probe, 1.25) {
                        Ok(path) => println!("[probe] set_zoom(1.25) -> {path}"),
                        Err(e) => println!("[probe] set_zoom(1.25) FAILED: {e}"),
                    }
                    let _ = w.eval("window.__probeReadDpr && window.__probeReadDpr()");
                }
                std::thread::sleep(Duration::from_millis(600));

                let mut spawned_at = None;
                match spawn_sidecar_impl(&handle, &probe) {
                    Ok((pid, route)) => {
                        spawned_at = Some(unix_ms());
                        println!("[probe] sidecar spawned pid={pid} route={route}");
                    }
                    Err(e) => println!("[probe] sidecar spawn FAILED: {e}"),
                }

                if spawned_at.is_some() {
                    let healthy = wait_health(&probe, Duration::from_secs(12));
                    println!("[probe] health ok={healthy}");
                }

                let elapsed = start.elapsed();
                if elapsed < Duration::from_millis(15000) {
                    std::thread::sleep(Duration::from_millis(15000) - elapsed);
                }

                let report = build_report(
                    &probe,
                    Some(window_info),
                    spawned_at,
                    started_ms,
                    start.elapsed().as_millis(),
                );
                let path = report_path();
                if let Err(e) = std::fs::write(&path, &report) {
                    eprintln!("[probe] failed to write report: {e}");
                } else {
                    println!("[probe] report written to {}", path.display());
                }
                println!("[probe] REPORT {report}");

                // Cleanup: kill every PID we created. Pressing "spawn sidecar" twice
                // makes the second child exit (port already bound) while the first
                // stays alive, so a single "last pid wins" kill leaks a process.
                let pids = probe.sidecar_pids.lock().unwrap().clone();
                for pid in pids {
                    kill_pid(pid);
                    println!("[probe] kill requested for sidecar pid={pid}");
                }
                handle.exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
