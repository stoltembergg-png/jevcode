import { describe, expect, test } from "bun:test"
import { availableParallelism } from "node:os"
import { assertSemifPaths, checkSemifPaths, parseSemifOptions } from "../../src/semif/config"

const ENV_KEYS = [
  "SEMIF_MODE",
  "SEMIF_MODEL_PATH",
  "SEMIF_SERVER_PATH",
  "SEMIF_HOST",
  "SEMIF_PORT",
  "SEMIF_THREADS",
  "SEMIF_CONTEXT_SIZE",
  "SEMIF_NPROBS",
  "SEMIF_LOAD_TIMEOUT_MS",
  "SEMIF_CACHE_SIZE",
] as const

for (const key of ENV_KEYS) delete process.env[key]

async function withEnv(values: Record<string, string>, fn: () => void | Promise<void>): Promise<void> {
  const previous = ENV_KEYS.map((key) => [key, process.env[key]] as const)
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  try {
    await fn()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const expectedThreads = Math.max(1, Math.min(8, availableParallelism() - 1))

describe("semif config", () => {
  test("applies portable defaults without author-machine paths", async () => {
    await withEnv({}, () => {
      const cfg = parseSemifOptions()
      expect(cfg.mode).toBe("auto")
      expect(cfg.host).toBe("127.0.0.1")
      expect(cfg.port).toBe(8817)
      expect(cfg.threads).toBe(expectedThreads)
      expect(cfg.contextSize).toBe(2048)
      expect(cfg.nProbs).toBe(256)
      expect(cfg.loadTimeoutMs).toBe(120000)
      expect(cfg.cacheSize).toBe(128)
      expect(cfg.modelPath).toBeUndefined()
      expect(cfg.serverPath).toBeUndefined()
    })
  })

  test("options override defaults", async () => {
    await withEnv({}, () => {
      const cfg = parseSemifOptions({
        mode: "lazy",
        host: "0.0.0.0",
        port: 1234,
        threads: 3,
        contextSize: 4096,
        nProbs: 64,
        loadTimeoutMs: 5000,
        cacheSize: 0,
        modelPath: "/models/LFM2-350M-Q4_K_M.gguf",
        serverPath: "/bin/llama-server",
      })
      expect(cfg.mode).toBe("lazy")
      expect(cfg.host).toBe("0.0.0.0")
      expect(cfg.port).toBe(1234)
      expect(cfg.threads).toBe(3)
      expect(cfg.contextSize).toBe(4096)
      expect(cfg.nProbs).toBe(64)
      expect(cfg.loadTimeoutMs).toBe(5000)
      expect(cfg.cacheSize).toBe(0)
      expect(cfg.modelPath).toBe("/models/LFM2-350M-Q4_K_M.gguf")
      expect(cfg.serverPath).toBe("/bin/llama-server")
    })
  })

  test("env vars fill in and options win", async () => {
    await withEnv(
      {
        SEMIF_MODE: "off",
        SEMIF_MODEL_PATH: "/env/model.gguf",
        SEMIF_SERVER_PATH: "/env/llama-server",
        SEMIF_HOST: "0.0.0.0",
        SEMIF_PORT: "9999",
        SEMIF_THREADS: "2",
        SEMIF_CONTEXT_SIZE: "4096",
        SEMIF_NPROBS: "512",
        SEMIF_LOAD_TIMEOUT_MS: "5000",
        SEMIF_CACHE_SIZE: "16",
      },
      () => {
        const fromEnv = parseSemifOptions()
        expect(fromEnv.mode).toBe("off")
        expect(fromEnv.modelPath).toBe("/env/model.gguf")
        expect(fromEnv.serverPath).toBe("/env/llama-server")
        expect(fromEnv.host).toBe("0.0.0.0")
        expect(fromEnv.port).toBe(9999)
        expect(fromEnv.threads).toBe(2)
        expect(fromEnv.contextSize).toBe(4096)
        expect(fromEnv.nProbs).toBe(512)
        expect(fromEnv.loadTimeoutMs).toBe(5000)
        expect(fromEnv.cacheSize).toBe(16)

        const overridden = parseSemifOptions({
          mode: "lazy",
          port: 4321,
          threads: 7,
          modelPath: "/opt/model.gguf",
        })
        expect(overridden.mode).toBe("lazy")
        expect(overridden.port).toBe(4321)
        expect(overridden.threads).toBe(7)
        expect(overridden.modelPath).toBe("/opt/model.gguf")
        expect(overridden.serverPath).toBe("/env/llama-server")
      },
    )
  })

  test("blank path values are treated as absent", async () => {
    await withEnv({ SEMIF_MODEL_PATH: "   " }, () => {
      expect(parseSemifOptions().modelPath).toBeUndefined()
      expect(parseSemifOptions({ modelPath: "   " }).modelPath).toBeUndefined()
    })
  })

  test("rejects invalid mode and out-of-range numbers", async () => {
    await withEnv({}, () => {
      expect(() => parseSemifOptions({ mode: "sometimes" })).toThrow(/mode must be/)
      expect(() => parseSemifOptions({ port: 70000 })).toThrow(/port must be/)
      expect(() => parseSemifOptions({ port: 0 })).toThrow(/port must be/)
      expect(() => parseSemifOptions({ threads: 0 })).toThrow(/threads must be/)
      expect(() => parseSemifOptions({ nProbs: 8 })).toThrow(/nProbs must be/)
      expect(() => parseSemifOptions({ cacheSize: -1 })).toThrow(/cacheSize must be/)
    })
  })

  test("rejects an invalid SEMIF_MODE env value", async () => {
    await withEnv({ SEMIF_MODE: "always" }, () => {
      expect(() => parseSemifOptions()).toThrow(/mode must be/)
    })
  })

  test("checkSemifPaths reports missing paths without throwing", async () => {
    await withEnv({}, async () => {
      const cfg = parseSemifOptions({ modelPath: "/does/not/exist.gguf", serverPath: "/does/not/exist.exe" })
      const status = await checkSemifPaths(cfg)
      expect(status.modelExists).toBe(false)
      expect(status.serverExists).toBe(false)
      expect(status.modelPath).toBe("/does/not/exist.gguf")
      expect(status.serverPath).toBe("/does/not/exist.exe")
      await expect(assertSemifPaths(cfg)).rejects.toThrow(/model file not found/)
    })
  })

  test("assertSemifPaths rejects when paths are unconfigured", async () => {
    await expect(assertSemifPaths(parseSemifOptions())).rejects.toThrow(/modelPath is not configured/)
  })
})
