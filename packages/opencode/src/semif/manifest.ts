// Pinned registry of SemIf models. This is the runtime counterpart of the
// server lockfile (`script/semif-server.lock.json`): the bytes and sha256 below
// were verified against the upstream Hugging Face artifact, and acquisition must
// never trust a download that does not match them.
//
// The Hugging Face "resolve" URL redirects to a short-lived CDN URL. We never
// cache the resolved URL; every download attempt re-resolves it through fetch.

export const MIRROR_ENV = "NEXTCODE_SEMIF_MODEL_MIRROR"

export type ChatFamily = "lfm2" | "qwen" | "deepseek_r1"

export interface Entry {
  readonly id: string
  readonly filename: string
  readonly url: string
  readonly bytes: number
  readonly sha256: string
  readonly quant: string
  readonly label: string
  readonly source: string
  readonly family: ChatFamily
  readonly choice: boolean
  readonly aliases?: readonly string[]
}

export interface Profile {
  readonly family: ChatFamily
  readonly source: string
  readonly revision: string
  readonly cachePrompt: boolean
}

const LFM2_350M: Entry = {
  id: "LiquidAI/LFM2-350M-GGUF",
  filename: "LFM2-350M-Q4_K_M.gguf",
  url: "https://huggingface.co/LiquidAI/LFM2-350M-GGUF/resolve/main/LFM2-350M-Q4_K_M.gguf",
  bytes: 229_309_376,
  sha256: "a4d000c7064bd3b2e42c6845836286a899a4e79cf1791da1a6797b58d575957d",
  quant: "Q4_K_M",
  label: "LFM2-350M Q4_K_M",
  source: "LiquidAI/LFM2-350M",
  family: "lfm2",
  choice: false,
}

const LFM2_1_2B: Entry = {
  id: "LiquidAI/LFM2-1.2B-GGUF",
  filename: "LFM2-1.2B-Q4_K_M.gguf",
  url: "https://huggingface.co/LiquidAI/LFM2-1.2B-GGUF/resolve/main/LFM2-1.2B-Q4_K_M.gguf",
  bytes: 730_893_248,
  sha256: "55175400e3f509a9616227afeffd58d87e80b9f628a5d3d54ada884d85221fed",
  quant: "Q4_K_M",
  label: "LFM2-1.2B Q4_K_M",
  source: "LiquidAI/LFM2-1.2B",
  family: "lfm2",
  choice: true,
  aliases: ["LFM2-1.2B"],
}

const DEEPSEEK_R1_1_5B: Entry = {
  id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  filename: "DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf",
  url: "https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf",
  bytes: 1_117_320_800,
  sha256: "1741e5b2d062b07acf048bf0d2c514dadf2a48f94e2b4aa0cfe069af3838ee2f",
  quant: "Q4_K_M",
  label: "DeepSeek-R1-Distill-Qwen-1.5B",
  source: "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B",
  family: "deepseek_r1",
  choice: true,
  aliases: ["bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF", "DeepSeek-R1-Distill-Qwen-1.5B"],
}

const QWEN_2_5_1_5B: Entry = {
  id: "Qwen/Qwen2.5-1.5B",
  filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
  url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
  bytes: 1_117_320_736,
  sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
  quant: "Q4_K_M",
  label: "Qwen2.5-1.5B",
  source: "Qwen/Qwen2.5-1.5B",
  family: "qwen",
  choice: true,
  aliases: ["Qwen/Qwen2.5-1.5B-Instruct", "Qwen/Qwen2.5-1.5B-Instruct-GGUF", "Qwen2.5-1.5B"],
}

export const MODEL: Entry = LFM2_1_2B

export const MODELS: readonly Entry[] = [LFM2_1_2B, DEEPSEEK_R1_1_5B, QWEN_2_5_1_5B, LFM2_350M]

export const CHOICES: readonly Entry[] = MODELS.filter((entry) => entry.choice)

const readString = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

// A mirror is an optional, explicit override read from the environment. When set
// it is tried before the pinned upstream URL. It must be a full URL to the model
// file, matching the server lockfile's `NEXTCODE_SEMIF_MIRROR` convention.
export function mirrorUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  return readString(env[MIRROR_ENV])
}

export function resolveUrl(
  entry: Entry = MODEL,
  env: Record<string, string | undefined> = process.env,
): string {
  return mirrorUrl(env) ?? entry.url
}

export function profile(entry: Entry = MODEL): Profile {
  return {
    family: entry.family,
    source: entry.source,
    revision: entry.quant,
    cachePrompt: entry.family !== "lfm2",
  }
}

const identifiers = (entry: Entry): string[] => {
  const id = entry.id.toLowerCase()
  const filename = entry.filename.toLowerCase()
  const aliases = [
    id,
    `${id}:${entry.quant.toLowerCase()}`,
    entry.source.toLowerCase(),
    entry.label.toLowerCase(),
    filename,
    filename.replace(/\.gguf$/i, ""),
    ...(entry.aliases ?? []).map((alias) => alias.toLowerCase()),
  ]
  if (entry === MODEL) aliases.push(entry.quant.toLowerCase())
  return aliases
}

// Resolves a configured model name to a pinned entry. An unspecified model
// resolves to the pinned default; an unknown model resolves to `undefined`, which
// the service reports as `unsupported` instead of silently downloading something.
export function find(model?: string): Entry | undefined {
  const needle = readString(model)?.toLowerCase()
  if (!needle) return MODEL
  return MODELS.find((entry) => identifiers(entry).includes(needle))
}

export * as SemifManifest from "./manifest"
