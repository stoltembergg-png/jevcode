import { tool } from "@opencode-ai/plugin"
import type { Hooks, Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { checkSemifPaths, parseSemifOptions } from "./config"
import { createSidecar } from "./engine"
import { decide } from "./scoring"

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const server: Plugin = async (_input, options) => {
  const cfg = parseSemifOptions(options)
  const sidecar = createSidecar(cfg)

  // "auto" warms the sidecar at startup without blocking plugin registration.
  if (cfg.mode === "auto") {
    void sidecar.ensure().catch((error: unknown) => {
      console.error(`[semif] sidecar preload failed: ${errorText(error)}`)
    })
  }

  const decideTool = tool({
    description:
      "SemIf semantic decision: apply a criterion to evidence and pick exactly one option by scoring " +
      "the model's next-token logprobs at declared answer slots. Returns calibrated-style probabilities " +
      "over the supplied options (uncalibrated decision scores).",
    args: {
      state: tool.schema.string().describe("Evidence or context the criterion is applied to (JSON string or text)."),
      question: tool.schema
        .string()
        .describe("The decision criterion/question. Do not include the option list; pass options separately."),
      options: tool.schema
        .array(
          tool.schema.object({
            id: tool.schema.string().describe("Stable id returned in the result."),
            description: tool.schema.string().describe("Human-readable option text."),
          }),
        )
        .min(2)
        .max(16)
        .describe("Between 2 and 16 mutually exclusive options."),
      id: tool.schema.string().optional().describe("Optional caller-provided decision id."),
    },
    async execute(args, ctx) {
      if (cfg.mode === "off") {
        return { title: "semif: disabled", output: "semif plugin is disabled (mode=off). No model is available." }
      }
      if (args.options.length < 2 || args.options.length > 16) {
        return { title: "semif: invalid options", output: "semif_decide requires between 2 and 16 options." }
      }
      const { url } = await sidecar.ensure()
      const record = await decide(
        { url, signal: ctx.abort },
        cfg,
        { id: args.id, state: args.state, question: args.question, options: args.options },
      )
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
    },
  })

  const statusTool = tool({
    description: "Report semif plugin mode, sidecar status, configured paths, port and process liveness.",
    args: {},
    async execute() {
      const status = sidecar.status()
      const paths = await checkSemifPaths(cfg)
      return {
        title: `semif: ${cfg.mode}`,
        output: JSON.stringify(
          {
            mode: cfg.mode,
            ...status,
            serverPath: cfg.serverPath,
            modelExists: paths.modelExists,
            serverExists: paths.serverExists,
          },
          null,
          2,
        ),
      }
    },
  })

  const hooks: Hooks = {
    tool: {
      semif_decide: decideTool as ToolDefinition,
      semif_status: statusTool as ToolDefinition,
    },
    dispose: async () => {
      await sidecar.dispose()
    },
  }

  return hooks
}

export default { id: "semif", server }

export * as SemifPlugin from "./index"
