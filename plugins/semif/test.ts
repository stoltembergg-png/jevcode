import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import {
  DEFAULT_MODEL_PATH,
  DEFAULT_SERVER_PATH,
  parseSemifOptions,
} from "./config"
import { createSidecar } from "./engine"
import {
  assertBoundary,
  decide,
  renderPrompt,
  resolveSlotIds,
  softmaxSubset,
  SYSTEM_PROMPT,
} from "./scoring"

const testPort = Number(process.env.SEMIF_TEST_PORT ?? 8819)
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

let failures = 0

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ok    ${name}`)
  } catch (error) {
    failures++
    console.error(`  FAIL  ${name}`)
    console.error(error instanceof Error ? error.stack : error)
  }
}

function approx(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} ~= ${expected} (tol ${tolerance})`)
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject)
  })
  return hash.digest("hex")
}

async function waitPortClosed(port: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let open = false
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      open = response.ok || response.status === 503
    } catch {
      open = false
    }
    if (!open) return true
    await delay(300)
  }
  return false
}

const ACCESS_PROMPT_OPTIONS = [
  { id: "access", description: "Account access support." },
  { id: "billing", description: "Billing support." },
  { id: "technical", description: "Technical troubleshooting." },
]
const ACCESS_EVIDENCE = "Customer cannot access an account after a password reset."
const ACCESS_QUESTION = "Which queue should handle this request?"

async function runLogicTests(): Promise<void> {
  console.log("\nLogic tests (no server)")

  await test("config: defaults", () => {
    const cfg = parseSemifOptions()
    assert.equal(cfg.mode, "auto")
    assert.equal(cfg.host, "127.0.0.1")
    assert.equal(cfg.port, 8817)
    assert.equal(cfg.threads, 4)
    assert.equal(cfg.contextSize, 2048)
    assert.equal(cfg.nProbs, 256)
    assert.equal(cfg.loadTimeoutMs, 60000)
    assert.equal(cfg.cacheSize, 128)
    assert.equal(cfg.modelPath, DEFAULT_MODEL_PATH)
    assert.equal(cfg.serverPath, DEFAULT_SERVER_PATH)
  })

  await test("config: options override defaults", () => {
    const cfg = parseSemifOptions({ mode: "off", port: 1234, nProbs: 64, cacheSize: 0, host: "0.0.0.0" })
    assert.equal(cfg.mode, "off")
    assert.equal(cfg.port, 1234)
    assert.equal(cfg.nProbs, 64)
    assert.equal(cfg.cacheSize, 0)
    assert.equal(cfg.host, "0.0.0.0")
  })

  await test("config: env vars fill in, options win", () => {
    const previous = { port: process.env.SEMIF_PORT, mode: process.env.SEMIF_MODE }
    process.env.SEMIF_PORT = "9999"
    process.env.SEMIF_MODE = "off"
    try {
      const fromEnv = parseSemifOptions()
      assert.equal(fromEnv.port, 9999)
      assert.equal(fromEnv.mode, "off")
      const fromOptions = parseSemifOptions({ port: 4321, mode: "lazy" })
      assert.equal(fromOptions.port, 4321)
      assert.equal(fromOptions.mode, "lazy")
    } finally {
      if (previous.port === undefined) delete process.env.SEMIF_PORT
      else process.env.SEMIF_PORT = previous.port
      if (previous.mode === undefined) delete process.env.SEMIF_MODE
      else process.env.SEMIF_MODE = previous.mode
    }
  })

  await test("config: invalid values throw", () => {
    assert.throws(() => parseSemifOptions({ mode: "sometimes" }))
    assert.throws(() => parseSemifOptions({ port: 70000 }))
    assert.throws(() => parseSemifOptions({ nProbs: 8 }))
    assert.throws(() => parseSemifOptions({ cacheSize: -1 }))
    // A blank modelPath is treated as absent and falls back to the documented default.
    assert.equal(parseSemifOptions({ modelPath: "   " }).modelPath, DEFAULT_MODEL_PATH)
  })

  await test("prompt: golden direct-options-v1 rendering", () => {
    const prompt = renderPrompt(ACCESS_EVIDENCE, ACCESS_QUESTION, ACCESS_PROMPT_OPTIONS)
    const payload = JSON.stringify({
      evidence: ACCESS_EVIDENCE,
      criterion: ACCESS_QUESTION,
      options: [
        { letter: "A", description: "Account access support." },
        { letter: "B", description: "Billing support." },
        { letter: "C", description: "Technical troubleshooting." },
      ],
    })
    const expected =
      "<|startoftext|><|im_start|>system\n" +
      `${SYSTEM_PROMPT}<|im_end|>\n` +
      `<|im_start|>user\n${payload}<|im_end|>\n` +
      "<|im_start|>assistant\n"
    assert.equal(prompt, expected)
    assert.ok(prompt.startsWith("<|startoftext|><|im_start|>system\n"))
    assert.ok(prompt.endsWith("<|im_start|>assistant\n"))
    assert.ok(!prompt.includes('"id"'), "option ids must not leak into the prompt")
    assert.ok(!prompt.includes('"label"'), "option labels must not leak into the prompt")
    assert.ok(prompt.includes('"evidence"') && prompt.includes('"criterion"') && prompt.includes('"options"'))
  })

  await test("softmax: subset math with missing slots", () => {
    const even = softmaxSubset([0, 0, Number.NEGATIVE_INFINITY])
    approx(even[0]!, 0.5)
    approx(even[1]!, 0.5)
    assert.equal(even[2], 0)
    approx(sum(even), 1)

    const weighted = softmaxSubset([Math.log(1), Math.log(3)])
    approx(weighted[0]!, 0.25)
    approx(weighted[1]!, 0.75)

    const allMissing = softmaxSubset([Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY])
    assert.deepEqual(allMissing, [0, 0])

    const withMissing = softmaxSubset([Math.log(1), Number.NEGATIVE_INFINITY, Math.log(1)])
    approx(withMissing[0]!, 0.5)
    assert.equal(withMissing[1], 0)
    approx(withMissing[2]!, 0.5)
    approx(sum(withMissing), 1)
  })
}

async function runLiveTests(): Promise<void> {
  console.log(`\nLive tests (hermetic sidecar on port ${testPort})`)
  const cfg = parseSemifOptions({
    mode: "lazy",
    port: testPort,
    modelPath: DEFAULT_MODEL_PATH,
    serverPath: DEFAULT_SERVER_PATH,
    threads: 4,
    cacheSize: 2,
    loadTimeoutMs: 120000,
  })
  const sidecar = createSidecar(cfg)
  const http: { url: string } = { url: "" }

  try {
    const started = Date.now()
    const ensured = await sidecar.ensure()
    http.url = ensured.url
    console.log(`  sidecar ready in ${((Date.now() - started) / 1000).toFixed(1)}s at ${http.url} (adopted=${ensured.adopted})`)

    let slotIds: number[] = []

    await test("slots: A..P are single tokens A=542..P=557", async () => {
      slotIds = await resolveSlotIds(http)
      assert.equal(slotIds.length, 16)
      assert.equal(slotIds[0], 542)
      assert.equal(slotIds[15], 557)
      for (let index = 1; index < slotIds.length; index++) {
        assert.equal(slotIds[index]! - slotIds[index - 1]!, 1)
      }
    })

    await test("boundary: prompt+letter is prompt tokens plus one slot token", async () => {
      const prompt = renderPrompt(ACCESS_EVIDENCE, ACCESS_QUESTION, ACCESS_PROMPT_OPTIONS)
      const base = await assertBoundary(http, prompt, slotIds)
      assert.ok(base.length > 0)
      console.log(`        prompt token count = ${base.length}, last three = ${base.slice(-3).join(",")}`)
    })

    let first: Awaited<ReturnType<typeof decide>>
    await test("decide: account-access example chooses 'access'", async () => {
      first = await decide(http, cfg, {
        id: "account-access-1",
        state: ACCESS_EVIDENCE,
        question: ACCESS_QUESTION,
        options: ACCESS_PROMPT_OPTIONS,
      })
      assert.equal(first.probabilities.length, 3)
      approx(sum(first.probabilities), 1, 1e-6)
      assert.equal(first.chosen, "access")
      assert.equal(first.option_ids.join(","), "access,billing,technical")
      assert.equal(first.answer_token_ids.length, 3)
      assert.equal(first.prompt_version, "direct-options-v1")
      assert.equal(first.model.server, "llama.cpp b11040")
      assert.equal(first.model.source, "LiquidAI/LFM2-350M")
      assert.equal(first.model.revision, "Q4_K_M")
      assert.equal(first.prompt_sha256.length, 64)
      assert.ok(first.input_tokens > 0)
      assert.equal(first.missing_slots.length, 0)
      assert.ok(first.forward_seconds >= 0)
      assert.ok(first.total_seconds >= first.forward_seconds)
      console.log(`        probabilities = ${first.probabilities.map((p) => p.toFixed(3)).join(", ")}`)
      console.log(`        logits = ${first.option_logits.map((l) => l.toFixed(2)).join(", ")}`)
      console.log(`        input_tokens = ${first.input_tokens}, forward = ${first.forward_seconds.toFixed(3)}s`)
    })

    await test("cache: identical second call is served from cache", async () => {
      const second = await decide(http, cfg, {
        id: "account-access-2",
        state: ACCESS_EVIDENCE,
        question: ACCESS_QUESTION,
        options: ACCESS_PROMPT_OPTIONS,
      })
      assert.equal(second.cached, true)
      assert.equal(second.prompt_sha256, first!.prompt_sha256)
      assert.equal(second.chosen, first!.chosen)
      assert.deepEqual(second.probabilities, first!.probabilities)
    })
  } finally {
    await sidecar.dispose()
  }

  await test("dispose: hermetic port is released", async () => {
    const closed = await waitPortClosed(testPort)
    assert.equal(closed, true, `port ${testPort} still answering /health after dispose`)
  })
}

async function main(): Promise<void> {
  console.log(`semif test suite (bun ${Bun.version})`)

  await runLogicTests()
  await runLiveTests()

  console.log("\nModel pin")
  const modelSha = await sha256File(DEFAULT_MODEL_PATH)
  console.log(`  sha256(${DEFAULT_MODEL_PATH}) = ${modelSha}`)

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failing test(s)`)
  process.exitCode = failures === 0 ? 0 : 1
}

await main()
