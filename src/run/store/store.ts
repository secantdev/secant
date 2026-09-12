import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";

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

/** One registered Run and whether it currently holds the Workspace claim. */
export interface RunListing {
  readonly runId: string;
  readonly live: boolean;
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

/** A write against a fenced owner is refused; nothing is written. */
export type WriteResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: "fenced" };

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
  created_at: z.string(),
});

const DAMAGED = Symbol("run-store-damaged");

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
      "owner_epoch INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT",
  );
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
  // ponytail: `diagnostics/` is created empty; the 90-day expiry runs once a
  // slice actually writes diagnostics there — no writer exists yet, so pruning
  // has nothing to do. Add the prune-on-open then.
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
    prepareCoordination(database);
    database.query("SELECT COUNT(*) AS n FROM runs").get();
    database.query("SELECT COUNT(*) AS n FROM operations").get();
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
): RunGroup {
  const groupDir = join(secantHome, "runs", groupDirName(workspacePath));
  mkdirSync(groupDir, { recursive: true });
  const { database, rebuilt } = openCoordination(
    join(groupDir, "coordination.db"),
    groupDir,
  );
  cleanQuarantine(groupDir);
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
    "SELECT run_id, state, owner_epoch, created_at FROM runs WHERE run_id = ?",
  );
  const listRegistrations = database.query(
    "SELECT run_id, state, owner_epoch, created_at FROM runs",
  );
  const insertRun = database.query(
    "INSERT INTO runs (run_id, state, owner_epoch, created_at) VALUES (?, 'live', 0, ?)",
  );
  const deleteRun = database.query("DELETE FROM runs WHERE run_id = ?");
  const endRun = database.query(
    "UPDATE runs SET state = 'ended' WHERE run_id = ?",
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
      insertRun.run(runId, record.createdAt);
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

  function reclaimRunDir(runId: string): void {
    const finalDir = join(groupDir, runId);
    if (!existsSync(finalDir)) return;
    const deletingDir = join(groupDir, `${runId}.deleting`);
    renameSync(finalDir, deletingDir);
    rmSync(deletingDir, { recursive: true, force: true });
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
    acquireRun(runId) {
      const record = readRunStore(join(groupDir, runId));
      if (record === undefined || record === DAMAGED) return undefined;
      const bumped = bumpEpoch.get(runId) as { owner_epoch: number } | null;
      if (bumped == null) return undefined;
      const epoch = bumped.owner_epoch;
      const runDatabase = new Database(join(groupDir, runId, "run.db"));
      runDatabase.exec("PRAGMA busy_timeout = 5000");
      const handles = runHandles.get(runId) ?? new Set<Database>();
      handles.add(runDatabase);
      runHandles.set(runId, handles);
      const updateState = runDatabase.query(
        "UPDATE run_record SET state = ? WHERE run_id = ?",
      );
      return {
        runId,
        record,
        writeState(state) {
          const current = readEpoch.get(runId) as {
            owner_epoch: number;
          } | null;
          if (current == null || current.owner_epoch !== epoch) {
            return { ok: false, reason: "fenced" };
          }
          updateState.run(state, runId);
          return { ok: true };
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
          return {
            runId: parsed.data.run_id,
            live: parsed.data.state === "live",
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
