import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { run, shouldPrepare, shouldWarmup, type Policy } from "../../src/semif/warmup"
import type { Status } from "../../src/semif/service"

const status = (overrides: Partial<Status>): Status => ({
  status: "not_downloaded",
  mode: "auto",
  download: "auto",
  host: "127.0.0.1",
  port: 8817,
  adopted: false,
  choices: [],
  ...overrides,
})

describe("semif warm-up policy", () => {
  test("shouldWarmup opts in only for mode=auto with download=auto", () => {
    const policies: Array<[Policy, boolean]> = [
      [{ mode: "auto", download: "auto" }, true],
      [{ mode: "auto", download: "manual" }, false],
      [{ mode: "auto", download: "never" }, false],
      [{ mode: "lazy", download: "auto" }, false],
      [{ mode: "off", download: "auto" }, false],
    ]
    for (const [policy, expected] of policies) {
      expect(shouldWarmup(policy)).toBe(expected)
    }
  })

  test("shouldPrepare defers in-flight and disabled states and respects download policy", () => {
    expect(shouldPrepare(status({ status: "downloading" }))).toBe(false)
    expect(shouldPrepare(status({ status: "verifying" }))).toBe(false)
    expect(shouldPrepare(status({ status: "starting" }))).toBe(false)
    expect(shouldPrepare(status({ status: "ready" }))).toBe(false)
    expect(shouldPrepare(status({ status: "unsupported" }))).toBe(false)
    expect(shouldPrepare(status({ status: "disabled", mode: "off" }))).toBe(false)

    expect(shouldPrepare(status({ status: "offline" }))).toBe(true)
    expect(shouldPrepare(status({ status: "failed" }))).toBe(true)
    expect(shouldPrepare(status({ status: "not_downloaded", download: "auto" }))).toBe(true)
    expect(shouldPrepare(status({ status: "not_downloaded", download: "manual" }))).toBe(false)
    expect(shouldPrepare(status({ status: "not_downloaded", download: "never" }))).toBe(false)
  })

  test("run starts only when auto+auto and never starts for off/lazy/manual/never", async () => {
    let started = 0
    const start = Effect.sync(() => {
      started += 1
    })

    await Effect.runPromise(run({ mode: "auto", download: "auto" }, start))
    expect(started).toBe(1)

    for (const policy of [
      { mode: "off", download: "auto" },
      { mode: "lazy", download: "auto" },
      { mode: "auto", download: "manual" },
      { mode: "auto", download: "never" },
    ] satisfies Array<Policy>) {
      await Effect.runPromise(run(policy, start))
    }
    expect(started).toBe(1)
  })

  test("run swallows start failures so boot can never be brought down", async () => {
    await Effect.runPromise(
      run({ mode: "auto", download: "auto" }, Effect.fail(new Error("simulated download failure"))),
    )
  })
})
