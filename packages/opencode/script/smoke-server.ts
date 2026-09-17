#!/usr/bin/env bun
//
// End-to-end smoke test for a compiled `opencode` binary.
//
// A `--version` check only proves the binary starts. It does not prove that server
// startup and PTY I/O survive bundling, which is where a Bun-version mismatch tends
// to break the binary at runtime. This script boots `serve`, waits for `/global/health`,
// then drives a real PTY session over the websocket protocol.
//
// Usage: bun script/smoke-server.ts <path-to-binary>

import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { randomUUID } from "node:crypto"

const decoder = new TextDecoder()

// A meta frame is a 0x00 byte followed by a UTF-8 JSON control payload (absolute cursor).
// Any other frame is raw terminal output. Mirrors packages/core/src/pty/protocol.ts.
function isMetaFrame(frame: Uint8Array) {
  return frame.length > 0 && frame[0] === 0
}

function frameToBytes(data: string | ArrayBuffer | Uint8Array) {
  if (typeof data === "string") return new TextEncoder().encode(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return data
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate a free port")))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function parseJson(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

async function removeTempDir(root: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch {
      await Bun.sleep(250)
    }
  }
  console.error(`smoke-server: warning: could not remove temp dir ${root}`)
}

export async function smokeServer(binaryPath: string): Promise<void> {
  // Compiled Windows binaries are `<name>.exe` while the build script passes the
  // extensionless path.
  if (process.platform === "win32" && !(await Bun.file(binaryPath).exists())) {
    const withExe = `${binaryPath}.exe`
    if (await Bun.file(withExe).exists()) binaryPath = withExe
  }
  if (!(await Bun.file(binaryPath).exists())) throw new Error(`binary not found: ${binaryPath}`)

  // Every XDG root points into our own temp dir so the smoke test never touches real user data.
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-smoke-"))
  const state = path.join(root, "state")
  const data = path.join(root, "data")
  const cache = path.join(root, "cache")
  const config = path.join(root, "config")
  const workspace = path.join(root, "workspace")
  await Promise.all([state, data, cache, config, workspace].map((dir) => mkdir(dir, { recursive: true })))

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const username = "opencode"
  const password = randomUUID()
  const auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64")
  const jsonHeaders = { authorization: auth, "content-type": "application/json" }
  const query = new URLSearchParams({ "location[directory]": workspace }).toString()

  console.log(`smoke-server: starting ${binaryPath} on 127.0.0.1:${port}`)
  const child = Bun.spawn({
    cmd: [binaryPath, "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"],
    env: {
      ...process.env,
      XDG_STATE_HOME: state,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: config,
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const logs: string[] = []
  const drain = (stream: ReadableStream<Uint8Array> | undefined) => {
    if (!stream) return
    void (async () => {
      const reader = stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        logs.push(decoder.decode(value, { stream: true }))
      }
    })()
  }
  drain(child.stdout as ReadableStream<Uint8Array>)
  drain(child.stderr as ReadableStream<Uint8Array>)
  const serverLogs = () => logs.join("").trim().split("\n").slice(-30).join("\n")

  let ptyID: string | undefined
  let ws: WebSocket | undefined
  try {
    // 1. Wait for the HTTP server. Fail fast if the child dies first.
    const healthDeadline = Date.now() + 120_000
    let healthy = false
    while (Date.now() < healthDeadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`server exited before becoming healthy (code ${child.exitCode ?? child.signalCode})\n${serverLogs()}`)
      }
      try {
        const res = await fetch(`${base}/global/health`, {
          headers: { authorization: auth },
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          healthy = true
          break
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error(`/global/health rejected credentials (status ${res.status})`)
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("rejected credentials")) throw error
      }
      await Bun.sleep(500)
    }
    if (!healthy) throw new Error(`timed out after 120s waiting for /global/health\n${serverLogs()}`)
    console.log("smoke-server: server healthy")

    // 2. Create a real PTY and drive it over the websocket protocol.
    const command = process.platform === "win32" ? "cmd.exe" : "sh"
    const created = await fetch(`${base}/api/pty?${query}`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ command, cwd: workspace, title: "smoke-server" }),
    })
    const createdBody = await parseJson(created)
    ptyID = createdBody?.data?.id ?? createdBody?.id
    if (!created.ok || !ptyID) {
      throw new Error(`failed to create PTY (status ${created.status}): ${JSON.stringify(createdBody)}`)
    }
    const ptyPID = createdBody?.data?.pid ?? createdBody?.pid
    console.log(`smoke-server: created PTY ${ptyID} pid=${ptyPID}`)

    const tokenRes = await fetch(`${base}/api/pty/${ptyID}/connect-token?${query}`, {
      method: "POST",
      headers: { ...jsonHeaders, "x-opencode-ticket": "1" },
    })
    const tokenBody = await parseJson(tokenRes)
    const ticket = tokenBody?.data?.ticket ?? tokenBody?.ticket
    if (!tokenRes.ok || !ticket) {
      throw new Error(`failed to mint connect token (status ${tokenRes.status}): ${JSON.stringify(tokenBody)}`)
    }

    const marker = `OPENCODE_PTY_SMOKE_${randomUUID().replaceAll("-", "").slice(0, 12)}`
    const wsParams = new URLSearchParams({
      ticket,
      "location[directory]": workspace,
      cursor: "-1",
    })
    const wsURL = `ws://127.0.0.1:${port}/api/pty/${ptyID}/connect?${wsParams.toString()}`

    const sawMarker = await new Promise<boolean>((resolve, reject) => {
      const output: string[] = []
      const timer = setTimeout(() => {
        reject(new Error(`timed out after 20s waiting for PTY marker\noutput: ${JSON.stringify(output.join("").slice(-2000))}`))
      }, 20_000)
      ws = new WebSocket(wsURL)
      ws.binaryType = "arraybuffer"
      const finish = (value: boolean) => {
        clearTimeout(timer)
        resolve(value)
      }
      ws.addEventListener("open", () => {
        setTimeout(() => ws?.send(`echo ${marker}\r\n`), 500)
      })
      ws.addEventListener("message", (event) => {
        const bytes = frameToBytes(event.data as string | ArrayBuffer)
        if (isMetaFrame(bytes)) return
        output.push(decoder.decode(bytes))
        if (output.join("").includes(marker)) finish(true)
      })
      ws.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("PTY websocket errored before the marker was observed"))
      })
      ws.addEventListener("close", (event) => {
        if (!output.join("").includes(marker)) {
          clearTimeout(timer)
          reject(new Error(`PTY websocket closed early (code ${event.code})\noutput: ${JSON.stringify(output.join("").slice(-2000))}`))
        }
      })
    })
    if (!sawMarker) throw new Error("PTY marker not observed")
    console.log(`smoke-server: PTY round-trip ok (${marker})`)
  } finally {
    if (ws) {
      try {
        ws.close()
      } catch {}
    }
    if (ptyID) {
      try {
        const removed = await fetch(`${base}/api/pty/${ptyID}?${query}`, { method: "DELETE", headers: jsonHeaders })
        console.log(`smoke-server: removed PTY ${ptyID} (status ${removed.status})`)
      } catch {}
    }
    try {
      child.kill("SIGTERM")
    } catch {}
    await Promise.race([child.exited, Bun.sleep(3000)])
    // On Windows a signal-terminated child reports `signalCode` while `exitCode` stays
    // null, so both must be checked to know whether it is still running.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL")
      } catch {}
      await Promise.race([child.exited, Bun.sleep(3000)])
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      console.log(`smoke-server: stopped server pid ${child.pid} (${child.exitCode ?? child.signalCode})`)
    } else {
      console.error(`smoke-server: warning: server pid ${child.pid} did not exit`)
    }
    await removeTempDir(root)
  }
}

if (import.meta.main) {
  const binaryPath = process.argv[2]
  if (!binaryPath) {
    console.error("usage: bun script/smoke-server.ts <path-to-binary>")
    process.exit(2)
  }
  try {
    await smokeServer(binaryPath)
    console.log("smoke-server: PASS")
    process.exit(0)
  } catch (error) {
    console.error("smoke-server: FAIL")
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
