import semver from "semver";
import type { Catalog, CatalogEntry } from "../catalog/catalog.js";
import { inspectBundle, type Budgets } from "../bundle/bundle.js";
import {
  flattenSteps,
  MAX_REVIEW_CHECKPOINT_INTERVAL,
  type Platform,
  type RepeatGroup,
  type RoutingNode,
  type Step,
} from "../workflow/workflow.js";
import type {
  AttemptLogEntry,
  MaterializationConflict,
  RunGroup,
  RunOwner,
} from "../run/store/store.js";
import type {
  Problem,
  RunCheckpointView,
  RunConflictView,
  RunOutputView,
  RunResult,
  RunSnapshot,
  RunStepProgress,
  RunStepStatus,
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
  const trackedState = context.state ?? record.state;
  const view = (
    owner: RunOwner | undefined,
    log: readonly AttemptLogEntry[],
    outputs: readonly RunOutputView[],
    conflicts: readonly MaterializationConflict[],
  ): RunResult => {
    // Derive progress and the `blocked` state from the Routing and the ordered
    // attempt log (ADR 0020, #84): a Repeat group loops, so a flat succeeded-
    // advances-one-Step mapping no longer identifies the current Step. `blocked`
    // is never stored, so it is re-derived here from the current Step Attempt —
    // needing the Verdict bindings, which only the owner can read. A persisted
    // `halted` (#88) passes through and marks its current Step `blocked`.
    const derivedRun = deriveRun(
      facts.routing,
      log,
      trackedState,
      runId,
      owner,
    );
    // The conflict resting the Run is the latest recorded one; earlier conflicts
    // stay on the timeline as history. It is surfaced only while `halted`.
    const active =
      derivedRun.state === "halted"
        ? conflicts[conflicts.length - 1]
        : undefined;
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
        state: derivedRun.state,
        progress: derivedRun.statuses,
        position: derivedRun.position,
        timeline: buildTimeline(
          deps,
          record.createdAt,
          log,
          facts.digest,
          derivedRun.iterationEvents,
          derivedRun.checkpoint,
          conflicts,
        ),
        outputs,
        ...(derivedRun.checkpoint !== undefined
          ? { checkpoint: derivedRun.checkpoint }
          : {}),
        ...(active !== undefined
          ? { conflict: conflictView(runId, active) }
          : {}),
      },
    };
  };

  const live = context.liveOwner;
  // Never acquire a fresh owner for a Run that is live in another process: every
  // `acquireRun` bumps the fencing epoch, which would fence — and so abort — the
  // process actually executing the Run. A read must never break a running Run, so
  // show the record-level snapshot instead (no attempt log or outputs from here).
  if (live === undefined && isLiveElsewhere(deps.runGroup, runId)) {
    return view(undefined, [], [], []);
  }
  const owner = live ?? deps.runGroup.acquireRun(runId);
  if (owner === undefined) {
    return { found: false, problem: runStoreDamaged(runId) };
  }
  try {
    return view(
      owner,
      owner.attemptLog(),
      collectOutputs(owner, facts.routing, runId),
      owner.materializationConflicts(),
    );
  } finally {
    if (live === undefined) owner.close();
  }
}

/** The client view of the conflict resting a Run `halted`: names the artifact and
 *  path, and references the diagnostic (read via `readResource`), never inlining
 *  its detail so the snapshot stays bounded (AC5). */
function conflictView(
  runId: string,
  conflict: MaterializationConflict,
): RunConflictView {
  return {
    artifactName: conflict.artifactName,
    path: conflict.path,
    reference: {
      runId,
      diagnosticId: conflict.diagnosticId,
      type: "diagnostic",
    },
  };
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

interface DerivedRun {
  /** The effective state, which may be the derived `blocked` (never stored). */
  readonly state: string;
  readonly statuses: RunStepProgress[];
  readonly position: number;
  /** One event per completed Repeat-group iteration, for the timeline. */
  readonly iterationEvents: readonly RunTimelineEvent[];
  /** The Review checkpoint facts, present only when the state derives to `blocked`. */
  readonly checkpoint?: RunCheckpointView;
}

/**
 * Derive per-Step progress, the effective Run state, the per-iteration timeline,
 * and the Review checkpoint from the Routing and the ordered attempt log (ADR
 * 0020, #84). A Repeat group loops, so a flat succeeded-advances-one-Step mapping
 * no longer identifies the current Step; and `blocked` is never stored, so it is
 * re-derived here from the current Step Attempt — which needs the `until` Verdict
 * binding, readable only through the owner.
 *
 * The attempt log carries no Step link, so iterations are reconstructed by
 * consuming attempts node by node: a Step consumes its `failed` retries then its
 * one terminal Attempt; a Repeat group consumes complete span-iterations. This is
 * exact when the Repeat group is the terminal reached node — every trailing
 * Attempt is one of its iterations — which a `blocked` Run always is, since the
 * block stops the walk. (ponytail: a group the walk has already passed with ≥1
 * iteration contributes no iteration events, because a precise mid-Routing count
 * needs the attempt→Step link the Store does not yet surface; a `succeeded` Run's
 * progress is taken from the terminal state, so this is only a timeline nicety.)
 */
function deriveRun(
  routing: readonly RoutingNode[],
  log: readonly AttemptLogEntry[],
  state: string,
  runId: string,
  owner: RunOwner | undefined,
): DerivedRun {
  const steps = flattenSteps(routing);
  const statuses: RunStepProgress[] = steps.map((step) => ({
    id: step.id,
    kind: step.kind,
    status: "pending",
  }));
  const flatIndex = new Map<Step, number>();
  steps.forEach((step, index) => flatIndex.set(step, index));
  const mark = (step: Step, status: RunStepStatus): void => {
    const index = flatIndex.get(step)!;
    statuses[index] = { ...statuses[index]!, status };
  };

  // A rested `succeeded` Run: every Step ran to completion. Progress is taken from
  // the terminal state; iteration events are counted only for a trailing group.
  if (state === "succeeded") {
    for (const step of steps) mark(step, "succeeded");
    return {
      state,
      statuses,
      position: steps.length,
      iterationEvents: trailingGroupIterations(routing, log),
    };
  }

  const iterationEvents: RunTimelineEvent[] = [];
  // The status of the Step the walk is currently paused at (log exhausted): a
  // failed Run's current Step failed; a running Run's is running; a `halted` Run's
  // (a Materialization conflict, #88) is blocked; a `created` Run has not started,
  // so its Steps stay pending.
  const stalledStatus: RunStepStatus =
    state === "failed"
      ? "failed"
      : state === "running"
        ? "running"
        : state === "halted"
          ? "blocked"
          : "pending";
  let cursor = 0;
  for (const node of routing) {
    if (!("repeat" in node)) {
      const result = consumeStep(log, cursor);
      cursor = result.next;
      if (!result.complete) {
        mark(node, stalledStatus);
        return {
          state,
          statuses,
          position: flatIndex.get(node)!,
          iterationEvents,
        };
      }
      mark(node, "succeeded");
      continue;
    }
    // A Repeat group: consume complete span-iterations until the log runs out.
    const span = node.repeat.steps;
    let iterations = 0;
    for (;;) {
      const iteration = consumeSpan(log, cursor, span);
      if (!iteration.complete) {
        // The log ran out mid-iteration: the group is the current node, paused at
        // `iteration.stalled`. Earlier span Steps of this iteration already ran.
        markSpanBefore(span, iteration.stalled, mark);
        mark(iteration.stalled, stalledStatus);
        return {
          state,
          statuses,
          position: flatIndex.get(iteration.stalled)!,
          iterationEvents,
        };
      }
      // A span that consumed no Attempts (a degenerate empty group Composition
      // rejects) would loop forever; stop rather than spin or mis-mark.
      if (iteration.next === cursor) break;
      cursor = iteration.next;
      iterations++;
      iterationEvents.push({
        at: iteration.at,
        event: "iteration",
        detail: String(iterations),
      });
      for (const spanStep of span) mark(spanStep, "succeeded");
      if (cursor >= log.length) {
        // No more Attempts: the group is the terminal reached node — derive the
        // block from its current (last) Step Attempt.
        return finishTerminalGroup(
          node.repeat,
          span,
          iterations,
          state,
          statuses,
          flatIndex,
          mark,
          iterationEvents,
          runId,
          owner,
          log,
        );
      }
      // More Attempts remain: the group passed and the walk moves on (greedy — see
      // the ponytail above; exact when the group is the terminal node).
    }
  }
  // Every node consumed cleanly with the log exhausted at a boundary: the Run is
  // between Steps (a transient running/created snapshot).
  return { state, statuses, position: steps.length, iterationEvents };
}

/** Consume one Step's Attempts from `cursor`: skip its `failed` retries, then its
 *  terminal `succeeded`. `complete` is false when the log runs out first (the Step
 *  is the current one). */
function consumeStep(
  log: readonly AttemptLogEntry[],
  cursor: number,
): { next: number; complete: boolean; at?: string } {
  let i = cursor;
  while (i < log.length) {
    const entry = log[i]!;
    i++;
    if (entry.outcome === "succeeded")
      return { next: i, complete: true, at: entry.at };
  }
  return { next: i, complete: false };
}

/** Consume one full span iteration (every span Step completing). `complete` is
 *  false, with the `stalled` Step, when the log runs out partway through. */
function consumeSpan(
  log: readonly AttemptLogEntry[],
  cursor: number,
  span: readonly Step[],
):
  | { complete: true; next: number; at: string }
  | { complete: false; stalled: Step; next: number } {
  let probe = cursor;
  let at = "";
  for (const spanStep of span) {
    const result = consumeStep(log, probe);
    if (!result.complete) {
      return { complete: false, stalled: spanStep, next: result.next };
    }
    probe = result.next;
    at = result.at ?? at;
  }
  // A non-empty span consumed every Step; an empty span (Composition rejects one)
  // consumes nothing, which `next === cursor` lets the caller detect and stop on.
  return { complete: true, next: probe, at };
}

/** Mark every span Step before `stalled` as succeeded (they ran this iteration). */
function markSpanBefore(
  span: readonly Step[],
  stalled: Step,
  mark: (step: Step, status: RunStepStatus) => void,
): void {
  for (const spanStep of span) {
    if (spanStep === stalled) return;
    mark(spanStep, "succeeded");
  }
}

/** Finish a Repeat group that is the terminal reached node: derive `blocked` when
 *  the review cadence is reached without a pass, else leave it running. */
function finishTerminalGroup(
  repeat: RepeatGroup["repeat"],
  span: readonly Step[],
  iterations: number,
  state: string,
  statuses: RunStepProgress[],
  flatIndex: Map<Step, number>,
  mark: (step: Step, status: RunStepStatus) => void,
  iterationEvents: readonly RunTimelineEvent[],
  runId: string,
  owner: RunOwner | undefined,
  log: readonly AttemptLogEntry[],
): DerivedRun {
  const current = span[span.length - 1]!;
  const position = flatIndex.get(current)!;
  const interval = Math.min(
    repeat.reviewCheckpoint.interval,
    MAX_REVIEW_CHECKPOINT_INTERVAL,
  );
  const versionId = owner?.currentVersion(repeat.until);
  const verdict =
    owner !== undefined && versionId !== undefined
      ? readVerdict(owner, versionId, repeat.until)
      : undefined;
  const passes = verdict === "pass";

  // Blocked: the cadence is reached, the Verdict still does not pass, and the Run
  // has not failed. The block is derived from the current Step Attempt.
  if (
    state !== "failed" &&
    !passes &&
    versionId !== undefined &&
    iterations >= interval
  ) {
    mark(current, "blocked");
    const lastAttempt = log[log.length - 1]!;
    const checkpoint: RunCheckpointView = {
      message: repeat.reviewCheckpoint.message,
      interval,
      completedIterations: iterations,
      latestVerdict: {
        name: repeat.until,
        // Normalize the value actually read (M2 Verdicts are pass/fail); this
        // branch already established it is not `pass`.
        value: verdict === "pass" ? "pass" : "fail",
        reference: {
          runId,
          artifactName: repeat.until,
          versionId,
          type: "verdict",
        },
      },
      gate: {
        runId,
        stepId: current.id,
        attemptId: lastAttempt.attemptId,
        shape: "approve-reject",
      },
    };
    return {
      state: "blocked",
      statuses,
      position,
      iterationEvents,
      checkpoint,
    };
  }

  // Not blocked: the loop is still short of its cadence (a live mid-loop snapshot),
  // or the Run failed on the last span Step.
  mark(current, state === "failed" ? "failed" : "running");
  return { state, statuses, position, iterationEvents };
}

/** Iteration events for a trailing Repeat group in a rested `succeeded` Run: every
 *  Attempt after the preceding nodes is one of the group's iterations. */
function trailingGroupIterations(
  routing: readonly RoutingNode[],
  log: readonly AttemptLogEntry[],
): RunTimelineEvent[] {
  const last = routing[routing.length - 1];
  if (last === undefined || !("repeat" in last)) return [];
  // Consume the preceding nodes to find where the group's Attempts begin.
  let cursor = 0;
  for (const node of routing.slice(0, -1)) {
    if ("repeat" in node) {
      for (;;) {
        const iteration = consumeSpan(log, cursor, node.repeat.steps);
        // Stop on a partial iteration or one that consumed nothing (an empty span).
        if (!iteration.complete || iteration.next === cursor) break;
        cursor = iteration.next;
        if (cursor >= log.length) break;
      }
    } else {
      cursor = consumeStep(log, cursor).next;
    }
  }
  const span = last.repeat.steps;
  const events: RunTimelineEvent[] = [];
  let iterations = 0;
  while (cursor < log.length) {
    const iteration = consumeSpan(log, cursor, span);
    if (!iteration.complete) break;
    cursor = iteration.next;
    iterations++;
    events.push({
      at: iteration.at,
      event: "iteration",
      detail: String(iterations),
    });
  }
  return events;
}

/** The `pass`/`fail` value of a Verdict at a version, or undefined if unreadable. */
function readVerdict(
  owner: RunOwner,
  versionId: string,
  name: string,
): string | undefined {
  const bytes = owner.readArtifact(versionId, name);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

function buildTimeline(
  deps: RunProjectionDependencies,
  createdAt: string,
  log: readonly AttemptLogEntry[],
  digest: string,
  iterationEvents: readonly RunTimelineEvent[],
  checkpoint: RunCheckpointView | undefined,
  conflicts: readonly MaterializationConflict[],
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
  // Each completed Repeat-group iteration, then the block when the Run rests at a
  // Review checkpoint (#84). ponytail: per-Attempt Verdict *values* still are not
  // tied to their Attempt through the Store Interface (no attempt→version link),
  // so the Verdict is reached as an output; add Verdict values here when it lands.
  for (const iteration of iterationEvents) events.push(iteration);
  if (checkpoint !== undefined) {
    events.push({
      at: log[log.length - 1]?.at ?? createdAt,
      event: "checkpoint-blocked",
      detail: String(checkpoint.completedIterations),
    });
  }
  // Each conflict names its declared Workspace path (AC5). Appended after the
  // Attempt events — a conflict follows the Steps that completed before it.
  for (const conflict of conflicts) {
    events.push({
      at: conflict.at,
      event: "materialization-conflict",
      detail: conflict.path,
    });
  }
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
