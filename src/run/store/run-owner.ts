import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { openArtifactRepo } from "./artifacts/artifacts.js";
import { runs } from "./coordination-schema.js";
import {
  artifactBindings,
  artifactVersions,
  attemptLog,
  attempts,
  gateAnswers,
  materializationConflicts,
  pendingGates,
  runRecord,
} from "./run-schema.js";
import type {
  PendingGateRecord,
  PublishAttemptRequest,
  RecordConflictRequest,
  RecordGateAnswerRequest,
  RecordPendingGateRequest,
  RunOwner,
  RunRecord,
  WriteResult,
} from "./store.js";

export const DAMAGED = Symbol("run-store-damaged");

export interface TRunDatabaseHandle {
  readonly db: SQLiteBunDatabase;
  close(): void;
}

export type TOpenRunDatabase = (path: string) => TRunDatabaseHandle;

interface TStageRunStoreParams {
  readonly dir: string;
  readonly record: RunRecord;
  readonly openDatabase: TOpenRunDatabase;
}

interface TReadRunStoreParams {
  readonly dir: string;
  readonly openDatabase: TOpenRunDatabase;
}

interface TReconcileRunStoreParams extends TReadRunStoreParams {
  readonly at: Date;
}

interface TCreateRunOwnerParams {
  readonly database: TRunDatabaseHandle;
  readonly runDir: string;
  readonly runId: string;
  readonly record: RunRecord;
  readonly fenced: () => boolean;
  readonly release: () => WriteResult;
  readonly close: () => void;
}

interface TAcquireRunOwnerParams {
  readonly coordinationDb: SQLiteBunDatabase;
  readonly groupDir: string;
  readonly runId: string;
  readonly takeover: boolean;
  readonly selfPid: number;
  readonly isOwnerAlive: (pid: number) => boolean;
  readonly openDatabase: TOpenRunDatabase;
  readonly trackHandle: (database: TRunDatabaseHandle) => () => void;
}

const runRecordRow = z.object({
  run_id: z.string(),
  workspace_path: z.string(),
  bundle_snapshot_digest: z.string(),
  launch: z.string(),
  state: z.string(),
  created_at: z.string(),
});
const bindingRow = z.object({ version_id: z.string() });
const attemptOutcome = z.enum([
  "succeeded",
  "failed",
  "indeterminate",
  "cancelled",
]);
const gateAnswer = z.enum(["continue", "stop"]);
const attemptRow = z.object({
  outcome: attemptOutcome,
  version_id: z.string().nullable(),
});
const attemptLogRow = z.object({
  attempt_id: z.string(),
  outcome: attemptOutcome,
  at: z.string(),
});
const reconcileRow = z.object({ run_id: z.string(), state: z.string() });
const conflictRow = z.object({
  diagnostic_id: z.string(),
  artifact_name: z.string(),
  artifact_path: z.string(),
  version_id: z.string(),
  at: z.string(),
});
const gateAnswerRow = z.object({
  answer_id: z.string(),
  operation_id: z.string(),
  gate_attempt_id: z.string(),
  answer: gateAnswer,
  iterations_at_grant: z.number(),
  version_id: z.string(),
  at: z.string(),
});
// The gate shape is a closed set domain logic branches on, so it is validated at
// the read ingress like the other enum columns (D7, store/AGENTS.md), never cast.
const gateShape = z.enum(["approve-reject", "free-text"]);
const pendingGateRow = z.object({
  attempt_id: z.string(),
  step_id: z.string(),
  shape: gateShape,
  message: z.string(),
  output_artifact_name: z.string().nullable(),
  raised_at: z.string(),
});

function toPendingGate(row: z.infer<typeof pendingGateRow>): PendingGateRecord {
  return {
    attemptId: row.attempt_id,
    stepId: row.step_id,
    shape: row.shape,
    message: row.message,
    ...(row.output_artifact_name !== null
      ? { outputArtifactName: row.output_artifact_name }
      : {}),
    raisedAt: row.raised_at,
  };
}

function toRunRecord(row: z.infer<typeof runRecordRow>): RunRecord {
  return {
    runId: row.run_id,
    workspacePath: row.workspace_path,
    bundleSnapshotDigest: row.bundle_snapshot_digest,
    launch: JSON.parse(row.launch),
    state: row.state,
    createdAt: row.created_at,
  };
}

export function stageRunStore(params: TStageRunStoreParams): void {
  const { dir, record, openDatabase } = params;
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "staging"), { recursive: true });
  mkdirSync(join(dir, "diagnostics"), { recursive: true });
  const database = openDatabase(join(dir, "run.db"));
  try {
    database.db
      .insert(runRecord)
      .values({
        run_id: record.runId,
        workspace_path: record.workspacePath,
        bundle_snapshot_digest: record.bundleSnapshotDigest,
        launch: JSON.stringify(record.launch ?? null),
        state: record.state,
        created_at: record.createdAt,
      })
      .run();
  } finally {
    database.close();
  }
}

export function readRunStore(
  params: TReadRunStoreParams,
): RunRecord | typeof DAMAGED | undefined {
  const path = join(params.dir, "run.db");
  if (!existsSync(path)) return undefined;
  let database: TRunDatabaseHandle | undefined;
  try {
    database = params.openDatabase(path);
    const row = database.db.select().from(runRecord).limit(1).get();
    if (row === undefined) return DAMAGED;
    const parsed = runRecordRow.safeParse(row);
    return parsed.success ? toRunRecord(parsed.data) : DAMAGED;
  } catch {
    return DAMAGED;
  } finally {
    database?.close();
  }
}

export function reconcileRunStore(params: TReconcileRunStoreParams): boolean {
  const path = join(params.dir, "run.db");
  if (!existsSync(path)) return false;
  let database: TRunDatabaseHandle | undefined;
  try {
    database = params.openDatabase(path);
    const raw = database.db
      .select({ run_id: runRecord.run_id, state: runRecord.state })
      .from(runRecord)
      .limit(1)
      .get();
    if (raw === undefined) return false;
    const parsed = reconcileRow.safeParse(raw);
    if (!parsed.success) return false;
    if (parsed.data.state !== "running" && parsed.data.state !== "created") {
      return false;
    }
    const row = parsed.data;
    database.db.transaction((tx) => {
      tx.insert(attemptLog)
        .values({
          attempt_id: randomUUID(),
          outcome: "indeterminate",
          at: params.at.toISOString(),
        })
        .run();
      tx.update(runRecord)
        .set({ state: "halted" })
        .where(eq(runRecord.run_id, row.run_id))
        .run();
    });
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

interface TUpdateRunStateParams {
  readonly db: SQLiteBunDatabase;
  readonly runId: string;
  readonly state: string;
}

function updateRunState(params: TUpdateRunStateParams): void {
  params.db
    .update(runRecord)
    .set({ state: params.state })
    .where(eq(runRecord.run_id, params.runId))
    .run();
}

interface TCommitAttemptParams {
  readonly db: SQLiteBunDatabase;
  readonly runId: string;
  readonly request: PublishAttemptRequest;
  readonly versionId: string | undefined;
}

function commitAttempt(params: TCommitAttemptParams): void {
  params.db.transaction((tx) => {
    const at = params.request.at.toISOString();
    if (params.versionId !== undefined) {
      for (const output of params.request.outputs) {
        tx.insert(artifactVersions)
          .values({
            version_id: params.versionId,
            artifact_name: output.name,
            artifact_type: output.type,
            attempt_id: params.request.attemptId,
            created_at: at,
          })
          .run();
        tx.insert(artifactBindings)
          .values({
            artifact_name: output.name,
            version_id: params.versionId,
            updated_at: at,
          })
          .onConflictDoUpdate({
            target: artifactBindings.artifact_name,
            set: { version_id: params.versionId, updated_at: at },
          })
          .run();
      }
    }
    tx.insert(attempts)
      .values({
        attempt_id: params.request.attemptId,
        outcome: params.request.outcome,
        version_id: params.versionId ?? null,
        settled_at: at,
      })
      .run();
    tx.insert(attemptLog)
      .values({
        attempt_id: params.request.attemptId,
        outcome: params.request.outcome,
        at,
      })
      .run();
    if (params.request.advanceState !== undefined) {
      updateRunState({
        db: tx,
        runId: params.runId,
        state: params.request.advanceState,
      });
    }
  });
}

interface TRecordConflictParams {
  readonly db: SQLiteBunDatabase;
  readonly runId: string;
  readonly request: RecordConflictRequest;
  readonly diagnosticId: string;
}

function recordConflict(params: TRecordConflictParams): void {
  params.db.transaction((tx) => {
    tx.insert(materializationConflicts)
      .values({
        diagnostic_id: params.diagnosticId,
        artifact_name: params.request.artifactName,
        artifact_path: params.request.path,
        version_id: params.request.versionId,
        at: params.request.at.toISOString(),
      })
      .run();
    updateRunState({ db: tx, runId: params.runId, state: "halted" });
  });
}

interface TRecordGateAnswerParams {
  readonly db: SQLiteBunDatabase;
  readonly runId: string;
  readonly request: RecordGateAnswerRequest;
  readonly answerId: string;
  readonly versionId: string;
}

function recordGateAnswer(params: TRecordGateAnswerParams): void {
  const { db, runId, request, answerId, versionId } = params;
  db.transaction((tx) => {
    const at = request.at.toISOString();
    tx.insert(artifactVersions)
      .values({
        version_id: versionId,
        artifact_name: request.artifactName,
        artifact_type: "text",
        attempt_id: answerId,
        created_at: at,
      })
      .run();
    tx.insert(artifactBindings)
      .values({
        artifact_name: request.artifactName,
        version_id: versionId,
        updated_at: at,
      })
      .onConflictDoUpdate({
        target: artifactBindings.artifact_name,
        set: { version_id: versionId, updated_at: at },
      })
      .run();
    tx.insert(gateAnswers)
      .values({
        answer_id: answerId,
        operation_id: request.operationId,
        gate_attempt_id: request.gateAttemptId,
        answer: request.answer,
        iterations_at_grant: request.iterationsAtGrant,
        version_id: versionId,
        at,
      })
      .run();
    if (request.advanceState !== undefined) {
      updateRunState({ db: tx, runId, state: request.advanceState });
    }
  });
}

interface TRecordPendingGateParams {
  readonly db: SQLiteBunDatabase;
  readonly runId: string;
  readonly request: RecordPendingGateRequest;
}

// Record the authored pending gate and rest the Run `blocked`, all or nothing, so
// a crash cannot leave the record without the pause (#108). Idempotent on the
// producing Attempt id: a resume that re-reaches the same gate re-records nothing
// and re-rests `blocked`.
function recordPendingGate(params: TRecordPendingGateParams): void {
  const { db, runId, request } = params;
  db.transaction((tx) => {
    tx.insert(pendingGates)
      .values({
        attempt_id: request.attemptId,
        step_id: request.stepId,
        shape: request.shape,
        message: request.message,
        output_artifact_name: request.outputArtifactName ?? null,
        raised_at: request.at.toISOString(),
      })
      .onConflictDoNothing({ target: pendingGates.attempt_id })
      .run();
    updateRunState({ db: tx, runId, state: "blocked" });
  });
}

function createRunOwner(params: TCreateRunOwnerParams): RunOwner {
  const { db } = params.database;
  const repo = openArtifactRepo(params.runDir);
  const diagnosticsDir = join(params.runDir, "diagnostics");

  return {
    runId: params.runId,
    record: params.record,
    writeState(state) {
      if (params.fenced()) return { ok: false, reason: "fenced" };
      updateRunState({ db, runId: params.runId, state });
      return { ok: true };
    },
    publishAttempt(request) {
      if (params.fenced()) return { ok: false, reason: "fenced" };
      const settled = db
        .select({ outcome: attempts.outcome, version_id: attempts.version_id })
        .from(attempts)
        .where(eq(attempts.attempt_id, request.attemptId))
        .get();
      if (settled !== undefined) {
        const parsed = attemptRow.parse(settled);
        const result: { ok: true; versionId?: string } = { ok: true };
        if (parsed.version_id !== null) result.versionId = parsed.version_id;
        return result;
      }
      if (request.outcome === "succeeded") {
        // A succeeded Attempt that produced nothing (an approve-reject Human Gate
        // answer, #108) needs no commit — there is no artifact to stage and an empty
        // tree is not a valid `git mktree` input. Settle it with no version, like a
        // non-producing outcome.
        if (request.outputs.length === 0 && request.required.length === 0) {
          commitAttempt({
            db,
            runId: params.runId,
            request,
            versionId: undefined,
          });
          return { ok: true };
        }
        const staged = repo.stageCommit(
          request.attemptId,
          request.required,
          request.outputs,
          request.at,
        );
        if (!staged.ok) return { ok: false, problem: staged.problem };
        if (params.fenced()) return { ok: false, reason: "fenced" };
        commitAttempt({
          db,
          runId: params.runId,
          request,
          versionId: staged.versionId,
        });
        return { ok: true, versionId: staged.versionId };
      }
      commitAttempt({ db, runId: params.runId, request, versionId: undefined });
      return { ok: true };
    },
    currentVersion(name) {
      const row = db
        .select({ version_id: artifactBindings.version_id })
        .from(artifactBindings)
        .where(eq(artifactBindings.artifact_name, name))
        .get();
      return row === undefined ? undefined : bindingRow.parse(row).version_id;
    },
    readArtifact(versionId, name) {
      return repo.read(versionId, name);
    },
    attemptLog() {
      return db
        .select({
          attempt_id: attemptLog.attempt_id,
          outcome: attemptLog.outcome,
          at: attemptLog.at,
        })
        .from(attemptLog)
        .orderBy(asc(attemptLog.seq))
        .all()
        .map((row) => {
          const parsed = attemptLogRow.parse(row);
          return {
            attemptId: parsed.attempt_id,
            outcome: parsed.outcome,
            at: parsed.at,
          };
        });
    },
    recordMaterializationConflict(request) {
      if (params.fenced()) return { ok: false, reason: "fenced" };
      const diagnosticId = randomUUID();
      mkdirSync(diagnosticsDir, { recursive: true });
      writeFileSync(join(diagnosticsDir, diagnosticId), request.diagnostic);
      if (params.fenced()) return { ok: false, reason: "fenced" };
      recordConflict({ db, runId: params.runId, request, diagnosticId });
      return { ok: true, diagnosticId };
    },
    materializationConflicts() {
      return db
        .select({
          diagnostic_id: materializationConflicts.diagnostic_id,
          artifact_name: materializationConflicts.artifact_name,
          artifact_path: materializationConflicts.artifact_path,
          version_id: materializationConflicts.version_id,
          at: materializationConflicts.at,
        })
        .from(materializationConflicts)
        .orderBy(asc(materializationConflicts.seq))
        .all()
        .map((row) => {
          const parsed = conflictRow.parse(row);
          return {
            diagnosticId: parsed.diagnostic_id,
            artifactName: parsed.artifact_name,
            path: parsed.artifact_path,
            versionId: parsed.version_id,
            at: parsed.at,
          };
        });
    },
    readDiagnostic(diagnosticId) {
      if (!/^[A-Za-z0-9-]+$/.test(diagnosticId)) return undefined;
      const path = join(diagnosticsDir, diagnosticId);
      try {
        return existsSync(path) ? readFileSync(path) : undefined;
      } catch {
        return undefined;
      }
    },
    recordGateAnswer(request) {
      if (params.fenced()) return { ok: false, reason: "fenced" };
      const existing = db
        .select({
          answer_id: gateAnswers.answer_id,
          version_id: gateAnswers.version_id,
        })
        .from(gateAnswers)
        .where(eq(gateAnswers.operation_id, request.operationId))
        .get();
      if (existing !== undefined) {
        return { ok: true, versionId: existing.version_id, replayed: true };
      }
      const answerId = randomUUID();
      const staged = repo.stageCommit(
        answerId,
        [],
        [
          {
            name: request.artifactName,
            type: "text",
            content: new TextEncoder().encode(request.answer),
          },
        ],
        request.at,
      );
      if (!staged.ok) return { ok: false, problem: staged.problem };
      if (params.fenced()) return { ok: false, reason: "fenced" };
      recordGateAnswer({
        db,
        runId: params.runId,
        request,
        answerId,
        versionId: staged.versionId,
      });
      return { ok: true, versionId: staged.versionId, replayed: false };
    },
    gateAnswers() {
      return db
        .select({
          answer_id: gateAnswers.answer_id,
          operation_id: gateAnswers.operation_id,
          gate_attempt_id: gateAnswers.gate_attempt_id,
          answer: gateAnswers.answer,
          iterations_at_grant: gateAnswers.iterations_at_grant,
          version_id: gateAnswers.version_id,
          at: gateAnswers.at,
        })
        .from(gateAnswers)
        .orderBy(asc(gateAnswers.seq))
        .all()
        .map((row) => {
          const parsed = gateAnswerRow.parse(row);
          return {
            answerId: parsed.answer_id,
            operationId: parsed.operation_id,
            gateAttemptId: parsed.gate_attempt_id,
            answer: parsed.answer,
            iterationsAtGrant: parsed.iterations_at_grant,
            versionId: parsed.version_id,
            at: parsed.at,
          };
        });
    },
    recordPendingGate(request) {
      if (params.fenced()) return { ok: false, reason: "fenced" };
      recordPendingGate({ db, runId: params.runId, request });
      return { ok: true };
    },
    pendingGate() {
      // The gate the Run currently rests at: the pending-gate record whose
      // producing Attempt has not settled. Answering settles that Attempt (an
      // `attempt` row), so this reads empty once the gate is answered.
      const row = db
        .select()
        .from(pendingGates)
        .where(
          notInArray(
            pendingGates.attempt_id,
            db.select({ id: attempts.attempt_id }).from(attempts),
          ),
        )
        .orderBy(asc(pendingGates.raised_at))
        .get();
      return row === undefined
        ? undefined
        : toPendingGate(pendingGateRow.parse(row));
    },
    release: params.release,
    close: params.close,
  };
}

export function acquireRunOwner(
  params: TAcquireRunOwnerParams,
): RunOwner | undefined {
  const record = readRunStore({
    dir: join(params.groupDir, params.runId),
    openDatabase: params.openDatabase,
  });
  if (record === undefined || record === DAMAGED) return undefined;

  if (!params.takeover) {
    const registration = params.coordinationDb
      .select({ owner_pid: runs.owner_pid })
      .from(runs)
      .where(eq(runs.run_id, params.runId))
      .get();
    const ownerPid = registration?.owner_pid;
    if (
      ownerPid != null &&
      ownerPid !== params.selfPid &&
      params.isOwnerAlive(ownerPid)
    ) {
      return undefined;
    }
  }

  const bumped = params.coordinationDb
    .update(runs)
    .set(
      params.takeover
        ? {
            owner_epoch: sql`${runs.owner_epoch} + 1`,
            owner_pid: params.selfPid,
          }
        : { owner_epoch: sql`${runs.owner_epoch} + 1` },
    )
    .where(eq(runs.run_id, params.runId))
    .returning({ owner_epoch: runs.owner_epoch })
    .get();
  if (bumped === undefined) return undefined;

  const epoch = bumped.owner_epoch;
  const runDir = join(params.groupDir, params.runId);
  const runDatabase = params.openDatabase(join(runDir, "run.db"));
  const close = params.trackHandle(runDatabase);

  function fenced(): boolean {
    const current = params.coordinationDb
      .select({ owner_epoch: runs.owner_epoch })
      .from(runs)
      .where(eq(runs.run_id, params.runId))
      .get();
    return current === undefined || current.owner_epoch !== epoch;
  }

  function release(): WriteResult {
    const released = params.coordinationDb
      .update(runs)
      .set({ owner_pid: null })
      .where(and(eq(runs.run_id, params.runId), eq(runs.owner_epoch, epoch)))
      .returning({ run_id: runs.run_id })
      .get();
    return released === undefined
      ? { ok: false, reason: "fenced" }
      : { ok: true };
  }

  return createRunOwner({
    database: runDatabase,
    runDir,
    runId: params.runId,
    record,
    fenced,
    release,
    close,
  });
}
