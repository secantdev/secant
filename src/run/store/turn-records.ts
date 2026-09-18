import { and, asc, count, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import {
  harnessSessions,
  transcriptEntries,
  turnEvents,
  turns,
} from "./run-schema.js";
import type {
  AdmitTurnRequest,
  AppendTurnEventRequest,
  HarnessSessionRecord,
  SequencedTranscriptEntry,
  SettleTurnRequest,
  TranscriptEntryRecord,
  TranscriptPage,
  TranscriptPageRequest,
  TurnEventRecord,
  TurnRecord,
} from "./store.js";

// The Turn, Session, Turn-event and transcript records of one Run (#116): the four
// Turn-side `run.db` tables and every read and write against them. A private
// submodule of the Run Store (A32). Nothing here consults the fence: every function
// is a plain write or read against the handle it is given. The `RunOwner` members
// that call in here keep their names and keep the fencing re-check; the one other
// caller, the startup reconciler's `settleAbandonedTurns`, runs before any owner is
// acquired and is deliberately unfenced.

const turnRow = z.object({
  turn_id: z.string(),
  attempt_id: z.string(),
  session_key: z.string(),
  origin: z.string(),
  kind: z.string().nullable(),
  sequence: z.number(),
  input: z.string(),
  admitted_at: z.string(),
  result_kind: z.string().nullable(),
  result_detail: z.string().nullable(),
  settled_at: z.string().nullable(),
});
const turnEventRow = z.object({
  turn_id: z.string(),
  kind: z.string(),
  payload: z.string(),
  at: z.string(),
});
const harnessSessionRow = z.object({
  session_key: z.string(),
  availability: z.string(),
  availability_detail: z.string().nullable(),
});
const transcriptRow = z.object({
  session_key: z.string(),
  turn_id: z.string(),
  role: z.string(),
  content: z.string(),
  at: z.string(),
});
const sequencedTranscriptRow = transcriptRow.extend({ seq: z.number() });

// Admit a Turn (#116): the `turn` row is written before the stdin frame is sent
// (the durable admission the Adapter awaits), the named Session is upserted `open`,
// and the rendered input is appended as a `user` transcript entry — all or nothing,
// so a crash cannot leave a Turn admitted without its Session or transcript.
export function admitTurn(
  db: SQLiteBunDatabase,
  request: AdmitTurnRequest,
): void {
  const at = request.at.toISOString();
  db.transaction((tx) => {
    // The Turn's position in the Run, computed under the write lock so it never
    // races and the executor never re-reads every Turn row per admission. Turns are
    // append-only, so the count is the next zero-based sequence.
    const sequence =
      tx.select({ value: count() }).from(turns).get()?.value ?? 0;
    tx.insert(harnessSessions)
      .values({
        session_key: request.session,
        native_session_id: request.recoveryCoordinate,
        availability: "open",
        availability_detail: null,
        harness: request.harness,
        profile_digest: null,
        created_at: at,
        updated_at: at,
      })
      .onConflictDoUpdate({
        target: harnessSessions.session_key,
        set: {
          native_session_id: request.recoveryCoordinate,
          availability: "open",
          availability_detail: null,
          updated_at: at,
        },
      })
      .run();
    tx.insert(turns)
      .values({
        turn_id: request.turnId,
        attempt_id: request.attemptId,
        session_key: request.session,
        origin: request.origin,
        kind: request.kind,
        sequence,
        input: request.input,
        admitted_at: at,
        result_kind: null,
        result_detail: null,
        settled_at: null,
      })
      .run();
    tx.insert(transcriptEntries)
      .values({
        session_key: request.session,
        turn_id: request.turnId,
        role: "user",
        content: request.input,
        at,
      })
      .run();
  });
}

// Append one normalized durable Turn event (#116), append-only.
export function appendTurnEvent(
  db: SQLiteBunDatabase,
  request: AppendTurnEventRequest,
): void {
  db.insert(turnEvents)
    .values({
      turn_id: request.turnId,
      kind: request.kind,
      payload: request.payload,
      at: request.at.toISOString(),
    })
    .run();
}

// Settle a Turn (#116): immutable once settled, so the update only fires while the
// result is still null. Records the Session availability and, when present, appends
// the authoritative assistant content as an `assistant` transcript entry.
export function settleTurn(
  db: SQLiteBunDatabase,
  request: SettleTurnRequest,
): void {
  const at = request.at.toISOString();
  db.transaction((tx) => {
    // Immutable: once a Turn's result is set, the whole settle is a no-op — the
    // Session availability and transcript it recorded are settled truth too.
    const current = tx
      .select({ result_kind: turns.result_kind })
      .from(turns)
      .where(eq(turns.turn_id, request.turnId))
      .get();
    if (current === undefined || current.result_kind !== null) return;
    tx.update(turns)
      .set({
        result_kind: request.resultKind,
        result_detail: request.resultDetail,
        settled_at: at,
      })
      .where(and(eq(turns.turn_id, request.turnId), isNull(turns.result_kind)))
      .run();
    tx.update(harnessSessions)
      .set({
        availability: request.availability,
        availability_detail: request.availabilityDetail ?? null,
        updated_at: at,
      })
      .where(eq(harnessSessions.session_key, request.session))
      .run();
    if (request.assistantContent !== undefined) {
      tx.insert(transcriptEntries)
        .values({
          session_key: request.session,
          turn_id: request.turnId,
          role: "assistant",
          content: request.assistantContent,
          at,
        })
        .run();
    }
  });
}

// An owner death mid-Turn leaves the Turn admitted without a settled result:
// no terminal truth survived, so settle it `lost` with completion-unknown so
// the durable Turn timeline shows its fate. No process is started — resume is
// explicit. Immutable like `settleTurn`: only rows still unsettled are set.
// Called by the startup reconciler inside its own transaction (`tx`), so the
// abandoned path and the ordinary settle above share one definition (A32).
export function settleAbandonedTurns(tx: SQLiteBunDatabase, at: string): void {
  const abandoned = tx
    .select({ session_key: turns.session_key })
    .from(turns)
    .where(isNull(turns.result_kind))
    .all();
  tx.update(turns)
    .set({
      result_kind: "lost",
      result_detail: JSON.stringify({
        kind: "lost",
        unknown: "completion",
      }),
      settled_at: at,
    })
    .where(isNull(turns.result_kind))
    .run();
  // Detach the abandoned Turn's Session to its stored recovery coordinate, exactly
  // as the in-process `lost` path (claude-code.ts `settleLost`) does — so a resume
  // continues in the same Claude Code Session via `--resume` rather than silently
  // opening a fresh conversation (ADR 0022). `admitTurn` recorded the coordinate as
  // `native_session_id` before the Turn started, so it survives the crash. Only a
  // still-`open` Session is moved; one already `detached`/`unusable` stays as-is.
  for (const { session_key } of abandoned) {
    tx.update(harnessSessions)
      .set({
        availability: "detached",
        availability_detail: sql`${harnessSessions.native_session_id}`,
        updated_at: at,
      })
      .where(
        and(
          eq(harnessSessions.session_key, session_key),
          eq(harnessSessions.availability, "open"),
        ),
      )
      .run();
  }
}

export function readTurns(db: SQLiteBunDatabase): readonly TurnRecord[] {
  return db
    .select({
      turn_id: turns.turn_id,
      attempt_id: turns.attempt_id,
      session_key: turns.session_key,
      origin: turns.origin,
      kind: turns.kind,
      sequence: turns.sequence,
      input: turns.input,
      admitted_at: turns.admitted_at,
      result_kind: turns.result_kind,
      result_detail: turns.result_detail,
      settled_at: turns.settled_at,
    })
    .from(turns)
    .orderBy(asc(turns.sequence))
    .all()
    .map((row): TurnRecord => {
      const parsed = turnRow.parse(row);
      return {
        turnId: parsed.turn_id,
        attemptId: parsed.attempt_id,
        session: parsed.session_key,
        origin: parsed.origin,
        // A legacy row admitted before the kind column reads it back null: the
        // kind is genuinely unknown, so omit it rather than fabricate a guess.
        ...(parsed.kind !== null ? { kind: parsed.kind } : {}),
        sequence: parsed.sequence,
        input: parsed.input,
        admittedAt: parsed.admitted_at,
        ...(parsed.result_kind !== null
          ? { resultKind: parsed.result_kind }
          : {}),
        ...(parsed.result_detail !== null
          ? { resultDetail: parsed.result_detail }
          : {}),
        ...(parsed.settled_at !== null ? { settledAt: parsed.settled_at } : {}),
      };
    });
}

export function readTurnEvents(
  db: SQLiteBunDatabase,
): readonly TurnEventRecord[] {
  return db
    .select({
      turn_id: turnEvents.turn_id,
      kind: turnEvents.kind,
      payload: turnEvents.payload,
      at: turnEvents.at,
    })
    .from(turnEvents)
    .orderBy(asc(turnEvents.seq))
    .all()
    .map((row): TurnEventRecord => {
      const parsed = turnEventRow.parse(row);
      return {
        turnId: parsed.turn_id,
        kind: parsed.kind,
        payload: parsed.payload,
        at: parsed.at,
      };
    });
}

export function readHarnessSessions(
  db: SQLiteBunDatabase,
): readonly HarnessSessionRecord[] {
  return db
    .select({
      session_key: harnessSessions.session_key,
      availability: harnessSessions.availability,
      availability_detail: harnessSessions.availability_detail,
    })
    .from(harnessSessions)
    .orderBy(asc(harnessSessions.created_at))
    .all()
    .map((row): HarnessSessionRecord => {
      const parsed = harnessSessionRow.parse(row);
      return {
        session: parsed.session_key,
        availability: parsed.availability,
        ...(parsed.availability_detail !== null
          ? { availabilityDetail: parsed.availability_detail }
          : {}),
      };
    });
}

export function readTranscript(
  db: SQLiteBunDatabase,
): readonly TranscriptEntryRecord[] {
  return db
    .select({
      session_key: transcriptEntries.session_key,
      turn_id: transcriptEntries.turn_id,
      role: transcriptEntries.role,
      content: transcriptEntries.content,
      at: transcriptEntries.at,
    })
    .from(transcriptEntries)
    .orderBy(asc(transcriptEntries.seq))
    .all()
    .map((row): TranscriptEntryRecord => {
      const parsed = transcriptRow.parse(row);
      return {
        session: parsed.session_key,
        turnId: parsed.turn_id,
        role: parsed.role,
        content: parsed.content,
        at: parsed.at,
      };
    });
}

export function readTranscriptPage(
  db: SQLiteBunDatabase,
  request: TranscriptPageRequest,
): TranscriptPage {
  // Read only the newest `limit` retained entries below the cursor (one extra
  // to detect older history), so a page read never touches the whole
  // transcript. `seq` is the monotonic append order; `before` pages upward.
  // A page must hold at least one entry to carry a cursor forward, so a
  // non-positive limit is clamped at this ingress Seam — otherwise `limit: 0`
  // reads one row and reports `hasOlder` over an empty page (A11).
  const limit = Math.max(1, request.limit);
  const where =
    request.before === undefined
      ? eq(transcriptEntries.session_key, request.session)
      : and(
          eq(transcriptEntries.session_key, request.session),
          lt(transcriptEntries.seq, request.before),
        );
  const rows = db
    .select({
      seq: transcriptEntries.seq,
      session_key: transcriptEntries.session_key,
      turn_id: transcriptEntries.turn_id,
      role: transcriptEntries.role,
      content: transcriptEntries.content,
      at: transcriptEntries.at,
    })
    .from(transcriptEntries)
    .where(where)
    .orderBy(desc(transcriptEntries.seq))
    .limit(limit + 1)
    .all();
  const hasOlder = rows.length > limit;
  const page = hasOlder ? rows.slice(0, limit) : rows;
  // Rows come newest-first for the bound; reverse so a page reads oldest-first.
  const entries = page.reverse().map((row): SequencedTranscriptEntry => {
    const parsed = sequencedTranscriptRow.parse(row);
    return {
      seq: parsed.seq,
      session: parsed.session_key,
      turnId: parsed.turn_id,
      role: parsed.role,
      content: parsed.content,
      at: parsed.at,
    };
  });
  return { entries, hasOlder };
}
