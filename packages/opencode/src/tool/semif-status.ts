import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Semif } from "@/semif/service"

export const Parameters = Schema.Struct({})

type Metadata = {
  [key: string]: any
}

const DESCRIPTION = "Report semif mode, sidecar status (running/adopted/spawned), URL, port and configured path liveness."

export const SemifStatusTool = Tool.define<typeof Parameters, Metadata, Semif.Service>(
  "semif_status",
  Effect.gen(function* () {
    const semif = yield* Semif.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        semif.status().pipe(
          Effect.map((status) => ({
            title: `semif: ${status.mode}`,
            output: JSON.stringify(status, null, 2),
            metadata: { mode: status.mode, running: status.running },
          })),
        ),
    }
  }),
)
