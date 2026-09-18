import { stat } from "node:fs/promises"

export type SemifMode = "auto" | "lazy" | "off"

export type SemifOptions = {
  mode?: string
  modelPath?: string
  serverPath?: string
  port?: number
  threads?: number
  contextSize?: number
  nProbs?: number
  loadTimeoutMs?: number
  cacheSize?: number
  host?: string
}

export type SemifResolved = {
  mode: SemifMode
  host: string
  port: number
  threads: number
  contextSize: number
  nProbs: number
  loadTimeoutMs: number
  cacheSize: number
  modelPath: string
  serverPath: string
}

export type SemifPathStatus = {
  modelExists: boolean
  serverExists: boolean
  modelPath: string
  serverPath: string
}

// Documented fallback paths for this development workspace. Override with options or env vars.
export const DEFAULT_MODEL_PATH = "C:\\Users\\Gabriel\\Desktop\\semif-workspace\\models\\LFM2-350M-Q4_K_M.gguf"
export const DEFAULT_SERVER_PATH = "C:\\Users\\Gabriel\\Desktop\\semif-workspace\\bin\\b11040\\llama-server.exe"

const DEFAULTS = {
  mode: "auto" as SemifMode,
  host: "127.0.0.1",
  port: 8817,
  threads: 4,
  contextSize: 2048,
  nProbs: 256,
  loadTimeoutMs: 60000,
  cacheSize: 128,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const readInt = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return undefined
}

const requireInt = (value: number | undefined, fallback: number, name: string, min: number, max: number): number => {
  const next = value ?? fallback
  if (!Number.isInteger(next) || next < min || next > max) {
    throw new Error(`semif: ${name} must be an integer between ${min} and ${max} (got ${String(next)})`)
  }
  return next
}

export function parseSemifOptions(raw?: unknown): SemifResolved {
  const options = isRecord(raw) ? raw : {}
  const env = process.env

  // Merge order: defaults < env vars < config options.
  const modeRaw = (readString(options.mode) ?? readString(env.SEMIF_MODE) ?? DEFAULTS.mode).toLowerCase()
  if (modeRaw !== "auto" && modeRaw !== "lazy" && modeRaw !== "off") {
    throw new Error(`semif: mode must be "auto", "lazy" or "off" (got "${modeRaw}")`)
  }

  const modelPath = readString(options.modelPath) ?? readString(env.SEMIF_MODEL_PATH) ?? DEFAULT_MODEL_PATH
  const serverPath = readString(options.serverPath) ?? readString(env.SEMIF_SERVER_PATH) ?? DEFAULT_SERVER_PATH
  if (!modelPath) throw new Error("semif: modelPath must be a non-empty string")
  if (!serverPath) throw new Error("semif: serverPath must be a non-empty string")

  const host = readString(options.host) ?? readString(env.SEMIF_HOST) ?? DEFAULTS.host
  const port = requireInt(readInt(options.port) ?? readInt(env.SEMIF_PORT), DEFAULTS.port, "port", 1, 65535)
  const threads = requireInt(
    readInt(options.threads) ?? readInt(env.SEMIF_THREADS),
    DEFAULTS.threads,
    "threads",
    1,
    1024,
  )
  const contextSize = requireInt(
    readInt(options.contextSize) ?? readInt(env.SEMIF_CONTEXT_SIZE),
    DEFAULTS.contextSize,
    "contextSize",
    1,
    1_048_576,
  )
  const nProbs = requireInt(readInt(options.nProbs) ?? readInt(env.SEMIF_NPROBS), DEFAULTS.nProbs, "nProbs", 32, 1_000_000)
  const loadTimeoutMs = requireInt(
    readInt(options.loadTimeoutMs) ?? readInt(env.SEMIF_LOAD_TIMEOUT_MS),
    DEFAULTS.loadTimeoutMs,
    "loadTimeoutMs",
    100,
    3_600_000,
  )
  const cacheSize = requireInt(
    readInt(options.cacheSize) ?? readInt(env.SEMIF_CACHE_SIZE),
    DEFAULTS.cacheSize,
    "cacheSize",
    0,
    1_000_000,
  )

  return {
    mode: modeRaw,
    host,
    port,
    threads,
    contextSize,
    nProbs,
    loadTimeoutMs,
    cacheSize,
    modelPath,
    serverPath,
  }
}

export async function checkSemifPaths(cfg: SemifResolved): Promise<SemifPathStatus> {
  const [modelExists, serverExists] = await Promise.all([
    stat(cfg.modelPath).then(
      () => true,
      () => false,
    ),
    stat(cfg.serverPath).then(
      () => true,
      () => false,
    ),
  ])
  return { modelExists, serverExists, modelPath: cfg.modelPath, serverPath: cfg.serverPath }
}

export async function assertSemifPaths(cfg: SemifResolved): Promise<void> {
  const status = await checkSemifPaths(cfg)
  if (!status.modelExists) throw new Error(`semif: model file not found at ${cfg.modelPath}`)
  if (!status.serverExists) throw new Error(`semif: llama-server binary not found at ${cfg.serverPath}`)
}

export * as SemifConfig from "./config"
