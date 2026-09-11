// Client-facing contract for headless Bundle management (#9, ADR 0021). Like the
// Projection Port it exposes only normalized semantic values and reuses that
// Port's `Problem`; no Bundle runtime, storage, or ZIP object crosses it. A
// built Bundle and an imported file install through the same path, so the two
// reports are the same shape.
import type { Problem } from "./projection-port.js";

export interface BundleIdentity {
  readonly id: string;
  readonly version: string;
}

export interface BundleBuildOptions {
  /** Absolute path to export the exact `.wfb` bytes to, when requested. */
  readonly output?: string;
  /** Build without the store and Catalog write; requires `output`. */
  readonly noInstall: boolean;
}

/** How an install settled. Absent on a `--no-install` build. */
export type BundleInstallStatus =
  | { readonly status: "installed"; readonly generation: number }
  | { readonly status: "already-installed" };

export interface BundleReport {
  readonly identity: BundleIdentity;
  readonly digest: string; // SHA-256 hex over the exact bytes
  readonly outputPath?: string;
  readonly installed?: BundleInstallStatus;
  readonly findings: readonly string[];
}

export type BundleResult =
  | { readonly ok: true; readonly report: BundleReport }
  | { readonly ok: false; readonly problem: Problem };

export interface BundleManagement {
  /** Build from a folder, installing atomically unless `noInstall`. */
  build(folder: string, options: BundleBuildOptions): BundleResult;
  /** Install a received `.wfb` file through the identical path. */
  install(file: string): BundleResult;
}
