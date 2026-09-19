import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { SemifConfig } from "./config"
import { SemifEngine } from "./engine"
import { SemifScoring } from "./scoring"

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)))

export type SemifStatus = SemifEngine.SidecarStatus & {
  mode: SemifConfig.SemifMode
  serverPath: string | undefined
  modelExists: boolean
  serverExists: boolean
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly ensure: () => Effect.Effect<{ url: string; adopted: boolean }, Error>
  readonly status: () => Effect.Effect<SemifStatus>
  readonly decide: (
    request: SemifScoring.SemifDecisionRequest,
    signal?: AbortSignal,
  ) => Effect.Effect<SemifScoring.SemifDecision, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Semif") {}

type State = {
  resolved: SemifConfig.SemifResolved
  sidecar: SemifEngine.Sidecar
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Semif.state")(function* () {
        const cfg = yield* config.get()
        // Fill unset model/server paths from the standard global install dir so a
        // config that only sets `mode` works once the runtime is present on disk.
        const resolved = yield* Effect.promise(() =>
          SemifConfig.resolveInstalledPaths(SemifConfig.fromConfig(cfg.semif), Global.Path.data),
        )
        const sidecar = SemifEngine.createSidecar(resolved)
        yield* Effect.addFinalizer(() => Effect.promise(() => sidecar.dispose()))
        // "auto" warms the sidecar in the background without blocking materialization;
        // failures (e.g. unconfigured paths) surface later when a tool is invoked.
        if (cfg.semif && resolved.mode === "auto") void sidecar.ensure().catch(() => {})
        return { resolved, sidecar }
      }),
    )

    const ensure: Interface["ensure"] = Effect.fn("Semif.ensure")(function* () {
      const s = yield* InstanceState.get(state)
      if (s.resolved.mode === "off") return yield* Effect.fail(new Error("semif is disabled (mode=off)"))
      return yield* Effect.tryPromise({ try: () => s.sidecar.ensure(), catch: toError })
    })

    const status: Interface["status"] = Effect.fn("Semif.status")(function* () {
      const s = yield* InstanceState.get(state)
      const paths = yield* Effect.promise(() => SemifConfig.checkSemifPaths(s.resolved))
      return {
        ...s.sidecar.status(),
        mode: s.resolved.mode,
        serverPath: s.resolved.serverPath,
        modelExists: paths.modelExists,
        serverExists: paths.serverExists,
      }
    })

    const decide: Interface["decide"] = Effect.fn("Semif.decide")(function* (request, signal) {
      const s = yield* InstanceState.get(state)
      if (s.resolved.mode === "off") return yield* Effect.fail(new Error("semif is disabled (mode=off)"))
      const ensured = yield* Effect.tryPromise({ try: () => s.sidecar.ensure(), catch: toError })
      return yield* Effect.tryPromise({
        try: () => SemifScoring.decide({ url: ensured.url, signal }, s.resolved, request),
        catch: toError,
      })
    })

    const init: Interface["init"] = Effect.fn("Semif.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ init, ensure, status, decide })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Config.node],
})

export * as Semif from "./service"
