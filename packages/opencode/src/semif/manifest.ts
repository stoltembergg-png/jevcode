// Pinned registry of the SemIf model. This is the runtime counterpart of the
// server lockfile (`script/semif-server.lock.json`): the bytes and sha256 below
// were verified against the upstream Hugging Face artifact, and acquisition must
// never trust a download that does not match them.
//
// The Hugging Face "resolve" URL redirects to a short-lived CDN URL. We never
// cache the resolved URL; every download attempt re-resolves it through fetch.

export const MIRROR_ENV = "NEXTCODE_SEMIF_MODEL_MIRROR"

export interface Entry {
  readonly id: string
  readonly filename: string
  readonly url: string
  readonly bytes: number
  readonly sha256: string
  readonly quant: string
}

export const MODEL: Entry = {
  id: "LiquidAI/LFM2-350M-GGUF",
  filename: "LFM2-350M-Q4_K_M.gguf",
  url: "https://huggingface.co/LiquidAI/LFM2-350M-GGUF/resolve/main/LFM2-350M-Q4_K_M.gguf",
  bytes: 229_309_376,
  sha256: "a4d000c7064bd3b2e42c6845836286a899a4e79cf1791da1a6797b58d575957d",
  quant: "Q4_K_M",
}

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

export function resolveUrl(env: Record<string, string | undefined> = process.env): string {
  return mirrorUrl(env) ?? MODEL.url
}

const identifiers = (entry: Entry): string[] => [
  entry.id.toLowerCase(),
  `${entry.id.toLowerCase()}:${entry.quant.toLowerCase()}`,
  entry.quant.toLowerCase(),
  entry.filename.toLowerCase(),
  entry.filename.replace(/\.gguf$/i, "").toLowerCase(),
]

// Resolves a configured model name to the pinned entry. An unspecified model
// resolves to the pinned default; an unknown model resolves to `undefined`, which
// the service reports as `unsupported` instead of silently downloading something.
export function find(model?: string): Entry | undefined {
  const needle = readString(model)?.toLowerCase()
  if (!needle) return MODEL
  return identifiers(MODEL).includes(needle) ? MODEL : undefined
}

export * as SemifManifest from "./manifest"
