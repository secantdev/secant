import { z } from "zod";
import {
  DEFAULT_BUDGETS,
  inspectBundle,
  type Budgets,
} from "../bundle/bundle.js";
import type { Catalog } from "../catalog/catalog.js";
import type { ClaudeCodeDiscovery } from "../harness/harness.js";
import {
  flattenSteps,
  routingNeedsHarness,
  type AgentStep,
  type AuthoredManifest,
  type Platform,
  type RoutingNode,
} from "../workflow/workflow.js";
import {
  interactiveStepAttemptId,
  type RequestChannel,
  type RunReport,
  RUN_CANCEL_ABORT as CANCEL_ABORT,
  INTERRUPT_TURN_ABORT,
  SIGNAL_ABORT,
} from "../run/execution/execution.js";
import type {
  RunGroup,
  RunOwner,
  RunRecord,
  SelectedHarnessId,
} from "../run/store/store.js";
import {
  focusSnapshot,
  listSnapshot,
  type BundleCatalogDependencies,
} from "./bundle-catalog.js";
import type { BundleManagement } from "./bundle-management.js";
import { createBundleManagement } from "./build-bundle.js";
import {
  deriveRun,
  deriveRunFacts,
  GATE_ANSWER_ARTIFACT,
  runSnapshot,
  selectRunEntry,
  type RunFacts,
  type RunProjectionDependencies,
  type RunSteerCapability,
} from "./run-projection.js";
import {
  bundleBytesCorrupt,
  bundleBytesMissing,
  bundleTrustRequired,
  gateShapeMismatch,
  gateStale,
  harnessRequestExpired,
  harnessRequestIndeterminate,
  harnessRequestRejected,
  harnessRequestStale,
  interactiveStepMidTurn,
  interactiveStepNotActive,
  interactiveTurnBlank,
  interactiveTurnBusy,
  operationIdReused,
  operationNotFound,
  pathNotFound,
  runDiagnosticMissing,
  runExecutionFault,
  runIsLive,
  runLiveElsewhere,
  runNotBlocked,
  runNotFound,
  runNotLive,
  runNotResumable,
  runOutputMissing,
  runStoreDamaged,
  runSupportUnavailable,
  steerUnavailable,
  trustDigestMismatch,
  turnControlRejected,
  workspaceNotApproved,
} from "./problems.js";
import { UpdateStream } from "./update-stream.js";
import { listRunsSnapshot } from "./run-list.js";
import { readTranscriptResource } from "./transcript-resource.js";
// Re-exported through the Module entry so clients and tests reach the page size
// without importing the internal resolver file (module-boundaries).
export { TRANSCRIPT_PAGE_SIZE } from "./transcript-resource.js";
import { preflight } from "./preflight.js";
import { createLiveOverlay, type LiveOverlayState } from "./live-overlay.js";
import {
  answerHarnessRequestReplayKey,
  answerReplayKey,
  cancelReplayKey,
  canonicalizeWorkspacePath,
  deleteReplayKey,
  endInteractiveStepReplayKey,
  interruptTurnReplayKey,
  launchReplayKey,
  resumeReplayKey,
  sendInteractiveTurnReplayKey,
  steerTurnReplayKey,
} from "./replay-keys.js";
export { canonicalizeWorkspacePath } from "./replay-keys.js";
import type {
  AnswerHarnessRequestInput,
  AnswerHumanGateInput,
  BundleCatalogSnapshot,
  BundleFocusSelector,
  BundleFocusSnapshot,
  EndInteractiveStepInput,
  InterruptTurnInput,
  LaunchRunInput,
  ResumeRunInput,
  SendInteractiveTurnInput,
  SteerTurnInput,
  OpenedProjection,
  OperationOutcome,
  OperationSnapshot,
  ProjectionPort,
  ProjectionSelector,
  Problem,
  DiagnosticReference,
  ResourceRead,
  ResourceReference,
  RunGateReference,
  TranscriptExportReference,
  TranscriptPageReference,
  TranscriptRead,
  RunListSnapshot,
  RunSnapshot,
  Submission,
  SubmissionAdmission,
  WorkspaceSnapshot,
} from "./projection-port.js";

/** How composition drives one acquired Run to rest. It constructs the Run
 *  execution (the `{asset}` resolver, host platform, and bounds) and calls the
 *  execution Interface; a fenced owner or publication fault throws (composition
 *  owns it). The Application wraps the owner it is handed to observe each
 *  publication, so this signature stays execution-agnostic. */
export type RunExecution = (context: {
  readonly routing: readonly RoutingNode[];
  readonly digest: string;
  readonly owner: RunOwner;
  /** The cancel Seam a live Run is driven under (#98): when it aborts mid-command
   *  the child's process group is killed and execution unwinds. The Application owns
   *  one AbortController per live Run and passes its signal here; the execution
   *  Interface stays agnostic to why it aborted. */
  readonly cancelSignal?: AbortSignal;
  /** The Application's per-Run live request-answer channel (#117): an Agent Turn's
   *  approval requests reach the observing client through it, and a client answers
   *  through `answer-harness-request`. Absent for a Command-only Run. */
  readonly requestChannel?: RequestChannel;
  /** Current prepared-profile evidence projected while the Attempt is still live;
   *  the settled Attempt persists the same fact for reopen/resume. */
  readonly observeSteer?: (capability: RunSteerCapability) => void;
}) => Promise<RunExecutionReport>;

export interface RunExecutionReport extends RunReport {
  /** An already-qualified Harness whose ownership transfers to the Application
   *  when execution rests at an interactive Step. The Application treats it as
   *  opaque and closes it when that Step ends or the Run releases ownership. */
  readonly interactiveStep?: RunInteractiveStep;
}

/** The opaque Step-scoped interactive driver composition transfers to a tracked
 *  Run. It reuses one prepared Harness across human Turns and exposes only the
 *  normalized control evidence and Turn outcome the Application owns. */
export interface RunInteractiveStep {
  readonly steer: RunSteerCapability;
  turn(context: {
    readonly runId: string;
    readonly owner: RunOwner;
    /** The Step's named Session, reused across the Step's Turns and later Steps. */
    readonly session: string;
    /** The interactive Step's pending Attempt id, so every human Turn links to it. */
    readonly attemptId: string;
    /** A unique id per human Turn. */
    readonly turnId: string;
    /** The human's verbatim Turn text. */
    readonly text: string;
    readonly cancelSignal?: AbortSignal;
    readonly requestChannel?: RequestChannel;
  }): Promise<InteractiveTurnReport>;
  close(): Promise<void>;
}

export type PrepareRunInteractiveStep = (context: {
  readonly owner: RunOwner;
}) => Promise<RunInteractiveStep>;

/** The mechanical outcome of one human interactive Turn (#122), normalized so the
 *  Application stays Harness-agnostic. `completed`/`failed` leave the Run `blocked`
 *  for the next Turn; `interrupted`/`lost` rest it `halted` (resumable). */
export type InteractiveTurnReport = {
  readonly outcome: "completed" | "failed" | "interrupted" | "lost";
};

// Why a live Run's execution was aborted. A `cancel-run` (CANCEL_ABORT) rests the
// Run `cancelled`; a process signal (SIGNAL_ABORT: SIGINT/SIGHUP/SIGTERM) or a
// Turn-scoped interrupt (INTERRUPT_TURN_ABORT, #118) rests it `halted` — a Command
// leaves the claim live for the next open to reconcile, while a live Agent Turn
// interrupts at the Harness Seam and rests `halted` in-process. The reasons live at
// the execution Seam that interprets them (#98, #118); the Application reads its own
// AbortController's reason to tell the cases apart.

/** A launched Run tracked in this process (#98): its routing and Bundle facts, the
 *  owner while live (so a snapshot read never fences the executing owner), the
 *  in-memory latest state, the AbortController that stops its execution, the
 *  settlement promise a cancel awaits, the streams watching it, and its live
 *  Agent-Turn overlay (#117). */
interface TrackedRun {
  readonly digest: string;
  readonly routing: readonly RoutingNode[];
  readonly name: string;
  readonly id: string;
  readonly version: string;
  state: string;
  owner?: RunOwner;
  done: boolean;
  readonly abort: AbortController;
  promise?: Promise<OperationOutcome>;
  readonly takeover?: boolean;
  readonly observers: Set<UpdateStream>;
  readonly live: LiveOverlayState;
  interactiveStep?: RunInteractiveStep;
  steer?: RunSteerCapability;
}

/** What `beginInteractive` returns once a Run is confirmed to rest at the named
 *  interactive-agent Step (#122): the claimed owner and its tracking, whether the
 *  ownership was already held, and the resolved Step/record/facts. */
interface InteractiveContext {
  readonly tracking: TrackedRun;
  readonly owner: RunOwner;
  readonly ownershipWasHeld: boolean;
  readonly step: AgentStep;
  readonly record: RunRecord;
  readonly facts: RunFacts;
}

// Application owns the Workspace-approval use case behind the Projection Port.
// The Port is in-memory: it resolves paths, records approvals through the
// Catalog, and reflects durable truth back into open Projections. A submitted
// Operation is admitted at once and recorded `pending`; its settlement is
// scheduled through `scheduleSettlement`, which runs inline by default so
// approve-workspace still settles before its caller opens the Projection. A
// deferred settler (a test, later a real long-lived Run) lets an observer open
// the `operation` Projection while it is still `pending` and receive the
// settled outcome as a durable update on the same stream. The async `updates`
// stream also carries the durable change to any `workspace` Projection observing
// when the launch Workspace becomes approved.

export interface ApplicationDependencies {
  readonly catalog: Catalog;
  /** The launch Workspace path, typically the raw cwd; Application canonicalises
   *  it (A6): the roots pass the path they were given, this Module owns the
   *  `realpathSync.native` invariant. */
  readonly launchWorkspacePath: string;
  /** Install budgets a Bundle can never raise; composition wires the defaults. */
  readonly bundleBudgets?: Budgets;
  /** The running Secant engine version, for the `bundle-catalog` engine note.
   *  Defaults to the dev sentinel when a caller has no version to declare. */
  readonly engineVersion?: string;
  /** The host platform the Execution summary resolves commands for. */
  readonly hostPlatform?: Platform;
  /** How a submitted Operation's settlement is scheduled. The default runs it
   *  inline: a synchronous settler (approve-workspace, cancel, delete) is already
   *  settled when an `operation` Projection opens; an async one (a Run reaching
   *  rest) settles on the operation stream's first durable update. A test supplies
   *  a controllable settler to exercise the `pending` → settled path. */
  readonly scheduleSettlement?: (
    settle: () => void | Promise<void>,
  ) => void | Promise<void>;
  /** The Run Store for the launch Workspace, opened by composition (which owns
   *  its lifetime). Absent when a caller wires no Run support; `launch-run` and
   *  the `run` Projection then report a Problem rather than executing. */
  readonly runGroup?: RunGroup;
  /** The Run execution composition constructs and hands in (see RunExecution). */
  readonly runExecution?: RunExecution;
  /** How one human interactive Turn is driven (#122); composition hands it in.
   *  Absent when a caller wires no interactive support (headless refuses interactive
   *  Bundles at Preflight, so it never reaches this seam). */
  readonly prepareRunInteractiveStep?: PrepareRunInteractiveStep;
  /** The clock the `run-list` Projection groups rows by (Today / Yesterday /
   *  Older). Defaults to the wall clock; a test injects a fixed instant (#87). */
  readonly now?: () => Date;
  /** Whether the launching client can relay human turn-taking (#116). Headless
   *  cannot, so it refuses an `interactive-agent` Bundle at Preflight; the TUI sets
   *  this true. Defaults to false. */
  readonly supportsInteractiveTurns?: boolean;
  /** Harness-owned synchronous discovery used by Preflight. Tests inject the
   *  outcome so parallel suites never coordinate through process.env. */
  readonly discoverClaudeCode?: () => ClaudeCodeDiscovery;
}

export interface Application {
  readonly projectionPort: ProjectionPort;
  readonly bundleManagement: BundleManagement;
  /** Release Runs already blocked without changing their rest, then abort every
   *  running Run and await settlement. Composition calls this from its OS-signal
   *  handler before teardown, so no prepared Harness or child is left running. */
  shutdown(): Promise<void>;
}

// Launch inputs are a name→value string map (LaunchInput values are opaque
// strings); the resume path validates the opaque run.db payload against this
// before Preflight (A10).
const launchInputMap = z.record(z.string(), z.string());

/** The semantic Harness pinned by a newly created Run. Client choice has not
 *  landed yet, so every Agent-bearing routing selects the sole production
 *  Adapter while Command-only routing remains unselected. */
function selectedHarnessFor(
  routing: readonly RoutingNode[],
): SelectedHarnessId | undefined {
  return routingNeedsHarness(routing) ? "claude-code" : undefined;
}

export function createApplication(deps: ApplicationDependencies): Application {
  const { catalog, runGroup, runExecution, prepareRunInteractiveStep } = deps;
  const launchWorkspacePath = canonicalizeWorkspacePath(
    deps.launchWorkspacePath,
  );
  const scheduleSettlement =
    deps.scheduleSettlement ??
    ((settle: () => void | Promise<void>) => settle());
  const now = deps.now ?? (() => new Date());
  const budgets = deps.bundleBudgets ?? DEFAULT_BUDGETS;
  // Each Operation carries a settler (run inline by default, deferred under a
  // test), its outcome, and the streams watching it. Observers are added only
  // while `pending` and delivered to exactly once on settlement, so a settled
  // Operation holds no live observer to leak. `replayKey` decides whether a
  // re-submitted operation id is a replay (equal) or a conflict (different).
  const operations = new Map<
    string,
    {
      readonly replayKey: string;
      outcome: OperationOutcome;
      readonly observers: Set<UpdateStream>;
      readonly runId?: string;
      readonly settle: () => OperationOutcome | Promise<OperationOutcome>;
    }
  >();
  // A launched Run tracked in this process: its routing and Bundle facts, the
  // owner while it is live (so a snapshot read never fences the executing owner),
  // the in-memory latest state, the AbortController that stops its execution
  // (cancel-run and process signals abort it), the settlement promise a cancel
  // awaits, and the streams watching it (#98).
  const runs = new Map<string, TrackedRun>();
  // A Run's observer set outlives any one live tracking entry. A Projection opened
  // while the Run rests joins here before a later Operation creates or replaces
  // tracking, so it receives future updates for its whole lifetime (#134 A1).
  const runObservers = new Map<string, Set<UpdateStream>>();
  const liveOverlay = createLiveOverlay((runId) => runs.get(runId));
  const workspaceObservers = new Set<UpdateStream>();
  const bundleCatalogObservers = new Set<UpdateStream>();
  const runListObservers = new Set<{
    readonly updates: UpdateStream;
    readonly resumable: boolean;
    readonly before?: string;
  }>();
  const bundleCatalog: BundleCatalogDependencies = {
    catalog,
    budgets,
    engineVersion: deps.engineVersion ?? "0.0.0-dev",
    ...(deps.hostPlatform !== undefined
      ? { hostPlatform: deps.hostPlatform }
      : {}),
  };
  const runProjection: RunProjectionDependencies | undefined =
    runGroup === undefined
      ? undefined
      : {
          runGroup,
          catalog,
          budgets,
          ...(deps.hostPlatform !== undefined
            ? { hostPlatform: deps.hostPlatform }
            : {}),
        };

  function observersForRun(runId: string): Set<UpdateStream> {
    const existing = runObservers.get(runId);
    if (existing !== undefined) return existing;
    const observers = new Set<UpdateStream>();
    runObservers.set(runId, observers);
    return observers;
  }

  function workspaceSnapshot(): WorkspaceSnapshot {
    const approval = catalog.getWorkspaceApproval(launchWorkspacePath);
    return {
      family: "workspace",
      path: launchWorkspacePath,
      approval: approval
        ? { state: "approved", approvedAt: approval.approvedAt }
        : { state: "unapproved" },
      installedBundleCount: catalog.countInstalledBundles(),
      actionOffers: approval
        ? []
        : [
            {
              action: "approve-workspace",
              input: { path: launchWorkspacePath },
            },
          ],
    };
  }

  function applyApproval(rawPath: string): OperationOutcome {
    let canonicalPath: string;
    try {
      canonicalPath = canonicalizeWorkspacePath(rawPath);
    } catch (error) {
      return { status: "not-applied", problem: pathNotFound(rawPath, error) };
    }
    catalog.approveWorkspace(canonicalPath, new Date());
    if (canonicalPath === launchWorkspacePath) {
      const snapshot = workspaceSnapshot();
      for (const observer of workspaceObservers) {
        observer.push({ kind: "durable", snapshot });
      }
    }
    return { status: "applied" };
  }

  // Settles a `pending` Operation: runs its settler, records the durable outcome
  // in place (the observer Set and settler stay stable), and delivers it to any
  // Projection opened on this id while it was pending. Runs via
  // `scheduleSettlement`, so inline by default and deferred under a test.
  function settleOperation(operationId: string): void | Promise<void> {
    const entry = operations.get(operationId);
    if (entry === undefined) return;
    const record = (outcome: OperationOutcome): void => {
      entry.outcome = outcome;
      const snapshot: OperationSnapshot = {
        family: "operation",
        operationId,
        outcome,
      };
      for (const observer of entry.observers) {
        observer.push({ kind: "durable", snapshot });
      }
    };
    // A synchronous settler (approve-workspace, delete, and a cancel of a Run not
    // live in this process) settles inline so an `operation` Projection opened right
    // after `submit` is already settled; a Run settler (launch, resume, answer) and a
    // cancel-as-abort of an in-process live Run return a Promise, which settles on the
    // stream's first durable update. Keeping the sync path sync preserves every such
    // Operation's synchronous observation.
    const recordFault = (error: unknown): void => {
      record({
        status: "not-applied",
        problem: runExecutionFault(entry.runId, error, operationId),
      });
    };
    try {
      const settled = entry.settle();
      if (settled instanceof Promise) {
        return settled.then(record, recordFault);
      }
      record(settled);
    } catch (error) {
      recordFault(error);
    }
  }

  // Push the current Run snapshot to every observer watching this Run. Called
  // after each publication (via the wrapped owner) while the Run is live.
  function pushRunUpdate(runId: string): void {
    if (runProjection === undefined) return;
    const tracking = runs.get(runId);
    const observers = runObservers.get(runId);
    if (observers !== undefined && observers.size > 0) {
      const snapshot = runSnapshot(
        runProjection,
        runId,
        tracking === undefined
          ? {}
          : {
              facts: {
                routing: tracking.routing,
                name: tracking.name,
                id: tracking.id,
                version: tracking.version,
                digest: tracking.digest,
              },
              ...(tracking.owner !== undefined
                ? { liveOwner: tracking.owner }
                : {}),
              state: tracking.state,
              ...(tracking.steer !== undefined
                ? { steer: tracking.steer }
                : {}),
            },
      );
      for (const observer of observers) {
        observer.push({ kind: "durable", snapshot });
      }
    }
    pushRunListUpdates();
  }

  function pushRunListUpdates(): void {
    if (runProjection === undefined) return;
    for (const observer of runListObservers) {
      const options = {
        resumable: observer.resumable,
        now: now(),
      };
      const snapshot = listRunsSnapshot(
        runProjection,
        observer.before === undefined
          ? options
          : { ...options, before: observer.before },
      );
      observer.updates.push({ kind: "durable", snapshot });
    }
  }

  // The registration of a Run live in ANOTHER process, or undefined when the Run is
  // not live, is live in THIS process, or its listing cannot be read (#98 S2). A Run
  // whose owner process is still alive is left live at group open (Run Store owner
  // liveness), so resuming or answering it would fence — and abort — the process
  // driving it; the caller refuses `run-live-elsewhere` instead.
  function liveElsewhere(runId: string): { ownerPid?: number } | undefined {
    if (runGroup === undefined) return undefined;
    const tracked = runs.get(runId);
    if (tracked !== undefined && !tracked.done && tracked.owner !== undefined) {
      return undefined; // live in this process
    }
    try {
      return runGroup
        .listRuns()
        .find(
          (run) => run.runId === runId && run.live && !run.ownedByThisProcess,
        );
    } catch {
      // A malformed coordination row never throws out of submit (A4); the caller's
      // own store reads then surface it as a typed Problem.
      return undefined;
    }
  }

  // Tell every observer watching this Run that its subject is gone (#98): a delete
  // removes the store, so any open `run` Projection is closed rather than left to
  // read a Run that no longer exists. Pushed before the tracking entry is dropped.
  function pushRunClosed(runId: string): void {
    const observers = runObservers.get(runId);
    if (observers === undefined) return;
    for (const observer of observers) {
      observer.push({ kind: "closed", reason: "subject-gone" });
    }
  }

  // Wrap the acquired owner so each canonical write pushes a fresh Run snapshot
  // to observers. Reads delegate to the raw owner unchanged; write methods are
  // intercepted and push only after they commit.
  function observedOwner(owner: RunOwner, runId: string): RunOwner {
    const tracking = runs.get(runId);
    return {
      ...owner,
      selectHarness(selectedHarness) {
        const result = owner.selectHarness(selectedHarness);
        if (result.outcome === "selected") pushRunUpdate(runId);
        return result;
      },
      writeState(state) {
        const result = owner.writeState(state);
        if (result.ok && tracking !== undefined) {
          tracking.state = state;
          pushRunUpdate(runId);
        }
        return result;
      },
      publishAttempt(request) {
        const result = owner.publishAttempt(request);
        if (result.ok) {
          if (request.advanceState !== undefined && tracking !== undefined) {
            tracking.state = request.advanceState;
          }
          pushRunUpdate(runId);
        }
        return result;
      },
      recordMaterializationConflict(request) {
        const result = owner.recordMaterializationConflict(request);
        // The store rests the Run `halted` inside this call, so mirror that into
        // the in-memory state and push the halted snapshot to observers.
        if (result.ok && tracking !== undefined) {
          tracking.state = "halted";
          pushRunUpdate(runId);
        }
        return result;
      },
      recordGateAnswer(request) {
        const result = owner.recordGateAnswer(request);
        // A `stop` advances the Run to `failed` inside this transaction; mirror
        // that advance into the in-memory state and push it to observers (#85).
        if (result.ok && request.advanceState !== undefined && tracking) {
          tracking.state = request.advanceState;
          pushRunUpdate(runId);
        }
        return result;
      },
      recordPendingGate(request) {
        const result = owner.recordPendingGate(request);
        // Recording an authored gate rests the Run `blocked` in the same
        // transaction (#108); mirror that into the in-memory state and push the
        // blocked snapshot so an open client sees the gate at once (A3).
        if (result.ok && tracking !== undefined) {
          tracking.state = "blocked";
          pushRunUpdate(runId);
        }
        return result;
      },
    };
  }

  function upgradeLegacyHarnessSelection(
    owner: RunOwner,
    routing: readonly RoutingNode[],
    runId: string,
  ): "ready" | "fenced" {
    if (
      owner.record.selectedHarness !== undefined ||
      !routingNeedsHarness(routing)
    ) {
      return "ready";
    }
    return observedOwner(owner, runId).selectHarness("claude-code").outcome !==
      "fenced"
      ? "ready"
      : "fenced";
  }

  function restsAtInteractiveStep(
    tracking: TrackedRun,
    owner: RunOwner,
    runId: string,
  ): boolean {
    const derived = deriveRun(
      tracking.routing,
      owner.attemptLog(),
      tracking.state,
      runId,
      owner,
      owner.gateAnswers(),
    );
    const current = derived.statuses[derived.position];
    return (
      derived.state === "blocked" &&
      derived.checkpoint === undefined &&
      derived.pendingGate === undefined &&
      current?.kind === "interactive-agent"
    );
  }

  async function adoptInteractiveStep(
    report: RunExecutionReport,
    tracking: TrackedRun,
    owner: RunOwner,
    runId: string,
  ): Promise<void> {
    if (report.interactiveStep === undefined) return;
    if (
      report.outcome === "blocked" &&
      restsAtInteractiveStep(tracking, owner, runId)
    ) {
      tracking.interactiveStep = report.interactiveStep;
      tracking.steer = report.interactiveStep.steer;
      return;
    }
    await report.interactiveStep.close();
  }

  async function closeInteractiveStep(tracking: TrackedRun): Promise<void> {
    const interactiveStep = tracking.interactiveStep;
    if (interactiveStep === undefined) return;
    tracking.interactiveStep = undefined;
    await interactiveStep.close();
  }

  async function driveWithAbortProtocol(params: {
    readonly runId: string;
    readonly tracking: TrackedRun;
    readonly owner: RunOwner;
    readonly drive: () => Promise<OperationOutcome>;
    readonly retainOwner: () => boolean;
    readonly setRetainOwner: (retain: boolean) => void;
  }): Promise<OperationOutcome> {
    const { runId, tracking, owner } = params;
    try {
      return await params.drive();
    } catch (error) {
      if (tracking.abort.signal.aborted) {
        if (tracking.abort.signal.reason === CANCEL_ABORT) {
          observedOwner(owner, runId).writeState("cancelled");
          params.setRetainOwner(false);
          return { status: "applied" };
        }
        params.setRetainOwner(true);
        return { status: "applied" };
      }
      return {
        status: "not-applied",
        problem: runExecutionFault(runId, error),
      };
    } finally {
      tracking.promise = undefined;
      if (params.retainOwner()) {
        tracking.done = false;
      } else {
        try {
          await closeInteractiveStep(tracking);
        } finally {
          tracking.owner = undefined;
          tracking.done = true;
          try {
            owner.release();
          } finally {
            owner.close();
            pushRunUpdate(runId);
          }
        }
      }
    }
  }

  async function executeTrackedRouting(params: {
    readonly runId: string;
    readonly tracking: TrackedRun;
    readonly owner: RunOwner;
    readonly executionOwner: RunOwner;
    readonly routing: readonly RoutingNode[];
    readonly digest: string;
  }): Promise<RunExecutionReport> {
    if (
      upgradeLegacyHarnessSelection(
        params.owner,
        params.routing,
        params.runId,
      ) === "fenced"
    ) {
      throw new Error(
        "application: legacy Harness selection write was fenced.",
      );
    }
    const report = await runExecution!({
      routing: params.routing,
      digest: params.digest,
      owner: params.executionOwner,
      cancelSignal: params.tracking.abort.signal,
      requestChannel: liveOverlay.requestChannel(params.runId),
      observeSteer: (capability) => {
        params.tracking.steer = capability;
      },
    });
    await adoptInteractiveStep(
      report,
      params.tracking,
      params.owner,
      params.runId,
    );
    return report;
  }

  // Acquire the Run and drive it through the injected execution. The launch
  // Operation is `applied`
  // once the Run reaches rest (succeeded, failed, or a `blocked` pause at a Review
  // checkpoint). Ownership stays held through `blocked` and is released only when
  // the Run reaches a resting state; a fenced owner or publication fault is a coordination/environment
  // fault that execution throws, carried here as a `not-applied` Problem.
  async function runAndSettle(runId: string): Promise<OperationOutcome> {
    const tracking = runs.get(runId);
    if (
      tracking === undefined ||
      runGroup === undefined ||
      runExecution === undefined
    ) {
      return { status: "not-applied", problem: runSupportUnavailable() };
    }
    const owner = runGroup.acquireRun(
      runId,
      tracking.takeover === true ? { takeover: true } : undefined,
    );
    if (owner === undefined) {
      tracking.done = true;
      return { status: "not-applied", problem: runStoreDamaged(runId) };
    }
    tracking.owner = owner;
    const observed = observedOwner(owner, runId);
    if (tracking.takeover === true && tracking.state === "blocked") {
      // This takeover intentionally drives no routing, so it performs the
      // resume-boundary upgrade here rather than in executeTrackedRouting.
      if (
        upgradeLegacyHarnessSelection(owner, tracking.routing, runId) ===
        "fenced"
      ) {
        tracking.owner = undefined;
        tracking.done = true;
        try {
          owner.release();
        } finally {
          owner.close();
        }
        return { status: "not-applied", problem: runStoreDamaged(runId) };
      }
      tracking.promise = undefined;
      tracking.done = false;
      pushRunUpdate(runId);
      return { status: "applied" };
    }
    // A signal-abort and a blocked pause retain ownership. Every rested outcome
    // releases it in the finally.
    let leaveClaimLive = false;
    return driveWithAbortProtocol({
      runId,
      tracking,
      owner,
      drive: async () => {
        const report = await executeTrackedRouting({
          runId,
          tracking,
          owner,
          executionOwner: observed,
          routing: tracking.routing,
          digest: tracking.digest,
        });
        leaveClaimLive = report.outcome === "blocked";
        return { status: "applied" };
      },
      retainOwner: () => leaveClaimLive,
      setRetainOwner: (retain) => {
        leaveClaimLive = retain;
      },
    });
  }

  // Start a Run's execution promise and record it on the tracking entry so a
  // concurrent cancel-run (or a process signal) can abort it and await its rest
  // (#98). Called as the launch/resume Operation's settler: invoking `runAndSettle`
  // runs its synchronous prefix (which acquires the owner) before the first await,
  // so the promise captured here already has the owner in hand.
  function startRun(runId: string): Promise<OperationOutcome> {
    const tracking = runs.get(runId);
    // A takeover that only re-acquires a Run resting `blocked` runs no execution:
    // `runAndSettle` re-fences the owner, leaves the Run blocked, and settles
    // synchronously (clearing its own `promise`). Its tracking entry must keep
    // `promise === undefined` so cancel-run and shutdown treat it as the held
    // blocked Run it is (write `cancelled`/`halted` and release the owner), not a
    // live execution to abort — so do not overwrite the promise back in that case.
    const blockedTakeover =
      tracking?.takeover === true && tracking.state === "blocked";
    const promise = runAndSettle(runId);
    if (tracking !== undefined && !blockedTakeover) tracking.promise = promise;
    return promise;
  }

  // Selector-typed per the Port overloads (#74 A8); the implementation signature
  // returns the union and the overloads narrow it for callers. The body is one
  // switch over the closed selector families, so no snapshot cast is needed here
  // or in either client.
  function openProjection(selector: {
    readonly family: "workspace";
  }): OpenedProjection<WorkspaceSnapshot>;
  function openProjection(selector: {
    readonly family: "operation";
    readonly operationId: string;
  }): OpenedProjection<OperationSnapshot>;
  function openProjection(selector: {
    readonly family: "bundle-catalog";
    readonly focus: BundleFocusSelector;
  }): OpenedProjection<BundleFocusSnapshot>;
  function openProjection(selector: {
    readonly family: "bundle-catalog";
    readonly focus?: undefined;
  }): OpenedProjection<BundleCatalogSnapshot>;
  function openProjection(selector: {
    readonly family: "run";
    readonly runId: string;
  }): OpenedProjection<RunSnapshot>;
  function openProjection(selector: {
    readonly family: "run-list";
    readonly resumable?: boolean;
    readonly before?: string;
  }): OpenedProjection<RunListSnapshot>;
  function openProjection(selector: ProjectionSelector): OpenedProjection;
  function openProjection(selector: ProjectionSelector): OpenedProjection {
    if (selector.family === "run") {
      return openRunProjection(selector.runId);
    }
    if (selector.family === "run-list") {
      const updates = new UpdateStream();
      const snapshot: RunListSnapshot =
        runProjection === undefined
          ? {
              family: "run-list",
              filter: selector.resumable ? "resumable" : "all",
              rows: [],
              beginningOfHistory: true,
              empty: true,
            }
          : listRunsSnapshot(runProjection, {
              resumable: selector.resumable ?? false,
              now: now(),
              ...(selector.before !== undefined
                ? { before: selector.before }
                : {}),
            });
      const observer = {
        updates,
        resumable: selector.resumable ?? false,
        ...(selector.before !== undefined ? { before: selector.before } : {}),
      };
      runListObservers.add(observer);
      return {
        snapshot,
        catchUp: "fresh",
        updates,
        close() {
          runListObservers.delete(observer);
          updates.close();
        },
      };
    }
    if (selector.family === "bundle-catalog") {
      if (selector.focus !== undefined) {
        // A focus is a settled point-in-time inspection; no updates arrive.
        const updates = new UpdateStream();
        return {
          snapshot: focusSnapshot(bundleCatalog, selector.focus),
          catchUp: "fresh",
          updates,
          close() {
            updates.close();
          },
        };
      }
      const updates = new UpdateStream();
      bundleCatalogObservers.add(updates);
      return {
        snapshot: listSnapshot(bundleCatalog),
        catchUp: "fresh",
        updates,
        close() {
          bundleCatalogObservers.delete(updates);
          updates.close();
        },
      };
    }
    if (selector.family === "workspace") {
      const updates = new UpdateStream();
      workspaceObservers.add(updates);
      return {
        snapshot: workspaceSnapshot(),
        catchUp: "fresh",
        updates,
        close() {
          workspaceObservers.delete(updates);
          updates.close();
        },
      };
    }
    const operationId = selector.operationId;
    const operation = operations.get(operationId);
    const updates = new UpdateStream();
    if (operation === undefined) {
      // An id Secant never saw is a Problem snapshot, not a throw (#77).
      return {
        snapshot: {
          family: "operation",
          operationId,
          outcome: {
            status: "not-applied",
            problem: operationNotFound(operationId),
          },
        },
        catchUp: "fresh",
        updates,
        close() {
          updates.close();
        },
      };
    }
    const snapshot: OperationSnapshot = {
      family: "operation",
      operationId,
      outcome: operation.outcome,
    };
    if (operation.outcome.status !== "pending") {
      // Already settled: no further update will arrive, so nothing to register.
      return {
        snapshot,
        catchUp: "fresh",
        updates,
        close() {
          updates.close();
        },
      };
    }
    // Still pending: register for the settled durable update. The stream stays
    // open after that update until the observer closes it.
    const { observers } = operation;
    observers.add(updates);
    return {
      snapshot,
      catchUp: "fresh",
      updates,
      close() {
        observers.delete(updates);
        updates.close();
      },
    };
  }

  function openRunProjection(runId: string): OpenedProjection {
    const updates = new UpdateStream();
    if (runProjection === undefined) {
      // No Run support wired: a Problem snapshot, not a throw, like an unknown id.
      return {
        snapshot: {
          family: "run",
          runId,
          result: { found: false, problem: runSupportUnavailable() },
        },
        catchUp: "fresh",
        updates,
        close() {
          updates.close();
        },
      };
    }
    // Reopening is itself an upgrade boundary. Derive only from the still-installed
    // pinned Snapshot, then perform the one fenced write before projecting the Run.
    // A missing/corrupt Snapshot is left untouched for `runSnapshot` to translate
    // into its existing Problem, and a foreign live owner is never fenced by a read.
    const read = runGroup?.readRun(runId);
    if (read?.ok && read.run.selectedHarness === undefined) {
      const derived = deriveRunFacts(
        runProjection,
        read.run.bundleSnapshotDigest,
      );
      if ("facts" in derived && routingNeedsHarness(derived.facts.routing)) {
        const tracking = runs.get(runId);
        const heldOwner =
          tracking !== undefined && !tracking.done ? tracking.owner : undefined;
        const owner = heldOwner ?? runProjection.runGroup.acquireRun(runId);
        if (owner !== undefined) {
          try {
            upgradeLegacyHarnessSelection(owner, derived.facts.routing, runId);
          } finally {
            if (heldOwner === undefined) owner.close();
          }
        }
      }
    }
    const tracking = runs.get(runId);
    const snapshot = runSnapshot(
      runProjection,
      runId,
      tracking === undefined
        ? {}
        : {
            facts: {
              routing: tracking.routing,
              name: tracking.name,
              id: tracking.id,
              version: tracking.version,
              digest: tracking.digest,
            },
            ...(tracking.owner !== undefined
              ? { liveOwner: tracking.owner }
              : {}),
            state: tracking.state,
            ...(tracking.steer !== undefined ? { steer: tracking.steer } : {}),
          },
    );
    // Every existing Run joins its Run-scoped observer set, even while rested: an
    // Operation may drive it later, and opening a Projection promises future
    // updates for the Projection's lifetime (ADR 0024).
    if (snapshot.result.found) {
      const observers = observersForRun(runId);
      observers.add(updates);
      // A late-joining observer catches up on the current live overlay at once, so
      // a headless follower that opens after a request was raised still sees it
      // (#117). No-op when the Run has no live Turn to describe.
      if (tracking !== undefined && !tracking.done) {
        liveOverlay.push(runId, updates);
      }
      return {
        snapshot,
        catchUp: "fresh",
        updates,
        close() {
          observers.delete(updates);
          updates.close();
        },
      };
    }
    return {
      snapshot,
      catchUp: "fresh",
      updates,
      close() {
        updates.close();
      },
    };
  }

  function submitApprove(
    operationId: string,
    input: { readonly path: string },
  ): SubmissionAdmission {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.replayKey === input.path) {
        return { admitted: true, operationId };
      }
      return { admitted: false, problem: operationIdReused(operationId) };
    }
    operations.set(operationId, {
      replayKey: input.path,
      outcome: { status: "pending" },
      observers: new Set<UpdateStream>(),
      settle: () => applyApproval(input.path),
    });
    scheduleSettlement(() => settleOperation(operationId));
    return { admitted: true, operationId };
  }

  function submitLaunch(
    operationId: string,
    input: LaunchRunInput,
  ): SubmissionAdmission {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.replayKey === launchReplayKey(input)) {
        return {
          admitted: true,
          operationId,
          ...(existing.runId !== undefined ? { runId: existing.runId } : {}),
        };
      }
      return { admitted: false, problem: operationIdReused(operationId) };
    }
    if (runGroup === undefined || runExecution === undefined) {
      return { admitted: false, problem: runSupportUnavailable() };
    }
    // Resolve the installed Entry, prove the Workspace is approved, and read the
    // pinned bytes — all before anything is written, so a Problem here leaves no
    // Trust grant and no Run (AC1, AC4).
    const selected = selectRunEntry(
      catalog,
      input.bundle.id,
      input.bundle.version,
    );
    if ("problem" in selected) {
      return { admitted: false, problem: selected.problem };
    }
    const entry = selected.entry;
    if (catalog.getWorkspaceApproval(launchWorkspacePath) === undefined) {
      return {
        admitted: false,
        problem: workspaceNotApproved(launchWorkspacePath),
      };
    }
    const bytes = catalog.readManagedBytes(entry.digest);
    if (bytes === undefined) {
      return {
        admitted: false,
        problem: bundleBytesMissing({ digest: entry.digest }),
      };
    }
    // Include the Composition re-check: a Run pins this Snapshot, so Preflight
    // proves it still composes against the archived prompt/schema text (ADR 0021).
    const inspected = inspectBundle(bytes, budgets, true);
    if (!inspected.ok) {
      return {
        admitted: false,
        problem: bundleBytesCorrupt(
          { digest: entry.digest },
          inspected.finding.code,
        ),
      };
    }
    const manifest = inspected.inspection.manifest;

    // Preflight refuses a Run whose prerequisites are not met — before any Trust
    // grant or Run is created, so a Problem here leaves nothing behind (#14). It
    // runs ahead of the Trust gate: a Bundle that cannot run in this environment
    // is refused without asking the user to acknowledge bytes that would not run.
    const pre = preflight({
      manifest,
      composition: inspected.inspection.composition,
      workspacePath: launchWorkspacePath,
      launchInputs: input.launchInputs,
      hostPlatform: deps.hostPlatform,
      digest: entry.digest,
      supportsInteractiveTurns: deps.supportsInteractiveTurns ?? false,
      ...(deps.discoverClaudeCode !== undefined
        ? { discoverClaudeCode: deps.discoverClaudeCode }
        : {}),
    });
    if ("problem" in pre) {
      return { admitted: false, problem: pre.problem };
    }

    // Trust: an untrusted digest needs a matching acknowledgement. A missing one
    // is `bundle-trust-required` (carrying the Execution summary, the fixed
    // warning, and the exact digest); a mismatching one grants nothing. The
    // acknowledgement is validated here but the grant is only recorded *after* the
    // Run is created, so a failed create leaves no dangling grant.
    const grant = catalog.getTrustGrant(
      entry.digest,
      entry.installationGeneration,
    );
    const needsGrant = grant === undefined;
    if (needsGrant) {
      if (input.trustDigest === undefined) {
        return {
          admitted: false,
          problem: bundleTrustRequired(
            manifest,
            entry.digest,
            deps.hostPlatform,
          ),
        };
      }
      if (input.trustDigest !== entry.digest) {
        return {
          admitted: false,
          problem: trustDigestMismatch(entry.digest, input.trustDigest),
        };
      }
    }

    const selectedHarness = selectedHarnessFor(manifest.routing);
    const created = runGroup.createRun({
      operationId,
      bundleSnapshotDigest: entry.digest,
      launch: input.launchInputs,
      ...(selectedHarness !== undefined ? { selectedHarness } : {}),
      at: new Date(),
    });
    if (needsGrant) {
      catalog.grantTrust({
        operationId,
        digest: entry.digest,
        installationGeneration: entry.installationGeneration,
        grantedAt: new Date(),
      });
    }
    const runId = created.runId;
    runs.set(runId, {
      digest: entry.digest,
      routing: manifest.routing,
      name: manifest.bundle.name,
      id: manifest.bundle.id,
      version: manifest.bundle.version,
      state: created.record.state,
      done: false,
      abort: new AbortController(),
      observers: observersForRun(runId),
      live: liveOverlay.fresh(),
    });
    pushRunListUpdates();
    operations.set(operationId, {
      replayKey: launchReplayKey(input),
      outcome: { status: "pending" },
      observers: new Set<UpdateStream>(),
      runId,
      settle: () => startRun(runId),
    });
    scheduleSettlement(() => settleOperation(operationId));
    return { admitted: true, operationId, runId };
  }

  // The Run-precondition re-check a resume runs before authorizing more work: the
  // exact pinned digest must still be installed, its bytes must still validate and
  // compose, the Bundle must still Preflight for this Workspace, and Trust must
  // still hold (ADR 0021, #86). A removed or replaced install surfaces as a
  // reinstall Problem, so a resume never runs a Bundle that could not be launched
  // fresh. Returns the manifest (its facts drive the resumed Run) or a Problem.
  function resumePreconditions(
    digest: string,
    launchInputs: Readonly<Record<string, string>>,
  ): { manifest: AuthoredManifest } | { problem: Problem } {
    const entry = catalog.listEntries().find((e) => e.digest === digest);
    if (entry === undefined) {
      // The exact digest is no longer installed (uninstalled, or replaced by a
      // different install): its bytes cannot be trusted to be the pinned Snapshot.
      return { problem: bundleBytesMissing({ digest }) };
    }
    const bytes = catalog.readManagedBytes(digest);
    if (bytes === undefined) {
      return { problem: bundleBytesMissing({ digest }) };
    }
    const inspected = inspectBundle(bytes, budgets, true);
    if (!inspected.ok) {
      return {
        problem: bundleBytesCorrupt({ digest }, inspected.finding.code),
      };
    }
    const manifest = inspected.inspection.manifest;
    const pre = preflight({
      manifest,
      composition: inspected.inspection.composition,
      workspacePath: launchWorkspacePath,
      launchInputs,
      hostPlatform: deps.hostPlatform,
      digest,
      supportsInteractiveTurns: deps.supportsInteractiveTurns ?? false,
      ...(deps.discoverClaudeCode !== undefined
        ? { discoverClaudeCode: deps.discoverClaudeCode }
        : {}),
    });
    if ("problem" in pre) return { problem: pre.problem };
    const grant = catalog.getTrustGrant(digest, entry.installationGeneration);
    if (grant === undefined) {
      return {
        problem: bundleTrustRequired(manifest, digest, deps.hostPlatform),
      };
    }
    return { manifest };
  }

  // Resume a Run resting `halted` or `failed`, or explicitly take over a live Run
  // (ADR 0019, ADR 0031): re-verify the pinned Snapshot is still installed and runnable,
  // then drive it further through the same execution — which skips the completed
  // Steps and re-runs from where it rested. A `failed` Run's declared attempt and
  // Iteration bounds reset naturally: the failed Step's Attempts never settled
  // `succeeded` (so it re-runs with a fresh retry budget), and a checkpoint stop
  // recorded the grant offset the Repeat loop restarts its interval from (#85).
  function submitResume(
    operationId: string,
    input: ResumeRunInput,
  ): SubmissionAdmission {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.replayKey === resumeReplayKey(input)) {
        return {
          admitted: true,
          operationId,
          ...(existing.runId !== undefined ? { runId: existing.runId } : {}),
        };
      }
      return { admitted: false, problem: operationIdReused(operationId) };
    }
    if (
      runGroup === undefined ||
      runExecution === undefined ||
      runProjection === undefined
    ) {
      return { admitted: false, problem: runSupportUnavailable() };
    }
    const read = runGroup.readRun(input.runId);
    if (!read.ok) {
      return {
        admitted: false,
        problem:
          read.problem.kind === "unknown-run"
            ? runNotFound(input.runId)
            : runStoreDamaged(input.runId),
      };
    }
    const record = read.run;
    const foreign = liveElsewhere(input.runId);
    const takeoverMatches =
      foreign !== undefined &&
      foreign.ownerPid !== undefined &&
      input.takeover?.ownerPid === foreign.ownerPid;
    if (foreign !== undefined && !takeoverMatches) {
      return {
        admitted: false,
        problem: runLiveElsewhere(input.runId, foreign.ownerPid),
      };
    }
    // Resume applies only to a Run resting `halted` or `failed` (ADR 0019). A
    // `running` record means the Run is live (here or elsewhere); resuming it would
    // fence the process driving it. A `succeeded`/`cancelled` Run is terminal.
    if (
      (takeoverMatches &&
        (record.state === "succeeded" || record.state === "cancelled")) ||
      (!takeoverMatches &&
        record.state !== "halted" &&
        record.state !== "failed")
    ) {
      return {
        admitted: false,
        problem: runNotResumable(input.runId, record.state),
      };
    }
    // Re-check Trust, Preflight, and that the exact pinned digest is still
    // installed before authorizing more work (#86); a removed or replaced install
    // is refused with a reinstall Problem, not resumed.
    // Launch inputs are stored and read back opaque (RunRecord.launch: unknown).
    // Validate them to the string map Preflight consumes before handing them on: a
    // drifted or corrupt run.db row is a damaged store refused with a typed Problem
    // here, ahead of Preflight, never a trusted cast (A10).
    const launchInputs = launchInputMap.safeParse(record.launch ?? {});
    if (!launchInputs.success) {
      return { admitted: false, problem: runStoreDamaged(input.runId) };
    }
    const runnable = resumePreconditions(
      record.bundleSnapshotDigest,
      launchInputs.data,
    );
    if ("problem" in runnable) {
      return { admitted: false, problem: runnable.problem };
    }
    const manifest = runnable.manifest;
    if (!takeoverMatches) {
      const claim = runGroup.resumeRun(input.runId);
      if (claim.outcome === "run-live-elsewhere") {
        return {
          admitted: false,
          problem: runLiveElsewhere(input.runId, claim.ownerPid),
        };
      }
      if (claim.outcome === "unknown-run") {
        return { admitted: false, problem: runNotFound(input.runId) };
      }
    }
    runs.set(input.runId, {
      digest: record.bundleSnapshotDigest,
      routing: manifest.routing,
      name: manifest.bundle.name,
      id: manifest.bundle.id,
      version: manifest.bundle.version,
      state: record.state,
      done: false,
      abort: new AbortController(),
      ...(takeoverMatches ? { takeover: true } : {}),
      observers: observersForRun(input.runId),
      live: liveOverlay.fresh(),
    });
    operations.set(operationId, {
      replayKey: resumeReplayKey(input),
      outcome: { status: "pending" },
      observers: new Set<UpdateStream>(),
      runId: input.runId,
      settle: () => startRun(input.runId),
    });
    scheduleSettlement(() => settleOperation(operationId));
    return { admitted: true, operationId, runId: input.runId };
  }

  // Answer the durable Human Gate a `blocked` Run rests at (#85). Admitted at
  // once; the answer is validated, recorded, and driven to the next rest at
  // settle time (deferred under a test), since deriving the current gate needs
  // the acquired owner.
  function submitAnswer(
    operationId: string,
    input: AnswerHumanGateInput,
  ): SubmissionAdmission {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.replayKey === answerReplayKey(input)) {
        return { admitted: true, operationId, runId: input.runId };
      }
      return { admitted: false, problem: operationIdReused(operationId) };
    }
    if (
      runGroup === undefined ||
      runExecution === undefined ||
      runProjection === undefined
    ) {
      return { admitted: false, problem: runSupportUnavailable() };
    }
    operations.set(operationId, {
      replayKey: answerReplayKey(input),
      outcome: { status: "pending" },
      observers: new Set<UpdateStream>(),
      runId: input.runId,
      settle: () => startAnswer(operationId, input),
    });
    scheduleSettlement(() => settleOperation(operationId));
    return { admitted: true, operationId, runId: input.runId };
  }

  // Start an answer's settlement and record its promise on the tracking entry the
  // continue branch creates, so a concurrent cancel-run (or a process signal) can
  // abort the granted interval and await its rest (#98), mirroring `startRun`.
  function startAnswer(
    operationId: string,
    input: AnswerHumanGateInput,
  ): Promise<OperationOutcome> {
    const promise = answerAndSettle(operationId, input);
    const tracking = runs.get(input.runId);
    if (tracking !== undefined) tracking.promise = promise;
    return promise;
  }

  // Validate the answer against the live Gate, record it durably, then either end
  // the Run `failed` (`stop`) or drive the granted interval to its next rest
  // (`continue`) — in this process. A stale/mismatched Gate or a Run that is not
  // blocked settles `not-applied` and changes nothing.
  async function answerAndSettle(
    operationId: string,
    input: AnswerHumanGateInput,
  ): Promise<OperationOutcome> {
    if (
      runGroup === undefined ||
      runExecution === undefined ||
      runProjection === undefined
    ) {
      return { status: "not-applied", problem: runSupportUnavailable() };
    }
    const read = runGroup.readRun(input.runId);
    if (!read.ok) {
      return {
        status: "not-applied",
        problem:
          read.problem.kind === "unknown-run"
            ? runNotFound(input.runId)
            : runStoreDamaged(input.runId),
      };
    }
    const record = read.run;
    // A Run live in another process is refused before anything is claimed (#98 S2):
    // re-claiming and acquiring it would fence the process driving it.
    const foreign = liveElsewhere(input.runId);
    if (foreign !== undefined) {
      return {
        status: "not-applied",
        problem: runLiveElsewhere(input.runId, foreign.ownerPid),
      };
    }
    const derivedFacts = deriveRunFacts(
      runProjection,
      record.bundleSnapshotDigest,
    );
    if ("problem" in derivedFacts) {
      return { status: "not-applied", problem: derivedFacts.problem };
    }
    const facts = derivedFacts.facts;
    // Reject a clearly-resting or terminal record before touching coordination, so answering a
    // Run that is not blocked changes nothing at all — no claim toggle, no epoch
    // bump. (A `running` record still needs the owner to tell blocked from a live
    // mid-execution Run; that is checked once acquired.)
    if (
      record.state !== "blocked" &&
      record.state !== "running" &&
      record.state !== "created"
    ) {
      return {
        status: "not-applied",
        problem: runNotBlocked(input.runId, record.state),
      };
    }
    let tracking = runs.get(input.runId);
    let owner =
      tracking !== undefined && !tracking.done ? tracking.owner : undefined;
    const ownershipWasHeld = owner !== undefined;
    if (owner === undefined) {
      const claim = runGroup.resumeRun(input.runId);
      if (claim.outcome === "run-live-elsewhere") {
        return {
          status: "not-applied",
          problem: runLiveElsewhere(input.runId, claim.ownerPid),
        };
      }
      if (claim.outcome === "unknown-run") {
        return { status: "not-applied", problem: runNotFound(input.runId) };
      }
      owner = runGroup.acquireRun(input.runId);
      if (owner === undefined) {
        return {
          status: "not-applied",
          problem: runStoreDamaged(input.runId),
        };
      }
      tracking = {
        digest: record.bundleSnapshotDigest,
        routing: facts.routing,
        name: facts.name,
        id: facts.id,
        version: facts.version,
        state: record.state,
        owner,
        done: false,
        abort: new AbortController(),
        observers: observersForRun(input.runId),
        live: liveOverlay.fresh(),
      };
      runs.set(input.runId, tracking);
    }
    if (tracking === undefined || owner === undefined) {
      return { status: "not-applied", problem: runStoreDamaged(input.runId) };
    }
    if (
      upgradeLegacyHarnessSelection(owner, facts.routing, input.runId) ===
      "fenced"
    ) {
      if (!ownershipWasHeld) {
        tracking.owner = undefined;
        tracking.done = true;
        owner.release();
        owner.close();
        runs.delete(input.runId);
      }
      return { status: "not-applied", problem: runStoreDamaged(input.runId) };
    }
    const activeTracking = tracking;
    const activeOwner = owner;
    // A signal-abort of the granted interval leaves the claim live for the next
    // open to reconcile `halted`; every other exit releases the claim (#98).
    let leaveClaimLive = ownershipWasHeld;
    return driveWithAbortProtocol({
      runId: input.runId,
      tracking: activeTracking,
      owner: activeOwner,
      drive: async () => {
        const observed = observedOwner(activeOwner, input.runId);
        const log = activeOwner.attemptLog();
        const priorAnswers = activeOwner.gateAnswers();
        const derived = deriveRun(
          facts.routing,
          log,
          record.state,
          input.runId,
          activeOwner,
          priorAnswers,
        );
        // Idempotent replay of the *same* operation id: settle `applied` without
        // re-validating the (now-moved) Gate or re-driving execution. Keyed on the
        // operation id, not on whether the Gate settled — a different operation
        // answering an already-answered gate must fall through to the staleness check
        // below and be refused, exactly as a moved derived checkpoint would (#108).
        // Within one process the operations map already dedupes a repeated operation
        // id (an authored gate records no `gate_answer` row, so this durable check
        // only fires for a derived checkpoint's cross-process replay). Process death
        // after a `continue` but before the interval rests leaves the Run stored
        // `running` with a live claim, so startup reconciliation (#86) rests it
        // `halted` and `run resume` re-drives it — the grant is honored, not doubled.
        const already = priorAnswers.some(
          (answer) => answer.operationId === operationId,
        );
        if (already) return { status: "applied" };

        // The live Gate the Run currently rests at: an authored gate (a durable
        // pending_gate) takes precedence over a derived Review checkpoint; a blocked
        // Run derives exactly one of the two (#108).
        const liveGate = derived.pendingGate?.gate ?? derived.checkpoint?.gate;
        if (derived.state !== "blocked" || liveGate === undefined) {
          return {
            status: "not-applied",
            problem: runNotBlocked(input.runId, derived.state),
          };
        }
        if (!gateEquals(liveGate, input.gate)) {
          return {
            status: "not-applied",
            problem: gateStale(input.runId, input.gate, liveGate),
          };
        }
        // The answer's form must match the Gate's shape (#108): a `free-text` gate
        // takes `--text`, an `approve-reject` gate takes `continue`/`stop`. A mismatch
        // changes nothing.
        const shapeMatches =
          liveGate.shape === "free-text"
            ? input.text !== undefined && input.answer === undefined
            : input.answer !== undefined && input.text === undefined;
        if (!shapeMatches) {
          return {
            status: "not-applied",
            problem: gateShapeMismatch(input.runId, liveGate.shape),
          };
        }

        // An authored gate settles its producing Attempt (#108): `free-text` publishes
        // the answer as the gate's declared `text` output and advances; approve advances
        // with no output; reject settles `failed` and rests the Run failed. All in one
        // Store boundary; the answering process then drives the Run to its next rest.
        if (derived.pendingGate !== undefined) {
          if (liveGate.shape === "free-text") {
            const outputName = derived.pendingGate.outputArtifactName;
            if (outputName === undefined) {
              throw new Error(
                "application: a free-text gate has no declared output artifact name.",
              );
            }
            publishGateAttemptOrThrow(
              observed.publishAttempt({
                attemptId: input.gate.attemptId,
                outcome: "succeeded",
                required: [{ name: outputName, type: "text" }],
                outputs: [
                  {
                    name: outputName,
                    type: "text",
                    content: new TextEncoder().encode(input.text!),
                  },
                ],
                at: new Date(),
                advanceState: "running",
              }),
            );
          } else {
            const reject = input.answer === "stop";
            publishGateAttemptOrThrow(
              observed.publishAttempt({
                attemptId: input.gate.attemptId,
                outcome: reject ? "failed" : "succeeded",
                required: [],
                outputs: [],
                at: new Date(),
                advanceState: reject ? "failed" : "running",
              }),
            );
            if (reject) {
              leaveClaimLive = false;
              return { status: "applied" };
            }
          }
          // approve or free-text: drive the resumed Run to its next rest in this process.
          const report = await executeTrackedRouting({
            runId: input.runId,
            tracking: activeTracking,
            owner: activeOwner,
            executionOwner: observed,
            routing: facts.routing,
            digest: record.bundleSnapshotDigest,
          });
          leaveClaimLive = report.outcome === "blocked";
          return { status: "applied" };
        }

        // A derived Review checkpoint: the M2 continue/stop path (unchanged, #85).
        // The cumulative iteration count this grant/stop resets from: the prior grant
        // offset plus the iterations completed since it.
        const answer = input.answer!;
        const priorOffset =
          priorAnswers.length === 0
            ? 0
            : priorAnswers[priorAnswers.length - 1]!.iterationsAtGrant;
        const iterationsAtGrant =
          priorOffset + (derived.checkpoint?.completedIterations ?? 0);
        const recorded = observed.recordGateAnswer({
          operationId,
          gateAttemptId: input.gate.attemptId,
          answer,
          iterationsAtGrant,
          artifactName: GATE_ANSWER_ARTIFACT,
          at: new Date(),
          ...(answer === "stop" ? { advanceState: "failed" } : {}),
        });
        if (!recorded.ok) {
          throw new Error(
            "reason" in recorded
              ? `cannot record the gate answer: ${recorded.reason}`
              : `cannot record the gate answer: ${recorded.problem.kind}`,
          );
        }
        if (answer === "stop") {
          leaveClaimLive = false;
          return { status: "applied" };
        }
        // `continue`: the answering process drives the granted interval to rest.
        const report = await executeTrackedRouting({
          runId: input.runId,
          tracking: activeTracking,
          owner: activeOwner,
          executionOwner: observed,
          routing: facts.routing,
          digest: record.bundleSnapshotDigest,
        });
        leaveClaimLive = report.outcome === "blocked";
        return { status: "applied" };
      },
      retainOwner: () => leaveClaimLive,
      setRetainOwner: (retain) => {
        leaveClaimLive = retain;
      },
    });
  }

  // Answer one outstanding approval Harness Request on a live Agent Turn (#117).
  // Admitted at once; the answer reaches the live Turn at settle time (inline by
  // default, so a headless follower's answer unblocks the Turn promptly). The
  // request is ephemeral — never durable — so a Turn that already ended, a stale
  // generation, or an id no longer outstanding is refused precisely and answers
  // nothing. Idempotent per operation id via the operations map.
  function submitAnswerHarnessRequest(
    operationId: string,
    input: AnswerHarnessRequestInput,
  ): SubmissionAdmission {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.replayKey === answerHarnessRequestReplayKey(input)) {
        return { admitted: true, operationId, runId: input.runId };
      }
      return { admitted: false, problem: operationIdReused(operationId) };
    }
    if (runGroup === undefined) {
      return { admitted: false, problem: runSupportUnavailable() };
    }
    operations.set(operationId, {
      replayKey: answerHarnessRequestReplayKey(input),
      outcome: { status: "pending" },
      observers: new Set<UpdateStream>(),
      runId: input.runId,
      settle: () => answerHarnessRequest(input),
    });
    scheduleSettlement(() => settleOperation(operationId));
    return { admitted: true, operationId, runId: input.runId };
  }

  // Route one answer to the live Turn's control (#117): accepted settles the
  // Operation `applied`; a stale generation, an expired id, or a control race
  // (`expired`/`already-settled`/`shape-mismatch`) settles `not-applied` with the
  // precise Problem — the answer's provenance (`by`) is carried to the durable
  // `request-answered` timeline record by execution.
  async function answerHarnessRequest(
    input: AnswerHarnessRequestInput,
  ): Promise<OperationOutcome> {
    const tracking = runs.get(input.runId);
    if (
      tracking === undefined ||
      tracking.done ||
      tracking.live.answer === undefined ||
      !tracking.live.outstanding.has(input.requestId)
    ) {
      return {
        status: "not-applied",
        problem: harnessRequestExpired(input.runId, input.requestId),
      };
    }
    if (input.generation !== tracking.live.generation) {
      return {
        status: "not-applied",
        problem: harnessRequestStale(
          input.runId,
          input.generation,
          tracking.live.generation,
        ),
      };
    }
    const result = await tracking.live.answer(
      input.requestId,
      input.decision,
      input.by,
    );
    if (result.outcome === "rejected") {
      return {
        status: "not-applied",
        problem: harnessRequestRejected(
          input.runId,
          input.requestId,
          result.reason,
        ),
      };
    }
    if (result.outcome === "indeterminate") {
      return {
        status: "not-applied",
        problem: harnessRequestIndeterminate(input.runId, input.requestId),
      };
    }
    return { status: "applied" };
  }

  // Interrupt the live Turn of a running Run (#118). Admitted at once; the
  // interrupt is relayed at settle time (deferred, since it must await the Run's
  // `halted` rest). Idempotent per operation id.
  function submitInterruptTurn(
    operationId: string,
    input: InterruptTurnInput,
  ): SubmissionAdmission {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.replayKey === interruptTurnReplayKey(input)) {
        return { admitted: true, operationId, runId: input.runId };
      }
      return { admitted: false, problem: operationIdReused(operationId) };
    }
    if (runGroup === undefined) {
      return { admitted: false, problem: runSupportUnavailable() };
    }
    operations.set(operationId, {
      replayKey: interruptTurnReplayKey(input),
      outcome: { status: "pending" },
      observers: new Set<UpdateStream>(),
      runId: input.runId,
      settle: () => interruptTurnAndSettle(input),
    });
    scheduleSettlement(() => settleOperation(operationId));
    return { admitted: true, operationId, runId: input.runId };
  }

  // Relay the Harness Adapter's interrupt to the live Turn: abort the Run's
  // execution (which the Agent executor translates into `turn.interrupt()`), then
  // await the `halted` rest the interrupted Turn's `cancelled`/`indeterminate`
  // Attempt writes through the still-held owner (#118). A Run that is not live in
  // this process, or whose named Turn already settled, has no live control to make:
  // it is rejected as a value, exactly the after-acceptance case the spec names.
  function interruptTurnAndSettle(
    input: InterruptTurnInput,
  ): OperationOutcome | Promise<OperationOutcome> {
    const rejected: OperationOutcome = {
      status: "not-applied",
      problem: turnControlRejected(input.runId, "interrupt-turn", input.turnId),
    };
    const tracking = runs.get(input.runId);
    const owner =
      tracking !== undefined && !tracking.done ? tracking.owner : undefined;
    const promise = tracking?.done === false ? tracking.promise : undefined;
    if (
      tracking === undefined ||
      owner === undefined ||
      promise === undefined
    ) {
      return rejected;
    }
    // The Turn the control targets must be the one live generation: the single
    // admitted Turn with no settled result. A control naming any other Turn is stale.
    const live = owner.turns().find((turn) => turn.resultKind === undefined);
    if (live === undefined || live.turnId !== input.turnId) {
      return rejected;
    }
    tracking.abort.abort(INTERRUPT_TURN_ABORT);
    return promise.then(() => {
      // Execution rested the Run `halted` (the interrupted Turn's Attempt) and
      // released the owner in its finally; the interrupt itself is applied.
      return { status: "applied" };
    });
  }

  // Steer the live Turn (#118). M3 has no available steer Adapter, so a submission
  // is rejected as a value with the recorded profile evidence — never emulated.
  function submitSteerTurn(
    operationId: string,
    input: SteerTurnInput,
  ): SubmissionAdmission {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.replayKey === steerTurnReplayKey(input)) {
        return { admitted: true, operationId, runId: input.runId };
      }
      return { admitted: false, problem: operationIdReused(operationId) };
    }
    if (runGroup === undefined) {
      return { admitted: false, problem: runSupportUnavailable() };
    }
    operations.set(operationId, {
      replayKey: steerTurnReplayKey(input),
      outcome: { status: "pending" },
      observers: new Set<UpdateStream>(),
      runId: input.runId,
      settle: (): OperationOutcome => {
        const tracking = runs.get(input.runId);
        const evidence =
          tracking?.steer?.evidence ??
          tracking?.owner?.harnessIdentity()?.steer?.evidence;
        return {
          status: "not-applied",
          problem: steerUnavailable(
            input.runId,
            evidence ??
              "No recorded Harness profile evidence permits same-Turn steer.",
          ),
        };
      },
    });
    scheduleSettlement(() => settleOperation(operationId));
    return { admitted: true, operationId, runId: input.runId };
  }

  // --- Interactive-agent turn-taking (#122) --------------------------------
  //
  // An interactive-agent Step rests the Run `blocked` and hands its Session to the
  // human. `send-interactive-turn` drives one human Turn against that Session (the
  // Run stays blocked between Turns); `end-interactive-step` settles the Step's
  // Attempt `succeeded` at a Turn boundary and advances the Run. Both reuse the M2
  // blocked-under-owner machinery: the owner is held through `blocked`, so a Turn
  // drives against the held owner; a reopened blocked Run is resumed and re-acquired
  // like the answer path (ADR 0031). Neither branches on Bundle identity.

  /** Claim the owner of a Run blocked at the named interactive-agent Step and prove
   *  the Run currently rests there (#122). Reuses the held owner when the Run is live
   *  in this process; otherwise resumes and acquires it and creates a tracking entry,
   *  mirroring the answer path. Returns everything a Turn or End needs, or a Problem. */
  function beginInteractive(
    runId: string,
    stepId: string,
  ): InteractiveContext | { readonly problem: Problem } {
    if (runGroup === undefined || runProjection === undefined) {
      return { problem: runSupportUnavailable() };
    }
    const read = runGroup.readRun(runId);
    if (!read.ok) {
      return {
        problem:
          read.problem.kind === "unknown-run"
            ? runNotFound(runId)
            : runStoreDamaged(runId),
      };
    }
    const record = read.run;
    const foreign = liveElsewhere(runId);
    if (foreign !== undefined) {
      return { problem: runLiveElsewhere(runId, foreign.ownerPid) };
    }
    const derivedFacts = deriveRunFacts(
      runProjection,
      record.bundleSnapshotDigest,
    );
    if ("problem" in derivedFacts) return { problem: derivedFacts.problem };
    const facts = derivedFacts.facts;
    const step = flattenSteps(facts.routing).find(
      (candidate): candidate is AgentStep =>
        candidate.id === stepId && candidate.kind === "interactive-agent",
    );
    if (step === undefined) {
      return { problem: interactiveStepNotActive(runId, stepId, record.state) };
    }
    // Reject a clearly non-blocked record before touching coordination, so acting on
    // a Run that is not blocked toggles no claim and bumps no epoch. (A `running`
    // record still needs the owner to tell blocked from a live mid-execution Run.)
    if (
      record.state !== "blocked" &&
      record.state !== "running" &&
      record.state !== "created"
    ) {
      return { problem: interactiveStepNotActive(runId, stepId, record.state) };
    }
    let tracking = runs.get(runId);
    let owner =
      tracking !== undefined && !tracking.done ? tracking.owner : undefined;
    const ownershipWasHeld = owner !== undefined;
    if (owner === undefined) {
      const claim = runGroup.resumeRun(runId);
      if (claim.outcome === "run-live-elsewhere") {
        return { problem: runLiveElsewhere(runId, claim.ownerPid) };
      }
      if (claim.outcome === "unknown-run") {
        return { problem: runNotFound(runId) };
      }
      owner = runGroup.acquireRun(runId);
      if (owner === undefined) return { problem: runStoreDamaged(runId) };
      tracking = {
        digest: record.bundleSnapshotDigest,
        routing: facts.routing,
        name: facts.name,
        id: facts.id,
        version: facts.version,
        state: record.state,
        owner,
        done: false,
        abort: new AbortController(),
        observers: observersForRun(runId),
        live: liveOverlay.fresh(),
      };
      runs.set(runId, tracking);
    }
    if (tracking === undefined || owner === undefined) {
      return { problem: runStoreDamaged(runId) };
    }
    if (
      upgradeLegacyHarnessSelection(owner, facts.routing, runId) === "fenced"
    ) {
      if (!ownershipWasHeld) {
        tracking.owner = undefined;
        tracking.done = true;
        owner.release();
        owner.close();
        runs.delete(runId);
      }
      return { problem: runStoreDamaged(runId) };
    }
    // Confirm the Run derives to `blocked` at this exact interactive Step — not a
    // derived checkpoint, an authored gate, or a Step it has moved past.
    const derived = deriveRun(
      facts.routing,
      owner.attemptLog(),
      record.state,
      runId,
      owner,
      owner.gateAnswers(),
    );
    const current = derived.statuses[derived.position];
    // `blocked` is the boundary (between Turns); `running` is a live human Turn, which
    // runs under `running` so a crash reconciles it via the #118 path (#122). Both are
    // "at the Step"; the caller's Turn-live check then tells a boundary from a live Turn.
    const atStep =
      (derived.state === "blocked" || derived.state === "running") &&
      derived.checkpoint === undefined &&
      derived.pendingGate === undefined &&
      current?.id === stepId &&
      current.kind === "interactive-agent";
    if (!atStep) {
      // Release an owner freshly acquired for this refusal; a held owner stays live.
      if (!ownershipWasHeld) {
        tracking.owner = undefined;
        tracking.done = true;
        owner.release();
        owner.close();
        runs.delete(runId);
      }
      return {
        problem: interactiveStepNotActive(runId, stepId, derived.state),
      };
    }
    return { tracking, owner, ownershipWasHeld, step, record, facts };
  }

  /** Whether a Turn is currently live for this Run: a settlement promise in flight
   *  here, or an admitted Turn with no settled result. */
  function interactiveTurnLive(tracking: TrackedRun, owner: RunOwner): boolean {
    return (
      tracking.promise !== undefined ||
      owner.turns().some((turn) => turn.resultKind === undefined)
    );
  }

  // Send one human Turn to the interactive-agent Step the Run is blocked at (#122).
  // Blank/whitespace-only text is refused at admission, before any stdin is sent.
  function submitSendInteractiveTurn(
    operationId: string,
    input: SendInteractiveTurnInput,
  ): SubmissionAdmission {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.replayKey === sendInteractiveTurnReplayKey(input)) {
        return { admitted: true, operationId, runId: input.runId };
      }
      return { admitted: false, problem: operationIdReused(operationId) };
    }
    if (
      runGroup === undefined ||
      prepareRunInteractiveStep === undefined ||
      runProjection === undefined
    ) {
      return { admitted: false, problem: runSupportUnavailable() };
    }
    // Secant authors nothing: a blank Turn is refused before it is admitted, so no
    // Turn is recorded and no stdin is ever written (AC1).
    if (input.text.trim() === "") {
      return { admitted: false, problem: interactiveTurnBlank(input.runId) };
    }
    operations.set(operationId, {
      replayKey: sendInteractiveTurnReplayKey(input),
      outcome: { status: "pending" },
      observers: new Set<UpdateStream>(),
      runId: input.runId,
      settle: () => startSendInteractiveTurn(operationId, input),
    });
    scheduleSettlement(() => settleOperation(operationId));
    return { admitted: true, operationId, runId: input.runId };
  }

  // Decide send synchronously, then run the Turn asynchronously. A refusal (support
  // unavailable, not blocked at the Step, or a Turn already live) returns WITHOUT
  // setting `tracking.promise`, so it never clobbers a genuinely live Turn's promise —
  // the signal cancel-run/interrupt-turn read to know when the Run has actually rested.
  // Only the going-live path records the promise, mirroring `startRun`'s guard.
  function startSendInteractiveTurn(
    operationId: string,
    input: SendInteractiveTurnInput,
  ): Promise<OperationOutcome> {
    if (
      runGroup === undefined ||
      prepareRunInteractiveStep === undefined ||
      runProjection === undefined
    ) {
      return Promise.resolve({
        status: "not-applied",
        problem: runSupportUnavailable(),
      });
    }
    const begun = beginInteractive(input.runId, input.stepId);
    if ("problem" in begun) {
      return Promise.resolve({ status: "not-applied", problem: begun.problem });
    }
    // One Turn at a time: a live Turn refuses a new one as a value (the offer is
    // suppressed then). Checked here, so the refusal leaves `tracking.promise` intact.
    if (interactiveTurnLive(begun.tracking, begun.owner)) {
      return Promise.resolve({
        status: "not-applied",
        problem: interactiveTurnBusy(input.runId),
      });
    }
    const promise = runInteractiveSend(operationId, input, begun);
    begun.tracking.promise = promise;
    return promise;
  }

  async function runInteractiveSend(
    operationId: string,
    input: SendInteractiveTurnInput,
    begun: InteractiveContext,
  ): Promise<OperationOutcome> {
    const { tracking, owner, step } = begun;
    const attemptId = interactiveStepAttemptId(step.id);
    const turnId = `${attemptId}#human:${operationId}`;
    const observed = observedOwner(owner, input.runId);
    // The Run stays `blocked` between Turns, so the claim is retained on the normal
    // path; only an interrupt/cancel releases it.
    let leaveClaimLive = true;
    return driveWithAbortProtocol({
      runId: input.runId,
      tracking,
      owner,
      drive: async () => {
        if (tracking.interactiveStep === undefined) {
          tracking.interactiveStep = await prepareRunInteractiveStep!({
            owner,
          });
          tracking.steer = tracking.interactiveStep.steer;
        }
        // A live human Turn is running work, so the Run reads `running` while it runs and
        // returns to `blocked` at the next boundary. This is what makes a crash mid-Turn
        // reconcile through the #118 path (a `running` record with an unsettled Turn is
        // rested `halted`, its Session detached), rather than strand the Run blocked with
        // a Turn that can never settle (#122).
        observed.writeState("running");
        const report = await tracking.interactiveStep.turn({
          runId: input.runId,
          owner,
          session: step.session,
          attemptId,
          turnId,
          text: input.text,
          cancelSignal: tracking.abort.signal,
          requestChannel: liveOverlay.requestChannel(input.runId),
        });
        if (report.outcome === "interrupted" || report.outcome === "lost") {
          // An interrupt-turn (or OS signal) stopped the human Turn: rest the Run
          // `halted`, resumable, through the held owner so observers see it (#118).
          observed.writeState("halted");
          leaveClaimLive = false;
          return { status: "applied" };
        }
        // completed or failed: the Turn is recorded; back to the boundary for the next
        // Turn. `writeState` pushes the fresh snapshot (with the new transcript entry),
        // which the Turn's own writes bypass observedOwner and would not push.
        observed.writeState("blocked");
        return { status: "applied" };
      },
      retainOwner: () => leaveClaimLive,
      setRetainOwner: (retain) => {
        leaveClaimLive = retain;
      },
    });
  }

  // End the interactive-agent Step the Run is blocked at (#122). Admitted at once;
  // at settle time it is refused mid-Turn, else it settles the Step's Attempt
  // succeeded and drives the Run to its next rest. Idempotent per operation id.
  function submitEndInteractiveStep(
    operationId: string,
    input: EndInteractiveStepInput,
  ): SubmissionAdmission {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.replayKey === endInteractiveStepReplayKey(input)) {
        return { admitted: true, operationId, runId: input.runId };
      }
      return { admitted: false, problem: operationIdReused(operationId) };
    }
    if (
      runGroup === undefined ||
      runExecution === undefined ||
      runProjection === undefined
    ) {
      return { admitted: false, problem: runSupportUnavailable() };
    }
    operations.set(operationId, {
      replayKey: endInteractiveStepReplayKey(input),
      outcome: { status: "pending" },
      observers: new Set<UpdateStream>(),
      runId: input.runId,
      settle: () => startEndInteractiveStep(input),
    });
    scheduleSettlement(() => settleOperation(operationId));
    return { admitted: true, operationId, runId: input.runId };
  }

  // Decide End synchronously (as send does), so a refusal — support unavailable, not
  // at the Step, or mid-Turn — never overwrites a live Turn's `tracking.promise`.
  function startEndInteractiveStep(
    input: EndInteractiveStepInput,
  ): Promise<OperationOutcome> {
    if (
      runGroup === undefined ||
      runExecution === undefined ||
      runProjection === undefined
    ) {
      return Promise.resolve({
        status: "not-applied",
        problem: runSupportUnavailable(),
      });
    }
    const begun = beginInteractive(input.runId, input.stepId);
    if ("problem" in begun) {
      return Promise.resolve({ status: "not-applied", problem: begun.problem });
    }
    // End Step is admitted only at a Turn boundary: a live Turn refuses it precisely,
    // changing nothing (AC1). Checked here, so the refusal leaves the live Turn's
    // `tracking.promise` intact.
    if (interactiveTurnLive(begun.tracking, begun.owner)) {
      return Promise.resolve({
        status: "not-applied",
        problem: interactiveStepMidTurn(input.runId, begun.step.id),
      });
    }
    const promise = runInteractiveEnd(input, begun);
    begun.tracking.promise = promise;
    return promise;
  }

  async function runInteractiveEnd(
    input: EndInteractiveStepInput,
    begun: InteractiveContext,
  ): Promise<OperationOutcome> {
    const { tracking, owner, record, facts, step } = begun;
    const observed = observedOwner(owner, input.runId);
    const attemptId = interactiveStepAttemptId(step.id);
    let leaveClaimLive = false;
    return driveWithAbortProtocol({
      runId: input.runId,
      tracking,
      owner,
      drive: async () => {
        await closeInteractiveStep(tracking);
        // Settle the interactive Step's Attempt succeeded (no outputs — an Agent Step
        // produces no Artifacts in M3), then drive the Run to its next rest. The empty
        // succeeded Attempt stages no commit (store/AGENTS), and a resume skips the Step.
        publishGateAttemptOrThrow(
          observed.publishAttempt({
            attemptId,
            outcome: "succeeded",
            required: [],
            outputs: [],
            at: new Date(),
            advanceState: "running",
          }),
        );
        const report = await executeTrackedRouting({
          runId: input.runId,
          tracking,
          owner,
          executionOwner: observed,
          routing: facts.routing,
          digest: record.bundleSnapshotDigest,
        });
        leaveClaimLive = report.outcome === "blocked";
        return { status: "applied" };
      },
      retainOwner: () => leaveClaimLive,
      setRetainOwner: (retain) => {
        leaveClaimLive = retain;
      },
    });
  }

  // Cancel a live Run (#87). Admitted at once; the cancel is decided and applied
  // at settle time (inline by default). Idempotent per operation id via the
  // operations map.
  function submitCancel(
    operationId: string,
    runId: string,
  ): SubmissionAdmission {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.replayKey === cancelReplayKey(runId)) {
        return { admitted: true, operationId, runId };
      }
      return { admitted: false, problem: operationIdReused(operationId) };
    }
    if (runGroup === undefined) {
      return { admitted: false, problem: runSupportUnavailable() };
    }
    operations.set(operationId, {
      replayKey: cancelReplayKey(runId),
      outcome: { status: "pending" },
      observers: new Set<UpdateStream>(),
      runId,
      settle: () => cancelAndSettle(runId),
    });
    scheduleSettlement(() => settleOperation(operationId));
    return { admitted: true, operationId, runId };
  }

  // Rest a live Run `cancelled` — the only route to that terminal state (#87, #98).
  // A Run live in THIS process is cancelled as an abort: stop its execution, then
  // await the `cancelled` rest the execution promise writes through the owner it
  // still holds. A non-live blocked Run is acquired, rested cancelled, and
  // released: blocked remains resumable work after its prior owner is gone. A Run
  // live in ANOTHER process is cancelled by the fresh-owner
  // epoch-bump trick, which fences the stale owner so its next canonical write is
  // refused (execution stops), then records `cancelled` and releases the claim,
  // every Artifact intact. Other resting Runs have no cancel to make.
  function cancelAndSettle(
    runId: string,
  ): OperationOutcome | Promise<OperationOutcome> {
    if (runGroup === undefined) {
      return { status: "not-applied", problem: runSupportUnavailable() };
    }
    const tracking = runs.get(runId);
    if (
      tracking !== undefined &&
      !tracking.done &&
      tracking.owner !== undefined &&
      tracking.promise === undefined
    ) {
      const owner = tracking.owner;
      return cancelOwnedBlockedRun(runId, tracking, owner);
    }
    if (
      tracking !== undefined &&
      !tracking.done &&
      tracking.owner !== undefined &&
      tracking.promise !== undefined
    ) {
      // Live in this process: abort execution (killing its child) and await the
      // `cancelled` rest runAndSettle writes and pushes. runAndSettle owns the owner
      // close and claim release, so nothing here fences its owner. `owner` and
      // `promise` are set inside the same synchronous prefix (see startRun), so
      // requiring both never drops a genuine in-process cancel to the fence path; it
      // only keeps the abort from resolving `applied` against a Run whose settlement
      // promise is not yet captured.
      const promise = tracking.promise;
      tracking.abort.abort(CANCEL_ABORT);
      return promise.then(() => {
        runs.delete(runId);
        return { status: "applied" };
      });
    }
    // Live elsewhere (or not tracked here): fence the stale owner and rest it. This
    // is a deliberate takeover — cancel force-rests a Run whichever process owns it —
    // so acquire with `takeover` to fence a live owner rather than be declined.
    try {
      const listing = runGroup.listRuns().find((run) => run.runId === runId);
      if (listing === undefined) {
        return { status: "not-applied", problem: runNotFound(runId) };
      }
      if (!listing.live) {
        const read = runGroup.readRun(runId);
        if (!read.ok) {
          return {
            status: "not-applied",
            problem:
              read.problem.kind === "unknown-run"
                ? runNotFound(runId)
                : runStoreDamaged(runId),
          };
        }
        if (read.run.state !== "blocked") {
          return { status: "not-applied", problem: runNotLive(runId) };
        }
        const owner = runGroup.acquireRun(runId);
        if (owner === undefined) {
          return { status: "not-applied", problem: runStoreDamaged(runId) };
        }
        try {
          observedOwner(owner, runId).writeState("cancelled");
          owner.release();
        } finally {
          owner.close();
        }
        pushRunUpdate(runId);
        runs.delete(runId);
        return { status: "applied" };
      }
      const owner = runGroup.acquireRun(runId, { takeover: true });
      if (owner === undefined) {
        return { status: "not-applied", problem: runStoreDamaged(runId) };
      }
      try {
        // Our epoch is the freshest, so this write is not fenced. A concurrent
        // second cancel is the only actor that could fence it, and it is resting the
        // same Run cancelled too, so the outcome is unchanged either way.
        observedOwner(owner, runId).writeState("cancelled");
        owner.release();
      } finally {
        owner.close();
      }
      pushRunListUpdates();
      runs.delete(runId);
      return { status: "applied" };
    } catch {
      // A malformed coordination row (listRuns) or a store fault settles here, the
      // way run/answer route an execution fault, so nothing throws out of submit (A4).
      return { status: "not-applied", problem: runStoreDamaged(runId) };
    }
  }

  async function cancelOwnedBlockedRun(
    runId: string,
    tracking: TrackedRun,
    owner: RunOwner,
  ): Promise<OperationOutcome> {
    observedOwner(owner, runId).writeState("cancelled");
    try {
      await closeInteractiveStep(tracking);
    } finally {
      tracking.owner = undefined;
      tracking.done = true;
      try {
        owner.release();
      } finally {
        owner.close();
        pushRunUpdate(runId);
        runs.delete(runId);
      }
    }
    return { status: "applied" };
  }

  // Delete a resting or terminal Run (#87). Admitted at once; applied at settle
  // time through the Run Store's admitted delete, which is idempotent per
  // operation id and a no-op on an absent Run.
  function submitDelete(
    operationId: string,
    runId: string,
  ): SubmissionAdmission {
    const existing = operations.get(operationId);
    if (existing !== undefined) {
      if (existing.replayKey === deleteReplayKey(runId)) {
        return { admitted: true, operationId, runId };
      }
      return { admitted: false, problem: operationIdReused(operationId) };
    }
    if (runGroup === undefined) {
      return { admitted: false, problem: runSupportUnavailable() };
    }
    operations.set(operationId, {
      replayKey: deleteReplayKey(runId),
      outcome: { status: "pending" },
      observers: new Set<UpdateStream>(),
      runId,
      settle: () => deleteAndSettle(operationId, runId),
    });
    scheduleSettlement(() => settleOperation(operationId));
    return { admitted: true, operationId, runId };
  }

  function deleteAndSettle(
    operationId: string,
    runId: string,
  ): OperationOutcome {
    if (runGroup === undefined) {
      return { status: "not-applied", problem: runSupportUnavailable() };
    }
    try {
      return applyDelete(runGroup, operationId, runId);
    } catch {
      // A malformed coordination row (listRuns) or a store fault settles here, so
      // nothing throws out of submit (A4).
      return { status: "not-applied", problem: runStoreDamaged(runId) };
    }
  }

  function applyDelete(
    runGroup: RunGroup,
    operationId: string,
    runId: string,
  ): OperationOutcome {
    // A live Run cannot be deleted (its store is in use); cancel it first.
    // ponytail: this liveness check is not transactional with the store delete,
    // and the Run Store's admitted delete deliberately does not re-check the claim
    // (it deletes any Run, live or not). So a Run that a *different process* resumes
    // in the window between this check and the delete could have its store removed
    // out from under it — a cross-process race that M2's one-command-per-process
    // usage does not hit. Close it by deciding liveness inside `admitDelete` under
    // its BEGIN IMMEDIATE lock (as create/resume do) if concurrent delete/resume
    // ever races.
    const listing = runGroup.listRuns().find((run) => run.runId === runId);
    if (listing?.live === true) {
      return { status: "not-applied", problem: runIsLive(runId) };
    }
    // The admitted delete drops the registration then reclaims the store under a
    // `.deleting` quarantine; idempotent per operation id, and re-deleting a Run
    // already gone still settles applied.
    runGroup.deleteRun({ operationId, runId });
    // Tell any observer its subject is gone before the tracking entry is dropped (#98).
    pushRunClosed(runId);
    runs.delete(runId);
    return { status: "applied" };
  }

  // Acquire an owner for a read (`readResource`/`readTranscript`): read through
  // the live in-process owner when one exists (so the read never fences it), else
  // acquire-and-close a rested Run, else refuse a Run live in another process
  // (acquiring would bump its fencing epoch and abort it). `transient` says the
  // caller must close the owner it was handed.
  function acquireForRead(runId: string):
    | {
        readonly ok: true;
        readonly owner: RunOwner;
        readonly transient: boolean;
      }
    | { readonly ok: false; readonly problem: Problem } {
    if (runGroup === undefined) {
      return { ok: false, problem: runSupportUnavailable() };
    }
    const live = runs.get(runId)?.owner;
    const foreign = live === undefined ? liveElsewhere(runId) : undefined;
    if (foreign !== undefined) {
      return { ok: false, problem: runLiveElsewhere(runId, foreign.ownerPid) };
    }
    const owner = live ?? runGroup.acquireRun(runId);
    if (owner === undefined) {
      return { ok: false, problem: runStoreDamaged(runId) };
    }
    return { ok: true, owner, transient: live === undefined };
  }

  const projectionPort: ProjectionPort = {
    openProjection,
    submit(submission: Submission): SubmissionAdmission {
      // Admit at once and record `pending`; settlement is scheduled (inline by
      // default, deferred under a test) and publishes the outcome then.
      switch (submission.operation) {
        case "approve-workspace":
          return submitApprove(submission.operationId, submission.input);
        case "launch-run":
          return submitLaunch(submission.operationId, submission.input);
        case "resume-run":
          return submitResume(submission.operationId, submission.input);
        case "answer-human-gate":
          return submitAnswer(submission.operationId, submission.input);
        case "answer-harness-request":
          return submitAnswerHarnessRequest(
            submission.operationId,
            submission.input,
          );
        case "interrupt-turn":
          return submitInterruptTurn(submission.operationId, submission.input);
        case "steer-turn":
          return submitSteerTurn(submission.operationId, submission.input);
        case "send-interactive-turn":
          return submitSendInteractiveTurn(
            submission.operationId,
            submission.input,
          );
        case "end-interactive-step":
          return submitEndInteractiveStep(
            submission.operationId,
            submission.input,
          );
        case "cancel-run":
          return submitCancel(submission.operationId, submission.input.runId);
        case "delete-run":
          return submitDelete(submission.operationId, submission.input.runId);
      }
    },

    readResource(
      reference: ResourceReference | DiagnosticReference,
    ): ResourceRead {
      const acquired = acquireForRead(reference.runId);
      if (!acquired.ok) return { found: false, problem: acquired.problem };
      const { owner, transient } = acquired;
      try {
        const bytes =
          reference.type === "diagnostic"
            ? owner.readDiagnostic(reference.diagnosticId)
            : owner.readArtifact(reference.versionId, reference.artifactName);
        if (bytes === undefined) {
          return {
            found: false,
            problem:
              reference.type === "diagnostic"
                ? runDiagnosticMissing(reference)
                : runOutputMissing(reference),
          };
        }
        return {
          found: true,
          type: reference.type,
          content: new TextDecoder().decode(bytes),
        };
      } finally {
        if (transient) owner.close();
      }
    },

    readTranscript(
      reference: TranscriptPageReference | TranscriptExportReference,
    ): TranscriptRead {
      const acquired = acquireForRead(reference.runId);
      if (!acquired.ok) return { found: false, problem: acquired.problem };
      const { owner, transient } = acquired;
      try {
        return readTranscriptResource(owner, reference);
      } finally {
        if (transient) owner.close();
      }
    },
  };

  async function shutdown(): Promise<void> {
    // Abort every Run live in this process, then await each settlement so its child
    // is dead and its store is consistent before teardown. Each aborts with the
    // signal reason, so runAndSettle leaves the claim live for the next open to
    // reconcile `halted` (ADR 0019, #98). Filter on `promise` (set in the same
    // synchronous prefix that sets `owner`), so the set aborted is exactly the set
    // awaited — shutdown never resolves before a live Run's settlement it aborted.
    const blocked = [...runs.entries()].filter(
      ([, tracking]) =>
        !tracking.done &&
        tracking.promise === undefined &&
        tracking.owner !== undefined &&
        tracking.state === "blocked",
    );
    for (const [runId, tracking] of blocked) {
      const owner = tracking.owner!;
      // A blocked rest is durable pending work, not interrupted execution. Keep
      // the state and release only ownership so the gate remains answerable after
      // restart (ADR 0031's shutdown rule, #134 A21).
      try {
        await closeInteractiveStep(tracking);
      } finally {
        tracking.owner = undefined;
        tracking.done = true;
        try {
          owner.release();
        } finally {
          owner.close();
          pushRunUpdate(runId);
        }
      }
    }
    const live = [...runs.values()].filter(
      (tracking) => !tracking.done && tracking.promise !== undefined,
    );
    for (const tracking of live) tracking.abort.abort(SIGNAL_ABORT);
    await Promise.all(
      live.map((tracking) => tracking.promise!.catch(() => undefined)),
    );
  }

  return {
    projectionPort,
    shutdown,
    bundleManagement: createBundleManagement({
      catalog,
      budgets: bundleCatalog.budgets,
      onInstalled() {
        // A fresh install changes the list; push the new snapshot to observers.
        if (bundleCatalogObservers.size === 0) return;
        const snapshot = listSnapshot(bundleCatalog);
        for (const observer of bundleCatalogObservers) {
          observer.push({ kind: "durable", snapshot });
        }
      },
    }),
  };
}

function gateEquals(a: RunGateReference, b: RunGateReference): boolean {
  return (
    a.runId === b.runId &&
    a.stepId === b.stepId &&
    a.attemptId === b.attemptId &&
    a.shape === b.shape
  );
}

/** Settle an authored gate's producing Attempt (#108). A fenced owner or an
 *  unstageable answer is a coordination/environment fault the answer use case
 *  owns; a replay of an already-settled gate remains a silent no-op. */
function publishGateAttemptOrThrow(
  result: ReturnType<RunOwner["publishAttempt"]>,
): void {
  if (result.ok) return;
  throw new Error(
    "reason" in result
      ? `cannot settle the gate answer: ${result.reason}`
      : `cannot settle the gate answer: ${result.problem.kind}`,
  );
}
