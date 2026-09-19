// Process-global SemIf service.
//
// There is one model per machine, so this is a plain Effect service (not
// `InstanceState`): its layer owns a single sidecar handle, one acquisition slot
// and one decision entry point. `Fase 3` consumes `SemifService.Service` for the
// native tool, HTTP API and events; the module-level helpers at the bottom are
// the convenience projection over `makeRuntime`.

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { filesystem, httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import { Context, Effect, Exit, FileSystem, Layer, Ref, Schema, Scope, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { HttpClient } from "effect/unstable/http"
import { Config } from "@/config/config"
import { SemifAcquire } from "./acquire"
import { parseSemifOptions, type SemifMode } from "./config"
import { SemifManifest } from "./manifest"
import { SemifPaths } from "./paths"
import { SemifRuntime } from "./runtime"
import { SemifScoring, type SemifDecision, type SemifDecisionRequest } from "./scoring"
import { SemifSidecar } from "./sidecar"
import { SemifWarmup } from "./warmup"

export type SemifStatus =
  | "unsupported"
  | "disabled"
  | "not_downloaded"
  | "downloading"
  | "verifying"
  | "starting"
  | "ready"
  | "failed"
  | "offline"

export type DownloadPolicy = "auto" | "manual" | "never"

export interface Models {
  readonly id: string
  readonly filename: string
  readonly sha256: string
  readonly bytes: number
  readonly quant: string
}

export interface Choice {
  readonly id: string
  readonly label: string
  readonly quant: string
}

export interface Progress {
  readonly received: number
  readonly total: number | undefined
}

export interface Status {
  readonly status: SemifStatus
  readonly mode: SemifMode
  readonly download: DownloadPolicy
  readonly model?: Models
  readonly choices: readonly Choice[]
  readonly modelPath?: string
  readonly serverPath?: string
  readonly host: string
  readonly port: number
  readonly pid?: number
  readonly adopted: boolean
  readonly progress?: Progress
  readonly error?: string
}

export class SemifServiceError extends Schema.TaggedErrorClass<SemifServiceError>()("SemifServiceError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export interface Interface {
  readonly status: () => Effect.Effect<Status>
  readonly start: () => Effect.Effect<Status, SemifServiceError>
  readonly acquire: () => Effect.Effect<Status, SemifServiceError>
  readonly decide: (request: SemifDecisionRequest) => Effect.Effect<SemifDecision, SemifServiceError>
  readonly dispose: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Semif") {}

const errorMessage = (cause: unknown): string => {
  if (cause instanceof SemifServiceError) return cause.reason
  if (cause instanceof SemifAcquire.AcquireError) return cause.reason
  if (cause instanceof SemifRuntime.RuntimeError) return cause.reason
  if (cause instanceof SemifSidecar.SidecarError) return cause.reason
  return cause instanceof Error ? cause.message : String(cause)
}

interface State {
  readonly status: SemifStatus
  readonly error?: string
  readonly handle?: SemifSidecar.Handle
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FileSystem.FileSystem
    const http = yield* HttpClient.HttpClient
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Effect.scope
    const state = yield* Ref.make<State>({ status: "offline" })
    const live: { progress?: Progress } = {}
    // Serializes concurrent starts (boot warm-up vs. explicit `start`) so two
    // callers can never race port probing and spawn two sidecars.
    const startLock = yield* Semaphore.make(1)

    const provideAcquire = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | HttpClient.HttpClient>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(HttpClient.HttpClient, http),
      )

    const provideSidecar = <A, E>(
      effect: Effect.Effect<A, E, HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
    ) =>
      effect.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Scope.Scope, scope),
      )

    const load = Effect.gen(function* () {
      const info = yield* config.getGlobal()
      const block = info.semif
      const entry = SemifManifest.find(block?.model)
      const resolved = parseSemifOptions({
        mode: block?.mode,
        modelPath: block?.model_path,
        serverPath: block?.server_path,
        port: block?.port,
        threads: block?.threads,
        contextSize: block?.contextSize,
        nProbs: block?.nProbs,
        cacheSize: block?.cacheSize,
        host: block?.host,
      })
      return {
        entry,
        download: (block?.download ?? "auto") as DownloadPolicy,
        resolved,
        modelPath: entry
          ? SemifPaths.resolveModelPath({
              configPath: resolved.modelPath,
              sha256: entry.sha256,
              filename: entry.filename,
            })
          : undefined,
        serverPath: SemifPaths.resolveServerPath({ configPath: resolved.serverPath }),
        libsPath: SemifPaths.resolveLibsPath(),
      }
    })

    const dropHandleIfStale = Effect.gen(function* () {
      const loaded = yield* load
      const current = yield* Ref.get(state)
      if (!current.handle) return
      const stale =
        loaded.resolved.mode === "off" ||
        (loaded.modelPath !== undefined && current.handle.modelPath !== loaded.modelPath)
      if (!stale) return
      yield* SemifSidecar.dispose(current.handle)
      SemifScoring.clearCaches()
      yield* Ref.set(state, { status: "offline" as SemifStatus })
    })

    const snapshot = Effect.gen(function* () {
      yield* dropHandleIfStale
      const loaded = yield* load
      const current = yield* Ref.get(state)
      const base = {
        mode: loaded.resolved.mode,
        download: loaded.download,
        host: loaded.resolved.host,
        port: current.handle?.port ?? loaded.resolved.port,
        pid: current.handle?.pid,
        adopted: current.handle?.adopted ?? false,
        model: loaded.entry
          ? {
              id: loaded.entry.id,
              filename: loaded.entry.filename,
              sha256: loaded.entry.sha256,
              bytes: loaded.entry.bytes,
              quant: loaded.entry.quant,
            }
          : undefined,
        choices: SemifManifest.CHOICES.map((entry) => ({
          id: entry.id,
          label: entry.label,
          quant: entry.quant,
        })),
        modelPath: loaded.modelPath,
        serverPath: loaded.serverPath,
        progress: live.progress,
        error: current.error,
      } satisfies Omit<Status, "status">

      if (current.handle) return { ...base, status: "ready" as SemifStatus }
      if (current.status === "downloading" || current.status === "verifying" || current.status === "starting") {
        return { ...base, status: current.status }
      }
      if (loaded.resolved.mode === "off") return { ...base, status: "disabled" as SemifStatus }
      if (!loaded.entry) return { ...base, status: "unsupported" as SemifStatus }
      if (!loaded.serverPath) return { ...base, status: "offline" as SemifStatus }
      if (current.status === "failed") return { ...base, status: "failed" as SemifStatus }
      const modelExists = loaded.modelPath
        ? yield* fs.exists(loaded.modelPath).pipe(Effect.orElseSucceed(() => false))
        : false
      if (!modelExists) return { ...base, status: "not_downloaded" as SemifStatus }
      return { ...base, status: "offline" as SemifStatus }
    })

    const ensureModel = Effect.gen(function* () {
      const loaded = yield* load
      const entry = loaded.entry
      if (!entry || !loaded.modelPath) {
        return yield* new SemifServiceError({ reason: "semif: no supported model is configured" })
      }
      yield* Ref.update(state, (value) => ({ ...value, status: "downloading" as SemifStatus, error: undefined }))
      const result = yield* provideAcquire(
        SemifAcquire.ensure({
          policy: loaded.download,
          dest: loaded.modelPath,
          part: SemifPaths.partPath(entry.sha256),
          sha256: entry.sha256,
          expectedBytes: entry.bytes,
          resolveUrl: () => Effect.succeed(SemifManifest.resolveUrl(entry)),
          onProgress: (progress) => {
            live.progress = progress
          },
        }),
      ).pipe(Effect.mapError((cause) => new SemifServiceError({ reason: errorMessage(cause) })))
      live.progress = undefined
      yield* Ref.update(state, (value) => ({ ...value, status: "offline" as SemifStatus }))
      return result
    })

    const acquireHandle = Effect.gen(function* () {
      yield* dropHandleIfStale
      const loaded = yield* load
      const current = yield* Ref.get(state)
      if (current.handle) return current.handle
      if (loaded.resolved.mode === "off") {
        return yield* new SemifServiceError({ reason: "semif: disabled (mode=off)" })
      }
      if (!loaded.serverPath) {
        return yield* new SemifServiceError({ reason: "semif: llama-server binary is not available" })
      }
      yield* ensureModel
      if (!loaded.modelPath) {
        return yield* new SemifServiceError({ reason: "semif: no model path resolved" })
      }
      yield* Ref.update(state, (value) => ({ ...value, status: "starting" as SemifStatus }))
      // Colocate the launcher and its libraries before spawning: the ggml loader
      // only finds its backends next to the executable. Without a libs directory
      // (unbundled/dev) this is a passthrough to the resolved binary.
      const runtime = yield* SemifRuntime.materialize({
        serverPath: loaded.serverPath,
        libsPath: loaded.libsPath,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError((cause) => new SemifServiceError({ reason: errorMessage(cause) })),
      )
      const handle = yield* provideSidecar(
        SemifSidecar.ensure({
          host: loaded.resolved.host,
          port: loaded.resolved.port,
          threads: loaded.resolved.threads,
          contextSize: loaded.resolved.contextSize,
          loadTimeoutMs: loaded.resolved.loadTimeoutMs,
          serverPath: runtime.serverPath,
          modelPath: loaded.modelPath,
        }),
      ).pipe(Effect.mapError((cause) => new SemifServiceError({ reason: errorMessage(cause) })))
      yield* Effect.tryPromise({
        try: () => SemifScoring.prepare({ url: handle.url }, loaded.entry?.family ?? "lfm2"),
        catch: (cause) => new SemifServiceError({ reason: errorMessage(cause) }),
      })
      yield* Ref.set(state, { status: "ready" as SemifStatus, handle })
      return handle
    })

    const ensureHandle = startLock.withPermits(1)(acquireHandle)

    const markFailed = (cause: unknown) =>
      Ref.update(state, (value) => ({ ...value, status: "failed" as SemifStatus, error: errorMessage(cause) }))

    const result: Interface = {
      status: () => snapshot,
      start: () =>
        Effect.gen(function* () {
          const loaded = yield* load
          // Without a supported model or a server binary there is nothing to
          // start; report the computed status instead of turning it into
          // `failed`.
          if (!loaded.entry || !loaded.serverPath) return yield* snapshot
          yield* ensureHandle
          return yield* snapshot
        }).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* markFailed(cause)
              return yield* new SemifServiceError({ reason: errorMessage(cause) })
            }),
          ),
        ),
      acquire: () =>
        Effect.gen(function* () {
          yield* ensureModel
          return yield* snapshot
        }).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* markFailed(cause)
              return yield* new SemifServiceError({ reason: errorMessage(cause) })
            }),
          ),
        ),
      decide: (request) =>
        Effect.gen(function* () {
          const loaded = yield* load
          const handle = yield* ensureHandle
          const entry = loaded.entry
          if (!entry) {
            return yield* new SemifServiceError({ reason: "semif: no supported model is configured" })
          }
          return yield* Effect.tryPromise({
            try: () =>
              SemifScoring.decide({ url: handle.url }, loaded.resolved, request, SemifManifest.profile(entry)),
            catch: (cause) => new SemifServiceError({ reason: errorMessage(cause) }),
          })
        }).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* markFailed(cause)
              return yield* new SemifServiceError({ reason: errorMessage(cause) })
            }),
          ),
        ),
      dispose: () =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state)
          if (current.handle) yield* SemifSidecar.dispose(current.handle)
          SemifScoring.clearCaches()
          yield* Ref.set(state, { status: "offline" as SemifStatus })
        }),
    }

    // Warm up when the config opts in. This layer is memoized by the app-node
    // graph, so normally the fork below happens once; even if a listener is
    // rebuilt, `start` is serialized by `startLock` in-process and acquisition
    // takes the cross-process `Flock`, while the sidecar adopts an already
    // healthy server. Readiness never blocks the boot: the fiber is detached
    // into the layer scope and every failure is logged.
    const bootWarmup = Effect.gen(function* () {
      const loaded = yield* load
      yield* SemifWarmup.run(
        { mode: loaded.resolved.mode, download: loaded.download },
        result.start().pipe(Effect.asVoid),
      )
    })
    yield* bootWarmup.pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Exit.isFailure(exit) ? Effect.logWarning("semif warm-up setup failed", { cause: exit.cause }) : Effect.void,
      ),
      Effect.forkIn(scope),
    )

    return Service.of(result)
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node, filesystem, httpClient, CrossSpawnSpawner.node],
})

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const status = () => runPromise((service) => service.status())
export const start = () => runPromise((service) => service.start())
export const acquire = () => runPromise((service) => service.acquire())
export const decide = (request: SemifDecisionRequest) => runPromise((service) => service.decide(request))
export const dispose = () => runPromise((service) => service.dispose())

export * as SemifService from "./service"
