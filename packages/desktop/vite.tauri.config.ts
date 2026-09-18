import { defineConfig } from "vite"
import appPlugin from "@opencode-ai/app/vite"

// Renderer-only build for the Tauri shell. The Electron build keeps using
// electron.vite.config.ts; this config produces the static assets served by
// `frontendDist` (src-tauri/web-dist).
export default defineConfig({
  plugins: [appPlugin],
  publicDir: "../../../app/public",
  root: "src/renderer",
  build: {
    // Tauri embeds `frontendDist` into the binary at compile time, so shipping source maps
    // added ~47 MB to every build. Keep them for debug builds (tauri dev sets
    // TAURI_ENV_DEBUG, and the local staging script sets it too) and drop them otherwise.
    sourcemap: process.env.TAURI_ENV_DEBUG === "true",
    outDir: "../../src-tauri/web-dist",
    emptyOutDir: true,
  },
})
