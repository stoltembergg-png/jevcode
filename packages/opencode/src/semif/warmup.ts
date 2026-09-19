// Boot and first-use warm-up policy for the process-global SemIf service.
//
// The native service only prepares the model when a caller asks (HTTP route or
// tool). To satisfy "install NextCode and SemIf is ready with no user step", the
// service kicks its own preparation after boot when the config opts in. The
// policy is deliberately narrow:
//
//   mode=auto + download=auto -> prepare in the background right after boot
//   mode=lazy                 -> prepare on the first decision
//   mode=off                  -> never prepare
//   download=manual | never   -> never download implicitly
//
// `run` never propagates failures: the service records its own `failed` status
// (and an `unsupported` platform is reported as-is), so a manual retry via
// `POST /semif/start` stays possible.

import { Effect, Exit } from "effect"
import type { Status } from "./service"

export type Policy = Pick<Status, "mode" | "download">

export const shouldWarmup = (policy: Policy): boolean => policy.mode === "auto" && policy.download === "auto"

// A first decision may kick preparation only when the mode allows it and the
// current state is not already in flight. A missing model is fetched only under
// `download: auto`; `manual` and `never` must not download implicitly.
export const shouldPrepare = (status: Pick<Status, "status" | "mode" | "download">): boolean => {
  if (status.mode === "off") return false
  switch (status.status) {
    case "ready":
    case "disabled":
    case "unsupported":
    case "downloading":
    case "verifying":
    case "starting":
      return false
    case "not_downloaded":
      return status.download === "auto"
    case "failed":
    case "offline":
      return true
  }
}

// Starts `start` in the background without ever failing the caller. Failures are
// logged; the service already records the matching `failed` status.
export const run = Effect.fn("SemifWarmup.run")(function* (policy: Policy, start: Effect.Effect<void, unknown>) {
  if (!shouldWarmup(policy)) return
  const exit = yield* Effect.exit(start)
  if (Exit.isFailure(exit)) yield* Effect.logWarning("semif warm-up failed", { cause: exit.cause })
})

export * as SemifWarmup from "./warmup"
