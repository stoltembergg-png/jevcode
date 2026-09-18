# Desktop: Electron → Tauri v2 Migration

## Goal

Replace the Electron shell of `packages/desktop` with a Tauri v2 shell while
keeping every user-visible feature and leaving the application UI byte-identical.

Scope is **Windows and macOS**. Linux desktop packaging is dropped from this
migration (see [Non-goals](#non-goals)).

Drivers, in priority order:

1. Lower runtime RAM/CPU than the Electron shell.
2. Faster startup.
3. Full functional parity with the current Electron shell ("lose nothing").

The UI must not be redesigned. `packages/app`, `packages/ui` and
`packages/session-ui` are out of scope for edits; engine-level rasterization
differences between WebView2 (Windows) and WKWebView (macOS) are accepted.

## Why Tauri 2 (vs Electron)

Electron ships and runs a full Chromium + Node runtime with the app. Tauri keeps only a
Rust host and uses the webview already installed on the machine, so the heaviest part of
the old shell is no longer started — or shipped — at all. That is what the priority order
above buys.

| | Electron (previous shell) | Tauri 2 (current shell) |
| --- | --- | --- |
| Runtime | bundled Chromium + Node (Electron 42), several processes per app | Rust host + OS webview (WebView2 / WKWebView) |
| Webview updates | shipped with the app | delivered by the operating system |
| Binary that launches | `electron` | `opencode-desktop` (release build 35 MB, measured) |
| Installer | electron-builder artifact set | NSIS 56 MB / dmg 58 MB (measured at `v0.0.2`), on top of the same ~180 MB sidecar |
| Shell IPC | `contextBridge` preload + ~60 IPC channels, Node reachable from the shell | capability-scoped Tauri commands (`src-tauri/capabilities/*.json`), no Node in the webview |
| Native integration | Electron modules (menus, dialogs, window state, single instance, deep links, updater) | Tauri plugins: `single-instance`, `deep-link`, `dialog`, `opener`, `shell`, `process`, `updater`, `log`, plus `decorum` for the Windows caption buttons |
| Title bar | `titleBarOverlay` | `decorum` overlay (Windows) and `titleBarStyle: Overlay` with traffic lights (macOS) |
| Updates | `electron-updater` + `latest.yml` | `tauri-plugin-updater` + minisign-signed `latest.json`, merged for both platforms |
| Logging | `electron-log` files | `tauri-plugin-log` (stdout + log dir) |
| Debug-log export | `src/main/logging.ts` zip | `export_debug_logs` command (manifest + shell log + server logs) |
| Build | electron-vite + electron-builder | `tauri-release.yml` (sidecar cross-compiled on Ubuntu, NSIS + dmg, signed feed) + `tauri-shell-macos.yml` |

What did **not** change: the engine (`packages/opencode`), the domain (`packages/core`),
the HTTP API (`packages/server`) and the entire UI (`packages/app`, `packages/ui`,
`packages/session-ui`). The shell is the only thing that moved, which is why parity was a
checklist instead of a rewrite.

## What was done (summary)

- **P0 — de-risking spikes**: proved the two risky pieces before committing to the
  migration — a Bun-compiled server sidecar with a working PTY, and Tauri window behavior
  (frameless zoom, `data-tauri-drag-region`, ACLs) on Windows.
- **P1 — shell**: Tauri v2 app in `packages/desktop/src-tauri` hosting the real renderer,
  with a `window.api` shim (`src/renderer/tauri-api.ts`), store, single instance, deep
  links, sidecar spawn + health + recovery, and Windows kill-on-close job objects.
- **P2 — feature parity, slice by slice**: pickers/permission tokens/opener; drafts (sqlite
  + blobs) with window state and crash recovery; native menus + i18n; title bar,
  background and zoom — each verified against the Electron behavior.
- **P4 — packaging and release**: NSIS + dmg bundles, `tauri-plugin-log` with
  `export_debug_logs`, and a release pipeline that cross-compiles the sidecar on Ubuntu and
  publishes a merged, minisign-signed `latest.json` for both platforms (live at `v0.0.2`).
- **Cleanup**: the repository was trimmed to the desktop product — dead release/bot
  scripts, orphaned `sst-env` shims, unused workflows, translated README mirrors and cloud
  infrastructure leftovers are gone.
- Still pending: the real install → update → restart cycle on an installed build, macOS
  orphan hardening, and the removal of the Electron shell.

## Why this is viable

- **The app already was Tauri v2.** `packages/desktop/src-tauri` existed until
  commit `b4147c8d08` (2026-05-05, "consolidate desktop-electron into desktop
  package", PR #25822). A snapshot of that implementation is recoverable and is
  the baseline for this migration. It already solved sidecar spawning
  (`process_wrap` with Windows `JobObject` / Unix `ProcessGroup`), macOS
  entitlements with JIT, WebView2 proxy flags, macOS-only native menus,
  `latest.json` updates and the build scripts.
- **The UI does not know the shell.** Renderer code resolves host capabilities
  through the typed `Platform` abstraction (`packages/app/src/context/platform.tsx`),
  implemented by `createPlatform()` in `packages/desktop/src/renderer/index.tsx`.
  No `window.api` calls exist in `packages/app`, `packages/ui` or
  `packages/session-ui` (single exception: the optional
  `window.api?.setTitlebar?.()` in `packages/app/src/app.tsx`).
- **The shell surface is enumerable.** ~60 IPC channels in
  `packages/desktop/src/main/ipc.ts`, a preload contract in
  `packages/desktop/src/preload/types.ts`, and a push-event set that maps
  directly onto Tauri commands and events.
- **No PTY work is required for the terminal.** The user-facing terminal is
  `@ghostty/web` (wasm) in the renderer and talks to the local server over
  HTTP/WebSocket. Native PTY (`@lydell/node-pty`) is used only by the Windows
  WSL install flow.
- **The update feed already exists in Tauri format.** The Electron shell already produced a
  minisign-signed `latest.json` (its `scripts/finalize-latest-json.ts` has since been
  removed; the release workflow builds the merged feed inline), and the CI holds
  `TAURI_SIGNING_PRIVATE_KEY`.

## Target architecture

```text
Renderer (Solid; packages/app|ui|session-ui unchanged)
  Platform ──► createPlatform() ──► window.api (Tauri shim, same shape as today)
                                      ├── invoke(command)
                                      └── listen(event)
                                            │
                    Shell (Rust): window/titlebar, menus, store, drafts,
                    pickers + attachment tokens, updater, logs, deep links,
                    WSL, CLI install/sync, sidecar lifecycle
                                            │
                    sidecar (bundle.externalBin): opencode-cli (Bun --compile)
                      └── Server.listen(...) → loopback HTTP/WS (PTY included)
```

- **Bridge**: keep `window.api` as the single renderer↔shell boundary. Implement
  it as a Tauri-backed module with the same `ElectronAPI` shape, so
  `createPlatform()` changes minimally and the `packages/desktop/AGENTS.md` rule
  ("renderer calls only `window.api` from `src/preload`") keeps holding.
  Generated bindings (tauri-specta, used by the old baseline) are optional for
  new commands, not a prerequisite.
- **Rust modules**: one per domain, mirroring today's handlers
  (`store`, `drafts`, `pickers`, `window`, `menu`, `updater`, `wsl`, `server`,
  `cli`, `logs`, `recovery`).
- **Server**: `bundle.externalBin` with the Bun-compiled `opencode-cli`, spawned
  from Rust with `process_wrap` (JobObject on Windows, `ProcessGroup` on Unix)
  and health-polled at `/global/health` before the window is shown. The server
  keeps owning PTY (REST + ticket-scoped WebSocket); the renderer talks to the
  loopback server directly — `packages/server/src/cors.ts` already allows
  `tauri://localhost` and `http://tauri.localhost`.
- **On-disk formats stay identical** for anything we import or keep writing:
  per-name JSON store files (`opencode.settings`, `opencode.global.dat`,
  `default.dat`, `opencode.window.<id>.dat`, …) and `drafts.sqlite`.

## Decisions

| Decision | Choice |
| --- | --- |
| Platform scope | Windows + macOS only |
| Visual requirement | No UI redesign; engine rasterization differences accepted |
| Baseline strategy | Selective resurrection of the pre-`b4147c8d08` Tauri shell, then port the surface added since |
| Bridge | `window.api` shim over `invoke`/`listen` |
| Distribution identity | **New app id, side by side with the installed Electron app** |
| Upgrade of existing users | No installer bridge; explicit data import on first launch |
| Terminal | Unchanged (ghostty wasm ↔ server HTTP/WS) |
| Server hosting | Bun `--compile` binary as `externalBin` |

### Resurrection policy

Port from the baseline as patterns and configuration, verified against Tauri 2.11
APIs (do not copy code blindly):

- `bundle.externalBin` sidecar layout and `tauri::process::current_binary()` path
  resolution.
- `process_wrap` lifecycle: Windows `JobObject` + `CREATE_NO_WINDOW|CREATE_SUSPENDED`
  + `KillOnDrop`; Unix `ProcessGroup::leader`; keep the documented ordering note
  (JobObject rewrites creation flags, so the custom creation-flags wrapper must
  run after it).
- Health poll before showing the window, with `.no_proxy()` for loopback hosts.
- Windows `additional_browser_args` (`--proxy-bypass-list=<-loopback>` plus
  re-applying the wry defaults).
- macOS entitlements (JIT, unsigned executable memory, dyld environment,
  library validation, audio input) and the `Overlay` title bar with
  traffic-light position.
- Build scripts: `predev` and `utils` (sidecar binary table keyed by Rust target triple);
  `prepare`, `copy-bundles` and `finalize-latest-json` were removed with the dead-code
  cleanup — the Tauri pipeline stages the sidecar and builds the feed itself.
- macOS-only native menu structure and the native i18n delivery flow.
- `install_cli` / `sync_cli` approach (repo `install` script, `--binary` argument).
- The `capabilities/default.json` permission list — it already names the ACL entries
  a desktop shell needs (`core:window:allow-start-dragging`,
  `core:webview:allow-set-webview-zoom`, `core:window:allow-set-theme`, updater /
  store / window-state / deep-link / opener defaults).

Rewrite instead of port:

- tauri-specta bindings → the `window.api` shim.
- `tauri-plugin-decorum` → native `titleBarStyle: Overlay` or own caption buttons;
  re-evaluate whether a third-party titlebar plugin is needed at all.
- All Linux display/windowing code (out of scope).
- Git `[patch.crates-io]` pins and pinned crate versions; pin to current stable.
- The separate loading window (the current shell renders an inline splash; keep
  that unless a spike proves a native window is necessary).

### New application identifiers

The Tauri app uses identifiers distinct from the Electron app, e.g.
`ai.opencode.desktop.v2` (`+ .dev` / `.beta` per channel). This is what makes
side-by-side installation possible, and it is why user data is **not** shared
automatically.

Consequences to resolve during implementation:

- **Data import is required.** First launch of the Tauri app must import from the
  Electron data directory (the inverse of `packages/desktop/src/main/migrate.ts`,
  which today performs Tauri → Electron). See [Data import](#data-import).
- **`opencode://` has one owner.** Two installed apps cannot both register the
  scheme usefully. The scheme must be claimed deliberately (and re-claimable when
  the Electron app is retired).
- **The CLI path is shared.** Both shells install/sync `~/.opencode/bin/opencode`.
  The Tauri app must version-gate or disable CLI sync while the Electron app is
  still supported, so the two do not overwrite each other.
- **Server state may be shared.** Session/project/auth storage outside the app
  data directory is shared between both apps; concurrent runs must be verified
  safe or mutually excluded.
- **Endgame.** Two identities means two data directories for one product. A later
  decision is required: keep `.v2` permanently, or collapse to the canonical id
  once the Electron app is retired (which is itself another data migration).

## Parity matrix

| Electron capability | Tauri v2 implementation | Risk |
| --- | --- | --- |
| `window.api` (~60 channels) | `#[tauri::command]` + `emit`/`listen` behind the shim | Low |
| Single instance | `tauri-plugin-single-instance`, registered first | Low |
| Deep links `opencode://` | `tauri-plugin-deep-link` + `deep-link` feature on single-instance | Low/Med |
| Frameless window + custom titlebar | `decorations: false` + `data-tauri-drag-region`; macOS `titleBarStyle: Overlay` + traffic lights; Windows caption area needs own buttons (Electron used `titleBarOverlay`) | **Med** |
| Multi-window + per-window state | `tauri-plugin-window-state` or replicate `window-state-<id>.json` | Low |
| macOS native menu + i18n | `@tauri-apps/api/menu` + a `set_native_translations` command; same 60-locale bundle, byte-for-byte copy preserved | Low/Med |
| Windows in-app menu | Unchanged (React `WindowsAppMenu`) | None |
| Store (`.dat` JSON per name) | Rust store using the same file names and formats | Low |
| Drafts (`drafts.sqlite`) | `rusqlite` with the same schema (or `tauri-plugin-sql`) | Low |
| Pickers + attachment tokens | `tauri-plugin-dialog` + per-webview token validation in Rust | Med |
| `openExternal` / `openLocalFile` / `openPath` / `revealPath` | `tauri-plugin-opener` + the existing URL allowlist | Low |
| Clipboard image read | `tauri-plugin-clipboard-manager` | Low |
| Notifications | Web Notification API unchanged; window focus/show commands | Low |
| Zoom + pinch | **Spike** (Tauri webview zoom vs a CSS-variable zoom layer) | **High** |
| macOS theme binding (`nativeTheme`) | `Window({ theme })` driven by `setTitlebar` | Med |
| Auto-update | `tauri-plugin-updater` + the existing signed `latest.json`; per-channel endpoints selected at runtime | Med |
| Logging + `exportDebugLogs` + Sentry | `tauri-plugin-log` + Rust-side zip; renderer Sentry unchanged | Low |
| Recovery dialog (unresponsive / crash) | Rust window events + `tauri-plugin-dialog` (fewer hooks than Electron) | Med |
| Server sidecar | `externalBin` + process-wrap + health poll | Med |
| WSL controller and interactive install | Rust commands (`wsl.exe`) + `portable-pty` for interactive steps | **Med/High** |
| `install-cli` / CLI sync | Rust commands using the repo `install` script (baseline did this) | Low |
| Context menu (`electron-context-menu`) | Reimplement with the Tauri menu API | Med |
| `oc://renderer` protocol, CSP, assets | Tauri asset/custom protocol; theme preload script inlined; font MIME types configured | Med |

## Phases

### P0 — De-risking spikes (~1 week)

Exit criteria:

- Bun `--compile` sidecar runs with `@lydell/node-pty` embedded on Windows and
  macOS, and is signed/notarized. Fallback if embedding fails: ship the Node
  runtime as `externalBin` with the `dist/node` bundle and `node_modules` as
  resources.
- Zoom strategy decided: confirm Tauri webview zoom support per platform, and
  prototype the titlebar with zoom applied.
- `@ghostty/web` renders, types and rescales inside WKWebView.
- `data-tauri-drag-region` dragging, click and focus behave correctly on both
  platforms.
- A test build updates itself end to end (signing + updater + sidecar restart).

Invalidation criteria: if the sidecar cannot be shipped signed/notarized, or if
zoom has no viable path, re-scope (CEF webview or stay on Electron).

Order the spikes by lead time: sidecar signing/notarization and a full update
cycle first, because certificates and CI have the longest tails; the UI-adjacent
spikes (drag regions, ghostty on WKWebView) can run in parallel.

### P1 — Shell skeleton (1–2 weeks)

Window + loading state + sidecar spawn + health poll + `awaitInitialization` +
single instance + deep links. Exit: the real UI boots and connects to the local
server on both platforms.

### P2 — Full `Platform` surface (3–5 weeks)

Store, drafts, pickers with tokens, window operations, zoom/titlebar/theme, macOS
menu with native i18n, updater, logs/export/Sentry, recovery, onboarding,
data import. Exit: functional parity with Electron except Windows-only features.

### P3 — Windows-only features and CLI (2–3 weeks)

WSL controller, interactive distro/opencode install, `install-cli`/sync,
background CLI v2 path. Exit: Windows parity.

### P4 — Packaging, CI, release (2–3 weeks)

Per-channel `tauri.conf`, `tauri-action`, Azure signing through
`bundle.windows.signCommand`, Apple notarization, `latest.json` publishing, beta
channel. Exit: a real beta release.

### P5 — Visual validation and rollout (2–3 weeks)

Screenshot-diff harness (web build in Chromium as the reference, plus real Tauri
windows on both platforms; 3 zoom levels × 3 window sizes × light/dark), QA
matrix, beta → prod promotion.

Rough order of magnitude for the whole migration: ~3 months with one developer
familiar with the shell plus CI/infra support.

## P0 results

### Spike 1 — Bun-compiled server as a sidecar (Windows) — PASS

Evidence (local, Windows x64):

- The single-target build (`bun run build --single` in `packages/opencode`)
  produces `dist/opencode-windows-x64/bin/opencode.exe` (~180 MB) and passes its
  own `--version` smoke test.
- The compiled binary serves HTTP (`/global/health` → 200 within ~1 s) and the
  full PTY round trip works: create a `cmd.exe` session → mint a connect token →
  open `/api/pty/:id/connect` over WebSocket → receive real terminal bytes →
  send `echo pty-ok` and see the marker echoed back → `DELETE /api/pty/:id` → 204.
- Conclusion: `bundle.externalBin` with PTY served by the server is validated. No
  Rust PTY and no bundled Node runtime are required.

Build-toolchain caveat:

- The repository pins `bun@1.3.14` (`packageManager`), while the locally installed
  Bun is **1.4.2**. Binaries built with 1.4.2 start and pass the `--version` smoke
  test, but fail at `Server.listen` with
  `TypeError: undefined is not an object (evaluating 'a.name')` at
  `packages/core/src/effect/layer-node.ts:241` (an `undefined` node in the layer
  dependency graph). The same build made with `bunx bun@1.3.14` works.
- A minimal compiled reproduction is **not** yet isolated: a reduced compile of the
  `locationServices` graph prints all 36 dependencies correctly under 1.4.2.
- Follow-ups: build the sidecar with the pinned Bun version; replace the
  `--version` smoke test with a **server + PTY** smoke test that actually exercises
  `Server.listen` and a PTY round trip; bisect 1.4.0/1.4.1/1.4.2 and report upstream.

### Spike 2 — Frameless window, zoom and sidecar spawn from Rust (Windows) — PASS

Evidence (minimal Tauri app with a static HTML frontend, `decorations: false`, built
and run locally):

- Window: created, `decorations: false`, 900×600, `resizable: true`, scale factor 1.0.
- Zoom: `tauri::WebviewWindow::set_zoom(factor: f64) -> tauri::Result<()>` exists and
  returns `Ok`; WebView2 applies it (`devicePixelRatio` read back from JS equals the
  requested 1.25). There is **no Rust getter** for the current zoom — the read-back
  must come from JS (`devicePixelRatio`) or from shell-side state.
- Sidecar: both spawn routes reach `/global/health` → 200 with the compiled binary:
  (a) `tauri-plugin-shell` `externalBin` (`binaries/opencode-cli-$TARGET_TRIPLE.exe`)
  and (b) `std::process::Command` with an absolute path. Killing the exact spawned
  PID (and its child) worked in both cases.
- Re-verified with the patched probe on a non-elevated run: the cleanup killed
  every spawned pid (`pids: [12164, 12228]`, no orphans) and zoom applied with a
  JS read-back of `devicePixelRatio = 1.5` for a requested 1.5.
- **Drag region needs an ACL permission, then works.** `data-tauri-drag-region` did
  nothing until `core:window:allow-start-dragging` was added to a capabilities file
  (the old Tauri baseline carried exactly that permission). After the fix the probe
  recorded 6 presses on the drag bar and 50 window-move events with changing
  coordinates, and Windows snap-to-top maximize behaves like any standard window.
  The probe ships `capabilities/default.json` with `core:default` plus that entry.
- Zoom visual scaling was not measured separately: `set_zoom` returns `Ok` and the JS
  `devicePixelRatio` read-back matches the requested factor on both platforms.

### Spike 3 — macOS probe on CI

`artifacts/tauri-p0-probe` plus `.github/workflows/tauri-p0-macos.yml` run the same
probe on a macOS runner (triggered by pushes to the spike branch): it builds the
macOS sidecar (`bun run build --single --skip-embed-web-ui`), stages it as an
`externalBin`, builds the probe with `cargo build`, runs it and uploads
`tauri-p0-report.json`. This validates compilation and runtime on WKWebView
(window creation, `set_zoom`, sidecar spawn + `/global/health`). Visual and drag
confirmation on macOS still needs a human with a Mac.

Result (macOS runner, 2026-09-17): **PASS** — frameless window created
(`decorations: false`, 900×600), `WebviewWindow::set_zoom(1.25)` returned `Ok` with a
JS read-back of `devicePixelRatio = 1.25` on WKWebView, and the sidecar built on the
runner was spawned through `externalBin` and answered `/global/health` → 200.

CI gotcha: `frontendDist` must not point into a `.gitignore`d path. The repository
root ignores `dist/`, so the probe's static page was never committed, the path did
not exist on the runner and `tauri-build` panicked (`The frontendDist configuration
is set to "../dist" but this path doesn't exist`). The probe now serves from
`public/`.

Second CI gotcha: Tauri validates the icon list at compile time (`generate_context!`),
so a Windows-only icon set fails on macOS. The probe now ships `icons/icon.png`
alongside `icons/icon.ico` and names both in `bundle.icon`.

The probe app and its workflow were removed once P0 closed (recover them from git
history if a minimal reproduction is ever needed). `.github/workflows/tauri-shell-macos.yml`
now runs the real shell on macOS and asserts the menu, sidecar and i18n behaviour.

Operational note found during the Windows probe:

- Running the probe from an **elevated** shell left an orphaned sidecar
  (`opencode-cli.exe`) holding a handle on `target/debug/opencode-cli.exe`.
  `tauri-build` deletes that copy before re-copying and then fails with
  `PermissionDenied`, so the next build breaks. Run probes non-elevated and keep
  the sidecar hardening (PID registry, stdin-EOF shutdown, job objects) in the
  real shell.
- Repeated "spawn sidecar" presses on the same port leak a process: the newer
  child fails to bind and exits while the earlier one stays alive, and a single
  "last pid wins" field makes the cleanup kill the wrong (already dead) pid.
  Kill every spawned pid and re-check death by pid. This is a concrete instance
  of the documented `CommandChild::kill()` weakness.

Follow-up implemented during P0 (see `packages/opencode`):

- `script/smoke-server.ts` boots the compiled binary, waits for
  `/global/health` and drives a PTY round trip; it is wired into
  `script/build.ts` together with a Bun-version mismatch warning. Verified
  locally against the compiled Windows binary (PASS).

## P1 results

The Tauri shell now runs the real UI on Windows (validated on this machine):

- `packages/desktop/src-tauri`: window (frameless), sidecar bootstrap (`externalBin`),
  health poll, `await_initialization`, store commands matching the Electron on-disk
  shape, single-instance, deep-link forwarding, and page-load diagnostics.
- `packages/desktop/src/renderer/tauri-api.ts`: the `window.api` shim over
  `invoke`/`listen`; it installs itself only when the Electron preload is absent, so
  `createPlatform()` and `packages/app` stay untouched.
- `packages/desktop/vite.tauri.config.ts` builds the renderer to
  `src-tauri/web-dist`; `scripts/predev-tauri.ts` stages the sidecar and builds the
  renderer on demand.
- `tauri.conf.json` uses a separate dev identifier (`ai.opencode.desktop.v2.dev`) and
  declares the `opencode` deep-link scheme.

Verified end to end: the UI boots and connects to the local server (confirmed
visually), the renderer's boot store traffic flows through the Rust store
(`opencode.global.dat`, per-window tabs, settings), closing the window kills the
sidecar, a second launch is forwarded to the running instance with its argv, and the
deep link reaches the shim (`deep-link received [...]`) and is re-dispatched as the
app's `opencode:deep-link` event.

Notes and follow-ups:

- Tauri does not propagate `document.title` changes to the native window title, so
  the title is not usable as a status channel (the page-load eval is).
- Favicons under `packages/app/public` are git symlinks; this Windows checkout
  materializes them as tiny text files (`core.symlinks=false`). Cosmetic locally.
- Temporary diagnostics (`[store]` logging, the page-load eval, shim event logging)
  must be gated behind a dev flag before P4.
- The deep link's *UI effect* (opening a project) was not visually distinguishable
  because that project was already active; re-verify during the P2 QA pass.
- P2 still to port: native pickers with attachment tokens, menus + native i18n,
  updater, logs/export, recovery dialog, drafts sqlite, opener, window state,
  titlebar theme/background color, zoom event sync.

## P2 results

### Slice 1 — native pickers, attachment tokens, opener — PASS

- Rust commands mirror the Electron semantics in `attachment-picker.ts`, `ipc.ts`,
  `external-url.ts` and `apps.ts`: directory/file/save pickers via
  `tauri-plugin-dialog`; per-selection tokens with a shared 20 MB byte budget
  (`read_picked_file` returns raw bytes through `tauri::ipc::Response`, one-shot per
  path, released explicitly); `open_external` (http/https/mailto allowlist),
  `open_local_file` (`file:` with no host), `open_path` (with an optional app),
  `reveal_path`, `check_app_exists`, `resolve_app_path` (ported `where` + `.cmd`/`.bat`
  `%~dp0` resolution) via `tauri-plugin-opener`.
- The window sets `dragDropEnabled: false` so the renderer keeps using its DOM
  drag-and-drop path exactly as under Electron. Trade-off: OS-dropped files no
  longer carry an on-disk path (Electron recovered it with `webUtils.getPathForFile`);
  restoring that needs the native drag-drop events plus a shim-side path map.
- Verified: directory picker and file picker + attachment (token round trip)
  confirmed by the user; `check_app_exists`/`resolve_app_path`/`reveal_path`
  confirmed by an automated self-test in the shell log
  (`{"appExists":true,"appPath":"C:\\Windows\\System32\\cmd.exe","revealed":true}`).
  `open_external`'s positive path is user-verifiable through in-app links (same
  opener call as `reveal_path`); its allowlist is code-reviewed only so far.
- i18n gap: the file-dialog filter label is the literal `"Files"` until the native
  translations bundle slice lands.

### Slice 2 — drafts, window state, recovery — PASS

- **Drafts**: `rusqlite` (bundled) with the exact Electron schema
  (`document(key, value)`, `blob(id, data)`, WAL) at `<app data>/drafts.sqlite`, so an
  existing Electron `drafts.sqlite` keeps working. Blobs are sha256-addressed; writes
  land immediately instead of Electron's 500 ms flush; orphan blobs are garbage
  collected at startup. Blob transfers use raw IPC bodies
  (`invoke("draft_blob_put", new Uint8Array(...))` / `tauri::ipc::Response` for reads),
  with a `draft_blob_has` probe preserving the `ArrayBuffer | null` contract.
- **Window state**: `<app data>/window-state.json` (`x`, `y`, `width`, `height`,
  `maximized`). Saved on `CloseRequested`/`ExitRequested` — not on `RunEvent::Exit`,
  where the window is already gone — and restored before the window is shown. When a
  maximized window has no previously recorded normal bounds, the current geometry is
  stored as a fallback so the file never persists zeros.
- **Recovery**: an unexpected sidecar termination now emits `sidecar-terminated` and
  restarts the server on the **same port** (up to two attempts), so the renderer's URL
  stays valid. Tauri does not expose unresponsive-renderer detection, so Electron's
  recovery dialog for unresponsive/crashed renderers is covered instead by the app's
  own connection UI plus this sidecar restart; document any residual gap when the
  renderer-side recovery UX is revisited.

Verified: draft round trip and blob hashing/readback via the shell self-test
(`{"value":"ok","blobId":"c2752ad96ee6","has":true,"text":"blob-data","missing":false}`);
killing the sidecar produced `sidecar terminated` → `restarting sidecar (attempt 1)` →
`server ready` on the same port; window state round-tripped for normal
(`1200x800 at 1230,90`) and maximized (`2560x1032 at -8,-8, maximized=true`) windows.

### Slice 3 — native menu + native i18n — PASS (Windows + macOS)

- `set_native_translations` stores the renderer's typed bundle (locale + messages) and
  resolves labels through a `native_t` equivalent of `native-translations.ts`. The file
  picker filter label now comes from the bundle (`desktop.dialog.files`); without the
  bundle the filter is skipped rather than hardcoding English (AGENTS.md).
- `set_native_menu` receives the shared menu specification, built in the renderer from
  `@opencode-ai/app/desktop-menu` (macOS-visible entries only) and mirrored from
  `src/main/menu.ts`: OS roles map to predefined items, `command` items forward
  `menu-command` to the renderer, `action` items run shell-side (mirroring
  `desktop-menu-actions.ts`) and `href` items go through the opener. Accelerators are
  translated from the app's mac-style tokens; unsupported tokens drop the accelerator
  instead of failing.
- The menu is applied on macOS only (`app.set_menu`), matching Electron's macOS-only
  native menu; on Windows the shell builds it and logs the item count without applying.
- Verified on Windows: `[i18n] bundle received locale=br keys=90`,
  `[menu] spec received: 7 submenu(s)`,
  `[menu] built 55 item(s) (not applied on this platform)`. The real macOS menu bar is
  compile-verified only — add it to the macOS QA checklist for CI/human validation.

macOS validation (CI run 35274975002, `.github/workflows/tauri-shell-macos.yml`): the real
shell ran on a macOS runner and its `run.log` shows `[i18n] bundle received locale=en
keys=90`, `[menu] spec received: 7 submenu(s)`, `[menu] applied 55 item(s)`, `server ready`,
renderer store traffic and the drafts self-test — all assertions green. Two notes from
that run:

- the picker self-test uses Windows paths/expectations, so on macOS it reports
  `{appExists:false, appPath:"cmd", revealed:false}` (platform-correct, not a regression);
  make the self-test platform-aware if it is kept long term;
- the sidecar logs `background dependency install failed ... @opencode-ai/plugin@0.0.0-<branch>-...`,
  which is expected for branch builds whose version is not published to npm.

Dev-loop gotcha (cost real debugging time, worth knowing): **Tauri embeds `frontendDist`
into the binary at compile time.** After changing anything under `src/renderer`, run
`cargo build` again (or use `tauri dev`); rebuilding only the renderer changes nothing
the running app can see.

## P4 prerequisites and updater E2E

### Updater E2E (unsigned build, local feed) — PASS

The shell ships `tauri-plugin-updater` (+ `tauri-plugin-process`) with the real minisign
public key in `plugins.updater.pubkey`. Verified end to end against a local feed
(`http://127.0.0.1:8787/latest.json`, a dev-only endpoint): the app checks the feed,
compares versions, downloads the artifact and verifies its minisign signature against
the embedded key — `updater self-test {"status":"ready","version":"0.0.2"}`. The state
machine mirrors the Electron controller (`idle/checking/downloading/ready/up-to-date/
installing/error`), so the existing UI works unchanged. Still required for P4: a real
`tauri build` (NSIS) plus the actual install/restart cycle, `bundle.createUpdaterArtifacts`
with signed artifacts in CI, and HTTPS endpoints per channel.

Gotchas found: PowerShell 5.1 `Set-Content -Encoding UTF8` writes a BOM that breaks feed
decoding; `tauri signer sign` wants the base64 key *contents* (only the bundler accepts a
path); the private key's password cannot be supplied non-interactively, so the signing step
must run where the password is available.

### Credentials (2026 state)

- **Updater keypair**: generated locally (`~/.tauri/opencode.key[.pub]`). Back it up
  off-line; rotating it silently strands existing installs unless done as a two-release
  transition (the old key signs a build that already embeds the new pubkey).
- **Windows**: **Azure Artifact Signing** (renamed from Trusted Signing, GA Jan 2026,
  `azure/artifact-signing-action@v2`) costs ~US$120/yr and needs a paid Azure
  subscription, but Individual identity validation is only available in the US/Canada and
  Organization only in the listed countries — **Brazil is not covered**. The practical
  route is therefore a classic OV/EV certificate with cloud signing (post-2023 CA/B rules
  require the key in an HSM; SSL.com eSigner OV ≈US$309/yr, DigiCert KeyLocker
  ≈US$996/yr), wired through `bundle.windows.signCommand`.
- **macOS**: Apple Developer Program US$99/yr; Individual enrollment ≈24h (no D-U-N-S),
  Organization needs a D-U-N-S number (1–2+ weeks). Use a **Developer ID Application**
  certificate (an "Apple Development" certificate is rejected by notarization) plus an App
  Store Connect API key (`.p8`, single download) for notarization.
- Secrets live in the repository/environment (`gh secret set`); OIDC federation is
  preferred for Azure. Public-repo note: workflows triggered by fork PRs never receive
  secrets, and `pull_request_target` must never be combined with checking out untrusted
  code.

### Slice 4 — titlebar overlay, window background, event sync — PASS (automated checks)

- **Windows caption controls**: `tauri-plugin-decorum` 1.1.1 with
  `create_overlay_titlebar()` draws native-style minimize/maximize/close controls into
  `[data-tauri-decorum-tb]` (marker in `src/renderer/index.html`, 40px height rule in
  `src/renderer/styles.css`), matching Electron's `titleBarOverlay`. Verified in-page:
  `titlebar self-test {"decorumButtons":3,"background":"ok"}`.
- **Window background**: `setBackgroundColor` now calls `Window.setBackgroundColor`; the UI
  already pushes the theme background on every change.
- **Event sync**: shell-driven zoom changes (menu actions, macOS menu items) emit
  `zoom-factor-changed`, and OS-driven fullscreen changes emit
  `window-fullscreen-changed`; both feed the renderer modules that already existed
  (`webview-zoom.ts`, `window-fullscreen.ts`). Menu commands still forward to the renderer
  as `menu-command`, while `run_menu_action` covers reload, devtools, zoom, fullscreen,
  window operations, edit operations and relaunch.
- A shell log file and a real `exportDebugLogs` were also deferred to P4; they are done
  below (see "Shell logging and debug-log export").

### Sidecar lifetime hardening — PASS (Windows)

The spawned server is assigned to a Windows Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`windows-sys` 0.59 with `Win32_Security` +
`Win32_System_JobObjects`), so a hard kill of the shell (crash, Task Manager, CI
teardown) also kills the server. Verified: `sidecar 19088 bound to a kill-on-close job
object`, then `Stop-Process -Force` on the shell → the sidecar died and
`target/debug/opencode-cli.exe` was released (before this, the orphaned server locked
that copy and broke the next `cargo build`). macOS has no job-object equivalent, so a
hard kill there can still orphan the server; a PID registry with a boot sweep (or
stdin-EOF shutdown if the server supports it) stays open for P4.

## P4 — packaging

### First NSIS bundle — PASS

- `bundle.active: true` with `targets: ["nsis"]`; `bun run tauri build` produces
  `target/release/opencode-desktop.exe` (35 MB), the bundled sidecar
  (`opencode-cli.exe`, 172 MB) and `OpenCode_0.0.0_x64-setup.exe` (63 MB). The packaged
  app boots with its bundled sidecar — verified through processes and the window, because
  a release build is a `windows_subsystem = "windows"` app and has no stdout diagnostics.
- The `tauri` crate enables the `devtools` feature (Electron exposed "Toggle Developer
  Tools" in production too, so this keeps parity).
- **Release boot panic found and fixed**: the updater plugin refuses non-HTTPS endpoints
  in release builds (`The configured updater endpoint must use a secure protocol like
  https`) and the app panicked at startup. The base `tauri.conf.json` now points at the
  GitHub releases feed (`https://github.com/stoltembergg-png/NextCode/releases/latest/download/latest.json`)
  and the local feed moved to `tauri.dev.conf.json`
  (`dangerousInsecureTransportProtocol: true`), used explicitly for the local updater E2E.
- Caption-control polish: the decorum hover overlay was a black tint (invisible on dark
  themes), replaced with a `color-mix(currentColor 12%)` overlay so minimize/maximize
  give the same feedback as Windows 11; close keeps decorum's red hover.

### Shell logging and debug-log export — PASS

- `tauri-plugin-log` replaces electron-log: `stdout` target + `LogDir` file target
  (defaults, no extra targets) with an `Info` level filter and a compact format
  (`[HH:MM:SS] [tag] message`, level marked only for warn/error). Builder::target adds
  to the default targets, so the defaults alone are the right configuration — two extra
  `.target` calls duplicated every line.
- The whole `[tag]` println/eprintln diagnostic surface moved to `log::info!`/`log::error!`
  (plus `log::warn!` for the not-yet-wired menu actions), so release logs land in
  `%LOCALAPPDATA%/<identifier>/logs/OpenCode.log` (6.8 KB, verified). `log_stub` now logs
  on every platform so fatal renderer errors reach the file in release builds too.
- `export_debug_logs` command (mirrors `src/main/logging.ts`): zips `desktop/` (shell log
  dir), `server-1/` (`~/.local/share/opencode/log`), `server-2/` (`userData/opencode/log`)
  and a `manifest.json` (version, platform, arch, paths, packaged) into
  `<downloads>/nextcode-debug-<stamp>.zip`, then reveals it. Last-24h mtime, ≤ 50 MB per
  file, `.heapsnapshot` excluded, matching the Electron filters. Debug builds write a
  fixed `nextcode-debug-dev.zip` in the temp dir so the self-test stays tidy.
- Renderer shim: `exportDebugLogs` invokes the command (was a no-op resolve).
- Verified: exported zip 845 KB with manifest ✓, `desktop/` ✓ and `server-1/` ✓ entries.

### Release pipeline — PASS

- `.github/workflows/tauri-release.yml` (the two kept workflows are it and
  `tauri-shell-macos.yml`) builds the bundle on Windows (NSIS) and macOS (.app + .dmg)
  and publishes a GitHub release on `v*` tags or a manual dispatch.
- The sidecar is cross-compiled once on Ubuntu (`--targets=opencode-windows-x64,
  opencode-darwin-arm64`, a new `build.ts` flag) and downloaded by the platform jobs:
  building it natively on Windows trips Bun's lifecycle shim for tree-sitter-powershell,
  which expects a project-root node-gyp the pinned Bun does not provide.
- The Windows install retries around Bun's ENOTEMPTY patched-cache rename
  (oven-sh/bun#28147), which is flaky under CI timing.
- Version and tag derive from the tag (`v0.0.2` → `0.0.2`); a dedicated `release` job merges
  the per-platform `latest-fragment-*.json` files into the single `latest.json` the updater
  reads and uploads the installers plus the macOS `.app.tar.gz` (the darwin updater
  artifact) with their `.sig` files.
- The `release` job checks out the tag with full history and builds a compact changelog from
  the conventional-commit subjects between the previous tag (`git describe --tags --abbrev=0
  "$TAG^"`; last 50 commits when there is none) and `$TAG`. The same text lands in the GitHub
  release body (after the `NextCode <tag>` heading) and in `latest.json`'s `notes`, so the
  in-app updater prompt shows the release notes; any generation failure publishes without notes.
- Verified end to end: `v0.0.2` published with **both** platforms signed in `latest.json`,
  both asset URLs answer 200, and the installed Windows build reports "Você está
  atualizado" from the real HTTPS feed.
- Secrets: `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` enable
  signing/updater artifacts (`createUpdaterArtifacts` turns on by itself); the Apple and
  Azure secrets stay optional and degrade gracefully.

Still to do: install `v0.0.1` and let the updater move it to `v0.0.2` (the real
install → update → restart cycle), and macOS orphan hardening.

## Cross-cutting tasks

- **Bridge contract test**: assert that every method on the `window.api` shim has a
  matching registered Rust command or event channel. The shim removes the
  compile-time guarantee that generated bindings provided, so this test replaces
  it.
- **Test suite migration**: `packages/desktop/electron-builder.config.test.ts`
  (channel/appId matrix) must be replaced by equivalent assertions over the
  per-channel Tauri config; `shell-env` and renderer HTML tests must be ported to
  the new module layout. UI e2e stays on the web build (Chromium).
- **Dev workflow**: keep the current DX — `bun run dev` with HMR, Vite on a fixed
  port with `TAURI_DEV_HOST` support, and file watching that ignores `src-tauri`.
- **Sentry source maps**: the Electron build uploads renderer source maps through
  `@sentry/vite-plugin`; the Tauri build must upload the same artifacts.
- **`OPENCODE_SIDECAR_V2`**: the background-CLI path must keep working unchanged
  through the new shell.

## Data import

First launch of the Tauri app imports from the Electron data directory:

- Windows: `%APPDATA%/ai.opencode.desktop[.dev|.beta]`
- macOS: `~/Library/Application Support/ai.opencode.desktop[.dev|.beta]`

Rules:

- Mirror `packages/desktop/src/main/migrate.ts` in reverse: read `*.dat` JSON
  files and seed keys into the corresponding store, **skipping keys the user has
  already set**; special-case `opencode.settings.dat` → `opencode.settings`.
- Copy `drafts.sqlite` when the target does not exist yet.
- Record a completion flag so the import runs once, and keep the Electron
  directory untouched (the Electron app must keep working during the transition).
- Window geometry is not imported; `window-state-<id>.json` uses a different
  format from `tauri-plugin-window-state`. Accept a default window size.
- Do not import `window-state-*.json`, logs or crash dumps.

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | Zoom controls the whole titlebar today (height `40 × zoom`, legacy `counterZoom`); research disagreed on whether Tauri exposes an equivalent | **Resolved by P0 on Windows and macOS**: native `WebviewWindow::set_zoom` exists and works on WebView2 and WKWebView (JS DPR read-back matches). Remaining: no Rust getter, so track zoom in shell state + JS read-back; Windows caption buttons must be drawn by us (no `titleBarOverlay` equivalent) |
| 2 | Two installed apps share `opencode://`, `~/.opencode/bin` and possibly server state | Explicit ownership rules; version-gated CLI sync; concurrency test |
| 3 | `@ghostty/web` (canvas/WebGL2) on WKWebView | P0 spike; preload Nerd Font before the canvas mounts |
| 4 | WSL needs host-side PTY | `portable-pty` in Rust, reusing the process-group/JobObject pattern |
| 5 | Bun sidecar loses JIT under hardened runtime without `allow-jit` | Baseline entitlements + `codesign --verify --deep` gate in CI |
| 6 | VPN/proxy breaks loopback in WebView2 | `--proxy-bypass-list=<-loopback>` plus re-applying wry defaults (baseline already solved this) |
| 7 | No official Tauri context-menu plugin | Reimplement with the menu API |
| 8 | `tauri-driver` does not support macOS, so Electron-era e2e cannot move over | Keep UI e2e on the web build (Chromium) and add scripted smoke tests against Tauri windows |
| 9 | Orphaned sidecar processes | PID registry, stdin-EOF shutdown, JobObject/process-group kill |
| 10 | macOS window-state/menu behavior differs from Electron | Validate in P2 against the visual-diff harness |

## Non-goals

- Redesigning, restyling or restructuring any UI.
- Supporting Linux desktop builds in this migration.
- Porting the opencode server to Rust.
- Removing the Electron shell during this migration; both exist side by side.
- Importing or migrating user data automatically beyond the documented import
  step (no two-way sync).

## Open blockers

- **Signing/updater credentials are not provisioned in this fork.** Azure Trusted
  Signing, Apple notarization and `TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are referenced by `.github/workflows/publish.yml`
  but do not exist in this repository's CI. This blocks the signed-build /
  auto-update spike and all of P4 until they are provisioned.
- **No local macOS machine.** WKWebView spikes and visual QA for macOS run on CI
  (GitHub Actions macOS runners).
- **Local Windows environment for spikes**: Bun and Rust 1.98.1 stable MSVC
  (`rustup`, minimal profile) are installed; WebView2 Runtime 153 and VS 2022
  BuildTools are present.

## Review status

Reviewed internally by the orchestrator against the seven analysis lanes (Electron
shell inventory, Tauri baseline archaeology, UI host-API surface, visual risk
audit, Tauri v2 capabilities, sidecar/PTY architecture, webview rendering parity).

An independent @oracle review was attempted three times and did not complete
(sessions stopped without a terminal result), so this spec has **not** had a
second independent pass. Before starting P2, obtain an independent review of:
the bridge choice, phase ordering, the side-by-side identifier consequences
(`opencode://` ownership, shared CLI path, shared server state), and the zoom
strategy.

## References

- Recoverable baseline: `packages/desktop/src-tauri` at commit `b4147c8d08^`
  (a local snapshot of that tree was used during analysis).
- Current shell: `packages/desktop/src/main/**`, `packages/desktop/src/preload/**`,
  `packages/desktop/src/renderer/**`.
- Bridge contract: `packages/desktop/src/preload/types.ts`.
- Platform abstraction: `packages/app/src/context/platform.tsx`,
  `packages/desktop/src/renderer/index.tsx`.
- Server artifact: `packages/opencode/script/build.ts` (12 compile targets),
  `packages/opencode/src/node.ts` (`Server.listen`).
- Update feed: `.github/workflows/tauri-release.yml` (merged `latest.json`, Azure signing,
  Apple notarization, `TAURI_SIGNING_PRIVATE_KEY`).
- Old Tauri data migration (to invert): `packages/desktop/src/main/migrate.ts`.
