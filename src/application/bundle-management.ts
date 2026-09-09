// Client-facing contract for headless Bundle management (#9, ADR 0021). Like the
// Projection Port it exposes only normalized semantic values and reuses that
// Port's `Problem`; no Bundle runtime, storage, or ZIP object crosses it. This
// slice defines `build`; install/list/inspect arrive with the Catalog slices.
import type { Problem } from "./projection-port.js";

export interface BundleIdentity {
  readonly id: string;
  readonly version: string;
}

export interface BundleBuildOptions {
  /** Absolute path to export the exact `.wfb` bytes to, when requested. */
  readonly output?: string;
  /** Skip the store and Catalog write. This slice exercises only `true`. */
  readonly noInstall: boolean;
}

export interface BundleBuildReport {
  readonly identity: BundleIdentity;
  readonly digest: string; // SHA-256 hex over the exact bytes
  readonly outputPath?: string;
  readonly findings: readonly string[];
}

export type BundleBuildResult =
  | { readonly ok: true; readonly report: BundleBuildReport }
  | { readonly ok: false; readonly problem: Problem };

export interface BundleManagement {
  build(folder: string, options: BundleBuildOptions): BundleBuildResult;
}
