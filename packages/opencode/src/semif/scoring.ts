import { createHash, randomUUID } from "node:crypto"
import type { SemifResolved } from "./config"
import { profile, type ChatFamily, type Profile } from "./manifest"

export const LETTERS = "ABCDEFGHIJKLMNOP"

export const SYSTEM_PROMPT =
  "Apply the supplied criterion to the supplied evidence. Choose exactly one listed option. Respond with only its uppercase letter, with no explanation or reasoning."

export const PROMPT_VERSION = "direct-options-v1"

export const SERVER_REVISION = "llama.cpp b11040"

export const SLOT_LOGIT_BIAS = 20

export const PROBABILITY_STATUS = "conditional option score; uncalibrated as decision confidence"
export const READOUT =
  "llama.cpp server top-k next-token logprobs at declared answer slots with equal slot logit_bias"

export type SemifHttp = {
  url: string
  signal?: AbortSignal
  fetch?: typeof fetch
}

export type SemifOption = { id: string; description: string }

export type SemifDecisionRequest = {
  id?: string
  state: unknown
  question: string
  options: SemifOption[]
}

export type SemifDecision = {
  id: string
  option_ids: string[]
  probabilities: number[]
  option_logits: number[]
  answer_token_ids: number[]
  chosen: string
  input_tokens: number
  prompt_sha256: string
  prompt_version: typeof PROMPT_VERSION
  model: { source: string; revision: string; server: string }
  probability_status: string
  readout: string
  forward_seconds: number
  total_seconds: number
  missing_slots: string[]
  cached?: boolean
}

type CompletionProbabilityEntry = { id?: unknown; token?: unknown; logprob?: unknown }
type CompletionProbability = {
  token?: unknown
  logprob?: unknown
  top_logprobs?: CompletionProbabilityEntry[] | unknown
}
type CompletionResponse = {
  completion_probabilities?: CompletionProbability[] | unknown
  tokens_evaluated?: unknown
}

// LFM2 uses a hybrid convolution + attention architecture, so llama.cpp cannot reuse a
// shared KV cache prefix across decisions. Qwen-family models may cache the prompt.
const slotCache = new Map<string, number[]>()
const decisionCache = new Map<string, SemifDecision>()

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function clearCaches(): void {
  slotCache.clear()
  decisionCache.clear()
}

function linksignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  const abort = () => controller.abort(signals.find((signal) => signal.aborted)?.reason)
  for (const signal of signals) {
    if (signal.aborted) {
      abort()
      break
    }
    signal.addEventListener("abort", abort, { once: true })
  }
  return controller.signal
}

async function postJson(http: SemifHttp, path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const doFetch = http.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`semif: ${path} request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  )
  const signal = http.signal ? linksignals([http.signal, controller.signal]) : controller.signal
  try {
    const response = await doFetch(`${http.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) throw new Error(`semif: ${path} returned HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function tokenize(http: SemifHttp, content: string, parseSpecial: boolean): Promise<number[]> {
  const response = (await postJson(
    http,
    "/tokenize",
    { content, add_special: false, parse_special: parseSpecial },
    15000,
  )) as { tokens?: unknown }
  if (!Array.isArray(response.tokens)) throw new Error("semif: /tokenize did not return a tokens array")
  return response.tokens.map((token) => {
    if (typeof token === "number") return token
    if (typeof token === "object" && token !== null) {
      const id = (token as Record<string, unknown>).id
      if (typeof id === "number") return id
    }
    throw new Error("semif: /tokenize returned a non-numeric token")
  })
}

export async function resolveSlotIds(http: SemifHttp): Promise<number[]> {
  const cached = slotCache.get(http.url)
  if (cached) return cached
  const ids: number[] = []
  for (const letter of LETTERS) {
    const tokens = await tokenize(http, letter, false)
    if (tokens.length !== 1) {
      throw new Error(`semif: answer slot ${letter} tokenized to ${tokens.length} tokens; expected exactly 1`)
    }
    ids.push(tokens[0]!)
  }
  slotCache.set(http.url, ids)
  return ids
}

export async function assertBoundary(http: SemifHttp, prompt: string, slotIds: number[]): Promise<number[]> {
  const base = await tokenize(http, prompt, true)
  const extended = await Promise.all(LETTERS.split("").map((letter) => tokenize(http, prompt + letter, true)))
  for (let index = 0; index < LETTERS.length; index++) {
    const letter = LETTERS[index]!
    const tokens = extended[index]!
    const prefixOk = tokens.length === base.length + 1 && base.every((token, position) => tokens[position] === token)
    const slotOk = tokens[base.length] === slotIds[index]
    if (!prefixOk || !slotOk) {
      throw new Error(
        `semif: boundary check failed for letter ${letter} (prefixOk=${prefixOk}, slotOk=${slotOk}); ` +
          `prompt+letter must be prompt tokens plus the single slot token ${slotIds[index]}`,
      )
    }
  }
  return base
}

export function renderPrompt(
  state: unknown,
  question: string,
  options: Array<{ description: string }>,
  family: ChatFamily = "lfm2",
): string {
  const payload = JSON.stringify({
    evidence: state,
    criterion: question,
    options: options.map((option, index) => ({ letter: LETTERS[index], description: option.description })),
  })
  if (family === "deepseek_r1") {
    return (
      "<｜begin▁of▁sentence｜><｜User｜>" +
      `${SYSTEM_PROMPT}\n${payload}` +
      "<｜Assistant｜><think>\n\n</think>"
    )
  }
  const body =
    `<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>\n` +
    `<|im_start|>user\n${payload}<|im_end|>\n` +
    "<|im_start|>assistant\n"
  if (family === "qwen") return body
  return "<|startoftext|>" + body
}

export async function prepare(http: SemifHttp, family: ChatFamily = "lfm2"): Promise<number[]> {
  const slotIds = await resolveSlotIds(http)
  const prompt = renderPrompt("canary", "choose", [{ description: "one" }, { description: "two" }], family)
  await assertBoundary(http, prompt, slotIds)
  return slotIds
}

export function softmaxSubset(logits: number[]): number[] {
  const present = logits.filter((value) => Number.isFinite(value))
  if (present.length === 0) return logits.map(() => 0)
  const max = Math.max(...present)
  const exponentials = logits.map((value) => (Number.isFinite(value) ? Math.exp(value - max) : 0))
  const total = exponentials.reduce((sum, value) => sum + value, 0)
  if (total === 0) return logits.map(() => 0)
  return exponentials.map((value) => value / total)
}

function validate(request: SemifDecisionRequest): void {
  const { options } = request
  if (!Array.isArray(options) || options.length < 2 || options.length > 16) {
    throw new Error(`semif: expected 2..16 options (got ${options?.length ?? 0})`)
  }
  const ids = new Set<string>()
  for (const option of options) {
    if (typeof option?.id !== "string" || option.id.trim() === "") {
      throw new Error("semif: every option needs a non-empty string id")
    }
    if (typeof option.description !== "string" || option.description.trim() === "") {
      throw new Error(`semif: option "${option.id}" needs a non-empty description`)
    }
    if (ids.has(option.id)) throw new Error(`semif: duplicate option id "${option.id}"`)
    ids.add(option.id)
  }
}

function cacheKey(promptSha: string, options: SemifOption[]): string {
  return `${promptSha}:${options.map((option) => option.id).join(",")}`
}

function readCache(key: string): SemifDecision | undefined {
  const hit = decisionCache.get(key)
  if (!hit) return undefined
  decisionCache.delete(key)
  decisionCache.set(key, hit)
  return hit
}

function writeCache(key: string, record: SemifDecision, capacity: number): void {
  if (capacity <= 0) return
  decisionCache.set(key, record)
  while (decisionCache.size > capacity) {
    const oldest = decisionCache.keys().next().value
    if (oldest === undefined) break
    decisionCache.delete(oldest)
  }
}

function parseCompletion(response: unknown): { byToken: Map<number, number>; tokensEvaluated: number | undefined } {
  const byToken = new Map<number, number>()
  const body = response as CompletionResponse
  const probabilities = Array.isArray(body.completion_probabilities) ? body.completion_probabilities : []
  const first = probabilities[0] as CompletionProbability | undefined
  const top = Array.isArray(first?.top_logprobs) ? (first.top_logprobs as CompletionProbabilityEntry[]) : []
  for (const entry of top) {
    if (typeof entry.id === "number" && typeof entry.logprob === "number") byToken.set(entry.id, entry.logprob)
  }
  if (typeof first?.token === "number" && typeof first.logprob === "number" && !byToken.has(first.token)) {
    byToken.set(first.token, first.logprob)
  }
  const tokensEvaluated = typeof body.tokens_evaluated === "number" ? body.tokens_evaluated : undefined
  return { byToken, tokensEvaluated }
}

export async function decide(
  http: SemifHttp,
  cfg: SemifResolved,
  request: SemifDecisionRequest,
  model: Profile = profile(),
): Promise<SemifDecision> {
  const started = performance.now()
  validate(request)

  const prompt = renderPrompt(request.state, request.question, request.options, model.family)
  const promptSha = createHash("sha256").update(prompt).digest("hex")
  const key = cacheKey(promptSha, request.options)

  if (cfg.cacheSize > 0) {
    const cached = readCache(key)
    if (cached) return { ...cached, id: request.id ?? cached.id, cached: true }
  }

  const slotIds = await resolveSlotIds(http)

  const forwardStarted = performance.now()
  const response = await postJson(
    http,
    "/completion",
    {
      prompt,
      n_predict: 1,
      n_probs: cfg.nProbs,
      temperature: 0,
      return_tokens: true,
      cache_prompt: model.cachePrompt,
      logit_bias: slotIds.map((id) => [id, SLOT_LOGIT_BIAS]),
    },
    300000,
  )
  const forwardSeconds = (performance.now() - forwardStarted) / 1000

  const { byToken, tokensEvaluated } = parseCompletion(response)
  const optionLogits = slotIds
    .slice(0, request.options.length)
    .map((tokenId) => (byToken.has(tokenId) ? byToken.get(tokenId)! : Number.NEGATIVE_INFINITY))
  const missingSlots = request.options
    .filter((_, index) => !Number.isFinite(optionLogits[index]))
    .map((option) => option.id)

  if (missingSlots.length === request.options.length) {
    throw new Error("semif: model returned no logprobs for any declared answer slot")
  }

  const probabilities = softmaxSubset(optionLogits)
  const chosenIndex = probabilities.reduce((best, value, index) => (value > probabilities[best]! ? index : best), 0)
  const chosen = request.options[chosenIndex]!.id
  const totalSeconds = (performance.now() - started) / 1000

  const record: SemifDecision = {
    id: request.id ?? randomUUID(),
    option_ids: request.options.map((option) => option.id),
    probabilities,
    option_logits: optionLogits,
    answer_token_ids: slotIds.slice(0, request.options.length),
    chosen,
    input_tokens: tokensEvaluated ?? 0,
    prompt_sha256: promptSha,
    prompt_version: PROMPT_VERSION,
    model: { source: model.source, revision: model.revision, server: SERVER_REVISION },
    probability_status: PROBABILITY_STATUS,
    readout: READOUT,
    forward_seconds: forwardSeconds,
    total_seconds: totalSeconds,
    missing_slots: missingSlots,
  }

  writeCache(key, record, cfg.cacheSize)
  return record
}

export { message as semifErrorMessage }

export * as SemifScoring from "./scoring"
