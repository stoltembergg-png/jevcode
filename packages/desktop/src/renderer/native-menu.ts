// Sends the shared desktop menu specification to the Tauri shell, which resolves
// labels from the native translations bundle and builds the macOS application menu.
// Mirrors the role of packages/desktop/src/main/menu.ts under Electron.

import { invoke } from "@tauri-apps/api/core"
import { DESKTOP_MENU, desktopMenuVisible, type DesktopMenuEntry } from "@opencode-ai/app/desktop-menu"

type MenuSpecItem = {
  type?: "item" | "separator"
  labelKey?: string
  role?: string
  command?: string
  action?: string
  href?: string
  accelerator?: { macos?: string }
  enabled?: string
}

type MenuSpec = {
  labelKey: string
  role?: string
  items: MenuSpecItem[]
}

function entrySpec(entry: DesktopMenuEntry): MenuSpecItem | undefined {
  const platforms = (entry as { platforms?: string[] }).platforms
  if (platforms && !platforms.includes("macos")) return undefined
  if ("type" in entry && entry.type === "separator") return { type: "separator" }
  const item = entry as Exclude<DesktopMenuEntry, { type: "separator" }>
  return {
    type: "item",
    labelKey: item.labelKey,
    role: item.role,
    command: item.command,
    action: item.action,
    href: item.href,
    accelerator: item.accelerator?.macos ? { macos: item.accelerator.macos } : undefined,
    enabled: item.enabled,
  }
}

function menuSpec(): MenuSpec[] {
  return DESKTOP_MENU.filter((menu) => desktopMenuVisible(menu, "macos")).map((menu) => ({
    labelKey: menu.labelKey,
    role: menu.role,
    items: (menu.items ?? [])
      .filter((entry) => desktopMenuVisible(entry, "macos"))
      .map(entrySpec)
      .filter((entry): entry is MenuSpecItem => !!entry),
  }))
}

/// No-op outside the Tauri shell.
export function syncNativeMenu() {
  try {
    if (!("__TAURI_INTERNALS__" in window)) return
    void invoke("set_native_menu", { items: menuSpec() }).catch((error) => {
      void invoke("log_stub", { message: `set_native_menu failed ${String(error)}` }).catch(() => {})
    })
  } catch (error) {
    void invoke("log_stub", { message: `syncNativeMenu threw ${String(error)}` }).catch(() => {})
  }
}
