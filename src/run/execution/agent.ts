import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  FRESH_SESSION,
  promptSlotPattern,
  type AgentStep,
  type ArtifactType,
  type AssetKind,
  type AttemptOutcome,
  type Reference,
} from "../../workflow/workflow.js";
import type {
  CandidateOutput,
  HarnessIdentityRecord,
  RunOwner,
  TurnKind,
} from "../store/store.js";
import type {
  DurableTurnRecorder,
  HarnessFailure,
  HarnessProfile,
  PreparedHarness,
  RecoveryCoordinate,
  RequestAnswer,
  TurnEvent,
  TurnOrigin,
  TurnResult,
} from "../../harness/harness.js";

// --- Live request-answer channel (#117) ------------------------------------
//
// The Seam an Agent Step's live approval Harness Requests reach a client through.
// Execution adapts the live Harness Turn (its `request-raised`/`answered`/`expired`
// events and its `answerRequest` control) into these normalized, Harness-agnostic
// notifications. The Application provides the channel per Run and turns the
// notifications into the `run` Projection's live overlay; a client answers through
// `answerRequest`, whose outcome is a value, never a throw (ADR 0022). Defined here
// (not in the Application) because execution owns the Step context and must not
// import above its Seam. Absent for a Command-only Run and whenever no client wired
// one in.

/** Who answered a request — carried down so the durable `request-answered` names
 *  the provenance the Harness Adapter cannot know (a client policy vs a human). */
export type RequestAnswerBy = "human" | "client-policy";

/** One outstanding approval request, flattened to strings. */
export interface LiveRequestView {
  readonly requestId: string;
  readonly tool: string;
  readonly input: string;
  readonly decisions: readonly ("allow" | "deny")[];
}

/** The normalized outcome of answering one request. Never throws. */
export type LiveAnswerOutcome =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "rejected"; readonly reason: string }
  | { readonly outcome: "indeterminate" };

/** Answer one outstanding request on the live Turn. */
export type RequestAnswerFn = (
  requestId: string,
  decision: "allow" | "deny",
  by: RequestAnswerBy,
) => Promise<LiveAnswerOutcome>;

/** Coalesced live observations for the overlay (never durable). */
export interface LiveObservation {
  readonly activity?: string;
  readonly preview?: string;
  readonly context?: {
    readonly usedTokens: number;
    readonly limitTokens: number;
  };
  readonly usage?: string;
}

export interface RequestChannel {
  /** An approval request was raised on the live Turn (now outstanding). */
  raised(request: LiveRequestView): void;
  /** The request was answered or expired; it is no longer outstanding. */
  settled(requestId: string): void;
  /** Bind (or, with `undefined`, unbind) the answer function for the active Turn.
   *  Bound before the first request can be raised, unbound when the Turn ends. */
  bindAnswer(answer: RequestAnswerFn | undefined): void;
  /** Merge live overlay observations (activity / preview / context / usage). */
  observe(observation: LiveObservation): void;
}

/** What an Agent Step needs from composition (#116): the prepared Harness the Run
 *  owns (started once, reused across every Agent Step naming the same Session, and
 *  closed by composition when the Run rests), plus the manifest facts prompt
 *  rendering resolves against — the declared type of each Launch input (so a `file`
 *  slot renders as a path and a `file-set` as one path per line) and the kind of
 *  each declared asset (so only a `skill` in `uses` appends a `SKILL.md` line). */
export interface HarnessExecutionDeps {
  readonly prepared: PreparedHarness;
  readonly inputTypes: Readonly<Record<string, ArtifactType>>;
  readonly assetKinds: Readonly<Record<string, AssetKind>>;
}

/** Thrown by `executeRouting` when the caller's cancel signal aborts a Command
 *  mid-run: the child's process group is killed and the walk unwinds without
 *  publishing an Attempt or resting the Run, so `cancel-run` owns the `cancelled`
 *  rest. The Application drives that cancel signal in production (`wiring.ts`
 *  passes the signal; `application.ts` aborts with `RUN_CANCEL_ABORT`, #87/#98). */
export class RunCancelledError extends Error {
  constructor() {
    super("execution: the Run was cancelled mid-command.");
    this.name = "RunCancelledError";
  }
}

// The abort-reason vocabulary the cancel Seam carries, owned here because this is
// the Module that interprets it — for a Command through the process Seam, and for
// an Agent Turn at the Harness Seam (#118). All three stop a live Turn; they differ
// only in the Run's resting state, which the Application decides from the reason:
// `RUN_CANCEL_ABORT` ends the Run `cancelled` (the terminal cancel-run, #87/#98),
// while `INTERRUPT_TURN_ABORT` (a Port control) and `SIGNAL_ABORT` (Ctrl+C / an OS
// signal) rest it `halted`, resumable (ADR 0019). The Application imports these so
// there is one source of truth for the sentinel strings.
export const RUN_CANCEL_ABORT = "secant:cancel-run";
export const INTERRUPT_TURN_ABORT = "secant:interrupt-turn";
export const SIGNAL_ABORT = "secant:process-signal";

/** One Step Attempt's outcome and, when it ran, the outputs to publish. */
export interface StepAttempt {
  readonly outcome: AttemptOutcome;
  readonly outputs: readonly CandidateOutput[];
  /** The effective model an Agent Step's Turn ran under (#116), recorded on the
   *  Attempt. Absent for a Command/Gate Attempt. */
  readonly effectiveModel?: string;
  /** The normalized Harness identity an autonomous Agent Step's Turn qualified under,
   *  from the prepared profile (#125): Harness name, resolved executable, and observed
   *  executable version. Present for every autonomous Agent Step Attempt (whatever its
   *  outcome), so the identity is durable even for an interrupted, lost, or
   *  recovery-refused Turn. Absent for a Command/Gate Attempt, and for the
   *  interactive-agent Step's synthetic Attempt (#122), which records neither identity
   *  nor effective model — the same scope as `effectiveModel`. */
  readonly harnessIdentity?: HarnessIdentityRecord;
}

interface StepContext {
  readonly owner: RunOwner;
  readonly resolveAsset: (assetPath: string) => string | undefined;
  readonly cancelSignal?: AbortSignal;
  readonly harness?: HarnessExecutionDeps;
  readonly requestChannel?: RequestChannel;
}

// --- Agent step (a Harness Turn dispatch entry, #116) ----------------------

/**
 * Run one autonomous Turn in the Step's named Session and map its result to an
 * Attempt outcome (#116). The rendered prompt is admitted as the Turn's transcript
 * input before the stdin frame is sent (the durable recorder the Adapter awaits: a
 * write failure proves the Turn `not-started`), events drain into the Store as they
 * arrive, and the settled result maps: `completed` → `succeeded`; `failed` and
 * `not-started` → `failed` (retryable within budget); `interrupted` → `cancelled`
 * (Run `halted`); `lost` → `indeterminate` (Run `halted`). The Agent Step produces
 * no Artifacts in M3, so a succeeded Attempt publishes an empty output set.
 */
export async function runAgent(
  step: AgentStep,
  context: StepContext,
  attemptId: string,
): Promise<StepAttempt> {
  const harness = context.harness;
  if (harness === undefined) {
    // Preflight guarantees a prepared Harness for a Bundle carrying an Agent Step;
    // reaching here without one is a wiring fault composition owns.
    throw new Error("execution: an Agent Step ran without a prepared Harness.");
  }
  const owner = context.owner;
  const rendered = renderAgentPrompt(step, context, harness);
  if (!rendered.ok) {
    return mapTurnResult(rendered.result, harness.prepared.profile);
  }
  const prompt = rendered.prompt;
  // `fresh` isolates a new Session per Attempt (per Iteration inside a Repeat
  // group, since the Attempt id encodes both); any other name is reused, so
  // successive Agent Steps naming it share one live process.
  const session =
    step.session === FRESH_SESSION
      ? `${FRESH_SESSION}-${attemptId}`
      : step.session;
  // One Turn per Agent Step Attempt in M3. The id keys the durable Turn record.
  const turnId = `${attemptId}#turn`;

  const recovery = sessionRecovery(owner, session);
  // `unusable`: recovery already failed and ADR 0022 forbids fabricating a fresh
  // conversation, so the Attempt fails without starting a Turn — no retry ever
  // opens a fresh Session in its place. It still ran under a qualified Harness, so the
  // failed Attempt records the identity (#125), never the effective model (no Turn ran).
  if (recovery.unusable) {
    return {
      outcome: "failed",
      outputs: [],
      harnessIdentity: profileIdentity(harness.prepared.profile),
    };
  }

  const result = await driveHarnessTurn(owner, harness.prepared, {
    session,
    origin: "managed",
    kind: "agent",
    attemptId,
    turnId,
    input: prompt,
    ...(recovery.resume !== undefined ? { resume: recovery.resume } : {}),
    ...(context.requestChannel !== undefined
      ? { requestChannel: context.requestChannel }
      : {}),
    ...(context.cancelSignal !== undefined
      ? { cancelSignal: context.cancelSignal }
      : {}),
  });
  return mapTurnResult(result, harness.prepared.profile);
}

/** What the named Session's last recorded availability says about how the next Turn
 *  opens (#118): `unusable` forbids another Turn (recovery failed, ADR 0022);
 *  `detached` resumes the same Claude Code Session from the stored coordinate;
 *  absent or `open` opens a fresh Turn (a first launch or a healthy same-Session
 *  Turn). Shared by the autonomous Agent Step and the interactive human Turn. */
function sessionRecovery(
  owner: RunOwner,
  session: string,
):
  | { readonly unusable: true }
  | { readonly unusable: false; readonly resume?: RecoveryCoordinate } {
  const record = owner
    .harnessSessions()
    .find((candidate) => candidate.session === session);
  if (record?.availability === "unusable") return { unusable: true };
  const resume: RecoveryCoordinate | undefined =
    record?.availability === "detached" &&
    record.availabilityDetail !== undefined
      ? { opaque: record.availabilityDetail }
      : undefined;
  return { unusable: false, ...(resume !== undefined ? { resume } : {}) };
}

/** The mechanical driving of one Harness Turn shared by the autonomous Agent Step
 *  and the interactive human Turn (#116, #122): admit the input as the Turn's
 *  transcript before the stdin frame (the durable admission the Adapter awaits),
 *  drain events into the Store, relay approval requests to the live channel, wire the
 *  cancel Seam to `interrupt`, settle the durable Turn, and return the raw result.
 *  A full cancel-run (RUN_CANCEL_ABORT) throws `RunCancelledError` so the cancel path
 *  owns the `cancelled` rest; every other result is returned for the caller to map. */
async function driveHarnessTurn(
  owner: RunOwner,
  prepared: PreparedHarness,
  params: {
    readonly session: string;
    readonly origin: TurnOrigin;
    /** The Crucible Step kind that produced this Turn (#126). This is the Step-kind
     *  dispatch seam: the kind is known from the executing Step — the Agent executor
     *  passes `agent`, the interactive human Turn passes `interactive-agent` — and is
     *  recorded durably at admission, never derived from a Harness-native type. */
    readonly kind: TurnKind;
    readonly attemptId: string;
    readonly turnId: string;
    readonly input: string;
    readonly resume?: RecoveryCoordinate;
    readonly requestChannel?: RequestChannel;
    readonly cancelSignal?: AbortSignal;
    /** True for an interactive human Turn, whose Harness is closed the moment the
     *  Turn ends, so its Session settles `detached` for the next Turn to resume. */
    readonly detachAfterTurn?: boolean;
  },
): Promise<TurnResult> {
  const { session, attemptId, turnId } = params;
  const harnessName = prepared.profile.harness;
  // The recovery coordinate the Adapter reveals at admission (Claude Code reveals it
  // before submission), captured so an interactive Turn can settle `detached` by it.
  let recoveryCoordinate: string | undefined;
  const recorder: DurableTurnRecorder = {
    admit(admission) {
      const result = owner.admitTurn({
        turnId,
        attemptId,
        session,
        origin: admission.origin,
        kind: params.kind,
        input: admission.input.text,
        recoveryCoordinate: admission.recoveryCoordinate.opaque,
        harness: harnessName,
        at: new Date(),
      });
      // Only a durable admission makes the coordinate meaningful; a fenced (rejected)
      // admission drives the Turn `not-started`, whose availability is never detached.
      if (result.ok) recoveryCoordinate = admission.recoveryCoordinate.opaque;
      return Promise.resolve(
        result.ok
          ? { recorded: true }
          : { recorded: false, reason: result.reason },
      );
    },
    // M3 records the recovery coordinate at admission (Claude Code reveals it before
    // submission), so a later checkpoint is a no-op success.
    checkpoint() {
      return Promise.resolve({ recorded: true });
    },
  };

  const turn = prepared.startTurn({
    session,
    origin: params.origin,
    correlationKey: { opaque: turnId },
    recorder,
    input: { text: params.input },
    ...(params.resume !== undefined ? { resume: params.resume } : {}),
  });
  // The live request-answer channel (#117): each approval request reaches an
  // observing client through the channel, which the client answers by policy
  // (headless) or a human decision (TUI). The Harness Adapter always emits
  // `request-answered` with `by:"human"` (it cannot know a client policy exists),
  // so the client-declared provenance is stashed here and wins in the durable
  // record.
  const channel = params.requestChannel;
  const answerSources = new Map<string, RequestAnswerBy>();
  turn.subscribe((event) => {
    recordTurnEvent(owner, turnId, event, answerSources);
    if (channel !== undefined) notifyChannel(channel, event);
  });
  if (channel !== undefined) {
    channel.bindAnswer(async (requestId, decision, by) => {
      answerSources.set(requestId, by);
      const answer: RequestAnswer = {
        requestId: { opaque: requestId },
        kind: "approval",
        decision,
      };
      const receipt = await turn.answerRequest(answer);
      return receipt.outcome === "accepted"
        ? { outcome: "accepted" }
        : { outcome: "rejected", reason: receipt.reason };
    });
  }
  // A cancel signal aborting mid-Turn interrupts the live Turn at the Harness Seam
  // (interrupt-turn, Ctrl+C, story 38, #118): the Adapter's `interrupt` stops the
  // native work and the Turn drains to an `interrupted` (or `lost`) result. Both
  // cases map to a resumable rest; the Application decides `cancelled` vs `halted`
  // from the abort reason.
  const signal = params.cancelSignal;
  const onAbort = (): void => {
    void turn.interrupt();
  };
  if (signal !== undefined) {
    if (signal.aborted) void turn.interrupt();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const result = await turn.result();
    settleTurnResult(
      owner,
      turnId,
      session,
      result,
      params.detachAfterTurn === true ? recoveryCoordinate : undefined,
    );
    // A full cancel-run of a live Turn stops the Turn but ends the Run `cancelled`
    // (#87/#98): unwind without settling this Attempt, so the Application's cancel
    // path owns the `cancelled` rest — the same RunCancelledError a cancelled
    // Command throws. An interrupt-turn or an OS signal instead maps the result to
    // a resumable `halted` rest.
    if (signal?.aborted === true && signal.reason === RUN_CANCEL_ABORT) {
      throw new RunCancelledError();
    }
    return result;
  } finally {
    // The Turn is over: drop the abort listener so a completed Turn leaks none, and
    // unbind so a late `answer-harness-request` finds no live answer function and
    // the Application refuses it (the request has expired).
    if (signal !== undefined) signal.removeEventListener("abort", onAbort);
    channel?.bindAnswer(undefined);
  }
}

/** What driving one human interactive Turn needs (#122). */
export interface InteractiveTurnRequest {
  readonly owner: RunOwner;
  readonly prepared: PreparedHarness;
  /** The Step's named Session, reused across the Step's human Turns and the
   *  following Agent Steps that name it. */
  readonly session: string;
  /** The interactive Step's pending Attempt id, so every human Turn links to it. */
  readonly attemptId: string;
  /** A unique id per human Turn (the durable Turn record's key). */
  readonly turnId: string;
  /** The human's verbatim text — Secant authors nothing; recorded as the Turn's
   *  `user` transcript entry before any stdin frame is sent. */
  readonly text: string;
  readonly requestChannel?: RequestChannel;
  readonly cancelSignal?: AbortSignal;
}

/** Drive one human Turn of an interactive-agent Step (#122): admit the human's
 *  verbatim text (origin `human`), resume the named Session when detached, record
 *  the Turn durably, and return the raw result. The Application maps the result to
 *  the Run's next resting state; between Turns the Run stays `blocked`. */
export async function driveInteractiveTurn(
  request: InteractiveTurnRequest,
): Promise<TurnResult> {
  const recovery = sessionRecovery(request.owner, request.session);
  // A Session whose recovery already failed cannot take another Turn (ADR 0022);
  // surface it as a failed result without opening a fresh conversation.
  if (recovery.unusable) return unusableTurnResult(request.session);
  return driveHarnessTurn(request.owner, request.prepared, {
    session: request.session,
    origin: "human",
    kind: "interactive-agent",
    attemptId: request.attemptId,
    turnId: request.turnId,
    input: request.text,
    // The interactive Harness is closed after each human Turn, so settle the Session
    // `detached` for the next Turn (and the following Agent Step) to resume it (#122).
    detachAfterTurn: true,
    ...(recovery.resume !== undefined ? { resume: recovery.resume } : {}),
    ...(request.requestChannel !== undefined
      ? { requestChannel: request.requestChannel }
      : {}),
    ...(request.cancelSignal !== undefined
      ? { cancelSignal: request.cancelSignal }
      : {}),
  });
}

/** The failed result an interactive Turn returns for an unusable Session (#122). */
function unusableTurnResult(session: string): TurnResult {
  return {
    kind: "failed",
    detail: {
      failure: {
        phase: "recovery",
        category: "session-unusable",
        possibleEffects: "none",
        cause: undefined,
        diagnostics: `Session "${session}" is unusable and cannot take another Turn.`,
      },
      effectiveModel: { known: false },
      session: { state: "unusable", reason: "recovery previously failed" },
    },
  };
}

/** Relay one Turn event to the live request-answer channel (#117): approval
 *  requests toggle the outstanding set; preview, context, usage, and activity are
 *  coalesced observations. Durable recording is separate (`recordTurnEvent`). */
function notifyChannel(channel: RequestChannel, event: TurnEvent): void {
  switch (event.kind) {
    case "request-raised":
      if (event.request.shape.kind === "approval") {
        channel.raised({
          requestId: event.request.requestId.opaque,
          tool: event.request.shape.tool,
          input: event.request.shape.input,
          decisions: [...event.request.shape.decisions],
        });
      }
      return;
    case "request-answered":
      channel.settled(event.requestId.opaque);
      return;
    case "request-expired":
      channel.settled(event.requestId.opaque);
      return;
    case "preview":
      channel.observe({ preview: event.text });
      return;
    case "context":
      channel.observe({ context: event.observation });
      return;
    case "usage":
      channel.observe({ usage: event.observation.summary });
      return;
    case "activity":
      channel.observe({ activity: event.description });
      return;
    case "tool-activity":
      channel.observe({
        activity: `${event.activity.tool} ${event.activity.phase}`,
      });
      return;
    default:
      return;
  }
}

/** Render the Agent prompt (#116): fill each `{{artifact:name}}` slot from the
 *  Run's bindings and Launch inputs, then append one line per `skill` in `uses`
 *  telling the agent to read its `SKILL.md`. No `@` or other Harness syntax is
 *  baked in — the file path is a plain absolute path. */
function renderAgentPrompt(
  step: AgentStep,
  context: StepContext,
  harness: HarnessExecutionDeps,
):
  | { readonly ok: true; readonly prompt: string }
  | { readonly ok: false; readonly result: TurnResult } {
  const deliveryFailure = unsupportedDeliveryFailure(harness.prepared.profile);
  if (deliveryFailure !== undefined) {
    return { ok: false, result: deliveryFailure };
  }
  const base = readPromptText(step.prompt, context);
  const filled = base.replace(promptSlotPattern(), (_match, name: string) =>
    resolvePromptSlot(name, context, harness),
  );
  const skillLines: string[] = [];
  for (const use of step.uses ?? []) {
    if (!("asset" in use)) continue;
    if (harness.assetKinds[use.asset] !== "skill") continue;
    const dir = context.resolveAsset(use.asset);
    if (dir === undefined) {
      throw new Error(
        `execution: skill asset "${use.asset}" is not in the pinned Bundle Snapshot.`,
      );
    }
    skillLines.push(
      `Read the skill instructions at ${join(dir, "SKILL.md")} before you begin.`,
    );
  }
  return {
    ok: true,
    prompt:
      skillLines.length === 0
        ? filled
        : `${filled}\n\n${skillLines.join("\n")}`,
  };
}

/** Refuse a profile whose declared delivery cannot be honoured by the plain-path
 *  prompt renderer. This is an operational value, not a throw: no Turn has started
 *  and the profile itself proves retrying cannot change the mismatch. */
function unsupportedDeliveryFailure(
  profile: HarnessProfile,
): TurnResult | undefined {
  const unsupported: string[] = [];
  if (profile.skillDelivery.mode !== "plain-path") {
    unsupported.push(`skill:${profile.skillDelivery.mode}`);
  }
  if (profile.fileDelivery.mode !== "plain-path") {
    unsupported.push(`file:${profile.fileDelivery.mode}`);
  }
  if (unsupported.length === 0) return undefined;
  return {
    kind: "not-started",
    detail: {
      failure: {
        phase: "launch",
        category: "unsupported-delivery-mode",
        possibleEffects: "none",
        retryEvidence: "the prepared Harness profile is immutable",
        diagnostics: `Prompt rendering supports plain-path delivery only; profile declared ${unsupported.join(", ")}.`,
      },
    },
  };
}

/** The prompt asset's or bound artifact's text. */
function readPromptText(prompt: Reference, context: StepContext): string {
  if ("asset" in prompt) {
    const path = context.resolveAsset(prompt.asset);
    if (path === undefined) {
      throw new Error(
        `execution: agent prompt asset "${prompt.asset}" is not in the pinned Bundle Snapshot.`,
      );
    }
    return readFileSync(path, "utf8");
  }
  const versionId = context.owner.currentVersion(prompt.artifact);
  if (versionId === undefined) {
    throw new Error(
      `execution: agent prompt artifact "${prompt.artifact}" is not bound at this Step.`,
    );
  }
  const bytes = context.owner.readArtifact(versionId, prompt.artifact);
  if (bytes === undefined) {
    throw new Error(
      `execution: agent prompt artifact "${prompt.artifact}" has no bytes at its bound version.`,
    );
  }
  return new TextDecoder().decode(bytes);
}

/** Resolve one `{{artifact:name}}` slot: a bound store artifact substitutes as its
 *  canonical text; a Launch input substitutes by its declared type — `file` as an
 *  absolute path (Workspace-relative resolved against the Workspace), `file-set` as
 *  one absolute path per line, everything else as its text. */
function resolvePromptSlot(
  name: string,
  context: StepContext,
  harness: HarnessExecutionDeps,
): string {
  const versionId = context.owner.currentVersion(name);
  if (versionId !== undefined) {
    const bytes = context.owner.readArtifact(versionId, name);
    if (bytes === undefined) {
      throw new Error(
        `execution: agent prompt slot "${name}" has no bytes at its bound version.`,
      );
    }
    return new TextDecoder().decode(bytes);
  }
  const launch = launchInputs(context.owner);
  const value = launch[name];
  if (value === undefined) {
    // The Composition check already proved every slot names a required, bound
    // artifact; reaching here is a broken invariant.
    throw new Error(
      `execution: agent prompt slot "${name}" names an artifact that is neither bound nor a Launch input.`,
    );
  }
  const type = harness.inputTypes[name];
  const workspacePath = context.owner.record.workspacePath;
  if (type === "file") {
    return absoluteWorkspacePath(workspacePath, value);
  }
  if (type === "file-set") {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => absoluteWorkspacePath(workspacePath, line))
      .join("\n");
  }
  return value;
}

/** A file input's absolute path: an absolute value passes through, a
 *  Workspace-relative one resolves against the Workspace root (#116). Host
 *  `node:path.isAbsolute` is correct here (unlike a portable Bundle path, which
 *  needs `bundle/relative-path`): a `file` Launch input is validated to exist on
 *  the executing host at Preflight, so it is always a host-native path. */
function absoluteWorkspacePath(workspacePath: string, value: string): string {
  return isAbsolute(value) ? value : resolvePath(workspacePath, value);
}

/** The Run's Launch inputs, read back from the canonical record as a string map
 *  (validated to that shape at launch and resume). */
export function launchInputs(
  owner: RunOwner,
): Readonly<Record<string, string>> {
  const launch = owner.record.launch;
  if (launch === null || typeof launch !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    launch as Record<string, unknown>,
  )) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/** Drain the meaningful Turn events into the Store as durable timeline entries
 *  (#116): authoritative assistant content and tool activity. Session facts and the
 *  effective model reach the durable view through the settled result; previews,
 *  usage, and context are live-only in M3. Best-effort: `appendTurnEvent` (and
 *  `settleTurn` below) no-op on a fenced owner rather than throw — a fenced owner
 *  means another process took over the Run, and that is surfaced authoritatively
 *  when this Attempt's `publishAttempt` is refused and the walk unwinds. */
function recordTurnEvent(
  owner: RunOwner,
  turnId: string,
  event: TurnEvent,
  answerSources: ReadonlyMap<string, RequestAnswerBy>,
): void {
  if (event.kind === "assistant-content") {
    owner.appendTurnEvent({
      turnId,
      kind: "assistant-content",
      payload: JSON.stringify({ content: event.content }),
      at: new Date(),
    });
  } else if (event.kind === "tool-activity") {
    owner.appendTurnEvent({
      turnId,
      kind: "tool-activity",
      payload: JSON.stringify({
        tool: event.activity.tool,
        phase: event.activity.phase,
        summary: event.activity.summary,
      }),
      at: new Date(),
    });
  } else if (event.kind === "request-raised") {
    // The request's tool and serialized input, so `run show` prints the exact
    // approval a Turn paused on (#117 AC1). Durable history only; the request is
    // never stored as live state, so a resumed Run re-raises nothing.
    if (event.request.shape.kind === "approval") {
      owner.appendTurnEvent({
        turnId,
        kind: "request-raised",
        payload: JSON.stringify({
          requestId: event.request.requestId.opaque,
          tool: event.request.shape.tool,
          input: event.request.shape.input,
          decisions: event.request.shape.decisions,
        }),
        at: new Date(),
      });
    }
  } else if (event.kind === "request-answered") {
    // The client-declared provenance wins over the Adapter's `by:"human"`, so a
    // headless policy answer records "answered by client policy" (#117 AC1).
    const by = answerSources.get(event.requestId.opaque) ?? event.by;
    const decision =
      event.answer.kind === "approval" ? event.answer.decision : undefined;
    owner.appendTurnEvent({
      turnId,
      kind: "request-answered",
      payload: JSON.stringify({
        requestId: event.requestId.opaque,
        by,
        ...(decision !== undefined ? { decision } : {}),
      }),
      at: new Date(),
    });
  } else if (event.kind === "request-expired") {
    owner.appendTurnEvent({
      turnId,
      kind: "request-expired",
      payload: JSON.stringify({ requestId: event.requestId.opaque }),
      at: new Date(),
    });
  }
}

/** Settle the durable Turn record from the authoritative result (#116): the result
 *  kind, the post-Turn Session availability, and any authoritative assistant
 *  content. Immutable in the Store; a fenced write is ignored (the walk unwinds).
 *
 *  `detachCoordinate` is set for a Turn whose Harness is closed the moment the Turn
 *  ends — an interactive human Turn, prepared fresh per Turn (#122, #123). Such a
 *  Turn reports its Session `open` (the Adapter's live-process view at result time,
 *  right for the autonomous held-Harness model), but the closed process leaves the
 *  Session `detached`; recording that, with the recovery coordinate, is what lets
 *  the next human Turn and the following Agent Step resume the same Session.
 *
 *  This settles `detached` before the caller's `finally` closes the Harness, which
 *  is safe: Claude Code recovery is resume-by-id from the Session's persisted state
 *  (native-reattach), not attachment to a live process, so the coordinate is valid
 *  the instant the Turn completes regardless of when the old process is reaped; and
 *  the next Turn/Step is a separate, later Operation (a human send or gate answer),
 *  never concurrent with this close. */
function settleTurnResult(
  owner: RunOwner,
  turnId: string,
  session: string,
  result: TurnResult,
  detachCoordinate?: string,
): void {
  const reported = resultAvailability(owner, session, result);
  const availability =
    detachCoordinate !== undefined && reported.state === "open"
      ? { state: "detached", detail: detachCoordinate }
      : reported;
  owner.settleTurn({
    turnId,
    session,
    resultKind: result.kind,
    resultDetail: turnResultDetail(result),
    availability: availability.state,
    ...(availability.detail !== undefined
      ? { availabilityDetail: availability.detail }
      : {}),
    ...(result.kind === "completed" && result.detail.finalContent !== undefined
      ? { assistantContent: result.detail.finalContent }
      : {}),
    at: new Date(),
  });
}

/** The settled result's detail, flattened to JSON for the durable Turn row. A
 *  failure-bearing kind carries its category, phase, and native exit code (spec
 *  #107 asks `lost`/`failed` to carry them, not just the bare kind); the crash
 *  reconciler writes its own `{kind, unknown}` for an abandoned Turn. */
function turnResultDetail(result: TurnResult): string {
  switch (result.kind) {
    case "completed":
      return JSON.stringify({ kind: "completed" });
    case "not-started":
      return JSON.stringify({
        kind: "not-started",
        failure: flattenFailure(result.detail.failure),
      });
    case "failed":
      return JSON.stringify({
        kind: "failed",
        failure: flattenFailure(result.detail.failure),
      });
    case "interrupted":
      return JSON.stringify({
        kind: "interrupted",
        mode: result.detail.interruption.mode,
      });
    case "lost":
      return JSON.stringify({
        kind: "lost",
        unknown: result.detail.unknown,
        ...(result.detail.failure !== undefined
          ? { failure: flattenFailure(result.detail.failure) }
          : {}),
      });
  }
}

/** The failure fields the durable row keeps: the stable category, the phase, and
 *  the native exit/error code when one exists. Never a raw frame or cause. */
function flattenFailure(failure: HarnessFailure): {
  category: string;
  phase: string;
  nativeCode?: string;
} {
  return {
    category: failure.category,
    phase: failure.phase,
    ...(failure.nativeCode !== undefined
      ? { nativeCode: failure.nativeCode }
      : {}),
  };
}

/** The post-Turn Session availability a result carries, flattened for the Store. */
function resultAvailability(
  owner: RunOwner,
  sessionName: string,
  result: TurnResult,
): {
  state: string;
  detail?: string;
} {
  if (result.kind === "not-started") {
    const recorded = owner
      .harnessSessions()
      .find((session) => session.session === sessionName);
    return recorded === undefined
      ? { state: "open" }
      : {
          state: recorded.availability,
          ...(recorded.availabilityDetail !== undefined
            ? { detail: recorded.availabilityDetail }
            : {}),
        };
  }
  const session = result.detail.session;
  if (session.state === "detached") {
    return { state: "detached", detail: session.coordinate.opaque };
  }
  if (session.state === "unusable") {
    return { state: "unusable", detail: session.reason };
  }
  return { state: "open" };
}

/** The Harness-identity fields to record on an Attempt (#125), spread into a
 *  `publishAttempt` request. Empty for a Command/Gate Attempt (no identity), so it
 *  adds nothing there. */
export function attemptIdentity(result: StepAttempt): {
  harnessIdentity?: HarnessIdentityRecord;
} {
  return result.harnessIdentity !== undefined
    ? { harnessIdentity: result.harnessIdentity }
    : {};
}

/** The normalized Harness identity for an autonomous Agent Step Attempt (#125), read
 *  from the prepared profile. Stamped on the Attempt whatever its outcome, so an
 *  interrupted, lost, or recovery-refused Turn still records the Harness it ran under. */
function profileIdentity(profile: HarnessProfile): HarnessIdentityRecord {
  return {
    harness: profile.harness,
    executable: profile.executable,
    executableVersion: profile.executableVersion,
  };
}

/** Map a Turn result to an Attempt outcome, its effective model (#116), and the
 *  normalized Harness identity it qualified under (#125). The identity comes from the
 *  prepared profile, so it is present for every autonomous Agent Step Attempt whatever
 *  its outcome — an interrupted or lost Turn still ran under a known Harness — while the
 *  effective model is present only when the Turn authoritatively observed one. */
function mapTurnResult(
  result: TurnResult,
  profile: HarnessProfile,
): StepAttempt {
  const model = resultEffectiveModel(result);
  const base = {
    outputs: [] as readonly CandidateOutput[],
    harnessIdentity: profileIdentity(profile),
  };
  switch (result.kind) {
    case "completed":
      return {
        outcome: "succeeded",
        ...base,
        ...(model !== undefined ? { effectiveModel: model } : {}),
      };
    case "failed":
    case "not-started":
      return {
        outcome: "failed",
        ...base,
        ...(model !== undefined ? { effectiveModel: model } : {}),
      };
    case "interrupted":
      return { outcome: "cancelled", ...base };
    case "lost":
      return { outcome: "indeterminate", ...base };
  }
}

/** The effective model a settled result reports, or undefined when unknown or when
 *  the result never reached a model observation. */
function resultEffectiveModel(result: TurnResult): string | undefined {
  if (result.kind === "completed" || result.kind === "failed") {
    const model = result.detail.effectiveModel;
    return model.known ? model.model : undefined;
  }
  return undefined;
}
