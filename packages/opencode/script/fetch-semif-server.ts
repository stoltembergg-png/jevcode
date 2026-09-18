#!/usr/bin/env bun
//
// Vendorizes the llama.cpp `llama-server` runtime used by SemIf so the binary
// always travels inside the Tauri bundle and is never downloaded at runtime.
//
//   upstream: https://github.com/ggml-org/llama.cpp/releases/download/<tag>/<asset>
//   mirror:   NEXTCODE_SEMIF_MIRROR (a URL to our own mirrored asset), tried first
//
// The archives carry `llama-server` plus its shared libraries (DLLs on Windows,
// dylibs on macOS). All libraries are staged together so the loader can resolve
// them. Staging layout:
//
//   packages/desktop/src-tauri/binaries/llama-server-<triple>[.exe]  (Tauri externalBin)
//   packages/desktop/src-tauri/semif/<libs>                          (Tauri resources, "semif")
//
// The lockfile is authoritative: bytes and sha256 are verified on every run, and
// the download falls back from the mirror to the upstream release.
//
// Usage:
//   bun script/fetch-semif-server.ts [--target <triple>] [--force] [--download-only]

import { $ } from "bun"
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"

const UPSTREAM_BASE = "https://github.com/ggml-org/llama.cpp/releases/download"

interface TargetLock {
  asset: string
  bytes: number
  sha256: string
}

interface Lockfile {
  tag: string
  targets: Record<string, TargetLock>
}

interface Marker {
  tag: string
  target: string
  asset: string
  sha256: string
  staged: { path: string; bytes: number }[]
}

interface ExtractedFile {
  name: string
  read: () => Promise<Uint8Array>
}

const repo = path.resolve(import.meta.dir, "../../..")
const tauri = path.join(repo, "packages/desktop/src-tauri")
const binariesDir = path.join(tauri, "binaries")
const libsDir = path.join(tauri, "semif")
const cacheDir = path.join(tauri, ".semif-cache")
const lockPath = path.join(import.meta.dir, "semif-server.lock.json")

const HOST_TARGETS: Record<string, string> = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
}

interface StageOptions {
  target?: string
  force?: boolean
  downloadOnly?: boolean
}

export async function stageSemifServer(options: StageOptions = {}) {
  const lock = (await Bun.file(lockPath).json()) as Lockfile
  const target = options.target ?? hostTarget()
  const entry = lock.targets[target]
  if (!entry) {
    throw new Error(`target ${target} is not pinned in ${path.relative(repo, lockPath)}`)
  }

  const isZip = entry.asset.endsWith(".zip")
  const executable = isZip ? "llama-server.exe" : "llama-server"
  const stagedServer = path.join(binariesDir, `llama-server-${target}${isZip ? ".exe" : ""}`)
  const markerPath = path.join(cacheDir, `${target}.json`)

  if (!options.force && (await isUpToDate(markerPath, lock.tag, entry))) {
    console.log(`llama-server for ${target} is already staged: ${stagedServer}`)
    return { target, stagedServer, libsDir, archive: path.join(cacheDir, entry.asset), skipped: true }
  }

  mkdirSync(cacheDir, { recursive: true })
  mkdirSync(binariesDir, { recursive: true })

  const archive = await ensureArchive(lock.tag, entry)
  console.log(`archive verified: ${archive} (${entry.bytes} bytes)`)

  if (options.downloadOnly) {
    return { target, stagedServer, libsDir, archive, skipped: false }
  }

  const files = await extract(archive, entry.asset)
  const binary = files.find((file) => file.name === executable)
  if (!binary) throw new Error(`archive ${entry.asset} does not contain ${executable}`)

  const libraries = files.filter((file) => file.name !== executable)
  rmSync(libsDir, { recursive: true, force: true })
  mkdirSync(libsDir, { recursive: true })

  const serverBytes = await binary.read()
  await Bun.write(stagedServer, serverBytes)
  const staged: Marker["staged"] = [{ path: stagedServer, bytes: serverBytes.byteLength }]
  for (const library of libraries) {
    const destination = path.join(libsDir, library.name)
    const bytes = await library.read()
    await Bun.write(destination, bytes)
    staged.push({ path: destination, bytes: bytes.byteLength })
  }

  if (!isZip) {
    const result = await $`chmod +x ${stagedServer}`.quiet().nothrow()
    if (result.exitCode !== 0) throw new Error(`could not mark ${stagedServer} executable`)
  }

  const marker: Marker = { tag: lock.tag, target, asset: entry.asset, sha256: entry.sha256, staged }
  await Bun.write(markerPath, `${JSON.stringify(marker, null, 2)}\n`)

  console.log(`staged server: ${stagedServer} (${serverBytes.byteLength} bytes)`)
  console.log(`staged ${libraries.length} librar${libraries.length === 1 ? "y" : "ies"} in ${libsDir}`)
  return { target, stagedServer, libsDir, archive, skipped: false }
}

function hostTarget(): string {
  const target = HOST_TARGETS[`${process.platform}-${process.arch}`]
  if (!target) {
    throw new Error(
      `no llama-server target for ${process.platform}-${process.arch}; supported: ${Object.values(HOST_TARGETS).join(", ")}`,
    )
  }
  return target
}

async function isUpToDate(markerPath: string, tag: string, entry: TargetLock): Promise<boolean> {
  const marker = (await Bun.file(markerPath)
    .json()
    .catch(() => undefined)) as Marker | undefined
  if (!marker || marker.tag !== tag || marker.sha256 !== entry.sha256) return false
  return marker.staged.every((file) => existsSync(file.path) && statSync(file.path).size === file.bytes)
}

async function ensureArchive(tag: string, entry: TargetLock): Promise<string> {
  const archive = path.join(cacheDir, entry.asset)
  if (existsSync(archive)) {
    const cached = await inspect(archive)
    if (cached.bytes === entry.bytes && cached.sha256 === entry.sha256) return archive
    console.warn(`cached archive does not match the lock, re-downloading: ${archive}`)
    rmSync(archive, { force: true })
  }

  const candidates = [process.env.NEXTCODE_SEMIF_MIRROR, `${UPSTREAM_BASE}/${tag}/${entry.asset}`].filter(
    (url): url is string => Boolean(url),
  )

  let lastError = `no download source available for ${entry.asset}`
  for (const url of candidates) {
    console.log(`downloading ${url}`)
    const response = await fetch(url, { redirect: "follow" }).catch(() => undefined)
    if (!response?.ok) {
      lastError = `download failed (${response ? response.status : "network error"}): ${url}`
      console.warn(lastError)
      continue
    }
    await Bun.write(archive, response)
    const actual = await inspect(archive)
    if (actual.bytes === entry.bytes && actual.sha256 === entry.sha256) return archive
    lastError =
      `archive mismatch for ${entry.asset} from ${url}\n` +
      `  expected bytes=${entry.bytes} sha256=${entry.sha256}\n` +
      `  actual   bytes=${actual.bytes} sha256=${actual.sha256}`
    console.warn(lastError)
    rmSync(archive, { force: true })
  }
  throw new Error(lastError)
}

async function inspect(file: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(bytes)
  return { bytes: bytes.byteLength, sha256: hasher.digest("hex") }
}

async function extract(archive: string, asset: string): Promise<ExtractedFile[]> {
  if (asset.endsWith(".zip")) return extractZip(archive)
  return extractTarGz(archive)
}

async function extractZip(archive: string): Promise<ExtractedFile[]> {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await Bun.file(archive).arrayBuffer())))
  const entries = await reader.getEntries()
  const files: ExtractedFile[] = []
  for (const entry of entries) {
    if (!("getData" in entry)) continue
    const name = path.basename(entry.filename)
    if (!name.endsWith(".dll") && name !== "llama-server.exe") continue
    const data = await entry.getData(new Uint8ArrayWriter())
    files.push({ name, read: async () => data })
  }
  await reader.close()
  return files
}

async function extractTarGz(archive: string): Promise<ExtractedFile[]> {
  const work = path.join(cacheDir, "extract")
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const result = await $`tar -xzf ${archive} -C ${work}`.quiet().nothrow()
  if (result.exitCode !== 0) {
    throw new Error(`tar failed (${result.exitCode}): ${result.stderr.toString().trim()}`)
  }
  const roots = readdirSync(work).filter((name) => !name.startsWith("."))
  const root = roots.length === 1 ? path.join(work, roots[0]) : work
  const files: ExtractedFile[] = []
  for (const name of readdirSync(root)) {
    if (!neededDylib(name)) continue
    const source = path.join(root, name)
    if (!statSync(source).isFile()) continue
    files.push({ name, read: async () => new Uint8Array(await Bun.file(source).arrayBuffer()) })
  }
  return files
}

/// The macOS archive versions its dylibs (`libllama.0.4.1.dylib`) and links every
/// consumer against the `.0` name (`@rpath/libllama.0.dylib`), shipping the
/// unversioned names only as symlinks. A load-command scan of the whole archive
/// shows every dependency resolves through the `.0` name, so staging those names
/// (plus the unversioned server impl) is enough and avoids duplicating each
/// library behind three names. Our staging dereferences the symlinks into real
/// files, because the bundle copy does not preserve links.
function neededDylib(name: string): boolean {
  return name === "llama-server" || name === "libllama-server-impl.dylib" || name.endsWith(".0.dylib")
}

function parseArgs(argv: string[]): StageOptions {
  const options: StageOptions = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--force") options.force = true
    else if (arg === "--download-only") options.downloadOnly = true
    else if (arg === "--target") options.target = argv[++index]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

if (import.meta.main) {
  stageSemifServer(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
