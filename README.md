<p align="center">
  <img src="packages/identity/wordmark.png" width="88" alt="NextCode" />
</p>

<p align="center">Desktop AI coding agent for Windows and macOS.</p>

<p align="center">
  <a href="specs/tauri-migration.md">Tauri 2 shell</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SECURITY.md">Security</a>
</p>

---

NextCode is a desktop app around the **NextCode** engine: sessions, agents, tools and
terminals in a native window. The shell is [Tauri 2](https://tauri.app) — a Rust host plus
the operating system webview (WebView2 on Windows, WKWebView on macOS) — while the engine
and the UI come from the NextCode codebase unchanged. The migration from the Electron shell
is documented in [`specs/tauri-migration.md`](specs/tauri-migration.md).

## Install

Download the latest installer from
[Releases](https://github.com/stoltembergg-png/nextcode/releases/latest):

- **Windows 10/11 (x64)** — `NextCode_<version>_x64-setup.exe` (NSIS, per-user install)
- **macOS (Apple Silicon)** — `NextCode_<version>_aarch64.dmg`

The installers are **not code-signed yet**: Windows SmartScreen asks for
_More info → Run anyway_, and macOS wants right-click → _Open_ (or System Settings →
Privacy & Security → _Open Anyway_). Application updates are signed and verified end to end.

## Updates

The app checks the release feed on startup and from the menu, and updates in place:

```
https://github.com/stoltembergg-png/nextcode/releases/latest/download/latest.json
```

Every artifact is minisign-signed; a tampered or unsigned payload is rejected. CI signs
with `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

## Build from source

Prerequisites: [Bun](https://bun.sh) `1.3.14` (pinned in `packageManager`), Rust stable, and
the platform toolchain (Visual Studio Build Tools + WebView2 on Windows; Xcode Command Line
Tools on macOS).

```bash
bun install

cd packages/desktop
bun run predev:tauri   # stages the compiled server sidecar + builds src-tauri/web-dist
bun run tauri dev      # runs the desktop shell
```

`bun run tauri build` produces the NSIS / dmg bundle, and
[`.github/workflows/tauri-release.yml`](.github/workflows/tauri-release.yml) builds, signs
and publishes both platforms from a `v*` tag.

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/desktop` | Desktop shell: Tauri 2 (`src-tauri/`), the `window.api` shim, and the Electron shell kept during the transition |
| `packages/opencode` | The engine/server that ships as the bundled sidecar (compiled with the pinned Bun) |
| `packages/app`, `packages/ui`, `packages/session-ui` | The renderer (SolidJS) |
| `packages/core`, `packages/server`, `packages/schema`, `packages/protocol`, `packages/client` | Session runtime, HTTP API, contracts and generated clients |
| `specs/` | Design and migration documents |

## Documentation

- [`specs/tauri-migration.md`](specs/tauri-migration.md) — why the shell moved to Tauri 2, the
  comparison with Electron, and the phase-by-phase record.
- [`CONTEXT.md`](CONTEXT.md) — session runtime vocabulary (System Context, Session History,
  Session Drain).
- [`AGENTS.md`](AGENTS.md) — repository conventions (module shape, Effect rules, dependency
  direction).

## License

MIT — see [`LICENSE`](LICENSE). NextCode is based on
[NextCode](https://github.com/stoltembergg-png/nextcode); copyright remains with the original
authors.
