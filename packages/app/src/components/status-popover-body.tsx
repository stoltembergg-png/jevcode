import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Tabs } from "@opencode-ai/ui/tabs"
import { showToast } from "@/utils/toast"
import { useNavigate } from "@solidjs/router"
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSXElement,
  Match,
  onCleanup,
  Show,
  Switch as SwitchView,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import type { SemifStatus } from "@opencode-ai/sdk/v2/client"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { type ServerHealth } from "@/utils/server-health"
import { useGlobal } from "@/context/global"
import { useSettings } from "@/context/settings"
import { useMcpToggle } from "@/context/mcp"
import { useQueryOptions } from "@/context/server-sync"
import { useServerProtocol } from "@/context/server-sdk"

const pluginEmptyMessage = (value: string, file: string): JSXElement => {
  const parts = value.split(file)
  if (parts.length === 1) return value
  return (
    <>
      {parts[0]}
      <code class="bg-surface-raised-base px-1.5 py-0.5 rounded-sm text-text-base">{file}</code>
      {parts.slice(1).join(file)}
    </>
  )
}

type SemifMode = "auto" | "lazy" | "off"

const SEMIF_MODES: SemifMode[] = ["auto", "lazy", "off"]

const SEMIF_DEFAULT_MODEL = "LiquidAI/LFM2-1.2B-GGUF"

const SEMIF_MODEL_CHOICES = [
  { id: SEMIF_DEFAULT_MODEL, label: "LFM2-1.2B Q4_K_M" },
  { id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B", label: "DeepSeek-R1-Distill-Qwen-1.5B" },
  { id: "Qwen/Qwen2.5-1.5B", label: "Qwen2.5-1.5B" },
] as const

const semifPercent = (status: SemifStatus | undefined) => {
  const total = toFinite(status?.progress?.total)
  const received = toFinite(status?.progress?.received) ?? 0
  if (total === undefined || total <= 0) return undefined
  return Math.max(0, Math.min(100, Math.floor((received / total) * 100)))
}

const toFinite = (value: number | string | undefined) => {
  const next = typeof value === "number" ? value : Number(value)
  return Number.isFinite(next) ? next : undefined
}

const semifDotClass = (status: SemifStatus | undefined) => {
  if (!status) return "bg-border-weaker-base"
  if (status.status === "ready") return "bg-icon-success-base"
  if (status.status === "downloading" || status.status === "verifying" || status.status === "starting")
    return "bg-icon-warning-base"
  if (status.status === "disabled" || status.status === "failed" || status.status === "not_downloaded")
    return "bg-border-weak-base"
  return "bg-border-weaker-base"
}

const listServersByHealth = (
  list: ServerConnection.Any[],
  active: ServerConnection.Key | undefined,
  status: Record<ServerConnection.Key, ServerHealth | undefined>,
) => {
  if (!list.length) return list
  const order = new Map(list.map((url, index) => [url, index] as const))
  const rank = (value?: ServerHealth) => {
    if (value?.healthy === true) return 0
    if (value?.healthy === false) return 2
    return 1
  }

  return list.slice().sort((a, b) => {
    if (ServerConnection.key(a) === active) return -1
    if (ServerConnection.key(b) === active) return 1
    const diff = rank(status[ServerConnection.key(a)]) - rank(status[ServerConnection.key(b)])
    if (diff !== 0) return diff
    return (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })
}

const useDefaultServerKey = (
  get: (() => string | Promise<string | null | undefined> | null | undefined) | undefined,
) => {
  const [state, setState] = createStore({
    key: undefined as ServerConnection.Key | undefined,
    tick: 0,
  })

  createEffect(() => {
    state.tick
    let dead = false
    const result = get?.()
    if (!result) {
      setState("key", undefined)
      onCleanup(() => {
        dead = true
      })
      return
    }

    if (result instanceof Promise) {
      void result.then((next) => {
        if (dead) return
        setState("key", next ?? undefined)
      })
      onCleanup(() => {
        dead = true
      })
      return
    }

    setState("key", ServerConnection.Key.make(result))
    onCleanup(() => {
      dead = true
    })
  })

  return {
    key: () => {
      return state.key
    },
    refresh: () => setState("tick", (value) => value + 1),
  }
}

type ServerStatusState = {
  servers: () => ServerStatusItem[]
  defaultKey: () => ServerConnection.Key | undefined
  ariaLabel: string
  serversLabel: string
  defaultLabel: string
  manageLabel: string
  onManage: () => void
}

type ServerStatusItem = {
  key: ServerConnection.Key
  conn: ServerConnection.Any
  health?: ServerHealth
  blocked: boolean
  active: boolean
  onSelect: () => void
}

export function StatusPopoverServerBody() {
  const global = useGlobal()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  let dialogRun = 0
  let dialogDead = false
  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
  })

  const sortedServers = createMemo(() => listServersByHealth(global.servers.list(), server.key, global.servers.health))
  const defaultServer = useDefaultServerKey(platform.getDefaultServer)
  const serverItems = createMemo(() =>
    sortedServers().map((conn) => {
      const key = ServerConnection.key(conn)
      return {
        key,
        conn,
        health: global.servers.health[key],
        blocked: global.servers.health[key]?.healthy === false,
        active: !!server.current && key === ServerConnection.key(server.current),
        onSelect: () => {
          navigate("/")
          queueMicrotask(() => server.setActive(key))
        },
      }
    }),
  )

  return (
    <ServerStatusPopoverView
      state={{
        servers: serverItems,
        defaultKey: defaultServer.key,
        ariaLabel: language.t("status.popover.ariaLabel"),
        serversLabel: language.t("status.popover.tab.servers"),
        defaultLabel: language.t("common.default"),
        manageLabel: language.t("status.popover.action.manageServers"),
        onManage: () => {
          const run = ++dialogRun
          void import("./dialog-select-server").then((x) => {
            if (dialogDead || dialogRun !== run) return
            dialog.show(() => <x.DialogSelectServer />, defaultServer.refresh)
          })
        },
      }}
    />
  )
}

function ServerStatusPopoverView(props: { state: ServerStatusState }) {
  return (
    <div class="flex items-center gap-1 w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]">
      <Tabs
        aria-label={props.state.ariaLabel}
        class="tabs bg-background-strong rounded-xl overflow-hidden"
        data-component="tabs"
        data-active="servers"
        defaultValue="servers"
        variant="alt"
      >
        <Tabs.List data-slot="tablist" class="bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-10">
          <Tabs.Trigger value="servers" data-slot="tab" class="text-12-regular">
            {props.state.servers().length > 0 ? `${props.state.servers().length} ` : ""}
            {props.state.serversLabel}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="servers">
          <ServerStatusList state={props.state} />
        </Tabs.Content>
      </Tabs>
    </div>
  )
}

function ServerStatusList(props: { state: ServerStatusState }) {
  return (
    <div class="flex flex-col px-2 pb-2">
      <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
        <For each={props.state.servers()}>
          {(item) => {
            return (
              <button
                type="button"
                class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5 rounded-md transition-colors text-left"
                classList={{
                  "hover:bg-surface-raised-base-hover": !item.blocked,
                  "cursor-not-allowed": item.blocked,
                }}
                aria-disabled={item.blocked}
                onClick={() => {
                  if (item.blocked) return
                  item.onSelect()
                }}
              >
                <ServerHealthIndicator health={item.health} />
                <ServerRow
                  conn={item.conn}
                  dimmed={item.blocked}
                  status={item.health}
                  class="flex items-center gap-2 w-full min-w-0"
                  nameClass="text-14-regular text-text-base truncate"
                  versionClass="text-12-regular text-text-weak truncate"
                  badge={
                    <Show when={item.key === props.state.defaultKey()}>
                      <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">
                        {props.state.defaultLabel}
                      </span>
                    </Show>
                  }
                >
                  <div class="flex-1" />
                  <Show when={item.active}>
                    <Icon name="check" size="small" class="text-icon-weak shrink-0" />
                  </Show>
                </ServerRow>
              </button>
            )
          }}
        </For>

        <Button variant="secondary" class="mt-3 self-start h-8 px-3 py-1.5" onClick={props.state.onManage}>
          {props.state.manageLabel}
        </Button>
      </div>
    </div>
  )
}

export function StatusPopoverBody(props: { shown: Accessor<boolean> }) {
  const sync = useSync()
  const global = useGlobal()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const settings = useSettings()
  const protocol = useServerProtocol()

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: err instanceof Error ? err.message : String(err),
    })
  }

  createEffect(() => {
    if (!props.shown()) return
  })

  let dialogRun = 0
  let dialogDead = false
  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
  })
  const sortedServers = createMemo(() => {
    const list = settings.general.newLayoutDesigns()
      ? global.servers.list()
      : global.servers.list().filter((x) => global.ensureServerCtx(x).sdk.protocolKind() !== "v2")
    return listServersByHealth(list, server.key, global.servers.health)
  })
  const toggleMcp = useMcpToggle()
  const defaultServer = useDefaultServerKey(platform.getDefaultServer)
  const mcpNames = createMemo(() => Object.keys(sync().data.mcp ?? {}).sort((a, b) => a.localeCompare(b)))
  const mcpStatus = (name: string) => sync().data.mcp?.[name]?.status
  const mcpConnected = createMemo(() => mcpNames().filter((name) => mcpStatus(name) === "connected").length)
  const lspItems = createMemo(() => sync().data.lsp ?? [])
  const lspCount = createMemo(() => lspItems().length)
  const plugins = createMemo(() =>
    (sync().data.config.plugin ?? []).map((item) => (typeof item === "string" ? item : item[0])),
  )
  const pluginCount = createMemo(() => plugins().length)
  const pluginEmpty = createMemo(() => pluginEmptyMessage(language.t("dialog.plugins.empty"), "opencode.json"))

  const sdk = useSDK()
  const queryOptions = useQueryOptions()
  const queryClient = useQueryClient()
  const [semifPending, setSemifPending] = createSignal(false)
  const [semifActionPending, setSemifActionPending] = createSignal(false)
  const [semifOptimistic, setSemifOptimistic] = createSignal<SemifMode | undefined>(undefined)
  const [semifModelOptimistic, setSemifModelOptimistic] = createSignal<string | undefined>(undefined)
  const semifQuery = useQuery(() => ({
    ...queryOptions().semif(),
  }))
  const semifStatus = () => semifQuery.data
  const semifAvailable = () => semifStatus() !== undefined
  const semifMode = createMemo<SemifMode>(() => semifOptimistic() ?? semifStatus()?.mode ?? "auto")
  const semifModelId = createMemo(
    () => semifModelOptimistic() ?? semifStatus()?.model?.id ?? SEMIF_DEFAULT_MODEL,
  )
  const semifProgressPercent = createMemo(() => semifPercent(semifStatus()))
  const showSemifModeControl = () => semifStatus()?.status !== "unsupported"
  const semifChoices = createMemo(() => {
    const fromStatus = semifStatus()?.choices
    if (fromStatus && fromStatus.length > 0) return fromStatus
    return SEMIF_MODEL_CHOICES
  })
  const semifBusy = () =>
    semifPending() ||
    semifActionPending() ||
    semifStatus()?.status === "downloading" ||
    semifStatus()?.status === "verifying" ||
    semifStatus()?.status === "starting"
  createEffect(() => {
    const optimistic = semifOptimistic()
    if (optimistic && semifStatus()?.mode === optimistic) setSemifOptimistic(undefined)
  })
  createEffect(() => {
    const optimistic = semifModelOptimistic()
    if (optimistic && semifStatus()?.model?.id === optimistic) setSemifModelOptimistic(undefined)
  })
  createEffect(() => {
    if (!semifActionPending()) return
    const timer = setInterval(() => void semifQuery.refetch(), 1500)
    onCleanup(() => clearInterval(timer))
  })
  const setSemifMode = async (mode: SemifMode) => {
    if (semifPending() || mode === semifMode()) return
    setSemifOptimistic(mode)
    setSemifPending(true)
    try {
      await sdk().client.global.config.update({ config: { semif: { mode } } })
      await semifQuery.refetch()
    } catch (err) {
      setSemifOptimistic(undefined)
      fail(err)
    } finally {
      setSemifPending(false)
    }
  }
  const setSemifModel = async (id: string) => {
    if (semifBusy() || id === semifModelId()) return
    setSemifModelOptimistic(id)
    setSemifPending(true)
    try {
      await sdk().client.global.config.update({ config: { semif: { model: id } } })
      await semifQuery.refetch()
      if (semifMode() !== "off") await runSemifAction("start")
    } catch (err) {
      setSemifModelOptimistic(undefined)
      fail(err)
    } finally {
      setSemifPending(false)
    }
  }
  const runSemifAction = async (action: "acquire" | "start") => {
    if (semifActionPending()) return
    setSemifActionPending(true)
    try {
      const client = sdk().client
      const result = action === "acquire" ? await client.semif.acquire() : await client.semif.start()
      if (result.data) queryClient.setQueryData(queryOptions().semif().queryKey, result.data)
    } catch (err) {
      fail(err)
    } finally {
      setSemifActionPending(false)
    }
  }

  return (
    <div class="flex items-center gap-1 w-[360px] rounded-xl shadow-[var(--shadow-lg-border-base)]">
      <Tabs
        aria-label={language.t("status.popover.ariaLabel")}
        class="tabs bg-background-strong rounded-xl overflow-hidden"
        data-component="tabs"
        data-active={settings.general.newLayoutDesigns() ? "mcp" : "servers"}
        defaultValue={settings.general.newLayoutDesigns() ? "mcp" : "servers"}
        variant="alt"
      >
        <Tabs.List data-slot="tablist" class="bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-10">
          {!settings.general.newLayoutDesigns() && (
            <Tabs.Trigger value="servers" data-slot="tab" class="text-12-regular">
              {sortedServers().length > 0 ? `${sortedServers().length} ` : ""}
              {language.t("status.popover.tab.servers")}
            </Tabs.Trigger>
          )}
          <Tabs.Trigger value="mcp" data-slot="tab" class="text-12-regular">
            {mcpConnected() > 0 ? `${mcpConnected()} ` : ""}
            {language.t("status.popover.tab.mcp")}
          </Tabs.Trigger>
          <Tabs.Trigger value="lsp" data-slot="tab" class="text-12-regular">
            {lspCount() > 0 ? `${lspCount()} ` : ""}
            {language.t("status.popover.tab.lsp")}
          </Tabs.Trigger>
          <Tabs.Trigger value="semif" data-slot="tab" class="text-12-regular">
            <span class="flex items-center gap-1.5">
              <span class={`size-1.5 rounded-full shrink-0 ${semifDotClass(semifAvailable() ? semifStatus() : undefined)}`} />
              {language.t("status.popover.tab.semif")}
            </span>
          </Tabs.Trigger>
          <Show when={protocol() === "v1"}>
            <Tabs.Trigger value="plugins" data-slot="tab" class="text-12-regular">
              {pluginCount() > 0 ? `${pluginCount()} ` : ""}
              {language.t("status.popover.tab.plugins")}
            </Tabs.Trigger>
          </Show>
        </Tabs.List>

        {!settings.general.newLayoutDesigns() && (
          <Tabs.Content value="servers">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                <For each={sortedServers()}>
                  {(s) => {
                    const key = ServerConnection.key(s)
                    const blocked = () => global.servers.health[key]?.healthy === false
                    return (
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5 rounded-md transition-colors text-left"
                        classList={{
                          "hover:bg-surface-raised-base-hover": !blocked(),
                          "cursor-not-allowed": blocked(),
                        }}
                        aria-disabled={blocked()}
                        onClick={() => {
                          if (blocked()) return
                          navigate("/")
                          queueMicrotask(() => server.setActive(key))
                        }}
                      >
                        <ServerHealthIndicator health={global.servers.health[key]} />
                        <ServerRow
                          conn={s}
                          dimmed={blocked()}
                          status={global.servers.health[key]}
                          class="flex items-center gap-2 w-full min-w-0"
                          nameClass="text-14-regular text-text-base truncate"
                          versionClass="text-12-regular text-text-weak truncate"
                          badge={
                            <Show when={key === defaultServer.key()}>
                              <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">
                                {language.t("common.default")}
                              </span>
                            </Show>
                          }
                        >
                          <div class="flex-1" />
                          <Show when={server.current && key === ServerConnection.key(server.current)}>
                            <Icon name="check" size="small" class="text-icon-weak shrink-0" />
                          </Show>
                        </ServerRow>
                      </button>
                    )
                  }}
                </For>

                <Button
                  variant="secondary"
                  class="mt-3 self-start h-8 px-3 py-1.5"
                  onClick={() => {
                    const run = ++dialogRun
                    void import("./dialog-select-server").then((x) => {
                      if (dialogDead || dialogRun !== run) return
                      dialog.show(() => <x.DialogSelectServer />, defaultServer.refresh)
                    })
                  }}
                >
                  {language.t("status.popover.action.manageServers")}
                </Button>
              </div>
            </div>
          </Tabs.Content>
        )}

        <Tabs.Content value="mcp">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
              <Show
                when={mcpNames().length > 0}
                fallback={
                  <div class="text-14-regular text-text-base text-center my-auto">{language.t("dialog.mcp.empty")}</div>
                }
              >
                <For each={mcpNames()}>
                  {(name) => {
                    const status = () => mcpStatus(name)
                    const enabled = () => status() === "connected"
                    return (
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full min-h-8 pl-3 pr-2 py-1 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                        onClick={() => {
                          if (toggleMcp.isPending) return
                          toggleMcp.mutate(name)
                        }}
                        disabled={toggleMcp.isPending && toggleMcp.variables === name}
                      >
                        <div
                          classList={{
                            "size-1.5 rounded-full shrink-0": true,
                            "bg-icon-success-base": status() === "connected",
                            "bg-icon-critical-base": status() === "failed",
                            "bg-border-weak-base": status() === "disabled",
                            "bg-icon-warning-base":
                              status() === "needs_auth" || status() === "needs_client_registration",
                          }}
                        />
                        <span class="flex flex-col min-w-0 flex-1">
                          <span class="flex items-center gap-2 min-w-0">
                            <span class="text-14-regular text-text-base truncate">{name}</span>
                          </span>
                          <Show when={status() === "needs_auth"}>
                            <span class="text-11-regular text-text-weaker truncate">
                              {language.t("mcp.auth.clickToAuthenticate")}
                            </span>
                          </Show>
                        </span>
                        <div onClick={(event) => event.stopPropagation()}>
                          <Switch
                            checked={enabled()}
                            disabled={toggleMcp.isPending && toggleMcp.variables === name}
                            onChange={() => {
                              if (toggleMcp.isPending) return
                              toggleMcp.mutate(name)
                            }}
                          />
                        </div>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="lsp">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
              <Show
                when={lspItems().length > 0}
                fallback={
                  <div class="text-14-regular text-text-base text-center my-auto">{language.t("dialog.lsp.empty")}</div>
                }
              >
                <For each={lspItems()}>
                  {(item) => (
                    <div class="flex items-center gap-2 w-full px-2 py-1">
                      <div
                        classList={{
                          "size-1.5 rounded-full shrink-0": true,
                          "bg-icon-success-base": item.status === "connected",
                          "bg-icon-critical-base": item.status === "error",
                        }}
                      />
                      <span class="text-14-regular text-text-base truncate">{item.name || item.id}</span>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="semif">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
              <Show
                when={semifAvailable()}
                fallback={
                  <div class="text-12-regular text-text-weak my-auto">{language.t("semif.not_configured")}</div>
                }
              >
                <div class="flex flex-col gap-3">
                  <div class="flex flex-col gap-0.5 min-w-0">
                    <span class="text-14-regular text-text-base">{language.t("status.popover.tab.semif")}</span>
                    <span class="text-12-regular text-text-weak">
                      {language.t(`semif.description.${semifMode()}`)}
                    </span>
                  </div>

                  <SwitchView>
                    <Match when={semifStatus()?.status === "ready"}>
                      <div class="flex items-center gap-1.5 text-12-regular text-text-base">
                        <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" />
                        {language.t("semif.state.ready")}
                      </div>
                    </Match>
                    <Match when={semifStatus()?.status === "downloading"}>
                      <div class="flex flex-col gap-1.5">
                        <div class="flex items-center justify-between gap-2 text-12-regular text-text-weak">
                          <span>{language.t("semif.state.downloading")}</span>
                          <Show when={semifProgressPercent() !== undefined}>
                            <span class="tabular-nums">
                              {language.t("semif.progress.percent", { percent: `${semifProgressPercent()}%` })}
                            </span>
                          </Show>
                        </div>
                        <div
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={semifProgressPercent()}
                          class="h-1.5 w-full overflow-hidden rounded-full bg-surface-inset-base"
                        >
                          <div
                            class="h-full rounded-full bg-icon-base transition-[width] duration-300"
                            classList={{ "w-full animate-pulse opacity-60": semifProgressPercent() === undefined }}
                            style={
                              semifProgressPercent() === undefined ? undefined : { width: `${semifProgressPercent()}%` }
                            }
                          />
                        </div>
                      </div>
                    </Match>
                    <Match when={semifStatus()?.status === "verifying"}>
                      <div class="flex items-center gap-1.5 text-12-regular text-text-weak">
                        <div class="size-1.5 rounded-full shrink-0 bg-icon-warning-base" />
                        {language.t("semif.state.verifying")}
                      </div>
                    </Match>
                    <Match when={semifStatus()?.status === "starting"}>
                      <div class="flex items-center gap-1.5 text-12-regular text-text-weak">
                        <div class="size-1.5 rounded-full shrink-0 bg-icon-warning-base" />
                        {language.t("semif.state.starting")}
                      </div>
                    </Match>
                    <Match when={semifStatus()?.status === "not_downloaded"}>
                      <div class="flex flex-col gap-2">
                        <span class="text-12-regular text-text-weak">{language.t("semif.state.not_downloaded")}</span>
                        <Show when={semifStatus()?.download !== "never"}>
                          <Button
                            variant="secondary"
                            class="self-start h-7 px-3 text-12-regular"
                            disabled={semifActionPending()}
                            onClick={() => void runSemifAction("acquire")}
                          >
                            {language.t("semif.action.start")}
                          </Button>
                        </Show>
                      </div>
                    </Match>
                    <Match when={semifStatus()?.status === "failed"}>
                      <div class="flex flex-col gap-2">
                        <span class="text-12-regular text-text-weak">{language.t("semif.state.failed")}</span>
                        <Show when={semifStatus()?.error}>
                          {(error) => <span class="text-11-regular text-text-weaker break-words">{error()}</span>}
                        </Show>
                        <Button
                          variant="secondary"
                          class="self-start h-7 px-3 text-12-regular"
                          disabled={semifActionPending()}
                          onClick={() => void runSemifAction("start")}
                        >
                          {language.t("semif.action.retry")}
                        </Button>
                      </div>
                    </Match>
                    <Match when={semifStatus()?.status === "offline"}>
                      <div class="flex items-center gap-1.5 text-12-regular text-text-weak">
                        <div class="size-1.5 rounded-full shrink-0 bg-border-weaker-base" />
                        {language.t("semif.state.offline")}
                      </div>
                    </Match>
                    <Match when={semifStatus()?.status === "unsupported"}>
                      <div class="flex items-center gap-1.5 text-12-regular text-text-weak">
                        <div class="size-1.5 rounded-full shrink-0 bg-border-weaker-base" />
                        {language.t("semif.state.unsupported")}
                      </div>
                    </Match>
                    <Match when={semifStatus()?.status === "disabled"}>
                      <span class="text-12-regular text-text-weak">{language.t("semif.state.disabled")}</span>
                    </Match>
                  </SwitchView>

                  <div class="flex flex-col gap-1.5">
                    <span class="text-12-regular text-text-weak">{language.t("semif.model.label")}</span>
                    <div
                      data-action="semif-model"
                      role="group"
                      aria-label={language.t("semif.model.label")}
                      class="flex flex-col gap-0.5 p-0.5 rounded-md bg-surface-inset-base"
                    >
                      <For each={semifChoices()}>
                        {(choice) => {
                          const selected = () => semifModelId() === choice.id
                          return (
                            <button
                              type="button"
                              aria-pressed={selected()}
                              disabled={semifBusy()}
                              class="inline-flex w-full min-w-0 items-center justify-between gap-2 h-7 px-2 rounded-sm text-12-regular transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-focus disabled:cursor-not-allowed disabled:opacity-50"
                              classList={{
                                "bg-button-secondary-base text-text-strong shadow-[var(--shadow-xs-border-base)]":
                                  selected(),
                                "text-text-weak hover:text-text-base hover:bg-surface-inset-base-hover":
                                  !selected() && !semifBusy(),
                              }}
                              onClick={() => void setSemifModel(choice.id)}
                            >
                              <span class="min-w-0 truncate">{choice.label}</span>
                              <Show when={choice.id === SEMIF_DEFAULT_MODEL}>
                                <span class="text-11-regular text-text-weak shrink-0">
                                  {language.t("common.default")}
                                </span>
                              </Show>
                            </button>
                          )
                        }}
                      </For>
                    </div>
                  </div>

                  <Show when={showSemifModeControl()}>
                    <div
                      data-action="semif-mode"
                      role="group"
                      aria-label={language.t("status.popover.tab.semif")}
                      class="flex items-center gap-0.5 p-0.5 rounded-md bg-surface-inset-base"
                    >
                      <For each={SEMIF_MODES}>
                        {(mode) => {
                          const selected = () => semifMode() === mode
                          return (
                            <button
                              type="button"
                              aria-pressed={selected()}
                              disabled={semifPending()}
                              class="inline-flex flex-1 min-w-0 items-center justify-center h-6 px-2 rounded-sm text-12-regular transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-border-focus disabled:cursor-not-allowed disabled:opacity-50"
                              classList={{
                                "bg-button-secondary-base text-text-strong shadow-[var(--shadow-xs-border-base)]":
                                  selected(),
                                "text-text-weak hover:text-text-base hover:bg-surface-inset-base-hover":
                                  !selected() && !semifPending(),
                              }}
                              onClick={() => void setSemifMode(mode)}
                            >
                              <span class="min-w-0 truncate">{language.t(`semif.mode.${mode}`)}</span>
                            </button>
                          )
                        }}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </Tabs.Content>

        <Show when={protocol() === "v1"}>
          <Tabs.Content value="plugins">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                <Show
                  when={plugins().length > 0}
                  fallback={<div class="text-14-regular text-text-base text-center my-auto">{pluginEmpty()}</div>}
                >
                  <For each={plugins()}>
                    {(plugin) => (
                      <div class="flex items-center gap-2 w-full px-2 py-1">
                        <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" />
                        <span class="text-14-regular text-text-base truncate">{plugin}</span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </Tabs.Content>
        </Show>
      </Tabs>
    </div>
  )
}
