import { realpathSync } from "node:fs";
import {
  DEFAULT_BUDGETS,
  generateExecutionSummary,
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
  bundleBytesCorruptForRun,
  bundleBytesMissingForRun,
  deriveRunFacts,
  isLiveElsewhere,
  runSnapshot,
  selectRunEntry,
  type RunProjectionDependencies,
} from "./run-projection.js";
import { preflight } from "./preflight.js";
import type {
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
  ProjectionUpdate,
  Problem,
  DiagnosticReference,
  ResourceRead,
  ResourceReference,
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
}) => RunReport;

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
   *  synchronously inline (an opened `operation` Projection is already settled).
   *  A test supplies a controllable settler to exercise the `pending` → settled
   *  path without a real long-lived Run. */
  readonly scheduleSettlement?: (settle: () => void) => void;
  /** The Run Store for the launch Workspace, opened by composition (which owns
   *  its lifetime). Absent when a caller wires no Run support; `launch-run` and
   *  the `run` Projection then report a Problem rather than executing. */
  readonly runGroup?: RunGroup;
  /** The Run execution composition constructs and hands in (see RunExecution). */
  readonly runExecution?: RunExecution;
}

export interface Application {
  readonly projectionPort: ProjectionPort;
  readonly bundleManagement: BundleManagement;
}

export function createApplication(deps: ApplicationDependencies): Application {
  const { catalog, runGroup, runExecution } = deps;
  const launchWorkspacePath = canonicalizeWorkspacePath(
    deps.launchWorkspacePath,
  );
  const scheduleSettlement =
    deps.scheduleSettlement ?? ((settle: () => void) => settle());
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
      readonly settle: () => OperationOutcome;
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
  function settleOperation(operationId: string): void {
    const entry = operations.get(operationId);
    if (entry === undefined) return;
    entry.outcome = entry.settle();
    const snapshot: OperationSnapshot = {
      family: "operation",
      operationId,
      outcome: entry.outcome,
    };
    for (const observer of entry.observers) {
      observer.push({ kind: "durable", snapshot });
    }
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
    };
  }

  // Acquire the Run, drive it to rest through the injected execution, then close
  // the owner and release the Workspace claim. The launch Operation is `applied`
  // once the Run reaches rest (succeeded, failed, or a `blocked` pause at a Review
  // checkpoint — nothing executes while blocked, and the claim is released on the
  // `finally`, so a reopened home re-derives the block from the current Step
  // Attempt); a fenced owner or publication fault is a coordination/environment
  // fault that execution throws, carried here as a `not-applied` Problem.
  function runAndSettle(runId: string): OperationOutcome {
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
      return { status: "not-applied", problem: runStoreUnreadable(runId) };
    }
    tracking.owner = owner;
    try {
      runExecution({
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
  function openProjection(selector: ProjectionSelector): OpenedProjection;
  function openProjection(selector: ProjectionSelector): OpenedProjection {
    if (selector.family === "run") {
      return openRunProjection(selector.runId);
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
        problem: bundleBytesMissingForRun(entry.digest),
      };
    }
    // Include the Composition re-check: a Run pins this Snapshot, so Preflight
    // proves it still composes against the archived prompt/schema text (ADR 0021).
    const inspected = inspectBundle(bytes, budgets, true);
    if (!inspected.ok) {
      return {
        admitted: false,
        problem: bundleBytesCorruptForRun(entry.digest, inspected.finding.code),
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

  // Resume a Run resting `halted`: re-derive its facts from the pinned bytes (a
  // fresh `run resume` process holds no in-memory tracking), re-claim the
  // Workspace (ADR 0023), then drive it further through the same execution — which
  // skips the completed Steps and re-verifies the one that halted.
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
            : runStoreUnreadable(input.runId),
      };
    }
    const record = read.run;
    // Resume applies only to a Run resting `halted` on a conflict. A `running`
    // record means the Run is live (here or elsewhere); resuming it would fence
    // the process driving it. A `succeeded`/`failed` Run is already at rest.
    if (record.state !== "halted") {
      return {
        admitted: false,
        problem: runNotHalted(input.runId, record.state),
      };
    }
    const derived = deriveRunFacts(runProjection, record.bundleSnapshotDigest);
    if ("problem" in derived) {
      return { admitted: false, problem: derived.problem };
    }
    const facts = derived.facts;
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
      routing: facts.routing,
      name: facts.name,
      id: facts.id,
      version: facts.version,
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
        return { found: false, problem: runStoreUnreadable(reference.runId) };
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

function pathNotFound(rawPath: string, error: unknown): Problem {
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

function workspaceNotApproved(path: string): Problem {
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
function bundleTrustRequired(
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

function trustDigestMismatch(installed: string, acknowledged: string): Problem {
  return {
    code: "trust-digest-mismatch",
    explanation: `The acknowledged digest ${acknowledged} does not match the installed digest ${installed}; nothing was trusted.`,
    remediation: `Re-run with --trust ${installed} to acknowledge the exact installed Bundle.`,
    possibleEffects: "none",
    details: { installed, acknowledged },
  };
}

function workspaceBusy(liveRunId: string): Problem {
  return {
    code: "workspace-busy",
    explanation: `Another Run (${liveRunId}) is live in this Workspace; only one Run runs at a time.`,
    remediation: "Wait for the live Run to reach rest, then launch again.",
    possibleEffects: "none",
    details: { liveRunId },
  };
}

function runSupportUnavailable(): Problem {
  return {
    code: "run-support-unavailable",
    explanation: "This client was wired without Run support.",
    remediation:
      "Launch Runs through the headless CLI or the shell, which wire the Run Store and execution.",
    possibleEffects: "none",
  };
}

function runStoreUnreadable(runId: string): Problem {
  return {
    code: "run-store-damaged",
    explanation: `Run ${runId} could not be acquired; its canonical store is unreadable.`,
    remediation:
      "The Run's store is damaged; delete the Run and launch a fresh one.",
    possibleEffects: "unknown",
    details: { runId },
  };
}

function runExecutionFault(runId: string, error: unknown): Problem {
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

function runLiveElsewhere(runId: string): Problem {
  return {
    code: "run-live-elsewhere",
    explanation: `Run ${runId} is live in another process; its outputs cannot be read until it reaches rest.`,
    remediation:
      "Wait for the Run to reach rest (its launch process prints the final state), then read the output.",
    possibleEffects: "none",
    details: { runId },
  };
}

function runOutputMissing(reference: ResourceReference): Problem {
  return {
    code: "run-output-not-found",
    explanation: `Output ${reference.artifactName} has no bytes at the referenced version.`,
    remediation:
      "Open the Run to see its current outputs, then read one that is bound.",
    possibleEffects: "none",
    details: { runId: reference.runId, artifactName: reference.artifactName },
  };
}

function runDiagnosticMissing(reference: DiagnosticReference): Problem {
  return {
    code: "run-diagnostic-not-found",
    explanation: `Diagnostic ${reference.diagnosticId} is not recorded for this Run.`,
    remediation:
      "Open the Run to see its current conflict, then read the diagnostic it references.",
    possibleEffects: "none",
    details: { runId: reference.runId, diagnosticId: reference.diagnosticId },
  };
}

function runNotFound(runId: string): Problem {
  return {
    code: "run-not-found",
    explanation: `No Run ${runId} exists in this Workspace.`,
    remediation:
      "Check the Run id (it is printed when a Run is launched), or launch a Run first.",
    possibleEffects: "none",
    details: { runId },
  };
}

function runNotHalted(runId: string, state: string): Problem {
  return {
    code: "run-not-halted",
    explanation: `Run ${runId} is ${state}, not halted; only a halted Run can be resumed.`,
    remediation:
      "Resume applies to a Run halted on a Materialization conflict; open the Run to see its state.",
    possibleEffects: "none",
    details: { runId, state },
  };
}

/** A stable replay key for a resume: the Run id. A re-submitted operation id
 *  with an equal key replays; a different key is a conflict. */
function resumeReplayKey(input: ResumeRunInput): string {
  return JSON.stringify(["resume", input.runId]);
}

function operationNotFound(operationId: string): Problem {
  return {
    code: "operation-not-found",
    explanation: `No Operation ${operationId} has been submitted.`,
    remediation:
      "Submit the Operation before opening its Projection, or check the operation id.",
    possibleEffects: "none",
    details: { operationId },
  };
}

function operationIdReused(operationId: string): Problem {
  return {
    code: "operation-id-reused",
    explanation: `Operation id ${operationId} was already used for a different request.`,
    remediation:
      "Repeat the original request with the same input, or use a fresh operation id.",
    possibleEffects: "none",
  };
}

/** A minimal single-consumer async push stream for durable Projection updates. */
class UpdateStream implements AsyncIterable<ProjectionUpdate> {
  private readonly queue: ProjectionUpdate[] = [];
  private waiting?: (result: IteratorResult<ProjectionUpdate>) => void;
  private closed = false;

  push(update: ProjectionUpdate): void {
    if (this.closed) return;
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting({ value: update, done: false });
    } else {
      this.queue.push(update);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ProjectionUpdate> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
