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
  isLiveElsewhere,
  runSnapshot,
  selectRunEntry,
  type RunProjectionDependencies,
} from "./run-projection.js";
import {
  bundleBytesCorrupt,
  bundleBytesMissing,
  bundleTrustRequired,
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
  workspaceBusy,
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
}) => Promise<RunReport>;

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
}

export interface Application {
  readonly projectionPort: ProjectionPort;
  readonly bundleManagement: BundleManagement;
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
  // the in-memory latest state, and the streams watching it.
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
      readonly observers: Set<UpdateStream>;
    }
  >();
  const workspaceObservers = new Set<UpdateStream>();
  const bundleCatalogObservers = new Set<UpdateStream>();
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
    // A synchronous settler (approve-workspace, cancel, delete) settles inline so an
    // `operation` Projection opened right after `submit` is already settled; only a
    // Run settler (launch, resume, answer) is a Promise, which settles on the stream's
    // first durable update. Keeping the sync path sync preserves every non-Run
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
    if (tracking === undefined || tracking.observers.size === 0) return;
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
    };
  }

  // Acquire the Run, drive it to rest through the injected execution, then close
  // the owner and release the Workspace claim. The launch Operation is `applied`
  // once the Run reaches rest (succeeded, failed, or a `blocked` pause at a Review
  // checkpoint — nothing executes while blocked, and the claim is released on the
  // `finally`, so a reopened home re-derives the block from the current Step
  // Attempt); a fenced owner or publication fault is a coordination/environment
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
    const owner = runGroup.acquireRun(runId);
    if (owner === undefined) {
      tracking.done = true;
      return { status: "not-applied", problem: runStoreDamaged(runId) };
    }
    tracking.owner = owner;
    try {
      await runExecution({
        routing: tracking.routing,
        digest: tracking.digest,
        owner: observedOwner(owner, runId),
      });
      return { status: "applied" };
    } catch (error) {
      return {
        status: "not-applied",
        problem: runExecutionFault(runId, error),
      };
    } finally {
      tracking.owner = undefined;
      tracking.done = true;
      owner.close();
      runGroup.endRun(runId);
    }
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
      // A point-in-time page, like a bundle-catalog focus: no live updates in M2
      // (the TUI adds observers in #93). An unwired Run Store yields an empty,
      // informational snapshot rather than a throw.
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
      return {
        snapshot,
        catchUp: "fresh",
        updates,
        close() {
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
    });
    if ("problem" in pre) {
      return { admitted: false, problem: pre.problem };
    }

    // Trust: an untrusted digest needs a matching acknowledgement. A missing one
    // is `bundle-trust-required` (carrying the Execution summary, the fixed
    // warning, and the exact digest); a mismatching one grants nothing. The
    // acknowledgement is validated here but the grant is only recorded *after* the
    // Run is created, so a `workspace-busy` refusal leaves no dangling grant.
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
    if (created.outcome === "workspace-busy") {
      // Refused before any grant is written: nothing to undo.
      return { admitted: false, problem: workspaceBusy(created.liveRunId) };
    }
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
      observers: new Set<UpdateStream>(),
    });
    operations.set(operationId, {
      replayKey: launchReplayKey(input),
      outcome: { status: "pending" },
      observers: new Set<UpdateStream>(),
      runId,
      settle: () => runAndSettle(runId),
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

  // Resume a Run resting `halted` or `failed` (ADR 0019): re-verify the pinned
  // Snapshot is still installed and runnable, re-claim the Workspace (ADR 0023),
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
    // Resume applies only to a Run resting `halted` or `failed` (ADR 0019). A
    // `running` record means the Run is live (here or elsewhere); resuming it would
    // fence the process driving it. A `succeeded`/`cancelled` Run is terminal.
    if (record.state !== "halted" && record.state !== "failed") {
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
    // Re-claim the Workspace before authorizing more work; a different live Run
    // refuses, leaving this Run untouched.
    const claim = runGroup.resumeRun(input.runId);
    if (claim.outcome === "workspace-busy") {
      return { admitted: false, problem: workspaceBusy(claim.liveRunId) };
    }
    if (claim.outcome === "unknown-run") {
      return { admitted: false, problem: runNotFound(input.runId) };
    }
    runs.set(input.runId, {
      digest: record.bundleSnapshotDigest,
      routing: manifest.routing,
      name: manifest.bundle.name,
      id: manifest.bundle.id,
      version: manifest.bundle.version,
      state: record.state,
      done: false,
      observers: new Set<UpdateStream>(),
    });
    operations.set(operationId, {
      replayKey: resumeReplayKey(input),
      outcome: { status: "pending" },
      observers: new Set<UpdateStream>(),
      runId: input.runId,
      settle: () => runAndSettle(input.runId),
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
      settle: () => answerAndSettle(operationId, input),
    });
    scheduleSettlement(() => settleOperation(operationId));
    return { admitted: true, operationId, runId: input.runId };
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
    const derivedFacts = deriveRunFacts(
      runProjection,
      record.bundleSnapshotDigest,
    );
    if ("problem" in derivedFacts) {
      return { status: "not-applied", problem: derivedFacts.problem };
    }
    const facts = derivedFacts.facts;
    // A `blocked` Run is stored `running` (the block is derived), so only a
    // `running`/`created` record can be blocked. Reject a clearly-terminal record
    // (`succeeded`/`failed`/`halted`) before touching coordination, so answering a
    // Run that is not blocked changes nothing at all — no claim toggle, no epoch
    // bump. (A `running` record still needs the owner to tell blocked from a live
    // mid-execution Run; that is checked once acquired.)
    if (record.state !== "running" && record.state !== "created") {
      return {
        status: "not-applied",
        problem: runNotBlocked(input.runId, record.state),
      };
    }
    // Re-claim the Workspace — the block released it — before acquiring ownership;
    // a different live Run refuses, leaving this Run untouched.
    const claim = runGroup.resumeRun(input.runId);
    if (claim.outcome === "workspace-busy") {
      return { status: "not-applied", problem: workspaceBusy(claim.liveRunId) };
    }
    if (claim.outcome === "unknown-run") {
      return { status: "not-applied", problem: runNotFound(input.runId) };
    }
    const owner = runGroup.acquireRun(input.runId);
    if (owner === undefined) {
      return {
        status: "not-applied",
        problem: runStoreDamaged(input.runId),
      };
    }
    runs.set(input.runId, {
      digest: record.bundleSnapshotDigest,
      routing: facts.routing,
      name: facts.name,
      id: facts.id,
      version: facts.version,
      state: record.state,
      owner,
      done: false,
      observers: new Set<UpdateStream>(),
    });
    const tracking = runs.get(input.runId)!;
    try {
      const observed = observedOwner(owner, input.runId);
      // Idempotent across process death: an answer already recorded for this
      // operation id settles `applied` without re-validating the (now-moved) Gate
      // or re-driving execution.
      // Process death after recording a `continue` but before the granted interval
      // reaches its next rest leaves the Run stored `running` with a live claim, so
      // startup reconciliation (#86) rests it `halted` on the next open and
      // `run resume` re-drives it — one interval of already-run iterations is
      // dropped whole-span, so the grant is honored, not double-counted.
      // ponytail: that recovers the interrupted grant but reports it as a `halted`
      // resume rather than a `blocked` re-answer; a persisted grant-pending marker
      // would let it re-derive `blocked` instead — add it if the distinction matters.
      const already = owner
        .gateAnswers()
        .some((answer) => answer.operationId === operationId);
      const priorAnswers = owner.gateAnswers();
      const derived = deriveRun(
        facts.routing,
        owner.attemptLog(),
        record.state,
        input.runId,
        owner,
        priorAnswers,
      );
      if (!already) {
        if (derived.state !== "blocked" || derived.checkpoint === undefined) {
          return {
            status: "not-applied",
            problem: runNotBlocked(input.runId, derived.state),
          };
        }
        if (!gateEquals(derived.checkpoint.gate, input.gate)) {
          return {
            status: "not-applied",
            problem: gateStale(
              input.runId,
              input.gate,
              derived.checkpoint.gate,
            ),
          };
        }
      }
      if (already) return { status: "applied" };
      // The cumulative iteration count this grant/stop resets from: the prior
      // grant offset plus the iterations completed since it (#85).
      const priorOffset =
        priorAnswers.length === 0
          ? 0
          : priorAnswers[priorAnswers.length - 1]!.iterationsAtGrant;
      const iterationsAtGrant =
        priorOffset + (derived.checkpoint?.completedIterations ?? 0);
      const recorded = observed.recordGateAnswer({
        operationId,
        gateAttemptId: input.gate.attemptId,
        answer: input.answer,
        iterationsAtGrant,
        artifactName: GATE_ANSWER_ARTIFACT,
        at: new Date(),
        ...(input.answer === "stop" ? { advanceState: "failed" } : {}),
      });
      if (!recorded.ok) {
        throw new Error(
          "reason" in recorded
            ? `cannot record the gate answer: ${recorded.reason}`
            : `cannot record the gate answer: ${recorded.problem.kind}`,
        );
      }
      if (input.answer === "stop") return { status: "applied" };
      // `continue`: the answering process drives the granted interval to rest.
      await runExecution({
        routing: facts.routing,
        digest: record.bundleSnapshotDigest,
        owner: observed,
      });
      return { status: "applied" };
    } catch (error) {
      return {
        status: "not-applied",
        problem: runExecutionFault(input.runId, error),
      };
    } finally {
      tracking.owner = undefined;
      tracking.done = true;
      owner.close();
      runGroup.endRun(input.runId);
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

  // Rest a live Run `cancelled` — the only route to that terminal state. Acquiring
  // the owner bumps the fencing epoch, so a stale owner executing the Run in
  // another process is fenced and its next canonical write is refused (execution
  // stops); then we record `cancelled` and release the claim, every Artifact
  // intact. A Run that is not live has no cancel to make.
  function cancelAndSettle(runId: string): OperationOutcome {
    if (runGroup === undefined) {
      return { status: "not-applied", problem: runSupportUnavailable() };
    }
    const listing = runGroup.listRuns().find((run) => run.runId === runId);
    if (listing === undefined) {
      return { status: "not-applied", problem: runNotFound(runId) };
    }
    if (!listing.live) {
      return { status: "not-applied", problem: runNotLive(runId) };
    }
    const owner = runGroup.acquireRun(runId);
    if (owner === undefined) {
      return { status: "not-applied", problem: runStoreDamaged(runId) };
    }
    try {
      // Our epoch is the freshest, so this write is not fenced. A concurrent second
      // cancel is the only actor that could fence it, and it is resting the same
      // Run cancelled too, so the outcome is unchanged either way.
      owner.writeState("cancelled");
    } finally {
      owner.close();
    }
    runGroup.endRun(runId);
    runs.delete(runId);
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
      if (live === undefined && isLiveElsewhere(runGroup, reference.runId)) {
        return { found: false, problem: runLiveElsewhere(reference.runId) };
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

  return {
    projectionPort,
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

// The one site that canonicalizes a Workspace path (#74 A6). `.native` fully
// resolves the path — on Windows it expands 8.3 short names — so equal
// directories reached by different spellings compare equal for the exact-string
// comparison Workspace approval relies on. Both the launch path (once, at
// construction) and every approve input pass through here; it throws only when
// the path does not resolve, which `applyApproval` translates to a Problem.
function canonicalizeWorkspacePath(rawPath: string): string {
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

/** A stable replay key for a resume: the Run id. A re-submitted operation id
 *  with an equal key replays; a different key is a conflict. */
function resumeReplayKey(input: ResumeRunInput): string {
  return JSON.stringify(["resume", input.runId]);
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
