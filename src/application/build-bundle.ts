import { readFileSync, writeFileSync } from "node:fs";
import {
  buildBundle,
  readBundle,
  type Budgets,
  type ReadBundle,
} from "../bundle/bundle.js";
import type {
  BundleInstall,
  BundleInstallResult,
  BundleOrigin,
  Catalog,
} from "../catalog/catalog.js";
import type { CompositionFinding } from "../workflow/workflow.js";
import type {
  BundleBuildOptions,
  BundleManagement,
  BundleReport,
  BundleResult,
} from "./bundle-management.js";
import type { Problem } from "./projection-port.js";

// Application's implementation of the Bundle-management contract. It coordinates
// the Bundle Module (reading and validating archive bytes) and the Catalog
// (the atomic store-and-commit) through their Interfaces — the two never import
// each other. A fresh build and a received file share `installBytes`, so a built
// and an imported Bundle are indistinguishable once installed.

export interface BundleManagementDependencies {
  readonly catalog: Catalog;
  readonly budgets: Budgets;
}

export function createBundleManagement(
  deps: BundleManagementDependencies,
): BundleManagement {
  const { catalog, budgets } = deps;

  function installBytes(
    bytes: Uint8Array,
    origin: BundleOrigin,
    extra: Partial<BundleReport>,
  ): BundleResult {
    const outcome = readBundle(bytes, budgets);
    if (!outcome.ok) return { ok: false, problem: toProblem(outcome.finding) };
    return commit(catalog, outcome.read, bytes, origin, extra);
  }

  return {
    build(folder: string, options: BundleBuildOptions): BundleResult {
      if (options.noInstall && options.output === undefined) {
        return { ok: false, problem: outputRequired() };
      }

      const built = buildBundle(folder);
      if (!built.ok) {
        return {
          ok: false,
          problem:
            "composition" in built
              ? compositionProblem(built.composition)
              : toProblem(built.finding),
        };
      }

      let outputPath: string | undefined;
      if (options.output !== undefined) {
        try {
          writeFileSync(options.output, built.built.bytes);
        } catch (error) {
          return { ok: false, problem: writeFailed(options.output, error) };
        }
        outputPath = options.output;
      }

      const extra: Partial<BundleReport> = {
        findings: built.built.findings,
        ...(outputPath ? { outputPath } : {}),
      };
      if (options.noInstall) {
        return {
          ok: true,
          report: {
            identity: built.built.identity,
            digest: built.built.digest,
            findings: built.built.findings,
            ...(outputPath ? { outputPath } : {}),
          },
        };
      }
      return installBytes(
        built.built.bytes,
        { kind: "local-build", folder },
        extra,
      );
    },

    install(file: string): BundleResult {
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(file);
      } catch (error) {
        return { ok: false, problem: fileUnreadable(file, error) };
      }
      return installBytes(bytes, { kind: "local-file", path: file }, {});
    },
  };
}

function commit(
  catalog: Catalog,
  read: ReadBundle,
  bytes: Uint8Array,
  origin: BundleOrigin,
  extra: Partial<BundleReport>,
): BundleResult {
  const install: BundleInstall = {
    identity: read.identity,
    digest: read.digest,
    bytes,
    origin,
    installedAt: new Date(),
  };
  let result: BundleInstallResult;
  try {
    result = catalog.installBundle(install);
  } catch (error) {
    return { ok: false, problem: storageFailed(error) };
  }
  if (result.outcome === "identity-collision") {
    return {
      ok: false,
      problem: identityCollision(read, result.existing.digest),
    };
  }
  return {
    ok: true,
    report: {
      identity: read.identity,
      digest: read.digest,
      installed:
        result.outcome === "installed"
          ? {
              status: "installed",
              generation: result.entry.installationGeneration,
            }
          : { status: "already-installed" },
      findings: extra.findings ?? [],
      ...(extra.outputPath ? { outputPath: extra.outputPath } : {}),
    },
  };
}

function toProblem(finding: {
  code: string;
  message: string;
  path?: string;
}): Problem {
  return {
    code: finding.code,
    explanation: finding.message,
    remediation:
      "Correct the named field or entry in the authoring folder or archive, then try again.",
    possibleEffects: "none",
    ...(finding.path
      ? {
          details: { location: finding.path },
          fieldViolations: [
            { field: finding.path, explanation: finding.message },
          ],
        }
      : {}),
  };
}

// A non-composing Bundle carries every Composition finding to the client as one
// Problem, each finding a field violation keyed by the Step or field it targets.
function compositionProblem(findings: readonly CompositionFinding[]): Problem {
  const errors = findings.filter((finding) => finding.severity === "error");
  return {
    code: "composition-check-failed",
    explanation: `The Bundle does not compose: ${errors.length} error-severity finding${errors.length === 1 ? "" : "s"}.`,
    remediation:
      "Correct the named Steps or fields in the authoring folder, then build again.",
    possibleEffects: "none",
    fieldViolations: errors.map((finding) => ({
      field: finding.target,
      explanation: `[${finding.code}] ${finding.explanation}`,
    })),
  };
}

function identityCollision(read: ReadBundle, installedDigest: string): Problem {
  const { id, version } = read.identity;
  return {
    code: "bundle-identity-collision",
    explanation: `A different ${id}@${version} is already installed; identities are first-install-wins.`,
    remediation:
      "Bump bundle.version to install this as a new identity, or remove the installed one first.",
    possibleEffects: "none",
    details: { id, version, installedDigest, incomingDigest: read.digest },
  };
}

function storageFailed(error: unknown): Problem {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "bundle-storage-failed",
    explanation: `The Bundle could not be stored: ${message}`,
    remediation:
      "Check the Secant home is writable and has free space, then try again.",
    possibleEffects: "none", // the atomic install cleans up on failure
  };
}

function fileUnreadable(file: string, error: unknown): Problem {
  const code = (error as NodeJS.ErrnoException).code;
  return {
    code: "bundle-file-unreadable",
    explanation: `The archive ${file} could not be read.`,
    remediation: "Pass the path to an existing, readable .wfb file.",
    possibleEffects: "none",
    details: code ? { file, errno: code } : { file },
  };
}

function writeFailed(output: string, error: unknown): Problem {
  const code = (error as NodeJS.ErrnoException).code;
  return {
    code: "output-write-failed",
    explanation: `The built bytes could not be written to ${output}.`,
    remediation:
      "Choose an --output path in an existing, writable directory, then build again.",
    possibleEffects: "partial",
    details: code ? { output, errno: code } : { output },
  };
}

function outputRequired(): Problem {
  return {
    code: "output-required",
    explanation:
      "bundle build --no-install requires --output <file>; a build that neither installs nor exports does nothing.",
    remediation: "Add --output <file> to write the built .wfb bytes.",
    possibleEffects: "none",
  };
}
