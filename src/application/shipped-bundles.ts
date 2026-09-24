import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  installBytes,
  type BundleManagementDependencies,
} from "./build-bundle.js";
import type { Problem } from "./projection-port.js";

// The startup ensure of the Shipped Bundles (ADR 0029 Installation, amended by
// ADR 0030). Composition hands in the `.wfb` files embedded in the running binary;
// each goes through the ordinary ingestion with origin `{ kind: "built-in",
// secantVersion }`, so an equal digest is a no-op and a different digest is the
// ordinary identity collision. Nothing here names a Bundle identity.
// ponytail: a sequential loop, not ADR 0029's `Promise.all` — every step is
// synchronous (`node:fs`, `bun:sqlite`) and v1 ships one built-in, so concurrency
// would buy nothing. Revisit if a Shipped Bundle's validation ever shows up.

export interface ShippedBundleEnsure {
  /** The digests the running Secant ships and has installed. */
  readonly shipped: ReadonlySet<string>;
  /** One notice per file that could not be installed; never thrown, so Secant
   *  still starts and every other Bundle remains usable. */
  readonly notices: readonly Problem[];
}

// The fixed operation id of every app-release grant: no user operation records
// it, and first-grant-wins keeps the first receipt per installed generation.
const APP_RELEASE_OPERATION = "app-release";

export function ensureShippedBundles(
  deps: BundleManagementDependencies,
  files: readonly string[],
  secantVersion: string,
): ShippedBundleEnsure {
  const shipped = new Set<string>();
  const notices: Problem[] = [];
  for (const file of files) {
    const outcome = ensureOne(deps, file, secantVersion);
    if ("digest" in outcome) shipped.add(outcome.digest);
    else notices.push(notInstalled(file, outcome.problem));
  }
  return { shipped, notices };
}

function ensureOne(
  deps: BundleManagementDependencies,
  file: string,
  secantVersion: string,
): { readonly digest: string } | { readonly problem: Problem } {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    return { problem: unreadable(file, error) };
  }
  const result = installBytes(deps, bytes, {
    kind: "built-in",
    secantVersion,
  });
  if (!result.ok) return { problem: result.problem };
  const { digest } = result.report;
  // App-release trust is a recorded grant, so launch, resume, and the timeline
  // read it exactly as a user's grant. It is recorded only on an Entry this ensure
  // (now or at an earlier startup) installed as a built-in: equal bytes a user
  // imported first keep their own origin and trust. Re-checked every startup, so
  // a crash between the install and the grant heals on the next launch.
  try {
    const entry = deps.catalog
      .listEntries()
      .find((candidate) => candidate.digest === digest);
    if (
      entry?.origin.kind === "built-in" &&
      deps.catalog.getTrustGrant(digest, entry.installationGeneration) ===
        undefined
    ) {
      deps.catalog.grantTrust({
        operationId: APP_RELEASE_OPERATION,
        digest,
        installationGeneration: entry.installationGeneration,
        grantedAt: new Date(),
      });
    }
  } catch (error) {
    return { problem: grantFailed(error) };
  }
  return { digest };
}

function notInstalled(file: string, cause: Problem): Problem {
  return {
    code: "shipped-bundle-not-installed",
    explanation: `Secant could not install its built-in Bundle ${basename(file)}: ${cause.explanation} Every other Bundle remains usable.`,
    // The ordinary collision remedy speaks to the importer of the incoming bytes;
    // here the user holds the installed ones and cannot re-version a built-in.
    remediation:
      cause.code === "bundle-identity-collision"
        ? "Another Bundle holds this built-in's identity in this Secant home, so the built-in stays unavailable there; keep using that Bundle, or point SECANT_HOME at a fresh home to use the built-in."
        : cause.remediation,
    possibleEffects: "none",
    details: { ...cause.details, file, cause: cause.code },
  };
}

function unreadable(file: string, error: unknown): Problem {
  const code = (error as NodeJS.ErrnoException).code;
  return {
    code: "bundle-file-unreadable",
    explanation: `The embedded archive ${basename(file)} could not be read.`,
    remediation:
      "Reinstall Secant; the executable's embedded built-in Bundles are incomplete.",
    possibleEffects: "none",
    ...(code ? { details: { errno: code } } : {}),
  };
}

function grantFailed(error: unknown): Problem {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "bundle-storage-failed",
    explanation: `The built-in's app-release trust could not be recorded: ${message}`,
    remediation:
      "Check the Secant home is writable and has free space, then start Secant again.",
    possibleEffects: "none",
  };
}
