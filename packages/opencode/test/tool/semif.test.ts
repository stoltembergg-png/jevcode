import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Ref } from "effect"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { SemifService, type Status } from "@/semif/service"
import type { SemifDecision } from "../../src/semif/scoring"
import { CHOICES } from "../../src/semif/manifest"
import { Truncate } from "@/tool/truncate"
import { SemifDecideTool, SemifStatusTool } from "@/tool/semif"
import { Tool } from "@/tool/tool"
import { pollWithTimeout, testEffect } from "../lib/effect"

const choices = CHOICES.map((entry) => ({ id: entry.id, label: entry.label, quant: entry.quant }))

const READY: Status = {
  status: "ready",
  mode: "auto",
  download: "auto",
  host: "127.0.0.1",
  port: 8817,
  adopted: false,
  choices,
  pid: 1234,
  model: {
    id: "LiquidAI/LFM2-1.2B-GGUF",
    filename: "LFM2-1.2B-Q4_K_M.gguf",
    sha256: "55175400e3f509a9616227afeffd58d87e80b9f628a5d3d54ada884d85221fed",
    bytes: 730_893_248,
    quant: "Q4_K_M",
  },
}

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

const RECORD: SemifDecision = {
  id: "route-1",
  option_ids: ["access", "billing"],
  probabilities: [0.786, 0.214],
  option_logits: [-0.47, -2.97],
  answer_token_ids: [542, 543],
  chosen: "access",
  input_tokens: 116,
  prompt_sha256: "abc",
  prompt_version: "direct-options-v1",
  model: { source: "LiquidAI/LFM2-1.2B", revision: "Q4_K_M", server: "llama.cpp b11040" },
  probability_status: "conditional option score; uncalibrated as decision confidence",
  readout: "llama.cpp server top-k next-token logprobs at declared answer slots",
  forward_seconds: 0.2,
  total_seconds: 0.3,
  missing_slots: [],
  cached: false,
}

const makeLayer = (status: Status, decide: SemifService.Interface["decide"]) =>
  LayerNode.compile(LayerNode.group([Truncate.node, Agent.node, SemifService.node]), [
    [
      SemifService.node,
      Layer.mock(SemifService.Service)({
        status: () => Effect.succeed(status),
        decide,
      }),
    ],
  ])

const LAZY: Status = {
  status: "not_downloaded",
  mode: "lazy",
  download: "auto",
  host: "127.0.0.1",
  port: 8817,
  adopted: false,
  choices,
}

const lazyStarts = Effect.runSync(Ref.make(0))
const lazyIt = testEffect(
  LayerNode.compile(LayerNode.group([Truncate.node, Agent.node, SemifService.node]), [
    [
      SemifService.node,
      Layer.mock(SemifService.Service)({
        status: () => Effect.succeed(LAZY),
        start: () =>
          Ref.update(lazyStarts, (count) => count + 1).pipe(Effect.as(LAZY)),
      }),
    ],
  ]),
)

const readyIt = testEffect(makeLayer(READY, () => Effect.succeed(RECORD)))
const pendingIt = testEffect(
  makeLayer(PENDING, () => Effect.die(new Error("semif_decide must not run while not ready"))),
)
const hangingIt = testEffect(makeLayer(READY, () => Effect.never))

function makeCtx(signal: AbortSignal = new AbortController().signal): Tool.Context {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

const options = [
  { id: "access", description: "A" },
  { id: "billing", description: "B" },
]

describe("semif tools", () => {
  readyIt.instance("semif_status returns the global service status as JSON", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* SemifStatusTool)
      const result = yield* tool.execute({}, makeCtx())

      expect(result.title).toBe("semif: ready")
      expect(JSON.parse(result.output)).toMatchObject({
        status: "ready",
        mode: "auto",
        host: "127.0.0.1",
        port: 8817,
        adopted: false,
        pid: 1234,
      })
    }),
  )

  readyIt.instance("semif_decide returns the auditable record and p-title", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* SemifDecideTool)
      const result = yield* tool.execute({ state: "some evidence", question: "Which team?", options }, makeCtx())

      expect(result.title).toBe("semif: access (p=0.786)")
      expect(JSON.parse(result.output)).toMatchObject({ chosen: "access", cached: false, missing_slots: [] })
      expect(result.metadata).toMatchObject({ chosen: "access", cached: false })
    }),
  )

  readyIt.instance("semif_decide rejects option counts outside 2..16", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* SemifDecideTool)
      const result = yield* tool.execute(
        { state: "s", question: "q", options: [{ id: "only", description: "one" }] },
        makeCtx(),
      )

      expect(result.title).toBe("semif: invalid options")
      expect(result.output).toContain("between 2 and 16")
    }),
  )

  pendingIt.instance("semif_decide reports progress instead of blocking while not ready", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* SemifDecideTool)
      const result = yield* tool.execute({ state: "s", question: "q", options }, makeCtx())

      expect(result.title).toBe("semif: downloading")
      expect(result.output).toContain("not ready")
      expect(result.output).toContain("37%")
      expect(result.metadata).toMatchObject({ status: "downloading" })
    }),
  )

  lazyIt.instance("semif_decide kicks lazy preparation in the background without blocking", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* SemifDecideTool)
      const result = yield* tool.execute({ state: "s", question: "q", options }, makeCtx())

      expect(result.title).toBe("semif: not_downloaded")
      expect(result.output).toContain("Preparing the model in the background")
      yield* pollWithTimeout(
        Ref.get(lazyStarts).pipe(Effect.map((count) => (count > 0 ? count : undefined))),
        "semif start was never kicked",
      )
    }),
  )

  hangingIt.instance("semif_decide respects an already-aborted ctx.abort", () =>
    Effect.gen(function* () {
      const tool = yield* Tool.init(yield* SemifDecideTool)
      const controller = new AbortController()
      controller.abort()
      const result = yield* tool.execute({ state: "s", question: "q", options }, makeCtx(controller.signal))

      expect(result.title).toBe("semif: aborted")
      expect(result.output).toContain("cancelled")
    }),
  )
})
