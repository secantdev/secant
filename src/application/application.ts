import { realpathSync } from "node:fs";
import { DEFAULT_BUDGETS, type Budgets } from "../bundle/bundle.js";
import type { Catalog } from "../catalog/catalog.js";
import type { Platform } from "../workflow/workflow.js";
import {
  focusSnapshot,
  listSnapshot,
  type BundleCatalogDependencies,
} from "./bundle-catalog.js";
import type { BundleManagement } from "./bundle-management.js";
import { createBundleManagement } from "./build-bundle.js";
import type {
  BundleCatalogSnapshot,
  BundleFocusSelector,
  BundleFocusSnapshot,
  OpenedProjection,
  OperationOutcome,
  OperationSnapshot,
  ProjectionPort,
  ProjectionSelector,
  ProjectionUpdate,
  Problem,
  ResourceReference,
  Submission,
  SubmissionAdmission,
  WorkspaceSnapshot,
} from "./projection-port.js";

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
}

export interface Application {
  readonly projectionPort: ProjectionPort;
  readonly bundleManagement: BundleManagement;
}

export function createApplication(deps: ApplicationDependencies): Application {
  const { catalog } = deps;
  const launchWorkspacePath = canonicalizeWorkspacePath(
    deps.launchWorkspacePath,
  );
  const scheduleSettlement =
    deps.scheduleSettlement ?? ((settle: () => void) => settle());
  // Each Operation carries its outcome and the streams watching it. Observers are
  // added only while `pending` and delivered to exactly once on settlement, so a
  // settled Operation holds no live observer to leak.
  const operations = new Map<
    string,
    {
      readonly path: string;
      readonly outcome: OperationOutcome;
      readonly observers: Set<UpdateStream>;
    }
  >();
  const workspaceObservers = new Set<UpdateStream>();
  const bundleCatalogObservers = new Set<UpdateStream>();
  const bundleCatalog: BundleCatalogDependencies = {
    catalog,
    budgets: deps.bundleBudgets ?? DEFAULT_BUDGETS,
    engineVersion: deps.engineVersion ?? "0.0.0-dev",
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

  // Settles a `pending` Operation: applies it, records the durable outcome, and
  // delivers it to any Projection opened on this id while it was pending. Runs
  // via `scheduleSettlement`, so inline by default and deferred under a test. The
  // observer Set is carried forward so streams opened while pending stay live.
  function settleOperation(operationId: string, path: string): void {
    const observers =
      operations.get(operationId)?.observers ?? new Set<UpdateStream>();
    const outcome = applyApproval(path);
    operations.set(operationId, { path, outcome, observers });
    const snapshot: OperationSnapshot = {
      family: "operation",
      operationId,
      outcome,
    };
    for (const observer of observers) {
      observer.push({ kind: "durable", snapshot });
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
  function openProjection(selector: ProjectionSelector): OpenedProjection;
  function openProjection(selector: ProjectionSelector): OpenedProjection {
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

  const projectionPort: ProjectionPort = {
    openProjection,
    submit(submission: Submission): SubmissionAdmission {
      const existing = operations.get(submission.operationId);
      if (existing !== undefined) {
        // Same id, equal input replays the original result without re-dispatch;
        // same id, different input is rejected.
        if (existing.path === submission.input.path) {
          return { admitted: true, operationId: submission.operationId };
        }
        return {
          admitted: false,
          problem: operationIdReused(submission.operationId),
        };
      }
      // Admit at once and record `pending`; settlement is scheduled (inline by
      // default, deferred under a test) and publishes the outcome then.
      operations.set(submission.operationId, {
        path: submission.input.path,
        outcome: { status: "pending" },
        observers: new Set<UpdateStream>(),
      });
      scheduleSettlement(() =>
        settleOperation(submission.operationId, submission.input.path),
      );
      return { admitted: true, operationId: submission.operationId };
    },

    readResource(_reference: ResourceReference): never {
      // Unreachable: no resource references exist in M1 (the type is uninhabited).
      throw new Error("The Projection Port has no M1 resource vocabulary.");
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
