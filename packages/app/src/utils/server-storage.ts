import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

export const STORAGE_PATH = "/sync/storage"
export const COMPACT_PATH = "/sync/compact"

export type StorageTable = { name: string; bytes: number }
export type StorageStatus = { fileBytes: number; tables: StorageTable[] }
export type CompactResult = { done: boolean; fileBytes: number }

const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const

export function formatBytes(bytes: number, locale: string) {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  const exponent = safe < 1024 ? 0 : Math.min(Math.floor(Math.log(safe) / Math.log(1024)), units.length - 1)
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[exponent],
    unitDisplay: "narrow",
    maximumFractionDigits: exponent === 0 ? 0 : 1,
  }).format(safe / 1024 ** exponent)
}

function authHeaders(server: ServerConnection.HttpBase) {
  if (!server.password) return
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
  }
}

export async function fetchStorageStatus(input: {
  server: ServerConnection.HttpBase
  fetch: typeof globalThis.fetch
  signal?: AbortSignal
}): Promise<StorageStatus> {
  const response = await input.fetch(new URL(STORAGE_PATH, input.server.url), {
    headers: authHeaders(input.server),
    signal: input.signal,
  })
  if (!response.ok) throw new Error(`Storage status request failed: ${response.status}`)
  return (await response.json()) as StorageStatus
}

export async function compactStorage(input: {
  server: ServerConnection.HttpBase
  fetch: typeof globalThis.fetch
  signal?: AbortSignal
}): Promise<CompactResult> {
  const response = await input.fetch(new URL(COMPACT_PATH, input.server.url), {
    method: "POST",
    headers: { ...authHeaders(input.server), "content-type": "application/json" },
    body: JSON.stringify({ vacuum: true }),
    signal: input.signal,
  })
  if (!response.ok) throw new Error(`Storage compact request failed: ${response.status}`)
  return (await response.json()) as CompactResult
}
