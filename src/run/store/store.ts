import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import { and, count, eq } from "drizzle-orm";
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { MigrationsJournal } from "drizzle-orm/migrator";
import { z } from "zod";
import type { SteerCapability } from "../../harness/harness.js";
import { type ProcessAdapter } from "../../process/process.js";
import type {
  ArtifactType,
  AttemptOutcome,
  HumanGateShape,
  ProducedArtifact,
} from "../../workflow/workflow.js";
import {
  coordinationMigrations,
  runMigrations,
} from "../../drizzle/migrations.js";
import {
  isolatedGitEnvironment,
  type StageProblem,
} from "./artifacts/artifacts.js";
import { operations, runs } from "./coordination-schema.js";
import {
  DAMAGED,
  acquireRunOwner,
  claimRunOwnership,
  endRunOwnership,
  readRunOwnership,
  readRunStore,
  reconcileRunStore,
  stageRunStore,
  type TRunDatabaseHandle,
} from "./run-owner.js";

// Re-exported from the Run Store entry so Preflight can harden its `git` worktree
// probe with the same isolation the private Artifact repo uses, without importing
// the private Artifact Module across the Module boundary (A31).
export { isolatedGitEnvironment };

// The Run Store owns each Run's canonical truth and the cross-Run coordination
// for one Workspace. Runs sharing a resolved absolute Workspace path are grouped
// under a readable `<slug>--<path-digest>` directory; that group's
// `coordination.db` owns only Run registration and create/delete admission, while
// each Run's `run.db` owns its canonical record and owner fencing. Any number of
// Runs may be live in one Workspace at once; each is owned separately (ADR 0031),
// so there is no Workspace-wide claim.
// Nothing storage-shaped — no SQLite type, no row, no path — crosses this Interface;
// callers ask in domain terms (ADR 0023, ADR 0030, ADR 0031, #21 storage).
// `bun:sqlite` is a Bun built-in, so the driver ships inside the compiled binary and
// lives only here and in the Catalog (runtime-neutrality allowlist).

/** A closed semantic Harness selection pinned by a Run. This is deliberately not
 *  an executable, Adapter revision, observed version, or effective model. */
export type SelectedHarnessId = "claude-code" | "codex";

/** A Run's canonical record, read back from its own `run.db`. */
export interface RunRecord {
  readonly runId: string;
  readonly workspacePath: string; // the resolved absolute Workspace value, pinned
  readonly bundleSnapshotDigest: string; // the pinned Bundle Snapshot reference
  readonly launch: unknown; // the Launch inputs, stored and returned opaque
  /** The immutable semantic Harness selected for this Run. Absent for a
   *  Command-only Run and for a pre-M4 Run not yet upgraded. */
  readonly selectedHarness?: SelectedHarnessId;
  /** The immutable model requested at launch, threaded into prepare (#187). Absent
   *  when no model was requested (the Harness default applies) and for a
   *  Command-only Run. Free text; the Store never validates it to a closed set. */
  readonly requestedModel?: string;
  readonly state: string; // canonical Run state, including a durable `blocked` pause
  readonly createdAt: string; // ISO 8601
}

/** One registered Run and its ownership (ADR 0031). `live` is whether the Run is
 *  currently owned (a process holds it — running or paused at a checkpoint through
 *  `blocked`); `ownerPid` names that process; `ownedByThisProcess` says whether the
 *  owner is this instance, so a caller can tell "live here" from "live elsewhere"
 *  and name the foreign owner of a Run it may not open (#98 S2, ADR 0031). */
export interface RunListing {
  readonly runId: string;
  readonly live: boolean;
  readonly ownerPid?: number;
  readonly ownedByThisProcess: boolean;
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
  /** Required by Application for an Agent-bearing Run; omitted for Command-only. */
  readonly selectedHarness?: SelectedHarnessId;
  /** The model requested at launch, pinned immutably; omitted when none was
   *  requested and for a Command-only Run (#187). */
  readonly requestedModel?: string;
  readonly at: Date;
}

/**
 * The outcome of an admitted create. `created` and `already-created` (the same
 * operation id replayed) both name the Run. Create never refuses for the Workspace
 * (ADR 0031: any number of Runs may be live at once).
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
    };

/** The outcome of an admitted delete; idempotent per operation id. */
export type DeleteRunResult =
  | { readonly outcome: "deleted"; readonly runId: string }
  | { readonly outcome: "already-deleted"; readonly runId: string };

/** The outcome of a resume claim (ADR 0031: ownership is per Run). `resumed` takes
 *  ownership of this Run (or it was already owned here); `run-live-elsewhere` refuses
 *  only because this Run is already owned by a live *other* process (the owner is
 *  named directly); `unknown-run` names a Run this group never registered. A
 *  takeover (`acquireRun` with `takeover`) fences that owner regardless of the
 *  courtesy probe (ADR 0031). */
export type ResumeRunResult =
  | { readonly outcome: "resumed"; readonly runId: string }
  | {
      readonly outcome: "run-live-elsewhere";
      readonly runId: string;
      readonly ownerPid: number;
    }
  | { readonly outcome: "unknown-run"; readonly runId: string };

/** A write against a fenced owner is refused; nothing is written. */
export type WriteResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: "fenced" };

/** A legacy Run's one-time semantic Harness upgrade. `already-selected` proves an
 *  idempotent retry observed the same immutable value and performed no write. */
export type SelectHarnessResult =
  | { readonly outcome: "selected" }
  | { readonly outcome: "already-selected" }
  | { readonly outcome: "fenced" };

/** A candidate output a producer wrote once, ready to publish together. */
export interface CandidateOutput {
  readonly name: string;
  readonly type: ArtifactType;
  /** Portable regular-file bytes. */
  readonly content: Uint8Array;
}

/** One Step Attempt's outcome and evidence. Agent evidence is one bundled value,
 *  so current writes cannot persist a model without its qualified identity. */
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
  /** Present for autonomous Agent Attempts; absent for Command/Gate and synthetic
   *  interactive Attempts. */
  readonly agentEvidence?: AgentAttemptEvidence;
}

export interface AgentAttemptEvidence {
  readonly kind: "agent";
  readonly identity: HarnessIdentityRecord;
  readonly effectiveModel?: string;
}

/** The normalized Harness identity recorded on an Agent-step Attempt (#125). Carries
 *  only the profile's semantic identity facts — never a native Session id, recovery
 *  coordinate, or Adapter object. */
export interface HarnessIdentityRecord {
  readonly harness: string;
  readonly executable: string;
  readonly executableVersion: string;
  /** Evidence the qualified profile supplied for native same-Turn steer. Absent
   *  only on an Attempt written before the capability was persisted. */
  readonly steer?: SteerCapability;
}

/** One Attempt's co-sourced observed Harness evidence. The identity-less variant
 *  is read compatibility for legacy model-only rows; current writes cannot create it. */
export type HarnessEvidenceRecord =
  | {
      readonly identity: HarnessIdentityRecord;
      readonly effectiveModel?: string;
    }
  | { readonly identity?: undefined; readonly effectiveModel: string };

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

/** An authored Human Gate the walk paused at (#108). A durable record, distinct
 *  from a derived Review checkpoint: the Run rests `blocked` here until the
 *  producing Attempt settles (answering settles it through `publishAttempt`). */
export interface PendingGateRecord {
  readonly attemptId: string; // the producing Attempt id; the key
  readonly stepId: string;
  readonly shape: HumanGateShape;
  readonly message: string; // the exact rendered message shown to the human
  readonly outputArtifactName?: string; // present only for a `free-text` gate
  /** A `free-text` gate's authored quick-choice answers (#213), in authored order. */
  readonly suggestions?: readonly string[];
  readonly raisedAt: string; // ISO 8601
}

/** The request to record one authored pending Human Gate. Recording it also rests
 *  the Run `blocked` in the same transaction, so a crash cannot leave the record
 *  without the pause. Idempotent on the producing Attempt id (a resume that
 *  re-reaches the gate re-records nothing). */
export interface RecordPendingGateRequest {
  readonly attemptId: string;
  readonly stepId: string;
  readonly shape: HumanGateShape;
  readonly message: string;
  readonly outputArtifactName?: string;
  readonly suggestions?: readonly string[];
  readonly at: Date;
}

// --- Harness Turns (#116) --------------------------------------------------

/** The Crucible Step kind that produced a durable Turn (#126): an autonomous
 *  `agent` Step's Turn or an `interactive-agent` Step's human Turn. Crucible-owned
 *  durable truth, recorded from the executing Step at admission and independent of
 *  Turn `origin` (`managed`/`human`) and of any Harness-native message type. */
export type TurnKind = "agent" | "interactive-agent";

/** Admit one Turn before its stdin frame is sent: the durable admission the
 *  Harness Adapter awaits. A refusal (or a fenced owner) proves the Turn
 *  `not-started`. Records the `turn` row, upserts the named Session `open`, and
 *  appends the rendered input as a `user` transcript entry, all in one boundary. */
export interface AdmitTurnRequest {
  readonly turnId: string;
  readonly attemptId: string;
  readonly session: string;
  readonly origin: "managed" | "human";
  /** The Crucible Step kind that produced this Turn (#126), recorded durably so
   *  reopened history distinguishes an Interactive Turn from an Agent Turn. */
  readonly kind: TurnKind;
  /** The exact rendered transcript input admitted before native submission. */
  readonly input: string;
  /** The opaque native recovery coordinate (native session id) observed. */
  readonly recoveryCoordinate: string;
  readonly harness: string;
  readonly at: Date;
}

/** Append one normalized durable Turn event (append-only). */
export interface AppendTurnEventRequest {
  readonly turnId: string;
  readonly kind: string;
  readonly payload: string; // JSON
  readonly at: Date;
}

/** Settle a Turn authoritatively (#116). Immutable: a settle after a settled
 *  result is a no-op. Updates the `turn` row, the Session availability, and (when
 *  present) appends the authoritative assistant content as a transcript entry. */
export interface SettleTurnRequest {
  readonly turnId: string;
  readonly session: string;
  readonly resultKind: string; // not-started/completed/failed/interrupted/lost
  readonly resultDetail: string; // JSON
  readonly availability: string; // open/detached/unusable
  readonly availabilityDetail?: string;
  readonly assistantContent?: string;
  readonly at: Date;
}

/** One admitted Turn, read back for the run Projection. */
export interface TurnRecord {
  readonly turnId: string;
  readonly attemptId: string;
  readonly session: string;
  readonly origin: string;
  /** The Crucible Step kind that produced this Turn (#126). Absent for a legacy
   *  row admitted before the kind column existed — genuinely unknown, so the
   *  Projection narrows a known value and omits an unknown one rather than guess. */
  readonly kind?: string;
  readonly sequence: number;
  readonly input: string;
  readonly admittedAt: string; // ISO 8601
  readonly resultKind?: string;
  /** The settled result's flattened detail as JSON (the failure category and
   *  native exit code for a lost/failed/not-started Turn); absent until settle.
   *  Read through this member rather than a raw `run.db` query. */
  readonly resultDetail?: string;
  readonly settledAt?: string;
}

/** One normalized durable Turn event, read back in append order. */
export interface TurnEventRecord {
  readonly turnId: string;
  readonly kind: string;
  readonly payload: string;
  readonly at: string; // ISO 8601
}

/** One named Session's last observed availability, read back for the Projection. */
export interface HarnessSessionRecord {
  readonly session: string;
  readonly availability: string;
  readonly availabilityDetail?: string;
}

/** One readable transcript entry (exact Turn input or authoritative assistant
 *  content), read back in append order. */
export interface TranscriptEntryRecord {
  readonly session: string;
  readonly turnId: string;
  readonly role: string;
  readonly content: string;
  readonly at: string; // ISO 8601
}

/** A transcript entry tagged with its store sequence — the stable, monotonic
 *  append order the Store pages on. The sequence is Store-internal: it never
 *  crosses the Projection Port (the Application wraps it in an opaque cursor). */
export interface SequencedTranscriptEntry extends TranscriptEntryRecord {
  readonly seq: number;
}

/** A bounded, ordered request for one Session's transcript, newest-first paging.
 *  `before` is an exclusive upper bound on the store sequence (absent = newest
 *  page); `limit` bounds the page so the whole transcript is never materialized.
 *  A non-positive `limit` is clamped to one entry, so a page always carries a
 *  cursor. */
export interface TranscriptPageRequest {
  readonly session: string;
  readonly before?: number;
  readonly limit: number;
}

/** One bounded transcript page, oldest-first. `hasOlder` is true when retained
 *  entries older than this page's oldest exist, so the caller can page upward. */
export interface TranscriptPage {
  readonly entries: readonly SequencedTranscriptEntry[];
  readonly hasOlder: boolean;
}

/**
 * Ownership of one Run's canonical store. Acquiring bumps a fencing epoch, so a
 * stale owner (a crashed process that comes back) is fenced: its canonical
 * writes are refused. The caller owns the handle and closes it; the group closes
 * any it still holds.
 */
export interface RunOwner {
  readonly runId: string;
  readonly record: RunRecord;
  /** Durably select the Harness for a pre-M4 Run if it is still absent. The
   *  selected value is immutable; repeating the same upgrade performs no write. */
  selectHarness(selectedHarness: SelectedHarnessId): SelectHarnessResult;
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
   * Prepare the empty directory an Agent Attempt's output receipts are written to
   * (#215) and return its absolute path. One directory per Attempt id under the
   * Run's own directory — never the Workspace, the database, or the Artifact
   * repository — emptied on every call so a stale receipt cannot satisfy a later
   * Attempt, and removed with the Run. Receipt files are candidate input only;
   * nothing is canonical until `publishAttempt` binds the validated bytes.
   */
  outputReceiptDirectory(attemptId: string): string;
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
  /**
   * Record an authored pending Human Gate and rest the Run `blocked` in one
   * transaction (#108). Idempotent on the producing Attempt id, so a resume that
   * re-reaches the gate re-records nothing. Refused if this owner is fenced.
   */
  recordPendingGate(request: RecordPendingGateRequest): WriteResult;
  /** The authored gate the Run currently rests at: the pending-gate record whose
   *  producing Attempt has not yet settled, or undefined if none is pending (a
   *  derived Review checkpoint records nothing here). */
  pendingGate(): PendingGateRecord | undefined;
  /** Admit a Turn before its stdin frame is sent (#116): the durable admission the
   *  Harness Adapter awaits. A fenced owner refuses (proving the Turn
   *  `not-started`); otherwise the `turn` row, the Session, and the input
   *  transcript entry are written in one transaction. */
  admitTurn(request: AdmitTurnRequest): WriteResult;
  /** Append one normalized durable Turn event (append-only). Refused if fenced. */
  appendTurnEvent(request: AppendTurnEventRequest): WriteResult;
  /** Settle a Turn authoritatively (#116); immutable once settled. Refused if
   *  fenced. */
  settleTurn(request: SettleTurnRequest): WriteResult;
  /** Every admitted Turn, in sequence order. */
  turns(): readonly TurnRecord[];
  /** Every normalized durable Turn event, in append order. */
  turnEvents(): readonly TurnEventRecord[];
  /** Every named Session's last observed availability. */
  harnessSessions(): readonly HarnessSessionRecord[];
  /** Every readable transcript entry, in append order. */
  transcript(): readonly TranscriptEntryRecord[];
  /** One bounded, ordered page of a Session's transcript (#124). The Store owns
   *  stable paging: it reads only the requested page, never the whole transcript,
   *  so inspecting a page never materializes the complete export. */
  transcriptPage(request: TranscriptPageRequest): TranscriptPage;
  /** The latest Agent-step Attempt's co-sourced identity and optional model, or
   *  legacy model-only evidence. Undefined when no Attempt ran a Harness Turn. */
  harnessEvidence(): HarnessEvidenceRecord | undefined;
  /** Release this Run only if this owner still holds the fencing epoch. A stale
   *  owner cannot clear ownership acquired by a takeover. */
  release(): WriteResult;
  close(): void;
}

export interface RunGroup {
  /**
   * Admit a fresh Run: stage its store under a `.creating` quarantine, publish it
   * atomically, register it owned by this process, and return it. Create never
   * refuses for the Workspace — any number of Runs may be live at once (ADR 0031),
   * and two concurrent creates in one group both succeed under `BEGIN IMMEDIATE`.
   * Replaying an operation id returns the Run it already created.
   */
  createRun(request: CreateRunRequest): CreateRunResult;
  /**
   * Admit a delete: release ownership and the registration, then reclaim the store
   * under a `.deleting` quarantine. Idempotent per operation id; deleting an
   * absent Run still succeeds.
   */
  deleteRun(request: {
    readonly operationId: string;
    readonly runId: string;
  }): DeleteRunResult;
  /**
   * Release this process's ownership while the canonical store stays until an
   * explicit delete. Called when the Run rests (ADR 0031: ownership lasts from
   * acquisition until rest — including through `blocked`). Idempotent; ending an
   * absent, unowned, or foreign-owned Run is a no-op.
   */
  endRun(runId: string): void;
  /**
   * Take ownership of a Run so an explicit human resume can drive it further
   * (ADR 0023, ADR 0031). Refused `run-live-elsewhere` only when this Run is already
   * owned by a live *other* process; a no-op `resumed` if this process already owns
   * it, otherwise it claims ownership. The caller then `acquireRun`s for a fresh
   * fencing epoch.
   */
  resumeRun(runId: string): ResumeRunResult;
  /**
   * Take ownership of a Run, bumping its fencing epoch so any earlier owner's next
   * canonical write is refused. Returns undefined if the Run is unreadable, or —
   * without `takeover` — if it is owned by a live *other* process (the caller
   * confirms and retries with `takeover`, which fences that owner regardless of the
   * probe; ADR 0031).
   */
  acquireRun(
    runId: string,
    options?: { readonly takeover?: boolean },
  ): RunOwner | undefined;
  /** Every registered Run in this group. Order is unspecified. */
  listRuns(): readonly RunListing[];
  /** A Run's canonical record, or a Problem when its store is damaged or absent. */
  readRun(runId: string): ReadRunResult;
  /** Release every file handle (coordination and any acquired Run). */
  close(): void;
}

const registrationRow = z.object({
  run_id: z.string(),
  created_at: z.string(),
});

/** Whether the process owning a live Run is still running (#98 S2). Signal 0
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
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
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

interface StoreDatabase {
  readonly db: SQLiteBunDatabase;
  readonly sqlite: Database;
  isClosed(): boolean;
  close(): void;
}

function openDatabase(
  path: string,
  migrations: MigrationsJournal,
): StoreDatabase {
  const sqlite = new Database(path);
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    const db = drizzle({ client: sqlite });
    migrate(db, migrations);
    let closed = false;
    return {
      db,
      sqlite,
      isClosed() {
        return closed;
      },
      close() {
        if (closed) return;
        sqlite.close();
        closed = true;
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function openRunDatabase(path: string): StoreDatabase {
  return openDatabase(path, runMigrations);
}

interface TStageStoredRunParams {
  readonly dir: string;
  readonly record: RunRecord;
  readonly ownerPid: number;
}

function stageStoredRun(params: TStageStoredRunParams): void {
  stageRunStore({
    dir: params.dir,
    record: params.record,
    ownerPid: params.ownerPid,
    openDatabase: openRunDatabase,
  });
}

function readStoredRun(dir: string): RunRecord | typeof DAMAGED | undefined {
  return readRunStore({ dir, openDatabase: openRunDatabase });
}

interface TReconcileStoredRunParams {
  readonly dir: string;
  readonly at: Date;
  readonly selfPid: number;
  readonly isOwnerAlive: (pid: number) => boolean;
}

function reconcileStoredRun(params: TReconcileStoredRunParams): boolean {
  return reconcileRunStore({
    dir: params.dir,
    at: params.at,
    selfPid: params.selfPid,
    isOwnerAlive: params.isOwnerAlive,
    openDatabase: openRunDatabase,
  });
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

// Two processes can read the migration journal before either applies a generated
// ALTER. The loser then observes the winner's committed schema and its stale ALTER
// fails; reopening re-reads the committed journal. Only two failed opens reach the
// corruption rebuild, so that transient race never deletes a healthy live database.
function openMigratedCoordination(coordinationPath: string): StoreDatabase {
  try {
    return openDatabase(coordinationPath, coordinationMigrations);
  } catch (firstError) {
    try {
      return openDatabase(coordinationPath, coordinationMigrations);
    } catch (secondError) {
      throw new AggregateError(
        [firstError, secondError],
        "Run Store: coordination database did not open after a migration retry.",
        { cause: secondError },
      );
    }
  }
}

function isSqliteCorruption(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    "code" in error &&
    (error.code === "SQLITE_CORRUPT" || error.code === "SQLITE_NOTADB")
  ) {
    return true;
  }
  return error.cause === undefined ? false : isSqliteCorruption(error.cause);
}

/** Open the coordination DB, rebuilding registration from readable Run Stores
 *  when the existing file is corrupt. Ownership remains in each Run Store. */
function openCoordination(
  coordinationPath: string,
  groupDir: string,
): StoreDatabase & { readonly rebuilt: boolean } {
  try {
    const database = openMigratedCoordination(coordinationPath);
    try {
      database.db.select({ value: count() }).from(runs).get();
      database.db.select({ value: count() }).from(operations).get();
    } catch (error) {
      // Close the handle before the file is deleted below: on Windows an open
      // handle to the corrupt file locks it, so `rmSync` would fail with EBUSY.
      database.sqlite.close();
      throw error;
    }
    return {
      db: database.db,
      sqlite: database.sqlite,
      isClosed: database.isClosed,
      close: database.close,
      rebuilt: false,
    };
  } catch (error) {
    if (!isSqliteCorruption(error)) throw error;
    rmSync(coordinationPath, { force: true });
  }
  const database = openMigratedCoordination(coordinationPath);
  // Register each readable Run after reading its owner from the same Run Store. A
  // damaged run.db is left unregistered but its bytes stay untouched (canonical
  // truth survives until an explicit delete).
  // ponytail: the admission ledger (`operations`) is not rebuilt — a Run's run.db
  // does not record the operation id that created it. So a create/delete retry
  // that races a coordination-corruption rebuild is no longer deduplicated and
  // may make a second Run. That is a double fault (corruption plus the exact same
  // operation id retried) and yields a duplicate, not data loss; persist the
  // create operation id in run.db and re-seed from it here if it ever bites.
  for (const name of runDirNames(groupDir)) {
    const dir = join(groupDir, name);
    const record = readStoredRun(dir);
    const ownership = readRunOwnership({
      dir,
      openDatabase: openRunDatabase,
    });
    if (
      record !== undefined &&
      record !== DAMAGED &&
      ownership !== undefined &&
      ownership !== DAMAGED
    ) {
      database.db
        .insert(runs)
        .values({
          run_id: record.runId,
          created_at: record.createdAt,
        })
        .run();
    }
  }
  return {
    db: database.db,
    sqlite: database.sqlite,
    isClosed: database.isClosed,
    close: database.close,
    rebuilt: true,
  };
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
    readonly process: ProcessAdapter;
    readonly now?: () => Date;
    /** Whether the process owning a live Run is still alive (#98 S2). Defaults
     *  to a real probe (`process.kill(pid, 0)`); a test injects a fixed answer to
     *  simulate a dead owner (reconcile `halted`) or a live one (leave it live). */
    readonly isOwnerAlive?: (pid: number) => boolean;
    /** The process id this group records as the owner of the Runs it claims (#98 S2). Defaults
     *  to the real pid; a test overrides it so two `openRunGroup`s on one home stand
     *  in for two processes with distinct pids. */
    readonly selfPid?: number;
  },
): RunGroup {
  const selfPid = options.selfPid ?? process.pid;
  const isOwnerAlive = options.isOwnerAlive ?? processIsAlive;
  const processAdapter = options.process;
  const groupDir = join(secantHome, "runs", groupDirName(workspacePath));
  mkdirSync(groupDir, { recursive: true });
  const { db, sqlite, rebuilt } = openCoordination(
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
      db
        .select({ run_id: runs.run_id })
        .from(runs)
        .all()
        .map((row) => row.run_id),
    );
    for (const name of runDirNames(groupDir)) {
      if (!registered.has(name)) {
        rmSync(join(groupDir, name), { recursive: true, force: true });
      }
    }
  }

  // Every acquired Run's run.db handles, keyed by Run id, so the group can close
  // them all — and, before a delete reclaims a Run's directory, close exactly that
  // Run's handles so the rename never trips over an open file (Windows cleanup).
  const runHandles = new Map<string, Set<TRunDatabaseHandle>>();
  function closeRunHandles(runId: string): void {
    const handles = runHandles.get(runId);
    if (handles === undefined) return;
    for (const handle of handles) handle.close();
    // Empty the set the owners still reference, so a later RunOwner.close() sees
    // nothing to close rather than closing the same handle twice.
    handles.clear();
    runHandles.delete(runId);
  }

  function trackRunHandle(
    runId: string,
    database: TRunDatabaseHandle,
  ): () => void {
    const handles = runHandles.get(runId) ?? new Set<TRunDatabaseHandle>();
    handles.add(database);
    runHandles.set(runId, handles);
    return () => {
      if (handles.delete(database)) database.close();
      if (handles.size === 0) runHandles.delete(runId);
    };
  }

  // Admit a create under BEGIN IMMEDIATE, so registration and the operation receipt
  // commit under the write lock even across processes (the named Windows risk), and
  // two concurrent creates in one group both succeed (ADR 0031: no Workspace claim
  // to contend). Ordering: stage the store, register + record the operation, then
  // publish (rename) last — any failure before the rename leaves only the
  // `.creating` quarantine, which the next open removes.
  function admitCreate(request: CreateRunRequest): CreateRunResult {
    return db.transaction(
      (tx): CreateRunResult => {
        const replay = tx
          .select({ run_id: operations.run_id })
          .from(operations)
          .where(
            and(
              eq(operations.operation_id, request.operationId),
              eq(operations.kind, "create"),
            ),
          )
          .get();
        if (replay !== undefined) {
          const record = readStoredRun(join(groupDir, replay.run_id));
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
        const runId = randomUUID();
        const record: RunRecord = {
          runId,
          workspacePath,
          bundleSnapshotDigest: request.bundleSnapshotDigest,
          launch: request.launch,
          ...(request.selectedHarness !== undefined
            ? { selectedHarness: request.selectedHarness }
            : {}),
          ...(request.requestedModel !== undefined
            ? { requestedModel: request.requestedModel }
            : {}),
          state: "created",
          createdAt: request.at.toISOString(),
        };
        stageStoredRun({
          dir: join(groupDir, `${runId}.creating`),
          record,
          ownerPid: selfPid,
        });
        tx.insert(runs)
          .values({
            run_id: runId,
            created_at: record.createdAt,
          })
          .run();
        tx.insert(operations)
          .values({
            operation_id: request.operationId,
            kind: "create",
            run_id: runId,
            recorded_at: record.createdAt,
          })
          .run();
        renameSync(join(groupDir, `${runId}.creating`), join(groupDir, runId));
        return { outcome: "created", runId, record };
      },
      { behavior: "immediate" },
    );
  }

  // Admit a delete under BEGIN IMMEDIATE: drop the registration and record the
  // operation first (ownership is released the moment this commits), then reclaim
  // the directory. A crash after the commit leaves at worst a `.deleting`
  // quarantine (or the plain directory), which the next open reconciles; the Run
  // is never left half-registered. Clearing the Run's operation rows retires its
  // create receipt, so a much-delayed create retry after the delete starts a
  // fresh Run rather than replaying a mapping to bytes that are gone.
  function admitDelete(operationId: string, runId: string): DeleteRunResult {
    return db.transaction(
      (tx): DeleteRunResult => {
        const replay = tx
          .select({ run_id: operations.run_id })
          .from(operations)
          .where(
            and(
              eq(operations.operation_id, operationId),
              eq(operations.kind, "delete"),
            ),
          )
          .get();
        if (replay !== undefined) {
          return { outcome: "already-deleted", runId: replay.run_id };
        }
        tx.delete(runs).where(eq(runs.run_id, runId)).run();
        tx.delete(operations).where(eq(operations.run_id, runId)).run();
        tx.insert(operations)
          .values({
            operation_id: operationId,
            kind: "delete",
            run_id: runId,
            recorded_at: new Date().toISOString(),
          })
          .run();
        return { outcome: "deleted", runId };
      },
      { behavior: "immediate" },
    );
  }

  // Registration answers `unknown-run`; ownership is claimed under BEGIN IMMEDIATE
  // in the Run's own database. Already owned here is idempotent, while a live other
  // process is refused by the courtesy probe (ADR 0031).
  function admitResume(runId: string): ResumeRunResult {
    const registration = db
      .select({ run_id: runs.run_id })
      .from(runs)
      .where(eq(runs.run_id, runId))
      .get();
    if (registration === undefined) return { outcome: "unknown-run", runId };
    const claim = claimRunOwnership({
      dir: join(groupDir, runId),
      selfPid,
      isOwnerAlive,
      openDatabase: openRunDatabase,
    });
    if (claim.kind === "live-elsewhere") {
      return { outcome: "run-live-elsewhere", runId, ownerPid: claim.ownerPid };
    }
    if (claim.kind === "unreadable") {
      throw new Error(`Run Store: cannot claim unreadable Run ${runId}.`);
    }
    return { outcome: "resumed", runId };
  }

  function reclaimRunDir(runId: string): void {
    const finalDir = join(groupDir, runId);
    if (!existsSync(finalDir)) return;
    const deletingDir = join(groupDir, `${runId}.deleting`);
    renameSync(finalDir, deletingDir);
    rmSync(deletingDir, { recursive: true, force: true });
  }

  // Startup reconciliation (ADR 0023, ADR 0031, #86, #98 S2): every registered
  // Run reads its owner from run.db and probes it under one transaction. An owner alive in
  // another process is a Run genuinely live there — leave it untouched (it stays
  // listed live-elsewhere, and opening or resuming it is refused with the owner
  // named). A dead owner (or a pid equal to ours, which at open means a reused pid —
  // this process has claimed nothing yet — and also lets a same-process reopen
  // reconcile in tests) is reconciled by stored state: a `running`/`created` record
  // is rested `halted` with the interrupted Attempt `indeterminate`; a `blocked`
  // record stays `blocked` because nothing was cut off and the checkpoint still
  // holds. Either way its ownership is released, running no Step work, so a reopened
  // home never silently resumes execution (ADR 0019). An absent owner row reads as
  // unowned at epoch zero and is skipped.
  for (const row of db.select().from(runs).all()) {
    const parsed = registrationRow.safeParse(row);
    if (!parsed.success) continue;
    reconcileStoredRun({
      dir: join(groupDir, parsed.data.run_id),
      at: new Date(),
      selfPid,
      isOwnerAlive,
    });
  }

  return {
    createRun(request) {
      return admitCreate(request);
    },
    deleteRun({ operationId, runId }) {
      const result = admitDelete(operationId, runId);
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
      endRunOwnership({
        dir: join(groupDir, runId),
        selfPid,
        openDatabase: openRunDatabase,
      });
    },
    resumeRun(runId) {
      return admitResume(runId);
    },
    acquireRun(runId, options = {}) {
      // Probe ownership before fencing (ADR 0031): without `takeover`, decline a Run
      // owned by a live *other* process, so the caller confirms the takeover before
      // fencing the instance driving it. A dead, absent, or self owner is fenced
      // without asking; `takeover` fences regardless of the probe and claims the Run.
      // A takeover claims ownership and bumps the epoch atomically; a plain acquire
      // bumps only, leaving the create/resume claim as-is (so a read-only acquire
      // never marks a resting Run live). Fencing is the epoch bump either way.
      const registered = db
        .select({ run_id: runs.run_id })
        .from(runs)
        .where(eq(runs.run_id, runId))
        .get();
      if (registered === undefined) return undefined;
      return acquireRunOwner({
        groupDir,
        runId,
        takeover: options.takeover === true,
        selfPid,
        isOwnerAlive,
        openDatabase: openRunDatabase,
        trackHandle: (database) => trackRunHandle(runId, database),
        process: processAdapter,
      });
    },
    listRuns() {
      return db
        .select()
        .from(runs)
        .all()
        .map((row) => {
          const parsed = registrationRow.safeParse(row);
          if (!parsed.success) {
            throw new Error("Run Store: a runs row is malformed.");
          }
          const ownership = readRunOwnership({
            dir: join(groupDir, parsed.data.run_id),
            openDatabase: openRunDatabase,
          });
          // A damaged store lists unowned, matching the exact read's damaged Problem.
          const ownerPid =
            ownership === undefined || ownership === DAMAGED
              ? null
              : ownership.ownerPid;
          const live = ownerPid != null;
          if (ownerPid === null) {
            return {
              runId: parsed.data.run_id,
              live: false,
              ownedByThisProcess: false,
            };
          }
          return {
            runId: parsed.data.run_id,
            live,
            ownerPid,
            ownedByThisProcess: ownerPid === selfPid,
          };
        });
    },
    readRun(runId) {
      // Registration is authoritative, so readRun agrees with listRuns: a Run the
      // coordination DB does not list is unknown even if a directory lingers
      // mid-reclaim, and a listed Run whose run.db will not read is damaged.
      if (
        db
          .select({ run_id: runs.run_id })
          .from(runs)
          .where(eq(runs.run_id, runId))
          .get() === undefined
      ) {
        return { ok: false, problem: { kind: "unknown-run", runId } };
      }
      const record = readStoredRun(join(groupDir, runId));
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
      sqlite.close();
    },
  };
}
