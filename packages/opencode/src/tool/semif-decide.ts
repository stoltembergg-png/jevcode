import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Semif } from "@/semif/service"

export const Parameters = Schema.Struct({
  state: Schema.String.annotate({
    description: "Evidence or context the criterion is applied to (JSON string or text).",
  }),
  question: Schema.String.annotate({
    description: "The decision criterion/question. Do not include the option list; pass options separately.",
  }),
  options: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        id: Schema.String.annotate({ description: "Stable id returned in the result." }),
        description: Schema.String.annotate({ description: "Human-readable option text." }),
      }),
    ),
  ).annotate({ description: "Between 2 and 16 mutually exclusive options." }),
  id: Schema.optional(Schema.String).annotate({ description: "Optional caller-provided decision id." }),
})

type Metadata = {
  [key: string]: any
}

const DESCRIPTION =
  "SemIf semantic decision: apply a criterion to evidence and pick exactly one option by scoring the local " +
  "model's next-token logprobs at declared answer slots. Returns probabilities over the supplied options " +
  "(conditional, uncalibrated as decision confidence)."

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const SemifDecideTool = Tool.define<typeof Parameters, Metadata, Semif.Service>(
  "semif_decide",
  Effect.gen(function* () {
    const semif = yield* Semif.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        semif
          .decide({ id: params.id, state: params.state, question: params.question, options: params.options }, ctx.abort)
          .pipe(
            Effect.map((record) => {
              const index = record.option_ids.indexOf(record.chosen)
              const probability = index >= 0 ? record.probabilities[index] : 0
              return {
                title: `semif: ${record.chosen} (p=${probability.toFixed(3)})`,
                output: JSON.stringify(record, null, 2),
                metadata: {
                  probabilities: record.probabilities,
                  chosen: record.chosen,
                  input_tokens: record.input_tokens,
                  missing_slots: record.missing_slots,
                  cached: record.cached ?? false,
                },
              }
            }),
            Effect.catch((error) =>
              Effect.succeed({
                title: "semif: error",
                output: `semif_decide failed: ${message(error)}`,
                metadata: { error: message(error) },
              }),
            ),
          ),
    }
  }),
)
