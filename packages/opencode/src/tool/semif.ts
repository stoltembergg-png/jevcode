import { Effect, Schema } from "effect"
import { SemifService } from "@/semif/service"
import { SemifWarmup } from "@/semif/warmup"
import * as Tool from "./tool"

export const SemifOption = Schema.Struct({
  id: Schema.String.annotate({ description: "Stable id returned in the result." }),
  description: Schema.String.annotate({ description: "Human-readable option text." }),
})

export const SemifDecideParameters = Schema.Struct({
  state: Schema.String.annotate({
    description: "Evidence or context the criterion is applied to (JSON string or text).",
  }),
  question: Schema.String.annotate({
    description: "The decision criterion/question. Do not include the option list; pass options separately.",
  }),
  options: Schema.Array(SemifOption).annotate({
    description: "Between 2 and 16 mutually exclusive options.",
  }),
  id: Schema.optional(Schema.String).annotate({ description: "Optional caller-provided decision id." }),
})

const MIN_OPTIONS = 2
const MAX_OPTIONS = 16

type DecideMetadata = {
  readonly status?: SemifService.SemifStatus
  readonly probabilities?: ReadonlyArray<number>
  readonly chosen?: string
  readonly input_tokens?: number
  readonly missing_slots?: ReadonlyArray<string>
  readonly cached?: boolean
}

// The one model lives on the machine, so readiness is global. Report progress
// instead of blocking a tool call on a download or a cold model load.
function readiness(status: SemifService.Status): string {
  const progress = status.progress
  const percent =
    progress?.total !== undefined && progress.total > 0
      ? ` (${Math.min(100, Math.floor((progress.received / progress.total) * 100))}%)`
      : ""
  switch (status.status) {
    case "downloading":
      return `the model is downloading${percent}`
    case "verifying":
      return "the model is being verified"
    case "starting":
      return "the local model server is starting"
    case "not_downloaded":
      return "the model has not been downloaded yet"
    case "offline":
      return "the local model server is not running"
    case "disabled":
      return "semif is disabled (mode=off)"
    case "unsupported":
      return "no supported model is configured"
    case "failed":
      return `the local model failed: ${status.error ?? "unknown error"}`
    case "ready":
      return "the local model is ready"
  }
}

function notReadyOutput(status: SemifService.Status, preparing: boolean): string {
  return [
    `semif is not ready (status=${status.status}): ${readiness(status)}.`,
    `Progress: ${JSON.stringify(status.progress ?? null)}`,
    preparing
      ? "Preparing the model in the background; poll semif_status for progress."
      : "Poll semif_status for readiness, or POST /semif/start to load the model explicitly.",
  ].join("\n")
}

export const SemifStatusTool = Tool.define(
  "semif_status",
  Effect.gen(function* () {
    const service = yield* SemifService.Service

    return {
      description:
        "Report the global SemIf service status: lifecycle state, configured mode, model paths, " +
        "sidecar host/port/pid, adoption, download progress and the last error. There is one SemIf " +
        "model per machine, so this status is server-global and identical in every project.",
      parameters: Schema.Struct({}),
      execute: (): Effect.Effect<Tool.ExecuteResult<{ readonly status?: SemifService.SemifStatus }>> =>
        Effect.gen(function* () {
          const status = yield* service.status()
          return {
            title: `semif: ${status.status}`,
            output: JSON.stringify(status, null, 2),
            metadata: { status: status.status },
          }
        }),
    }
  }),
)

export const SemifDecideTool = Tool.define<typeof SemifDecideParameters, DecideMetadata, SemifService.Service>(
  "semif_decide",
  Effect.gen(function* () {
    const service = yield* SemifService.Service

    return {
      description:
        "SemIf semantic decision: apply a criterion to evidence and pick exactly one option by scoring " +
        "the local model's next-token logprobs at declared answer slots. Returns option probabilities " +
        "(uncalibrated decision scores). Requires the local model to be ready; otherwise it reports the " +
        "current status and progress without blocking.",
      parameters: SemifDecideParameters,
      execute: (params, ctx): Effect.Effect<Tool.ExecuteResult<DecideMetadata>> =>
        Effect.gen(function* () {
          if (params.options.length < MIN_OPTIONS || params.options.length > MAX_OPTIONS) {
            return {
              title: "semif: invalid options",
              output: `semif_decide requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options.`,
              metadata: {},
            }
          }

          const status = yield* service.status()
          if (status.status !== "ready") {
            const preparing = SemifWarmup.shouldPrepare(status)
            // `lazy` prepares on first use. Never block the decision on a
            // download or a cold model load: kick preparation in the background
            // and report the current state/progress immediately.
            if (preparing) yield* service.start().pipe(Effect.ignore, Effect.forkDetach)
            return {
              title: `semif: ${status.status}`,
              output: notReadyOutput(status, preparing),
              metadata: { status: status.status },
            }
          }

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const outcome = yield* Effect.raceFirst(
            service
              .decide({
                id: params.id,
                state: params.state,
                question: params.question,
                options: params.options.map((option) => ({ id: option.id, description: option.description })),
              })
              .pipe(
                Effect.map((record) => ({ kind: "decided" as const, record })),
                Effect.catch((error) => Effect.succeed({ kind: "failed" as const, message: error.message })),
              ),
            abort.pipe(Effect.map(() => ({ kind: "aborted" as const }))),
          )

          if (outcome.kind === "aborted") {
            return {
              title: "semif: aborted",
              output: "semif_decide was cancelled.",
              metadata: {},
            }
          }

          if (outcome.kind === "failed") {
            return {
              title: "semif: failed",
              output: `semif_decide failed: ${outcome.message}`,
              metadata: { status: "failed" as const },
            }
          }

          const record = outcome.record
          const index = record.option_ids.indexOf(record.chosen)
          const probability = index >= 0 ? record.probabilities[index]! : 0
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
    }
  }),
)
