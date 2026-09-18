// The Harness Module owns Crucible's one truthful Harness Adapter Interface (ADR
// 0022): the contract every Harness Adapter — the deterministic fake here, the
// Claude Code, Codex, and Gemini Adapters later — implements at the Harness
// Seam. This file is the whole public surface: the Interface, the evidence-
// bearing profile, and the factory a composition root calls. It names no native
// conversation id, filesystem path, raw protocol frame, or protocol type; those
// stay private to each Adapter. It knows nothing of Routing, Step kind, retry
// budget, or Run policy, all of which live above the Seam. Native Adapter
// implementations re-export only their deliberately public factories here.

// ---------------------------------------------------------------------------
// Opaque coordinates
//
// Crucible mints and stores these but never interprets them. They are values,
// not native ids: an Adapter maps them to its private native identifiers and
// nothing above the Seam decides anything from their contents.
// ---------------------------------------------------------------------------

/** Build a readonly tuple that must list every member of a string union (A39).
 *  A bare `readonly X[]` annotation lets an *added* union member compile against
 *  the old array, so the loud-failure claim only caught renames and deletions.
 *  Here a missing member turns the argument type into `{ missing: … }`, which the
 *  array literal cannot be, so adding a variant without extending the tuple fails
 *  the build; an out-of-union value fails it too. */
const exhaustive =
  <Union extends string>() =>
  <Tuple extends readonly Union[]>(
    tuple: [Union] extends [Tuple[number]]
      ? Tuple
      : { readonly missing: Exclude<Union, Tuple[number]> },
  ): Tuple =>
    tuple as Tuple;

/** The three supported operating systems, in canonical order. */
export type HarnessPlatform = "windows" | "macos" | "linux";
export const HARNESS_PLATFORMS = exhaustive<HarnessPlatform>()([
  "windows",
  "macos",
  "linux",
] as const);

/** Crucible's per-Turn correlation key. Opaque, and not an exactly-once
 *  promise, so uncertain submission is never automatically retried. */
export interface CorrelationKey {
  readonly opaque: string;
}

/** An opaque native recovery coordinate held for reattaching a detached
 *  Session. Never Run truth: nothing above the Seam reads its contents. */
export interface RecoveryCoordinate {
  readonly opaque: string;
}

/** Identifies one outstanding Harness Request within a live Turn. */
export interface RequestId {
  readonly opaque: string;
}

// ---------------------------------------------------------------------------
// Evidence-bearing profile
//
// `prepare` returns an immutable semantic profile. Every capability is an
// evidence-bearing variant rather than a flat boolean: each carries the
// qualification evidence it rests on, so a caller can show why a capability is
// or is not available and never has to infer it.
// ---------------------------------------------------------------------------

/** Native recovery: reattach by native id, load-with-replay, or none. */
export type RecoveryCapability =
  | { readonly mode: "native-reattach"; readonly evidence: string }
  | { readonly mode: "load-with-replay"; readonly evidence: string }
  | { readonly mode: "unavailable"; readonly evidence: string };

/** Interruption: confirmed active-Turn interruption, process-only stop, or
 *  none. Process-only stop ends the Turn and the process but leaves the Session
 *  resumable. */
export type InterruptionCapability =
  | { readonly mode: "active-turn"; readonly evidence: string }
  | { readonly mode: "process-only"; readonly evidence: string }
  | { readonly mode: "unavailable"; readonly evidence: string };

/** Whether tool approvals can be raised as Harness Requests. Independent of
 *  structured clarifications. */
export type ApprovalsCapability =
  | { readonly available: true; readonly evidence: string }
  | { readonly available: false; readonly evidence: string };

/** Whether structured clarifications can be raised as Harness Requests.
 *  Independent of approvals; never emulated when unavailable. */
export type ClarificationsCapability =
  | { readonly available: true; readonly evidence: string }
  | { readonly available: false; readonly evidence: string };

/** Where model selection can occur, or that Crucible cannot select a model. */
export type ModelSelectionCapability =
  | { readonly at: "launch"; readonly evidence: string }
  | { readonly at: "per-turn"; readonly evidence: string }
  | { readonly at: "launch-and-per-turn"; readonly evidence: string }
  | { readonly at: "unavailable"; readonly evidence: string };

/** Whether a durable recovery coordinate can be recorded before submission,
 *  only after native acceptance (an unavoidable crash window), or never. */
export type RecoveryCoordinateTiming =
  | { readonly timing: "before-submission"; readonly evidence: string }
  | { readonly timing: "after-acceptance"; readonly evidence: string }
  | { readonly timing: "unavailable"; readonly evidence: string };

/** How a skill Bundle Asset reaches the agent: natively or by plain path. */
export type SkillDelivery =
  | { readonly mode: "native"; readonly evidence: string }
  | { readonly mode: "plain-path"; readonly evidence: string };

/** How a file artifact reaches the agent. Plain path in v1. */
export type FileDelivery =
  | { readonly mode: "native"; readonly evidence: string }
  | { readonly mode: "plain-path"; readonly evidence: string };

/**
 * The immutable semantic profile `prepare` returns, tied to the observed
 * executable, version, platform, configuration posture, and Adapter revision.
 */
export interface HarnessProfile {
  /** Opaque name of the Harness this profile describes. */
  readonly harness: string;
  /** The resolved executable or command qualification observed. */
  readonly executable: string;
  /** The version qualification observed. */
  readonly executableVersion: string;
  readonly platform: HarnessPlatform;
  /** The Adapter revision the profile was produced by. */
  readonly adapterRevision: string;
  /** How the Harness was configured for the qualification (e.g. the flags
   *  Crucible added), stated as a posture rather than raw arguments. */
  readonly configurationPosture: string;
  readonly recovery: RecoveryCapability;
  readonly interruption: InterruptionCapability;
  readonly approvals: ApprovalsCapability;
  readonly clarifications: ClarificationsCapability;
  readonly modelSelection: ModelSelectionCapability;
  readonly recoveryCoordinate: RecoveryCoordinateTiming;
  readonly skillDelivery: SkillDelivery;
  readonly fileDelivery: FileDelivery;
}

// ---------------------------------------------------------------------------
// Durable Turn recorder and Turn submission
//
// Crucible supplies an opaque correlation key and a durable Turn recorder the
// Adapter awaits before sending content. Recording failure proves the Turn
// `not-started`. A recovery coordinate revealed only after acceptance is
// recorded through the same recorder; a late failure there is reported
// separately and never falsifies a settled result.
// ---------------------------------------------------------------------------

/** Whether a Step's input is authored by Crucible or typed by a human. */
export type TurnOrigin = "managed" | "human";
export const TURN_ORIGINS = exhaustive<TurnOrigin>()([
  "managed",
  "human",
] as const);

/** The content of one Turn. The caller renders the prompt text, substituting
 *  any Bundle artifacts, and supplies it here; the Adapter owns only the
 *  delivery mode (a profile fact), never the prompt text (ADR 0022). */
export interface TurnInput {
  readonly text: string;
}

/** What the durable recorder admits before content is sent. */
export interface TurnAdmission {
  readonly correlationKey: CorrelationKey;
  readonly session: string;
  readonly origin: TurnOrigin;
  /** The exact rendered transcript input admitted before native submission. */
  readonly input: TurnInput;
  /** The opaque native coordinate Secant records before submission. */
  readonly recoveryCoordinate: RecoveryCoordinate;
  /** Present when this Turn resumes a detached Session. */
  readonly resume?: RecoveryCoordinate;
}

/** The recorder's answer, returned as a value. `recorded: false` on admission
 *  proves the Turn `not-started`. */
export type RecordingReceipt =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly reason: string };

/** The Crucible-owned durable recorder the Adapter awaits. */
export interface DurableTurnRecorder {
  /** Await durable admission before any content is sent. A `recorded: false`
   *  receipt (or a rejected promise) proves the Turn `not-started`. */
  admit(admission: TurnAdmission): Promise<RecordingReceipt>;
  /** Record a recovery coordinate revealed only after acceptance. Its failure
   *  is reported separately and never rewrites a settled result. */
  checkpoint(coordinate: RecoveryCoordinate): Promise<RecordingReceipt>;
}

/** Everything `startTurn` needs. The handle returns before native acceptance. */
export interface TurnRequest {
  readonly session: string;
  readonly origin: TurnOrigin;
  readonly correlationKey: CorrelationKey;
  readonly recorder: DurableTurnRecorder;
  readonly input: TurnInput;
  /** When set, resume the named Session from this coordinate. */
  readonly resume?: RecoveryCoordinate;
}

// ---------------------------------------------------------------------------
// Harness Requests
//
// Turn-scoped, independently keyed, may coexist, and expire when the Turn ends,
// is interrupted, or is lost. An ordinary assistant question at a Turn boundary
// is not a Harness Request.
// ---------------------------------------------------------------------------

/** The decisions a tool approval offers. Claude Code offers no "always". */
export type ApprovalDecision = "allow" | "deny";
export const APPROVAL_DECISIONS = exhaustive<ApprovalDecision>()([
  "allow",
  "deny",
] as const);

/** The shape of one Harness Request. */
export type RequestShape =
  | {
      readonly kind: "approval";
      readonly tool: string;
      readonly input: string;
      readonly decisions: readonly ApprovalDecision[];
    }
  | {
      readonly kind: "clarification";
      readonly prompt: string;
    };

/** One raised Harness Request. */
export interface HarnessRequest {
  readonly requestId: RequestId;
  readonly shape: RequestShape;
}

/** An answer addressed to one exact outstanding request. Its `kind` must match
 *  the request's shape, or the control is rejected `shape-mismatch`. */
export type RequestAnswer =
  | {
      readonly requestId: RequestId;
      readonly kind: "approval";
      readonly decision: ApprovalDecision;
    }
  | {
      readonly requestId: RequestId;
      readonly kind: "clarification";
      readonly text: string;
    };

/** Who answered a Harness Request. */
export type AnswerSource = "human" | "client-policy";

// ---------------------------------------------------------------------------
// Turn event vocabulary
//
// One ordered stream preserving every user-meaningful fact. Raw frames, private
// reasoning, telemetry, and ordinary stderr are never events. Previews are the
// only coalesced, replaceable entries.
// ---------------------------------------------------------------------------

/** A tool's lifecycle within a Turn. */
export interface ToolActivity {
  readonly tool: string;
  readonly phase: "started" | "completed";
  readonly summary: string;
  /** Parent activity identity for subagent work, when the Harness reports it. */
  readonly parentActivity?: string;
}

/** Semantic Session facts observed during native initialization. The native id
 * crosses the Seam only as an opaque recovery coordinate. */
export interface SessionFacts {
  readonly recoveryCoordinate: RecoveryCoordinate;
  readonly executableVersion?: string;
  readonly tools: readonly string[];
  readonly mcp: readonly {
    readonly name: string;
    readonly status: string;
  }[];
}

/** Context-window pressure, prominent when observed or honestly calculable. */
export interface ContextObservation {
  readonly usedTokens: number;
  readonly limitTokens: number;
}

/** Usage, cost, and rate facts. Always labelled as an estimate. */
export interface UsageObservation {
  readonly estimate: true;
  readonly summary: string;
}

/** The effective model, distinct from any requested model. Stays unknown rather
 *  than copying the request when unconfirmed. */
export type ModelObservation =
  { readonly known: true; readonly model: string } | { readonly known: false };

/** Whether a Session can take a next Turn now, holds a recovery coordinate, or
 *  cannot continue. */
export type SessionAvailability =
  | { readonly state: "open" }
  | { readonly state: "detached"; readonly coordinate: RecoveryCoordinate }
  | { readonly state: "unusable"; readonly reason: string };

/** The closed set of Turn event kinds. */
export type TurnEvent =
  | {
      readonly kind: "session";
      readonly availability: SessionAvailability;
      readonly facts?: SessionFacts;
    }
  | {
      readonly kind: "assistant-content";
      readonly content: string;
      readonly parentActivity?: string;
    }
  | { readonly kind: "tool-activity"; readonly activity: ToolActivity }
  | { readonly kind: "request-raised"; readonly request: HarnessRequest }
  | {
      readonly kind: "request-answered";
      readonly requestId: RequestId;
      readonly by: AnswerSource;
      readonly answer: RequestAnswer;
    }
  | { readonly kind: "request-expired"; readonly requestId: RequestId }
  | { readonly kind: "preview"; readonly text: string }
  | { readonly kind: "context"; readonly observation: ContextObservation }
  | { readonly kind: "usage"; readonly observation: UsageObservation }
  | { readonly kind: "activity"; readonly description: string }
  | { readonly kind: "model"; readonly observation: ModelObservation };

export const TURN_EVENT_KINDS = exhaustive<TurnEvent["kind"]>()([
  "session",
  "assistant-content",
  "tool-activity",
  "request-raised",
  "request-answered",
  "request-expired",
  "preview",
  "context",
  "usage",
  "activity",
  "model",
] as const);

/** A listener on the ordered event stream. Removed by its subscription. */
export type TurnEventListener = (event: TurnEvent) => void;

/** A handle to stop receiving events. */
export interface TurnSubscription {
  unsubscribe(): void;
}

// ---------------------------------------------------------------------------
// Controls
//
// Closed and stateful. Expected races return an accepted or rejected receipt as
// a value rather than throwing.
// ---------------------------------------------------------------------------

/** Native same-Turn guidance. */
export interface SteerInput {
  readonly text: string;
}

/** Why a control was rejected. A closed set of expected races. */
export type ControlRejection =
  "unsupported" | "expired" | "already-settled" | "shape-mismatch";
export const CONTROL_REJECTIONS = exhaustive<ControlRejection>()([
  "unsupported",
  "expired",
  "already-settled",
  "shape-mismatch",
] as const);

/** The value a control returns. Acceptance does not prove final effect. */
export type ControlReceipt =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "rejected"; readonly reason: ControlRejection };

// ---------------------------------------------------------------------------
// Typed operational failures
//
// Operational failures are values preserving phase, category, possible effects,
// and the original cause. Only trusted caller-contract violations throw. Secrets
// Crucible itself introduces are redacted; excluding raw protocol and duplicate
// transcript content is Interface design, not generic redaction.
// ---------------------------------------------------------------------------

/** The mechanical phase a failure occurred in. */
export type FailurePhase =
  "prepare" | "launch" | "turn" | "control" | "recovery" | "cleanup";

/** What the failure may have done to the world. */
export type EffectScope = "none" | "possible" | "committed";

/** A typed operational failure returned as a value. */
export interface HarnessFailure {
  readonly phase: FailurePhase;
  /** A stable category, e.g. `authentication`, `max-turns`, `budget`,
   *  `execution`, `structured-output`, `protocol-corruption`, `not-found`. */
  readonly category: string;
  readonly possibleEffects: EffectScope;
  /** Any partial output captured before the failure. */
  readonly partialOutput?: string;
  /** A native exit or error code, when one exists. Never a raw frame. */
  readonly nativeCode?: string;
  /** Evidence bearing on whether a retry is safe. */
  readonly retryEvidence?: string;
  /** Useful diagnostics for the Harness owner. */
  readonly diagnostics?: string;
  /** The original cause, preserved, with Crucible-introduced secrets redacted. */
  readonly cause?: unknown;
}

// ---------------------------------------------------------------------------
// Turn results
//
// One sole authoritative result, settled after the event producer closes. No
// event follows it.
// ---------------------------------------------------------------------------

/** The Turn never started: durable admission failed before any content. */
export interface NotStartedDetail {
  readonly failure: HarnessFailure;
}

/** An authoritative Harness boundary was reached. */
export interface CompletedDetail {
  readonly finalContent?: string;
  readonly effectiveModel: ModelObservation;
  readonly session: SessionAvailability;
  readonly usage?: UsageObservation;
  /** The receipt of any after-acceptance recovery checkpoint, if one was
   *  attempted. A failed checkpoint here did not falsify this result. */
  readonly recoveryCheckpoint?: RecordingReceipt;
}

/** The Harness reported a terminal error subtype. */
export interface FailedDetail {
  readonly failure: HarnessFailure;
  readonly effectiveModel: ModelObservation;
  readonly session: SessionAvailability;
}

/** The active Turn was interrupted and its native work stopped. */
export interface InterruptedDetail {
  readonly interruption: InterruptionCapability;
  readonly session: SessionAvailability;
}

/** Which terminal truth is unknown after a Turn is lost. */
export type LostUnknown = "acceptance" | "completion" | "interruption";
export const LOST_UNKNOWNS = exhaustive<LostUnknown>()([
  "acceptance",
  "completion",
  "interruption",
] as const);

/** Effects may have started but no terminal truth survived recovery probes. */
export interface LostDetail {
  readonly unknown: LostUnknown;
  /** The last authoritative observation before truth was lost. */
  readonly lastObservation: string;
  readonly session: SessionAvailability;
  readonly failure?: HarnessFailure;
}

/** The closed set of Turn results, each with typed detail. */
export type TurnResult =
  | { readonly kind: "not-started"; readonly detail: NotStartedDetail }
  | { readonly kind: "completed"; readonly detail: CompletedDetail }
  | { readonly kind: "failed"; readonly detail: FailedDetail }
  | { readonly kind: "interrupted"; readonly detail: InterruptedDetail }
  | { readonly kind: "lost"; readonly detail: LostDetail };

export const TURN_RESULT_KINDS = exhaustive<TurnResult["kind"]>()([
  "not-started",
  "completed",
  "failed",
  "interrupted",
  "lost",
] as const);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** The result of `close`. Idempotent: a second `close` returns the same value.
 *  Cleanup failure is separate and cannot rewrite a settled Turn. */
export interface CleanupReport {
  readonly clean: boolean;
  readonly detail: string;
  readonly failure?: HarnessFailure;
  /** Final availability of every Session the prepared Harness owned. */
  readonly sessions?: readonly {
    readonly session: string;
    readonly availability: SessionAvailability;
  }[];
}

// ---------------------------------------------------------------------------
// The Interface
// ---------------------------------------------------------------------------

/**
 * One mechanical exchange inside a Harness Session. The handle is returned
 * before native acceptance. Its event stream is ordered and closes before the
 * result settles; its controls return receipts as values.
 */
export interface HarnessTurn {
  /** Subscribe to the ordered event stream. Events already produced are
   *  delivered in order, and later events follow in order. No event is
   *  delivered after `result` settles. */
  subscribe(listener: TurnEventListener): TurnSubscription;
  /** The sole authoritative result. Settles exactly once, after the event
   *  producer closes. */
  result(): Promise<TurnResult>;
  /** Native same-Turn guidance. Rejected `unsupported` where the profile says
   *  so. */
  steer(input: SteerInput): Promise<ControlReceipt>;
  /** Harness-confirmed termination of the active Turn. After an accepted
   *  interrupt, new inputs are rejected and the result confirms the outcome. */
  interrupt(): Promise<ControlReceipt>;
  /** Answer one exact outstanding request. Races (`expired`, `already-settled`,
   *  `shape-mismatch`) return a rejected receipt, never throw. */
  answerRequest(answer: RequestAnswer): Promise<ControlReceipt>;
}

/**
 * A qualified Harness ready for Turns. Allows one active Turn at a time while
 * privately retaining idle named conversations. Ownership transfers once from
 * Preflight to the Run, so exactly one owner is responsible for `close`.
 */
export interface PreparedHarness {
  /** The immutable profile from qualification. */
  readonly profile: HarnessProfile;
  /** Begin one Turn in the named Session. Returns before native acceptance.
   *  Starting a second concurrent Turn is a caller-contract violation. */
  startTurn(request: TurnRequest): HarnessTurn;
  /** Idempotent cleanup: reject new work, expire requests, attempt graceful
   *  interruption, close transports, bound termination and reaping. */
  close(): Promise<CleanupReport>;
}

/** Options for non-conversational Preflight qualification. */
export interface PrepareOptions {
  /** The resolved absolute Workspace directory every Session runs against. */
  readonly workspace: string;
  /** An explicit configured executable path or command, tried before the
   *  canonical name. */
  readonly configuredExecutable?: string;
}

/** The value `prepare` returns: a prepared Harness or a typed failure. */
export type PrepareResult =
  | { readonly ok: true; readonly harness: PreparedHarness }
  | { readonly ok: false; readonly failure: HarnessFailure };

/**
 * A Harness Adapter. `prepare` performs non-conversational qualification,
 * creates no Session, and sends no content. Every operational failure is a
 * value; only caller-contract violations throw.
 */
export interface HarnessAdapter {
  prepare(options: PrepareOptions): Promise<PrepareResult>;
}

/**
 * The factory a composition root calls to obtain an Adapter, and the parameter
 * the shared conformance suite is run against.
 */
export type HarnessAdapterFactory = () => HarnessAdapter;

// ---------------------------------------------------------------------------
// Native Adapters
//
// Each native Adapter keeps its discovery, qualification cache, and protocol
// model private and re-exports only its factory through this entry. The Claude
// Code Adapter (#111) is the first; Codex and Gemini follow.
// ---------------------------------------------------------------------------

export {
  createClaudeCodeAdapter,
  CLAUDE_CODE_EXECUTABLE_ENV,
} from "./claude-code.js";
export type { ClaudeCodeAdapterOverrides } from "./claude-code.js";
