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
    sourcemap: true,
    outDir: "../../src-tauri/web-dist",
    emptyOutDir: true,
  },
})
