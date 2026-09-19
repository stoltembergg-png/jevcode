import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { type AssistantMessage } from "@opencode-ai/sdk/v2"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { AnimatedNumber } from "@opencode-ai/ui/animated-number"
import { AnimatedCountLabel } from "./tool-count-label"

function tokenTotal(message: AssistantMessage | undefined) {
  if (!message) return 0
  const t = message.tokens
  return t.input + t.output + t.reasoning + t.cache.read + t.cache.write
}

function compactNumber(value: number, locale: string) {
  if (value < 1000) return Math.round(value).toString()
  const formatter = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  })
  return formatter.format(value)
}

export function ThinkingStatus(props: {
  active: boolean
  pendingMessage: AssistantMessage | undefined
  parts: readonly { type: string; tool?: string }[]
}) {
  const i18n = useI18n()
  const [tick, setTick] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  createEffect(
    on(
      () => props.active,
      (isActive) => {
        if (timer) {
          clearInterval(timer)
          timer = undefined
        }
        if (!isActive) return
        timer = setInterval(() => setTick((value) => value + 1), 1000)
      },
    ),
  )

  onCleanup(() => {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  })

  const decisions = createMemo(() => {
    tick()
    let count = 0
    for (const part of props.parts) {
      if (part.type === "tool" && part.tool === "semif_decide") count++
    }
    return count
  })

  const tokens = createMemo(() => {
    tick()
    return tokenTotal(props.pendingMessage)
  })

  const elapsed = createMemo(() => {
    tick()
    const start = props.pendingMessage?.time.created
    if (typeof start !== "number") return 0
    const diff = Date.now() - start
    return diff > 0 ? Math.floor(diff / 1000) : 0
  })

  const tokensLabel = createMemo(() => {
    const value = tokens()
    if (value <= 0) return ""
    return i18n.t("ui.sessionTurn.thinking.tokens", { tokens: compactNumber(value, i18n.locale()) })
  })

  const showDecisions = createMemo(() => decisions() > 0)
  const showTokens = createMemo(() => tokensLabel().length > 0)
  const showElapsed = createMemo(() => elapsed() > 0)

  return (
    <div data-slot="thinking-status" data-active={props.active ? "true" : "false"}>
      <span data-slot="thinking-status-label">
        <TextShimmer text={i18n.t("ui.sessionTurn.status.thinking")} active={props.active} />
      </span>
      <Show when={props.active}>
        <span data-slot="thinking-status-stats" data-active="true">
          <Show when={showDecisions()}>
            <span data-slot="thinking-status-stat-decisions" data-active="true">
              <span data-slot="thinking-status-stat-inner">
                <AnimatedCountLabel count={decisions()} plural="ui.sessionTurn.thinking.decisions" />
              </span>
            </span>
          </Show>
          <Show when={showDecisions() && showTokens()}>
            <span data-slot="thinking-status-sep">·</span>
          </Show>
          <Show when={showTokens()}>
            <span data-slot="thinking-status-stat-tokens" data-active="true">
              <span data-slot="thinking-status-stat-inner">{tokensLabel()}</span>
            </span>
          </Show>
          <Show when={showTokens() && showElapsed()}>
            <span data-slot="thinking-status-sep">·</span>
          </Show>
          <Show when={showElapsed()}>
            <span data-slot="thinking-status-stat-elapsed" data-active="true">
              <span data-slot="thinking-status-stat-inner">
                <AnimatedNumber value={elapsed()} />
                <span data-slot="thinking-status-stat-suffix">s</span>
              </span>
            </span>
          </Show>
        </span>
      </Show>
    </div>
  )
}

