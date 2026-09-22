import type { Catalog, CatalogEntry } from "../catalog/catalog.js";
import { inspectBundle, type Budgets } from "../bundle/bundle.js";
import { selectInstalledEntry } from "./entry-selection.js";
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
  GateAnswerRecord,
  HarnessSessionRecord,
  MaterializationConflict,
  PendingGateRecord,
  RunGroup,
  RunListing,
  RunOwner,
  TranscriptEntryRecord,
  TurnEventRecord,
  TurnRecord,
} from "../run/store/store.js";
import { interactiveStepAttemptId } from "../run/execution/execution.js";
import type {
  ActionOffer,
  Problem,
  RunCheckpointView,
  RunConflictView,
  RunGateReference,
  RunOutputView,
  RunPendingGateView,
  RunResult,
  RunSessionView,
  RunSnapshot,
  RunStateName,
  RunStepProgress,
  RunStepStatus,
  RunTimelineEvent,
  RunTimelineKind,
  RunTranscriptEntryView,
  RunTurnKind,
  RunView,
} from "./projection-port.js";
import { RUN_TIMELINE_TRUNCATION_MARKER } from "./projection-port.js";
import {
  bundleBytesCorrupt,
  bundleBytesMissing,
  runNotFound,
  runStoreDamaged,
} from "./problems.js";

/** The bound Artifact name a Human Gate answer publishes to (#85), so the answer
 *  reads back through `run show`/`run read` like any output. The latest answer
 *  wins the binding; every version stays retained in the Artifact store. */
export const GATE_ANSWER_ARTIFACT = "human-gate-answer";

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

export interface RunSteerCapability {
  readonly available: boolean;
  readonly evidence: string;
}

/** How the join reaches a Run's canonical record and outputs. When the Run is
 *  live in this process the launch use case passes its held owner, so a snapshot
 *  read never fences the executing owner; otherwise the join acquires a
 *  short-lived owner and closes it. */
export interface RunReadContext {
  readonly facts?: RunFacts; // present for a Run launched in this process
  readonly liveOwner?: RunOwner; // present while live in this process
  readonly state?: string; // the in-memory latest state while tracked
  readonly steer?: RunSteerCapability; // current prepared profile evidence
  readonly problem?: Problem; // transient selected-Harness preparation refusal
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
  const selectedHarness = record.selectedHarness;
  const requestedModel = record.requestedModel;
  // Legality of cancel/delete is decided here, inside Secant (#87): an owned Run
  // can be cancelled; an unowned resting or terminal Run can be deleted. Read from the coordination record, which
  // is the same whether the Run is live in this process or another.
  const listing = runListing(deps.runGroup, runId);
  const isLive = listing?.live === true;
  const liveElsewhere = isLive && listing?.ownedByThisProcess === false;
  const view = (
    owner: RunOwner | undefined,
    log: readonly AttemptLogEntry[],
    outputs: readonly RunOutputView[],
    conflicts: readonly MaterializationConflict[],
    gateAnswers: readonly GateAnswerRecord[],
  ): RunResult => {
    // Derive progress and the `blocked` state from the Routing and the ordered
    // attempt log (ADR 0020, #84): a Repeat group loops, so a flat succeeded-
    // advances-one-Step mapping no longer identifies the current Step. Stored
    // `blocked` preserves reconciliation; the checkpoint facts are re-derived from
    // the current Step Attempt and Verdict binding. A persisted
    // `halted` (#88) passes through and marks its current Step `blocked`.
    const derivedRun = deriveRun(
      facts.routing,
      log,
      trackedState,
      runId,
      owner,
      gateAnswers,
    );
    // The conflict resting the Run is the latest recorded one; earlier conflicts
    // stay on the timeline as history. It is surfaced only while `halted`.
    const active =
      derivedRun.state === "halted"
        ? conflicts[conflicts.length - 1]
        : undefined;
    // Harness Turn records (#116): the durable view of every Turn this Run ran —
    // its timeline entries, per-Session availability, effective model, and readable
    // transcript. Empty for a Command-only Run (and for a Run live elsewhere, read
    // without an owner), so the frozen `--json` stays unchanged for those.
    const turns = owner?.turns() ?? [];
    // The live Turn a Turn-scoped control targets (#118): the one admitted Turn with
    // no settled result, present only while the Run is live in this process (a Run
    // live elsewhere is read without an owner, so `turns` is empty and no control is
    // offered — resuming it is the only remote action).
    const liveTurn = !liveElsewhere
      ? turns.find((turn) => turn.resultKind === undefined)
      : undefined;
    // The interactive-agent Step the Run rests `blocked` at, at a Turn boundary
    // (#122): no derived checkpoint, no authored gate, and no live Turn. The block is
    // read from the current Step's kind — the same signal the TUI blocked-basis uses —
    // so it needs no durable gate record.
    const current = derivedRun.statuses[derivedRun.position];
    const interactiveStep =
      !liveElsewhere &&
      derivedRun.state === "blocked" &&
      derivedRun.checkpoint === undefined &&
      derivedRun.pendingGate === undefined &&
      liveTurn === undefined &&
      current?.kind === "interactive-agent"
        ? current
        : undefined;
    const turnEvents = owner?.turnEvents() ?? [];
    const sessions = owner?.harnessSessions() ?? [];
    const harnessEvidence = owner?.harnessEvidence();
    const effectiveModel = harnessEvidence?.effectiveModel;
    // The normalized Harness identity of the latest Agent-step Attempt (#125): durable
    // profile facts read back through the owner, empty for a Command-only Run (and for a
    // Run live elsewhere, read without an owner), so the frozen `--json` stays unchanged
    // for those.
    const harnessIdentity = harnessEvidence?.identity;
    const steer = context.steer ?? harnessIdentity?.steer;
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
        problem: context.problem,
        liveness: runLiveness(listing),
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
          gateAnswers,
          turns,
          turnEvents,
          facts.routing,
        ),
        outputs,
        ...(derivedRun.checkpoint !== undefined
          ? { checkpoint: derivedRun.checkpoint }
          : {}),
        ...(derivedRun.pendingGate !== undefined
          ? { pendingGate: derivedRun.pendingGate }
          : {}),
        // Typed Action Offers, legality decided inside Secant (#85, #86, #87, #98,
        // #108): the answer-human-gate offer appears only while blocked at a gate
        // (a derived Review checkpoint or an authored gate); resume-run only while
        // resting halted or failed; cancel is offered while the Run is live or
        // `blocked` (a blocked Run has resumable work, so it is cancelled rather than
        // deleted — A6), delete only otherwise (mutually exclusive).
        actionOffers: [
          ...(!liveElsewhere && derivedRun.checkpoint !== undefined
            ? [answerHumanGateOffer(derivedRun.checkpoint.gate, false)]
            : !liveElsewhere && derivedRun.pendingGate !== undefined
              ? [answerHumanGateOffer(derivedRun.pendingGate.gate, true)]
              : []),
          ...(liveElsewhere &&
          listing?.ownerPid !== undefined &&
          derivedRun.state !== "succeeded" &&
          derivedRun.state !== "cancelled"
            ? [resumeRunOffer(runId, derivedRun.state, listing.ownerPid)]
            : derivedRun.state === "halted" || derivedRun.state === "failed"
              ? [resumeRunOffer(runId, derivedRun.state)]
              : []),
          // Turn-scoped controls (#118, #148): while a Turn is live in this process, a
          // user can interrupt it (rests the Run `halted`, resumable) without
          // cancelling the Run, and steer it when the prepared profile declares native
          // same-Turn guidance. The steer Offer is discriminated on that profile
          // evidence (live first, then persisted with the Attempt) — a Harness with
          // steer (Codex) offers it available, one without (Claude Code) offers it
          // unavailable with the evidence, never Adapter-specific prose here.
          ...(isLive && liveTurn !== undefined
            ? [
                interruptTurnOffer(runId, liveTurn.turnId),
                ...(steer !== undefined
                  ? [steerTurnOffer(runId, liveTurn.turnId, steer)]
                  : []),
              ]
            : []),
          // Interactive-agent turn-taking (#122): while the Run rests `blocked` at an
          // interactive-agent Step at a Turn boundary (no gate, no live Turn), the
          // human can send the next Turn or end the Step. End Step is offered only at
          // a boundary — a live Turn suppresses both, exactly when interrupt is offered.
          ...(interactiveStep !== undefined
            ? [
                sendInteractiveTurnOffer(runId, interactiveStep.id),
                endInteractiveStepOffer(runId, interactiveStep.id),
              ]
            : []),
          isLive || derivedRun.state === "blocked"
            ? cancelRunOffer(runId)
            : deleteRunOffer(runId),
        ],
        ...(active !== undefined
          ? { conflict: conflictView(runId, active) }
          : {}),
        ...(sessions.length > 0
          ? {
              sessions: sessions.map((s) =>
                sessionView(
                  runId,
                  s,
                  (owner?.transcriptPage({ session: s.session, limit: 1 })
                    .entries.length ?? 0) > 0,
                ),
              ),
            }
          : {}),
        ...(effectiveModel !== undefined ? { effectiveModel } : {}),
        ...(requestedModel !== undefined ? { requestedModel } : {}),
        ...(selectedHarness !== undefined ? { selectedHarness } : {}),
        ...(harnessIdentity !== undefined
          ? {
              harness: {
                name: harnessIdentity.harness,
                executable: harnessIdentity.executable,
                executableVersion: harnessIdentity.executableVersion,
              },
            }
          : {}),
        ...(turns.length > 0 ? { turnPosition: turns.length } : {}),
      },
    };
  };

  const live = context.liveOwner;
  // Never acquire a fresh owner for a Run that is live in another process: every
  // `acquireRun` bumps the fencing epoch, which would fence — and so abort — the
  // process actually executing the Run. A read must never break a running Run, so
  // show the record-level snapshot instead (no attempt log or outputs from here).
  if (live === undefined && liveElsewhere) {
    return view(undefined, [], [], [], []);
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
      owner.gateAnswers(),
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

function runListing(runGroup: RunGroup, runId: string): RunListing | undefined {
  return runGroup.listRuns().find((run) => run.runId === runId);
}

function runLiveness(listing: RunListing | undefined): RunView["liveness"] {
  if (listing?.live !== true || listing.ownerPid === undefined) {
    return { state: "not-live" };
  }
  return listing.ownedByThisProcess
    ? { state: "live-here", ownerPid: listing.ownerPid }
    : { state: "live-elsewhere", ownerPid: listing.ownerPid };
}

/** Re-derive the routing and Bundle facts from the pinned Snapshot's stored
 *  bytes, translating a missing or corrupt managed store into a typed Problem. */
export function deriveRunFacts(
  deps: RunProjectionDependencies,
  digest: string,
): { facts: RunFacts } | { problem: Problem } {
  const bytes = deps.catalog.readManagedBytes(digest);
  if (bytes === undefined)
    return { problem: bundleBytesMissing({ digest: digest }) };
  const outcome = inspectBundle(bytes, deps.budgets, false);
  if (!outcome.ok) {
    return {
      problem: bundleBytesCorrupt({ digest: digest }, outcome.finding.code),
    };
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
  // A durable Human Gate answer (#85) is a bound `text` Artifact not declared in
  // the Routing; surface it as an output so it reads back through run show/read.
  const answerVersion = owner.currentVersion(GATE_ANSWER_ARTIFACT);
  if (answerVersion !== undefined) declared.set(GATE_ANSWER_ARTIFACT, "text");
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

/** The `resume-run` offer for a resting Run: names what resume does from the
 *  current state so a client presents it without re-deriving the model (#86). */
function resumeRunOffer(
  runId: string,
  state: RunStateName,
  takeoverOwnerPid?: number,
): ActionOffer {
  const offer: {
    action: "resume-run";
    runId: string;
    consequence: string;
    takeover?: { ownerPid: number };
  } = {
    action: "resume-run",
    runId,
    consequence:
      takeoverOwnerPid !== undefined
        ? `take over from process ${takeoverOwnerPid} and continue the Run.`
        : state === "failed"
          ? "resume: reset this Step's attempt and iteration bounds and grant another try."
          : "resume: continue from the Step the Run stopped at.",
  };
  if (takeoverOwnerPid !== undefined) {
    offer.takeover = { ownerPid: takeoverOwnerPid };
  }
  return offer;
}

/** The `answer-human-gate` offer for a blocked Run: names the consequence of each
 *  answer so a client presents them without re-deriving the model (#85). */
/** The `run` Projection view of an authored pending Human Gate (#108): the durable
 *  record's message and free-text output, plus the exact Gate reference a client
 *  answers against (the producing Attempt id). */
function pendingGateView(
  runId: string,
  pending: PendingGateRecord,
): RunPendingGateView {
  return {
    gate: {
      runId,
      stepId: pending.stepId,
      attemptId: pending.attemptId,
      shape: pending.shape,
    },
    message: pending.message,
    ...(pending.outputArtifactName !== undefined
      ? { outputArtifactName: pending.outputArtifactName }
      : {}),
  };
}

function answerHumanGateOffer(
  gate: RunGateReference,
  authored: boolean,
): ActionOffer {
  return {
    action: "answer-human-gate",
    gate,
    basis: "durable Human Gate",
    // An authored gate approves/advances a single pause; only a derived Review
    // checkpoint grants an interval of the Repeat cadence (#108).
    continueConsequence: authored
      ? "approve: advance the Run past the gate."
      : "continue: grant one more review interval and resume the Run.",
    stopConsequence: authored
      ? "reject: end the Run failed, keeping its history and Artifacts."
      : "stop: end the Run failed, keeping its history and Artifacts.",
    ...(gate.shape === "free-text"
      ? {
          textConsequence:
            "text: publish the answer as the gate's output and resume the Run.",
        }
      : {}),
  };
}

/** The `send-interactive-turn` offer for a Run blocked at an interactive-agent Step
 *  at a Turn boundary (#122). */
function sendInteractiveTurnOffer(runId: string, stepId: string): ActionOffer {
  return {
    action: "send-interactive-turn",
    runId,
    stepId,
    basis: "interactive Turn",
    consequence:
      "send the typed text as one human Turn in the Step's Session; the Run stays blocked for the next Turn.",
  };
}

/** The `end-interactive-step` offer for a Run blocked at an interactive-agent Step
 *  at a Turn boundary (#122): offered only when it can be taken (no live Turn). */
function endInteractiveStepOffer(runId: string, stepId: string): ActionOffer {
  return {
    action: "end-interactive-step",
    runId,
    stepId,
    consequence:
      "end the interactive Step succeeded and advance the Run; the following Step reuses the same Session.",
  };
}

/** The `cancel-run` offer for a live Run (#87). */
function cancelRunOffer(runId: string): ActionOffer {
  return {
    action: "cancel-run",
    runId,
    consequence:
      "end the live Run cancelled, stopping execution and keeping its history and Artifacts.",
  };
}

/** The `interrupt-turn` offer for a Run with a live Turn (#118): it carries the
 *  live Turn's id so a control targets exactly that generation. */
function interruptTurnOffer(runId: string, turnId: string): ActionOffer {
  return {
    action: "interrupt-turn",
    runId,
    turnId,
    consequence:
      "stop the live Turn and rest the Run halted (resumable), keeping its history.",
  };
}

/** The `steer-turn` offer for a live Turn (#118, #148), discriminated on the
 *  prepared Harness profile's steer evidence: `available` carries the live turnId a
 *  client submits against; unavailable carries the evidence as its reason. */
function steerTurnOffer(
  runId: string,
  turnId: string,
  steer: RunSteerCapability,
): ActionOffer {
  return steer.available
    ? {
        action: "steer-turn",
        runId,
        turnId,
        available: true,
        consequence:
          "send same-Turn guidance to the running agent without ending the Turn.",
      }
    : {
        action: "steer-turn",
        runId,
        turnId,
        available: false,
        reason: steer.evidence,
      };
}

/** The `delete-run` offer for a resting or terminal Run (#87). */
function deleteRunOffer(runId: string): ActionOffer {
  return {
    action: "delete-run",
    runId,
    consequence:
      "remove the Run and its stored history and Artifacts from disk.",
  };
}

/** Map a stored/tracked canonical state to the client vocabulary (#98 A7). The
 *  retired `created` reads as `running` — a launched Run is observed running from
 *  the moment it is admitted — and every other stored state is already one of
 *  RunStateName. */
export function toRunState(state: string): RunStateName {
  switch (state) {
    case "running":
    case "blocked":
    case "succeeded":
    case "failed":
    case "halted":
    case "cancelled":
      return state;
    default:
      return "running";
  }
}

export interface DerivedRun {
  /** The effective state, including the `blocked` a checkpoint pause derives from
   *  the attempt log here (execution also stores `blocked` durably, so a killed Run
   *  reconciles blocked; this derivation supplies the checkpoint facts). */
  readonly state: RunStateName;
  readonly statuses: RunStepProgress[];
  readonly position: number;
  /** One event per completed Repeat-group iteration, for the timeline. */
  readonly iterationEvents: readonly RunTimelineEvent[];
  /** The Review checkpoint facts, present only when the state derives to `blocked`
   *  at a derived Review checkpoint. */
  readonly checkpoint?: RunCheckpointView;
  /** The authored Human Gate facts, present only when the state is `blocked` at an
   *  authored `human-gate` Step (#108). A blocked Run derives exactly one of
   *  `checkpoint` or `pendingGate`. */
  readonly pendingGate?: RunPendingGateView;
}

/**
 * Derive per-Step progress, the effective Run state, the per-iteration timeline,
 * and the Review checkpoint from the Routing and the ordered attempt log (ADR
 * 0020, #84). A Repeat group loops, so a flat succeeded-advances-one-Step mapping
 * no longer identifies the current Step; and the `blocked` checkpoint facts are
 * re-derived here from the current Step Attempt — which needs the `until` Verdict
 * binding, readable only through the owner. Execution also stores `blocked`
 * durably (a killed Run reconciles blocked), but its checkpoint facts still come
 * from this derivation, not the stored state.
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
export function deriveRun(
  routing: readonly RoutingNode[],
  log: readonly AttemptLogEntry[],
  state: string,
  runId: string,
  owner: RunOwner | undefined,
  gateAnswers: readonly GateAnswerRecord[],
): DerivedRun {
  // The offset the derived checkpoint count and the block decision reset from:
  // the latest grant's cumulative iteration count (#85). Zero before any grant,
  // so the first block still reports the full interval.
  const grantOffset =
    gateAnswers.length === 0
      ? 0
      : gateAnswers[gateAnswers.length - 1]!.iterationsAtGrant;
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
      state: toRunState(state),
      statuses,
      position: steps.length,
      iterationEvents: trailingGroupIterations(routing, log),
    };
  }

  const iterationEvents: RunTimelineEvent[] = [];
  // The status of the Step the walk is currently paused at (log exhausted): a
  // failed Run's current Step failed; a running Run's is running; a `halted` Run's
  // (a Materialization conflict, #88) or a durably `blocked` Run's (an authored
  // Human Gate whose facts we cannot read here because the owner is absent — a Run
  // live in another process, #108) current Step is blocked; a `created` Run has not
  // started, so its Steps stay pending.
  const stalledStatus: RunStepStatus =
    state === "failed"
      ? "failed"
      : state === "running"
        ? "running"
        : state === "halted" || state === "blocked"
          ? "blocked"
          : "pending";
  let cursor = 0;
  for (const node of routing) {
    if (!("repeat" in node)) {
      const result = consumeStep(log, cursor);
      cursor = result.next;
      if (!result.complete) {
        // An authored Human Gate the walk paused at: the Run rests `blocked`
        // durably (a pending_gate record whose producing Attempt has not settled),
        // distinct from a derived Review checkpoint (#108). Its facts come from the
        // durable record, read through the owner.
        const pending =
          node.kind === "human-gate" ? owner?.pendingGate() : undefined;
        if (pending !== undefined && pending.stepId === node.id) {
          mark(node, "blocked");
          return {
            state: "blocked",
            statuses,
            position: flatIndex.get(node)!,
            iterationEvents,
            pendingGate: pendingGateView(runId, pending),
          };
        }
        mark(node, stalledStatus);
        return {
          state: toRunState(state),
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
        // (An authored Human Gate cannot appear in a Repeat span — the Composition
        // check rejects that, #108 — so the only stall here is a Step's own pause.)
        markSpanBefore(span, iteration.stalled, mark);
        mark(iteration.stalled, stalledStatus);
        return {
          state: toRunState(state),
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
        // A passing Verdict ends the group even when the next node has not settled
        // an Attempt yet. This is the normal shape when that node is an authored
        // Human Gate: its durable pending-gate record exists, but it deliberately
        // has no attempt-log entry until answered. Advance so the next node can
        // project that gate instead of misreporting the deciding Command as live.
        const versionId = owner?.currentVersion(node.repeat.until);
        if (
          owner !== undefined &&
          versionId !== undefined &&
          readVerdict(owner, versionId, node.repeat.until) === "pass"
        ) {
          break;
        }
        // No more Attempts: the group is the terminal reached node — derive the
        // block from its current (last) Step Attempt.
        return finishTerminalGroup(
          node.repeat,
          span,
          iterations,
          grantOffset,
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
  // between Steps (a transient running snapshot).
  return {
    state: toRunState(state),
    statuses,
    position: steps.length,
    iterationEvents,
  };
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
  grantOffset: number,
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
  // Iterations since the last grant: a `continue` grant resets the count, so one
  // grant buys exactly one more interval (ADR 0020, #85). Before any grant the
  // offset is zero, so this is the full iteration count.
  const sinceGrant = iterations - grantOffset;
  const versionId = owner?.currentVersion(repeat.until);
  const verdict =
    owner !== undefined && versionId !== undefined
      ? readVerdict(owner, versionId, repeat.until)
      : undefined;
  const passes = verdict === "pass";

  // Blocked: the cadence is reached *since the last grant*, the Verdict still does
  // not pass, and the Run has not failed. The block is derived from the current
  // Step Attempt.
  if (
    state !== "failed" &&
    !passes &&
    versionId !== undefined &&
    sinceGrant >= interval
  ) {
    mark(current, "blocked");
    const lastAttempt = log[log.length - 1]!;
    const checkpoint: RunCheckpointView = {
      message: repeat.reviewCheckpoint.message,
      interval,
      completedIterations: sinceGrant,
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
  return { state: toRunState(state), statuses, position, iterationEvents };
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

/** Narrow a stored Session availability to the client union, defaulting an
 *  unrecognized value to `unusable` (the safe read at the ingress, D7). A Session
 *  with a recorded transcript advertises its typed `page`/`export` References
 *  (#124), reached through `readResource`; the bytes are never inlined here. */
function sessionView(
  runId: string,
  record: HarnessSessionRecord,
  hasTranscript: boolean,
): RunSessionView {
  const availability =
    record.availability === "open" ||
    record.availability === "detached" ||
    record.availability === "unusable"
      ? record.availability
      : "unusable";
  return {
    session: record.session,
    availability,
    ...(hasTranscript
      ? {
          transcriptPage: {
            runId,
            session: record.session,
            type: "transcript-page",
          },
          transcriptExport: {
            runId,
            session: record.session,
            type: "transcript-export",
          },
        }
      : {}),
  };
}

/** Narrow a stored Turn kind to the client union, or undefined when it is absent
 *  (a legacy row) or unrecognized — the safe truthful read at the ingress (D7): an
 *  unknown kind is omitted, never coerced to a guess. */
function toTurnKind(kind: string | undefined): RunTurnKind | undefined {
  return kind === "agent" || kind === "interactive-agent" ? kind : undefined;
}

/** Narrow a stored transcript entry to the client view. Shared with the
 *  transcript-resource resolver so page/export output matches the inline view. */
export function transcriptView(
  record: TranscriptEntryRecord,
): RunTranscriptEntryView {
  return {
    session: record.session,
    role: record.role === "assistant" ? "assistant" : "user",
    content: record.content,
  };
}

/** A one-line, capped detail for a timeline entry drawn from possibly-multiline
 *  content, so `run show`'s per-line timeline stays legible. */
const TIMELINE_DETAIL_LIMIT = 160;

function timelineDetail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= TIMELINE_DETAIL_LIMIT) return flat;
  const contentLimit =
    TIMELINE_DETAIL_LIMIT - RUN_TIMELINE_TRUNCATION_MARKER.length - 1;
  return `${flat.slice(0, contentLimit)} ${RUN_TIMELINE_TRUNCATION_MARKER}`;
}

/** The turn-event timeline entries for one Turn's normalized durable events. */
function turnEventEntry(event: TurnEventRecord): RunTimelineEvent | undefined {
  if (event.kind === "assistant-content") {
    const content = safeField(event.payload, "content");
    return {
      at: event.at,
      event: "assistant-content",
      detail: timelineDetail(content ?? ""),
    };
  }
  if (event.kind === "tool-activity") {
    const tool = safeField(event.payload, "tool") ?? "tool";
    const phase = safeField(event.payload, "phase") ?? "";
    return {
      at: event.at,
      event: "tool-activity",
      detail: `${tool} ${phase}`.trim(),
    };
  }
  // Approval Harness Request lifecycle (#117): the raised request names its tool
  // and serialized input; the answer names who answered and the decision; the
  // expiry names the request. Durable history — the request itself is never stored.
  if (event.kind === "request-raised") {
    const tool = safeField(event.payload, "tool") ?? "tool";
    const input = safeField(event.payload, "input") ?? "";
    return {
      at: event.at,
      event: "request-raised",
      detail: timelineDetail(`${tool} ${input}`),
    };
  }
  if (event.kind === "request-answered") {
    const by = safeField(event.payload, "by");
    const decision = safeField(event.payload, "decision");
    const who =
      by === "client-policy"
        ? "answered by client policy"
        : by === "human"
          ? "answered by human"
          : "answered";
    return {
      at: event.at,
      event: "request-answered",
      detail: decision !== undefined ? `${who} (${decision})` : who,
    };
  }
  if (event.kind === "request-expired") {
    const requestId = safeField(event.payload, "requestId");
    return {
      at: event.at,
      event: "request-expired",
      ...(requestId !== undefined ? { detail: requestId } : {}),
    };
  }
  return undefined;
}

/** Read one string field from a JSON payload, or undefined on any parse fault. */
function safeField(payload: string, field: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed !== null && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === "string") return value;
    }
  } catch {
    // A malformed payload contributes no detail rather than throwing the read.
  }
  return undefined;
}

function buildTimeline(
  deps: RunProjectionDependencies,
  createdAt: string,
  log: readonly AttemptLogEntry[],
  digest: string,
  iterationEvents: readonly RunTimelineEvent[],
  checkpoint: RunCheckpointView | undefined,
  conflicts: readonly MaterializationConflict[],
  gateAnswers: readonly GateAnswerRecord[],
  turns: readonly TurnRecord[],
  turnEvents: readonly TurnEventRecord[],
  routing: readonly RoutingNode[],
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
  const interactiveEndAttempts = new Set(
    flattenSteps(routing)
      .filter((step) => step.kind === "interactive-agent")
      .map((step) => interactiveStepAttemptId(step.id)),
  );
  for (const attempt of log) {
    events.push({
      at: attempt.at,
      event: interactiveEndAttempts.has(attempt.attemptId)
        ? "interactive-step-ended"
        : "attempt-settled",
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
  // Each durable Human Gate answer, in the order it was recorded (#85), so the
  // grant/stop history stays readable after the Run resumes or ends.
  for (const answer of gateAnswers) {
    events.push({
      at: answer.at,
      event: "gate-answered",
      detail: answer.answer,
    });
  }
  // Each conflict names its declared Workspace path (AC5).
  for (const conflict of conflicts) {
    events.push({
      at: conflict.at,
      event: "materialization-conflict",
      detail: conflict.path,
    });
  }
  // Each Harness Turn (#116): admitted (naming its Session), then — once settled —
  // its result kind. Each carries its Crucible Turn kind (#126), narrowed at this
  // read ingress (D7) so a client labels reopened Agent and Interactive Turns
  // without inferring from `progress[position]`; a legacy row with no kind omits it.
  // The authoritative assistant content and tool activity in between come from the
  // normalized durable events.
  for (const turn of turns) {
    const turnKind = toTurnKind(turn.kind);
    const kindField = turnKind !== undefined ? { turnKind } : {};
    events.push({
      at: turn.admittedAt,
      event: "turn-started",
      detail: turn.session,
      ...kindField,
    });
    if (turn.settledAt !== undefined && turn.resultKind !== undefined) {
      events.push({
        at: turn.settledAt,
        event: "turn-settled",
        detail: turn.resultKind,
        ...kindField,
      });
    }
  }
  for (const turnEvent of turnEvents) {
    const entry = turnEventEntry(turnEvent);
    if (entry !== undefined) events.push(entry);
  }
  // Order the timeline by `at` (ISO 8601 sorts lexicographically), category as the
  // tiebreak so events at the same instant keep a stable, meaningful order (#98 A2).
  // Sorting by time — rather than emitting category by category — means a later
  // Attempt never reorders the events that preceded it.
  return events.sort((a, b) =>
    a.at < b.at
      ? -1
      : a.at > b.at
        ? 1
        : TIMELINE_CATEGORY_RANK[a.event] - TIMELINE_CATEGORY_RANK[b.event],
  );
}

/** The tiebreak order for timeline events sharing an `at` (#98 A2): the same
 *  category order `buildTimeline` emits in, so equal-instant events read run-created
 *  → trust → attempt → iteration → checkpoint → gate-answer → conflict. */
const TIMELINE_CATEGORY_RANK: Record<RunTimelineKind, number> = {
  "run-created": 0,
  "trust-granted": 1,
  // A Turn's own events sort before the Attempt that settles after it, so an
  // equal-instant ordering reads start → content → tool → settled → attempt.
  "turn-started": 2,
  "assistant-content": 3,
  "tool-activity": 4,
  // An approval request's lifecycle sorts between tool activity and the Turn's
  // settle, in raise → answer → expire order for an equal instant (#117).
  "request-raised": 5,
  "request-answered": 6,
  "request-expired": 7,
  "turn-settled": 8,
  "interactive-step-ended": 9,
  "attempt-settled": 10,
  iteration: 11,
  "checkpoint-blocked": 12,
  "gate-answered": 13,
  "materialization-conflict": 14,
};

// --- entry selection -------------------------------------------------------

/** Select the installed Entry a launch names, through the one selector shared with
 *  the Bundle-catalog focus join (#98 A18): an omitted version is the highest stable
 *  installed version; a prerelease must be named (#9, #49). */
export function selectRunEntry(
  catalog: Catalog,
  id: string,
  version: string | undefined,
): { entry: CatalogEntry } | { problem: Problem } {
  return selectInstalledEntry(catalog.listEntries(), id, version);
}
