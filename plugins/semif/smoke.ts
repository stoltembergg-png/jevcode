const mod = await import("./index.ts")
const def = mod.default
if (typeof def !== "object" || def.id !== "semif" || typeof def.server !== "function") {
  console.error("BAD default export"); process.exit(1)
}
const hooks = await def.server(
  { client: {} as any, project: { id: "test" } as any, directory: process.cwd(), worktree: process.cwd(), serverUrl: new URL("http://127.0.0.1:8817"), $: {} as any },
  { mode: "lazy", modelPath: "", serverPath: "" },
)
console.log("keys:", Object.keys(hooks))
console.log("tools:", Object.keys((hooks as any).tool ?? {}))
const st = await hooks.tool.semif_status.execute({}, { sessionID: "t", messageID: "t", agent: "t", directory: process.cwd(), worktree: process.cwd(), abort: new AbortController().signal, metadata: async () => ({}), ask: async () => {} } as any)
console.log("status tool:", st.output.slice(0, 300))
if (hooks.tool.semif_decide && hooks.tool.semif_decide.args && hooks.tool.semif_decide.description) console.log("tool shape ok (args+description+execute)")
if (typeof hooks.dispose === "function") await hooks.dispose()
console.log("SMOKE OK")
