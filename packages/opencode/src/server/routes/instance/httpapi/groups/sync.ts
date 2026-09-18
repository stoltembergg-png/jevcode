import { NonNegativeInt } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/sync"
export const ReplayEvent = Schema.Struct({
  id: EventV2.ID,
  aggregateID: Schema.String,
  seq: NonNegativeInt,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})
export const ReplayPayload = Schema.Struct({
  directory: Schema.String,
  events: Schema.NonEmptyArray(ReplayEvent),
})
export const ReplayResponse = Schema.Struct({
  sessionID: Schema.String,
})
export const SessionPayload = Schema.Struct({
  sessionID: SessionID,
})
export const HistoryPayload = Schema.Record(Schema.String, NonNegativeInt)
export const HistoryEvent = Schema.Struct({
  id: EventV2.ID,
  aggregate_id: Schema.String,
  seq: NonNegativeInt,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})
export const StorageTable = Schema.Struct({
  name: Schema.String,
  bytes: Schema.Number,
})
export const StorageStatus = Schema.Struct({
  fileBytes: Schema.Number,
  tables: Schema.Array(StorageTable),
})
export const CompactPayload = Schema.Struct({
  vacuum: Schema.optional(Schema.Boolean),
})
export const CompactResponse = Schema.Struct({
  done: Schema.Boolean,
  fileBytes: Schema.Number,
})
export const StoragePaths = {
  storage: `${root}/storage`,
  compact: `${root}/compact`,
} as const

export const SyncPaths = {
  start: `${root}/start`,
  replay: `${root}/replay`,
  steal: `${root}/steal`,
  history: `${root}/history`,
  storage: `${root}/storage`,
  compact: `${root}/compact`,
} as const

export const SyncApi = HttpApi.make("sync")
  .add(
    HttpApiGroup.make("sync")
      .add(
        HttpApiEndpoint.post("start", SyncPaths.start, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Workspace sync started"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.start",
            summary: "Start workspace sync",
            description: "Start sync loops for workspaces in the current project that have active sessions.",
          }),
        ),
        HttpApiEndpoint.post("replay", SyncPaths.replay, {
          query: WorkspaceRoutingQuery,
          payload: ReplayPayload,
          success: described(ReplayResponse, "Replayed sync events"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.replay",
            summary: "Replay sync events",
            description: "Validate and replay a complete sync event history.",
          }),
        ),
        HttpApiEndpoint.post("steal", SyncPaths.steal, {
          query: WorkspaceRoutingQuery,
          payload: SessionPayload,
          success: described(SessionPayload, "Session stolen into workspace"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.steal",
            summary: "Steal session into workspace",
            description: "Update a session to belong to the current workspace through the sync event system.",
          }),
        ),
        HttpApiEndpoint.post("history", SyncPaths.history, {
          query: WorkspaceRoutingQuery,
          payload: HistoryPayload,
          success: described(Schema.Array(HistoryEvent), "Sync events"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.history.list",
            summary: "List sync events",
            description:
              "List sync events for all aggregates. Keys are aggregate IDs the client already knows about, values are the last known sequence ID. Events with seq > value are returned for those aggregates. Aggregates not listed in the input get their full history, capped at 10,000 events per response — continue by adding the last known sequences to the payload.",
          }),
        ),
        HttpApiEndpoint.get("storage", SyncPaths.storage, {
          query: WorkspaceRoutingQuery,
          success: described(StorageStatus, "Database storage status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.storage.status",
            summary: "Database storage status",
            description: "Total file size and per-table breakdown of the server database.",
          }),
        ),
        HttpApiEndpoint.post("compact", SyncPaths.compact, {
          query: WorkspaceRoutingQuery,
          payload: CompactPayload,
          success: described(CompactResponse, "Database compacted"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.storage.compact",
            summary: "Compact database storage",
            description: "Checkpoint the WAL, remove orphaned events, and optionally run VACUUM to reclaim disk space.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "sync",
          description: "Experimental HttpApi sync routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "NextCode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
