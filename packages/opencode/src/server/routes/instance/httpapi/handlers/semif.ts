import { SemifService } from "@/semif/service"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"

// Start/acquire are idempotent but can fail (unsupported model, missing binary,
// download error). On failure the service records `failed` plus the error text,
// so returning the resulting status is more useful than a 500 and keeps the
// endpoint contract a single discriminated status union.
export const semifHandlers = HttpApiBuilder.group(RootHttpApi, "semif", (handlers) =>
  Effect.gen(function* () {
    const service = yield* SemifService.Service

    const status = Effect.fn("SemifHttpApi.status")(function* () {
      return yield* service.status()
    })

    const start = Effect.fn("SemifHttpApi.start")(function* () {
      return yield* service.start().pipe(Effect.catch(() => service.status()))
    })

    const acquire = Effect.fn("SemifHttpApi.acquire")(function* () {
      return yield* service.acquire().pipe(Effect.catch(() => service.status()))
    })

    return handlers.handle("status", status).handle("start", start).handle("acquire", acquire)
  }),
)
