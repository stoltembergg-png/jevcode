import { Workspace } from "@/control-plane/workspace"
import * as InstanceState from "@/effect/instance-state"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventTable } from "@opencode-ai/core/event/sql"
import { asc } from "drizzle-orm"
import { and } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { lte } from "drizzle-orm"
import { not } from "drizzle-orm"
import { or } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { Duration, Effect, Schedule, Scope } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { HistoryPayload, ReplayPayload, SessionPayload, StorageStatus, CompactPayload, CompactResponse } from "../groups/sync"

// Server-side cap for a single history response: clients page incrementally through
// the payload cursor instead of ever streaming the whole event log at once.
const SYNC_HISTORY_LIMIT = 10_000

export const syncHandlers = HttpApiBuilder.group(InstanceHttpApi, "sync", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const session = yield* Session.Service
    const scope = yield* Scope.Scope
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    // Server-side storage maintenance: keep the WAL from growing unbounded, refresh the
    // query planner stats, and remove events for aggregates that no longer have a session.
    // Runs once shortly after the server is ready, then every 24 hours.
    const runMaintenance = Effect.fn("SyncHttpApi.maintenance")(function* () {
      yield* Effect.sleep(Duration.seconds(30))
      yield* db.run(sql`DELETE FROM event WHERE aggregate_id NOT IN (SELECT id FROM session)`)
      yield* db.run(sql`DELETE FROM event_sequence WHERE aggregate_id NOT IN (SELECT id FROM session)`)
      yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)")
      yield* db.run("PRAGMA optimize")
    })

    // WAL hygiene at boot, then periodic maintenance in a background fiber.
    yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.ignore)
    yield* Effect.forkIn(
      scope,
      runMaintenance().pipe(
        Effect.repeat(Schedule.spaced(Duration.hours(24))),
        Effect.ignore,
      ),
    )

    const start = Effect.fn("SyncHttpApi.start")(function* () {
      yield* workspace
        .startWorkspaceSyncing((yield* InstanceState.context).project.id)
        .pipe(Effect.ignore, Effect.forkIn(scope))
      return true
    })

    const replay = Effect.fn("SyncHttpApi.replay")(function* (ctx: { payload: typeof ReplayPayload.Type }) {
      const payload: EventV2.SerializedEvent[] = ctx.payload.events.map((event) => ({
        id: event.id,
        aggregateID: event.aggregateID,
        seq: event.seq,
        type: event.type,
        data: { ...event.data },
      }))
      const source = payload[0].aggregateID
      yield* Effect.logInfo("sync replay requested", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
        directory: ctx.payload.directory,
      })
      const ownerID = yield* InstanceState.workspaceID
      yield* events.replayAll(payload, { ownerID, strictOwner: true })
      yield* Effect.logInfo("sync replay complete", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
      })
      return { sessionID: source }
    })

    const steal = Effect.fn("SyncHttpApi.steal")(function* (ctx: { payload: typeof SessionPayload.Type }) {
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID) return yield* new HttpApiError.BadRequest({})

      yield* session.setWorkspace({ sessionID: ctx.payload.sessionID, workspaceID })

      yield* Effect.logInfo("sync session stolen", { sessionID: ctx.payload.sessionID, workspaceID })

      return { sessionID: ctx.payload.sessionID }
    })

    const history = Effect.fn("SyncHttpApi.history")(function* (ctx: { payload: typeof HistoryPayload.Type }) {
      const exclude = Object.entries(ctx.payload)
      return yield* db
        .select()
        .from(EventTable)
        .where(
          exclude.length > 0
            ? not(or(...exclude.map(([id, seq]) => and(eq(EventTable.aggregate_id, id), lte(EventTable.seq, seq))))!)
            : undefined,
        )
        .orderBy(asc(EventTable.seq))
        // Server-side cap so an unknown aggregate can never stream the whole event log in
        // one response; clients continue incrementally with the payload cursor.
        .limit(SYNC_HISTORY_LIMIT)
        .all()
        .pipe(Effect.orDie)
    })

    const storage = Effect.fn("SyncHttpApi.storage")(function* () {
      const dbPath = Database.path()
      const fileBytes = yield* Effect.promise(() => Bun.file(dbPath).size).pipe(Effect.orDie)
      const tables = yield* db.all<{ name: string; bytes: number }>(
        sql`SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 10`,
      ).pipe(Effect.orDie)
      return { fileBytes, tables }
    })

    const compact = Effect.fn("SyncHttpApi.compact")(function* (ctx: { payload: typeof CompactPayload.Type }) {
      yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.ignore)
      if (ctx.payload.vacuum) {
        yield* db.run("VACUUM").pipe(Effect.ignore)
      }
      yield* db.run("PRAGMA optimize").pipe(Effect.ignore)
      const dbPath = Database.path()
      const fileBytes = yield* Effect.promise(() => Bun.file(dbPath).size).pipe(Effect.orDie)
      return { fileBytes, done: true }
    })

    return handlers.handle("start", start).handle("replay", replay).handle("steal", steal).handle("history", history).handle("storage", storage).handle("compact", compact)
  }),
)
