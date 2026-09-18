import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Layer, Effect } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { download, ensure } from "../../src/semif/acquire"

const layer = Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer)

const encoder = new TextEncoder()
const content = encoder.encode("semif-model-payload-".repeat(2048))
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const hash = sha256(content)

const tmpdir = () => fs.mkdtemp(path.join(os.tmpdir(), "opencode-semif-acquire-"))

interface Harness {
  readonly urls: () => string
  readonly ranges: () => (string | null)[]
  readonly stop: () => void
}

function serve(handler: (req: Request) => Response | Promise<Response>): Harness {
  const server = Bun.serve({ port: 0, fetch: handler })
  return {
    urls: () => `http://127.0.0.1:${server.port}/model.gguf`,
    ranges: () => [],
    stop: () => server.stop(true),
  }
}

function modelServer(options: { readonly failFirst?: boolean; readonly payload?: Uint8Array } = {}): Harness {
  const payload = options.payload ?? content
  const digest = sha256(payload)
  let calls = 0
  const ranges: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== "/model.gguf") return new Response("not found", { status: 404 })
      calls += 1
      if (options.failFirst && calls === 1) return new Response("busy", { status: 503 })
      if (req.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": String(payload.byteLength),
            etag: `"${digest}"`,
            "accept-ranges": "bytes",
          },
        })
      }
      const range = req.headers.get("range")
      ranges.push(range)
      if (range) {
        const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
        return new Response(payload.slice(start).buffer as ArrayBuffer, {
          status: 206,
          headers: { "content-range": `bytes ${start}-${payload.byteLength - 1}/${payload.byteLength}` },
        })
      }
      return new Response(payload.slice().buffer as ArrayBuffer, { status: 200 })
    },
  })
  return {
    urls: () => `http://127.0.0.1:${server.port}/model.gguf`,
    ranges: () => ranges,
    stop: () => server.stop(true),
  }
}

describe("semif acquire", () => {
  test("downloads, verifies sha256 and atomically renames the part file", async () => {
    const dir = await tmpdir()
    const server = modelServer()
    const dest = path.join(dir, "LFM2-350M-Q4_K_M.gguf")
    const part = `${dest}.part`
    try {
      const result = await Effect.runPromise(
        Effect.provide(
          download({
            dest,
            part,
            sha256: hash,
            expectedBytes: content.byteLength,
            resolveUrl: () => Effect.succeed(server.urls()),
          }),
          layer,
        ),
      )
      expect(result.resumed).toBe(false)
      expect(result.bytes).toBe(content.byteLength)
      expect(result.sha256).toBe(hash)
      expect(await Bun.file(dest).exists()).toBe(true)
      expect(await Bun.file(part).exists()).toBe(false)
      expect(await Bun.file(dest).text()).toBe(Buffer.from(content).toString())
    } finally {
      server.stop()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("resumes from a partial file with a Range request", async () => {
    const dir = await tmpdir()
    const server = modelServer()
    const dest = path.join(dir, "LFM2-350M-Q4_K_M.gguf")
    const part = `${dest}.part`
    const half = Math.floor(content.byteLength / 2)
    try {
      await Bun.write(part, content.slice(0, half))
      const result = await Effect.runPromise(
        Effect.provide(
          download({
            dest,
            part,
            sha256: hash,
            expectedBytes: content.byteLength,
            resolveUrl: () => Effect.succeed(server.urls()),
          }),
          layer,
        ),
      )
      expect(result.resumed).toBe(true)
      expect(server.ranges().some((range) => range === `bytes=${half}-`)).toBe(true)
      expect(await Bun.file(dest).text()).toBe(Buffer.from(content).toString())
      expect(await Bun.file(part).exists()).toBe(false)
    } finally {
      server.stop()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("rejects a sha256 mismatch and never exposes the final file", async () => {
    const dir = await tmpdir()
    const other = encoder.encode("not-the-model-".repeat(2048))
    const server = modelServer({ payload: content })
    const dest = path.join(dir, "LFM2-350M-Q4_K_M.gguf")
    const part = `${dest}.part`
    try {
      await expect(
        Effect.runPromise(
          Effect.provide(
            download({
              dest,
              part,
              sha256: sha256(other),
              expectedBytes: content.byteLength,
              maxAttempts: 2,
              resolveUrl: () => Effect.succeed(server.urls()),
            }),
            layer,
          ),
        ),
      ).rejects.toThrow(/sha256 mismatch/)
      expect(await Bun.file(dest).exists()).toBe(false)
      expect(await Bun.file(part).exists()).toBe(false)
    } finally {
      server.stop()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("retries after a transient failure", async () => {
    const dir = await tmpdir()
    const server = modelServer({ failFirst: true })
    const dest = path.join(dir, "LFM2-350M-Q4_K_M.gguf")
    const part = `${dest}.part`
    try {
      const result = await Effect.runPromise(
        Effect.provide(
          download({
            dest,
            part,
            sha256: hash,
            expectedBytes: content.byteLength,
            maxAttempts: 3,
            resolveUrl: () => Effect.succeed(server.urls()),
          }),
          layer,
        ),
      )
      expect(result.bytes).toBe(content.byteLength)
      expect(await Bun.file(dest).exists()).toBe(true)
    } finally {
      server.stop()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("never downloads when the policy is not auto", async () => {
    const dir = await tmpdir()
    let calls = 0
    const server = serve(() => {
      calls += 1
      return new Response(content, { status: 200 })
    })
    const dest = path.join(dir, "LFM2-350M-Q4_K_M.gguf")
    const part = `${dest}.part`
    try {
      await expect(
        Effect.runPromise(
          Effect.provide(
            ensure({
              policy: "never",
              dest,
              part,
              sha256: hash,
              expectedBytes: content.byteLength,
              resolveUrl: () => Effect.succeed(server.urls()),
            }),
            layer,
          ),
        ),
      ).rejects.toThrow(/download=never/)
      expect(calls).toBe(0)
      expect(await Bun.file(dest).exists()).toBe(false)
    } finally {
      server.stop()
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
