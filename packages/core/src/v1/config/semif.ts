export * as ConfigSemifV1 from "./semif"

import { Effect, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../../schema"

export const Mode = Schema.Literals(["auto", "lazy", "off"]).annotate({
  identifier: "SemifMode",
  description: "When the local SemIf model is loaded",
})
export type Mode = Schema.Schema.Type<typeof Mode>

export const Download = Schema.Literals(["auto", "manual", "never"]).annotate({
  identifier: "SemifDownload",
  description: "How the SemIf model and server are obtained",
})
export type Download = Schema.Schema.Type<typeof Download>

export const Info = Schema.Struct({
  mode: Mode.pipe(Schema.withDecodingDefault(Effect.succeed("auto" as const))).annotate({
    description:
      "When to load the local SemIf model: 'auto' loads it in the background, 'lazy' loads it on first use, 'off' disables it (default: auto)",
  }),
  download: Download.pipe(Schema.withDecodingDefault(Effect.succeed("auto" as const))).annotate({
    description:
      "How to obtain the model and server: 'auto' downloads in the background on first run, 'manual' only on explicit user action, 'never' never downloads (default: auto)",
  }),
  threads: Schema.optional(PositiveInt).annotate({
    description: "Threads for the local model server. Defaults to the machine's available parallelism.",
  }),
  contextSize: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(2048))).annotate({
    description: "Context window size for the local model (default: 2048)",
  }),
  nProbs: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(256))).annotate({
    description: "Number of option probabilities requested from the local model (default: 256)",
  }),
  cacheSize: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(128))).annotate({
    description: "Number of cached semantic decisions to retain (default: 128)",
  }),
  host: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("127.0.0.1"))).annotate({
    description: "Host the local model server binds to (default: 127.0.0.1)",
  }),
  port: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(8817))).annotate({
    description: "Port the local model server listens on (default: 8817)",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model id or name with quantization to download and run, e.g. LiquidAI/LFM2-1.2B-GGUF",
  }),
  model_path: Schema.optional(Schema.String).annotate({
    description:
      "Explicit path to a local model file. Overrides automatic resolution for development and air-gapped installations.",
  }),
  server_path: Schema.optional(Schema.String).annotate({
    description:
      "Explicit path to the local model server binary. Overrides automatic resolution for development and air-gapped installations.",
  }),
}).annotate({ identifier: "SemifConfig" })
export type Info = Schema.Schema.Type<typeof Info>
