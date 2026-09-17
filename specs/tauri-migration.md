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
- **The update feed already exists in Tauri format.** `packages/desktop/scripts/finalize-latest-json.ts`
  already produces a minisign-signed `latest.json`, and the CI already holds
  `TAURI_SIGNING_PRIVATE_KEY`. `packages/containers/tauri-linux` also exists.

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
- Build scripts: `predev`, `prepare`, `copy-bundles`, `finalize-latest-json`,
  `utils` (sidecar binary table keyed by Rust target triple).
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
- Update feed: `packages/desktop/scripts/finalize-latest-json.ts`,
  `.github/workflows/publish.yml` (Azure signing, Apple notarization,
  `TAURI_SIGNING_PRIVATE_KEY`).
- Old Tauri data migration (to invert): `packages/desktop/src/main/migrate.ts`.
