import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { CHOICES } from "../../src/semif/manifest"
import { SemifService, type Status } from "../../src/semif/service"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { SemifPaths } from "../../src/server/routes/instance/httpapi/groups/semif"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { semifHandlers } from "../../src/server/routes/instance/httpapi/handlers/semif"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

// The SemIf service owns one model per machine, so these routes are mounted on
// the server-level root API. No instance or workspace context is involved.
const choices = CHOICES.map((entry) => ({ id: entry.id, label: entry.label, quant: entry.quant }))

const PENDING: Status = {
  status: "downloading",
  mode: "auto",
  download: "auto",
  host: "127.0.0.1",
  port: 8817,
  adopted: false,
  choices,
  progress: { received: 37, total: 100 },
}

const READY: Status = {
  status: "ready",
  mode: "auto",
  download: "auto",
  host: "127.0.0.1",
  port: 8817,
  adopted: false,
  choices,
  pid: 4242,
}

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers, semifHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(
    Layer.mock(SemifService.Service)({
      status: () => Effect.succeed(PENDING),
      start: () => Effect.succeed(READY),
      acquire: () => Effect.succeed({ ...PENDING, status: "not_downloaded" as const }),
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("semif HttpApi", () => {
  it.live("GET /semif/status returns the global discriminated status", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(SemifPaths.status).pipe(HttpClient.execute)

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({
        status: "downloading",
        mode: "auto",
        download: "auto",
        host: "127.0.0.1",
        port: 8817,
        adopted: false,
        progress: { received: 37, total: 100 },
        choices,
      })
    }),
  )

  it.live("POST /semif/start returns the resulting ready status", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(SemifPaths.start).pipe(HttpClient.execute)

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ status: "ready", pid: 4242 })
    }),
  )

  it.live("POST /semif/acquire returns the resulting not-downloaded status", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(SemifPaths.acquire).pipe(HttpClient.execute)

      expect(response.status).toBe(200)
      expect(yield* response.json).toMatchObject({ status: "not_downloaded" })
    }),
  )
})
