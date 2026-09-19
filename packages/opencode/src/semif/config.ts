import { readdir, stat } from "node:fs/promises"
import { availableParallelism } from "node:os"
import { join } from "node:path"
import type { ConfigSemifV1 } from "@opencode-ai/core/v1/config/semif"

export type SemifMode = "auto" | "lazy" | "off"

export type SemifOptions = {
  mode?: string
  modelPath?: string
  serverPath?: string
  model?: string
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
  model?: string
  modelPath?: string
  serverPath?: string
}

export type SemifPathStatus = {
  modelExists: boolean
  serverExists: boolean
  modelPath?: string
  serverPath?: string
}

const DEFAULTS = {
  mode: "auto" as SemifMode,
  host: "127.0.0.1",
  port: 8817,
  contextSize: 2048,
  nProbs: 256,
  loadTimeoutMs: 60000,
  cacheSize: 128,
}

// Leave one core free for the host process; cap so the sidecar never starves the UI.
function defaultThreads(): number {
  return Math.max(1, Math.min(8, availableParallelism() - 1))
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

  // Paths are supplied by options, env, or (in later phases) acquisition/packaging.
  // There are deliberately no author-machine fallbacks here; existence is checked by assertSemifPaths.
  const modelPath = readString(options.modelPath) ?? readString(env.SEMIF_MODEL_PATH)
  const serverPath = readString(options.serverPath) ?? readString(env.SEMIF_SERVER_PATH)
  const model = readString(options.model) ?? readString(env.SEMIF_MODEL)

  const host = readString(options.host) ?? readString(env.SEMIF_HOST) ?? DEFAULTS.host
  const port = requireInt(readInt(options.port) ?? readInt(env.SEMIF_PORT), DEFAULTS.port, "port", 1, 65535)
  const threads = requireInt(
    readInt(options.threads) ?? readInt(env.SEMIF_THREADS),
    defaultThreads(),
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
    model,
    modelPath,
    serverPath,
  }
}

// Bridge the native core config block (snake_case, Effect Schema) into the
// runtime options this module consumes. Env vars still fill gaps via
// parseSemifOptions; an absent semif block means the feature is disabled.
export function fromConfig(semif?: ConfigSemifV1.Info): SemifResolved {
  if (!semif) return parseSemifOptions({ mode: "off" })
  return parseSemifOptions({
    mode: semif.mode,
    host: semif.host,
    port: semif.port,
    threads: semif.threads,
    contextSize: semif.contextSize,
    nProbs: semif.nProbs,
    cacheSize: semif.cacheSize,
    model: semif.model,
    modelPath: semif.model_path,
    serverPath: semif.server_path,
  })
}

// Standard on-disk layout for a globally-installed SemIf runtime, e.g. under
// the opencode data directory: `<base>/semif/{models,bin}`.
export function semifInstallDir(baseDir: string): string {
  return join(baseDir, "semif")
}

export function defaultServerName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "llama-server.exe" : "llama-server"
}

const normalizeHint = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "")

async function findModelFile(modelsDir: string, hint?: string): Promise<string | undefined> {
  const entries = await readdir(modelsDir).catch(() => [] as string[])
  const ggufs = entries.filter((name) => name.toLowerCase().endsWith(".gguf"))
  if (ggufs.length === 0) return undefined
  if (hint) {
    const needle = normalizeHint(hint)
    const match = ggufs.find((name) => normalizeHint(name).includes(needle))
    if (match) return join(modelsDir, match)
  }
  // Only auto-pick when there is a single unambiguous candidate.
  return ggufs.length === 1 ? join(modelsDir, ggufs[0]!) : undefined
}

async function installedServerPath(binDir: string): Promise<string | undefined> {
  const candidate = join(binDir, defaultServerName())
  const exists = await stat(candidate).then(
    () => true,
    () => false,
  )
  return exists ? candidate : undefined
}

// Fill model/server paths from the standard global install location when the
// config leaves them unset. Explicit config or env paths always win.
export async function resolveInstalledPaths(cfg: SemifResolved, baseDir: string): Promise<SemifResolved> {
  const dir = semifInstallDir(baseDir)
  const modelPath = cfg.modelPath ?? (await findModelFile(join(dir, "models"), cfg.model))
  const serverPath = cfg.serverPath ?? (await installedServerPath(join(dir, "bin")))
  return { ...cfg, modelPath, serverPath }
}

async function pathExists(path: string | undefined): Promise<boolean> {
  if (!path) return false
  return stat(path).then(
    () => true,
    () => false,
  )
}

export async function checkSemifPaths(cfg: SemifResolved): Promise<SemifPathStatus> {
  const [modelExists, serverExists] = await Promise.all([pathExists(cfg.modelPath), pathExists(cfg.serverPath)])
  return { modelExists, serverExists, modelPath: cfg.modelPath, serverPath: cfg.serverPath }
}

export async function assertSemifPaths(cfg: SemifResolved): Promise<void> {
  if (!cfg.modelPath) throw new Error("semif: modelPath is not configured (set it via options or SEMIF_MODEL_PATH)")
  if (!cfg.serverPath) throw new Error("semif: serverPath is not configured (set it via options or SEMIF_SERVER_PATH)")
  const status = await checkSemifPaths(cfg)
  if (!status.modelExists) throw new Error(`semif: model file not found at ${cfg.modelPath}`)
  if (!status.serverExists) throw new Error(`semif: llama-server binary not found at ${cfg.serverPath}`)
}

export * as SemifConfig from "./config"
