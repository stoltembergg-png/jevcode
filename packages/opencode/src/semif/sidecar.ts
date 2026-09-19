// llama-server sidecar lifecycle.
//
// `ensure` adopts an already-healthy server that serves the configured model,
// otherwise it spawns one. Port fallback walks `port+1 .. port+10` when the base
// port is busy with a different model, adopting a matching server if it finds one
// and otherwise using the first free port. `dispose` kills only the process this
// code spawned; an adopted server is never touched.

import path from "node:path"
import { Effect, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { HttpClient } from "effect/unstable/http"

const PORT_FALLBACK_ATTEMPTS = 10
const HEALTH_TIMEOUT = "1500 millis"

export class SidecarError extends Schema.TaggedErrorClass<SidecarError>()("SemifSidecarError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export interface SidecarConfig {
  readonly host: string
  readonly port: number
  readonly threads: number
  readonly contextSize: number
  readonly loadTimeoutMs: number
  readonly serverPath: string
  readonly modelPath: string
}

export interface Handle {
  readonly host: string
  readonly port: number
  readonly url: string
  readonly modelPath: string
  readonly adopted: boolean
  readonly pid: number | undefined
  readonly child: ChildProcessHandle | undefined
}

const baseUrl = (host: string, port: number): string => `http://${host}:${port}`

const normalizePath = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

const isHealthy = (url: string): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const response = yield* http
      .get(`${url}/health`)
      .pipe(Effect.timeout(HEALTH_TIMEOUT), Effect.orElseSucceed(() => undefined))
    return response !== undefined && response.status === 200
  })

const readProps = (url: string): Effect.Effect<unknown, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const response = yield* http
      .get(`${url}/props`)
      .pipe(Effect.timeout(HEALTH_TIMEOUT), Effect.orElseSucceed(() => undefined))
    if (response === undefined || response.status !== 200) return undefined
    return yield* response.json.pipe(Effect.orElseSucceed(() => undefined))
  })

const readModelPath = (props: unknown): string | undefined => {
  if (typeof props !== "object" || props === null) return undefined
  const record = props as Record<string, unknown>
  for (const key of ["model_path", "modelPath"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim() !== "") return value
  }
  const defaults = record.default_generation_settings
  if (typeof defaults === "object" && defaults !== null) {
    const nested = (defaults as Record<string, unknown>).model
    if (typeof nested === "string" && nested.trim() !== "") return nested
  }
  return undefined
}

type Probe = "match" | "other" | "none"

const probe = (config: SidecarConfig, port: number): Effect.Effect<Probe, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = baseUrl(config.host, port)
    if (!(yield* isHealthy(url))) return "none" as Probe
    const served = readModelPath(yield* readProps(url))
    if (served && normalizePath(served) === normalizePath(config.modelPath)) return "match" as Probe
    return "other" as Probe
  })

type Location =
  | { readonly kind: "adopt"; readonly port: number }
  | { readonly kind: "free"; readonly port: number }

const locate = (config: SidecarConfig): Effect.Effect<Location, SidecarError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const base = yield* probe(config, config.port)
    if (base === "match") return { kind: "adopt", port: config.port } as const
    if (base === "none") return { kind: "free", port: config.port } as const

    for (let delta = 1; delta <= PORT_FALLBACK_ATTEMPTS; delta++) {
      const port = config.port + delta
      if (port > 65535) break
      const result = yield* probe(config, port)
      if (result === "match") return { kind: "adopt", port } as const
      if (result === "none") return { kind: "free", port } as const
    }
    return yield* new SidecarError({
      reason: `semif: no free llama-server port in ${config.port + 1}..${config.port + PORT_FALLBACK_ATTEMPTS}`,
    })
  })

const command = (config: SidecarConfig, port: number) =>
  ChildProcess.make(
    config.serverPath,
    [
      "-m",
      config.modelPath,
      "--host",
      config.host,
      "--port",
      String(port),
      "--threads",
      String(config.threads),
      "-c",
      String(config.contextSize),
      "--no-webui",
      // Two slots lets a status poll overlap a decision without doubling the KV arena.
      "--parallel",
      "2",
    ],
    {
      cwd: path.dirname(config.serverPath),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      extendEnv: true,
    },
  )

const waitForHealthy = (
  config: SidecarConfig,
  port: number,
  child: ChildProcessHandle,
): Effect.Effect<void, SidecarError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = baseUrl(config.host, port)
    const deadline = Date.now() + config.loadTimeoutMs
    while (true) {
      const running = yield* child.isRunning.pipe(Effect.orElseSucceed(() => false))
      if (!running) {
        return yield* new SidecarError({ reason: "semif: llama-server exited before becoming ready" })
      }
      if (yield* isHealthy(url)) return
      if (Date.now() > deadline) {
        return yield* new SidecarError({
          reason: `semif: llama-server did not become ready within ${config.loadTimeoutMs}ms at ${url}`,
        })
      }
      yield* Effect.sleep("250 millis")
    }
  })

export const ensure = Effect.fn("SemifSidecar.ensure")(function* (config: SidecarConfig) {
  const located = yield* locate(config)
  if (located.kind === "adopt") {
    return {
      host: config.host,
      port: located.port,
      url: baseUrl(config.host, located.port),
      modelPath: config.modelPath,
      adopted: true,
      pid: undefined,
      child: undefined,
    } satisfies Handle
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner
    .spawn(command(config, located.port))
    .pipe(Effect.mapError((cause) => new SidecarError({ reason: `semif: could not start llama-server: ${String(cause)}` })))
  yield* waitForHealthy(config, located.port, child)
  return {
    host: config.host,
    port: located.port,
    url: baseUrl(config.host, located.port),
    modelPath: config.modelPath,
    adopted: false,
    pid: Number(child.pid),
    child,
  } satisfies Handle
})

// Kills only a server this code spawned. An adopted server belongs to another
// process (or an earlier run) and must survive.
export const dispose = (handle: Handle): Effect.Effect<void> =>
  handle.adopted || handle.child === undefined
    ? Effect.void
    : handle.child.kill().pipe(Effect.orElseSucceed(() => undefined), Effect.asVoid)

export * as SemifSidecar from "./sidecar"
