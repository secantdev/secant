import semver from "semver";
import type { Catalog, CatalogEntry } from "../catalog/catalog.js";
import { inspectBundle, type Budgets } from "../bundle/bundle.js";
import {
  flattenSteps,
  type Platform,
  type RoutingNode,
} from "../workflow/workflow.js";
import type {
  AttemptLogEntry,
  RunGroup,
  RunOwner,
} from "../run/store/store.js";
import type {
  Problem,
  RunOutputView,
  RunResult,
  RunSnapshot,
  RunStepProgress,
  RunTimelineEvent,
} from "./projection-port.js";

// The `run` Projection join (#82), beside `bundle-catalog.ts`. It reads a Run's
// canonical record and outputs through the Run Store, re-derives the ordered
// Workflow (from the pinned Bundle's stored bytes, via the Bundle Module) to
// shape per-Step progress, and translates both into the normalized client
// contract. Application owns this join because it is the only place that imports
// the Run Store, the Bundle Module, and the Catalog together; nothing storage-,
// runtime-, or Git-shaped crosses — only semantic values leave here.

export interface RunProjectionDependencies {
  readonly runGroup: RunGroup;
  readonly catalog: Catalog;
  readonly budgets: Budgets;
  readonly hostPlatform?: Platform;
}

/** Facts a launched Run pins that are cheaper to carry from the launch use case
 *  than to re-derive: the routing (for progress), the Bundle's human name and
 *  identity, and the digest. For a Run launched in another process these are
 *  re-derived from the stored bytes instead. */
export interface RunFacts {
  readonly routing: readonly RoutingNode[];
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

/** How the join reaches a Run's canonical record and outputs. When the Run is
 *  live in this process the launch use case passes its held owner, so a snapshot
 *  read never fences the executing owner; otherwise the join acquires a
 *  short-lived owner and closes it. */
export interface RunReadContext {
  readonly facts?: RunFacts; // present for a Run launched in this process
  readonly liveOwner?: RunOwner; // present while live in this process
  readonly state?: string; // the in-memory latest state while tracked
}

/** Build the bounded `run` snapshot for one Run id. */
export function runSnapshot(
  deps: RunProjectionDependencies,
  runId: string,
  context: RunReadContext,
): RunSnapshot {
  return { family: "run", runId, result: runResult(deps, runId, context) };
}

function runResult(
  deps: RunProjectionDependencies,
  runId: string,
  context: RunReadContext,
): RunResult {
  const read = deps.runGroup.readRun(runId);
  if (!read.ok) {
    return {
      found: false,
      problem:
        read.problem.kind === "unknown-run"
          ? runNotFound(runId)
          : runStoreDamaged(runId),
    };
  }
  const record = read.run;
  const derived = context.facts
    ? { facts: context.facts }
    : deriveRunFacts(deps, record.bundleSnapshotDigest);
  if ("problem" in derived) return { found: false, problem: derived.problem };
  const facts = derived.facts;
  const state = context.state ?? record.state;
  const view = (
    log: readonly AttemptLogEntry[],
    outputs: readonly RunOutputView[],
  ): RunResult => {
    const progress = reconstructProgress(facts.routing, log, state);
    return {
      found: true,
      run: {
        runId,
        bundle: {
          id: facts.id,
          version: facts.version,
          name: facts.name,
          digest: facts.digest,
        },
        workspacePath: record.workspacePath,
        launchedAt: record.createdAt,
        state,
        progress: progress.statuses,
        position: progress.position,
        timeline: buildTimeline(deps, record.createdAt, log, facts.digest),
        outputs,
      },
    };
  };

  const live = context.liveOwner;
  // Never acquire a fresh owner for a Run that is live in another process: every
  // `acquireRun` bumps the fencing epoch, which would fence — and so abort — the
  // process actually executing the Run. A read must never break a running Run, so
  // show the record-level snapshot instead (no attempt log or outputs from here).
  if (live === undefined && isLiveElsewhere(deps.runGroup, runId)) {
    return view([], []);
  }
  const owner = live ?? deps.runGroup.acquireRun(runId);
  if (owner === undefined) {
    return { found: false, problem: runStoreDamaged(runId) };
  }
  try {
    return view(
      owner.attemptLog(),
      collectOutputs(owner, facts.routing, runId),
    );
  } finally {
    if (live === undefined) owner.close();
  }
}

/** Whether the coordination record still holds this Run's live Workspace claim —
 *  i.e. some process is executing it — so a reader must not acquire (and fence). */
export function isLiveElsewhere(runGroup: RunGroup, runId: string): boolean {
  return runGroup.listRuns().some((run) => run.runId === runId && run.live);
}

/** Re-derive the routing and Bundle facts from the pinned Snapshot's stored
 *  bytes, translating a missing or corrupt managed store into a typed Problem. */
export function deriveRunFacts(
  deps: RunProjectionDependencies,
  digest: string,
): { facts: RunFacts } | { problem: Problem } {
  const bytes = deps.catalog.readManagedBytes(digest);
  if (bytes === undefined) return { problem: bundleBytesMissingForRun(digest) };
  const outcome = inspectBundle(bytes, deps.budgets, false);
  if (!outcome.ok) {
    return { problem: bundleBytesCorruptForRun(digest, outcome.finding.code) };
  }
  const { manifest } = outcome.inspection;
  return {
    facts: {
      routing: manifest.routing,
      name: manifest.bundle.name,
      id: manifest.bundle.id,
      version: manifest.bundle.version,
      digest,
    },
  };
}

// The outputs a Run produced, reached by reference. A Command binds only `text`
// and `verdict` (its Step-kind contract), so only those are surfaced in M2; the
// latest bound version per name wins when several Steps produce the same name.
function collectOutputs(
  owner: RunOwner,
  routing: readonly RoutingNode[],
  runId: string,
): RunOutputView[] {
  const declared = new Map<string, "text" | "verdict">();
  for (const step of flattenSteps(routing)) {
    for (const produced of step.produces ?? []) {
      if (produced.type === "text" || produced.type === "verdict") {
        declared.set(produced.name, produced.type);
      }
    }
  }
  const outputs: RunOutputView[] = [];
  for (const [name, type] of declared) {
    const versionId = owner.currentVersion(name);
    if (versionId === undefined) continue;
    outputs.push({
      name,
      type,
      reference: { runId, artifactName: name, versionId, type },
    });
  }
  return outputs;
}

// Reconstruct per-Step progress from the ordered attempt log and the Run state.
// ponytail: M2 Routings are straight-line command-only, so a `succeeded` Attempt
// completes the current Step and advances, and `failed` Attempts before it are
// that Step's retries; the deciding failure is read from the rested Run state.
// This walk gains a Step→Attempt link when Repeat groups (#84) make it ambiguous.
function reconstructProgress(
  routing: readonly RoutingNode[],
  log: readonly AttemptLogEntry[],
  state: string,
): { statuses: RunStepProgress[]; position: number } {
  const steps = flattenSteps(routing);
  const statuses: RunStepProgress[] = steps.map((step) => ({
    id: step.id,
    kind: step.kind,
    status: "pending",
  }));
  let index = 0;
  for (const entry of log) {
    if (index >= steps.length) break;
    if (entry.outcome === "succeeded") {
      statuses[index] = { ...statuses[index]!, status: "succeeded" };
      index++;
    }
  }
  if (state === "succeeded") {
    for (let i = index; i < steps.length; i++) {
      statuses[i] = { ...statuses[i]!, status: "succeeded" };
    }
    return { statuses, position: steps.length };
  }
  if (state === "failed") {
    if (index < steps.length) {
      statuses[index] = { ...statuses[index]!, status: "failed" };
    }
    return { statuses, position: index };
  }
  if (state === "running" && index < steps.length) {
    statuses[index] = { ...statuses[index]!, status: "running" };
  }
  return { statuses, position: index };
}

function buildTimeline(
  deps: RunProjectionDependencies,
  createdAt: string,
  log: readonly AttemptLogEntry[],
  digest: string,
): RunTimelineEvent[] {
  const events: RunTimelineEvent[] = [{ at: createdAt, event: "run-created" }];
  const entry = deps.catalog.listEntries().find((e) => e.digest === digest);
  if (entry !== undefined) {
    const grant = deps.catalog.getTrustGrant(
      digest,
      entry.installationGeneration,
    );
    if (grant !== undefined) {
      events.push({
        at: grant.grantedAt,
        event: "trust-granted",
        detail: grant.operationId,
      });
    }
  }
  for (const attempt of log) {
    events.push({
      at: attempt.at,
      event: "attempt-settled",
      detail: attempt.outcome,
    });
  }
  // ponytail: per-Attempt Verdict events are not tied to their Attempt through
  // the Run Store Interface (the attempt log carries no artifact link), so
  // Verdicts are reached as outputs instead. Add Verdict timeline events when the
  // Store surfaces the attempt→version link.
  return events;
}

// --- entry selection -------------------------------------------------------

/** Select the installed Entry a launch names, mirroring `bundle-catalog`'s rule:
 *  an omitted version is the highest stable installed version; a prerelease must
 *  be named (#9, #49). */
export function selectRunEntry(
  catalog: Catalog,
  id: string,
  version: string | undefined,
): { entry: CatalogEntry } | { problem: Problem } {
  const matching = catalog.listEntries().filter((entry) => entry.id === id);
  if (matching.length === 0) return { problem: bundleNotInstalled(id) };
  if (version !== undefined) {
    const exact = matching.find((entry) => entry.version === version);
    return exact
      ? { entry: exact }
      : { problem: versionNotInstalled(id, version) };
  }
  const stable = matching
    .filter((entry) => semver.prerelease(entry.version) === null)
    .sort((a, b) => semver.rcompare(a.version, b.version));
  return stable.length > 0
    ? { entry: stable[0]! }
    : { problem: noStableVersion(id) };
}

// --- problems --------------------------------------------------------------

function bundleNotInstalled(id: string): Problem {
  return {
    code: "bundle-not-installed",
    explanation: `No Bundle with id ${id} is installed.`,
    remediation:
      "Run `secant bundle list` to see installed Bundles, then launch one by its id.",
    possibleEffects: "none",
    details: { id },
  };
}

function versionNotInstalled(id: string, version: string): Problem {
  return {
    code: "bundle-version-not-installed",
    explanation: `${id}@${version} is not installed.`,
    remediation:
      "Run `secant bundle list` to see the installed versions, then name one that is installed.",
    possibleEffects: "none",
    details: { id, version },
  };
}

function noStableVersion(id: string): Problem {
  return {
    code: "no-stable-version-installed",
    explanation: `Only prerelease versions of ${id} are installed; a prerelease must be named explicitly.`,
    remediation: "Run `secant run launch <id>@<version>` naming a prerelease.",
    possibleEffects: "none",
    details: { id },
  };
}

function runNotFound(runId: string): Problem {
  return {
    code: "run-not-found",
    explanation: `No Run ${runId} exists in this Workspace.`,
    remediation:
      "Launch a Run first, or check the Run id (it is printed when a Run is launched).",
    possibleEffects: "none",
    details: { runId },
  };
}

function runStoreDamaged(runId: string): Problem {
  return {
    code: "run-store-damaged",
    explanation: `Run ${runId} is recorded but its store could not be read.`,
    remediation:
      "The Run's canonical store is damaged; delete the Run and launch a fresh one.",
    possibleEffects: "unknown",
    details: { runId },
  };
}

export function bundleBytesMissingForRun(digest: string): Problem {
  return {
    code: "bundle-bytes-missing",
    explanation: `The Bundle for digest ${digest} is recorded as installed, but its stored bytes are missing.`,
    remediation:
      "Reinstall the Bundle to restore its bytes, then launch again.",
    possibleEffects: "none",
    details: { digest },
  };
}

export function bundleBytesCorruptForRun(
  digest: string,
  finding: string,
): Problem {
  return {
    code: "bundle-bytes-corrupt",
    explanation: `The Bundle for digest ${digest} is installed, but its stored bytes no longer validate (${finding}).`,
    remediation:
      "Reinstall the Bundle to restore intact bytes, then launch again.",
    possibleEffects: "none",
    details: { digest, finding },
  };
}
