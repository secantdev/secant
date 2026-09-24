import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBundle } from "../src/bundle/bundle.js";

// The Shipped Bundles (ADR 0029, amended by ADR 0030): the allow-listed authoring
// folders are built once, through the ordinary Bundle builder, into the exact
// `.wfb` bytes `scripts/build.ts` embeds in every compiled binary. The allow-list
// is this constant, so a reviewer sees any change in the diff and nothing in
// `src/` branches on Bundle identity; the Test Repair Proof Bundle stays External
// by staying off it. Every build is checked against the committed lock, so a byte
// change without a version and lock bump fails on each OS that builds.

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SHIPPED_BUNDLE_FOLDERS = ["bundles/matt-front-spec"] as const;

export const LOCK_FILE = "bundles/builtin.lock.json";

export interface LockedBundle {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

export interface ShippedBundle extends LockedBundle {
  readonly file: string;
}

export function readLock(): LockedBundle[] {
  return JSON.parse(
    readFileSync(join(projectRoot, LOCK_FILE), "utf8"),
  ) as LockedBundle[];
}

/** Fail unless `built` is exactly the locked set of (id, version, digest). */
export function assertLocked(
  built: readonly LockedBundle[],
  lock: readonly LockedBundle[],
): void {
  for (const { id, version, digest } of built) {
    const locked = lock.find(
      (entry) => entry.id === id && entry.version === version,
    );
    if (locked?.digest !== digest) {
      throw new Error(
        `Shipped Bundle ${id}@${version} built to digest ${digest}, but ${LOCK_FILE} ${
          locked ? `locks ${locked.digest}` : "has no entry for it"
        }. Changed bytes need a new version: bump the manifest version and update ${LOCK_FILE} in the same change.`,
      );
    }
  }
  for (const { id, version } of lock) {
    if (!built.some((entry) => entry.id === id && entry.version === version)) {
      throw new Error(
        `${id}@${version} is locked but not built; remove it from ${LOCK_FILE}.`,
      );
    }
  }
}

/** Build every allow-listed folder into `<outDir>/<id>-<version>.wfb` (the
 *  directory is replaced), failing unless the built set equals `lock`. */
export function buildShippedBundles(
  outDir: string,
  lock: readonly LockedBundle[] = readLock(),
): ShippedBundle[] {
  const shipped = SHIPPED_BUNDLE_FOLDERS.map((folder) => {
    const outcome = buildBundle(join(projectRoot, folder));
    if (!outcome.ok) {
      throw new Error(
        `Shipped Bundle ${folder} failed to build: ${JSON.stringify(outcome)}`,
      );
    }
    const { identity, digest, bytes } = outcome.built;
    const file = join(outDir, `${identity.id}-${identity.version}.wfb`);
    return { ...identity, digest, file, bytes };
  });
  assertLocked(shipped, lock);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const { file, bytes } of shipped) writeFileSync(file, bytes);
  return shipped;
}
