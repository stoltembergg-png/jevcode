import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { dirname } from "node:path"
import { assertSemifPaths, type SemifResolved } from "./config"

export type SidecarPhase = "idle" | "starting" | "ready" | "failed" | "disposed"

export type SidecarStatus = {
  running: boolean
  adopted: boolean
  spawned: boolean
  url: string
  host: string
  port: number
  modelPath: string
  pid: number | undefined
  phase: SidecarPhase
  error: string | undefined
}

export type Sidecar = {
  ensure(): Promise<{ url: string; adopted: boolean }>
  ready: Promise<void>
  status(): SidecarStatus
  dispose(): Promise<void>
}

const baseUrl = (host: string, port: number) => `http://${host}:${port}`

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()

async function requestJson(url: string, init?: RequestInit, timeoutMs = 1500): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("semif: request timeout")), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function pingHealth(host: string, port: number): Promise<boolean> {
  const body = await requestJson(`${baseUrl(host, port)}/health`)
  return body !== undefined
}

// Returns "match" when a ready llama-server already serves the configured model,
// "other" when a healthy server serves a different model, "none" otherwise.
async function probeModel(host: string, port: number, modelPath: string): Promise<"match" | "other" | "none"> {
  const health = await requestJson(`${baseUrl(host, port)}/health`)
  if (health === undefined) return "none"
  const props = await requestJson(`${baseUrl(host, port)}/props`)
  const served = readModelPath(props)
  if (served && normalizePath(served) === normalizePath(modelPath)) return "match"
  return "other"
}

function readModelPath(props: unknown): string | undefined {
  if (typeof props !== "object" || props === null) return undefined
  const record = props as Record<string, unknown>
  for (const key of ["model_path", "modelPath"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim() !== "") return value
  }
  const defaults = record.default_generation_settings
  if (typeof defaults === "object" && defaults !== null) {
    const nested = (defaults as Record<string, unknown>).model
    if (typeof nested === "string" && nested.trim() !== "") return nested
  }
  return undefined
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  child.kill("SIGTERM")
  const terminated = await Promise.race([exited.then(() => true), delay(3000).then(() => false)])
  if (terminated) return
  child.kill("SIGKILL")
  await Promise.race([exited, delay(2000)])
}

export function createSidecar(cfg: SemifResolved): Sidecar {
  let child: ChildProcess | undefined
  let spawned = false
  let adopted = false
  let currentPort = cfg.port
  let url = baseUrl(cfg.host, cfg.port)
  let phase: SidecarPhase = "idle"
  let lastError: string | undefined
  let disposeRequested = false
  let ensurePromise: Promise<{ url: string; adopted: boolean }> | undefined
  let readySettled = false
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const settleReady = () => {
    if (readySettled) return
    readySettled = true
    resolveReady()
  }

  async function findFreePort(start: number): Promise<number> {
    for (let delta = 1; delta <= 10; delta++) {
      const candidate = start + delta
      if (candidate > 65535) break
      if (!(await pingHealth(cfg.host, candidate))) return candidate
    }
    throw new Error(`semif: no free llama-server port found in ${start + 1}..${start + 10}`)
  }

  function waitForHealth(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + cfg.loadTimeoutMs
      let settled = false
      let timer: ReturnType<typeof setInterval> | undefined
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (timer) clearInterval(timer)
        if (error) reject(error)
        else resolve()
      }
      const tick = async () => {
        if (disposeRequested) return finish(new Error("semif: sidecar was disposed while loading"))
        if (child && child.exitCode !== null) {
          return finish(new Error(`semif: llama-server exited early with code ${child.exitCode}`))
        }
        if (Date.now() > deadline) {
          return finish(new Error(`semif: llama-server did not become ready within ${cfg.loadTimeoutMs}ms at ${url}`))
        }
        if (await pingHealth(cfg.host, port)) finish()
      }
      timer = setInterval(() => void tick(), 250)
      void tick()
    })
  }

  async function spawnServer(port: number): Promise<void> {
    await assertSemifPaths(cfg)
    currentPort = port
    url = baseUrl(cfg.host, port)
    const next = spawn(
      cfg.serverPath,
      [
        "-m",
        cfg.modelPath,
        "--host",
        cfg.host,
        "--port",
        String(port),
        "--threads",
        String(cfg.threads),
        "-c",
        String(cfg.contextSize),
        "--no-webui",
        "--parallel",
        "1",
      ],
      { stdio: "ignore", cwd: dirname(cfg.serverPath), windowsHide: true },
    )
    child = next
    spawned = true
    await waitForHealth(port)
  }

  async function start(): Promise<{ url: string; adopted: boolean }> {
    phase = "starting"
    lastError = undefined
    const probe = await probeModel(cfg.host, cfg.port, cfg.modelPath)
    if (probe === "match") {
      adopted = true
      spawned = false
      currentPort = cfg.port
      url = baseUrl(cfg.host, cfg.port)
    } else {
      const port = probe === "other" ? await findFreePort(cfg.port) : cfg.port
      await spawnServer(port)
    }
    phase = "ready"
    settleReady()
    return { url, adopted }
  }

  function ensure(): Promise<{ url: string; adopted: boolean }> {
    if (phase === "ready") return Promise.resolve({ url, adopted })
    if (phase === "disposed") return Promise.reject(new Error("semif: sidecar already disposed"))
    if (!ensurePromise) {
      ensurePromise = start().catch((error: unknown) => {
        phase = "failed"
        lastError = errorMessage(error)
        ensurePromise = undefined
        throw error
      })
    }
    return ensurePromise
  }

  function status(): SidecarStatus {
    const alive = adopted || (child !== undefined && child.exitCode === null && child.signalCode === null)
    return {
      running: phase === "ready" && alive,
      adopted,
      spawned,
      url,
      host: cfg.host,
      port: currentPort,
      modelPath: cfg.modelPath,
      pid: child?.pid,
      phase,
      error: lastError,
    }
  }

  async function dispose(): Promise<void> {
    if (phase === "disposed") return
    phase = "disposed"
    disposeRequested = true
    ensurePromise = undefined
    const current = child
    child = undefined
    // Only kill processes this plugin spawned; never kill an adopted external server.
    if (current && spawned) await killChild(current)
    spawned = false
    adopted = false
    settleReady()
  }

  return { ensure, ready, status, dispose }
}

export * as SemifEngine from "./engine"
