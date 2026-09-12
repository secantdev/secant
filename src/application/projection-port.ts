// Client-facing contract for the Projection Port (ADR 0024, #19). Both clients
// speak this Interface; it exposes only normalized semantic values and imports
// nothing, so no runtime, storage, or Adapter object can leak across it.
//
// M1 declares three of the closed families (`workspace`, `operation`,
// `bundle-catalog`) and one Operation (`approve-workspace`). The unions grow
// with later slices; families and actions not yet needed are deliberately
// absent rather than stubbed.

/** Which bounded Projection to open. Selectors are closed and typed. */
export type ProjectionSelector =
  | { readonly family: "workspace" }
  | { readonly family: "operation"; readonly operationId: string }
  // `bundle-catalog` with no `focus` is the list; with a `focus` it is the exact
  // inspection of one Installed Bundle. Read-only: this family offers no Actions.
  | { readonly family: "bundle-catalog"; readonly focus?: BundleFocusSelector };

/** Selects one Installed Bundle to inspect. An omitted version selects the
 *  highest stable installed version; a prerelease must be named (#9, #49). */
export interface BundleFocusSelector {
  readonly id: string;
  readonly version?: string;
}

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

export type ProjectionSnapshot =
  | WorkspaceSnapshot
  | OperationSnapshot
  | BundleCatalogSnapshot
  | BundleFocusSnapshot;

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

// --- bundle-catalog family -------------------------------------------------
//
// A read-only projection of the Installed Bundles the Catalog recorded. It joins
// each Catalog Entry with its manifest facts and generated Execution summary and
// exposes only normalized semantic values: no archive object, storage path, or
// SQLite type crosses, and it offers no Action Offers (#9, #49).

/** The three supported operating systems, in canonical order. */
export type BundlePlatform = "windows" | "macos" | "linux";
/** The five Run Artifact types a launch input or produced artifact may be. */
export type ArtifactTypeName =
  "text" | "file" | "file-set" | "verdict" | "choice";
/** The four Crucible-owned Step kinds. */
export type StepKindName =
  "agent" | "interactive-agent" | "human-gate" | "command";

/** Whether a version is a stable release or a SemVer prerelease. */
export type BundleStability = "stable" | "prerelease";

/** Where a Bundle came from. Advisory provenance, never a runtime dependency;
 *  the managed store path is not this and never crosses. */
export interface BundleOriginView {
  readonly kind: "local-build" | "local-file";
  readonly location: string;
}

/** The Bundle's engine range and whether the running engine satisfies it. */
export interface EngineRange {
  readonly range: string; // the packaged `>=x.y.z`
  readonly satisfied: boolean; // the running Secant engine satisfies `range`
  /** "needs Secant ≥ x.y" when the running engine is outside the range (#49). */
  readonly note?: string;
}

/** M1 shows External Bundles as not yet trusted and offers no trust action;
 *  Built-in Bundles inherit app-release trust (#9). */
export type BundleTrustState =
  { readonly state: "not-yet-trusted" } | { readonly state: "app-release" };

/** One Installed Bundle as a list row (#9, #49). */
export interface InstalledBundleSummary {
  readonly id: string;
  readonly version: string;
  readonly digest: string; // SHA-256 hex over the exact bytes
  readonly name: string;
  readonly description: string;
  readonly origin: BundleOriginView;
  readonly stability: BundleStability;
  readonly platforms: readonly BundlePlatform[];
  readonly engine: EngineRange;
  readonly trust: BundleTrustState;
}

export interface BundleCatalogSnapshot {
  readonly family: "bundle-catalog";
  readonly view: "list";
  /** Sorted by name, then version descending (#9, #49). */
  readonly bundles: readonly InstalledBundleSummary[];
}

/** Optional Bundle author metadata, shown only in a focus. */
export interface BundleAuthorMetadata {
  readonly authors?: readonly string[];
  readonly license?: string;
  readonly homepage?: string;
  readonly repository?: string;
  readonly keywords?: readonly string[];
  readonly notices?: readonly string[];
}

export interface LaunchInputView {
  readonly name: string;
  readonly type: ArtifactTypeName;
  readonly description: string;
  readonly schema?: string; // schema asset path, when the input declares one
  readonly choices?: readonly string[];
}

export interface RoutingStepView {
  readonly id: string;
  readonly kind: StepKindName;
}
/** Routing in authored order: a Step, or a Repeat group with its checkpoint. */
export type RoutingNodeView =
  | { readonly node: "step"; readonly step: RoutingStepView }
  | {
      readonly node: "repeat";
      readonly until: string;
      readonly reviewCheckpoint: {
        readonly interval: number;
        readonly message: string;
      };
      readonly steps: readonly RoutingStepView[];
    };

export interface ProducedArtifactView {
  readonly name: string;
  readonly type: ArtifactTypeName;
  readonly home: "store" | "workspace";
  readonly path?: string;
  readonly producedBy: string; // the Step id that produces it
}

/** One command Step's authority on the selected platform. */
export interface ExecutionCommandView {
  readonly stepId: string;
  readonly executable: string;
  readonly workingDirectory?: string;
  readonly environmentVariableNames: readonly string[];
  readonly scripts: readonly string[];
}

/** Crucible's generated account of the authority a Bundle can exercise on the
 *  selected platform (#9 glossary). Derived from the Bundle, not the author. */
export interface ExecutionSummary {
  readonly platform: BundlePlatform;
  readonly identity: { readonly id: string; readonly version: string };
  readonly digest: string;
  readonly origin: BundleOriginView;
  readonly platforms: readonly BundlePlatform[];
  readonly stepKindCounts: Readonly<Partial<Record<StepKindName, number>>>;
  readonly commands: readonly ExecutionCommandView[];
  readonly warning: string; // fixed authority warning
}

/** One Composition check finding, shown in a focus. */
export interface CompositionFindingView {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly target: string; // the Step id or dotted manifest field
  readonly explanation: string;
}

/** The exact inspection of one Installed Bundle: the row plus focus facts. */
export interface InstalledBundleFocus extends InstalledBundleSummary {
  readonly author: BundleAuthorMetadata;
  readonly launchInputs: readonly LaunchInputView[];
  readonly routing: readonly RoutingNodeView[];
  readonly workspacePrerequisites: readonly string[];
  readonly producedArtifacts: readonly ProducedArtifactView[];
  readonly executionSummary: ExecutionSummary;
  readonly compositionFindings: readonly CompositionFindingView[];
}

export interface BundleFocusSnapshot {
  readonly family: "bundle-catalog";
  readonly view: "focus";
  readonly selection: BundleFocusSelector;
  readonly result: BundleFocusResult;
}
export type BundleFocusResult =
  | { readonly found: true; readonly bundle: InstalledBundleFocus }
  | { readonly found: false; readonly problem: Problem };

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
