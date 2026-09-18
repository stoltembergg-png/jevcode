import type { UiI18nKey } from "@opencode-ai/ui/context/i18n"

// The shell tool input only carries the raw `command`. Surfacing that command in
// the timeline pollutes the conversation, so the collapsed row shows a short,
// translated action derived from the command's leading verb instead. The raw
// command (and its output) only render in the expanded body.
const MAX_TARGET_LENGTH = 48
const QUOTES = new Set(['"', "'"])

export type ShellCommandSummary = {
  key: UiI18nKey
  params?: Record<string, string>
  target?: string
}

// Commands that only navigate or echo output never describe real work: they are
// dropped so the label comes from the first command that actually does something.
const NOISE_COMMANDS = new Set(["cd", "echo", "write-output", "write-host", "printf", "clear", "cls", ":", "true", "false"])

const SEARCH_COMMANDS = new Set(["rg", "ripgrep", "grep", "egrep", "fgrep", "findstr", "select-string", "ack", "ag"])
const LIST_COMMANDS = new Set(["ls", "dir", "get-childitem", "gci", "tree", "find", "fd", "locate", "get-item"])
const READ_COMMANDS = new Set(["cat", "get-content", "gc", "type", "head", "tail", "less", "more", "bat"])
const TEST_COMMANDS = new Set(["test", "jest", "vitest", "mocha", "ava", "playwright", "cypress", "pytest", "rspec", "phpunit"])
const BUILD_COMMANDS = new Set([
  "build",
  "tsc",
  "make",
  "cmake",
  "ninja",
  "esbuild",
  "rollup",
  "webpack",
  "msbuild",
  "xcodebuild",
])
const FETCH_COMMANDS = new Set(["curl", "wget", "fetch", "aria2c", "invoke-webrequest", "iwr", "invoke-restmethod", "irm"])
const INSTALL_COMMANDS = new Set(["install", "pip", "pip3", "poetry", "composer"])
const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn", "npx", "bunx"])
const RUNTIMES = new Set(["go", "cargo", "dotnet", "deno"])
const PYTHONS = new Set(["python", "python3", "py"])

// Flags whose value is the next token, used only when locating a subcommand or
// script name. The value is dropped so it is not mistaken for the verb.
const GIT_VALUE_FLAGS = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"])
const PACKAGE_VALUE_FLAGS = new Set(["-c", "-w", "--cwd", "--filter", "--prefix", "--workspace"])

export function summarizeShellCommand(command: string | undefined): ShellCommandSummary | undefined {
  const text = (command ?? "").replace(/\r\n?/g, "\n").trim()
  if (!text) return undefined

  const segment = text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap(splitSegments)
    .map((value) => value.trim())
    .find((value) => value.length > 0 && !isNoise(value))
  if (!segment) return undefined

  const argv = tokens(cutRedirect(segment)).filter((token) => token !== "&" && token !== "\\")
  const name = commandName(argv)
  if (!name) return undefined

  const args = argv.slice(1)
  const action = resolveAction(name, args)
  const target = findTarget(args)
  return target ? { ...action, target } : action
}

function isNoise(segment: string): boolean {
  const name = commandName(tokens(cutRedirect(segment)).filter((token) => token !== "&" && token !== "\\"))
  return !name || NOISE_COMMANDS.has(name)
}

// The first token, reduced to its program name: `/usr/bin/rg`, `./bin/vitest`,
// and `C:\tools\git.exe` all become `rg`, `vitest`, and `git`.
function commandName(argv: string[]): string | undefined {
  const raw = argv[0]
  if (!raw) return undefined
  const base = stripQuotes(raw).replace(/\\/g, "/").split("/").pop() ?? ""
  const name = base.replace(/\.(exe|cmd|bat|ps1|sh)$/i, "").toLowerCase()
  return name || undefined
}

function resolveAction(name: string, args: string[]): ShellCommandSummary {
  if (SEARCH_COMMANDS.has(name)) return { key: "ui.tool.shell.action.search" }
  if (LIST_COMMANDS.has(name)) return { key: "ui.tool.shell.action.list" }
  if (READ_COMMANDS.has(name)) return { key: "ui.tool.shell.action.read" }
  if (FETCH_COMMANDS.has(name)) return { key: "ui.tool.shell.action.fetch" }
  if (INSTALL_COMMANDS.has(name)) return { key: "ui.tool.shell.action.install" }
  if (TEST_COMMANDS.has(name)) return { key: "ui.tool.shell.action.test" }
  if (BUILD_COMMANDS.has(name)) return { key: "ui.tool.shell.action.build" }
  if (name === "git") return gitAction(args)
  if (PACKAGE_MANAGERS.has(name)) return packageAction(name, args)
  if (RUNTIMES.has(name)) return runtimeAction(args)
  if (PYTHONS.has(name)) return pythonAction(args)
  return { key: "ui.tool.shell.action.command" }
}

function gitAction(args: string[]): ShellCommandSummary {
  const verb = positional(args, GIT_VALUE_FLAGS)[0]?.toLowerCase()
  if (!verb) return { key: "ui.tool.shell.action.command" }
  return { key: "ui.tool.shell.action.git", params: { verb } }
}

function packageAction(name: string, args: string[]): ShellCommandSummary {
  const positionalArgs = positional(args, PACKAGE_VALUE_FLAGS)
  const sub = positionalArgs[0]?.toLowerCase()
  // `bun` with no arguments runs the default install/run behavior.
  if (!sub) return name === "yarn" ? { key: "ui.tool.shell.action.install" } : { key: "ui.tool.shell.action.command" }

  const script = sub === "run" || sub === "exec" || sub === "dlx" ? positionalArgs[1]?.toLowerCase() : undefined
  if (sub === "test" || isTest(script)) return { key: "ui.tool.shell.action.test" }
  if (sub === "build" || isBuild(script)) return { key: "ui.tool.shell.action.build" }
  if (INSTALL_SUBCOMMANDS.has(sub) || isInstall(sub)) return { key: "ui.tool.shell.action.install" }
  if (isTest(sub)) return { key: "ui.tool.shell.action.test" }
  if (isBuild(sub)) return { key: "ui.tool.shell.action.build" }
  return { key: "ui.tool.shell.action.command" }
}

const INSTALL_SUBCOMMANDS = new Set(["install", "i", "ci", "add", "update", "up"])

function runtimeAction(args: string[]): ShellCommandSummary {
  const sub = positional(args, new Set())[0]?.toLowerCase()
  if (sub === "test") return { key: "ui.tool.shell.action.test" }
  if (sub === "build") return { key: "ui.tool.shell.action.build" }
  if (sub === "install" || sub === "get" || sub === "add") return { key: "ui.tool.shell.action.install" }
  return { key: "ui.tool.shell.action.command" }
}

function pythonAction(args: string[]): ShellCommandSummary {
  if (args[0] !== "-m") return { key: "ui.tool.shell.action.command" }
  const module = args[1]?.toLowerCase()
  if (!module) return { key: "ui.tool.shell.action.command" }
  if (TEST_COMMANDS.has(module)) return { key: "ui.tool.shell.action.test" }
  if (BUILD_COMMANDS.has(module) || module === "build") return { key: "ui.tool.shell.action.build" }
  if (module === "pip") return { key: "ui.tool.shell.action.install" }
  return { key: "ui.tool.shell.action.command" }
}

function isTest(value: string | undefined): value is string {
  if (!value) return false
  return value === "test" || value.startsWith("test:") || value.startsWith("test-") || value.includes("test")
}

function isBuild(value: string | undefined): value is string {
  if (!value) return false
  return BUILD_COMMANDS.has(value) || value.startsWith("build:") || value.startsWith("build-") || value.includes("build")
}

function isInstall(value: string): boolean {
  return INSTALL_COMMANDS.has(value)
}

// A clean, meaningful target: a path or filename, never a flag, pattern, URL,
// or the argument soup the raw command carries.
function findTarget(args: string[]): string | undefined {
  for (const raw of args) {
    const token = stripQuotes(raw)
    if (!pathLike(token)) continue
    return clampTarget(token)
  }
  return undefined
}

function pathLike(token: string): boolean {
  if (!token || token.startsWith("-")) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false
  if (/[|*?<>\s]/.test(token)) return false
  if (token === "..." || token.endsWith("/...") || token.endsWith("\\...")) return false
  if (token.includes("/") || token.includes("\\")) return true
  return /^[\w@~.+-]+\.[A-Za-z0-9]{1,8}$/.test(token)
}

function clampTarget(value: string): string {
  const collapsed = collapse(value)
  if (collapsed.length <= MAX_TARGET_LENGTH) return collapsed
  return `${collapsed.slice(0, MAX_TARGET_LENGTH - 1).trimEnd()}…`
}

// Drops flags and the value of value-taking flags, leaving positional tokens.
function positional(args: string[], valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = []
  let literal = false
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!
    if (!literal && token === "--") {
      literal = true
      continue
    }
    if (!literal && token.startsWith("-") && token !== "-") {
      if (valueFlags.has(token.toLowerCase())) index++
      continue
    }
    out.push(token)
  }
  return out
}

function stripQuotes(token: string): string {
  if (token.length >= 2 && QUOTES.has(token[0]!) && token.at(-1) === token[0]) return token.slice(1, -1)
  return token
}

// Cut at a redirection so `git diff > out.txt` does not look like it targets a file.
function cutRedirect(input: string): string {
  let quote: string | undefined
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!
    if (quote) {
      if (char === "\\" && quote === '"') {
        index++
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (QUOTES.has(char)) {
      quote = char
      continue
    }
    if (char === "\\") {
      index++
      continue
    }
    if (char === ">" || char === "<") return input.slice(0, index).replace(/\s*\d+$/, "")
  }
  return input
}

// Split on `;`, `&&`, `||`, and `|` without breaking quoted arguments.
function splitSegments(input: string): string[] {
  const segments: string[] = []
  let current = ""
  let quote: string | undefined
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!
    if (quote) {
      current += char
      if (char === "\\" && quote === '"') {
        if (index + 1 < input.length) current += input[++index]
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (QUOTES.has(char)) {
      quote = char
      current += char
      continue
    }
    if (char === "\\") {
      current += char
      if (index + 1 < input.length) current += input[++index]
      continue
    }
    const pair = input.slice(index, index + 2)
    if (pair === "&&" || pair === "||") {
      segments.push(current)
      current = ""
      index++
      continue
    }
    if (char === ";" || char === "|") {
      segments.push(current)
      current = ""
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

function tokens(input: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: string | undefined
  let started = false
  const push = () => {
    if (!started) return
    out.push(current)
    current = ""
    started = false
  }
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!
    if (quote) {
      current += char
      started = true
      if (char === "\\" && quote === '"') {
        if (index + 1 < input.length) current += input[++index]
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (QUOTES.has(char)) {
      quote = char
      current += char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    current += char
    started = true
  }
  push()
  return out
}

function collapse(input: string): string {
  return input.replace(/\s+/g, " ").trim()
}
