import { describe, expect, test } from "bun:test"
import type { Part as PartType } from "@opencode-ai/sdk/v2"
import { groupParts, sameGroups } from "./message-part-groups"

describe("groupParts edits", () => {
  test("groups six consecutive edits to the same file into one card", () => {
    const parts = Array.from({ length: 6 }, (_, index) => ({
      messageID: "message",
      part: editPart(`part_${index}`, "src/dv.ts"),
    }))

    const groups = groupParts(parts)

    expect(groups).toHaveLength(1)
    expect(groups[0]).toEqual({
      key: "edit:part_0",
      type: "edit",
      refs: Array.from({ length: 6 }, (_, index) => ({ messageID: "message", partID: `part_${index}` })),
    })
  })

  test("keeps a lone edit as a plain part row", () => {
    const groups = groupParts([{ messageID: "message", part: editPart("part_0", "src/dv.ts") }])

    expect(groups).toHaveLength(1)
    expect(groups[0]).toEqual({
      key: "part:message:part_0",
      type: "part",
      ref: { messageID: "message", partID: "part_0" },
    })
  })

  test("does not merge edits that target different files", () => {
    const groups = groupParts([
      { messageID: "message", part: editPart("part_0", "src/dv.ts") },
      { messageID: "message", part: editPart("part_1", "src/other.ts") },
    ])

    expect(groups.map((group) => group.type)).toEqual(["part", "part"])
  })

  test("does not merge edits separated by another part", () => {
    const groups = groupParts([
      { messageID: "message", part: editPart("part_0", "src/dv.ts") },
      { messageID: "message", part: textPart("part_1") },
      { messageID: "message", part: editPart("part_2", "src/dv.ts") },
    ])

    expect(groups.map((group) => group.type)).toEqual(["part", "part", "part"])
  })

  test("resolves the file from metadata before the input", () => {
    const groups = groupParts([
      { messageID: "message", part: editPart("part_0", "src/dv.ts") },
      { messageID: "message", part: editPart("part_1", "src/../src/dv.ts", "src/dv.ts") },
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.type).toBe("edit")
  })

  test("keeps grouping context tools", () => {
    const groups = groupParts([
      { messageID: "message", part: toolPart("read", "part_0") },
      { messageID: "message", part: toolPart("grep", "part_1") },
      { messageID: "message", part: editPart("part_2", "src/dv.ts") },
      { messageID: "message", part: editPart("part_3", "src/dv.ts") },
    ])

    expect(groups.map((group) => group.type)).toEqual(["context", "edit"])
  })

  test("sameGroups treats equal edit runs as equal", () => {
    const parts = [
      { messageID: "message", part: editPart("part_0", "src/dv.ts") },
      { messageID: "message", part: editPart("part_1", "src/dv.ts") },
    ]

    expect(sameGroups(groupParts(parts), groupParts(parts))).toBe(true)
  })
})

function toolPart(tool: string, id: string): PartType {
  return {
    id,
    sessionID: "session",
    messageID: "message",
    type: "tool",
    callID: `call_${id}`,
    tool,
    state: {
      status: "completed",
      input: {},
      output: "",
      title: tool,
      metadata: {},
      time: { start: 0, end: 1 },
    },
  }
}

function editPart(id: string, filePath: string, metadataFile?: string): PartType {
  return {
    id,
    sessionID: "session",
    messageID: "message",
    type: "tool",
    callID: `call_${id}`,
    tool: "edit",
    state: {
      status: "completed",
      input: { filePath },
      output: "",
      title: "edit",
      metadata: { filediff: { file: metadataFile ?? filePath, additions: 1, deletions: 0 } },
      time: { start: 0, end: 1 },
    },
  }
}

function textPart(id: string): PartType {
  return {
    id,
    sessionID: "session",
    messageID: "message",
    type: "text",
    text: "thinking",
  }
}
