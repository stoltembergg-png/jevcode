// Runtime directory materialization for the llama-server sidecar.
//
// The launcher and its shared libraries must live in the *same directory*. On
// Windows the ggml backend loader scans the directory of the executable for its
// `ggml-*.dll` backends; putting the library directory on `PATH` (or in
// `GGML_BACKEND_PATH`) is not enough. The server starts but reports
// "no backends are loaded" and fails to load the model. The Tauri bundle ships
// the launcher as an `externalBin` next to the app and the libraries as the
// `semif` resource directory, so before spawning we materialize a runtime
// directory holding both.
//
// The directory is content-keyed (launcher name/size plus every library
// name/size) and carries a marker, so a repeated start reuses the same files
// instead of copying again. Hard links are preferred because they are instant
// and share bytes; a byte copy is the cross-volume fallback.

import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, FileSystem, Option, Schema } from "effect"
import { SemifPaths } from "./paths"

const MARKER_NAME = ".runtime.json"
const MARKER_VERSION = 1

const Marker = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Number,
    key: Schema.String,
    files: Schema.Array(Schema.Struct({ name: Schema.String, bytes: Schema.Number })),
  }),
)
const decodeMarker = Schema.decodeUnknownOption(Marker)

export interface RuntimeEntry {
  readonly name: string
  readonly bytes: number
}

export interface MaterializeInput {
  readonly serverPath: string
  readonly libsPath?: string
  // Overrides the `<data>/semif/runtime` root; tests use a scratch directory.
  readonly root?: string
}

export interface Runtime {
  readonly dir: string
  readonly serverPath: string
  readonly materialized: boolean
}

export class RuntimeError extends Schema.TaggedErrorClass<RuntimeError>()("SemifRuntimeError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

// Keys a runtime directory by the launcher and library layout. Names and sizes
// are enough to distinguish vendored builds without reading gigabytes of bytes.
export const runtimeKey = (server: RuntimeEntry, libs: ReadonlyArray<RuntimeEntry>): string => {
  const hasher = createHash("sha256")
  hasher.update(`${server.name}:${server.bytes}`)
  for (const lib of [...libs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hasher.update(`|${lib.name}:${lib.bytes}`)
  }
  return hasher.digest("hex").slice(0, 12)
}

const passthrough = (serverPath: string): Runtime => ({
  dir: path.dirname(serverPath),
  serverPath,
  materialized: false,
})

const directoryEntries = (
  fs: FileSystem.FileSystem,
  dir: string,
): Effect.Effect<RuntimeEntry[], never> =>
  fs.readDirectory(dir).pipe(
    Effect.orElseSucceed(() => [] as string[]),
    Effect.flatMap((names) =>
      Effect.forEach(names, (name) =>
        fs.stat(path.join(dir, name)).pipe(
          Effect.map((info): RuntimeEntry | undefined =>
            info.type === "File" ? { name, bytes: Number(info.size) } : undefined,
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      ),
    ),
    Effect.map((entries) => entries.filter((entry): entry is RuntimeEntry => entry !== undefined)),
  )

const isComplete = (
  fs: FileSystem.FileSystem,
  dir: string,
  entries: ReadonlyArray<RuntimeEntry>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (const entry of entries) {
      const info = yield* fs.stat(path.join(dir, entry.name)).pipe(Effect.orElseSucceed(() => undefined))
      if (!info || info.type !== "File" || Number(info.size) !== entry.bytes) return false
    }
    return true
  })

const place = (
  fs: FileSystem.FileSystem,
  source: string,
  dest: string,
  bytes: number,
): Effect.Effect<void, RuntimeError> =>
  Effect.gen(function* () {
    const existing = yield* fs.stat(dest).pipe(Effect.orElseSucceed(() => undefined))
    if (existing?.type === "File" && Number(existing.size) === bytes) return
    yield* fs.remove(dest, { force: true }).pipe(Effect.orElseSucceed(() => undefined))
    // Hard links are instant and share bytes; a byte copy is the fallback when
    // the source and target do not share a volume.
    yield* fs.link(source, dest).pipe(
      Effect.catch(() => fs.copyFile(source, dest)),
      Effect.mapError((cause) => new RuntimeError({ reason: `semif: cannot place ${dest}: ${cause.message}` })),
    )
    // Hard links share the source's mode; a copy may not carry the executable
    // bit, so restore it explicitly on POSIX. No-op on Windows.
    if (process.platform !== "win32") yield* fs.chmod(dest, 0o755).pipe(Effect.orElseSucceed(() => undefined))
  })

export const materialize = Effect.fn("SemifRuntime.materialize")(function* (input: MaterializeInput) {
  const fs = yield* FileSystem.FileSystem
  const serverName = path.basename(input.serverPath)

  if (!input.libsPath) return passthrough(input.serverPath)
  const libsInfo = yield* fs.stat(input.libsPath).pipe(Effect.orElseSucceed(() => undefined))
  if (libsInfo?.type !== "Directory") return passthrough(input.serverPath)
  const libs = yield* directoryEntries(fs, input.libsPath)
  if (libs.length === 0) return passthrough(input.serverPath)

  const serverInfo = yield* fs.stat(input.serverPath).pipe(
    Effect.mapError(
      (cause) => new RuntimeError({ reason: `semif: cannot stat llama-server at ${input.serverPath}: ${cause.message}` }),
    ),
  )
  const server: RuntimeEntry = { name: serverName, bytes: Number(serverInfo.size) }
  const key = runtimeKey(server, libs)
  const dir = input.root ? path.join(input.root, key) : SemifPaths.runtimeDir(key)
  const target = path.join(dir, serverName)
  const markerPath = path.join(dir, MARKER_NAME)

  const marker = yield* fs.readFileString(markerPath).pipe(Effect.orElseSucceed(() => ""))
  const decoded = decodeMarker(marker)
  const entries = [server, ...libs]
  if (
    Option.isSome(decoded) &&
    decoded.value.version === MARKER_VERSION &&
    decoded.value.key === key &&
    (yield* isComplete(fs, dir, entries))
  ) {
    return { dir, serverPath: target, materialized: false } satisfies Runtime
  }

  yield* fs.makeDirectory(dir, { recursive: true }).pipe(
    Effect.mapError((cause) => new RuntimeError({ reason: `semif: cannot create runtime dir ${dir}: ${cause.message}` })),
  )
  yield* place(fs, input.serverPath, target, server.bytes)
  for (const lib of libs) {
    yield* place(fs, path.join(input.libsPath, lib.name), path.join(dir, lib.name), lib.bytes)
  }
  const next = { version: MARKER_VERSION, key, files: entries }
  yield* fs.writeFileString(markerPath, `${JSON.stringify(next, null, 2)}\n`).pipe(
    Effect.mapError(
      (cause) => new RuntimeError({ reason: `semif: cannot write runtime marker ${markerPath}: ${cause.message}` }),
    ),
  )
  return { dir, serverPath: target, materialized: true } satisfies Runtime
})

export * as SemifRuntime from "./runtime"
