# Tauri P0 probe

Throwaway spike used to de-risk the Electron → Tauri v2 migration (see
`specs/tauri-migration.md`). It answers, on a real Tauri window:

1. Does a frameless window with `data-tauri-drag-region` work?
2. Does `WebviewWindow::set_zoom` exist and actually apply?
3. Can the compiled `opencode` binary be spawned as a sidecar (both through
   `tauri-plugin-shell` `externalBin` and through `std::process::Command`) and
   reach `/global/health`?

The window renders a 40px drag bar, zoom buttons and a "spawn sidecar" button;
after ~15s it writes a JSON report and exits.

## Local run (Windows)

```powershell
# build the sidecar first (from packages/opencode)
bun run build --single

# stage it for externalBin (triple-suffixed name)
$triple = (rustc -vV | Select-String '^host: ').ToString().Split(' ')[1]
Copy-Item packages/opencode/dist/opencode-windows-x64/bin/opencode.exe "artifacts/tauri-p0-probe/src-tauri/binaries/opencode-cli-$triple.exe"

cd artifacts/tauri-p0-probe/src-tauri
cargo build
$env:PROBE_OPENCODE_BIN = (Resolve-Path ../../../packages/opencode/dist/opencode-windows-x64/bin/opencode.exe)
./target/debug/p0-tauri-probe
```

Run it from a normal (non-elevated) shell: an elevated run leaves an orphaned
sidecar that locks `target/debug/opencode-cli.exe` and breaks the next
`tauri-build` (it deletes that copy before re-copying).

## CI

`.github/workflows/tauri-p0-macos.yml` (`workflow_dispatch`) builds the macOS
sidecar, builds this probe and runs it on a macOS runner, uploading
`tauri-p0-report.json` as an artifact.
