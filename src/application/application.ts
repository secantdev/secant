import { realpathSync } from "node:fs";
import type { Catalog } from "../catalog/catalog.js";
import type {
  OpenedProjection,
  OperationOutcome,
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
// Catalog, and reflects durable truth back into open Projections. Operations
// settle synchronously here, so an opened `operation` Projection is already at
// its outcome; the async `updates` stream carries the durable change to any
// `workspace` Projection observing when the launch Workspace becomes approved.
// ponytail: synchronous in-memory settlement; add real pending observation only
// when a client needs to watch a not-yet-settled Operation.

export interface ApplicationDependencies {
  readonly catalog: Catalog;
  /** The canonical absolute path of the one launch Workspace. */
  readonly launchWorkspacePath: string;
}

export interface Application {
  readonly projectionPort: ProjectionPort;
}

export function createApplication(deps: ApplicationDependencies): Application {
  const { catalog, launchWorkspacePath } = deps;
  const operations = new Map<
    string,
    { readonly path: string; readonly outcome: OperationOutcome }
  >();
  const workspaceObservers = new Set<UpdateStream>();

  function workspaceSnapshot(): WorkspaceSnapshot {
    const approval = catalog.getWorkspaceApproval(launchWorkspacePath);
    return {
      family: "workspace",
      path: launchWorkspacePath,
      approval: approval
        ? { state: "approved", approvedAt: approval.approvedAt }
        : { state: "unapproved" },
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
      canonicalPath = realpathSync(rawPath); // case preserved, symlinks resolved
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

  const projectionPort: ProjectionPort = {
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
      const outcome = applyApproval(submission.input.path);
      operations.set(submission.operationId, {
        path: submission.input.path,
        outcome,
      });
      return { admitted: true, operationId: submission.operationId };
    },

    openProjection(selector: ProjectionSelector): OpenedProjection {
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
      const operation = operations.get(selector.operationId);
      if (operation === undefined) {
        throw new Error(
          `No Operation ${selector.operationId} has been submitted.`,
        );
      }
      // The Operation is already settled; no further updates will arrive.
      const updates = new UpdateStream();
      return {
        snapshot: {
          family: "operation",
          operationId: selector.operationId,
          outcome: operation.outcome,
        },
        catchUp: "fresh",
        updates,
        close() {
          updates.close();
        },
      };
    },

    readResource(_reference: ResourceReference): never {
      // Unreachable: no resource references exist in M1 (the type is uninhabited).
      throw new Error("The Projection Port has no M1 resource vocabulary.");
    },
  };

  return { projectionPort };
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
