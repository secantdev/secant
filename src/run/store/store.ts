import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import type {
  ArtifactType,
  AttemptOutcome,
  ProducedArtifact,
} from "../../workflow/workflow.js";
import {
  isolatedGitEnvironment,
  openArtifactRepo,
  type StageProblem,
} from "./artifacts/artifacts.js";

// Re-exported from the Run Store entry so Preflight can harden its `git` worktree
// probe with the same isolation the private Artifact repo uses, without importing
// the private Artifact Module across the Module boundary (A31).
export { isolatedGitEnvironment };

// The Run Store owns each Run's canonical truth and the cross-Run coordination
// for one Workspace. Runs sharing a resolved absolute Workspace path are grouped
// under a readable `<slug>--<path-digest>` directory; that group's
// `coordination.db` owns only cross-Run facts (Run registration, the one-live-Run
// claim, owner fencing, and create/delete admission), while each Run owns its own
// `run.db` canonical record. Nothing storage-shaped — no SQLite type, no row, no
// path — crosses this Interface; callers ask in domain terms (ADR 0023, ADR 0030,
// #21 storage). `bun:sqlite` is a Bun built-in, so the driver ships inside the
// compiled binary and lives only here and in the Catalog (runtime-neutrality
// allowlist).

/** A Run's canonical record, read back from its own `run.db`. */
export interface RunRecord {
  readonly runId: string;
  readonly workspacePath: string; // the resolved absolute Workspace value, pinned
  readonly bundleSnapshotDigest: string; // the pinned Bundle Snapshot reference
  readonly launch: unknown; // the Launch inputs, stored and returned opaque
  readonly state: string; // canonical Run state (`blocked` is never stored)
  readonly createdAt: string; // ISO 8601
}

/** One registered Run and whether it currently holds the Workspace claim. When
 *  live, `ownerPid` names the process that holds it, so a caller can name the owner
 *  of a Run live in another process (#98 S2). */
export interface RunListing {
  readonly runId: string;
  readonly live: boolean;
  readonly ownerPid?: number;
}

/** Why a Run could not be read: its store is damaged, or no such Run exists. */
export type RunProblem =
  | { readonly kind: "run-store-damaged"; readonly runId: string }
  | { readonly kind: "unknown-run"; readonly runId: string };

export type ReadRunResult =
  | { readonly ok: true; readonly run: RunRecord }
  | { readonly ok: false; readonly problem: RunProblem };

/** The inputs a fresh Run pins. `operationId` makes create idempotent. */
export interface CreateRunRequest {
  readonly operationId: string;
  readonly bundleSnapshotDigest: string;
  readonly launch: unknown; // JSON-serialisable; stored opaque
  readonly at: Date;
}

/**
 * The outcome of an admitted create. `created` and `already-created` (the same
 * operation id replayed) both name the Run; `workspace-busy` refuses because a
 * live Run already holds this Workspace's claim.
 */
export type CreateRunResult =
  | {
      readonly outcome: "created";
      readonly runId: string;
      readonly record: RunRecord;
    }
  | {
      readonly outcome: "already-created";
      readonly runId: string;
      readonly record: RunRecord;
    }
  | { readonly outcome: "workspace-busy"; readonly liveRunId: string };

/** The outcome of an admitted delete; idempotent per operation id. */
export type DeleteRunResult =
  | { readonly outcome: "deleted"; readonly runId: string }
  | { readonly outcome: "already-deleted"; readonly runId: string };

/** The outcome of a resume claim. `resumed` re-holds the Workspace claim (or the
 *  Run already held it); `workspace-busy` refuses because a different live Run
 *  holds it; `unknown-run` names a Run this group never registered. */
export type ResumeRunResult =
  | { readonly outcome: "resumed"; readonly runId: string }
  | { readonly outcome: "workspace-busy"; readonly liveRunId: string }
  | { readonly outcome: "unknown-run"; readonly runId: string };

/** A write against a fenced owner is refused; nothing is written. */
export type WriteResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: "fenced" };

/** A candidate output a producer wrote once, ready to publish together. */
export interface CandidateOutput {
  readonly name: string;
  readonly type: ArtifactType;
  /** Portable regular-file bytes. */
  readonly content: Uint8Array;
}

/** One Step Attempt's outcome and, when it succeeded, the outputs to publish. */
export interface PublishAttemptRequest {
  readonly attemptId: string;
  readonly outcome: AttemptOutcome;
  /** The Step contract's required outputs, validated before anything commits.
   *  Only consulted for a succeeded Attempt. */
  readonly required: readonly ProducedArtifact[];
  /** The candidate outputs; empty unless the Attempt succeeded. */
  readonly outputs: readonly CandidateOutput[];
  readonly at: Date;
  /** Optional canonical Run state to advance to in the same transaction. */
  readonly advanceState?: string;
}

/** The outcome of a publication attempt. A fenced owner or an unstageable set
 *  moves no binding and settles nothing. */
export type PublishAttemptResult =
  | { readonly ok: true; readonly versionId?: string }
  | { readonly ok: false; readonly reason: "fenced" }
  | { readonly ok: false; readonly problem: StageProblem };

/** One append-only record of how an Attempt ended. */
export interface AttemptLogEntry {
  readonly attemptId: string;
  readonly outcome: AttemptOutcome;
  readonly at: string;
}

/** A recorded Materialization conflict: a `home: workspace` Artifact's Workspace
 *  copy went missing or changed before a Step could use it (ADR 0023). */
export interface MaterializationConflict {
  readonly diagnosticId: string;
  readonly artifactName: string;
  readonly path: string; // the declared relative Workspace path
  readonly versionId: string; // the bound version the copy failed to match
  readonly at: string; // ISO 8601
}

/** The request to record one Materialization conflict. The store writes the
 *  diagnostic to its own `diagnostics/` and rests the Run `halted`; it never
 *  reads or writes the Workspace and moves no binding. */
export interface RecordConflictRequest {
  readonly artifactName: string;
  readonly path: string;
  readonly versionId: string;
  /** The human-readable diagnostic bytes, retained under `diagnostics/`. */
  readonly diagnostic: Uint8Array;
  readonly at: Date;
}
export type RecordConflictResult =
  | { readonly ok: true; readonly diagnosticId: string }
  | { readonly ok: false; readonly reason: "fenced" };

/** A durable Human Gate answer recorded against a blocked Run (#85). It is a
 *  bound Run Artifact (readable like any output) and survives process death; the
 *  attempt log is deliberately untouched, so `blocked` derivation and the
 *  iteration count are unaffected. */
export interface GateAnswerRecord {
  readonly answerId: string;
  readonly operationId: string; // caller-generated; makes recording idempotent
  readonly gateAttemptId: string; // the Gate reference's Attempt this answers
  readonly answer: "continue" | "stop";
  /** Cumulative Repeat-group iterations completed when this answer was recorded,
   *  so the derived "iterations since the last grant" count resets here. */
  readonly iterationsAtGrant: number;
  readonly versionId: string; // the bound answer Artifact's version
  readonly at: string; // ISO 8601
}

/** The request to record one Human Gate answer as a durable, bound Artifact. */
export interface RecordGateAnswerRequest {
  readonly operationId: string;
  readonly gateAttemptId: string;
  readonly answer: "continue" | "stop";
  readonly iterationsAtGrant: number;
  /** The Artifact name the answer binds, so it reads back like any output. */
  readonly artifactName: string;
  readonly at: Date;
  /** Optional canonical state to advance to in the same transaction (`failed`
   *  for a `stop`, so the answer and the rest commit together). */
  readonly advanceState?: string;
}
export type RecordGateAnswerResult =
  | {
      readonly ok: true;
      readonly versionId: string;
      /** True when this operation id was already recorded (idempotent replay). */
      readonly replayed: boolean;
    }
  | { readonly ok: false; readonly reason: "fenced" }
  | { readonly ok: false; readonly problem: StageProblem };

/**
 * Ownership of one Run's canonical store. Acquiring bumps a fencing epoch, so a
 * stale owner (a crashed process that comes back) is fenced: its canonical
 * writes are refused. The caller owns the handle and closes it; the group closes
 * any it still holds.
 */
export interface RunOwner {
  readonly runId: string;
  readonly record: RunRecord;
  /** Record the Run's canonical state, unless this owner has been fenced. */
  writeState(state: string): WriteResult;
  /**
   * Publish one Step Attempt all-or-nothing. A succeeded Attempt stages one
   * commit (the version id) for its whole output set, then a single `run.db`
   * transaction records every version, moves every binding, settles the Attempt,
   * and optionally advances the Run. A failed/cancelled/indeterminate Attempt
   * settles and logs its outcome, moving no binding. Idempotent per attempt id.
   */
  publishAttempt(request: PublishAttemptRequest): PublishAttemptResult;
  /** The current version id bound to an artifact name, or undefined if unbound. */
  currentVersion(name: string): string | undefined;
  /** The bytes of an artifact at a version, or undefined if that path is absent. */
  readArtifact(versionId: string, name: string): Uint8Array | undefined;
  /** Every Attempt outcome in append order. */
  attemptLog(): readonly AttemptLogEntry[];
  /**
   * Record a Materialization conflict and rest the Run `halted` in one
   * transaction: write the diagnostic under `diagnostics/`, append the conflict
   * record, and set the canonical state to `halted`. Moves no binding and never
   * touches the Workspace, so the "never overwrite / never adopt" invariant holds
   * trivially (the store has no Workspace access). Refused if this owner is fenced.
   */
  recordMaterializationConflict(
    request: RecordConflictRequest,
  ): RecordConflictResult;
  /** Every recorded Materialization conflict, in append order. */
  materializationConflicts(): readonly MaterializationConflict[];
  /** The bytes of a recorded diagnostic by id, or undefined if it is absent. */
  readDiagnostic(diagnosticId: string): Uint8Array | undefined;
  /**
   * Record a durable Human Gate answer as a bound Artifact (#85): stage its bytes
   * as one commit, then a single `run.db` transaction records the version, moves
   * the binding, appends the answer, and optionally advances the Run — all or
   * nothing. The attempt log is untouched, so `blocked` stays derived. Idempotent
   * per operation id; refused if this owner is fenced.
   */
  recordGateAnswer(request: RecordGateAnswerRequest): RecordGateAnswerResult;
  /** Every recorded Human Gate answer, in append order. */
  gateAnswers(): readonly GateAnswerRecord[];
  close(): void;
}

export interface RunGroup {
  /**
   * Admit a fresh Run: stage its store under a `.creating` quarantine, publish it
   * atomically, register it, and claim the Workspace. A second create while a Run
   * is live is refused `workspace-busy`; replaying an operation id returns the Run
   * it already created.
   */
  createRun(request: CreateRunRequest): CreateRunResult;
  /**
   * Admit a delete: release the claim and registration, then reclaim the store
   * under a `.deleting` quarantine. Idempotent per operation id; deleting an
   * absent Run still succeeds.
   */
  deleteRun(request: {
    readonly operationId: string;
    readonly runId: string;
  }): DeleteRunResult;
  /**
   * Release a Run's Workspace claim so a fresh Run can be created, while its
   * canonical store stays until an explicit delete. Idempotent; ending an absent
   * or already-ended Run is a no-op.
   */
  endRun(runId: string): void;
  /**
   * Re-claim the Workspace for a Run so an explicit human resume can drive it
   * further (ADR 0023). Refused `workspace-busy` if a different Run holds the
   * claim; a no-op `resumed` if this Run already holds it. The caller then
   * `acquireRun`s for fresh ownership.
   */
  resumeRun(runId: string): ResumeRunResult;
  /** Take ownership of a Run, fencing any earlier owner; undefined if unreadable. */
  acquireRun(runId: string): RunOwner | undefined;
  /** Every registered Run in this group. Order is unspecified. */
  listRuns(): readonly RunListing[];
  /** A Run's canonical record, or a Problem when its store is damaged or absent. */
  readRun(runId: string): ReadRunResult;
  /** Release every file handle (coordination and any acquired Run). */
  close(): void;
}

// One schema per persisted table validates a row at its read ingress (D7). A row
// that fails is a broken invariant — the store drifted or is corrupt — surfaced
// as a damaged-store Problem for reads and a throw for coordination, never a
// silently trusted value.
const runRecordRow = z.object({
  run_id: z.string(),
  workspace_path: z.string(),
  bundle_snapshot_digest: z.string(),
  launch: z.string(),
  state: z.string(),
  created_at: z.string(),
});
const registrationRow = z.object({
  run_id: z.string(),
  state: z.string(),
  owner_epoch: z.number(),
  owner_pid: z.number().nullable(),
  created_at: z.string(),
});
const bindingRow = z.object({ version_id: z.string() });
// The two columns domain logic branches on are validated to their closed sets at
// the read ingress, not cast (A11): a garbage `outcome` must never reach the
// resume skip cursor or `deriveRun` as a trusted value, nor a garbage `answer`
// the grant count. `z.enum` is the exact schema; the tuples mirror `AttemptOutcome`
// and the Gate answer shape in Workflow / the store's own request types.
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
// The two-column read `reconcileRunStore` makes is validated like every other
// read ingress (A11 / D9), not cast — the sibling `readRunStore` validates the
// same `run_record` table through `runRecordRow`.
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

const DAMAGED = Symbol("run-store-damaged");

/** Whether the process holding a live claim is still running (#98 S2). Signal 0
 *  performs the permission/existence check without delivering a signal: it returns
 *  for a live process, throws `ESRCH` for a dead one, and throws `EPERM` for a
 *  process alive but owned by another user — which still counts as alive. Any other
 *  probe failure is treated as alive, so the group never reconciles (and so kills a
 *  Run's recovery point) on an ambiguous answer. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** A readable `<slug>--<path-digest>` for the resolved absolute Workspace path. */
function groupDirName(workspacePath: string): string {
  const slug =
    basename(workspacePath)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace";
  const digest = createHash("sha256")
    .update(workspacePath)
    .digest("hex")
    .slice(0, 16);
  return `${slug}--${digest}`;
}

function prepareCoordination(database: Database): void {
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(
    "CREATE TABLE IF NOT EXISTS runs (" +
      "run_id TEXT PRIMARY KEY, state TEXT NOT NULL, " +
      "owner_epoch INTEGER NOT NULL, owner_pid INTEGER, " +
      "created_at TEXT NOT NULL) STRICT",
  );
  // Owner liveness (#98 S2): the process id holding the live claim, so a reopened
  // group can tell a Run genuinely executing in another process from a dead owner's
  // stale claim. Nullable and added to a pre-#98 coordination DB in place; a NULL
  // (an old or rebuilt row) reads as no known owner and reconciles as before. Guard
  // the ALTER with a column-existence check rather than a catch-all, so a genuine
  // migration fault (a locked or corrupt DB) fails fast at open with its real cause
  // instead of a confusing "no such column" deep in a later query.
  const hasOwnerPid = (
    database.query("PRAGMA table_info(runs)").all() as { name: string }[]
  ).some((column) => column.name === "owner_pid");
  if (!hasOwnerPid) {
    database.exec("ALTER TABLE runs ADD COLUMN owner_pid INTEGER");
  }
  // At most one live Run per Workspace: the DB itself rejects a second claim, so
  // the one-live-Run invariant survives even a bug in the check above.
  database.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS one_live_run ON runs(state) WHERE state = 'live'",
  );
  database.exec(
    "CREATE TABLE IF NOT EXISTS operations (" +
      "operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, " +
      "run_id TEXT NOT NULL, recorded_at TEXT NOT NULL) STRICT",
  );
}

function toRunRecord(row: z.infer<typeof runRecordRow>): RunRecord {
  return {
    runId: row.run_id,
    workspacePath: row.workspace_path,
    bundleSnapshotDigest: row.bundle_snapshot_digest,
    launch: JSON.parse(row.launch) as unknown,
    state: row.state,
    createdAt: row.created_at,
  };
}

/** Build a fresh `run.db` (plus `staging/` and `diagnostics/`) inside `dir` and
 *  close its handle, so the directory can be renamed on Windows. */
function stageRunStore(dir: string, record: RunRecord): void {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "staging"), { recursive: true });
  // `diagnostics/` is created empty here; `recordMaterializationConflict` is its
  // writer (#88), and `pruneDiagnostics` enforces the ADR 0023 90-day retention at
  // group open.
  mkdirSync(join(dir, "diagnostics"), { recursive: true });
  const database = new Database(join(dir, "run.db"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(
      "CREATE TABLE IF NOT EXISTS run_record (" +
        "run_id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, " +
        "bundle_snapshot_digest TEXT NOT NULL, launch TEXT NOT NULL, " +
        "state TEXT NOT NULL, created_at TEXT NOT NULL) STRICT",
    );
    // Artifact publication tables (#80). A version row records one artifact of one
    // publication commit; a binding names the current version per artifact; an
    // attempt row settles an Attempt once (its PK makes publication idempotent);
    // the log appends every outcome. The private `artifacts.git` beside `run.db`
    // holds the content and is created lazily on the first publication.
    database.exec(
      "CREATE TABLE IF NOT EXISTS artifact_version (" +
        "version_id TEXT NOT NULL, artifact_name TEXT NOT NULL, " +
        "artifact_type TEXT NOT NULL, attempt_id TEXT NOT NULL, " +
        "created_at TEXT NOT NULL, PRIMARY KEY (version_id, artifact_name)) STRICT",
    );
    database.exec(
      "CREATE TABLE IF NOT EXISTS artifact_binding (" +
        "artifact_name TEXT PRIMARY KEY, version_id TEXT NOT NULL, " +
        "updated_at TEXT NOT NULL) STRICT",
    );
    database.exec(
      "CREATE TABLE IF NOT EXISTS attempt (" +
        "attempt_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, " +
        "version_id TEXT, settled_at TEXT NOT NULL) STRICT",
    );
    database.exec(
      "CREATE TABLE IF NOT EXISTS attempt_log (" +
        "seq INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL, " +
        "outcome TEXT NOT NULL, at TEXT NOT NULL) STRICT",
    );
    // A Materialization conflict (#88): each row is one detected mismatch, its
    // detailed diagnostic retained as a file under `diagnostics/`. Append-only —
    // recording a conflict rests the Run `halted` in the same transaction.
    database.exec(
      "CREATE TABLE IF NOT EXISTS materialization_conflict (" +
        "seq INTEGER PRIMARY KEY, diagnostic_id TEXT NOT NULL, " +
        "artifact_name TEXT NOT NULL, artifact_path TEXT NOT NULL, " +
        "version_id TEXT NOT NULL, at TEXT NOT NULL) STRICT",
    );
    // A durable Human Gate answer (#85): each row is one grant/stop against a
    // blocked Run's Gate. `operation_id` is UNIQUE so a replayed answer records
    // once. Append-only and separate from `attempt_log`, so `blocked` stays
    // derived and iterations are counted since the latest row's grant point.
    database.exec(
      "CREATE TABLE IF NOT EXISTS gate_answer (" +
        "seq INTEGER PRIMARY KEY, answer_id TEXT NOT NULL, " +
        "operation_id TEXT NOT NULL UNIQUE, gate_attempt_id TEXT NOT NULL, " +
        "answer TEXT NOT NULL, iterations_at_grant INTEGER NOT NULL, " +
        "version_id TEXT NOT NULL, at TEXT NOT NULL) STRICT",
    );
    database
      .query(
        "INSERT INTO run_record (run_id, workspace_path, bundle_snapshot_digest, " +
          "launch, state, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.runId,
        record.workspacePath,
        record.bundleSnapshotDigest,
        JSON.stringify(record.launch ?? null),
        record.state,
        record.createdAt,
      );
  } finally {
    database.close();
  }
}

/** Read a Run's canonical record, or `DAMAGED` when the store is unreadable, or
 *  `undefined` when no `run.db` is present. Holds no handle on return. */
function readRunStore(dir: string): RunRecord | typeof DAMAGED | undefined {
  const path = join(dir, "run.db");
  if (!existsSync(path)) return undefined;
  let database: Database | undefined;
  try {
    database = new Database(path);
    // Wait briefly for a concurrent writer rather than misreading a live Run's
    // write lock as a damaged store (which would drop it from `run list`), like
    // every other open in this Module.
    database.exec("PRAGMA busy_timeout = 5000");
    const row = database
      .query(
        "SELECT run_id, workspace_path, bundle_snapshot_digest, launch, state, " +
          "created_at FROM run_record LIMIT 1",
      )
      .get();
    if (row == null) return DAMAGED;
    const parsed = runRecordRow.safeParse(row);
    return parsed.success ? toRunRecord(parsed.data) : DAMAGED;
  } catch {
    // A corrupt file (not a database, wrong schema) is damaged for this Run only.
    return DAMAGED;
  } finally {
    database?.close();
  }
}

/**
 * Reconcile a Run whose canonical record is still `running`/`created` — a state
 * only a process actively driving the Run leaves behind — by resting it `halted`
 * with the interrupted Attempt marked `indeterminate` (ADR 0019, ADR 0023, #86).
 * Returns true when it reconciled, so the caller releases the now-stale claim;
 * false when the Run was already at rest or its store is unreadable. Runs no Step
 * work and holds no handle on return.
 */
function reconcileRunStore(dir: string, at: Date): boolean {
  const path = join(dir, "run.db");
  if (!existsSync(path)) return false;
  let database: Database | undefined;
  try {
    database = new Database(path);
    database.exec("PRAGMA busy_timeout = 5000");
    const raw = database
      .query("SELECT run_id, state FROM run_record LIMIT 1")
      .get();
    if (raw == null) return false;
    const parsed = reconcileRow.safeParse(raw);
    if (!parsed.success) return false; // a damaged row is left for readRun to surface
    const row = parsed.data;
    if (row.state !== "running" && row.state !== "created") {
      return false;
    }
    const isoAt = at.toISOString();
    // Append the indeterminate marker and rest `halted` together, so recovery is
    // atomic: a crash mid-reconcile leaves the Run still `running` to reconcile
    // again, never half-reconciled. The marker is recovery evidence appended to
    // the log (ADR 0023), not a settled `attempt` row — so the resume skip cursor
    // (succeeded Attempts) is unchanged and the interrupted Step re-runs.
    const reconcile = database.transaction(() => {
      database!
        .query(
          "INSERT INTO attempt_log (attempt_id, outcome, at) VALUES (?, ?, ?)",
        )
        .run(randomUUID(), "indeterminate", isoAt);
      database!
        .query("UPDATE run_record SET state = 'halted' WHERE run_id = ?")
        .run(row.run_id);
    });
    reconcile();
    return true;
  } catch {
    // A damaged run.db is left untouched; readRun surfaces it as a Problem later.
    return false;
  } finally {
    database?.close();
  }
}

/** The Run directories in a group, excluding the coordination DB and quarantines. */
function runDirNames(groupDir: string): string[] {
  return readdirSync(groupDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.endsWith(".creating") &&
        !entry.name.endsWith(".deleting"),
    )
    .map((entry) => entry.name);
}

// ADR 0023: detailed diagnostics expire after 90 days by default. `diagnostics/`
// has had a writer since #88 (`recordMaterializationConflict`), so the retention
// is implemented as a prune at group open — the one moment every Run in the group
// is visited without holding a Run open.
const DIAGNOSTICS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Remove every diagnostics file older than the 90-day retention window from each
 *  Run's `diagnostics/`, run once at group open against an injectable clock. A file
 *  whose mtime is at or before `now - 90 days` is deleted; a newer one is kept.
 *  Best-effort: a Run without a `diagnostics/` dir, an unreadable entry, or a file
 *  a racing delete already removed is skipped, never fatal to opening the group. */
function pruneDiagnostics(groupDir: string, now: Date): void {
  const cutoff = now.getTime() - DIAGNOSTICS_RETENTION_MS;
  for (const runName of runDirNames(groupDir)) {
    const dir = join(groupDir, runName, "diagnostics");
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // no diagnostics dir yet (or unreadable) — nothing to prune
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      try {
        if (statSync(path).mtimeMs <= cutoff) rmSync(path, { force: true });
      } catch {
        // A racing delete or an unreadable entry: leave it for the next open.
      }
    }
  }
}

/** Remove any leftover `.creating` / `.deleting` quarantine a crash left behind. */
function cleanQuarantine(groupDir: string): void {
  for (const entry of readdirSync(groupDir)) {
    if (entry.endsWith(".creating") || entry.endsWith(".deleting")) {
      rmSync(join(groupDir, entry), { recursive: true, force: true });
    }
  }
}

/** Open the coordination DB, rebuilding it bare-bones from the readable Run
 *  Stores (no owner, no claim) when the existing file is corrupt. */
function openCoordination(
  coordinationPath: string,
  groupDir: string,
): { database: Database; rebuilt: boolean } {
  try {
    const database = new Database(coordinationPath);
    try {
      prepareCoordination(database);
      database.query("SELECT COUNT(*) AS n FROM runs").get();
      database.query("SELECT COUNT(*) AS n FROM operations").get();
    } catch (error) {
      // Close the handle before the file is deleted below: on Windows an open
      // handle to the corrupt file locks it, so `rmSync` would fail with EBUSY.
      database.close();
      throw error;
    }
    return { database, rebuilt: false };
  } catch {
    rmSync(coordinationPath, { force: true });
  }
  const database = new Database(coordinationPath);
  prepareCoordination(database);
  const insert = database.query(
    "INSERT INTO runs (run_id, state, owner_epoch, created_at) VALUES (?, 'ended', 0, ?)",
  );
  // Register each readable Run with no owner and no claim; a Run with a damaged
  // run.db is left unregistered but its bytes stay untouched (canonical truth
  // survives until an explicit delete).
  // ponytail: the admission ledger (`operations`) is not rebuilt — a Run's run.db
  // does not record the operation id that created it. So a create/delete retry
  // that races a coordination-corruption rebuild is no longer deduplicated and
  // may make a second Run. That is a double fault (corruption plus the exact same
  // operation id retried) and yields a duplicate, not data loss; persist the
  // create operation id in run.db and re-seed from it here if it ever bites.
  for (const name of runDirNames(groupDir)) {
    const record = readRunStore(join(groupDir, name));
    if (record !== undefined && record !== DAMAGED) {
      insert.run(record.runId, record.createdAt);
    }
  }
  return { database, rebuilt: true };
}

/**
 * Open (creating on first use) the Run group for a resolved absolute Workspace
 * path. The path is pinned as given — the Application owns canonicalisation. The
 * caller owns the returned group and must close it. Under `~/.secant` by default
 * (`%USERPROFILE%\\.secant` on Windows via `homedir()`), or `SECANT_HOME` when
 * set — both resolved by composition, not here.
 */
export function openRunGroup(
  secantHome: string,
  workspacePath: string,
  options: {
    readonly now?: () => Date;
    /** Whether the process holding a live claim is still alive (#98 S2). Defaults
     *  to a real probe (`process.kill(pid, 0)`); a test injects a fixed answer to
     *  simulate a dead owner (reconcile `halted`) or a live one (leave it live). */
    readonly isOwnerAlive?: (pid: number) => boolean;
    /** The process id this group records on the claims it opens (#98 S2). Defaults
     *  to the real pid; a test overrides it so two `openRunGroup`s on one home stand
     *  in for two processes with distinct pids. */
    readonly selfPid?: number;
  } = {},
): RunGroup {
  const selfPid = options.selfPid ?? process.pid;
  const isOwnerAlive = options.isOwnerAlive ?? processIsAlive;
  const groupDir = join(secantHome, "runs", groupDirName(workspacePath));
  mkdirSync(groupDir, { recursive: true });
  const { database, rebuilt } = openCoordination(
    join(groupDir, "coordination.db"),
    groupDir,
  );
  cleanQuarantine(groupDir);
  // ADR 0023 retention: prune expired diagnostics at open (A9), before any Run is
  // acquired. Best-effort and injectable-clock-driven for deterministic tests.
  pruneDiagnostics(groupDir, (options.now ?? (() => new Date()))());
  // Reconcile the directory against the registrations. An intact coordination DB
  // is authoritative, so a Run directory it does not list is a crash orphan — an
  // unpublished create (renamed but uncommitted) or a committed delete whose
  // reclaim never ran — and is removed. Skipped after a rebuild, where the
  // registrations were just re-seeded from these same directories.
  if (!rebuilt) {
    const registered = new Set(
      (
        database.query("SELECT run_id FROM runs").all() as {
          run_id: string;
        }[]
      ).map((row) => row.run_id),
    );
    for (const name of runDirNames(groupDir)) {
      if (!registered.has(name)) {
        rmSync(join(groupDir, name), { recursive: true, force: true });
      }
    }
  }

  // `.query()` (not `.prepare()`) so the Database owns and finalises these
  // statements on close, releasing the file handle immediately (Windows cleanup).
  // Replay is keyed by (operation id, kind): a create retry never matches a delete
  // receipt, and vice versa, so a reused id cannot be silently mistaken for a
  // completed operation of the other kind.
  const findOperation = database.query(
    "SELECT run_id FROM operations WHERE operation_id = ? AND kind = ?",
  );
  const findLive = database.query(
    "SELECT run_id FROM runs WHERE state = 'live' LIMIT 1",
  );
  const findRegistration = database.query(
    "SELECT run_id, state, owner_epoch, owner_pid, created_at FROM runs WHERE run_id = ?",
  );
  const listRegistrations = database.query(
    "SELECT run_id, state, owner_epoch, owner_pid, created_at FROM runs",
  );
  const insertRun = database.query(
    "INSERT INTO runs (run_id, state, owner_epoch, owner_pid, created_at) " +
      "VALUES (?, 'live', 0, ?, ?)",
  );
  const deleteRun = database.query("DELETE FROM runs WHERE run_id = ?");
  // Ending a Run releases the claim and clears the owner pid, so a later reopen
  // never mistakes a cleanly-ended Run's stale pid for a live owner.
  const endRun = database.query(
    "UPDATE runs SET state = 'ended', owner_pid = NULL WHERE run_id = ?",
  );
  const claimRun = database.query(
    "UPDATE runs SET state = 'live', owner_pid = ? WHERE run_id = ?",
  );
  const recordOperation = database.query(
    "INSERT INTO operations (operation_id, kind, run_id, recorded_at) VALUES (?, ?, ?, ?)",
  );
  const clearRunOperations = database.query(
    "DELETE FROM operations WHERE run_id = ?",
  );
  const bumpEpoch = database.query(
    "UPDATE runs SET owner_epoch = owner_epoch + 1 WHERE run_id = ? RETURNING owner_epoch",
  );
  const readEpoch = database.query(
    "SELECT owner_epoch FROM runs WHERE run_id = ?",
  );

  // Every acquired Run's run.db handles, keyed by Run id, so the group can close
  // them all — and, before a delete reclaims a Run's directory, close exactly that
  // Run's handles so the rename never trips over an open file (Windows cleanup).
  const runHandles = new Map<string, Set<Database>>();
  function closeRunHandles(runId: string): void {
    const handles = runHandles.get(runId);
    if (handles === undefined) return;
    for (const handle of handles) handle.close();
    // Empty the set the owners still reference, so a later RunOwner.close() sees
    // nothing to close rather than closing the same handle twice.
    handles.clear();
    runHandles.delete(runId);
  }

  // Admit a create under BEGIN IMMEDIATE, so the one-live-Run claim is decided
  // under the write lock even across processes (the named Windows risk). Ordering:
  // stage the store, register + record the operation, then publish (rename) last —
  // any failure before the rename leaves only the `.creating` quarantine, which
  // the next open removes.
  const admitCreate = database.transaction(
    (request: CreateRunRequest): CreateRunResult => {
      const replay = findOperation.get(request.operationId, "create") as {
        run_id: string;
      } | null;
      if (replay != null) {
        const record = readRunStore(join(groupDir, replay.run_id));
        if (record === undefined || record === DAMAGED) {
          // A create receipt whose Run vanished without a delete (a delete frees
          // its own create receipt) is a broken invariant — external tampering —
          // not an ordinary outcome, so it throws rather than fabricate a Run.
          throw new Error(
            `Run Store: admitted Run ${replay.run_id} has no readable record.`,
          );
        }
        return { outcome: "already-created", runId: replay.run_id, record };
      }
      const live = findLive.get() as { run_id: string } | null;
      if (live != null) {
        return { outcome: "workspace-busy", liveRunId: live.run_id };
      }
      const runId = randomUUID();
      const record: RunRecord = {
        runId,
        workspacePath,
        bundleSnapshotDigest: request.bundleSnapshotDigest,
        launch: request.launch,
        state: "created",
        createdAt: request.at.toISOString(),
      };
      stageRunStore(join(groupDir, `${runId}.creating`), record);
      insertRun.run(runId, selfPid, record.createdAt);
      recordOperation.run(
        request.operationId,
        "create",
        runId,
        record.createdAt,
      );
      renameSync(join(groupDir, `${runId}.creating`), join(groupDir, runId));
      return { outcome: "created", runId, record };
    },
  );

  // Admit a delete under BEGIN IMMEDIATE: drop the registration and record the
  // operation first (the claim is released the moment this commits), then reclaim
  // the directory. A crash after the commit leaves at worst a `.deleting`
  // quarantine (or the plain directory), which the next open reconciles; the Run
  // is never left half-registered. Clearing the Run's operation rows retires its
  // create receipt, so a much-delayed create retry after the delete starts a
  // fresh Run rather than replaying a mapping to bytes that are gone.
  const admitDelete = database.transaction(
    (operationId: string, runId: string): DeleteRunResult => {
      const replay = findOperation.get(operationId, "delete") as {
        run_id: string;
      } | null;
      if (replay != null) {
        return { outcome: "already-deleted", runId: replay.run_id };
      }
      deleteRun.run(runId);
      clearRunOperations.run(runId);
      recordOperation.run(
        operationId,
        "delete",
        runId,
        new Date().toISOString(),
      );
      return { outcome: "deleted", runId };
    },
  );

  // Re-claim the Workspace for an existing Run under BEGIN IMMEDIATE, so the
  // one-live-Run decision is made under the write lock like a create. Already
  // live for this Run is an idempotent `resumed`; a different live Run refuses.
  const admitResume = database.transaction((runId: string): ResumeRunResult => {
    const registration = findRegistration.get(runId) as {
      run_id: string;
      state: string;
    } | null;
    if (registration == null) return { outcome: "unknown-run", runId };
    if (registration.state === "live") return { outcome: "resumed", runId };
    const live = findLive.get() as { run_id: string } | null;
    if (live != null && live.run_id !== runId) {
      return { outcome: "workspace-busy", liveRunId: live.run_id };
    }
    claimRun.run(selfPid, runId);
    return { outcome: "resumed", runId };
  });

  function reclaimRunDir(runId: string): void {
    const finalDir = join(groupDir, runId);
    if (!existsSync(finalDir)) return;
    const deletingDir = join(groupDir, `${runId}.deleting`);
    renameSync(finalDir, deletingDir);
    rmSync(deletingDir, { recursive: true, force: true });
  }

  // Startup reconciliation (ADR 0023, #86, #98 S2): a live Workspace claim found at
  // open whose owner process is gone is stale — a clean exit releases it via endRun,
  // so a dead owner died mid-Run (Ctrl+C, a termination signal, a crash). A rested
  // Run (succeeded, failed, halted, or a derived-`blocked` Run stored `running`) has
  // already released its claim, so the claim — not the stored state — is what
  // distinguishes a killed Run from a resting one. Rest each dead-owner Run `halted`
  // with the interrupted Attempt `indeterminate` and release the claim, running no
  // Step work, so a reopened home never silently resumes execution (ADR 0019).
  //
  // Owner liveness (#98 S2): a live claim whose owner process is still alive is a Run
  // genuinely executing in another process — leave it live and unaltered (it stays
  // listed live-elsewhere, and opening or resuming it is refused). A missing pid (a
  // pre-#98 DB or a rebuilt coordination file) is treated as a dead owner, so the
  // prior single-process behavior is preserved. The recorded pid is never our own at
  // open (this process registers nothing until after open), so an alive foreign pid
  // is always another process.
  for (const row of listRegistrations.all() as Record<string, unknown>[]) {
    const parsed = registrationRow.safeParse(row);
    if (!parsed.success || parsed.data.state !== "live") continue;
    const pid = parsed.data.owner_pid;
    if (pid != null && pid !== selfPid && isOwnerAlive(pid)) continue;
    reconcileRunStore(join(groupDir, parsed.data.run_id), new Date());
    endRun.run(parsed.data.run_id);
  }

  return {
    createRun(request) {
      return admitCreate.immediate(request);
    },
    deleteRun({ operationId, runId }) {
      const result = admitDelete.immediate(operationId, runId);
      // Reclaim the bytes after the registration is gone; a fault here only leaks
      // a directory the next open sweeps, never a half-deleted registration. Close
      // any owner's handle first so the rename is not blocked by an open file.
      if (result.outcome === "deleted") {
        closeRunHandles(runId);
        reclaimRunDir(runId);
      }
      return result;
    },
    endRun(runId) {
      // ponytail: releasing the claim is not owner-fenced here; no caller needs a
      // stale owner blocked from ending yet. Guard with the epoch if one ever does.
      endRun.run(runId);
    },
    resumeRun(runId) {
      return admitResume.immediate(runId);
    },
    acquireRun(runId) {
      const record = readRunStore(join(groupDir, runId));
      if (record === undefined || record === DAMAGED) return undefined;
      const bumped = bumpEpoch.get(runId) as { owner_epoch: number } | null;
      if (bumped == null) return undefined;
      const epoch = bumped.owner_epoch;
      const runDir = join(groupDir, runId);
      const runDatabase = new Database(join(runDir, "run.db"));
      runDatabase.exec("PRAGMA busy_timeout = 5000");
      const handles = runHandles.get(runId) ?? new Set<Database>();
      handles.add(runDatabase);
      runHandles.set(runId, handles);
      const repo = openArtifactRepo(runDir);
      const updateState = runDatabase.query(
        "UPDATE run_record SET state = ? WHERE run_id = ?",
      );
      const findAttempt = runDatabase.query(
        "SELECT outcome, version_id FROM attempt WHERE attempt_id = ?",
      );
      const findBinding = runDatabase.query(
        "SELECT version_id FROM artifact_binding WHERE artifact_name = ?",
      );
      const listLog = runDatabase.query(
        "SELECT attempt_id, outcome, at FROM attempt_log ORDER BY seq",
      );
      const insertVersion = runDatabase.query(
        "INSERT INTO artifact_version (version_id, artifact_name, artifact_type, " +
          "attempt_id, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      const upsertBinding = runDatabase.query(
        "INSERT INTO artifact_binding (artifact_name, version_id, updated_at) " +
          "VALUES (?, ?, ?) ON CONFLICT (artifact_name) DO UPDATE SET " +
          "version_id = excluded.version_id, updated_at = excluded.updated_at",
      );
      const insertAttempt = runDatabase.query(
        "INSERT INTO attempt (attempt_id, outcome, version_id, settled_at) " +
          "VALUES (?, ?, ?, ?)",
      );
      const insertLog = runDatabase.query(
        "INSERT INTO attempt_log (attempt_id, outcome, at) VALUES (?, ?, ?)",
      );
      const insertConflict = runDatabase.query(
        "INSERT INTO materialization_conflict (diagnostic_id, artifact_name, " +
          "artifact_path, version_id, at) VALUES (?, ?, ?, ?, ?)",
      );
      const listConflicts = runDatabase.query(
        "SELECT diagnostic_id, artifact_name, artifact_path, version_id, at " +
          "FROM materialization_conflict ORDER BY seq",
      );
      const findGateAnswer = runDatabase.query(
        "SELECT answer_id, version_id FROM gate_answer WHERE operation_id = ?",
      );
      const insertGateAnswer = runDatabase.query(
        "INSERT INTO gate_answer (answer_id, operation_id, gate_attempt_id, " +
          "answer, iterations_at_grant, version_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const listGateAnswers = runDatabase.query(
        "SELECT answer_id, operation_id, gate_attempt_id, answer, " +
          "iterations_at_grant, version_id, at FROM gate_answer ORDER BY seq",
      );

      // The single publication transaction: record every version, move every
      // binding, settle the Attempt, and advance the Run — all or nothing. A
      // succeeded Attempt carries its staged version id; the others carry none.
      const publishTransaction = runDatabase.transaction(
        (request: PublishAttemptRequest, versionId: string | undefined) => {
          const at = request.at.toISOString();
          if (versionId !== undefined) {
            for (const output of request.outputs) {
              insertVersion.run(
                versionId,
                output.name,
                output.type,
                request.attemptId,
                at,
              );
              upsertBinding.run(output.name, versionId, at);
            }
          }
          insertAttempt.run(
            request.attemptId,
            request.outcome,
            versionId ?? null,
            at,
          );
          insertLog.run(request.attemptId, request.outcome, at);
          if (request.advanceState !== undefined) {
            updateState.run(request.advanceState, runId);
          }
        },
      );

      // Record the conflict and rest `halted` together: the conflict is the
      // immutable transition that rests the Run, so a crash never leaves it
      // recorded-but-still-running (the same ordering publishAttempt uses).
      const conflictTransaction = runDatabase.transaction(
        (request: RecordConflictRequest, diagnosticId: string) => {
          insertConflict.run(
            diagnosticId,
            request.artifactName,
            request.path,
            request.versionId,
            request.at.toISOString(),
          );
          updateState.run("halted", runId);
        },
      );

      // Record the gate answer and (for a `stop`) rest the Run together: the
      // version and binding move, the answer is appended, and the optional state
      // advance commits atomically — the same all-or-nothing ordering as a
      // publication, but without touching the attempt log.
      const gateAnswerTransaction = runDatabase.transaction(
        (
          request: RecordGateAnswerRequest,
          answerId: string,
          versionId: string,
        ) => {
          const at = request.at.toISOString();
          insertVersion.run(
            versionId,
            request.artifactName,
            "text",
            answerId,
            at,
          );
          upsertBinding.run(request.artifactName, versionId, at);
          insertGateAnswer.run(
            answerId,
            request.operationId,
            request.gateAttemptId,
            request.answer,
            request.iterationsAtGrant,
            versionId,
            at,
          );
          if (request.advanceState !== undefined) {
            updateState.run(request.advanceState, runId);
          }
        },
      );

      const diagnosticsDir = join(runDir, "diagnostics");

      function fenced(): boolean {
        const current = readEpoch.get(runId) as {
          owner_epoch: number;
        } | null;
        return current == null || current.owner_epoch !== epoch;
      }

      return {
        runId,
        record,
        writeState(state) {
          if (fenced()) return { ok: false, reason: "fenced" };
          updateState.run(state, runId);
          return { ok: true };
        },
        publishAttempt(request) {
          if (fenced()) return { ok: false, reason: "fenced" };
          // Idempotent: a settled Attempt replays its recorded outcome without
          // staging a second commit.
          const settled = findAttempt.get(request.attemptId);
          if (settled != null) {
            const parsed = attemptRow.parse(settled);
            return { ok: true, versionId: parsed.version_id ?? undefined };
          }
          if (request.outcome === "succeeded") {
            // Stage the commit (invisible candidate storage) before the
            // transaction; a missing output or an absent `git` is a Problem here,
            // with no `run.db` change.
            const staged = repo.stageCommit(
              request.attemptId,
              request.required,
              request.outputs,
              request.at,
            );
            if (!staged.ok) return { ok: false, problem: staged.problem };
            // Re-check the epoch after the (subprocess-slow) staging: a fresh
            // owner may have fenced this one meanwhile, and the publication is a
            // canonical write, so a stale owner must be refused.
            if (fenced()) return { ok: false, reason: "fenced" };
            publishTransaction(request, staged.versionId);
            return { ok: true, versionId: staged.versionId };
          }
          // A failed/cancelled/indeterminate Attempt moves no binding.
          publishTransaction(request, undefined);
          return { ok: true };
        },
        currentVersion(name) {
          const row = findBinding.get(name);
          return row == null ? undefined : bindingRow.parse(row).version_id;
        },
        readArtifact(versionId, name) {
          return repo.read(versionId, name);
        },
        attemptLog() {
          return (listLog.all() as Record<string, unknown>[]).map((row) => {
            const parsed = attemptLogRow.parse(row);
            return {
              attemptId: parsed.attempt_id,
              outcome: parsed.outcome,
              at: parsed.at,
            };
          });
        },
        recordMaterializationConflict(request) {
          if (fenced()) return { ok: false, reason: "fenced" };
          const diagnosticId = randomUUID();
          // Write the diagnostic file first (invisible candidate storage, like a
          // staged commit); the transaction that appends the conflict and rests
          // `halted` is the publication point. A crash between the two leaves an
          // orphan diagnostic file the Run's deletion sweeps — no binding moves,
          // and the Workspace is never touched here.
          mkdirSync(diagnosticsDir, { recursive: true });
          writeFileSync(join(diagnosticsDir, diagnosticId), request.diagnostic);
          if (fenced()) return { ok: false, reason: "fenced" };
          conflictTransaction(request, diagnosticId);
          return { ok: true, diagnosticId };
        },
        materializationConflicts() {
          return (listConflicts.all() as Record<string, unknown>[]).map(
            (row) => {
              const parsed = conflictRow.parse(row);
              return {
                diagnosticId: parsed.diagnostic_id,
                artifactName: parsed.artifact_name,
                path: parsed.artifact_path,
                versionId: parsed.version_id,
                at: parsed.at,
              };
            },
          );
        },
        readDiagnostic(diagnosticId) {
          // A diagnostic id is a UUID this owner generated; guard the join anyway
          // so a crafted id can never escape the diagnostics directory.
          if (!/^[A-Za-z0-9-]+$/.test(diagnosticId)) return undefined;
          const path = join(diagnosticsDir, diagnosticId);
          try {
            return existsSync(path) ? readFileSync(path) : undefined;
          } catch {
            return undefined;
          }
        },
        recordGateAnswer(request) {
          if (fenced()) return { ok: false, reason: "fenced" };
          // Idempotent per operation id: a replayed answer returns its recorded
          // version without staging a second commit or a second row.
          const existing = findGateAnswer.get(request.operationId) as {
            answer_id: string;
            version_id: string;
          } | null;
          if (existing != null) {
            return { ok: true, versionId: existing.version_id, replayed: true };
          }
          const answerId = randomUUID();
          // Stage the answer bytes (invisible candidate storage) before the
          // transaction; an absent `git` is a Problem here, with no `run.db` change.
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
          // Re-check the epoch after the (subprocess-slow) staging: recording is a
          // canonical write, so a stale owner must be refused.
          if (fenced()) return { ok: false, reason: "fenced" };
          gateAnswerTransaction(request, answerId, staged.versionId);
          return { ok: true, versionId: staged.versionId, replayed: false };
        },
        gateAnswers() {
          return (listGateAnswers.all() as Record<string, unknown>[]).map(
            (row) => {
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
            },
          );
        },
        close() {
          if (handles.delete(runDatabase)) runDatabase.close();
          if (handles.size === 0) runHandles.delete(runId);
        },
      };
    },
    listRuns() {
      return (listRegistrations.all() as Record<string, unknown>[]).map(
        (row) => {
          const parsed = registrationRow.safeParse(row);
          if (!parsed.success) {
            throw new Error("Run Store: a runs row is malformed.");
          }
          const live = parsed.data.state === "live";
          return {
            runId: parsed.data.run_id,
            live,
            // Name the owning process only while the claim is live (#98 S2).
            ...(live && parsed.data.owner_pid != null
              ? { ownerPid: parsed.data.owner_pid }
              : {}),
          };
        },
      );
    },
    readRun(runId) {
      // Registration is authoritative, so readRun agrees with listRuns: a Run the
      // coordination DB does not list is unknown even if a directory lingers
      // mid-reclaim, and a listed Run whose run.db will not read is damaged.
      if (findRegistration.get(runId) == null) {
        return { ok: false, problem: { kind: "unknown-run", runId } };
      }
      const record = readRunStore(join(groupDir, runId));
      if (record === undefined || record === DAMAGED) {
        return { ok: false, problem: { kind: "run-store-damaged", runId } };
      }
      return { ok: true, run: record };
    },
    close() {
      for (const handles of runHandles.values()) {
        for (const handle of handles) handle.close();
        handles.clear();
      }
      runHandles.clear();
      database.close();
    },
  };
}
