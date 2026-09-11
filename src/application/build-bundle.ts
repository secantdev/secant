import { writeFileSync } from "node:fs";
import { buildBundle } from "../bundle/bundle.js";
import type { CompositionFinding } from "../workflow/workflow.js";
import type {
  BundleBuildOptions,
  BundleBuildResult,
  BundleManagement,
} from "./bundle-management.js";
import type { Problem } from "./projection-port.js";

// Application's implementation of the Bundle-management contract. It coordinates
// the Bundle Module through its Interface, writes the exported bytes, and
// translates a Bundle finding into the Port's normalized Problem. The store and
// Catalog write behind the default installing path arrive with the Catalog
// install slice; this slice serves only `--no-install --output`.

export function createBundleManagement(): BundleManagement {
  return {
    build(folder: string, options: BundleBuildOptions): BundleBuildResult {
      if (!options.noInstall) {
        return { ok: false, problem: installUnavailable() };
      }
      if (options.output === undefined) {
        return { ok: false, problem: outputRequired() };
      }

      const outcome = buildBundle(folder);
      if (!outcome.ok) {
        return {
          ok: false,
          problem:
            "composition" in outcome
              ? compositionProblem(outcome.composition)
              : toProblem(outcome.finding),
        };
      }

      try {
        writeFileSync(options.output, outcome.built.bytes);
      } catch (error) {
        return { ok: false, problem: writeFailed(options.output, error) };
      }
      return {
        ok: true,
        report: {
          identity: outcome.built.identity,
          digest: outcome.built.digest,
          outputPath: options.output,
          findings: outcome.built.findings,
        },
      };
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
      "Correct the named field or entry in the authoring folder, then build again.",
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

function installUnavailable(): Problem {
  return {
    code: "bundle-install-unavailable",
    explanation:
      "Installing a Bundle is not available yet; the Catalog install slice adds it.",
    remediation:
      "Pass --no-install --output <file> to build without installing.",
    possibleEffects: "none",
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
