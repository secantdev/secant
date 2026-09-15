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
  | { readonly family: "bundle-catalog"; readonly focus?: BundleFocusSelector }
  // One launched Run by its id. Read-only: launching is an Operation, not a Run
  // Action; durable updates land as each publication commits.
  | { readonly family: "run"; readonly runId: string }
  // The Workspace's Previous Runs (#87): a bounded, newest-first page whose rows
  // carry only the Bundle name, Run id, and latest durable-activity time, each
  // grouped Today / Yesterday / Older. `resumable` narrows to halted+failed;
  // `before` is a stable cursor requesting the next older page. Read-only: Run
  // state and actions live only on the exact `run` Projection.
  | {
      readonly family: "run-list";
      readonly resumable?: boolean;
      readonly before?: string;
    };

/** Selects one Installed Bundle to inspect. An omitted version selects the
 *  highest stable installed version; a prerelease must be named (#9, #49). */
export interface BundleFocusSelector {
  readonly id: string;
  readonly version?: string;
}

/** A durable user intent, correlated by a caller-generated operation id. The
 *  closed set of Operations grows one variant per slice. */
export type Submission =
  | ApproveWorkspaceSubmission
  | LaunchRunSubmission
  | ResumeRunSubmission
  | AnswerHumanGateSubmission
  | CancelRunSubmission
  | DeleteRunSubmission;

export interface ApproveWorkspaceSubmission {
  readonly operationId: string;
  readonly operation: "approve-workspace";
  readonly input: { readonly path: string };
}

/** Launch an installed Command-only Bundle against the approved launch
 *  Workspace, optionally acknowledging trust for the exact installed digest. */
export interface LaunchRunSubmission {
  readonly operationId: string;
  readonly operation: "launch-run";
  readonly input: LaunchRunInput;
}
export interface LaunchRunInput {
  /** The installed Bundle to launch. An omitted version selects the highest
   *  stable installed version; a prerelease must be named (#9, #49). */
  readonly bundle: { readonly id: string; readonly version?: string };
  /** Launch inputs by name, as plain strings; stored opaque on the Run. */
  readonly launchInputs: Readonly<Record<string, string>>;
  /** The exact installed digest the caller acknowledges trusting. Required only
   *  when the installed digest is not yet trusted (ADR 0021). */
  readonly trustDigest?: string;
}

/** Resume a Run resting `halted` or `failed`, or take over a Run owned elsewhere
 *  (ADR 0019, ADR 0031). Idempotent per operation id. Resume acquires fresh ownership
 *  per Run, re-checks Trust and Preflight against the
 *  still-installed pinned digest, and drives the Run to its next rest: a `halted`
 *  Run continues from the Step it stopped at (e.g. after a Materialization
 *  conflict is fixed, #88); a `failed` Run resets that Step's attempt and
 *  Iteration bounds, so the resume is itself the grant of another try. */
export interface ResumeRunSubmission {
  readonly operationId: string;
  readonly operation: "resume-run";
  readonly input: ResumeRunInput;
}
export interface ResumeRunInput {
  readonly runId: string;
  /** The live foreign owner the user explicitly confirmed taking over. */
  readonly takeover?: { readonly ownerPid: number };
}

/** Answer the durable Human Gate a `blocked` Run rests at (ADR 0020, #85). The
 *  answer targets the Gate's exact durable reference — a stale or mismatched
 *  reference, or a Run that is not blocked, is not applied and changes nothing —
 *  and settles across process death: `continue` grants exactly one more interval
 *  and execution resumes in the answering process, `stop` (a rejecting
 *  approve/reject) ends the Run `failed` without discarding history or Artifacts.
 *  The answer is stored as a durable Run Artifact, so the Run can wait
 *  indefinitely and the answer survives closing Secant. */
export interface AnswerHumanGateSubmission {
  readonly operationId: string;
  readonly operation: "answer-human-gate";
  readonly input: AnswerHumanGateInput;
}
export interface AnswerHumanGateInput {
  readonly runId: string;
  /** The Gate reference the answer resolves — `RunCheckpointView.gate`, read from
   *  the current blocked snapshot. Staleness is decided against the live gate. */
  readonly gate: RunGateReference;
  /** `continue` grants another interval; `stop` ends the Run `failed`. */
  readonly answer: "continue" | "stop";
}

/** Cancel a live Run (#87): end it `cancelled` — the only route to that terminal
 *  state — stopping execution and keeping its history and Artifacts. Offered on
 *  the `run` Projection only while the Run is live; on a resting or terminal Run
 *  it yields a Problem. Idempotent per operation id. */
export interface CancelRunSubmission {
  readonly operationId: string;
  readonly operation: "cancel-run";
  readonly input: { readonly runId: string };
}

/** Delete a resting or terminal Run (#87): remove its store from disk through the
 *  admitted delete with quarantine (idempotent per operation id). Offered on the
 *  `run` Projection only while the Run is not live; on a live Run it yields a
 *  Problem. */
export interface DeleteRunSubmission {
  readonly operationId: string;
  readonly operation: "delete-run";
  readonly input: { readonly runId: string };
}

/** `submit` settles only as admitted (with the operation id, and the created Run
 *  id for a launch) or not-admitted. */
export type SubmissionAdmission =
  | {
      readonly admitted: true;
      readonly operationId: string;
      /** The Run a launch created, so the caller can open its Projection at once. */
      readonly runId?: string;
    }
  | { readonly admitted: false; readonly problem: Problem };

/** An opened Projection joins its snapshot, catch-up barrier, and updates. The
 *  snapshot type is the one the selector names (#74 A8): `openProjection` is
 *  overloaded per selector, so a client reads `snapshot` (and each durable
 *  update's snapshot) at its exact type with no cast. */
export interface OpenedProjection<
  S extends ProjectionSnapshot = ProjectionSnapshot,
> {
  readonly snapshot: S;
  readonly catchUp: CatchUp;
  readonly updates: AsyncIterable<ProjectionUpdate<S>>;
  /** Idempotent, performs no domain action, and permits no later updates. */
  close(): void;
}

export type CatchUp = "fresh" | "continuous" | "rebased";

export type ProjectionSnapshot =
  | WorkspaceSnapshot
  | OperationSnapshot
  | BundleCatalogSnapshot
  | BundleFocusSnapshot
  | RunSnapshot
  | RunListSnapshot;

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

/** The receipt of one submitted intent: `pending` until it settles, then a
 *  typed outcome. Opening the Projection on an operation id Secant never saw is
 *  not an error: it settles `not-applied` with an `operation-not-found` Problem
 *  rather than throwing. */
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

/** An External Bundle reads `not-yet-trusted` until a Trust grant is recorded
 *  for its exact installed digest, then `trusted` with the grant's receipt
 *  (#78, ADR 0021). Built-in Bundles inherit `app-release` trust (#9). Trust is
 *  part of Start a Run, never a catalog action: there is no revocation. */
export type BundleTrustState =
  | { readonly state: "not-yet-trusted" }
  | { readonly state: "app-release" }
  | {
      readonly state: "trusted";
      readonly operationId: string; // the grant's operation id
      readonly grantedAt: string; // ISO 8601
    };

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
  readonly result: BundleListResult;
}
/** The list resolved to its rows, or a Problem when a listed Entry's managed
 *  bytes are missing or no longer validate — a broken Catalog invariant that
 *  fails the whole set, carried the way a focus carries the same fault (#74 A3,
 *  docs/agents/validation.md) rather than thrown. */
export type BundleListResult =
  /** Sorted by name, then version descending (#9, #49). */
  | {
      readonly found: true;
      readonly bundles: readonly InstalledBundleSummary[];
    }
  | { readonly found: false; readonly problem: Problem };

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

// --- run family ------------------------------------------------------------
//
// One launched Run as a bounded snapshot: identity, state, ordered Workflow
// progress with per-step status, current position, and a timeline of durable
// events. Run outputs are reached by reference (ResourceReference), never inlined
// here, so the snapshot stays bounded however large an output grows.

/** A Run's canonical lifecycle state, in words. `blocked` is stored as the durable
 *  pause while its Gate is derived from the current Step Attempt, so a reopened
 *  home re-derives the same Gate with no new Attempt. `halted` is a persisted rest state a
 *  Materialization conflict leaves the Run in until the user restores the file
 *  and resumes (#88, ADR 0023). `cancelled` is the terminal rest a `cancel-run`
 *  leaves a live Run in (#87, #98). There is no `created`: a launched Run is
 *  observed `running` from the moment it is admitted (#98 A7); the Run Store's own
 *  pre-start bookkeeping never crosses this Port. */
export type RunStateName =
  "running" | "succeeded" | "failed" | "blocked" | "halted" | "cancelled";

/** One Step's status within a Run's ordered progress. `blocked` is the Step a
 *  Repeat group is paused at (its Review checkpoint), or the Step a Materialization
 *  conflict stopped before it could run. */
export type RunStepStatus =
  "pending" | "running" | "succeeded" | "failed" | "blocked";
export interface RunStepProgress {
  readonly id: string;
  readonly kind: StepKindName;
  readonly status: RunStepStatus;
}

/** One durable Run event: when it happened and, where it helps, a detail.
 *  `iteration` marks one completed Repeat-group iteration; `checkpoint-blocked`
 *  marks the Run resting at a Review checkpoint (#84). */
export type RunTimelineKind =
  | "run-created"
  | "trust-granted"
  | "attempt-settled"
  | "iteration"
  | "checkpoint-blocked"
  | "gate-answered"
  | "materialization-conflict";
export interface RunTimelineEvent {
  readonly at: string; // ISO 8601
  readonly event: RunTimelineKind;
  /** The Attempt outcome for `attempt-settled`; the granting operation id for
   *  `trust-granted`; the iteration ordinal for `iteration`; the completed
   *  iteration count for `checkpoint-blocked`; the answer (`continue`/`stop`) for
   *  `gate-answered`; the declared Workspace path for `materialization-conflict`;
   *  absent for `run-created`. */
  readonly detail?: string;
}

/** A Materialization conflict currently resting a Run `halted`: a `home: workspace`
 *  Artifact whose Workspace copy went missing or changed before a Step could use
 *  it (#88, ADR 0023). The detailed diagnostic is reached by reference, never
 *  inlined, so the snapshot stays bounded (AC5). */
export interface RunConflictView {
  readonly artifactName: string;
  readonly path: string; // the declared relative Workspace path
  readonly reference: DiagnosticReference;
}

/** One Run output, reachable through `readResource`. Only `text` and `verdict`
 *  are reachable in M2; file/file-set materialization is a later slice. */
export interface RunOutputView {
  readonly name: string;
  readonly type: "text" | "verdict";
  readonly reference: ResourceReference;
}

/** The exact durable reference of the approve/reject Human Gate a blocked Run
 *  rests at, derived from the current Step Attempt (never stored). Distinct from
 *  a `ResourceReference`: it names the Attempt the Gate pauses, so #85 can answer
 *  it. */
export interface RunGateReference {
  readonly runId: string;
  readonly stepId: string; // the Step whose current Attempt the Gate derives from
  readonly attemptId: string; // that current Step Attempt
  readonly shape: "approve-reject";
}

/** The Review checkpoint a `blocked` Run is paused at (ADR 0020, #84). Present
 *  only when `state` is `blocked`. */
export interface RunCheckpointView {
  readonly message: string; // the authored reviewCheckpoint message
  readonly interval: number; // the effective cadence, clamped to the engine ceiling
  readonly completedIterations: number; // iterations completed since the last grant
  /** The `until` Verdict's latest value (`fail` when blocked) and its reference. */
  readonly latestVerdict: {
    readonly name: string;
    readonly value: "pass" | "fail";
    readonly reference: ResourceReference;
  };
  readonly gate: RunGateReference; // the Gate's exact durable reference
}

/** A Run's bounded snapshot. Outputs carry references, not bytes. */
export interface RunView {
  readonly runId: string;
  readonly bundle: {
    readonly id: string;
    readonly version: string;
    readonly name: string;
    readonly digest: string; // SHA-256 hex over the installed bytes
  };
  readonly workspacePath: string;
  readonly launchedAt: string; // ISO 8601
  readonly state: RunStateName;
  readonly liveness:
    | { readonly state: "not-live" }
    | { readonly state: "live-here"; readonly ownerPid: number }
    | { readonly state: "live-elsewhere"; readonly ownerPid: number };
  readonly progress: readonly RunStepProgress[];
  /** Index of the current Step; `progress.length` once the Run is at rest. */
  readonly position: number;
  readonly timeline: readonly RunTimelineEvent[];
  readonly outputs: readonly RunOutputView[];
  /** The Review checkpoint facts, present only when `state` is `blocked` (#84). */
  readonly checkpoint?: RunCheckpointView;
  /** Typed opportunities on this Run. The `answer-human-gate` offer appears only
   *  while `state` is `blocked` (#85); absent otherwise. */
  readonly actionOffers: readonly ActionOffer[];
  /** Present only while the Run rests `halted` on a Materialization conflict. */
  readonly conflict?: RunConflictView;
}

export interface RunSnapshot {
  readonly family: "run";
  readonly runId: string;
  readonly result: RunResult;
}
/** The Run, or a Problem when no such Run exists or its store is damaged —
 *  carried the way an operation carries `operation-not-found`, not thrown. */
export type RunResult =
  | { readonly found: true; readonly run: RunView }
  | { readonly found: false; readonly problem: Problem };

// --- run-list family -------------------------------------------------------
//
// The Workspace's Previous Runs (#87): a bounded, newest-first page of the Runs
// launched against this Workspace, joined from the Run Store's registrations and
// each Run's canonical record. Rows carry only the Bundle human name, Run id, and
// latest durable-activity time — Run state and actions live only on the exact
// `run` Projection. Runs from another Workspace never appear (each Workspace has
// its own Run group).

/** Which day bucket a row falls in, relative to the snapshot's `now`. */
export type RunListGroup = "today" | "yesterday" | "older";

/** The filter the list was read under: every Run, or only the resumable
 *  (`halted` and `failed`) ones. */
export type RunListFilter = "all" | "resumable";

/** One Previous-Runs row. Carries identity, the Bundle's human name, the latest
 *  durable-activity time, liveness, and its day group — no Run state (#87). */
export interface RunListRow {
  readonly runId: string;
  readonly bundleName: string;
  /** ISO 8601 durable-activity time the list orders and groups by. M2 populates
   *  it with the Run's launch time; a per-Attempt "last touched" needs a Store
   *  timestamp the record does not yet carry (see run-list.ts). */
  readonly activityAt: string;
  readonly live: boolean;
  readonly ownedByThisProcess: boolean;
  readonly ownerPid?: number;
  readonly group: RunListGroup;
}

/** A bounded page of Previous Runs, newest first. `nextCursor` requests the next
 *  older page (absent on the final page); `beginningOfHistory` marks that final
 *  page; `empty` marks an informational empty snapshot (no Runs match). */
export interface RunListSnapshot {
  readonly family: "run-list";
  readonly filter: RunListFilter;
  readonly rows: readonly RunListRow[];
  /** A stable cursor for the next older page; absent when this is the final page. */
  readonly nextCursor?: string;
  /** True on the final page: there is no older history beyond these rows. */
  readonly beginningOfHistory: boolean;
  /** True when no Run matches the filter: an informational empty snapshot. */
  readonly empty: boolean;
}

/** A typed opportunity bound to an exact target. The closed set grows one
 *  variant per slice; each offer names the consequence of taking it. */
export type ActionOffer =
  | ApproveWorkspaceOffer
  | AnswerHumanGateOffer
  | ResumeRunOffer
  | CancelRunOffer
  | DeleteRunOffer;

/** Approve the launch Workspace (M1). Offered while it is unapproved. */
export interface ApproveWorkspaceOffer {
  readonly action: "approve-workspace";
  readonly input: { readonly path: string };
}

/** Answer the Human Gate a `blocked` Run rests at (#85). Offered on the `run`
 *  Projection only while the Run is blocked; it names the consequence of each
 *  answer so a client can present them without re-deriving the model. */
export interface AnswerHumanGateOffer {
  readonly action: "answer-human-gate";
  readonly gate: RunGateReference;
  /** What `continue` does: grants exactly one more review interval. */
  readonly continueConsequence: string;
  /** What `stop` does: ends the Run `failed`, keeping history and Artifacts. */
  readonly stopConsequence: string;
}

/** Resume a resting Run or take over a nonterminal Run owned by another process. */
export interface ResumeRunOffer {
  readonly action: "resume-run";
  readonly runId: string;
  /** What resume does from the Run's current resting state. */
  readonly consequence: string;
  /** Present when resume requires an explicit takeover confirmation. */
  readonly takeover?: { readonly ownerPid: number };
}

/** Cancel a live Run (#87). Offered on the `run` Projection only while the Run is
 *  live; it names the consequence so a client presents it without re-deriving. */
export interface CancelRunOffer {
  readonly action: "cancel-run";
  readonly runId: string;
  readonly consequence: string;
}

/** Delete a resting or terminal Run (#87). Offered on the `run` Projection only
 *  while the Run is not live; it names the consequence of taking it. */
export interface DeleteRunOffer {
  readonly action: "delete-run";
  readonly runId: string;
  readonly consequence: string;
}

export type ProjectionUpdate<
  S extends ProjectionSnapshot = ProjectionSnapshot,
> =
  | { readonly kind: "durable"; readonly snapshot: S }
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

/** A reference to one Run output, resolved through `readResource`. It names the
 *  Run, the artifact, and the exact bound version, so a later publication of the
 *  same name does not change what a held reference reads. M2 references `text`
 *  Artifacts and Verdicts only. */
export interface ResourceReference {
  readonly runId: string;
  readonly artifactName: string;
  readonly versionId: string;
  readonly type: "text" | "verdict";
}
/** A reference to a Run's recorded diagnostic, resolved through `readResource`.
 *  It names the Run and the exact diagnostic; unlike an output reference it binds
 *  no artifact version. The Materialization-conflict diagnostic is reached this
 *  way so `run show` can name the conflict without inlining its detail (#88). */
export interface DiagnosticReference {
  readonly runId: string;
  readonly diagnosticId: string;
  readonly type: "diagnostic";
}
/** The content of a resolved reference, or a Problem when the run or the bytes
 *  are gone. `text` is the captured output; `verdict` is `pass`/`fail`;
 *  `diagnostic` is a recorded diagnostic's text. M2 outputs are textual, so bytes
 *  decode as UTF-8 (ADR 0020, #81 ponytail gap). */
export type ResourceRead =
  | {
      readonly found: true;
      readonly type: "text" | "verdict" | "diagnostic";
      readonly content: string;
    }
  | { readonly found: false; readonly problem: Problem };

export interface ProjectionPort {
  // Selector-typed overloads (#74 A8): each concrete selector resolves to the
  // snapshot type it names, so clients drop their `as` casts. A `bundle-catalog`
  // selector splits on `focus` — present is the focus, absent is the list. The
  // final union signature admits a dynamically-typed selector.
  openProjection(selector: {
    readonly family: "workspace";
  }): OpenedProjection<WorkspaceSnapshot>;
  openProjection(selector: {
    readonly family: "operation";
    readonly operationId: string;
  }): OpenedProjection<OperationSnapshot>;
  openProjection(selector: {
    readonly family: "bundle-catalog";
    readonly focus: BundleFocusSelector;
  }): OpenedProjection<BundleFocusSnapshot>;
  openProjection(selector: {
    readonly family: "bundle-catalog";
    readonly focus?: undefined;
  }): OpenedProjection<BundleCatalogSnapshot>;
  openProjection(selector: {
    readonly family: "run";
    readonly runId: string;
  }): OpenedProjection<RunSnapshot>;
  openProjection(selector: {
    readonly family: "run-list";
    readonly resumable?: boolean;
    readonly before?: string;
  }): OpenedProjection<RunListSnapshot>;
  openProjection(selector: ProjectionSelector): OpenedProjection;
  submit(submission: Submission): SubmissionAdmission;
  readResource(
    reference: ResourceReference | DiagnosticReference,
  ): ResourceRead;
}
