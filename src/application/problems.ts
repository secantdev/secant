import { generateExecutionSummary } from "../bundle/bundle.js";
import type { AuthoredManifest, Platform } from "../workflow/workflow.js";
import type {
  DiagnosticReference,
  Problem,
  ResourceReference,
  RunGateReference,
} from "./projection-port.js";

// Every Problem the Application produces, one factory per Problem code (A17). The
// Application entry, the Run Projection, and the Bundle-catalog Projection all
// build their Problems here, so a code has exactly one explanation, remediation,
// and details shape — never two divergent copies of the same code.

export function pathNotFound(rawPath: string, error: unknown): Problem {
  const code = (error as NodeJS.ErrnoException).code;
  return {
    code: "workspace-path-not-found",
    explanation: `The path ${rawPath} could not be resolved to an existing directory.`,
    remediation:
      "Pass a path that exists, or create the directory first, then run the command again.",
    possibleEffects: "none",
    details: code ? { path: rawPath, errno: code } : { path: rawPath },
  };
}

export function workspaceNotApproved(path: string): Problem {
  return {
    code: "workspace-not-approved",
    explanation: `The launch Workspace ${path} is not approved.`,
    remediation:
      "Run `secant workspace approve` to approve this Workspace, then launch again.",
    possibleEffects: "none",
    details: { path },
  };
}

// The `bundle-trust-required` Problem carries the Execution summary for the host
// platform and the fixed authority warning in its explanation, and names the
// exact digest to acknowledge in its remediation (ADR 0021, #82 AC1). The summary
// resolves commands for the host platform when the Bundle supports it — the same
// rule `bundle-catalog`'s focus uses — so the user sees what will actually run,
// not the first declared platform.
export function bundleTrustRequired(
  manifest: AuthoredManifest,
  digest: string,
  host: Platform | undefined,
): Problem {
  const platforms = manifest.platforms ?? [];
  const platform: Platform =
    host !== undefined && platforms.includes(host)
      ? host
      : (platforms[0] ?? "linux");
  const summary = generateExecutionSummary(manifest, digest, platform);
  const kinds = Object.entries(summary.stepKindCounts)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(", ");
  const commands = summary.commands
    .map((command) => `${command.stepId}: ${command.executable}`)
    .join("; ");
  const explanation =
    `Launching ${summary.identity.id}@${summary.identity.version} needs your trust for the exact installed bytes. ` +
    `Execution summary (platform ${summary.platform}): step kinds ${kinds || "(none)"}; ` +
    `commands ${commands || "(none)"}. ${summary.warning}`;
  return {
    code: "bundle-trust-required",
    explanation,
    remediation: `Re-run with --trust ${digest} to acknowledge and trust this exact Bundle, then launch.`,
    possibleEffects: "none",
    details: { digest, platform: summary.platform },
  };
}

export function trustDigestMismatch(
  installed: string,
  acknowledged: string,
): Problem {
  return {
    code: "trust-digest-mismatch",
    explanation: `The acknowledged digest ${acknowledged} does not match the installed digest ${installed}; nothing was trusted.`,
    remediation: `Re-run with --trust ${installed} to acknowledge the exact installed Bundle.`,
    possibleEffects: "none",
    details: { installed, acknowledged },
  };
}

export function runSupportUnavailable(): Problem {
  return {
    code: "run-support-unavailable",
    explanation: "This client was wired without Run support.",
    remediation:
      "Launch Runs through the headless CLI or the shell, which wire the Run Store and execution.",
    possibleEffects: "none",
  };
}

// One code for a Run whose canonical store cannot be read, whether the failure is
// an `acquireRun` that returns nothing (Application) or a `readRun` that fails
// (Run Projection). Collapsed from `runStoreUnreadable`/`runStoreDamaged` (A17).
export function runStoreDamaged(runId: string): Problem {
  return {
    code: "run-store-damaged",
    explanation: `Run ${runId} is recorded but its canonical store could not be read.`,
    remediation:
      "The Run's canonical store is damaged; delete the Run and launch a fresh one.",
    possibleEffects: "unknown",
    details: { runId },
  };
}

export function runExecutionFault(runId: string, error: unknown): Problem {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "run-execution-fault",
    explanation: `Run ${runId} could not be driven to rest: ${message}`,
    remediation:
      "This is a coordination or environment fault; check the Run store and retry the launch.",
    possibleEffects: "unknown",
    details: { runId },
  };
}

export function runLiveElsewhere(runId: string, ownerPid?: number): Problem {
  const owner = ownerPid !== undefined ? ` (process ${ownerPid})` : "";
  return {
    code: "run-live-elsewhere",
    explanation: `Run ${runId} is live in another process${owner}; this instance cannot change it without taking ownership.`,
    remediation: `Wait for the Run to rest, or run \`secant run resume ${runId} --takeover\` to take ownership and continue it.`,
    possibleEffects: "none",
    details:
      ownerPid !== undefined
        ? { runId, ownerPid: String(ownerPid) }
        : { runId },
  };
}

export function runOutputMissing(reference: ResourceReference): Problem {
  return {
    code: "run-output-not-found",
    explanation: `Output ${reference.artifactName} has no bytes at the referenced version.`,
    remediation:
      "Open the Run to see its current outputs, then read one that is bound.",
    possibleEffects: "none",
    details: { runId: reference.runId, artifactName: reference.artifactName },
  };
}

export function runDiagnosticMissing(reference: DiagnosticReference): Problem {
  return {
    code: "run-diagnostic-not-found",
    explanation: `Diagnostic ${reference.diagnosticId} is not recorded for this Run.`,
    remediation:
      "Open the Run to see its current conflict, then read the diagnostic it references.",
    possibleEffects: "none",
    details: { runId: reference.runId, diagnosticId: reference.diagnosticId },
  };
}

export function runNotFound(runId: string): Problem {
  return {
    code: "run-not-found",
    explanation: `No Run ${runId} exists in this Workspace.`,
    remediation:
      "Check the Run id (it is printed when a Run is launched), or launch a Run first.",
    possibleEffects: "none",
    details: { runId },
  };
}

export function runNotResumable(runId: string, state: string): Problem {
  return {
    code: "run-not-resumable",
    explanation: `Run ${runId} is ${state}; only a halted or failed Run can be resumed.`,
    remediation:
      "Resume applies to a Run resting halted or failed; open the Run to see its state.",
    possibleEffects: "none",
    details: { runId, state },
  };
}

/** A Run that is not live cannot be cancelled: there is no execution to stop (#87). */
export function runNotLive(runId: string): Problem {
  return {
    code: "run-not-live",
    explanation: `Run ${runId} is not live; only a live Run can be cancelled.`,
    remediation:
      "A resting or terminal Run has nothing to cancel; delete it instead to remove it.",
    possibleEffects: "none",
    details: { runId },
  };
}

/** A live Run cannot be deleted: its store is in use (#87). */
export function runIsLive(runId: string): Problem {
  return {
    code: "run-is-live",
    explanation: `Run ${runId} is live; a live Run cannot be deleted.`,
    remediation:
      "Cancel the Run first (or wait for it to reach rest), then delete it.",
    possibleEffects: "none",
    details: { runId },
  };
}

/** A Run that is not blocked cannot be answered: the Gate does not exist (#85). */
export function runNotBlocked(runId: string, state: string): Problem {
  return {
    code: "run-not-blocked",
    explanation: `Run ${runId} is ${state}, not blocked; there is no Human Gate to answer.`,
    remediation:
      "Open the Run to see its state; only a blocked Run rests at an answerable Gate.",
    possibleEffects: "none",
    details: { runId, state },
  };
}

/** The submitted Gate reference no longer matches the Run's live Gate (#85): the
 *  block moved on, so the answer targets a stale Attempt and is not applied. */
export function gateStale(
  runId: string,
  submitted: RunGateReference,
  current: RunGateReference,
): Problem {
  return {
    code: "gate-reference-stale",
    explanation: `The answered Gate (attempt ${submitted.attemptId}) is not the Run's current Gate (attempt ${current.attemptId}); nothing was applied.`,
    remediation:
      "Open the Run to read its current Gate reference, then answer that one.",
    possibleEffects: "none",
    details: {
      runId,
      submittedAttemptId: submitted.attemptId,
      currentAttemptId: current.attemptId,
    },
  };
}

export function operationNotFound(operationId: string): Problem {
  return {
    code: "operation-not-found",
    explanation: `No Operation ${operationId} has been submitted.`,
    remediation:
      "Submit the Operation before opening its Projection, or check the operation id.",
    possibleEffects: "none",
    details: { operationId },
  };
}

export function operationIdReused(operationId: string): Problem {
  return {
    code: "operation-id-reused",
    explanation: `Operation id ${operationId} was already used for a different request.`,
    remediation:
      "Repeat the original request with the same input, or use a fresh operation id.",
    possibleEffects: "none",
  };
}

export function bundleNotInstalled(id: string): Problem {
  return {
    code: "bundle-not-installed",
    explanation: `No Bundle with id ${id} is installed.`,
    remediation:
      "Run `secant bundle list` to see installed Bundles, then name one that is installed.",
    possibleEffects: "none",
    details: { id },
  };
}

export function versionNotInstalled(id: string, version: string): Problem {
  return {
    code: "bundle-version-not-installed",
    explanation: `${id}@${version} is not installed.`,
    remediation:
      "Run `secant bundle list` to see the installed versions, then name one that is installed.",
    possibleEffects: "none",
    details: { id, version },
  };
}

export function noStableVersion(id: string): Problem {
  return {
    code: "no-stable-version-installed",
    explanation: `Only prerelease versions of ${id} are installed; a prerelease must be named explicitly.`,
    remediation: `Run \`secant bundle list\` to see the installed versions, then name a prerelease explicitly (e.g. \`${id}@<version>\`).`,
    possibleEffects: "none",
    details: { id },
  };
}

/** A Bundle recorded as installed whose stored bytes are gone. Both the Run-launch
 *  flow (which holds only the pinned `digest`) and the Catalog flow (which holds
 *  the Entry's `id`/`version` too) route here; the id/version enrich the message
 *  and details when the caller has them (A17). */
export function bundleBytesMissing(subject: {
  digest: string;
  id?: string;
  version?: string;
}): Problem {
  const { digest, id, version } = subject;
  const named = id !== undefined && version !== undefined;
  return {
    code: "bundle-bytes-missing",
    explanation: named
      ? `${id}@${version} is recorded as installed, but its stored bytes are missing.`
      : `The Bundle for digest ${digest} is recorded as installed, but its stored bytes are missing.`,
    // Flow-neutral: this reaches both the Run-launch and the Catalog-inspect
    // paths, so it names the fix without assuming the caller is launching.
    remediation:
      "Reinstall the Bundle to restore its bytes, or remove the stale Catalog Entry.",
    possibleEffects: "none",
    details:
      id !== undefined && version !== undefined
        ? { id, version, digest }
        : { digest },
  };
}

/** A Bundle recorded as installed whose stored bytes no longer validate. Same two
 *  callers as `bundleBytesMissing` (A17). */
export function bundleBytesCorrupt(
  subject: { digest: string; id?: string; version?: string },
  finding: string,
): Problem {
  const { digest, id, version } = subject;
  const named = id !== undefined && version !== undefined;
  return {
    code: "bundle-bytes-corrupt",
    explanation: named
      ? `${id}@${version} is installed, but its stored bytes no longer validate (${finding}).`
      : `The Bundle for digest ${digest} is installed, but its stored bytes no longer validate (${finding}).`,
    // Flow-neutral (see bundleBytesMissing): reinstalling restores intact bytes
    // whether the caller was launching or inspecting.
    remediation: "Reinstall the Bundle to restore intact bytes.",
    possibleEffects: "none",
    details:
      id !== undefined && version !== undefined
        ? { id, version, finding, digest }
        : { digest, finding },
  };
}
