#!/usr/bin/env bun
//
// Stages the compiled opencode binary as the Tauri sidecar for the current Rust
// target: packages/opencode/dist/<platform>/bin/opencode
//   -> packages/desktop/src-tauri/binaries/opencode-cli-<rust-triple>[.exe]
//
// Build the binary first (from packages/opencode): bun run build --single

import { $ } from "bun"
import path from "node:path"
import { copyFileSync, existsSync, mkdirSync } from "node:fs"

const desktop = path.resolve(import.meta.dir, "..")
const repo = path.resolve(desktop, "../..")

const PLATFORM: Record<string, string> = {
  "aarch64-apple-darwin": "opencode-darwin-arm64",
  "x86_64-apple-darwin": "opencode-darwin-x64",
  "aarch64-pc-windows-msvc": "opencode-windows-arm64",
  "x86_64-pc-windows-msvc": "opencode-windows-x64",
  "aarch64-unknown-linux-gnu": "opencode-linux-arm64",
  "x86_64-unknown-linux-gnu": "opencode-linux-x64",
}

const host = (await $`rustc -vV`.text()).match(/^host: (\S+)/m)?.[1]
if (!host) throw new Error("could not resolve the Rust host triple (is rustup installed?)")
const platform = PLATFORM[host]
if (!platform) throw new Error(`no opencode build target mapped for ${host}`)

const exe = process.platform === "win32" ? ".exe" : ""
const source = path.join(repo, "packages/opencode/dist", platform, "bin", `opencode${exe}`)
if (!existsSync(source)) {
  console.error(`sidecar binary not found: ${source}\nbuild it first: (cd packages/opencode && bun run build --single)`)
  process.exit(1)
}

const destDir = path.join(desktop, "src-tauri/binaries")
mkdirSync(destDir, { recursive: true })
const dest = path.join(destDir, `opencode-cli-${host}${exe}`)
copyFileSync(source, dest)
console.log(`sidecar staged: ${dest}`)

// `frontendDist` points at src-tauri/web-dist, which must exist before Tauri
// compiles. Build the renderer on demand so a plain `cargo build` never fails on
// a missing path.
if (!existsSync(path.join(desktop, "src-tauri/web-dist/index.html"))) {
  console.log("renderer assets missing: building with vite.tauri.config.ts")
  const built = await $`bun x vite build --config vite.tauri.config.ts`.cwd(desktop).nothrow()
  if (built.exitCode !== 0) {
    console.error(built.stderr.toString())
    process.exit(1)
  }
  console.log("renderer assets built")
}
