import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";

// The Catalog owns the catalog database under the Secant home. Everything about
// SQLite stays behind this Interface: no SQLite type, row shape, or storage path
// crosses it. Callers ask; they never reach into rows. (ADR 0025, #21 storage.)

/** A recorded Workspace approval. Its home is the Catalog database. */
export interface WorkspaceApproval {
  readonly path: string; // canonical absolute path, compared exactly
  readonly approvedAt: string; // ISO 8601
}

/** Where a Bundle came from. M6 adds `built-in`; M1 has only local origins. */
export type BundleOrigin =
  | { readonly kind: "local-build"; readonly folder: string }
  | { readonly kind: "local-file"; readonly path: string };

/** A recorded Installed Bundle. Its bytes live in the digest-named store. */
export interface CatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly digest: string; // SHA-256 hex
  readonly origin: BundleOrigin;
  readonly installedAt: string; // ISO 8601
  readonly installationGeneration: number; // private, monotonic per home
}

/** The validated bytes and metadata an install commits. */
export interface BundleInstall {
  readonly identity: { readonly id: string; readonly version: string };
  readonly digest: string; // SHA-256 hex the caller computed over the bytes
  readonly bytes: Uint8Array; // the exact `.wfb` bytes
  readonly origin: BundleOrigin;
  readonly installedAt: Date;
}

/**
 * The outcome of an install. First-install-wins by identity (id, version): an
 * equal digest is already installed, a different digest is an identity
 * collision, and neither changes the store or the Entry.
 */
export type BundleInstallResult =
  | { readonly outcome: "installed"; readonly entry: CatalogEntry }
  | { readonly outcome: "already-installed"; readonly entry: CatalogEntry }
  | { readonly outcome: "identity-collision"; readonly existing: CatalogEntry };

export interface Catalog {
  /** The approval for an exact canonical path, or undefined when none exists. */
  getWorkspaceApproval(path: string): WorkspaceApproval | undefined;
  /**
   * Idempotently record an approval. Approving a path already present keeps the
   * original approval time and writes no second record; returns the effective
   * record either way.
   */
  approveWorkspace(path: string, approvedAt: Date): WorkspaceApproval;
  /**
   * Install a Bundle atomically: stage the bytes, store them under the digest,
   * verify the stored bytes against the digest, and commit the Entry, all in one
   * serialized transaction. Any failure leaves no store bytes and no Entry.
   * Throws only on a caller-contract violation or storage fault (after cleaning
   * up), never for the three ordinary outcomes.
   */
  installBundle(install: BundleInstall): BundleInstallResult;
  /** How many Bundles are installed. */
  countInstalledBundles(): number;
  /** Every Installed Bundle's Entry. Order is unspecified; callers sort. */
  listEntries(): readonly CatalogEntry[];
  /**
   * The exact managed `.wfb` bytes for a digest, or undefined when the store
   * holds none. Only bytes cross — never the store path, which stays private to
   * the Catalog (ADR 0025).
   */
  readManagedBytes(digest: string): Uint8Array | undefined;
  /** Release the database; safe to call from a `finally` — it does not throw. */
  close(): void;
}

// One schema per table validates a persisted row at its ingress Seam (D7). A row
// that fails is a broken invariant — the store is corrupt or a schema drifted —
// not a user Problem, so the readers throw rather than return a finding.
const catalogEntryRow = z.object({
  id: z.string(),
  version: z.string(),
  digest: z.string(),
  origin_kind: z.enum(["local-build", "local-file"]),
  origin_location: z.string(),
  installed_at: z.string(),
  installation_generation: z.number(),
});
const approvalRow = z.object({
  path: z.string(),
  approved_at: z.string(),
});

/**
 * Open the catalog database at `<secantHome>/catalog.db`, creating the home when
 * absent. `bun:sqlite` is a Bun built-in, so the driver ships inside the
 * compiled binary; it is the sole SQLite dependency and lives only behind this
 * Interface (ADR 0030, runtime-neutrality allowlist).
 */
export function openCatalog(secantHome: string): Catalog {
  mkdirSync(secantHome, { recursive: true });
  const database = new Database(join(secantHome, "catalog.db"));
  // Serialize concurrent Secant processes at the database rather than corrupt.
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(
    "CREATE TABLE IF NOT EXISTS workspace_approvals (" +
      "path TEXT PRIMARY KEY, approved_at TEXT NOT NULL) STRICT",
  );
  // Identity is (id, version); the digest names the store file. The generation
  // is a private monotonic counter recording install order within this home.
  database.exec(
    "CREATE TABLE IF NOT EXISTS catalog_entries (" +
      "id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, " +
      "origin_kind TEXT NOT NULL, origin_location TEXT NOT NULL, " +
      "installed_at TEXT NOT NULL, installation_generation INTEGER NOT NULL, " +
      "PRIMARY KEY (id, version)) STRICT",
  );
  // The digest-named managed store holds each Bundle's exact bytes.
  const storeDir = join(secantHome, "bundles");

  // `.query()` (not `.prepare()`) so the Database owns these statements and
  // finalizes them on close; with no caller-owned statement outstanding, close()
  // then releases the file handle immediately (see `close` below).
  const insert = database.query(
    "INSERT OR IGNORE INTO workspace_approvals (path, approved_at) VALUES (?, ?)",
  );
  const select = database.query(
    "SELECT path, approved_at FROM workspace_approvals WHERE path = ?",
  );
  // BEGIN IMMEDIATE with automatic COMMIT on return and ROLLBACK on throw, so a
  // failure leaves no partial row (ADR 0030's transaction helper).
  const insertApproval = database.transaction((path: string, isoTime: string) =>
    insert.run(path, isoTime),
  );

  const selectEntry = database.query(
    "SELECT id, version, digest, origin_kind, origin_location, installed_at, " +
      "installation_generation FROM catalog_entries WHERE id = ? AND version = ?",
  );
  const insertEntry = database.query(
    "INSERT INTO catalog_entries (id, version, digest, origin_kind, " +
      "origin_location, installed_at, installation_generation) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const nextGeneration = database.query(
    "SELECT COALESCE(MAX(installation_generation), 0) + 1 AS g FROM catalog_entries",
  );
  const countEntries = database.query(
    "SELECT COUNT(*) AS n FROM catalog_entries",
  );
  const selectAllEntries = database.query(
    "SELECT id, version, digest, origin_kind, origin_location, installed_at, " +
      "installation_generation FROM catalog_entries",
  );

  function toEntry(row: Record<string, unknown>): CatalogEntry {
    const parsed = catalogEntryRow.safeParse(row);
    if (!parsed.success) {
      throw new Error("Catalog: a catalog_entries row is malformed.");
    }
    const r = parsed.data;
    const origin: BundleOrigin =
      r.origin_kind === "local-build"
        ? { kind: "local-build", folder: r.origin_location }
        : { kind: "local-file", path: r.origin_location };
    return {
      id: r.id,
      version: r.version,
      digest: r.digest,
      origin,
      installedAt: r.installed_at,
      installationGeneration: r.installation_generation,
    };
  }

  // The atomic install: serialized by BEGIN IMMEDIATE, so a concurrent writer
  // waits on `busy_timeout` or fails without corrupting. First-install-wins is
  // decided under the lock; a fresh install stages the bytes, verifies the
  // stored copy against the digest, then commits the row. On any throw the
  // partial store file is removed before the transaction rolls the row back, so
  // a failure leaves neither bytes nor Entry.
  // ponytail: the byte staging (write, read-back, hash, rename) runs inside the
  // write lock, so a large install briefly blocks other writers. Fine at M1
  // Bundle sizes; if a multi-MB install ever stalls concurrent commands, stage
  // and verify to a temp file before the transaction and keep only the
  // first-install-wins check, rename, and insert under the lock.
  const commitInstall = database.transaction(
    (install: BundleInstall): BundleInstallResult => {
      const { id, version } = install.identity;
      const existing = selectEntry.get(id, version) as Record<
        string,
        unknown
      > | null;
      if (existing != null) {
        const entry = toEntry(existing);
        return entry.digest === install.digest
          ? { outcome: "already-installed", entry }
          : { outcome: "identity-collision", existing: entry };
      }

      const finalPath = join(storeDir, `${install.digest}.wfb`);
      const stagePath = `${finalPath}.staging`;
      try {
        mkdirSync(storeDir, { recursive: true });
        writeFileSync(stagePath, install.bytes);
        const storedDigest = createHash("sha256")
          .update(readFileSync(stagePath))
          .digest("hex");
        if (storedDigest !== install.digest) {
          throw new Error(
            `Catalog: staged bytes hash to ${storedDigest}, not the ${install.digest} the caller declared.`,
          );
        }
        // Rename the verified staged copy into its digest name: an atomic
        // placement, so the store never holds a half-written digest file.
        rmSync(finalPath, { force: true });
        renameSync(stagePath, finalPath);

        const generation = (nextGeneration.get() as { g: number }).g;
        insertEntry.run(
          id,
          version,
          install.digest,
          install.origin.kind,
          install.origin.kind === "local-build"
            ? install.origin.folder
            : install.origin.path,
          install.installedAt.toISOString(),
          generation,
        );
        return {
          outcome: "installed",
          entry: toEntry(
            selectEntry.get(id, version) as Record<string, unknown>,
          ),
        };
      } catch (error) {
        rmSync(stagePath, { force: true });
        rmSync(finalPath, { force: true });
        throw error;
      }
    },
  );

  function readApproval(path: string): WorkspaceApproval | undefined {
    // `bun:sqlite` returns null (not undefined) when no row matches.
    const row = select.get(path);
    if (row == null) return undefined;
    // Validate the persisted shape at this ingress rather than trust it blindly.
    const parsed = approvalRow.safeParse(row);
    if (!parsed.success) {
      throw new Error("Catalog: a workspace_approvals row is malformed.");
    }
    return { path: parsed.data.path, approvedAt: parsed.data.approved_at };
  }

  return {
    getWorkspaceApproval: readApproval,
    approveWorkspace(path, approvedAt) {
      insertApproval.immediate(path, approvedAt.toISOString());
      const record = readApproval(path);
      if (record === undefined) {
        throw new Error("Catalog: workspace approval vanished after commit.");
      }
      return record;
    },
    installBundle(install) {
      return commitInstall.immediate(install);
    },
    countInstalledBundles() {
      return (countEntries.get() as { n: number }).n;
    },
    listEntries() {
      return (selectAllEntries.all() as Record<string, unknown>[]).map(toEntry);
    },
    readManagedBytes(digest) {
      try {
        return readFileSync(join(storeDir, `${digest}.wfb`));
      } catch {
        // Absent bytes read as undefined; a corrupt read surfaces to the caller
        // as a missing Bundle, not a thrown storage fault.
        return undefined;
      }
    },
    /**
     * Release the connection and the catalog file handle. Deterministic because
     * the Database owns every statement here; reopening the same home does not
     * race a lingering lock (the Windows close() failure `node:sqlite` could not
     * avoid, ADR 0030). Default `close()` does not throw, so callers may close
     * in a `finally` without masking a successful command.
     */
    close() {
      database.close();
    },
  };
}
