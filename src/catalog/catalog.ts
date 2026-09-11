import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// The Catalog owns the catalog database under the Secant home. Everything about
// SQLite stays behind this Interface: no SQLite type, row shape, or storage path
// crosses it. Callers ask; they never reach into rows. (ADR 0025, #21 storage.)

/** A recorded Workspace approval. Its home is the Catalog database. */
export interface WorkspaceApproval {
  readonly path: string; // canonical absolute path, compared exactly
  readonly approvedAt: string; // ISO 8601
}

export interface Catalog {
  /** The approval for an exact canonical path, or undefined when none exists. */
  getWorkspaceApproval(path: string): WorkspaceApproval | undefined;
  /**
   * Idempotently record an approval. Approving a path already present keeps the
   * original approval time and writes no second record; returns the effective
   * record either way.
   */
  approveWorkspace(path: string, approvedAt: Date): WorkspaceApproval;
  /** Release the database; safe to call from a `finally` — it does not throw. */
  close(): void;
}

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

  function readApproval(path: string): WorkspaceApproval | undefined {
    // `bun:sqlite` returns null (not undefined) when no row matches.
    const row = select.get(path);
    if (row == null) return undefined;
    // Validate the persisted shape at this ingress rather than trust it blindly.
    const { path: storedPath, approved_at: approvedAt } = row as Record<
      string,
      unknown
    >;
    if (typeof storedPath !== "string" || typeof approvedAt !== "string") {
      throw new Error("Catalog: a workspace_approvals row is malformed.");
    }
    return { path: storedPath, approvedAt };
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
