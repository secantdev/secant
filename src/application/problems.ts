import { generateExecutionSummary } from "../bundle/bundle.js";
import type { AuthoredManifest, Platform } from "../workflow/workflow.js";
import type { RunHarnessPreparationFailure } from "./harness-registry.js";
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

export function runExecutionFault(
  runId: string | undefined,
  error: unknown,
  operationId?: string,
): Problem {
  const message = error instanceof Error ? error.message : String(error);
  const subject =
    runId !== undefined
      ? `Run ${runId}`
      : `Operation ${operationId ?? "unknown"}`;
  return {
    code: "run-execution-fault",
    explanation: `${subject} could not be driven to rest: ${message}`,
    remediation:
      "This is a coordination or environment fault; check the Run store and retry the launch.",
    possibleEffects: "unknown",
    details:
      runId !== undefined
        ? { runId }
        : { operationId: operationId ?? "unknown" },
  };
}

export function selectedHarnessUnavailable(
  runId: string,
  failure: RunHarnessPreparationFailure,
): Problem {
  const details: Record<string, string> = {
    runId,
    harness: failure.selectedHarness,
    phase: failure.phase,
    category: failure.category,
    harnessPossibleEffects: failure.possibleEffects,
  };
  if (failure.partialOutput !== undefined) {
    details.partialOutput = failure.partialOutput;
  }
  if (failure.nativeCode !== undefined) details.nativeCode = failure.nativeCode;
  if (failure.retryEvidence !== undefined) {
    details.retryEvidence = failure.retryEvidence;
  }
  const explanation = `${failure.harnessName} could not be prepared (${failure.category}).`;
  const remediation =
    failure.category === "authentication"
      ? `Log in separately through ${failure.harnessName}, then resume Run ${runId}.`
      : `Check the installed ${failure.harnessName} version and configuration, then resume Run ${runId}.`;
  return {
    code: "selected-harness-unavailable",
    explanation:
      failure.diagnostics === undefined
        ? explanation
        : `${explanation} ${failure.diagnostics}`,
    remediation,
    possibleEffects: problemEffectScope(failure.possibleEffects),
    correction: "harness-selection",
    details,
    cause: failure.cause,
  };
}

function problemEffectScope(
  scope: RunHarnessPreparationFailure["possibleEffects"],
): Problem["possibleEffects"] {
  switch (scope) {
    case "none":
      return "none";
    case "possible":
      return "unknown";
    case "committed":
      return "partial";
  }
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

export function runSessionNotFound(runId: string, session: string): Problem {
  return {
    code: "run-session-not-found",
    explanation: `Run ${runId} has no Session named ${session} with a recorded transcript.`,
    remediation:
      "Open the Run to see its Sessions, then read a transcript reference one of them advertises.",
    possibleEffects: "none",
    details: { runId, session },
  };
}

export function runTranscriptCursorInvalid(
  runId: string,
  session: string,
): Problem {
  return {
    code: "run-transcript-cursor-invalid",
    explanation: `The transcript cursor for Run ${runId} Session ${session} is not one this Run produced.`,
    remediation:
      "Re-open the newest transcript page and page from the cursor it returns.",
    possibleEffects: "none",
    details: { runId, session },
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

/** A Turn-scoped control (interrupt-turn/steer-turn) that names no live Turn is
 *  rejected as a value (#118): the Run is not live here, or the named Turn already
 *  settled — a control issued after acceptance. */
export function turnControlRejected(
  runId: string,
  control: string,
  turnId: string,
): Problem {
  return {
    code: "turn-control-rejected",
    explanation: `Run ${runId} has no live Turn ${turnId} to ${control}; the Turn has settled or the Run is not live here.`,
    remediation:
      "Re-read the Run; a control applies only while its Turn is live. Resume a halted Run to continue it.",
    possibleEffects: "none",
    details: { runId, control, turnId },
  };
}

/** Steering a live Turn is rejected because the Harness has no same-Turn steer
 *  (#118): the offer is marked unavailable and a submission never emulates it. */
export function steerUnavailable(runId: string, reason: string): Problem {
  return {
    code: "steer-unavailable",
    explanation: `Run ${runId} cannot be steered: ${reason}`,
    remediation:
      "Interrupt the Turn to stop it, or let it run; same-Turn steer is not available for this Harness.",
    possibleEffects: "none",
    details: { runId, reason },
  };
}

/** Steering reached the live Turn but the Harness rejected it as a native control
 *  race (#148): the Turn settled or moved before the guidance landed. Distinct from
 *  `steer-unavailable`, which is refused above the Seam before any native call. */
export function steerRejected(
  runId: string,
  turnId: string,
  reason: string,
): Problem {
  return {
    code: "steer-rejected",
    explanation: `The live Turn ${turnId} on Run ${runId} rejected the guidance (${reason}); nothing was applied.`,
    remediation:
      "The Turn settled or moved before the guidance landed; nothing was applied. Re-read the Run and steer the next live Turn.",
    possibleEffects: "none",
    details: { runId, turnId, reason },
  };
}

/** A human interactive Turn was sent with blank or whitespace-only text (#122):
 *  Secant authors nothing, so an empty Turn is rejected before any stdin is sent. */
export function interactiveTurnBlank(runId: string): Problem {
  return {
    code: "interactive-turn-blank",
    explanation: `Run ${runId} was sent an interactive Turn with no text; a human Turn must carry text.`,
    remediation:
      "Type the Turn's text, then send it; blank Turns are not sent.",
    possibleEffects: "none",
    details: { runId },
  };
}

/** A second interactive Turn was sent while one is still live (#122): the Step
 *  takes one Turn at a time, and between Turns the Run stays blocked. */
export function interactiveTurnBusy(runId: string): Problem {
  return {
    code: "interactive-turn-busy",
    explanation: `Run ${runId} already has a live interactive Turn; a new Turn is sent only at a Turn boundary.`,
    remediation:
      "Wait for the live Turn to settle (or interrupt it), then send the next Turn.",
    possibleEffects: "none",
    details: { runId },
  };
}

/** An interactive-agent Step cannot be ended: the Run is not blocked at that Step
 *  (it never reached it, or it has already advanced past it) (#122). */
export function interactiveStepNotActive(
  runId: string,
  stepId: string,
  state: string,
): Problem {
  return {
    code: "interactive-step-not-active",
    explanation: `Run ${runId} is ${state}, not blocked at interactive Step "${stepId}"; there is no interactive Step to act on.`,
    remediation:
      "Open the Run to read its current state and the Step it rests at.",
    possibleEffects: "none",
    details: { runId, stepId, state },
  };
}

/** End Step was submitted while a Turn is still live (#122): a Step ends only at a
 *  Turn boundary, so the End is refused without changing anything. */
export function interactiveStepMidTurn(runId: string, stepId: string): Problem {
  return {
    code: "interactive-step-mid-turn",
    explanation: `Run ${runId} has a live Turn on interactive Step "${stepId}"; the Step ends only at a Turn boundary.`,
    remediation:
      "Wait for the live Turn to settle (or interrupt it), then end the Step.",
    possibleEffects: "none",
    details: { runId, stepId },
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

/** The answer's form does not match the Gate's shape (#108): a `free-text` answer
 *  to an `approve-reject` gate, or a `continue`/`stop` answer to a `free-text`
 *  gate. The Gate is unchanged. */
export function gateShapeMismatch(
  runId: string,
  shape: "approve-reject" | "free-text",
): Problem {
  const expected =
    shape === "free-text"
      ? "a free-text answer (`run answer --text`)"
      : "an approve/reject answer (`run answer --continue` or `--stop`)";
  return {
    code: "gate-shape-mismatch",
    explanation: `This Gate is ${shape}; it takes ${expected}. Nothing was applied.`,
    remediation:
      shape === "free-text"
        ? "Answer with `run answer <run-id> --text <value>`."
        : "Answer with `run answer <run-id> --continue` or `--stop`.",
    possibleEffects: "none",
    details: { runId, shape },
  };
}

/** The answered approval Harness Request is no longer outstanding (#117): its Turn
 *  ended, it was already answered, or the Run is not executing a Turn. The request
 *  is ephemeral, so there is nothing to answer. */
export function harnessRequestExpired(
  runId: string,
  requestId: string,
): Problem {
  return {
    code: "harness-request-expired",
    explanation: `Approval request ${requestId} on Run ${runId} is no longer outstanding; the Turn answered or ended it.`,
    remediation:
      "The request was Turn-scoped and has expired; nothing was applied. Watch the live overlay for the next request.",
    possibleEffects: "none",
    details: { runId, requestId },
  };
}

/** The answer was formed against a stale live-overlay generation (#117): the set
 *  of outstanding requests changed after the client read it, so the answer targets
 *  a superseded view and is not applied. */
export function harnessRequestStale(
  runId: string,
  submitted: number,
  current: number,
): Problem {
  return {
    code: "harness-request-stale",
    explanation: `The answer's overlay generation (${submitted}) is not the Run's current generation (${current}); nothing was applied.`,
    remediation:
      "Read the live overlay again and answer the outstanding request at its current generation.",
    possibleEffects: "none",
    details: {
      runId,
      submittedGeneration: String(submitted),
      currentGeneration: String(current),
    },
  };
}

/** Answering was refused by the live Turn control (#117): a race the Adapter
 *  settled as a rejected receipt (`expired`, `already-settled`, `shape-mismatch`).
 *  Carried as a value, never thrown (ADR 0022). */
export function harnessRequestRejected(
  runId: string,
  requestId: string,
  reason: string,
): Problem {
  return {
    code: "harness-request-rejected",
    explanation: `The live Turn rejected the answer to request ${requestId} on Run ${runId} (${reason}); nothing was applied.`,
    remediation:
      "The request settled before the answer landed; nothing was applied. Watch the live overlay for the next request.",
    possibleEffects: "none",
    details: { runId, requestId, reason },
  };
}

/** The Harness accepted an answer but could not prove whether its effect landed.
 *  The Operation stays within the Port's applied/not-applied vocabulary while the
 *  Problem preserves the Seam's unknown possible effects (#134 A20). */
export function harnessRequestIndeterminate(
  runId: string,
  requestId: string,
): Problem {
  return {
    code: "harness-request-indeterminate",
    explanation: `The Harness could not determine whether request ${requestId} on Run ${runId} was answered.`,
    remediation:
      "The request may or may not have been answered; inspect the live Turn before attempting another action.",
    possibleEffects: "unknown",
    details: { runId, requestId },
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
