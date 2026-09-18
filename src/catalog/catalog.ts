import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { and, count, eq, max, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { z } from "zod";
import { catalogMigrations } from "../drizzle/migrations.js";
import { catalogEntries, trustGrants, workspaceApprovals } from "./schema.js";

// The Catalog owns the catalog database under the Secant home. Everything about
// SQLite stays behind this Interface: no SQLite type or row shape crosses it, and
// the one storage path that does is the installed asset root (`assetRoot`), which
// deliberately crosses so a Run can read the extracted layer. Callers ask; they
// never reach into rows. (ADR 0025, #21 storage.)

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

/**
 * The receipt of a Trust grant: the caller's operation id and when it was
 * recorded. A grant is bound to the exact installed digest at its private
 * installation generation, so it never carries to a later install of the same
 * identity with different bytes (ADR 0021).
 */
export interface TrustGrant {
  readonly operationId: string;
  readonly grantedAt: string; // ISO 8601
}

/** The validated bytes and metadata an install commits. */
export interface BundleInstall {
  readonly identity: { readonly id: string; readonly version: string };
  readonly digest: string; // SHA-256 hex the caller computed over the bytes
  readonly bytes: Uint8Array; // the exact `.wfb` bytes
  readonly origin: BundleOrigin;
  readonly installedAt: Date;
}

/** One manifest-declared asset file inside exact `.wfb` bytes. */
export interface AssetFile {
  readonly path: string; // the archive entry's relative path
  readonly data: Uint8Array;
}

/**
 * Reads the manifest-declared asset files out of exact `.wfb` bytes, or undefined
 * when the bytes are not a readable Bundle. Composition supplies the Bundle
 * Module's reader; the Catalog itself never parses an archive, so it keeps
 * depending only on the Workflow vocabulary. Without a reader every install
 * derives an empty tree.
 */
export type AssetReader = (
  bytes: Uint8Array,
) => readonly AssetFile[] | undefined;

export interface CatalogOptions {
  readonly readAssets?: AssetReader;
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
   * verify the stored bytes against the digest, derive the digest-named asset
   * tree beside them, and commit the Entry, all in one serialized transaction.
   * Any failure leaves no store bytes, no tree, and no Entry. Throws only on a
   * caller-contract violation or storage fault (after cleaning up), never for
   * the three ordinary outcomes.
   */
  installBundle(install: BundleInstall): BundleInstallResult;
  /**
   * Record a Trust grant for an installed Bundle under a caller-generated
   * operation id, committed atomically (its own BEGIN IMMEDIATE, like an
   * install): any failure leaves no grant. The grant is bound to the exact
   * installed `(digest, installationGeneration)` the caller names — both come
   * from the `CatalogEntry` being trusted — so it never authorizes a later
   * install of the same identity with a different digest, nor a re-install of the
   * same digest at a fresh generation. First-grant-wins: re-granting the same
   * installed Bundle (any operation id) keeps the original receipt and writes
   * nothing new. Throws on a caller-contract violation (nothing is installed at
   * that `(digest, generation)`) or a storage fault. Trust is never derived from
   * what a Bundle declares — only from this recorded grant.
   */
  grantTrust(request: {
    readonly operationId: string;
    readonly digest: string;
    readonly installationGeneration: number;
    readonly grantedAt: Date;
  }): TrustGrant;
  /**
   * The Trust grant for an installed Bundle's exact `(digest,
   * installationGeneration)` — pass both from the Entry — or undefined when none
   * was recorded. This is the sole source of trust; a grant against an earlier
   * generation of the same digest does not count.
   */
  getTrustGrant(
    digest: string,
    installationGeneration: number,
  ): TrustGrant | undefined;
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
  /**
   * The directory holding an installed digest's extracted, read-only asset tree
   * — one file per manifest-declared asset, at its archive-relative path — or
   * undefined when the digest is not installed. The tree is a derived cache of
   * the managed bytes, never an identity or a second source of truth: a missing
   * or corrupt tree is re-extracted from the bytes here before the directory is
   * returned, and only missing bytes read as not installed (ADR 0021, #100).
   * Nothing else about the store layout crosses this Interface.
   */
  assetRoot(digest: string): string | undefined;
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
const trustGrantRow = z.object({
  operation_id: z.string(),
  granted_at: z.string(),
});

type TCommitGrantParams = {
  readonly digest: string;
  readonly generation: number;
  readonly operationId: string;
  readonly isoTime: string;
};

function openDatabase(path: string) {
  const database = new Database(path);
  try {
    // Serialize concurrent Secant processes at the database rather than corrupt.
    database.exec("PRAGMA busy_timeout = 5000");
    const db = drizzle({ client: database });
    migrate(db, catalogMigrations);
    return { database, db };
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Open the catalog database at `<secantHome>/catalog.db`, creating the home when
 * absent. `bun:sqlite` is a Bun built-in, so the driver ships inside the
 * compiled binary; it is the sole SQLite dependency and lives only behind this
 * Interface (ADR 0030, runtime-neutrality allowlist).
 */
export function openCatalog(
  secantHome: string,
  options: CatalogOptions = {},
): Catalog {
  const readAssets: AssetReader = options.readAssets ?? (() => []);
  mkdirSync(secantHome, { recursive: true });
  const { database, db } = openDatabase(join(secantHome, "catalog.db"));
  // The digest-named managed store holds each Bundle's exact bytes as
  // `<digest>.wfb`, and beside each one the derived asset tree in `<digest>/`.
  const storeDir = join(secantHome, "bundles");
  const bytesPath = (digest: string) => join(storeDir, `${digest}.wfb`);
  const treePath = (digest: string) => join(storeDir, digest);

  // Derive the asset tree for a digest from its exact bytes with the same
  // quarantine the bytes use: write every declared file into a staging directory,
  // read each back and compare, then rename the whole tree into its digest name.
  // On POSIX each file is made read-only (a Run must never edit the shared
  // layer); Windows gets no read-only attribute, which would only obstruct the
  // sweep and rewrite below. Throws on a storage fault or unreadable bytes after
  // removing the staging tree; the caller owns the final tree's cleanup.
  // ponytail: files are read-only, directories stay writable, so a rewrite can
  // `rmSync` the old tree without a chmod pass first. Lock the directories too
  // if a Run is ever seen adding files beside the assets.
  function extractTree(digest: string, bytes: Uint8Array): void {
    const assets = readAssets(bytes);
    if (assets === undefined) {
      throw new Error(
        `Catalog: the managed bytes for ${digest} are not a readable Bundle.`,
      );
    }
    const final = treePath(digest);
    const staging = `${final}.staging`;
    rmSync(staging, { recursive: true, force: true });
    try {
      mkdirSync(staging, { recursive: true });
      for (const asset of assets) {
        const target = join(staging, asset.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, asset.data);
        if (!Buffer.from(readFileSync(target)).equals(asset.data)) {
          throw new Error(
            `Catalog: the extracted asset ${asset.path} of ${digest} did not read back intact.`,
          );
        }
        if (process.platform !== "win32") chmodSync(target, 0o444);
      }
      rmSync(final, { recursive: true, force: true });
      renameSync(staging, final);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  // True when every declared asset is present in the tree at its declared size.
  // ponytail: a size check, not a hash, decides "corrupt"; the bytes remain the
  // authority either way, so a same-length edit merely survives until the next
  // reinstall. Hash the files here if that ever matters.
  function treeIntact(digest: string, bytes: Uint8Array): boolean {
    const assets = readAssets(bytes);
    if (assets === undefined) return false;
    const root = treePath(digest);
    if (!existsSync(root)) return false;
    return assets.every((asset) => {
      try {
        return statSync(join(root, asset.path)).size === asset.data.length;
      } catch {
        return false;
      }
    });
  }

  function readManaged(digest: string): Uint8Array | undefined {
    try {
      return readFileSync(bytesPath(digest));
    } catch {
      // Absent bytes read as undefined; a corrupt read surfaces to the caller
      // as a missing Bundle, not a thrown storage fault.
      return undefined;
    }
  }

  // BEGIN IMMEDIATE with automatic COMMIT on return and ROLLBACK on throw, so a
  // failure leaves no partial row (ADR 0030's transaction helper).
  function insertApproval(path: string, isoTime: string): void {
    db.transaction(
      (tx) => {
        tx.insert(workspaceApprovals)
          .values({ path, approved_at: isoTime })
          .onConflictDoNothing()
          .run();
      },
      { behavior: "immediate" },
    );
  }
  // The grant is written inside BEGIN IMMEDIATE with automatic COMMIT/ROLLBACK,
  // so the installed-at-this-generation check and the insert are one serialized
  // step and a fault (a corrupt store schema, say) leaves no grant row. Trusting
  // a (digest, generation) that is not installed is a caller-contract violation,
  // so it throws (and rolls back) rather than recording a dangling grant.
  function commitGrant(params: TCommitGrantParams): void {
    db.transaction(
      (tx) => {
        const entry = tx
          .select({ present: sql<number>`1` })
          .from(catalogEntries)
          .where(
            and(
              eq(catalogEntries.digest, params.digest),
              eq(catalogEntries.installation_generation, params.generation),
            ),
          )
          .get();
        if (entry === undefined) {
          throw new Error(
            `Catalog: cannot grant trust for digest ${params.digest}; it is not installed at generation ${params.generation}.`,
          );
        }
        tx.insert(trustGrants)
          .values({
            digest: params.digest,
            installation_generation: params.generation,
            operation_id: params.operationId,
            granted_at: params.isoTime,
          })
          .onConflictDoNothing()
          .run();
      },
      { behavior: "immediate" },
    );
  }

  function toEntry(row: typeof catalogEntries.$inferSelect): CatalogEntry {
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
  // stored copy against the digest, derives the asset tree beside them, then
  // commits the row. On any throw the partial store file and tree are removed
  // before the transaction rolls the row back, so a failure leaves neither
  // bytes, nor tree, nor Entry.
  // ponytail: the byte staging (write, read-back, hash, rename) runs inside the
  // write lock, so a large install briefly blocks other writers. Fine at M1
  // Bundle sizes; if a multi-MB install ever stalls concurrent commands, stage
  // and verify to a temp file before the transaction and keep only the
  // first-install-wins check, rename, and insert under the lock.
  function commitInstall(install: BundleInstall): BundleInstallResult {
    return db.transaction(
      (tx): BundleInstallResult => {
        const { id, version } = install.identity;
        const existing = tx
          .select()
          .from(catalogEntries)
          .where(
            and(eq(catalogEntries.id, id), eq(catalogEntries.version, version)),
          )
          .get();
        if (existing != null) {
          const entry = toEntry(existing);
          return entry.digest === install.digest
            ? { outcome: "already-installed", entry }
            : { outcome: "identity-collision", existing: entry };
        }

        const finalPath = bytesPath(install.digest);
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
          // A re-install of this digest at a fresh generation rewrites the tree.
          extractTree(install.digest, install.bytes);

          const currentGeneration = tx
            .select({ value: max(catalogEntries.installation_generation) })
            .from(catalogEntries)
            .get()?.value;
          const generation = (currentGeneration ?? 0) + 1;
          tx.insert(catalogEntries)
            .values({
              id,
              version,
              digest: install.digest,
              origin_kind: install.origin.kind,
              origin_location:
                install.origin.kind === "local-build"
                  ? install.origin.folder
                  : install.origin.path,
              installed_at: install.installedAt.toISOString(),
              installation_generation: generation,
            })
            .run();
          const inserted = tx
            .select()
            .from(catalogEntries)
            .where(
              and(
                eq(catalogEntries.id, id),
                eq(catalogEntries.version, version),
              ),
            )
            .get();
          if (inserted === undefined) {
            throw new Error("Catalog: installed entry vanished before commit.");
          }
          return { outcome: "installed", entry: toEntry(inserted) };
        } catch (error) {
          rmSync(stagePath, { force: true });
          rmSync(finalPath, { force: true });
          rmSync(treePath(install.digest), { recursive: true, force: true });
          throw error;
        }
      },
      { behavior: "immediate" },
    );
  }

  function readApproval(path: string): WorkspaceApproval | undefined {
    const row = db
      .select()
      .from(workspaceApprovals)
      .where(eq(workspaceApprovals.path, path))
      .get();
    if (row === undefined) return undefined;
    // Validate the persisted shape at this ingress rather than trust it blindly.
    const parsed = approvalRow.safeParse(row);
    if (!parsed.success) {
      throw new Error("Catalog: a workspace_approvals row is malformed.");
    }
    return { path: parsed.data.path, approvedAt: parsed.data.approved_at };
  }

  function readGrant(
    digest: string,
    generation: number,
  ): TrustGrant | undefined {
    const row = db
      .select({
        operation_id: trustGrants.operation_id,
        granted_at: trustGrants.granted_at,
      })
      .from(trustGrants)
      .where(
        and(
          eq(trustGrants.digest, digest),
          eq(trustGrants.installation_generation, generation),
        ),
      )
      .get();
    if (row === undefined) return undefined;
    // Validate the persisted shape at this ingress; a malformed row is a broken
    // invariant (the store is corrupt), not a caller Problem (D7).
    const parsed = trustGrantRow.safeParse(row);
    if (!parsed.success) {
      throw new Error("Catalog: a trust_grants row is malformed.");
    }
    return {
      operationId: parsed.data.operation_id,
      grantedAt: parsed.data.granted_at,
    };
  }

  return {
    getWorkspaceApproval: readApproval,
    approveWorkspace(path, approvedAt) {
      insertApproval(path, approvedAt.toISOString());
      const record = readApproval(path);
      if (record === undefined) {
        throw new Error("Catalog: workspace approval vanished after commit.");
      }
      return record;
    },
    installBundle(install) {
      return commitInstall(install);
    },
    grantTrust(request) {
      // The transaction rejects a (digest, generation) that is not installed as
      // a caller-contract violation (throws); Application translates that to a
      // Problem at the Seam.
      commitGrant({
        digest: request.digest,
        generation: request.installationGeneration,
        operationId: request.operationId,
        isoTime: request.grantedAt.toISOString(),
      });
      // Read back the effective grant: first-grant-wins means this is the
      // original receipt when a grant already existed for this (digest,
      // generation), and the just-recorded one otherwise.
      const grant = readGrant(request.digest, request.installationGeneration);
      if (grant === undefined) {
        throw new Error("Catalog: trust grant vanished after commit.");
      }
      return grant;
    },
    getTrustGrant(digest, installationGeneration) {
      return readGrant(digest, installationGeneration);
    },
    countInstalledBundles() {
      const row = db.select({ value: count() }).from(catalogEntries).get();
      if (row === undefined) {
        throw new Error("Catalog: installed Bundle count was not returned.");
      }
      return row.value;
    },
    listEntries() {
      return db.select().from(catalogEntries).all().map(toEntry);
    },
    readManagedBytes: readManaged,
    assetRoot(digest) {
      const bytes = readManaged(digest);
      if (bytes === undefined) return undefined;
      // ponytail: the archive is re-read on every ask to know what "intact"
      // means, and the re-extraction runs outside the install lock, so two
      // processes launching one digest can both rewrite the same tree — each
      // writes identical files, so the loser of the rename sees the winner's
      // tree. Cache the declared paths or take the write lock if either bites.
      if (!treeIntact(digest, bytes)) {
        try {
          extractTree(digest, bytes);
        } catch (error) {
          if (!treeIntact(digest, bytes)) throw error;
        }
      }
      return treePath(digest);
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
