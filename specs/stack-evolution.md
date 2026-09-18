# Stack evolution — NextCode

Where the project stands today, and where a future upgrade would buy real quality. Numbers are
measured on the current dev build (Windows, 2026-09-18) unless marked as estimates.

## Current snapshot

| Layer | What we run | Evidence |
| --- | --- | --- |
| Shell | Tauri 2 (Rust 2021) + plugins `shell`, `single-instance` (+deep-link), `deep-link`, `dialog`, `opener`, `process`, `updater`, `log` 2.9.1, `decorum` 1.1.1 (Windows only) | `packages/desktop/src-tauri/Cargo.toml:9-37` |
| Renderer | SolidJS + Vite (`vite.tauri.config.ts`), 81.9 MB `web-dist` (1789 files), **46.9 MB of it is source maps** | `packages/desktop/src-tauri/web-dist`, `vite.tauri.config.ts:11` |
| Server | Bun-compiled single-file binary, pinned `bun@1.3.14`; staged 137.8 MB, resident 433–458 MB, `spawned → healthy` ≈ 3 s; gate = server + PTY smoke test | `packages/opencode/script/build.ts`, `smoke-server.ts` |
| Domain/API | Effect `4.0.0-beta.83`; 126 files import `effect/unstable/*`; `Effect.gen` 300 files, `Layer.` 171, `Context.Service` 133, `Schema.Class` 39; HttpApi protocol + generated clients with a `check:generated` script | root catalog, `packages/client/package.json:12-13` |
| Storage | Drizzle over SQLite; schema `packages/core/src/database/schema.sql.ts`, migrations `packages/core/src/database/migration/*.ts`; PRAGMAs: WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `cache_size=-64000`, `foreign_keys=ON`, `wal_checkpoint(PASSIVE)` | `packages/core/src/database/database.ts:27-32` |
| Data | Server DB `opencode.db` **3.13 GB**, of which the `event` table is **2.93 GB** (`part` 176 MB, `message` 69 MB, `session` 0.1 MB) | `dbstat` on the live DB |
| Release | 2 workflows: tag → sidecar cross-compiled on Ubuntu + NSIS/dmg + minisign-signed merged `latest.json` with changelog notes; macOS shell CI with path filters | `.github/workflows/tauri-release.yml`, `tauri-shell-macos.yml` |
| Observability | `tauri-plugin-log` (stdout + log dir) + `export_debug_logs` zip (manifest + shell log + server logs); Sentry wired in the renderer | `packages/desktop/src-tauri/src/main.rs`, `packages/desktop/src/renderer/index.tsx` |

## Areas and recommendations

### 1. Storage: the event log is the real problem (highest impact)
Measured 2.93 GB in `event` against 176 MB in `part` and 69 MB in `message` — the growth is the
**event log, not the conversation history**. Two consequences: disk, and any recovery/replay path
that scales with rows. Before changing anything, the retention design has to respect the
event-sourcing invariants (epoch/snapshot cutoffs) — that analysis lives in
[`performance-audit.md`](performance-audit.md) (section 2).

Two properties to plan for:
- **Pruning does not shrink the file.** The database has no `auto_vacuum`; deleting rows frees pages
  for reuse but `opencode.db` stays 3.13 GB until a rebuild (`VACUUM INTO` + swap, or a
  dump/reload). Any retention change should ship together with a one-time compaction path.
- **Stale channel databases** (`opencode-dev.db` 14 MB, `opencode-tauri-shell.db`, `opencode-.db`)
  accumulate because the file name is derived per channel/instance; a boot-time cleanup or a
  `doctor` command is cheap housekeeping.

**Recommendation (next):** define a retention cutoff (prune events below the last snapshot/epoch),
implement a bounded rewrite of the existing file, and add a size guard/telemetry so it cannot grow
silently again. Effort M · Risk M (invariants) · Impact H.

### 2. Effect on a beta line
Depth matters more than the pin: 126 files touch `effect/unstable/*`, on top of core APIs spread
over 300+ files. Tracking betas is therefore a deliberate, tested bump — not a background chore.
Options: (a) stay pinned and bump with a full test pass; (b) isolate unstable usage behind our own
adapters so the churn surface is small; (c) migrate to the first stable v4 line when it exists.

**Recommendation:** (a) + (b) now — keep the pin, and route new code through our own adapter modules
instead of importing `effect/unstable/*` directly; plan (c) as a single, budgeted migration.
Effort M (b) · Risk M · Impact M.

### 3. Bun pin and the compiled sidecar
The sidecar's runtime behaviour is bound to the exact Bun version, and that class of bug is real
here: a newer Bun produced a binary whose `Server.listen` failed, which is why the smoke gate
exists. The gate covers server health + a PTY round-trip; it does not cover provider calls, session
recovery, or LSP edges.

**Recommendation:** keep `bun@1.3.14`; when bumping, require the smoke gate to pass on all three
targets in CI and add a cheap `--version` + binary-size assertion to catch packaging drift.
Effort S · Risk L · Impact M.

### 4. Shell (Tauri 2)
The plugin set is small and each entry earns its place; `decorum` is the only third-party risk
(Windows-only overlay caption buttons, and it crashed on macOS before we scoped it to a Windows
capability).

**Verified 2026-09-18:** the 2.x line is already current — `tauri 2.11.5`, `tauri-build 2.6.3` and the
plugins as pinned in `packages/desktop/src-tauri/Cargo.lock`; `cargo update --dry-run` bumps nothing and
`bun outdated` reports no `@tauri-apps/*` entry. The newest published Tauri is `3.0.0-alpha`, outside
our range, so **the next real upgrade is Tauri 3 once it leaves alpha** — do it as one batch, gated by
the release workflow plus the macOS/Windows shell jobs.

### 5. Protocol and codegen
The generated clients already have a reproducibility check (`check:generated`), and it is now wired
into CI (`.github/workflows/codegen-check.yml`, triggered by changes to `client`, `server`, `protocol`,
`schema` and `httpapi-codegen`). It was verified clean locally; note that this clone sets
`core.autocrlf=true`, so a run here shows line-ending noise that is not content drift.

**Recommendation:** run `check:generated` in CI (cheap, catches drift). Defer any package renaming
(`@opencode-ai/*`) until there is a publishing reason — it is a mechanical but wide change.
Effort S · Risk L · Impact M.

### 6. Testing and CI
Gaps, in priority order: **no Windows shell CI** (Windows is the primary product platform, and the
release workflow only exercises it on tags), no e2e in CI, and typecheck is not enforced on the
release path. The macOS shell job is a good template: build the shell, boot it, assert the shell
self-tests.

**Recommendation:** add a Windows shell smoke job mirroring the macOS one, plus `check:generated`.
Consider a single Playwright smoke spec in CI once the job is stable. Effort S/M · Risk L · Impact H.

### 7. Observability
The renderer reports to Sentry (DSN via env, disabled when unset) and the shell writes a log file
with a working export. What is missing is **shell-side crash visibility**: a Rust panic today only
lands in the log file, and unless the user exports logs it never reaches us.

**Recommendation:** install a panic hook that routes shell panics into the same log sink (so they
are inside `export_debug_logs`), and note the log-export path in the error page. Effort S · Risk L ·
Impact M.

### 8. Packaging
Installers measure 56 MB (NSIS) and 58 MB (dmg) with the sidecar inside, so payload compression is
already doing its job. Options considered and rejected for now: on-demand sidecar download (first
run needs network, worse UX, new failure modes), splitting a "minimal" build (support burden).

**Recommendation:** keep the bundled sidecar; revisit only if it grows meaningfully. Effort — ·
Risk — · Impact L.

### 9. Renderer bundle
**Done:** source maps were embedded in every build because `vite.tauri.config.ts` set
`build.sourcemap: true`; they are now gated behind `TAURI_ENV_DEBUG` (dev keeps them, release drops
them), which took `web-dist` from 81.9 MB to **35.0 MB** (0 `.map` files). The remaining bundle item is
the 1.3 MB onboarding video, which is an eager module import in `help-button.tsx`.

## Ranked roadmap

| # | Item | Area | Impact | Effort | Risk | When |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | ~~Windows shell CI job (build + boot + self-tests)~~ **added** (`.github/workflows/tauri-shell-windows.yml`: cross-compiled sidecar + shell boot/assert; first run pending) | CI | H | S/M | L | done |
| 2 | ~~Wire `check:generated` into CI~~ **added** (`codegen-check.yml`; verified clean — this clone only shows CRLF noise) | protocol | M | S | L | done |
| 3 | ~~Drop production source maps from the Tauri build~~ **done** (81.9 MB → 35.0 MB) | bundle | M | S | L | done |
| 4 | Event-log retention + one-time compaction | storage | H | M | M | **hygiene half done**: 24h orphan sweep + `wal_checkpoint(TRUNCATE)` + `optimize`, with `GET /sync/storage` and `POST /sync/compact` surfaced in Settings (Storage section). **Temporal retention of live-session events still pending** — needs the `admitted_seq`/`promoted_seq`/epoch invariants worked through. Note: the storage API reports the total file size only; the compiled SQLite has no `dbstat` for a per-table breakdown. |
| 5 | Stale channel-DB cleanup | storage | L | S | L | next |
| 6 | Shell panic hook into the exported log | observability | M | S | L | soon |
| 7 | Isolate `effect/unstable/*` behind adapters | runtime | M | M | M | soon |
| 8 | Tauri + plugin batch upgrade | shell | — | — | — | **nothing to do now**: 2.x line is current (`tauri 2.11.5`, `cargo update` no-op); next is Tauri 3, currently alpha |
| 9 | ~~Playwright smoke spec in CI~~ **done** (the tab-close reproduction spec runs in `app-tests.yml` with chromium; the app unit tests there also run with `--conditions=solid`, and a newer Bun for the solid/ICU behaviour) | testing | M | M | M | done |
| 10 | `@opencode-ai/*` → NextCode package scope | layout | L | L | M | only if published |

## Do not do (yet)

- Rewriting the shell/sidecar architecture, or moving orchestration into the Rust side: the current
  split (Rust host + webview + bundled server) is what made the Electron → Tauri migration cheap.
- Leaving the Effect beta line for a hand-rolled abstraction, or migrating off Effect now.
- Replacing SQLite/Drizzle: the measured problem is the event table, not the storage engine.
- On-demand sidecar downloads, or splitting "minimal" installers.
- Renaming `@opencode-ai/*` packages before there is a publishing reason.
- Adding a second state/persistence layer for the renderer.
