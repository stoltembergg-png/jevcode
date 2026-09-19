import { ConfigSemifV1 } from "@opencode-ai/core/v1/config/semif"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

// The SemIf model is a machine-global singleton, so these routes are mounted on
// the server-level `RootHttpApi` and never carry instance/workspace context.
const ModelInfo = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Number,
  quant: Schema.String,
})

const ModelChoice = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  quant: Schema.String,
})

const Progress = Schema.Struct({
  received: Schema.Number,
  total: Schema.optional(Schema.Number),
})

// Mirrors `SemifService.Status` in `src/semif/service.ts`. The handler returns
// the service status directly, so a drift between this wire schema and that
// interface is a compile error at the handler boundary.
export const SemifStatusSchema = Schema.Struct({
  status: Schema.Literals([
    "unsupported",
    "disabled",
    "not_downloaded",
    "downloading",
    "verifying",
    "starting",
    "ready",
    "failed",
    "offline",
  ]),
  mode: ConfigSemifV1.Mode,
  download: ConfigSemifV1.Download,
  model: Schema.optional(ModelInfo),
  choices: Schema.Array(ModelChoice),
  modelPath: Schema.optional(Schema.String),
  serverPath: Schema.optional(Schema.String),
  host: Schema.String,
  port: Schema.Number,
  pid: Schema.optional(Schema.Number),
  adopted: Schema.Boolean,
  progress: Schema.optional(Progress),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "SemifStatus" })

export const SemifPaths = {
  status: "/semif/status",
  start: "/semif/start",
  acquire: "/semif/acquire",
} as const

export const SemifApi = HttpApi.make("semif").add(
  HttpApiGroup.make("semif")
    .add(
      HttpApiEndpoint.get("status", SemifPaths.status, {
        success: described(SemifStatusSchema, "Global SemIf status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "semif.status",
          summary: "Get SemIf status",
          description:
            "Get the global SemIf service status. The local model is one per machine, so this route is server-global.",
        }),
      ),
      HttpApiEndpoint.post("start", SemifPaths.start, {
        success: described(SemifStatusSchema, "Global SemIf status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "semif.start",
          summary: "Start SemIf",
          description: "Ensure the local SemIf model and server are running. Idempotent; returns the resulting status.",
        }),
      ),
      HttpApiEndpoint.post("acquire", SemifPaths.acquire, {
        success: described(SemifStatusSchema, "Global SemIf status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "semif.acquire",
          summary: "Acquire SemIf model",
          description:
            "Ensure the local SemIf model file is downloaded and verified. Idempotent; returns the resulting status.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "semif", description: "Global SemIf model routes." })),
)
