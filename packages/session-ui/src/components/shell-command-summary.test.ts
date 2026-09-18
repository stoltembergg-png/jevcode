import { describe, expect, test } from "bun:test"
import { dict as en } from "@opencode-ai/ui/i18n/en"
import { summarizeShellCommand, type ShellCommandSummary } from "./shell-command-summary"

describe("summarizeShellCommand", () => {
  // Real commands from the reported timeline, including the long rg,
  // Get-ChildItem, and Get-Content pipelines.
  const cases: Array<{ name: string; command: string | undefined; expected: ShellCommandSummary | undefined }> = [
    {
      name: "long rg pipeline picks the first searched path",
      command: `rg -l -i "bash|shell" packages/session-ui/src packages/app/src/pages/session packages/app/src/components/session --glob '!**/node_modules/**'`,
      expected: { key: "ui.tool.shell.action.search", target: "packages/session-ui/src" },
    },
    {
      name: "echo noise plus a call-operator rg",
      command: `Write-Output "=== --motion-* ==="; & rg -l -- '--motion-fast' packages/desktop`,
      expected: { key: "ui.tool.shell.action.search", target: "packages/desktop" },
    },
    {
      name: "Get-ChildItem into Select-String",
      command: `Get-ChildItem packages/session-ui/src -Recurse -Filter *.ts | Select-String -Pattern "motion" | Select-Object -First 20`,
      expected: { key: "ui.tool.shell.action.list", target: "packages/session-ui/src" },
    },
    {
      name: "Get-Content with a total-count flag",
      command: `Get-Content packages/desktop/src/renderer/main.tsx -TotalCount 80`,
      expected: { key: "ui.tool.shell.action.read", target: "packages/desktop/src/renderer/main.tsx" },
    },
    {
      name: "quoted path stays a clean target",
      command: `Get-Content "src/tool/shell.ts"`,
      expected: { key: "ui.tool.shell.action.read", target: "src/tool/shell.ts" },
    },
    {
      name: "glob pattern is not a target",
      command: `rg --files -g '*.ts' | head -20`,
      expected: { key: "ui.tool.shell.action.search" },
    },
    {
      name: "cat heredoc",
      command: `cat <<'EOF'`,
      expected: { key: "ui.tool.shell.action.read" },
    },
    {
      name: "ls flags are dropped",
      command: `ls -la`,
      expected: { key: "ui.tool.shell.action.list" },
    },
    {
      name: "uses only the first non-empty line",
      command: `\n  ls -la\nsecond line`,
      expected: { key: "ui.tool.shell.action.list" },
    },
    {
      name: "leading cd is noise",
      command: `cd /repo && npm run build --silent`,
      expected: { key: "ui.tool.shell.action.build" },
    },
    {
      name: "redirect and pipe around npm test",
      command: `npm test 2>&1 | tail -5`,
      expected: { key: "ui.tool.shell.action.test" },
    },
    {
      name: "bun install",
      command: `bun install`,
      expected: { key: "ui.tool.shell.action.install" },
    },
    {
      name: "bun test with a path",
      command: `bun test src/components`,
      expected: { key: "ui.tool.shell.action.test", target: "src/components" },
    },
    {
      name: "bun run build script",
      command: `bun run build:renderer-tauri`,
      expected: { key: "ui.tool.shell.action.build" },
    },
    {
      name: "build with a cwd flag",
      command: `bun run --cwd packages/desktop build:renderer-tauri`,
      expected: { key: "ui.tool.shell.action.build", target: "packages/desktop" },
    },
    {
      name: "git status is verb-aware",
      command: `git status`,
      expected: { key: "ui.tool.shell.action.git", params: { verb: "status" } },
    },
    {
      name: "git diff redirect does not target the output file",
      command: `git diff --stat > out.txt`,
      expected: { key: "ui.tool.shell.action.git", params: { verb: "diff" } },
    },
    {
      name: "git value flags are skipped when finding the verb",
      command: `git -C packages/app status`,
      expected: { key: "ui.tool.shell.action.git", params: { verb: "status" }, target: "packages/app" },
    },
    {
      name: "a URL is not a target",
      command: `curl https://example.com/status.json`,
      expected: { key: "ui.tool.shell.action.fetch" },
    },
    {
      name: "pytest with a path",
      command: `pytest tests/unit -q`,
      expected: { key: "ui.tool.shell.action.test", target: "tests/unit" },
    },
    {
      name: "tsc is a build",
      command: `tsc --noEmit`,
      expected: { key: "ui.tool.shell.action.build" },
    },
    {
      name: "go test package wildcard is not a target",
      command: `go test ./packages/...`,
      expected: { key: "ui.tool.shell.action.test" },
    },
    {
      name: "python -m pytest",
      command: `python -m pytest tests/unit`,
      expected: { key: "ui.tool.shell.action.test", target: "tests/unit" },
    },
    {
      name: "unknown command falls back safely",
      command: `mkdir -p packages/new`,
      expected: { key: "ui.tool.shell.action.command", target: "packages/new" },
    },
    {
      name: "echo alone is skipped",
      command: `echo hello`,
      expected: undefined,
    },
    {
      name: "Write-Output alone is skipped",
      command: `Write-Output "done"`,
      expected: undefined,
    },
    {
      name: "empty input",
      command: `   \n  `,
      expected: undefined,
    },
    {
      name: "undefined input",
      command: undefined,
      expected: undefined,
    },
  ]

  for (const { name, command, expected } of cases) {
    test(name, () => {
      expect(summarizeShellCommand(command)).toEqual(expected)
    })
  }

  test("clamps a long target", () => {
    const summary = summarizeShellCommand(
      `rg --files packages/very-long-directory-name/another-long-directory-name/deeper-directory`,
    )
    expect(summary?.key).toBe("ui.tool.shell.action.search")
    expect(summary?.target?.length).toBeLessThanOrEqual(48)
    expect(summary?.target?.endsWith("…")).toBe(true)
  })

  test("never leaks the raw command text", () => {
    const summary = summarizeShellCommand(
      `rg -l -i "bash|shell" packages/session-ui/src --glob '!**/node_modules/**'`,
    )
    expect(JSON.stringify(summary)).not.toContain("bash|shell")
    expect(JSON.stringify(summary)).not.toContain("--glob")
    expect(JSON.stringify(summary)).not.toContain("node_modules")
  })
})

describe("shell action labels", () => {
  const resolve = (command: string) => {
    const summary = summarizeShellCommand(command)
    if (!summary) return undefined
    const template = en[summary.key]
    const text = summary.params
      ? template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, key) => String(summary.params?.[key] ?? ""))
      : template
    return summary.target ? `${text} \u00B7 ${summary.target}` : text
  }

  test("renders human labels for the reported commands", () => {
    expect(
      resolve(
        `rg -l -i "bash|shell" packages/session-ui/src packages/app/src/pages/session packages/app/src/components/session --glob '!**/node_modules/**'`,
      ),
    ).toBe("Searching files \u00B7 packages/session-ui/src")
    expect(resolve(`Get-ChildItem packages/session-ui/src -Recurse -Filter *.ts`)).toBe(
      "Listing files \u00B7 packages/session-ui/src",
    )
    expect(resolve(`Get-Content packages/desktop/src/renderer/main.tsx -TotalCount 80`)).toBe(
      "Reading files \u00B7 packages/desktop/src/renderer/main.tsx",
    )
    expect(resolve(`git status`)).toBe("Running git status")
    expect(resolve(`bun run --cwd packages/desktop build:renderer-tauri`)).toBe("Building \u00B7 packages/desktop")
    expect(resolve(`bun test src/components`)).toBe("Running tests \u00B7 src/components")
  })
})
