// Tauri bridge shim.
//
// Implements the same `window.api` surface the Electron preload exposes so the
// renderer (and `createPlatform`) run unchanged under the Tauri shell. The shim
// installs itself only when the Electron preload is absent.
//
// P1 scope: everything needed to boot the real UI plus defensive stubs. Native
// pickers, context menus, the updater, logging export and the native menu are
// later phases (see specs/tauri-migration.md).

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"

const SETTINGS_STORE = "opencode.settings"
const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
const PINCH_ZOOM_ENABLED_KEY = "pinchZoomEnabled"

const storeGet = (name: string, key: string) => invoke<string | null>("store_get", { name, key })
const storeSet = (name: string, key: string, value: string) => invoke<void>("store_set", { name, key, value })
const storeDelete = (name: string, key: string) => invoke<void>("store_delete", { name, key })
const storeClear = (name: string) => invoke<void>("store_clear", { name })
const storeKeys = (name: string) => invoke<string[]>("store_keys", { name })
const storeLength = (name: string) => invoke<number>("store_length", { name })

const subscribe = <T>(event: string, callback: (payload: T) => void) => {
  let unlisten: (() => void) | undefined
  listen<T>(event, (message) => callback(message.payload))
    .then((fn) => (unlisten = fn))
    .catch((error) => {
      void invoke<void>("log_stub", { message: `listen failed for ${event}: ${String(error)}` }).catch(() => {})
    })
  return () => unlisten?.()
}

const warn = (feature: string) => {
  console.warn(`[tauri-api] ${feature} is not wired in the Tauri shell yet`)
}

const tauriApi = {
  killSidecar: () => invoke<void>("kill_sidecar"),
  installCli: async () => "",
  awaitInitialization: () =>
    invoke<{ url: string; username: string | null; password: string | null }>("await_initialization"),
  wslServers: undefined,

  updater: {
    subscribe: async () => () => {},
    check: async () => ({ status: "disabled" }),
    install: async () => {},
  },

  consumeInitialDeepLinks: () => invoke<string[]>("consume_initial_deep_links"),
  onDeepLink: (callback: (urls: string[]) => void) =>
    subscribe<string[]>("deep-link", (urls) => {
      void invoke<void>("log_stub", { message: `deep-link received ${JSON.stringify(urls)}` }).catch(() => {})
      callback(urls)
    }),

  getDefaultServerUrl: () => storeGet(SETTINGS_STORE, DEFAULT_SERVER_URL_KEY),
  setDefaultServerUrl: (url: string | null) =>
    url === null
      ? storeDelete(SETTINGS_STORE, DEFAULT_SERVER_URL_KEY)
      : storeSet(SETTINGS_STORE, DEFAULT_SERVER_URL_KEY, url),

  isFirstLaunchOnboardingPending: async () => false,
  finishFirstLaunchOnboarding: async () => null,
  isOldLayoutEligible: async () => false,

  getDisplayBackend: async () => null,
  setDisplayBackend: async () => {},

  checkAppExists: async () => false,
  resolveAppPath: async () => null,

  storeGet,
  storeSet,
  storeDelete,
  storeClear,
  storeKeys,
  storeLength,

  draftGet: async () => null,
  draftSet: async () => {},
  draftDelete: async () => {},
  draftBlobPut: async () => crypto.randomUUID(),
  draftBlobGet: async () => null,

  getWindowID: () => invoke<string>("get_window_id"),
  onMenuCommand: (callback: (id: string) => void) => subscribe<string>("menu-command", callback),

  openDirectoryPicker: async () => null,
  openFilePicker: async () => null,
  readPickedFile: async () => new ArrayBuffer(0),
  releasePickedFiles: async () => {},
  getPathForFile: () => "",
  saveFilePicker: async () => null,

  openExternal: (url: string) => warn(`openExternal(${url})`),
  openLocalFile: (url: string) => warn(`openLocalFile(${url})`),
  openPath: async () => {},
  revealPath: async () => false,
  readClipboardImage: async () => null,

  getWindowFocused: () => getCurrentWindow().isFocused(),
  getWindowFullscreen: () => getCurrentWindow().isFullscreen(),
  onWindowFullscreenChanged: (_callback: (fullscreen: boolean) => void) => () => {},
  setWindowFocus: () => getCurrentWindow().setFocus(),
  showWindow: () => getCurrentWindow().show(),
  relaunch: () => warn("relaunch"),

  getZoomFactor: async () => 1,
  setZoomFactor: (factor: number) => invoke<void>("set_zoom", { factor }),
  getPinchZoomEnabled: async () => (await storeGet(SETTINGS_STORE, PINCH_ZOOM_ENABLED_KEY)) === "true",
  setPinchZoomEnabled: (enabled: boolean) =>
    storeSet(SETTINGS_STORE, PINCH_ZOOM_ENABLED_KEY, enabled ? "true" : "false"),
  onPinchZoomEnabledChanged: (_callback: (enabled: boolean) => void) => () => {},
  onZoomFactorChanged: (_callback: (factor: number) => void) => () => {},

  setTitlebar: async () => {},
  runDesktopMenuAction: async () => {},
  setBackgroundColor: async () => {},
  exportDebugLogs: async () => "",
  setForceFocus: async () => {},
  recordFatalRendererError: (error: unknown) =>
    invoke<void>("log_stub", { message: `fatal-renderer-error ${JSON.stringify(error)}` }).catch(() => {}),
  setNativeTranslations: async () => {},
} as unknown as typeof window.api

if (!window.api) window.api = tauriApi

export { tauriApi }
