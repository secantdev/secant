// Client-facing contract for the Projection Port (ADR 0024, #19). Both clients
// speak this Interface; it exposes only normalized semantic values and imports
// nothing, so no runtime, storage, or Adapter object can leak across it.
//
// M1 declares two of the closed families (`workspace`, `operation`) and one
// Operation (`approve-workspace`). The unions grow with later slices; families
// and actions not yet needed are deliberately absent rather than stubbed.

/** Which bounded Projection to open. Selectors are closed and typed. */
export type ProjectionSelector =
  | { readonly family: "workspace" }
  | { readonly family: "operation"; readonly operationId: string };

/** A durable user intent, correlated by a caller-generated operation id. */
export interface Submission {
  readonly operationId: string;
  readonly operation: "approve-workspace";
  readonly input: { readonly path: string };
}

/** `submit` settles only as admitted (with the operation id) or not-admitted. */
export type SubmissionAdmission =
  | { readonly admitted: true; readonly operationId: string }
  | { readonly admitted: false; readonly problem: Problem };

/** An opened Projection joins its snapshot, catch-up barrier, and updates. */
export interface OpenedProjection {
  readonly snapshot: ProjectionSnapshot;
  readonly catchUp: CatchUp;
  readonly updates: AsyncIterable<ProjectionUpdate>;
  /** Idempotent, performs no domain action, and permits no later updates. */
  close(): void;
}

export type CatchUp = "fresh" | "continuous" | "rebased";

export type ProjectionSnapshot = WorkspaceSnapshot | OperationSnapshot;

/** The one launch Workspace: its canonical path and approval state. */
export interface WorkspaceSnapshot {
  readonly family: "workspace";
  readonly path: string;
  readonly approval: WorkspaceApprovalState;
  readonly installedBundleCount: number;
  readonly actionOffers: readonly ActionOffer[];
}
export type WorkspaceApprovalState =
  | { readonly state: "approved"; readonly approvedAt: string } // ISO 8601
  | { readonly state: "unapproved" };

/** The receipt of one submitted intent: pending, then a typed outcome. */
export interface OperationSnapshot {
  readonly family: "operation";
  readonly operationId: string;
  readonly outcome: OperationOutcome;
}
export type OperationOutcome =
  | { readonly status: "pending" }
  | { readonly status: "applied" }
  | { readonly status: "not-applied"; readonly problem: Problem };

/** A typed opportunity bound to an exact target. M1 offers exactly one. */
export interface ActionOffer {
  readonly action: "approve-workspace";
  readonly input: { readonly path: string };
}

export type ProjectionUpdate =
  | { readonly kind: "durable"; readonly snapshot: ProjectionSnapshot }
  | { readonly kind: "closed"; readonly reason: ObserverEnd };
export type ObserverEnd =
  | "subject-gone"
  | "observer-lagged"
  | "temporarily-unavailable"
  | "application-shutdown";

/**
 * The one normalized failure family crossing the Port. Operational failures are
 * values carried here; throws are reserved for caller-contract violations.
 */
export interface Problem {
  readonly code: string;
  readonly explanation: string;
  readonly remediation: string;
  readonly possibleEffects: "none" | "partial" | "unknown";
  readonly details?: Readonly<Record<string, string>>;
  readonly fieldViolations?: readonly FieldViolation[];
}
export interface FieldViolation {
  readonly field: string;
  readonly explanation: string;
}

// No M1 resource vocabulary: `readResource` exists in the contract with nothing
// to reference yet, so its reference and result types are uninhabited.
export type ResourceReference = never;
export type ResourceRead = never;

export interface ProjectionPort {
  openProjection(selector: ProjectionSelector): OpenedProjection;
  submit(submission: Submission): SubmissionAdmission;
  readResource(reference: ResourceReference): ResourceRead;
}
