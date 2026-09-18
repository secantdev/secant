import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asc, desc, eq, isNotNull, notInArray } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
import { openArtifactRepo } from "./artifacts/artifacts.js";
import {
  artifactBindings,
  artifactVersions,
  attemptLog,
  attempts,
  gateAnswers,
  materializationConflicts,
  pendingGates,
  runOwner,
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
  SelectedHarnessId,
  SelectHarnessResult,
  WriteResult,
} from "./store.js";
import {
  admitTurn,
  appendTurnEvent,
  readHarnessSessions,
  readTranscript,
  readTranscriptPage,
  readTurnEvents,
  readTurns,
  settleAbandonedTurns,
  settleTurn,
} from "./turn-records.js";

export const DAMAGED = Symbol("run-store-damaged");

export interface TRunDatabaseHandle {
  readonly db: SQLiteBunDatabase;
  isClosed(): boolean;
  close(): void;
}

export type TOpenRunDatabase = (path: string) => TRunDatabaseHandle;

interface TStageRunStoreParams {
  readonly dir: string;
  readonly record: RunRecord;
  readonly ownerPid: number;
  readonly openDatabase: TOpenRunDatabase;
}

interface TReadRunStoreParams {
  readonly dir: string;
  readonly openDatabase: TOpenRunDatabase;
}

interface TReconcileRunStoreParams extends TReadRunStoreParams {
  readonly at: Date;
  readonly selfPid: number;
  readonly isOwnerAlive: (pid: number) => boolean;
}

interface TCreateRunOwnerParams {
  readonly database: TRunDatabaseHandle;
  readonly runDir: string;
  readonly runId: string;
  readonly record: RunRecord;
  readonly epoch: number;
  readonly close: () => void;
}

interface TAcquireRunOwnerParams {
  readonly groupDir: string;
  readonly runId: string;
  readonly takeover: boolean;
  readonly selfPid: number;
  readonly isOwnerAlive: (pid: number) => boolean;
  readonly openDatabase: TOpenRunDatabase;
  readonly trackHandle: (database: TRunDatabaseHandle) => () => void;
}

const selectedHarnessId = z.literal("claude-code");
const runRecordRow = z.object({
  run_id: z.string(),
  workspace_path: z.string(),
  bundle_snapshot_digest: z.string(),
  launch: z.string(),
  selected_harness: selectedHarnessId.nullable(),
  state: z.string(),
  created_at: z.string(),
});
const selectedHarnessRow = z.object({
  selected_harness: selectedHarnessId.nullable(),
});
const runOwnerRow = z.object({
  ownerEpoch: z.number(),
  ownerPid: z.number().nullable(),
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

const effectiveModelRow = z.object({ effective_model: z.string() });
const harnessIdentityRow = z
  .object({
    harness: z.string(),
    executable: z.string(),
    executable_version: z.string(),
  })
  .and(
    z.union([
      z.object({
        steer_available: z.null(),
        steer_evidence: z.null(),
      }),
      z.object({
        steer_available: z.boolean(),
        steer_evidence: z.string(),
      }),
    ]),
  );

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
    ...(row.selected_harness !== null
      ? { selectedHarness: row.selected_harness }
      : {}),
    state: row.state,
    createdAt: row.created_at,
  };
}

export interface TRunOwnership {
  readonly ownerPid: number | null;
  readonly ownerEpoch: number;
}

const RUN_OWNER_SINGLETON = 1;
const UNOWNED_RUN: TRunOwnership = { ownerPid: null, ownerEpoch: 0 };

function readRunOwnershipRow(db: SQLiteBunDatabase): TRunOwnership {
  const row = db
    .select({
      ownerEpoch: runOwner.ownerEpoch,
      ownerPid: runOwner.ownerPid,
    })
    .from(runOwner)
    .where(eq(runOwner.singleton, RUN_OWNER_SINGLETON))
    .get();
  return row === undefined ? UNOWNED_RUN : runOwnerRow.parse(row);
}

function writeRunOwnershipRow(
  db: SQLiteBunDatabase,
  ownership: TRunOwnership,
): void {
  db.insert(runOwner)
    .values({
      singleton: RUN_OWNER_SINGLETON,
      ownerEpoch: ownership.ownerEpoch,
      ownerPid: ownership.ownerPid,
    })
    .onConflictDoUpdate({
      target: runOwner.singleton,
      set: ownership,
    })
    .run();
}

function readRunRecordRow(db: SQLiteBunDatabase): RunRecord | typeof DAMAGED {
  const row = db.select().from(runRecord).limit(1).get();
  if (row === undefined) return DAMAGED;
  const parsed = runRecordRow.safeParse(row);
  return parsed.success ? toRunRecord(parsed.data) : DAMAGED;
}

export function stageRunStore(params: TStageRunStoreParams): void {
  const { dir, record, openDatabase } = params;
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "staging"), { recursive: true });
  mkdirSync(join(dir, "diagnostics"), { recursive: true });
  const database = openDatabase(join(dir, "run.db"));
  try {
    database.db.transaction((tx) => {
      tx.insert(runRecord)
        .values({
          run_id: record.runId,
          workspace_path: record.workspacePath,
          bundle_snapshot_digest: record.bundleSnapshotDigest,
          launch: JSON.stringify(record.launch ?? null),
          selected_harness: record.selectedHarness ?? null,
          state: record.state,
          created_at: record.createdAt,
        })
        .run();
      writeRunOwnershipRow(tx, {
        ownerPid: params.ownerPid,
        ownerEpoch: 0,
      });
    });
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
    return readRunRecordRow(database.db);
  } catch {
    return DAMAGED;
  } finally {
    database?.close();
  }
}

export function readRunOwnership(
  params: TReadRunStoreParams,
): TRunOwnership | typeof DAMAGED | undefined {
  const path = join(params.dir, "run.db");
  if (!existsSync(path)) return undefined;
  let database: TRunDatabaseHandle | undefined;
  try {
    database = params.openDatabase(path);
    if (readRunRecordRow(database.db) === DAMAGED) return DAMAGED;
    return readRunOwnershipRow(database.db);
  } catch {
    return DAMAGED;
  } finally {
    database?.close();
  }
}

interface TClaimRunOwnershipParams extends TReadRunStoreParams {
  readonly selfPid: number;
  readonly isOwnerAlive: (pid: number) => boolean;
}

interface TEndRunOwnershipParams extends TReadRunStoreParams {
  readonly selfPid: number;
}

export type TClaimRunOwnershipResult =
  | { readonly kind: "claimed" }
  | { readonly kind: "live-elsewhere"; readonly ownerPid: number }
  | { readonly kind: "unreadable" };

export function claimRunOwnership(
  params: TClaimRunOwnershipParams,
): TClaimRunOwnershipResult {
  const path = join(params.dir, "run.db");
  if (!existsSync(path)) return { kind: "unreadable" };
  const database = params.openDatabase(path);
  try {
    return database.db.transaction(
      (tx): TClaimRunOwnershipResult => {
        const ownership = readRunOwnershipRow(tx);
        if (readRunRecordRow(tx) === DAMAGED) return { kind: "unreadable" };
        const ownerPid = ownership.ownerPid;
        if (ownerPid === params.selfPid) return { kind: "claimed" };
        if (ownerPid !== null && params.isOwnerAlive(ownerPid)) {
          return { kind: "live-elsewhere", ownerPid };
        }
        writeRunOwnershipRow(tx, {
          ownerEpoch: ownership.ownerEpoch,
          ownerPid: params.selfPid,
        });
        return { kind: "claimed" };
      },
      { behavior: "immediate" },
    );
  } finally {
    database.close();
  }
}

export function endRunOwnership(params: TEndRunOwnershipParams): void {
  const path = join(params.dir, "run.db");
  if (!existsSync(path)) return;
  const database = params.openDatabase(path);
  try {
    database.db.transaction(
      (tx) => {
        const ownership = readRunOwnershipRow(tx);
        if (ownership.ownerPid !== params.selfPid) return;
        writeRunOwnershipRow(tx, {
          ownerEpoch: ownership.ownerEpoch,
          ownerPid: null,
        });
      },
      { behavior: "immediate" },
    );
  } finally {
    database.close();
  }
}

export function reconcileRunStore(params: TReconcileRunStoreParams): boolean {
  const path = join(params.dir, "run.db");
  if (!existsSync(path)) return false;
  let database: TRunDatabaseHandle | undefined;
  try {
    database = params.openDatabase(path);
    return database.db.transaction(
      (tx): boolean => {
        const ownership = readRunOwnershipRow(tx);
        const ownerPid = ownership.ownerPid;
        if (ownerPid === null) return true;
        if (ownerPid !== params.selfPid && params.isOwnerAlive(ownerPid)) {
          return true;
        }

        const raw = tx
          .select({ run_id: runRecord.run_id, state: runRecord.state })
          .from(runRecord)
          .limit(1)
          .get();
        const parsed = reconcileRow.safeParse(raw);
        if (!parsed.success) return false;
        if (
          parsed.data.state === "running" ||
          parsed.data.state === "created"
        ) {
          tx.insert(attemptLog)
            .values({
              attempt_id: randomUUID(),
              outcome: "indeterminate",
              at: params.at.toISOString(),
            })
            .run();
          tx.update(runRecord)
            .set({ state: "halted" })
            .where(eq(runRecord.run_id, parsed.data.run_id))
            .run();
          settleAbandonedTurns(tx, params.at.toISOString());
        }
        writeRunOwnershipRow(tx, {
          ownerEpoch: ownership.ownerEpoch,
          ownerPid: null,
        });
        return true;
      },
      { behavior: "immediate" },
    );
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
  const at = params.request.at.toISOString();
  if (params.versionId !== undefined) {
    for (const output of params.request.outputs) {
      params.db
        .insert(artifactVersions)
        .values({
          version_id: params.versionId,
          artifact_name: output.name,
          artifact_type: output.type,
          attempt_id: params.request.attemptId,
          created_at: at,
        })
        .run();
      params.db
        .insert(artifactBindings)
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
  const identity = params.request.harnessIdentity;
  params.db
    .insert(attempts)
    .values({
      attempt_id: params.request.attemptId,
      outcome: params.request.outcome,
      version_id: params.versionId ?? null,
      settled_at: at,
      effective_model: params.request.effectiveModel ?? null,
      harness: identity?.harness ?? null,
      executable: identity?.executable ?? null,
      executable_version: identity?.executableVersion ?? null,
      steer_available: identity?.steer?.available ?? null,
      steer_evidence: identity?.steer?.evidence ?? null,
    })
    .run();
  params.db
    .insert(attemptLog)
    .values({
      attempt_id: params.request.attemptId,
      outcome: params.request.outcome,
      at,
    })
    .run();
  if (params.request.advanceState !== undefined) {
    updateRunState({
      db: params.db,
      runId: params.runId,
      state: params.request.advanceState,
    });
  }
}

interface TRecordConflictParams {
  readonly db: SQLiteBunDatabase;
  readonly runId: string;
  readonly request: RecordConflictRequest;
  readonly diagnosticId: string;
}

function recordConflict(params: TRecordConflictParams): void {
  params.db
    .insert(materializationConflicts)
    .values({
      diagnostic_id: params.diagnosticId,
      artifact_name: params.request.artifactName,
      artifact_path: params.request.path,
      version_id: params.request.versionId,
      at: params.request.at.toISOString(),
    })
    .run();
  updateRunState({ db: params.db, runId: params.runId, state: "halted" });
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
  const at = request.at.toISOString();
  db.insert(artifactVersions)
    .values({
      version_id: versionId,
      artifact_name: request.artifactName,
      artifact_type: "text",
      attempt_id: answerId,
      created_at: at,
    })
    .run();
  db.insert(artifactBindings)
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
  db.insert(gateAnswers)
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
    updateRunState({ db, runId, state: request.advanceState });
  }
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
  db.insert(pendingGates)
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
  updateRunState({ db, runId, state: "blocked" });
}

type TGuardedWriteResult =
  { readonly kind: "written" } | { readonly kind: "fenced" };

type TCanonicalWrite = (tx: SQLiteBunDatabase) => void;
type TGuardedTransactionResult<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "fenced" };

type TFencedWriteResult = {
  readonly ok: false;
  readonly reason: "fenced";
};

const FENCED_WRITE: TFencedWriteResult = { ok: false, reason: "fenced" };

function toWriteResult(result: TGuardedWriteResult): WriteResult {
  return result.kind === "fenced" ? FENCED_WRITE : { ok: true };
}

function createRunOwner(params: TCreateRunOwnerParams): RunOwner {
  const { db } = params.database;
  const repo = openArtifactRepo(params.runDir);
  const diagnosticsDir = join(params.runDir, "diagnostics");

  function isFenced(): boolean {
    if (params.database.isClosed()) return true;
    return readRunOwnershipRow(db).ownerEpoch !== params.epoch;
  }

  function guardedTransaction<T>(
    transaction: (tx: SQLiteBunDatabase) => T,
  ): TGuardedTransactionResult<T> {
    if (params.database.isClosed()) return { kind: "fenced" };
    return db.transaction(
      (tx): TGuardedTransactionResult<T> => {
        const ownership = readRunOwnershipRow(tx);
        if (ownership.ownerEpoch !== params.epoch) return { kind: "fenced" };
        return { kind: "completed", value: transaction(tx) };
      },
      { behavior: "immediate" },
    );
  }

  function guardedWrite(write: TCanonicalWrite): TGuardedWriteResult {
    const result = guardedTransaction((tx) => write(tx));
    return result.kind === "fenced" ? result : { kind: "written" };
  }

  return {
    runId: params.runId,
    record: params.record,
    selectHarness(selectedHarness: SelectedHarnessId): SelectHarnessResult {
      const result = guardedTransaction(
        (tx): "selected" | "already-selected" => {
          const row = tx
            .select({ selected_harness: runRecord.selected_harness })
            .from(runRecord)
            .where(eq(runRecord.run_id, params.runId))
            .get();
          if (row === undefined) {
            throw new Error(
              `Run Store: Run ${params.runId} has no canonical record.`,
            );
          }
          const current = selectedHarnessRow.parse(row).selected_harness;
          if (current === selectedHarness) {
            return "already-selected";
          }
          if (current !== null) {
            throw new Error(
              `Run Store: Run ${params.runId} already selected an immutable Harness.`,
            );
          }
          tx.update(runRecord)
            .set({ selected_harness: selectedHarness })
            .where(eq(runRecord.run_id, params.runId))
            .run();
          return "selected";
        },
      );
      return result.kind === "fenced"
        ? { outcome: "fenced" }
        : { outcome: result.value };
    },
    writeState(state) {
      const result = guardedWrite((tx) => {
        updateRunState({ db: tx, runId: params.runId, state });
      });
      return toWriteResult(result);
    },
    publishAttempt(request) {
      if (isFenced()) return FENCED_WRITE;
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
          const committed = guardedWrite((tx) => {
            commitAttempt({
              db: tx,
              runId: params.runId,
              request,
              versionId: undefined,
            });
          });
          return toWriteResult(committed);
        }
        const staged = repo.stageCommit(
          request.attemptId,
          request.required,
          request.outputs,
          request.at,
        );
        if (!staged.ok) return { ok: false, problem: staged.problem };
        const committed = guardedWrite((tx) => {
          commitAttempt({
            db: tx,
            runId: params.runId,
            request,
            versionId: staged.versionId,
          });
        });
        if (committed.kind === "fenced") return FENCED_WRITE;
        return { ok: true, versionId: staged.versionId };
      }
      const committed = guardedWrite((tx) => {
        commitAttempt({
          db: tx,
          runId: params.runId,
          request,
          versionId: undefined,
        });
      });
      return toWriteResult(committed);
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
      const diagnosticId = randomUUID();
      const diagnosticPath = join(diagnosticsDir, diagnosticId);
      const recorded = guardedWrite((tx) => {
        mkdirSync(diagnosticsDir, { recursive: true });
        writeFileSync(diagnosticPath, request.diagnostic);
        recordConflict({ db: tx, runId: params.runId, request, diagnosticId });
      });
      if (recorded.kind === "fenced") return FENCED_WRITE;
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
      if (isFenced()) return FENCED_WRITE;
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
      const recorded = guardedWrite((tx) => {
        recordGateAnswer({
          db: tx,
          runId: params.runId,
          request,
          answerId,
          versionId: staged.versionId,
        });
      });
      if (recorded.kind === "fenced") return FENCED_WRITE;
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
      const recorded = guardedWrite((tx) => {
        recordPendingGate({ db: tx, runId: params.runId, request });
      });
      return toWriteResult(recorded);
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
    admitTurn(request) {
      const admitted = guardedWrite((tx) => admitTurn(tx, request));
      return toWriteResult(admitted);
    },
    appendTurnEvent(request) {
      const appended = guardedWrite((tx) => appendTurnEvent(tx, request));
      return toWriteResult(appended);
    },
    settleTurn(request) {
      const settled = guardedWrite((tx) => settleTurn(tx, request));
      return toWriteResult(settled);
    },
    turns() {
      return readTurns(db);
    },
    turnEvents() {
      return readTurnEvents(db);
    },
    harnessSessions() {
      return readHarnessSessions(db);
    },
    transcript() {
      return readTranscript(db);
    },
    transcriptPage(request) {
      return readTranscriptPage(db, request);
    },
    effectiveModel() {
      // `attempt_id` is the tiebreaker so two Attempts settled in the same millisecond
      // (a fast retry loop) resolve to one deterministic row, matching `harnessIdentity`.
      const row = db
        .select({ effective_model: attempts.effective_model })
        .from(attempts)
        .where(isNotNull(attempts.effective_model))
        .orderBy(desc(attempts.settled_at), desc(attempts.attempt_id))
        .limit(1)
        .get();
      return row === undefined
        ? undefined
        : effectiveModelRow.parse(row).effective_model;
    },
    harnessIdentity() {
      // The latest Agent-step Attempt is the latest Attempt that recorded a Harness
      // (its `harness` column is non-null); a Command/Gate Attempt records none. The
      // three profile facts are written together, so `harness` non-null implies the
      // other two are present. `attempt_id` is a deterministic tiebreaker for Attempts
      // that share a `settled_at`. In M3 one prepared Harness serves a whole Run (ADR
      // 0022), so every Agent-step Attempt carries the same executable and version — the
      // identity is constant across the Run, and pairing it with `effectiveModel()`
      // (which may resolve to a different row) is always coherent. A future second
      // Harness or a mid-Run requalification would need identity and model co-sourced
      // from one row here.
      const row = db
        .select({
          harness: attempts.harness,
          executable: attempts.executable,
          executable_version: attempts.executable_version,
          steer_available: attempts.steer_available,
          steer_evidence: attempts.steer_evidence,
        })
        .from(attempts)
        .where(isNotNull(attempts.harness))
        .orderBy(desc(attempts.settled_at), desc(attempts.attempt_id))
        .limit(1)
        .get();
      if (row === undefined) return undefined;
      const parsed = harnessIdentityRow.parse(row);
      return {
        harness: parsed.harness,
        executable: parsed.executable,
        executableVersion: parsed.executable_version,
        ...(parsed.steer_available !== null && parsed.steer_evidence !== null
          ? {
              steer: {
                available: parsed.steer_available,
                evidence: parsed.steer_evidence,
              },
            }
          : {}),
      };
    },
    release() {
      const released = guardedWrite((tx) => {
        writeRunOwnershipRow(tx, {
          ownerEpoch: params.epoch,
          ownerPid: null,
        });
      });
      return toWriteResult(released);
    },
    close: params.close,
  };
}

export function acquireRunOwner(
  params: TAcquireRunOwnerParams,
): RunOwner | undefined {
  const runDir = join(params.groupDir, params.runId);
  let runDatabase: TRunDatabaseHandle;
  try {
    runDatabase = params.openDatabase(join(runDir, "run.db"));
  } catch {
    return undefined;
  }

  type TAcquireResult =
    | {
        readonly kind: "acquired";
        readonly epoch: number;
        readonly record: RunRecord;
      }
    | { readonly kind: "refused" };

  let acquired: TAcquireResult;
  try {
    acquired = runDatabase.db.transaction(
      (tx): TAcquireResult => {
        const ownership = readRunOwnershipRow(tx);
        const ownerPid = ownership.ownerPid;
        if (
          !params.takeover &&
          ownerPid !== null &&
          ownerPid !== params.selfPid &&
          params.isOwnerAlive(ownerPid)
        ) {
          return { kind: "refused" };
        }
        const record = readRunRecordRow(tx);
        if (record === DAMAGED) return { kind: "refused" };
        const epoch = ownership.ownerEpoch + 1;
        writeRunOwnershipRow(tx, {
          ownerEpoch: epoch,
          ownerPid: params.takeover ? params.selfPid : ownership.ownerPid,
        });
        return { kind: "acquired", epoch, record };
      },
      { behavior: "immediate" },
    );
  } catch {
    runDatabase.close();
    return undefined;
  }
  if (acquired.kind === "refused") {
    runDatabase.close();
    return undefined;
  }
  const close = params.trackHandle(runDatabase);

  return createRunOwner({
    database: runDatabase,
    runDir,
    runId: params.runId,
    record: acquired.record,
    epoch: acquired.epoch,
    close,
  });
}
