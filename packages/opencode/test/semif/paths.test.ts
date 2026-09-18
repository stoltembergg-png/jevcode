import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import {
  SERVER_ENV,
  SERVER_ENV_FALLBACK,
  downloadsRoot,
  modelDir,
  modelPath,
  partPath,
  resolveModelPath,
  resolveServerPath,
} from "../../src/semif/paths"

const HASH = "a4d000c7064bd3b2e42c6845836286a899a4e79cf1791da1a6797b58d575957d"

describe("semif paths", () => {
  test("server path precedence is config > env > dev", () => {
    const dev = import.meta.path
    expect(
      resolveServerPath({
        configPath: "/cfg/llama-server",
        env: { [SERVER_ENV]: "/env/llama-server" },
        devFallback: dev,
      }),
    ).toBe("/cfg/llama-server")
    expect(resolveServerPath({ env: { [SERVER_ENV]: "/env/llama-server" }, devFallback: dev })).toBe(
      "/env/llama-server",
    )
    expect(resolveServerPath({ env: { [SERVER_ENV_FALLBACK]: "/legacy/llama-server" }, devFallback: dev })).toBe(
      "/legacy/llama-server",
    )
    expect(resolveServerPath({ env: {}, devFallback: dev })).toBe(dev)
  })

  test("server path is absent without error when nothing resolves or exists", () => {
    expect(resolveServerPath({ env: {}, devFallback: path.join(Global.Path.tmp, "semif-missing-server") })).toBe(
      undefined,
    )
    expect(resolveServerPath({ env: {} })).toBe(undefined)
  })

  test("blank config and env values are treated as absent", () => {
    expect(resolveServerPath({ configPath: "   ", env: {}, devFallback: import.meta.path })).toBe(import.meta.path)
    expect(resolveServerPath({ env: { [SERVER_ENV]: "  " }, devFallback: import.meta.path })).toBe(import.meta.path)
  })

  test("model path prefers config over the hash registry", () => {
    expect(resolveModelPath({ configPath: "/models/custom.gguf", sha256: HASH, filename: "LFM2.gguf" })).toBe(
      "/models/custom.gguf",
    )
    expect(resolveModelPath({ sha256: HASH, filename: "LFM2.gguf" })).toBe(modelPath(HASH, "LFM2.gguf"))
  })

  test("registry and cache layouts are global and hash-keyed", () => {
    expect(modelDir(HASH)).toBe(path.join(Global.Path.data, "semif", "models", HASH.slice(0, 12)))
    expect(modelPath(HASH, "LFM2-350M-Q4_K_M.gguf")).toBe(
      path.join(Global.Path.data, "semif", "models", HASH.slice(0, 12), "LFM2-350M-Q4_K_M.gguf"),
    )
    expect(downloadsRoot()).toBe(path.join(Global.Path.cache, "semif", "downloads"))
    expect(partPath(HASH)).toBe(path.join(Global.Path.cache, "semif", "downloads", `${HASH}.part`))
  })
})
