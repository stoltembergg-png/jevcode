import { describe, expect, test } from "bun:test"
import { authTokenFromCredentials } from "./server"
import { compactStorage, fetchStorageStatus, formatBytes } from "./server-storage"

const space = (value: string) => value.replace(/[\u00a0\u202f]/g, " ")

describe("formatBytes", () => {
  test("formats sizes with locale-aware units", () => {
    expect(space(formatBytes(0, "en"))).toBe("0B")
    expect(space(formatBytes(512, "en"))).toBe("512B")
    expect(space(formatBytes(1024, "en"))).toBe("1kB")
    expect(space(formatBytes(1024 * 1024 * 1.5, "en"))).toBe("1.5MB")
  })
})

describe("server storage requests", () => {
  test("fetches status with basic auth", async () => {
    const calls: { input: unknown; init: RequestInit | undefined }[] = []
    const fake = (async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ fileBytes: 10, tables: [] }), { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const status = await fetchStorageStatus({
      server: { url: "http://localhost:4096", username: "opencode", password: "secret" },
      fetch: fake,
    })

    expect(status.fileBytes).toBe(10)
    expect(String(calls[0].input)).toBe("http://localhost:4096/sync/storage")
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
      `Basic ${authTokenFromCredentials({ username: "opencode", password: "secret" })}`,
    )
  })

  test("compacts with vacuum and a json body", async () => {
    const calls: { input: unknown; init: RequestInit | undefined }[] = []
    const fake = (async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ done: true, fileBytes: 8 }), { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const result = await compactStorage({
      server: { url: "http://localhost:4096", password: "secret" },
      fetch: fake,
    })

    expect(result).toEqual({ done: true, fileBytes: 8 })
    expect(String(calls[0].input)).toBe("http://localhost:4096/sync/compact")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe('{"vacuum":true}')
    expect(new Headers(calls[0].init?.headers).get("content-type")).toBe("application/json")
  })
})
