import type { Part as PartType, ToolPart } from "@opencode-ai/sdk/v2"

const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])

export type PartRef = {
  messageID: string
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }
  | {
      key: string
      type: "edit"
      refs: PartRef[]
    }

export function isContextGroupTool(part: PartType): part is ToolPart {
  return part.type === "tool" && CONTEXT_GROUP_TOOLS.has(part.tool)
}

function isEditTool(part: PartType): part is ToolPart {
  return part.type === "tool" && part.tool === "edit"
}

export type EditFileDiff = {
  file: string
  additions: number
  deletions: number
}

export function editFileDiff(part: ToolPart): EditFileDiff | undefined {
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  if (!metadata) return
  const filediff = metadata.filediff
  if (!filediff || typeof filediff !== "object") return
  return {
    file: "file" in filediff && typeof filediff.file === "string" ? filediff.file : "",
    additions: "additions" in filediff && typeof filediff.additions === "number" ? filediff.additions : 0,
    deletions: "deletions" in filediff && typeof filediff.deletions === "number" ? filediff.deletions : 0,
  }
}

// Edits are grouped by the file they touch, so the effective path has to resolve
// the same way the edit row does: metadata first, then the tool input.
export function editFilePath(part: ToolPart): string {
  const file = editFileDiff(part)?.file
  if (file) return file
  const value = part.state.input?.filePath
  if (typeof value === "string" && value) return value
  return ""
}

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (b.type === "part") return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]!))
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]!))
}

export function groupParts(parts: { messageID: string; part: PartType }[]) {
  const result: PartGroup[] = []
  let contextStart = -1
  let editStart = -1
  let editFile: string | undefined

  const ref = (item: { messageID: string; part: PartType }): PartRef => ({
    messageID: item.messageID,
    partID: item.part.id,
  })

  const flush = (end: number) => {
    if (contextStart >= 0) {
      const first = parts[contextStart]
      const last = parts[end]
      if (first && last) {
        result.push({
          key: `context:${first.part.id}`,
          type: "context",
          refs: parts.slice(contextStart, end + 1).map(ref),
        })
      }
      contextStart = -1
    }

    if (editStart >= 0) {
      const first = parts[editStart]
      const refs = parts.slice(editStart, end + 1).map(ref)
      // A lone edit keeps the plain row; a run of two or more to the same file
      // collapses into one card so consecutive edits stop flooding the timeline.
      if (first && refs.length >= 2) {
        result.push({
          key: `edit:${first.part.id}`,
          type: "edit",
          refs,
        })
      } else if (first && refs[0]) {
        result.push({
          key: `part:${first.messageID}:${first.part.id}`,
          type: "part",
          ref: refs[0],
        })
      }
      editStart = -1
      editFile = undefined
    }
  }

  parts.forEach((item, index) => {
    if (isContextGroupTool(item.part)) {
      if (contextStart < 0) {
        flush(index - 1)
        contextStart = index
      }
      return
    }

    if (isEditTool(item.part)) {
      const file = editFilePath(item.part)
      if (editStart < 0) {
        flush(index - 1)
        editStart = index
        editFile = file
        return
      }
      if (file !== editFile) {
        flush(index - 1)
        editStart = index
        editFile = file
      }
      return
    }

    flush(index - 1)
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: ref(item),
    })
  })

  flush(parts.length - 1)
  return result
}
