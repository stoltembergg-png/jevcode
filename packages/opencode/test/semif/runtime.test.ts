import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { materialize, runtimeKey } from "../../src/semif/runtime"

const layer = NodeFileSystem.layer

const tmpdir = () => fs.mkdtemp(path.join(os.tmpdir(), "opencode-semif-runtime-"))

async function fixture() {
  const root = await tmpdir()
  const libs = path.join(root, "semif")
  await fs.mkdir(libs, { recursive: true })
  const server = path.join(root, "llama-server.exe")
  await Bun.write(server, "launcher-bytes")
  await Bun.write(path.join(libs, "ggml-base.dll"), new Uint8Array(64).fill(1))
  await Bun.write(path.join(libs, "llama.dll"), new Uint8Array(128).fill(2))
  return { root, libs, server, runtimeRoot: path.join(root, "runtime") }
}

describe("semif runtime materialization", () => {
  test("colocates the launcher and every library in a content-keyed directory", async () => {
    const fixtureDir = await fixture()
    try {
      const result = await Effect.runPromise(
        Effect.provide(
          materialize({
            serverPath: fixtureDir.server,
            libsPath: fixtureDir.libs,
            root: fixtureDir.runtimeRoot,
          }),
          layer,
        ),
      )

      expect(result.materialized).toBe(true)
      expect(result.dir.startsWith(fixtureDir.runtimeRoot)).toBe(true)
      expect(result.serverPath).toBe(path.join(result.dir, path.basename(fixtureDir.server)))
      expect(await Bun.file(result.serverPath).exists()).toBe(true)
      expect(await Bun.file(path.join(result.dir, "ggml-base.dll")).exists()).toBe(true)
      expect(await Bun.file(path.join(result.dir, "llama.dll")).exists()).toBe(true)
      expect(await Bun.file(path.join(result.dir, ".runtime.json")).exists()).toBe(true)
      expect((await fs.stat(result.serverPath)).size).toBe((await fs.stat(fixtureDir.server)).size)
    } finally {
      await fs.rm(fixtureDir.root, { recursive: true, force: true })
    }
  })

  test("is idempotent: a second start reuses the same directory without recopying", async () => {
    const fixtureDir = await fixture()
    try {
      const input = {
        serverPath: fixtureDir.server,
        libsPath: fixtureDir.libs,
        root: fixtureDir.runtimeRoot,
      }
      const first = await Effect.runPromise(Effect.provide(materialize(input), layer))
      const before = await fs.stat(first.serverPath)
      const second = await Effect.runPromise(Effect.provide(materialize(input), layer))

      expect(second.materialized).toBe(false)
      expect(second.dir).toBe(first.dir)
      expect(second.serverPath).toBe(first.serverPath)
      expect((await fs.stat(second.serverPath)).size).toBe(before.size)
    } finally {
      await fs.rm(fixtureDir.root, { recursive: true, force: true })
    }
  })

  test("a changed library layout produces a new runtime directory", async () => {
    const fixtureDir = await fixture()
    try {
      const input = {
        serverPath: fixtureDir.server,
        libsPath: fixtureDir.libs,
        root: fixtureDir.runtimeRoot,
      }
      const first = await Effect.runPromise(Effect.provide(materialize(input), layer))
      await Bun.write(path.join(fixtureDir.libs, "llama.dll"), new Uint8Array(256).fill(2))
      const second = await Effect.runPromise(Effect.provide(materialize(input), layer))

      expect(second.materialized).toBe(true)
      expect(second.dir).not.toBe(first.dir)
    } finally {
      await fs.rm(fixtureDir.root, { recursive: true, force: true })
    }
  })

  test("passes the resolved binary through when no libs directory is supplied", async () => {
    const fixtureDir = await fixture()
    try {
      const result = await Effect.runPromise(
        Effect.provide(materialize({ serverPath: fixtureDir.server }), layer),
      )
      expect(result.materialized).toBe(false)
      expect(result.serverPath).toBe(fixtureDir.server)
      expect(result.dir).toBe(path.dirname(fixtureDir.server))
    } finally {
      await fs.rm(fixtureDir.root, { recursive: true, force: true })
    }
  })

  test("passes through when the libs path does not exist", async () => {
    const fixtureDir = await fixture()
    try {
      const result = await Effect.runPromise(
        Effect.provide(
          materialize({
            serverPath: fixtureDir.server,
            libsPath: path.join(fixtureDir.root, "missing"),
            root: fixtureDir.runtimeRoot,
          }),
          layer,
        ),
      )
      expect(result.materialized).toBe(false)
      expect(result.serverPath).toBe(fixtureDir.server)
    } finally {
      await fs.rm(fixtureDir.root, { recursive: true, force: true })
    }
  })

  test("runtimeKey is order-independent and content-sensitive", () => {
    const server = { name: "llama-server.exe", bytes: 9 }
    const a = { name: "a.dll", bytes: 1 }
    const b = { name: "b.dll", bytes: 2 }
    expect(runtimeKey(server, [a, b])).toBe(runtimeKey(server, [b, a]))
    expect(runtimeKey(server, [a, b])).not.toBe(runtimeKey(server, [{ ...a, bytes: 3 }, b]))
  })
})
