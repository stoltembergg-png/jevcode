# Performance audit — app, sessions, providers

Measured on the dev build (Windows, 2026-09-18) with the app running; code references come from two
read-only evidence passes over the repository. The roadmap lives in
[`stack-evolution.md`](stack-evolution.md).

## 0. Measured baseline

| Stage | Measurement |
| --- | --- |
| Shell ready (window + stores) | < 1 s |
| Sidecar `spawned → server listening` | ≈ 3 s |
| Renderer loaded, self-tests done | ≈ 4 s total |
| Compiled sidecar `--version` (cold) | 829 ms |
| `opencode-desktop` resident | 55 MB |
| `opencode-cli` resident | 433–458 MB |
| Our WebView2 processes (6) | 441 MB |
| Total | **≈ 930 MB** |
| Sidecar idle CPU | **1.2%** of one core (0.19 s / 15 s) |
| `web-dist` | 81.9 MB / 1789 files — **46.9 MB is source maps**, 1.3 MB an onboarding mp4 |
| Server DB `opencode.db` | **3.13 GB**, `event` = **2.93 GB** (`part` 176 MB, `message` 69 MB, `session` 0.1 MB) |
| Shell drafts DB | 3.5 MB (`drafts.sqlite`, scanned on every boot) |
| models.dev cache | not present at `%LOCALAPPDATA%\opencode\Cache` in this environment (see §3) |

Correcting two assumptions along the way: the sidecar spawns **no** language servers at boot (its only
child is `conhost.exe`), and the server creates **no** project instance at boot (`serve.ts` passes
`instance: false`; instances are created per request via `x-opencode-directory`).

## 1. Storage: the durable event log (top finding)

**What the data is.** `event` (`packages/core/src/event/sql.ts:10-25`) is an append-only durable log:
`id`, `aggregate_id`, `seq`, `type`, `data` (JSON), unique index on `(aggregate_id, seq)` plus a lookup
index on `(aggregate_id, type, seq)` (DDL: `packages/core/src/database/schema.gen.ts:79-88,239-240`).

**Why it grows without bound.** One insert path — `commitDurableEvent`
(`packages/core/src/event.ts:336-348`) — fed by the V2 projectors
(`packages/core/src/session/projector.ts:214-413`), which emit a durable row per logical event
(`Text.*`, `Tool.Called/Progress/Success/Failed`, `Reasoning.*`, `Step.*`, `Shell.*`, `Compaction.Ended`,
prompt/context/agent/model transitions). Rows are never updated; the only delete path is
`EventV2.remove(aggregateID)` (`event.ts:514-523`), reached solely when a session is deleted
(`packages/opencode/src/session/session.ts:623`). **There is no retention, pruning or compaction of
`event`** (the only retention code in the repo covers tool output and PTYs).

**What reads it, and when.** Opening the DB does not scan `event`
(`packages/core/src/database/database.ts:22-37`), and epoch state lives in its own table
(`session_context_epoch`, `packages/core/src/session/sql.ts:168-176`) with `latestSequence` reading one
row. The cost is **per aggregate**: `readAggregate` (`packages/core/src/event.ts:63-108`) and the
durable stream (`event.ts:585-604`) read `seq > after` ordered by `seq` with `LIMIT n+1`, but callers
that omit `after` default to `-1` — a **full history scan for that session**
(`packages/core/src/session.ts:346-359`). Long sessions get slower as their own log grows, even though
database-wide boot stays cheap.

**The load-bearing constraint.** Pre-epoch events are still required by: (a) `V2Session.history`;
(b) durable stream subscribers; (c) workspace sync replay — `SyncHttpApi.history`
(`packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts:72-85`) does
`SELECT * FROM event WHERE NOT (aggregate_id=? AND seq<=?) ORDER BY seq ASC` **with no limit**;
(d) exact-retry of admitted prompts, whose `session_input` rows reference `admitted_seq`/`promoted_seq`
(`packages/core/src/session/sql.ts:140-166`); (e) prompt admission reading `latestSequence`. Retention
therefore cannot be "delete everything below the epoch" without reworking those contracts.

**Pruning alone does not reclaim disk.** The connection sets `WAL`, `synchronous=NORMAL`,
`busy_timeout=5000`, `cache_size=-64000`, `foreign_keys=ON`, `wal_checkpoint(PASSIVE)`
(`database.ts:27-32`) but no `auto_vacuum`, no `optimize`, no scheduled `VACUUM`: freed pages are
reused, the file keeps its high-water mark until a rebuild (`VACUUM INTO` + swap or dump/reload).

**Session-facing queries.** Message history is paginated and indexed (`message` cursor query + `part`
hydration: `packages/opencode/src/session/message-v2.ts:425-467,98-123`), the session list is
`LIMIT 100` over `session_project_idx`/`session_workspace_idx`
(`packages/opencode/src/session/session.ts:955-1008`) — the *list* is not the bottleneck. The unbounded
surfaces are the whole `data` JSON per row delivered to the renderer and the sync/replay stream above.

**Channel DB files.** Filename derives from `OPENCODE_CHANNEL` (`database.ts:43-55`): `latest|beta|prod`
→ `opencode.db`, anything else → `opencode-<channel>.db` (branch-named dev runs get their own file,
e.g. `opencode-tauri-shell.db`). Nothing cleans up stale ones (14 MB `opencode-dev.db`,
`opencode-tauri-shell.db`, `opencode-.db` were present).

| Fix | Impact | Effort | Risk |
| --- | --- | --- | --- |
| Bound `SyncHttpApi.history` (limit + cursor) | H | S | L |
| Default `after` to the session's compaction/baseline window where semantics allow | H | M | M |
| Retention for `event` below a cutoff derived from `admitted_seq`/`promoted_seq`/epoch + one-time compaction | H | M | M |
| `PRAGMA optimize` on close, periodic `wal_checkpoint(TRUNCATE)` | M | S | L |
| Sweep stale `opencode-<channel>.db` files | L | S | L |

## 2. Startup and bundle

**First paint is gated by `setup()`.** Tauri paints the window only after `.setup()` returns, and this
block is synchronous (`packages/desktop/src-tauri/src/main.rs:1643`). Inside it, in order:
`window_id` (trivial) → **drafts DB open + `gc_orphan_blobs`** (`:1648-1656`, store at `:825-838`, GC at
`:841-870`): opens `drafts.sqlite`, then selects every `document` row, JSON-parses each one, walks it to
collect referenced blob ids, and deletes unreferenced blobs — cost scales with
`documents × document size + blobs`, and it runs on the UI thread before the window paints (measured DB:
3.5 MB today, but this grows with use) → **the main first-paint blocker**;
`restore_window_state` (`:1658`, one small JSON read); decorum overlay (`:1662-1668`, Windows);
deep-link queue and callback (`:1671-1684`). The sidecar is spawned on a detached thread (`:1686-1687`),
so `setup` does not wait for it.

**Sidecar spawn and health.** `start_sidecar` (`main.rs:151-167`) allocates a free port and a random
password; `spawn_sidecar` (`:172-199`) runs `opencode-cli serve --hostname 127.0.0.1 --port … --print-logs`
with basic-auth env plus `XDG_STATE_HOME`, then binds the child to a Windows job object (`:208-222`).
A thread drains stdout/stderr and restarts on unexpected exit (`:227-252`, ≤2 attempts, same port); a
separate thread polls `GET /global/health` every 300 ms with a 2 s connect timeout up to 90 s
(`:255-277`), and the renderer polls `await_initialization` every 200 ms (`:281-296`). So the measured
~3 s is the server's own boot; shell polling adds at most ~300 ms.

**Server boot.** `serve.ts:14` dynamically imports the server; `Server.listen` builds the listener layer
(`packages/opencode/src/server/server.ts:73-138`), which materializes the global `AppLayer`
(`packages/opencode/src/effect/app-runtime.ts:58-109`) — including `ModelsDev.node` and `Provider.node`.
The provider service itself stays lazy (`provider/provider.ts:1195-1206`, no `init()`), and per-instance
boot (config, plugins, then `lsp/shareNext/format/vcs/snapshot/project` inits concurrently,
`packages/opencode/src/project/bootstrap.ts:32-46`) only runs on the first per-directory request, not at
process start.

**Bundle.** `packages/desktop/vite.tauri.config.ts:12` sets `build.sourcemap: true` (and
`packages/app/vite.config.ts:31` does the same for the web build), so the Tauri `frontendDist` embeds
**835 `.map` files / 46.9 MB** — pure weight in the binary and installer. The entry chunk itself is
2.7 MB, with `ghostty-web` (1.35 MB) and the session/dialog modules among the largest. The 1.3 MB
onboarding video is an **eager module import** (`packages/app/src/components/help-button.tsx:9`) even
though its popup is conditional, so it ships in the entry chunk.

| Fix | Impact | Effort | Risk |
| --- | --- | --- | --- |
| Emit source maps only for debug builds (`TAURI_ENV_DEBUG`) | M | S | L |
| Move the onboarding video behind a dynamic import | L | S | L |
| Defer/limit `gc_orphan_blobs` (after first paint, or bounded batch) | M | S/M | L |

## 3. Providers / models

**Source and cache.** `packages/core/src/models-dev.ts:160-164` resolves
`OPENCODE_MODELS_URL || "https://models.opencode.ai"` and caches to
`Global.Path.cache/opencode/models.json` (hash-suffixed for custom sources). Freshness is a 5-minute
mtime TTL (`:165-173`); the layer is wrapped in `Effect.cachedInvalidateWithTTL(…, infinity)` (`:233`) so
the first caller pays, and a scoped fiber refreshes every 60 minutes (`:255-258`). Population reads the
disk cache first (`:184-196`), then (unless `OPENCODE_DISABLE_MODELS_FETCH` is set) fetches
`${source}/api.json` under a file lock with a **10 s timeout and 2 retries** (exponential 200 ms +
jitter, `:150-158,175-215`). **The cache file was absent at the expected path in this environment**, so
the cold-cache path — including that network call — is the one that runs (worth re-measuring on a fresh
profile).

**Nothing blocks the UI on models.** `AppLayer` constructs the service, but no route awaits it during
boot; the first provider-list request is what triggers the cache read or fetch. Per-instance boot does
not touch models.dev, and the renderer dialogs read reactively from the store rather than fetching on
mount (`packages/app/src/components/dialog-connect-provider.tsx:161,233,393`,
`packages/app/src/context/models.tsx:6,29`).

**What the first paint of data costs.** `bootstrapGlobal`
(`packages/app/src/context/global-sync/bootstrap.ts:154-166,221-244`) fires, on v2, three parallel
requests — `provider.list`, `model.list`, `model.default` — wrapped in a retry, and awaits their
settlement as part of the global bootstrap. `GET /provider`
(`packages/opencode/src/server/routes/instance/httpapi/groups/provider.ts:38-47`) merges the entire
models.dev catalog with the instance provider list and auth into `{ all, default, connected }`, where
`all` enumerates **every provider × every model** with cost, limits, capabilities, variants, headers,
modalities and release dates (`provider/provider.ts:1078-1113`) — the largest per-route payload in the
app. On a stale cache the first request also waits for the fetch above.

| Fix | Impact | Effort | Risk |
| --- | --- | --- | --- |
| Serve a compact provider/model projection for the bootstrap, with details on demand | H | M | M |
| Do not let the first provider request block on a network fetch (serve cache, refresh async) | M | S/M | L |
| Warm the models cache in the background right after `server ready` | L | S | L |
| Reconsider the default models source (see flagged decision) | M | S | M |

## Flagged decisions (need your call, not mechanical fixes)

1. **`https://models.opencode.ai` is still the runtime default** (`packages/core/src/models-dev.ts:160`,
   and `packages/ui/vite.config.ts:48` for the web build). It is a *service*, not a label: it is upstream's
   models.dev proxy. Pointing it at the public `https://models.dev/api.json` may change the metadata
   (pricing/limits), so this is a functional decision rather than a rename.
2. **`OPENCODE_MODELS_URL` / `OPENCODE_*` env names** remain the configuration surface (kept deliberately
   during the rebrand); aliasing them to `NEXTCODE_*` is a small, cheap follow-up if you want it.

## Measurement plan

- Boot: `[shell] sidecar spawned` → `[sidecar] NextCode server listening` timestamps in
  `%LOCALAPPDATA%\ai.opencode.desktop.v2.dev\logs\OpenCode.log`; renderer side from `[page] Started/Finished`.
- Sidecar cold start: `Measure-Command { opencode-cli.exe --version }`.
- DB growth: `bun` script with `dbstat` (as used for this audit) on
  `~/.local/share/opencode/opencode.db`, grouped by table.
- Provider payload: time and size `GET /provider` and the v2 `model.list` with the server's basic auth,
  warm vs cold cache (delete `models.json` first).
- Bundle: `Get-ChildItem web-dist -Recurse | Measure-Object Length -Sum` after each build; assert no
  `.map` files in release builds once source maps are gated.
- Renderer startup: the dev probe already logs `[stub] eval {…}` on page load; the same timestamp pair
  gives "page loaded → self-tests done".
