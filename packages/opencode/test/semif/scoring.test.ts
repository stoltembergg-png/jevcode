import { beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  LETTERS,
  PROMPT_VERSION,
  SLOT_LOGIT_BIAS,
  assertBoundary,
  clearCaches,
  decide,
  prepare,
  renderPrompt,
  resolveSlotIds,
  softmaxSubset,
  SYSTEM_PROMPT,
  type SemifHttp,
} from "../../src/semif/scoring"
import { parseSemifOptions } from "../../src/semif/config"
import { profile } from "../../src/semif/manifest"

// Hermetic stand-in for llama.cpp's tokenizer: one token per character, with A..P
// mapped to the contiguous slot ids the real LFM2 tokenizer produces (A=542..P=557).
const SLOT_BASE = 542
const slotId = (letter: string) => SLOT_BASE + LETTERS.indexOf(letter)
const SLOT_IDS = LETTERS.split("").map((letter) => slotId(letter))

function defaultTokenize(content: string): number[] {
  return [...content].map((character) => {
    const index = LETTERS.indexOf(character)
    return index >= 0 ? SLOT_BASE + index : 1000 + character.charCodeAt(0)
  })
}

type FakeServerOptions = {
  logprobs: Record<number, number>
  tokenize?: (content: string) => number[]
}

function startServer(options: FakeServerOptions) {
  const tokenize = options.tokenize ?? defaultTokenize
  const completions: unknown[] = []
  let tokenizeCalls = 0
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/tokenize") {
        tokenizeCalls += 1
        const body = (await request.json()) as { content?: unknown }
        const content = typeof body.content === "string" ? body.content : ""
        return Response.json({ tokens: tokenize(content) })
      }
      if (url.pathname === "/completion") {
        const body = (await request.json()) as { prompt?: unknown }
        completions.push(body)
        const prompt = typeof body.prompt === "string" ? body.prompt : ""
        const entries = Object.entries(options.logprobs).map(([id, logprob]) => ({
          id: Number(id),
          token: Number(id),
          logprob,
        }))
        const sampled = entries.reduce<{ id: number; logprob: number } | undefined>(
          (best, entry) =>
            best === undefined || entry.logprob > best.logprob ? { id: entry.id, logprob: entry.logprob } : best,
          undefined,
        )
        return Response.json({
          completion_probabilities: [
            { token: sampled?.id ?? -1, logprob: sampled?.logprob ?? 0, top_logprobs: entries },
          ],
          tokens_evaluated: tokenize(prompt).length,
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return Object.assign(server, { completions, tokenizeCount: () => tokenizeCalls })
}

const OPTIONS = [
  { id: "access", description: "Account access support." },
  { id: "billing", description: "Billing support." },
  { id: "technical", description: "Technical troubleshooting." },
]

beforeEach(() => {
  clearCaches()
})

describe("semif scoring", () => {
  test("resolveSlotIds maps A..P to contiguous slot tokens", async () => {
    using server = startServer({ logprobs: {} })
    const ids = await resolveSlotIds({ url: server.url.origin })
    expect(ids).toHaveLength(16)
    expect(ids).toEqual(SLOT_IDS)
    expect(ids).toEqual([542, 543, 544, 545, 546, 547, 548, 549, 550, 551, 552, 553, 554, 555, 556, 557])
  })

  test("assertBoundary accepts prompt+letter as prompt tokens plus the single slot token", async () => {
    using server = startServer({ logprobs: {} })
    const http: SemifHttp = { url: server.url.origin }
    const prompt = renderPrompt("evidence", "criterion", [{ description: "one" }, { description: "two" }])
    const ids = await resolveSlotIds(http)
    const base = await assertBoundary(http, prompt, ids)
    expect(base).toEqual(defaultTokenize(prompt))
    expect(defaultTokenize(prompt + "A")).toEqual([...base, slotId("A")])
    expect(defaultTokenize(prompt + "P")).toEqual([...base, slotId("P")])
  })

  test("assertBoundary rejects when prompt+letter is not a single appended slot token", async () => {
    const broken = (content: string) =>
      content.length > 1 && content.endsWith("B") ? [...defaultTokenize(content), -1] : defaultTokenize(content)
    using server = startServer({ logprobs: {}, tokenize: broken })
    const http: SemifHttp = { url: server.url.origin }
    const prompt = renderPrompt("evidence", "criterion", [{ description: "one" }, { description: "two" }])
    const ids = await resolveSlotIds(http)
    await expect(assertBoundary(http, prompt, ids)).rejects.toThrow(/boundary check failed for letter B/)
  })

  test("prepare runs the boundary canary once at ready", async () => {
    using server = startServer({ logprobs: {} })
    const ids = await prepare({ url: server.url.origin }, "lfm2")
    expect(ids).toEqual(SLOT_IDS)
    expect(server.tokenizeCount()).toBe(16 + 1 + 16)
  })

  test("decide softmaxes only over slots present in top_logprobs", async () => {
    using server = startServer({ logprobs: { [slotId("A")]: Math.log(3), [slotId("C")]: Math.log(1) } })
    const cfg = parseSemifOptions({ cacheSize: 0 })
    const state = "Customer cannot access an account after a password reset."
    const question = "Which queue should handle this request?"
    const record = await decide({ url: server.url.origin }, cfg, {
      id: "route-1",
      state,
      question,
      options: OPTIONS,
    })

    const prompt = renderPrompt(state, question, OPTIONS)
    expect(record.chosen).toBe("access")
    expect(record.option_ids).toEqual(["access", "billing", "technical"])
    expect(record.answer_token_ids).toEqual([slotId("A"), slotId("B"), slotId("C")])
    expect(record.option_logits).toEqual([Math.log(3), Number.NEGATIVE_INFINITY, Math.log(1)])
    expect(record.probabilities[0]).toBeCloseTo(0.75, 6)
    expect(record.probabilities[1]).toBe(0)
    expect(record.probabilities[2]).toBeCloseTo(0.25, 6)
    expect(record.probabilities.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6)
    expect(record.missing_slots).toEqual(["billing"])
    expect(record.prompt_sha256).toBe(createHash("sha256").update(prompt).digest("hex"))
    expect(record.prompt_version).toBe(PROMPT_VERSION)
    expect(record.model).toEqual({ source: "LiquidAI/LFM2-1.2B", revision: "Q4_K_M", server: "llama.cpp b11040" })
    expect(record.input_tokens).toBe(defaultTokenize(prompt).length)
    expect(record.forward_seconds).toBeGreaterThanOrEqual(0)
    expect(record.total_seconds).toBeGreaterThanOrEqual(record.forward_seconds)
    expect(record.cached).toBeUndefined()
    expect(server.completions).toHaveLength(1)
    expect(server.completions[0]).toMatchObject({
      prompt,
      n_predict: 1,
      temperature: 0,
      cache_prompt: false,
      logit_bias: SLOT_IDS.map((id) => [id, SLOT_LOGIT_BIAS]),
    })
  })

  test("decide tokenizes answer slots once and skips the per-decision boundary check", async () => {
    using server = startServer({ logprobs: { [slotId("A")]: 0, [slotId("B")]: 0 } })
    const cfg = parseSemifOptions({ cacheSize: 0 })
    const http: SemifHttp = { url: server.url.origin }
    const options = [
      { id: "a", description: "Option A" },
      { id: "b", description: "Option B" },
    ]
    await decide(http, cfg, { state: "first", question: "q", options })
    const afterFirst = server.tokenizeCount()
    expect(afterFirst).toBe(16)
    await decide(http, cfg, { state: "second", question: "q", options })
    expect(server.tokenizeCount()).toBe(afterFirst)
    expect(server.completions).toHaveLength(2)
  })

  test("decide throws when no declared slot appears in top_logprobs", async () => {
    using server = startServer({ logprobs: { [slotId("C")]: 0 } })
    const cfg = parseSemifOptions({ cacheSize: 0 })
    await expect(
      decide({ url: server.url.origin }, cfg, {
        state: "unique-all-missing-evidence",
        question: "q",
        options: [
          { id: "a", description: "Option A" },
          { id: "b", description: "Option B" },
        ],
      }),
    ).rejects.toThrow(/no logprobs for any declared answer slot/)
  })

  test("decide returns cached records with cached=true", async () => {
    using server = startServer({ logprobs: { [slotId("A")]: 0, [slotId("B")]: 0 } })
    const cfg = parseSemifOptions({ cacheSize: 8 })
    const http: SemifHttp = { url: server.url.origin }
    const request = {
      state: "cache-probe-4f2a",
      question: "q",
      options: [
        { id: "x", description: "Option X" },
        { id: "y", description: "Option Y" },
      ],
    }

    const first = await decide(http, cfg, request)
    const second = await decide(http, cfg, request)

    expect(first.cached).toBeUndefined()
    expect(second.cached).toBe(true)
    expect(second.prompt_sha256).toBe(first.prompt_sha256)
    expect(second.chosen).toBe(first.chosen)
    expect(second.probabilities).toEqual(first.probabilities)
  })

  test("decide honors an aborted AbortSignal", async () => {
    using server = startServer({ logprobs: { [slotId("A")]: 0 } })
    const cfg = parseSemifOptions({ cacheSize: 0 })
    const controller = new AbortController()
    controller.abort(new Error("cancelled by test"))
    await expect(
      decide({ url: server.url.origin, signal: controller.signal }, cfg, {
        state: "abort-probe",
        question: "q",
        options: [
          { id: "a", description: "Option A" },
          { id: "b", description: "Option B" },
        ],
      }),
    ).rejects.toThrow()
  })

  test("softmaxSubset normalizes only finite logits", () => {
    expect(softmaxSubset([0, 0, Number.NEGATIVE_INFINITY])).toEqual([0.5, 0.5, 0])
    expect(softmaxSubset([Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY])).toEqual([0, 0])
    const weighted = softmaxSubset([Math.log(1), Math.log(3)])
    expect(weighted[0]).toBeCloseTo(0.25, 6)
    expect(weighted[1]).toBeCloseTo(0.75, 6)
  })

  test("renderPrompt embeds only the SemIf direct-options payload", () => {
    const prompt = renderPrompt("evidence", "criterion", OPTIONS)
    expect(prompt.startsWith("<|startoftext|><|im_start|>system\n")).toBe(true)
    expect(prompt).toContain(SYSTEM_PROMPT)
    expect(prompt.endsWith("<|im_start|>assistant\n")).toBe(true)
    expect(prompt).not.toContain('"id"')
    expect(prompt).toContain('"letter":"A"')
  })

  test("renderPrompt uses Qwen ChatML and DeepSeek-R1 prefills an empty think block", () => {
    const qwen = renderPrompt("evidence", "criterion", OPTIONS, "qwen")
    expect(qwen.startsWith("<|im_start|>system\n")).toBe(true)
    expect(qwen.includes("<|startoftext|>")).toBe(false)

    const deepseek = renderPrompt("evidence", "criterion", OPTIONS, "deepseek_r1")
    expect(deepseek.startsWith("<｜begin▁of▁sentence｜><｜User｜>")).toBe(true)
    expect(deepseek.endsWith("<｜Assistant｜><think>\n\n</think>")).toBe(true)
  })

  test("decide uses the selected profile for cache_prompt and model identity", async () => {
    using server = startServer({ logprobs: { [slotId("A")]: 0, [slotId("B")]: 0 } })
    const cfg = parseSemifOptions({ cacheSize: 0 })
    const qwen = profile({
      id: "Qwen/Qwen2.5-1.5B",
      filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
      url: "https://example.invalid",
      bytes: 1,
      sha256: "aa",
      quant: "Q4_K_M",
      label: "Qwen2.5-1.5B",
      source: "Qwen/Qwen2.5-1.5B",
      family: "qwen",
      choice: true,
    })
    const record = await decide(
      { url: server.url.origin },
      cfg,
      {
        state: "qwen-profile",
        question: "q",
        options: [
          { id: "a", description: "Option A" },
          { id: "b", description: "Option B" },
        ],
      },
      qwen,
    )
    expect(record.model).toEqual({ source: "Qwen/Qwen2.5-1.5B", revision: "Q4_K_M", server: "llama.cpp b11040" })
    expect(server.completions[0]).toMatchObject({ cache_prompt: true })
    expect((server.completions[0] as { prompt: string }).prompt.startsWith("<|im_start|>system\n")).toBe(true)
  })
})
