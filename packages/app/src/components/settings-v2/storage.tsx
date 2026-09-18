import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { For, Show, Switch, Match, createMemo, createResource, createSignal, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useSettings } from "@/context/settings"
import { compactStorage, fetchStorageStatus, formatBytes } from "@/utils/server-storage"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

const MAX_TABLES = 5

export const SettingsStorageSection: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const sdk = useServerSDK()
  const fetcher = () => platform.fetch ?? globalThis.fetch
  const [running, setRunning] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const [compactedBytes, setCompactedBytes] = createSignal<number>()

  const [status, { refetch }] = createResource(
    () => sdk().url,
    async () => {
      // The server can disappear mid-flight, for example while the updater kills the
      // sidecar before installing. Treat that as "no data" instead of setting the
      // resource error, because reading an errored resource accessor throws into the
      // render tree and takes down the settings dialog.
      try {
        return await fetchStorageStatus({ server: sdk().server.http, fetch: fetcher() })
      } catch {
        return undefined
      }
    },
  )

  // `status.loading` only covers pending/refreshing; include the pre-fetch "unresolved"
  // state so the section shows the loader before the first response instead of "—".
  const loading = () => status.state === "unresolved" || status.loading

  const topTables = createMemo(() => (status()?.tables ?? []).slice(0, MAX_TABLES))

  const lastCompact = createMemo(() => {
    const at = settings.general.lastDbCompactAt()
    if (!at) return language.t("settings.general.storage.compact.never")
    const date = new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(at),
    )
    return language.t("settings.general.storage.compact.last", { date })
  })

  const compact = async () => {
    if (running()) return
    setRunning(true)
    setFailed(false)
    try {
      const result = await compactStorage({ server: sdk().server.http, fetch: fetcher() })
      setCompactedBytes(result.fileBytes)
      settings.general.setLastDbCompactAt(Date.now())
      await refetch()
    } catch {
      setFailed(true)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.storage")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.storage.database.title")}
          description={language.t("settings.general.storage.database.description")}
        >
          <div class="settings-v2-storage-value" aria-live="polite">
            <Switch>
              <Match keyed when={status()}>
                {(data) => <span class="settings-v2-storage-size">{formatBytes(data.fileBytes, language.intl())}</span>}
              </Match>
              <Match when={loading()}>
                <LoaderV2 />
              </Match>
              <Match when={true}>
                <span class="settings-v2-storage-empty">—</span>
              </Match>
            </Switch>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              disabled={status.loading}
              icon={<Icon name="reset" size="normal" />}
              aria-label={language.t("settings.general.storage.refresh")}
              data-action="settings-storage-refresh"
              onClick={() => void refetch()}
            />
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.storage.tables.title")}
          description={language.t("settings.general.storage.tables.description")}
        >
          <div class="settings-v2-storage-tables">
            <Switch>
              <Match when={topTables().length > 0}>
                <For each={topTables()}>
                  {(table) => (
                    <div class="settings-v2-storage-table">
                      <span class="settings-v2-storage-table-name">{table.name}</span>
                      <span class="settings-v2-storage-table-size">{formatBytes(table.bytes, language.intl())}</span>
                    </div>
                  )}
                </For>
              </Match>
              <Match when={loading()}>
                <LoaderV2 />
              </Match>
              <Match when={true}>
                <span class="settings-v2-storage-empty">—</span>
              </Match>
            </Switch>
          </div>
        </SettingsRowV2>

        <SettingsRowV2
          title={language.t("settings.general.storage.compact.title")}
          description={
            <>
              <div>{language.t("settings.general.storage.compact.description")}</div>
              <div class="settings-v2-storage-meta">{lastCompact()}</div>
              <Show keyed when={compactedBytes()}>
                {(bytes) => (
                  <div class="settings-v2-storage-result">
                    {language.t("settings.general.storage.compact.result", {
                      size: formatBytes(bytes, language.intl()),
                    })}
                  </div>
                )}
              </Show>
              <Show when={failed()}>
                <div class="settings-v2-storage-error">{language.t("common.requestFailed")}</div>
              </Show>
            </>
          }
        >
          <ButtonV2
            size="normal"
            variant={running() ? "loading" : "neutral"}
            disabled={running()}
            data-action="settings-storage-compact"
            onClick={() => void compact()}
          >
            <Show when={running()}>
              <LoaderV2 width={14} height={14} />
            </Show>
            {language.t(
              running() ? "settings.general.storage.compact.running" : "settings.general.storage.compact.action",
            )}
          </ButtonV2>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )
}
