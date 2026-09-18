// Path resolution for the SemIf model and server. There are no author-machine
// paths here: everything derives from `Global.Path` or from configuration and
// environment supplied at runtime.
//
// Layout decisions (global, one model per machine):
//   model      <data>/semif/models/<sha256 first 12>/<filename>
//   partials   <cache>/semif/downloads/<sha256>.part
//
// The model directory is keyed by the first 12 hex characters of the pinned
// sha256, so a different model revision never collides with the current one and
// stale downloads can be garbage-collected by prefix. Partial downloads live in
// cache (not data) because they are disposable and resume-able.

import { existsSync } from "node:fs"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"

export const SERVER_ENV = "NEXTCODE_SEMIF_SERVER_PATH"
export const SERVER_ENV_FALLBACK = "SEMIF_SERVER_PATH"

export function modelsRoot(): string {
  return path.join(Global.Path.data, "semif", "models")
}

export function modelDir(sha256: string): string {
  return path.join(modelsRoot(), sha256.slice(0, 12))
}

export function modelPath(sha256: string, filename: string): string {
  return path.join(modelDir(sha256), filename)
}

export function downloadsRoot(): string {
  return path.join(Global.Path.cache, "semif", "downloads")
}

export function partPath(sha256: string): string {
  return path.join(downloadsRoot(), `${sha256}.part`)
}

export function serverBinaryName(): string {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server"
}

export interface ModelPathInput {
  readonly configPath?: string
  readonly sha256: string
  readonly filename: string
}

// Precedence: explicit config path > registry path derived from the pinned hash.
export function resolveModelPath(input: ModelPathInput): string {
  const configured = readString(input.configPath)
  if (configured) return configured
  return modelPath(input.sha256, input.filename)
}

export interface ServerPathInput {
  readonly configPath?: string
  readonly env?: Record<string, string | undefined>
  readonly devFallback?: string
}

// Precedence: explicit config path > environment > a dev-only sibling of the
// running executable, but only when that sibling actually exists. Absence is not
// an error; callers surface a dedicated error when the server is actually needed.
export function resolveServerPath(input: ServerPathInput = {}): string | undefined {
  const env = input.env ?? process.env
  const configured = readString(input.configPath) ?? readString(env[SERVER_ENV]) ?? readString(env[SERVER_ENV_FALLBACK])
  if (configured) return configured
  const dev = input.devFallback ?? defaultDevServerPath()
  if (dev && existsSync(dev)) return dev
  return undefined
}

function defaultDevServerPath(): string {
  // An unbundled build often stages the runtime next to the current executable.
  // Production shells pass `NEXTCODE_SEMIF_SERVER_PATH` instead, which wins above.
  return path.join(path.dirname(process.execPath), serverBinaryName())
}

function readString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

export * as SemifPaths from "./paths"
