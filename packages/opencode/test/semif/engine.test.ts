import { describe, expect, test } from "bun:test"
import { parseSemifOptions } from "../../src/semif/config"
import { createSidecar } from "../../src/semif/engine"

describe("semif engine", () => {
  test("adopts an external server already serving the configured model", async () => {
    const modelPath = "/models/LFM2-350M-Q4_K_M.gguf"
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/health") return Response.json({})
        if (url.pathname === "/props") return Response.json({ model_path: modelPath })
        return new Response("not found", { status: 404 })
      },
    })
    try {
      const sidecar = createSidecar(
        parseSemifOptions({
          mode: "lazy",
          host: "127.0.0.1",
          port: server.port,
          modelPath,
          serverPath: "/nonexistent/llama-server",
        }),
      )
      const result = await sidecar.ensure()
      expect(result.adopted).toBe(true)
      expect(result.url).toBe(`http://127.0.0.1:${server.port}`)

      const status = sidecar.status()
      expect(status.adopted).toBe(true)
      expect(status.spawned).toBe(false)
      expect(status.running).toBe(true)
      expect(status.pid).toBeUndefined()

      // Disposing must never kill a server this sidecar did not spawn.
      await sidecar.dispose()
      expect((await fetch(`http://127.0.0.1:${server.port}/health`)).ok).toBe(true)
    } finally {
      await server.stop(true)
    }
  })

  test("ensure rejects when it must spawn but paths are not installed", async () => {
    const sidecar = createSidecar(
      parseSemifOptions({
        mode: "lazy",
        host: "127.0.0.1",
        port: 59_999,
        modelPath: "/does/not/exist.gguf",
        serverPath: "/does/not/exist/llama-server",
      }),
    )
    await expect(sidecar.ensure()).rejects.toThrow(/model file not found|not configured/)
    expect(sidecar.status().phase).toBe("failed")
  })
})
