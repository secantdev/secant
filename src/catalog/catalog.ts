import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  close(): void;
}

/**
 * Open the catalog database at `<secantHome>/catalog.db`, creating the home when
 * absent. The Catalog Module is loaded lazily by the composition root (behind
 * the CLI's engine gate), so `node:sqlite` is never reached on an unsupported
 * Node before the fail-fast names the required range.
 */
export function openCatalog(secantHome: string): Catalog {
  mkdirSync(secantHome, { recursive: true });
  const database = new DatabaseSync(join(secantHome, "catalog.db"));
  // Serialize concurrent Secant processes at the database rather than corrupt.
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(
    "CREATE TABLE IF NOT EXISTS workspace_approvals (" +
      "path TEXT PRIMARY KEY, approved_at TEXT NOT NULL) STRICT",
  );

  const insert = database.prepare(
    "INSERT OR IGNORE INTO workspace_approvals (path, approved_at) VALUES (?, ?)",
  );
  const select = database.prepare(
    "SELECT path, approved_at FROM workspace_approvals WHERE path = ?",
  );

  function readApproval(path: string): WorkspaceApproval | undefined {
    const row = select.get(path);
    if (row === undefined) return undefined;
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
      // BEGIN IMMEDIATE with guarded rollback: a failure leaves no partial row.
      database.exec("BEGIN IMMEDIATE");
      try {
        insert.run(path, approvedAt.toISOString());
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // A failed rollback must not mask the original failure below.
        }
        throw error;
      }
      const record = readApproval(path);
      if (record === undefined) {
        throw new Error("Catalog: workspace approval vanished after commit.");
      }
      return record;
    },
    close() {
      database.close();
    },
  };
}
