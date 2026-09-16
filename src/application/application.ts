import { realpathSync } from "node:fs";
import { z } from "zod";
import {
  DEFAULT_BUDGETS,
  inspectBundle,
  type Budgets,
} from "../bundle/bundle.js";
import type { Catalog } from "../catalog/catalog.js";
import type {
  AuthoredManifest,
  Platform,
  RoutingNode,
} from "../workflow/workflow.js";
import type { RunReport } from "../run/execution/execution.js";
import type { RunGroup, RunOwner } from "../run/store/store.js";
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
  type RunProjectionDependencies,
} from "./run-projection.js";
import {
  bundleBytesCorrupt,
  bundleBytesMissing,
  bundleTrustRequired,
  gateShapeMismatch,
  gateStale,
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
  trustDigestMismatch,
  workspaceNotApproved,
} from "./problems.js";
import { UpdateStream } from "./update-stream.js";
import { listRunsSnapshot } from "./run-list.js";
import { preflight } from "./preflight.js";
import type {
  AnswerHumanGateInput,
  BundleCatalogSnapshot,
  BundleFocusSelector,
  BundleFocusSnapshot,
  LaunchRunInput,
  ResumeRunInput,
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
}) => Promise<RunReport>;

// Why a live Run's execution was aborted (#98). A `cancel-run` rests the Run
// `cancelled`; a process signal (SIGINT/SIGHUP/SIGTERM) leaves the Workspace claim
// live so the next open reconciles the Run `halted` via the indeterminate path
// (ADR 0019). The Application reads its own AbortController's reason to tell them
// apart, so it never needs to import the execution `RunCancelledError` — an aborted
// signal is proof enough that our cancel fired.
const CANCEL_ABORT = "secant:cancel-run";
const SIGNAL_ABORT = "secant:process-signal";

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
  /** The clock the `run-list` Projection groups rows by (Today / Yesterday /
   *  Older). Defaults to the wall clock; a test injects a fixed instant (#87). */
  readonly now?: () => Date;
  /** Whether the launching client can relay human turn-taking (#116). Headless
   *  cannot, so it refuses an `interactive-agent` Bundle at Preflight; the TUI sets
   *  this true. Defaults to false. */
  readonly supportsInteractiveTurns?: boolean;
}

export interface Application {
  readonly projectionPort: ProjectionPort;
  readonly bundleManagement: BundleManagement;
  /** Abort every Run live in this process and await its settlement, leaving each
   *  Workspace claim live so the next open reconciles the Run `halted` via the
   *  indeterminate path (ADR 0019, #98). Composition calls this from its OS-signal
   *  handler before teardown, so a killed process never leaves a child running and
   *  the Run recovers on resume. Idempotent and safe when no Run is live. */
  shutdown(): Promise<void>;
}

// Launch inputs are a name→value string map (LaunchInput values are opaque
// strings); the resume path validates the opaque run.db payload against this
// before Preflight (A10).
const launchInputMap = z.record(z.string(), z.string());

export function createApplication(deps: ApplicationDependencies): Application {
  const { catalog, runGroup, runExecution } = deps;
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
  const runs = new Map<
    string,
    {
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
    }
  >();
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
    const settled = entry.settle();
    if (settled instanceof Promise) return settled.then(record);
    record(settled);
  }

  // Push the current Run snapshot to every observer watching this Run. Called
  // after each publication (via the wrapped owner) while the Run is live.
  function pushRunUpdate(runId: string): void {
    if (runProjection === undefined) return;
    const tracking = runs.get(runId);
    if (tracking !== undefined && tracking.observers.size > 0) {
      const snapshot = runSnapshot(runProjection, runId, {
        facts: {
          routing: tracking.routing,
          name: tracking.name,
          id: tracking.id,
          version: tracking.version,
          digest: tracking.digest,
        },
        ...(tracking.owner !== undefined ? { liveOwner: tracking.owner } : {}),
        state: tracking.state,
      });
      for (const observer of tracking.observers) {
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
    const tracking = runs.get(runId);
    if (tracking === undefined) return;
    for (const observer of tracking.observers) {
      observer.push({ kind: "closed", reason: "subject-gone" });
    }
  }

  // Wrap the acquired owner so each canonical write pushes a fresh Run snapshot
  // to observers. Reads delegate to the raw owner unchanged; only the two
  // canonical writes are intercepted, after they commit.
  function observedOwner(owner: RunOwner, runId: string): RunOwner {
    const tracking = runs.get(runId);
    return {
      ...owner,
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
    if (tracking.takeover === true && tracking.state === "blocked") {
      tracking.promise = undefined;
      tracking.done = false;
      pushRunUpdate(runId);
      return { status: "applied" };
    }
    const observed = observedOwner(owner, runId);
    // A signal-abort and a blocked pause retain ownership. Every rested outcome
    // releases it in the finally.
    let leaveClaimLive = false;
    try {
      const report = await runExecution({
        routing: tracking.routing,
        digest: tracking.digest,
        owner: observed,
        cancelSignal: tracking.abort.signal,
      });
      leaveClaimLive = report.outcome === "blocked";
      return { status: "applied" };
    } catch (error) {
      // Our own AbortController firing is the only cause of an execution abort, so
      // an aborted signal — not the error's type — tells apart a cancel/signal from
      // a genuine coordination/environment fault (which keeps the Application
      // execution-agnostic; see RunExecution).
      if (tracking.abort.signal.aborted) {
        if (tracking.abort.signal.reason === CANCEL_ABORT) {
          // cancel-run: rest the Run `cancelled` through the owner still held here,
          // which pushes the terminal snapshot to every open `run` Projection.
          observed.writeState("cancelled");
          return { status: "applied" };
        }
        // A process signal: leave the claim live for reconciliation.
        leaveClaimLive = true;
        return { status: "applied" };
      }
      return {
        status: "not-applied",
        problem: runExecutionFault(runId, error),
      };
    } finally {
      tracking.promise = undefined;
      if (leaveClaimLive) {
        tracking.done = false;
      } else {
        tracking.owner = undefined;
        tracking.done = true;
        owner.release();
        owner.close();
        pushRunUpdate(runId);
      }
    }
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
          },
    );
    // Register for durable updates only while the Run is still live in this
    // process; a settled or foreign Run receives no further publication.
    if (tracking !== undefined && !tracking.done) {
      tracking.observers.add(updates);
      return {
        snapshot,
        catchUp: "fresh",
        updates,
        close() {
          tracking.observers.delete(updates);
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

    const created = runGroup.createRun({
      operationId,
      bundleSnapshotDigest: entry.digest,
      launch: input.launchInputs,
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
      observers: new Set<UpdateStream>(),
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
      observers: new Set<UpdateStream>(),
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
        observers: new Set<UpdateStream>(),
      };
      runs.set(input.runId, tracking);
    }
    if (tracking === undefined || owner === undefined) {
      return { status: "not-applied", problem: runStoreDamaged(input.runId) };
    }
    const activeTracking = tracking;
    const activeOwner = owner;
    // A signal-abort of the granted interval leaves the claim live for the next
    // open to reconcile `halted`; every other exit releases the claim (#98).
    let leaveClaimLive = ownershipWasHeld;
    try {
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
        const report = await runExecution({
          routing: facts.routing,
          digest: record.bundleSnapshotDigest,
          owner: observed,
          cancelSignal: activeTracking.abort.signal,
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
      const report = await runExecution({
        routing: facts.routing,
        digest: record.bundleSnapshotDigest,
        owner: observed,
        cancelSignal: activeTracking.abort.signal,
      });
      leaveClaimLive = report.outcome === "blocked";
      return { status: "applied" };
    } catch (error) {
      // As in runAndSettle: our own abort — not the error's type — distinguishes a
      // cancel/signal from a genuine fault.
      if (activeTracking.abort.signal.aborted) {
        if (activeTracking.abort.signal.reason === CANCEL_ABORT) {
          observedOwner(activeOwner, input.runId).writeState("cancelled");
          leaveClaimLive = false;
          return { status: "applied" };
        }
        leaveClaimLive = true;
        return { status: "applied" };
      }
      return {
        status: "not-applied",
        problem: runExecutionFault(input.runId, error),
      };
    } finally {
      activeTracking.promise = undefined;
      if (leaveClaimLive) {
        activeTracking.done = false;
      } else {
        activeTracking.owner = undefined;
        activeTracking.done = true;
        activeOwner.release();
        activeOwner.close();
        pushRunUpdate(input.runId);
      }
    }
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
  // still holds. A Run live in ANOTHER process is cancelled by the fresh-owner
  // epoch-bump trick, which fences the stale owner so its next canonical write is
  // refused (execution stops), then records `cancelled` and releases the claim,
  // every Artifact intact. A Run that is not live has no cancel to make.
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
      observedOwner(owner, runId).writeState("cancelled");
      tracking.owner = undefined;
      tracking.done = true;
      owner.release();
      owner.close();
      pushRunUpdate(runId);
      runs.delete(runId);
      return { status: "applied" };
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
        return { status: "not-applied", problem: runNotLive(runId) };
      }
      const owner = runGroup.acquireRun(runId, { takeover: true });
      if (owner === undefined) {
        return { status: "not-applied", problem: runStoreDamaged(runId) };
      }
      try {
        // Our epoch is the freshest, so this write is not fenced. A concurrent
        // second cancel is the only actor that could fence it, and it is resting the
        // same Run cancelled too, so the outcome is unchanged either way.
        owner.writeState("cancelled");
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
        case "cancel-run":
          return submitCancel(submission.operationId, submission.input.runId);
        case "delete-run":
          return submitDelete(submission.operationId, submission.input.runId);
      }
    },

    readResource(
      reference: ResourceReference | DiagnosticReference,
    ): ResourceRead {
      if (runGroup === undefined) {
        return { found: false, problem: runSupportUnavailable() };
      }
      // Read through the live owner when the Run is still executing in this
      // process (so the read never fences it); otherwise acquire a short-lived
      // owner and close it. Never acquire for a Run live in another process:
      // acquiring bumps the fencing epoch and would abort the process running it,
      // so refuse the read until the Run rests instead.
      const live = runs.get(reference.runId)?.owner;
      const foreign =
        live === undefined ? liveElsewhere(reference.runId) : undefined;
      if (foreign !== undefined) {
        return {
          found: false,
          problem: runLiveElsewhere(reference.runId, foreign.ownerPid),
        };
      }
      const owner = live ?? runGroup.acquireRun(reference.runId);
      if (owner === undefined) {
        return { found: false, problem: runStoreDamaged(reference.runId) };
      }
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
        if (live === undefined) owner.close();
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
      const rested = observedOwner(owner, runId).writeState("halted");
      if (rested.ok) owner.release();
      tracking.owner = undefined;
      tracking.done = true;
      owner.close();
      pushRunUpdate(runId);
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

// The one site that canonicalizes a Workspace path (#74 A6, #98 A20). `.native`
// fully resolves the path — on Windows it expands 8.3 short names — so equal
// directories reached by different spellings compare equal for the exact-string
// comparison Workspace approval relies on. Both the launch path (once, at
// construction) and every approve input pass through here, and composition wires
// the Run group's group directory through the same canonicaliser rather than a
// second `realpathSync.native` site (A20); it throws only when the path does not
// resolve, which `applyApproval` translates to a Problem.
export function canonicalizeWorkspacePath(rawPath: string): string {
  return realpathSync.native(rawPath);
}

/** A stable replay key for a launch: the identity, the sorted inputs, and any
 *  acknowledged digest. A re-submitted operation id with an equal key replays. */
function launchReplayKey(input: LaunchRunInput): string {
  const inputs = Object.entries(input.launchInputs).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify([
    input.bundle.id,
    input.bundle.version ?? null,
    inputs,
    input.trustDigest ?? null,
  ]);
}

/** Whether two Gate references name the same Attempt of the same Run (#85). */
function gateEquals(a: RunGateReference, b: RunGateReference): boolean {
  return (
    a.runId === b.runId &&
    a.stepId === b.stepId &&
    a.attemptId === b.attemptId &&
    a.shape === b.shape
  );
}

/** Settle an authored gate's producing Attempt (#108). A fenced owner or an
 *  unstageable answer is a coordination/environment fault the caller (the answer
 *  use case) owns, so it throws — publication is idempotent per attempt id, so a
 *  replay of an already-settled gate is a silent no-op, not a fault. */
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

/** A stable replay key for a resume: the Run id. A re-submitted operation id
 *  with an equal key replays; a different key is a conflict. */
function resumeReplayKey(input: ResumeRunInput): string {
  return JSON.stringify([
    "resume",
    input.runId,
    input.takeover?.ownerPid ?? null,
  ]);
}

/** A stable replay key for a gate answer: the Run, the answered Attempt, and the
 *  answer. A re-submitted operation id with an equal key replays. */
function answerReplayKey(input: AnswerHumanGateInput): string {
  return JSON.stringify([
    "answer",
    input.runId,
    input.gate.attemptId,
    input.answer,
  ]);
}

/** A stable replay key for a cancel: the Run id. A re-submitted operation id with
 *  an equal key replays; a different key is a conflict (#87). */
function cancelReplayKey(runId: string): string {
  return JSON.stringify(["cancel", runId]);
}

/** A stable replay key for a delete: the Run id (#87). */
function deleteReplayKey(runId: string): string {
  return JSON.stringify(["delete", runId]);
}
