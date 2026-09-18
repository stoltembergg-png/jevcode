import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockNextCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = fixture.directory
const serverKey = fixture.serverKey

const href = (sessionID: string) => `/server/${base64Encode(serverKey)}/session/${sessionID}`

type Probe = {
  done: boolean
  enterAnimationName: string | null
  enterDuration: string | null
  removedAt?: number
  events: { phase: "start" | "end"; name: string; duration: string; t: number }[]
  panelSwitches: number
  homeStarts: number
  samples: { t: number; width: number; opacity: number }[]
}

declare global {
  interface Window {
    __tabProbe?: Probe
  }
}

async function seedTabs(page: Page, sessionIDs: string[]) {
  await page.addInitScript(
    ({ dirBase64, ids }) => {
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify(
          ids.map((sessionId: string) => ({
            type: "session",
            server: "http://127.0.0.1:4096",
            dirBase64,
            sessionId,
          })),
        ),
      )
    },
    { dirBase64: base64Encode(directory), ids: sessionIDs },
  )
}

async function seedServerConfig(page: Page) {
  await page.addInitScript((dir) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: dir, expanded: true }] },
        lastProject: { local: dir },
      }),
    )
  }, directory)
}

async function installProbe(page: Page, sessionID: string) {
  await page.evaluate((targetHref) => {
    const list = document.querySelector("[data-titlebar-tab-list]")
    if (!list) throw new Error("tab list not found")
    const isTarget = (root: ParentNode) =>
      [...root.querySelectorAll<HTMLElement>("[data-titlebar-tab-slot]")].some((el) =>
        el.querySelector(`a[href$="${targetHref}"]`),
      )
    const target = [...document.querySelectorAll<HTMLElement>("[data-titlebar-tab-slot]")].find((el) =>
      el.querySelector(`a[href$="${targetHref}"]`),
    )
    const probe: Probe = {
      done: false,
      enterAnimationName: target ? getComputedStyle(target).animationName : null,
      enterDuration: target ? getComputedStyle(target).animationDuration : null,
      events: [],
      panelSwitches: 0,
      homeStarts: 0,
      samples: [],
    }
    window.__tabProbe = probe

    const findTarget = () =>
      [...document.querySelectorAll<HTMLElement>("[data-titlebar-tab-slot]")].find((el) =>
        el.querySelector(`a[href$="${targetHref}"]`),
      )
    const sample = () => {
      const el = findTarget()
      if (el) {
        const rect = el.getBoundingClientRect()
        probe.samples.push({
          t: performance.now(),
          width: Math.round(rect.width),
          opacity: Number(getComputedStyle(el).opacity),
        })
      }
      if (!probe.done) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    document.addEventListener(
      "animationstart",
      (event) => {
        const e = event as AnimationEvent
        const element = e.target as Element
        if (e.animationName === "sessionPanelFrameIn" && element.closest('[data-component="session-panel-frame"]')) {
          probe.panelSwitches += 1
        }
        if (e.animationName === "homeSurfaceIn") probe.homeStarts += 1
      },
      true,
    )
    list.addEventListener("animationstart", (event) => {
      const e = event as AnimationEvent
      probe.events.push({
        phase: "start",
        name: e.animationName,
        duration: getComputedStyle(e.target as Element).animationDuration,
        t: performance.now(),
      })
    })
    list.addEventListener("animationend", (event) => {
      const e = event as AnimationEvent
      probe.events.push({
        phase: "end",
        name: e.animationName,
        duration: getComputedStyle(e.target as Element).animationDuration,
        t: performance.now(),
      })
    })
    const observer = new MutationObserver(() => {
      if (isTarget(list) || probe.done) return
      probe.removedAt = performance.now()
      probe.done = true
      observer.disconnect()
    })
    observer.observe(list, { childList: true, subtree: true })
  }, href(sessionID))
}

function targetSlot(page: Page, sessionID: string) {
  return page
    .locator("[data-titlebar-tab-slot]")
    .filter({ has: page.locator(`a[href$="${href(sessionID)}"]`) })
}

test.describe("reproduction: tab close motion", () => {
  test.setTimeout(120_000)

  test("closing the active tab animates out, then switches the session surface", async ({ page }) => {
    await mockNextCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory,
      project: fixture.project,
      pageMessages,
    })
    await seedServerConfig(page)
    await seedTabs(page, [fixture.sourceID, fixture.targetID])

    await page.goto(`/${base64Encode(directory)}/session/${fixture.targetID}`)
    await expectSessionTitle(page, fixture.expected.targetTitle)

    await expect(targetSlot(page, fixture.targetID)).toBeVisible()
    await installProbe(page, fixture.targetID)

    const slot = targetSlot(page, fixture.targetID)
    await slot.hover()
    await slot.locator('[data-slot="tab-close"] button').click()

    await page.waitForFunction(() => window.__tabProbe?.done === true)
    const probe = await page.evaluate(() => window.__tabProbe!)
    const starts = probe.events.filter((e) => e.phase === "start" && e.name === "titlebarTabOut")
    const ends = probe.events.filter((e) => e.phase === "end" && e.name === "titlebarTabOut")

    // Enter animation is still declared on the slot.
    expect(probe.enterAnimationName).toContain("titlebarTabIn")
    expect(probe.enterDuration).toBe("0.22s")

    // The close runs a real exit phase: start, end, and end before removal.
    expect(starts).toHaveLength(1)
    expect(ends).toHaveLength(1)
    expect(starts[0]!.duration).toBe("0.22s")
    expect(ends[0]!.t - starts[0]!.t).toBeGreaterThan(200)
    expect(probe.removedAt! - starts[0]!.t).toBeGreaterThan(150)
    expect(Math.abs(probe.removedAt! - ends[0]!.t)).toBeLessThan(100)

    // The exit is a real shrink + fade, not just a delayed removal.
    const widths = probe.samples.map((s) => s.width)
    const opacities = probe.samples.map((s) => s.opacity)
    expect(widths.length).toBeGreaterThan(4)
    expect(Math.max(...widths)).toBeGreaterThan(200)
    expect(Math.min(...widths)).toBeLessThan(40)
    expect(Math.max(...opacities)).toBe(1)
    expect(Math.min(...opacities)).toBeLessThan(0.5)

    // No closing tab is left behind, and the remaining tab is interactive again.
    await expect(page.locator("[data-titlebar-tab-slot][data-closing]")).toHaveCount(0)
    await expect(page.locator('[data-titlebar-tab-slot]')).toHaveCount(1)
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(document.querySelector("[data-titlebar-tab-slot]")!).pointerEvents,
      ),
    ).not.toBe("none")

    // Active conversation switched, and the session surface actually re-ran its entrance.
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    expect(
      await page.evaluate(
        () => getComputedStyle(document.querySelector('[data-component="session-panel-frame"]')!).animationName,
      ),
    ).toBe("sessionPanelFrameIn")
    await expect.poll(() => page.evaluate(() => window.__tabProbe!.panelSwitches)).toBeGreaterThan(0)
  })

  test("closing the last session transitions to the home surface", async ({ page }) => {
    await mockNextCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory,
      project: fixture.project,
      pageMessages,
    })
    await seedServerConfig(page)
    await seedTabs(page, [fixture.targetID])

    await page.goto(`/${base64Encode(directory)}/session/${fixture.targetID}`)
    await expectSessionTitle(page, fixture.expected.targetTitle)
    await installProbe(page, fixture.targetID)

    const slot = targetSlot(page, fixture.targetID)
    await slot.hover()
    await slot.locator('[data-slot="tab-close"] button').click()
    await page.waitForFunction(() => window.__tabProbe?.done === true)

    await expect(page).toHaveURL(/\/$/)
    const home = page.locator('[data-component="home-surface"]')
    await expect(home).toBeVisible()
    expect(await home.evaluate((el) => getComputedStyle(el).animationName)).toBe("homeSurfaceIn")
  })

  test("drag-and-drop reorder still works alongside the exit phase", async ({ page }) => {
    const extra = {
      id: "ses_extra",
      slug: "extra",
      projectID: fixture.project.id,
      directory,
      title: "Extra session",
      version: "dev",
      time: { created: 1700000002000, updated: 1700000002000 },
    }
    await mockNextCodeServer(page, {
      sessions: [...fixture.sessions, extra],
      provider: fixture.provider,
      directory,
      project: fixture.project,
      pageMessages,
    })
    await seedServerConfig(page)
    await seedTabs(page, [fixture.sourceID, fixture.targetID, extra.id])

    await page.goto(`/${base64Encode(directory)}/session/${fixture.sourceID}`)
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    await expect(page.locator("[data-titlebar-tab-slot]")).toHaveCount(3)

    const order = () =>
      page.$$eval("[data-titlebar-tab-slot]", (els) =>
        els.map((el) => el.querySelector("a")?.getAttribute("href") ?? ""),
      )
    const before = await order()
    const first = await targetSlot(page, fixture.sourceID).boundingBox()
    const last = await targetSlot(page, extra.id).boundingBox()
    if (!first || !last) throw new Error("tab boxes unavailable")

    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2)
    await page.mouse.down()
    await page.mouse.move(first.x + 6, first.y + first.height / 2, { steps: 14 })
    await page.mouse.move(first.x + 2, first.y + first.height / 2, { steps: 6 })
    await page.mouse.up()

    await expect.poll(order).not.toEqual(before)
  })

  test("opening a tab still runs the entrance animation", async ({ page }) => {
    await mockNextCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory,
      project: fixture.project,
      pageMessages,
    })
    await seedServerConfig(page)
    await seedTabs(page, [fixture.sourceID])

    await page.goto(`/${base64Encode(directory)}/session/${fixture.sourceID}`)
    await expectSessionTitle(page, fixture.expected.sourceTitle)

    await page.evaluate(() => {
      ;(window as Window & { __enterStarts?: string[] }).__enterStarts = []
      document.addEventListener(
        "animationstart",
        (event) => {
          const e = event as AnimationEvent
          if (e.animationName === "titlebarTabIn") {
            ;(window as Window & { __enterStarts?: string[] }).__enterStarts!.push(e.animationName)
          }
        },
        true,
      )
    })

    const titlebar = page.locator('[data-slot="titlebar-tabs"]')
    await titlebar.locator('xpath=following-sibling::*[1]//button').first().click()
    await page.waitForFunction(() => ((window as Window & { __enterStarts?: string[] }).__enterStarts ?? []).length > 0)
  })

  test("reduced motion still closes instantly without the exit animation", async ({ page }) => {
    await mockNextCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory,
      project: fixture.project,
      pageMessages,
    })
    await seedServerConfig(page)
    await seedTabs(page, [fixture.sourceID, fixture.targetID])
    await page.emulateMedia({ reducedMotion: "reduce" })

    await page.goto(`/${base64Encode(directory)}/session/${fixture.targetID}`)
    await expectSessionTitle(page, fixture.expected.targetTitle)
    await installProbe(page, fixture.targetID)

    const slot = targetSlot(page, fixture.targetID)
    await slot.hover()
    await slot.locator('[data-slot="tab-close"] button').click()
    await page.waitForFunction(() => window.__tabProbe?.done === true)

    const probe = await page.evaluate(() => window.__tabProbe!)
    expect(probe.events.some((e) => e.name === "titlebarTabOut")).toBe(false)
    await expect(page.locator("[data-titlebar-tab-slot]")).toHaveCount(1)
  })
})
