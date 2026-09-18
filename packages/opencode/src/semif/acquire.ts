// Resumable, verified model acquisition.
//
// Invariants:
//   - The final path is only ever exposed by an atomic rename from the `.part`
//     file, and only after both the byte count and the sha256 match.
//   - The upstream URL is re-resolved on every attempt (the Hugging Face CDN URL
//     expires), so a retry never reuses a stale redirect.
//   - A resume hashes the bytes already on disk before appending, so the digest
//     covers the whole file rather than just the new chunks.
//   - `download: never | manual` never downloads implicitly; only `auto` does.

import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, FileSystem, Ref, Schedule, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Flock } from "@opencode-ai/core/util/flock"
// Importing Global initializes the process-wide Flock root used for cross-process locks.
import "@opencode-ai/core/global"

export type DownloadPolicy = "auto" | "manual" | "never"

export class AcquireError extends Schema.TaggedErrorClass<AcquireError>()("SemifAcquireError", {
  reason: Schema.String,
  retryable: Schema.optional(Schema.Boolean),
}) {
  override get message() {
    return this.reason
  }
}

export interface Progress {
  readonly received: number
  readonly total: number | undefined
}

export interface DownloadInput {
  readonly dest: string
  readonly part: string
  readonly sha256: string
  readonly expectedBytes?: number
  readonly maxAttempts?: number
  readonly onProgress?: (progress: Progress) => void
  readonly resolveUrl: () => Effect.Effect<string, AcquireError>
}

export interface DownloadResult {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly resumed: boolean
  readonly attempts: number
}

export interface EnsureInput extends DownloadInput {
  readonly policy: DownloadPolicy
}

export interface EnsureResult extends Omit<DownloadResult, "resumed" | "attempts"> {
  readonly acquired: boolean
}

const DEFAULT_ATTEMPTS = 4

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const toAcquire = (cause: unknown): AcquireError =>
  cause instanceof AcquireError ? cause : new AcquireError({ reason: message(cause) })

const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AcquireError, R> =>
  effect.pipe(Effect.mapError(toAcquire))

const normalizeEtag = (etag: string | undefined): string | undefined => {
  const value = etag?.trim().replace(/^W\//, "").replace(/^"|"$/g, "")
  return value && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined
}

interface RemoteInfo {
  readonly size?: number
  readonly etag?: string
  readonly acceptsRanges: boolean
}

const inspectRemote = (url: string): Effect.Effect<RemoteInfo | undefined, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const response = yield* http
      .execute(HttpClientRequest.head(url))
      .pipe(Effect.timeout("10 seconds"), Effect.orElseSucceed(() => undefined))
    if (!response) return undefined
    const length = Number(response.headers["content-length"])
    return {
      size: Number.isFinite(length) && length > 0 ? length : undefined,
      etag: normalizeEtag(response.headers["etag"]),
      acceptsRanges: (response.headers["accept-ranges"] ?? "").toLowerCase() !== "none",
    }
  })

const partSize = (part: string): Effect.Effect<number, AcquireError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* wrap(fs.exists(part))
    if (!exists) return 0
    const info = yield* wrap(fs.stat(part))
    return Number(info.size)
  })

const downloadAttempt = Effect.fnUntraced(function* (input: DownloadInput) {
  const fs = yield* FileSystem.FileSystem
  const http = yield* HttpClient.HttpClient
  const url = yield* input.resolveUrl()

  let start = yield* partSize(input.part)
  if (start > 0) {
    const remote = yield* inspectRemote(url)
    // A changed upstream (or a server that cannot serve ranges) invalidates the
    // partial file; restart from zero rather than stitching mismatched bytes.
    if (remote && ((remote.etag && remote.etag !== input.sha256.toLowerCase()) || !remote.acceptsRanges)) {
      yield* wrap(fs.remove(input.part, { force: true }))
      start = 0
    }
  }

  const request = (
    start > 0 ? HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("range", `bytes=${start}-`)) : HttpClientRequest.get(url)
  )
  const response = yield* http.execute(request).pipe(Effect.mapError(toAcquire))
  if (response.status !== 200 && response.status !== 206) {
    return yield* new AcquireError({ reason: `semif: model download returned HTTP ${response.status}` })
  }

  // A resumed request must answer 206. When it answers 200 the server ignored the
  // range and is sending the full body, so discard the partial file and rewrite.
  const resumed = start > 0 && response.status === 206
  if (start > 0 && !resumed) {
    yield* wrap(fs.remove(input.part, { force: true }))
    start = 0
  }

  const length = Number(response.headers["content-length"])
  const total =
    input.expectedBytes ?? (Number.isFinite(length) && length > 0 ? start + length : undefined)

  const hash = createHash("sha256")
  if (resumed) {
    yield* fs
      .stream(input.part, { offset: 0 })
      .pipe(
        Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))),
        wrap,
      )
  }

  let received = start
  input.onProgress?.({ received, total })

  const sink = fs.sink(input.part, { flag: resumed ? "a" : "w" })
  yield* response.stream.pipe(
    Stream.tap((chunk) =>
      Effect.sync(() => {
        hash.update(chunk)
        received += chunk.byteLength
        input.onProgress?.({ received, total })
      }),
    ),
    Stream.run(sink),
    wrap,
  )

  if (input.expectedBytes !== undefined && received !== input.expectedBytes) {
    return yield* new AcquireError({
      reason: `semif: model size mismatch (expected ${input.expectedBytes}, received ${received})`,
    })
  }

  const digest = hash.digest("hex")
  if (digest !== input.sha256.toLowerCase()) {
    // The content is complete but corrupt; drop the partial so the retry starts clean.
    yield* wrap(fs.remove(input.part, { force: true }))
    return yield* new AcquireError({
      reason: `semif: model sha256 mismatch (expected ${input.sha256}, received ${digest})`,
    })
  }

  yield* wrap(fs.makeDirectory(path.dirname(input.dest), { recursive: true }))
  yield* wrap(fs.rename(input.part, input.dest))
  return { path: input.dest, bytes: received, sha256: digest, resumed }
})

export const download = Effect.fn("SemifAcquire.download")(function* (input: DownloadInput) {
  const attempts = Math.max(1, input.maxAttempts ?? DEFAULT_ATTEMPTS)
  const counter = yield* Ref.make(0)
  const run = Effect.gen(function* () {
    yield* Ref.update(counter, (count) => count + 1)
    return yield* downloadAttempt(input)
  })
  const result = yield* Effect.acquireUseRelease(
    Effect.promise((signal) => Flock.acquire(`semif:model:${input.sha256}`, { signal })),
    () =>
      run.pipe(
        Effect.retry({
          schedule: Schedule.both(Schedule.exponential("250 millis"), Schedule.recurs(attempts - 1)).pipe(
            Schedule.jittered,
          ),
          while: (error) => error.retryable !== false,
        }),
      ),
    (lease) => Effect.promise(() => lease.release()),
  )
  return { ...result, attempts: yield* Ref.get(counter) }
})

export const ensure = Effect.fn("SemifAcquire.ensure")(function* (input: EnsureInput) {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* wrap(fs.exists(input.dest))
  if (exists) {
    const info = yield* wrap(fs.stat(input.dest))
    if (input.expectedBytes === undefined || Number(info.size) === input.expectedBytes) {
      return { path: input.dest, bytes: Number(info.size), sha256: input.sha256, acquired: false }
    }
    // Wrong size means a half-migrated or stale file; leave policy to decide.
  }
  if (input.policy !== "auto") {
    return yield* new AcquireError({
      reason: `semif: model is not downloaded and download=${input.policy}`,
      retryable: false,
    })
  }
  const result = yield* download(input)
  return { path: result.path, bytes: result.bytes, sha256: result.sha256, acquired: true }
})

// Reads a file and verifies it against the pinned digest. Used to re-validate a
// file that exists but whose size is unknown or suspicious.
export const verify = Effect.fn("SemifAcquire.verify")(function* (file: string, sha256: string) {
  const fs = yield* FileSystem.FileSystem
  const hash = createHash("sha256")
  yield* fs
    .stream(file)
    .pipe(
      Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))),
      wrap,
    )
  const digest = hash.digest("hex")
  if (digest !== sha256.toLowerCase()) {
    return yield* new AcquireError({ reason: `semif: ${file} failed sha256 verification` })
  }
  return digest
})

export * as SemifAcquire from "./acquire"
