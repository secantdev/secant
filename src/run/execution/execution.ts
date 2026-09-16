import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  flattenSteps,
  MAX_REVIEW_CHECKPOINT_INTERVAL,
  type AgentStep,
  type ArtifactType,
  type AssetKind,
  type AttemptOutcome,
  type CommandInvocation,
  type CommandParams,
  type CommandStep,
  type HumanGateShape,
  type HumanGateStep,
  type Platform,
  type Reference,
  type RepeatGroup,
  type RoutingNode,
  type Step,
  type StepKindName,
} from "../../workflow/workflow.js";
import type {
  AttemptLogEntry,
  CandidateOutput,
  RunOwner,
} from "../store/store.js";
import type {
  DurableTurnRecorder,
  PreparedHarness,
  RequestAnswer,
  TurnEvent,
  TurnResult,
} from "../../harness/harness.js";
import {
  resolveExecutable,
  spawnCommand,
  type SpawnOptions,
  type SpawnResult,
} from "../../process/process.js";

// The Run execution Module owns the Run lifecycle policy: it walks a Routing
// node by node, dispatches each Step through a closed executable Step-kind table,
// retries an Attempt that could not execute within its bound, loops a Repeat
// group on its Verdict, and rests the Run `succeeded`, `failed`, or `blocked`. It
// imports Workflow (the authored vocabulary and the Routing walk order), the Run
// Store (the canonical record every Attempt lands through), the process Module
// (executable resolution, which it shares with Preflight, plus the owned
// child-process spawn/kill it drives here), and the Harness Module (the prepared
// Harness an `agent` Step drives one autonomous Turn through, #116). It never
// constructs a Harness Adapter — composition prepares one and hands it in.
//
// The scheduler learns nothing per Step kind — it looks a kind up in the closed
// table (#13) and never branches on Bundle identity (id, name, asset path). Adding
// a kind means adding a row here, never a new branch; the table holds `command`,
// `human-gate`, and `agent`.
//
// The deterministic-Verdict split (ADR 0020) is the load-bearing invariant: a
// Command step's exit status is a *value* (exit 0 -> `pass`, non-zero -> `fail`),
// not the Attempt outcome. The Attempt `succeeded` because the command ran to an
// exit; it `failed` only when the command could not execute — a missing binary, a
// spawn error, a timeout. So a `fail` Verdict advances a Routing (and drives a
// Repeat group to loop), and only a `failed` Attempt consumes the retry budget.
//
// A Repeat group (ADR 0020) loops its span of Steps until its named `until`
// Verdict reads `pass`. The condition is evaluated before every iteration, so an
// already-`pass` Verdict runs zero iterations. Iterations are bounded separately
// from retries: on completing the review cadence (the authored interval, clamped
// to the engine ceiling) without a pass, the Run rests `blocked` at a Review
// checkpoint. The deciding Attempt still supplies the Gate identity; execution
// stores `blocked` when it pauses so dead-owner reconciliation preserves the Gate.

/**
 * How a `{asset}` reference reaches execution without importing Bundle or
 * Catalog: composition resolves the asset's path in the pinned Bundle Snapshot
 * and hands execution this port. Returns the absolute on-disk path of the asset,
 * or `undefined` for an asset the Snapshot does not carry.
 */
export type AssetResolver = (assetPath: string) => string | undefined;

/**
 * The command-execution Seam (module-design.md). Execution spawns every Command
 * through this port, which defaults to the process Module's real `spawnCommand`.
 * The only justified second Adapter is a test's fast in-process executor: it lets
 * the scheduler's loop-arithmetic tests (Repeat-group cadence, resume, the review
 * clamp) assert their exact outcomes deterministically without spawning a real
 * runtime per iteration — the real spawn path stays covered by the command-contract
 * tests that keep the default (docs/agents/testing.md fixture ladder). Nothing
 * above this Seam varies command execution in production.
 */
export type SpawnCommand = (options: SpawnOptions) => Promise<SpawnResult>;

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

/** Everything the scheduler needs to drive one acquired Run to rest. */
export interface ExecutionDeps {
  /** The acquired Run Store owner every Attempt publishes through. */
  readonly owner: RunOwner;
  /** The host platform, so a Command's platform override resolves deterministically. */
  readonly platform: Platform;
  /** The `{asset}` resolution Seam (see AssetResolver). */
  readonly resolveAsset: AssetResolver;
  /** Retries for a `failed` Attempt when a Step declares no `retry`. */
  readonly defaultRetryBudget?: number;
  /** Wall-clock bound a Command may run before it is killed and the Attempt fails. */
  readonly commandTimeoutMs?: number;
  /** A caller's cancel Seam (`cancel-run`, T4). When it aborts mid-command the
   *  child's process group is killed and the walk unwinds with a RunCancelledError
   *  — no Attempt is published, so `cancel-run` owns the `cancelled` rest. Absent
   *  for a normal Run, which only ever aborts on its own timeout. */
  readonly cancelSignal?: AbortSignal;
  /** The prepared Harness and manifest facts an Agent Step runs against (#116).
   *  Absent for a Command-only Run, which needs no Harness. */
  readonly harness?: HarnessExecutionDeps;
  /** The live request-answer channel an Agent Turn's approval requests reach a
   *  client through (#117). Absent when no client is observing. */
  readonly requestChannel?: RequestChannel;
  /** The command-execution Seam (see SpawnCommand). Defaults to the real
   *  `spawnCommand`; a test injects a fast in-process executor. */
  readonly spawnCommand?: SpawnCommand;
  /** Injectable clock so Attempt timestamps are deterministic in tests. */
  readonly now?: () => Date;
}

/** Thrown by `executeRouting` when the caller's cancel signal aborts a Command
 *  mid-run: the child's process group is killed and the walk unwinds without
 *  publishing an Attempt or resting the Run, so `cancel-run` (T4) owns the
 *  `cancelled` rest. Production never passes a cancel signal until T4 wires it. */
export class RunCancelledError extends Error {
  constructor() {
    super("execution: the Run was cancelled mid-command.");
    this.name = "RunCancelledError";
  }
}

/** How a Run came to rest. `blocked` is a durable pause at a Review checkpoint,
 *  derived (never written) from the current Step Attempt (#84, #85). `halted` is
 *  a resumable rest a Materialization conflict leaves the Run in (#88, ADR 0023). */
export type RunOutcome = "succeeded" | "failed" | "blocked" | "halted";

export interface RunReport {
  readonly outcome: RunOutcome;
}

// The outcome of executing one Routing node. `succeeded-rested` means the node's
// deciding Attempt already advanced the Run to `succeeded` in its own
// transaction; `succeeded-open` means the node completed but did not rest the Run
// (it was not the last node, or a group passed with zero iterations); `failed`,
// `blocked`, and `halted` (a Materialization conflict) end the walk.
type NodeOutcome =
  "succeeded-rested" | "succeeded-open" | "failed" | "blocked" | "halted";

// Crucible-owned defaults (ADR 0020: the engine sets the retry budget, a Bundle
// may override per Step). Retries measure transient flakiness, not problem size.
const DEFAULT_RETRY_BUDGET = 2;
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
// A streaming byte cap on captured output: past it, further chunks are dropped
// (the counter keeps running) and a truncation marker is appended to the `text`
// artifact, so a runaway Command cannot exhaust memory (D3). This is execution's
// own cap, independent of the Artifact Module's git-pipe cap: that Module is
// private to the Run Store and this one cannot import it.
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const TRUNCATION_MARKER = `\n[secant: output truncated at ${MAX_CAPTURE_BYTES / (1024 * 1024)} MiB]\n`;

/** One Step Attempt's outcome and, when it ran, the outputs to publish. */
interface StepAttempt {
  readonly outcome: AttemptOutcome;
  readonly outputs: readonly CandidateOutput[];
  /** The effective model an Agent Step's Turn ran under (#116), recorded on the
   *  Attempt. Absent for a Command/Gate Attempt. */
  readonly effectiveModel?: string;
}

/** A durable pause an executor returns instead of an Attempt (#108): the Step did
 *  not run to a settled outcome — it rests the Run `blocked` and waits for a human.
 *  The scheduler records the pending gate (with the minted Attempt id) and unwinds
 *  the walk `blocked`, never publishing an Attempt. It branches on this shape, not
 *  on the Step kind (#13 rule 6). */
interface StepPause {
  readonly pause: true;
  readonly shape: HumanGateShape;
  readonly message: string; // the exact rendered message shown to the human
  readonly outputArtifactName?: string; // free-text's declared output artifact
}

interface StepContext {
  readonly owner: RunOwner;
  readonly platform: Platform;
  readonly resolveAsset: AssetResolver;
  readonly commandTimeoutMs: number;
  readonly cancelSignal?: AbortSignal;
  /** The command-execution Seam, resolved to the real `spawnCommand` unless a
   *  caller injected an executor (see SpawnCommand). */
  readonly spawnCommand: SpawnCommand;
  /** The prepared Harness and manifest facts an Agent Step runs against (#116). */
  readonly harness?: HarnessExecutionDeps;
  /** The live request-answer channel an Agent Turn reaches a client through (#117). */
  readonly requestChannel?: RequestChannel;
}

type StepExecutor = (
  step: Step,
  context: StepContext,
  attemptId: string,
) => Promise<StepAttempt | StepPause>;

// The closed executable Step-kind dispatch table (#13). A `command` runs to an
// Attempt; a `human-gate` returns a durable pause the scheduler records as a
// pending gate and rests `blocked` at (#108); an `agent` runs one autonomous
// Harness Turn to an Attempt (#116). The scheduler learns nothing per kind — it
// branches only on an Attempt vs the pause shape. `interactive-agent` has no row
// yet (its human-driven turns land in a later slice).
const STEP_EXECUTORS: Readonly<Partial<Record<StepKindName, StepExecutor>>> = {
  command: (step, context) => {
    // The table key guarantees the kind; narrow for the type system.
    if (step.kind !== "command") {
      throw new Error(
        "execution: command executor received a non-command Step.",
      );
    }
    return runCommand(step, context);
  },
  "human-gate": (step, context) => {
    if (step.kind !== "human-gate") {
      throw new Error(
        "execution: human-gate executor received a non-gate Step.",
      );
    }
    return runHumanGate(step, context);
  },
  agent: (step, context, attemptId) => {
    if (step.kind !== "agent") {
      throw new Error("execution: agent executor received a non-agent Step.");
    }
    return runAgent(step, context, attemptId);
  },
};

/** The Step kinds this release can dispatch — the keys of the closed executable
 *  table. Preflight refuses a Routing that uses any other kind (an intrinsic
 *  precondition failure) before a Run is created, so the Proof Bundle's Agent
 *  step is caught at launch rather than at spawn. Single source of truth: adding
 *  a kind to the table adds it here. */
export const EXECUTABLE_STEP_KINDS: readonly StepKindName[] = Object.keys(
  STEP_EXECUTORS,
) as StepKindName[];

interface WalkContext {
  readonly step: StepContext;
  readonly budget: number;
  readonly now: () => Date;
  /** Artifact name → declared relative Workspace path for `home: workspace`
   *  outputs, so a Step verifies the copies it uses before running (#88). */
  readonly materializations: ReadonlyMap<string, string>;
  /** Resume by Step identity, reconstructed from the attempt log (A1): which Step
   *  instances already settled succeeded (skipped on resume) and how many Attempts
   *  each already has (so a re-run gets a fresh Attempt id, never a replay). */
  readonly resume: ResumeState;
}

/**
 * Drive one acquired Run's Routing to rest. Walks the nodes in Routing order,
 * dispatching each Step through the closed table, retrying a `failed` Attempt
 * within its bound, and looping a Repeat group on its `until` Verdict. Rests the
 * Run `succeeded` (every node ran to completion), `failed` (a Step's retry budget
 * was exhausted), or `blocked` (a Repeat group reached its review cadence without
 * a pass). A fenced owner or a publication Problem is a coordination/environment
 * fault and throws — the caller (composition) owns it.
 */
export async function executeRouting(
  routing: readonly RoutingNode[],
  deps: ExecutionDeps,
): Promise<RunReport> {
  const context: WalkContext = {
    step: {
      owner: deps.owner,
      platform: deps.platform,
      resolveAsset: deps.resolveAsset,
      commandTimeoutMs: deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      // The command-execution Seam resolves to the real `spawnCommand` unless a
      // caller injected an executor; production and composition never inject one.
      spawnCommand: deps.spawnCommand ?? spawnCommand,
      ...(deps.cancelSignal !== undefined
        ? { cancelSignal: deps.cancelSignal }
        : {}),
      ...(deps.harness !== undefined ? { harness: deps.harness } : {}),
      ...(deps.requestChannel !== undefined
        ? { requestChannel: deps.requestChannel }
        : {}),
    },
    budget: deps.defaultRetryBudget ?? DEFAULT_RETRY_BUDGET,
    now: deps.now ?? (() => new Date()),
    // `home: workspace` outputs and where they materialize (#88). Keyed on the
    // authored declaration (#13 rule 6: never on Bundle identity).
    materializations: collectMaterializations(flattenSteps(routing)),
    // Resume by Step identity (A1): each Step Attempt's id encodes its Step,
    // Iteration, and Attempt number, so the attempt log names exactly which Step
    // instances already succeeded (skip them) and which failed or never settled
    // (re-run them). Empty on a fresh launch. This replaces the old flat count of
    // succeeded Attempts, whose budget a passed Repeat group leaked to later nodes.
    resume: buildResumeState(deps.owner.attemptLog()),
  };

  writeStateOrThrow(deps.owner, "running");

  const lastIndex = routing.length - 1;
  let restedSucceeded = false;
  for (let index = 0; index < routing.length; index++) {
    const node = routing[index]!;
    const isLastNode = index === lastIndex;
    const outcome =
      "repeat" in node
        ? await runRepeatGroup(node.repeat, context, isLastNode)
        : await runStep(node, context, isLastNode);
    if (outcome === "failed") return { outcome: "failed" };
    if (outcome === "blocked") {
      writeStateOrThrow(deps.owner, "blocked");
      return { outcome: "blocked" };
    }
    if (outcome === "halted") return { outcome: "halted" };
    restedSucceeded = outcome === "succeeded-rested";
  }

  // A node's deciding Attempt already rests the Run `succeeded` in its own
  // transaction (the last plain Step, or the last iteration of a trailing Repeat
  // group). The remaining cases — an empty Routing, or a trailing group that
  // passed with zero iterations — leave no deciding Attempt, so rest here.
  if (!restedSucceeded) writeStateOrThrow(deps.owner, "succeeded");
  return { outcome: "succeeded" };
}

/** Run one plain Step through its retry loop, resting the Run in the deciding
 *  Attempt's transaction: a `failed` Attempt that exhausts the budget rests
 *  `failed`; a success on the last node rests `succeeded`. Advancing separately
 *  would leave a crash between the Attempt commit and the state write stuck at
 *  `running`. */
async function runStep(
  step: Step,
  context: WalkContext,
  isLastNode: boolean,
): Promise<NodeOutcome> {
  // A plain Step runs once per Run, so its Iteration is always zero.
  const outcome = await runStepAttempts(
    step,
    context,
    0,
    isLastNode ? "succeeded" : undefined,
  );
  if (outcome === "halted") return "halted";
  if (outcome === "failed") return "failed";
  // A Human Gate paused: the pending gate is recorded and the Run rests `blocked`
  // durably; executeRouting writes the `blocked` state so open clients update (#108).
  if (outcome === "blocked") return "blocked";
  // A skipped Step (already settled on a prior run) rested nothing this run, so it
  // is `succeeded-open`; executeRouting's final rest covers an all-skipped Run.
  if (outcome === "skipped") return "succeeded-open";
  return isLastNode ? "succeeded-rested" : "succeeded-open";
}

/**
 * Loop a Repeat group until its `until` Verdict reads `pass` (ADR 0020). The
 * condition is evaluated before every iteration, so an already-`pass` Verdict
 * runs zero iterations. On completing the review cadence — the authored interval,
 * clamped to the engine ceiling so a Bundle cannot disable review — without a
 * pass, the Run rests `blocked`: nothing is written, so the block is derived from
 * the current Step Attempt (a reopened home re-derives it with no new Attempt).
 *
 * A `continue`-answered Run resumes here in the answering process (#85): the block
 * released its Workspace claim, so a fresh process re-walks the Routing. Iterations
 * run in absolute order from zero and each Step instance is skipped by identity, so
 * the already-completed iterations replay without re-running (never touching the
 * shared counter file or moving a binding) and only newly-run iterations count
 * toward the cadence — one grant buys exactly one more interval (ADR 0020, A1).
 */
async function runRepeatGroup(
  repeat: RepeatGroup["repeat"],
  context: WalkContext,
  isLastNode: boolean,
): Promise<NodeOutcome> {
  const interval = Math.min(
    repeat.reviewCheckpoint.interval,
    MAX_REVIEW_CHECKPOINT_INTERVAL,
  );
  const owner = context.step.owner;
  // The Verdict is already bound `pass` before entry — zero iterations. On resume
  // this also covers a group a prior granted interval already passed.
  if (verdictPasses(owner, repeat.until)) return "succeeded-open";

  // Iterations count from absolute zero so each Attempt id is unique across
  // resumes; a resume replays the completed iterations (every Step skipped by
  // identity) without re-running them, then runs fresh ones. Only a newly-run
  // iteration counts toward the review cadence, so one grant buys one interval.
  let freshIterations = 0;
  for (let iteration = 0; ; iteration++) {
    const result = await runIteration(repeat, context, isLastNode, iteration);
    if (result.outcome === "failed") return "failed";
    if (result.outcome === "halted") return "halted";
    if (result.outcome === "blocked") return "blocked";
    if (result.ran) freshIterations++;
    // Re-evaluate the condition after the iteration. A pass ends the group;
    // `succeeded-rested` means the iteration's deciding Attempt already rested the
    // Run when this is the last node.
    if (
      result.outcome === "succeeded-rested" ||
      verdictPasses(owner, repeat.until)
    ) {
      return result.outcome;
    }
    // Still not passing: block once the cadence is reached without a pass.
    if (freshIterations >= interval) return "blocked";
  }
}

/** Run one iteration of a Repeat group's span at the given absolute Iteration. A
 *  span Step whose Attempt exhausts its budget rests the Run `failed`. When this is
 *  the last Routing node and the iteration makes the `until` Verdict pass, the last
 *  span Step's Attempt rests the Run `succeeded` — the deciding Attempt. `ran` is
 *  false when every span Step was skipped (a resume replaying a completed
 *  iteration), so the caller does not count it toward the review cadence. */
async function runIteration(
  repeat: RepeatGroup["repeat"],
  context: WalkContext,
  isLastNode: boolean,
  iteration: number,
): Promise<{ outcome: NodeOutcome; ran: boolean }> {
  const { steps, until } = repeat;
  let ran = false;
  for (let s = 0; s < steps.length; s++) {
    const step = steps[s]!;
    const isLastSpanStep = s === steps.length - 1;
    // The deciding-`succeeded` Attempt is the last span Step of the last node when
    // it leaves the `until` Verdict reading `pass`. Compute that intent from the
    // Attempt's own outputs (a Step producing the Verdict) or the current binding.
    const decideOnPass = isLastNode && isLastSpanStep;
    const outcome = await runStepAttempts(
      step,
      context,
      iteration,
      undefined,
      decideOnPass
        ? (result) =>
            iterationPasses(result, until, context.step.owner)
              ? "succeeded"
              : undefined
        : undefined,
    );
    if (outcome === "halted") return { outcome: "halted", ran };
    if (outcome === "failed") return { outcome: "failed", ran };
    // An authored Human Gate span Step paused: the pending gate is recorded and the
    // Run rests `blocked`; unwind the group so executeRouting writes `blocked` (#108).
    if (outcome === "blocked") return { outcome: "blocked", ran };
    if (outcome !== "skipped") ran = true;
  }
  return {
    outcome:
      isLastNode && verdictPasses(context.step.owner, until)
        ? "succeeded-rested"
        : "succeeded-open",
    ran,
  };
}

/**
 * Run one Step's retry loop, publishing each Attempt. A `failed` Attempt that
 * exhausts the budget carries `advanceState: "failed"`. A succeeded Attempt
 * carries `successAdvance` (the caller's fixed `"succeeded"` for a last plain
 * Step) unless `decideSuccessAdvance` is given, which chooses the advance from the
 * Attempt result (the Repeat-group deciding Attempt).
 *
 * Two #88 concerns fold in at this single Step choke point: a Step already settled
 * on a prior run is `"skipped"` (resume), and before any Step runs its
 * `home: workspace` Artifacts are verified — a conflict rests the Run `halted` and
 * returns `"halted"`. Returns the final outcome.
 */
async function runStepAttempts(
  step: Step,
  context: WalkContext,
  iteration: number,
  successAdvance: string | undefined,
  decideSuccessAdvance?: (result: StepAttempt) => string | undefined,
): Promise<AttemptOutcome | "halted" | "skipped" | "blocked"> {
  const instance = instanceKey(step.id, iteration);
  // A Step instance that already settled `succeeded` on a prior run is skipped:
  // its outputs stay bound and materialized, so re-running it would duplicate work
  // and (for a Step that changed a Workspace copy) undo the user's fix.
  if (context.resume.succeeded.has(instance)) return "skipped";
  // Attempts already recorded for this instance (failed retries, or an interrupted
  // Attempt's `indeterminate` marker) set the base Attempt number, so a re-run
  // publishes a fresh id the store never replays as a settled Attempt.
  const baseAttempt = context.resume.attempts.get(instance) ?? 0;
  // Before the Step runs, verify every `home: workspace` Artifact it uses against
  // its bound version (ADR 0023). A missing or changed copy records a conflict and
  // rests the Run `halted`; the Workspace is never overwritten nor its bytes adopted.
  const conflict = verifyMaterializations(
    step,
    context.step,
    context.materializations,
    context.now(),
  );
  if (conflict !== undefined) {
    recordConflictOrThrow(context.step.owner, conflict);
    return "halted";
  }
  const executor = STEP_EXECUTORS[step.kind];
  if (executor === undefined) {
    throw new Error(
      `execution: Step kind "${step.kind}" is not dispatchable ` +
        "(Command runs, Human Gate pauses, Agent runs a Turn; interactive-agent lands later).",
    );
  }
  // Clamp a bad budget to zero so a typo (e.g. -1) still runs the Step once
  // rather than silently skipping it and resting the Run failed with no Attempt.
  const retries = Math.max(0, step.retry ?? context.budget);
  let outcome: AttemptOutcome = "failed";
  for (let attempt = 0; attempt <= retries; attempt++) {
    // The Attempt id encodes Step, Iteration, and Attempt number (A1): it names
    // this instance in the log so resume can skip it, and the Attempt number
    // (continuing past any prior Attempts) keeps a re-run's id fresh.
    const attemptId = encodeAttemptId(
      step.id,
      iteration,
      baseAttempt + attempt,
    );
    // A cancel abort throws RunCancelledError out of the executor: it unwinds the
    // walk here without publishing this Attempt, so `cancel-run` (T4) owns the rest.
    const result = await executor(step, context.step, attemptId);
    // A durable pause (a Human Gate): record the pending gate with this minted
    // Attempt id and rest the Run `blocked` — no Attempt is published, no retry
    // (#108). Recording is idempotent on the Attempt id, so a resume that
    // re-reaches the gate re-rests `blocked` and re-records nothing. A fenced owner
    // means another process took over; throw as the publication path does.
    if ("pause" in result) {
      const recorded = context.step.owner.recordPendingGate({
        attemptId,
        stepId: step.id,
        shape: result.shape,
        message: result.message,
        ...(result.outputArtifactName !== undefined
          ? { outputArtifactName: result.outputArtifactName }
          : {}),
        at: context.now(),
      });
      if (!recorded.ok) {
        throw new Error(
          `execution: cannot record the pending Human Gate: ${recorded.reason}.`,
        );
      }
      return "blocked";
    }
    outcome = result.outcome;
    // An interrupted Attempt (a termination signal, never our timeout) has no
    // result: it is settled `indeterminate`, never retried, and rests the Run
    // `halted` in the same transaction for human resume (ADR 0019, #86). A `lost`
    // Agent Turn maps to `indeterminate` too (#116): terminal truth is unknown.
    if (result.outcome === "indeterminate") {
      publishOrThrow(
        context.step.owner.publishAttempt({
          attemptId,
          outcome: "indeterminate",
          required: [],
          outputs: [],
          at: context.now(),
          advanceState: "halted",
        }),
      );
      return "halted";
    }
    // A `cancelled` Attempt is an interrupted Agent Turn (#116): the Turn's native
    // work stopped, so the Attempt ends `cancelled` and the Run rests `halted` for
    // human resume, never retried — the same resumable rest an interrupt leaves.
    if (result.outcome === "cancelled") {
      publishOrThrow(
        context.step.owner.publishAttempt({
          attemptId,
          outcome: "cancelled",
          required: [],
          outputs: [],
          at: context.now(),
          advanceState: "halted",
        }),
      );
      return "halted";
    }
    const advanceState =
      result.outcome === "failed"
        ? attempt === retries
          ? "failed"
          : undefined
        : (decideSuccessAdvance?.(result) ?? successAdvance);
    publishOrThrow(
      context.step.owner.publishAttempt({
        attemptId,
        outcome: result.outcome,
        // A failed Attempt moves no binding; a succeeded one publishes exactly
        // the Step's declared outputs.
        required: result.outcome === "succeeded" ? (step.produces ?? []) : [],
        outputs: result.outputs,
        at: context.now(),
        advanceState,
        ...(result.effectiveModel !== undefined
          ? { effectiveModel: result.effectiveModel }
          : {}),
      }),
    );
    // A succeeded Attempt's `home: workspace` outputs are now canonical in the
    // store; materialize each into the Workspace at its declared path (#88). Written
    // after publication so a Workspace copy that outlives a failed publication is
    // only external state, never a moved binding (ADR 0023).
    if (result.outcome === "succeeded") {
      materializeOutputs(step, result.outputs, context.step);
    }
    // A Verdict (pass or fail) still ran to an exit, so it advances the Run;
    // only a `failed` Attempt is retried.
    if (result.outcome !== "failed") break;
  }
  return outcome;
}

/** Whether the named Verdict is currently bound to `pass`. */
function verdictPasses(owner: RunOwner, name: string): boolean {
  const versionId = owner.currentVersion(name);
  if (versionId === undefined) return false;
  const bytes = owner.readArtifact(versionId, name);
  return bytes !== undefined && new TextDecoder().decode(bytes) === "pass";
}

/** Whether an iteration's last span Step leaves `until` reading `pass`: prefer
 *  the Verdict this very Attempt is about to publish, else the current binding an
 *  earlier span Step left. */
function iterationPasses(
  result: StepAttempt,
  until: string,
  owner: RunOwner,
): boolean {
  const produced = result.outputs.find(
    (output) => output.name === until && output.type === "verdict",
  );
  if (produced !== undefined) {
    return new TextDecoder().decode(produced.content) === "pass";
  }
  return verdictPasses(owner, until);
}

// --- Workspace materialization and verification (#88, ADR 0023) -------------

/** A detected Materialization conflict, ready to record. */
interface DetectedConflict {
  readonly artifactName: string;
  readonly path: string;
  readonly versionId: string;
  readonly diagnostic: Uint8Array;
  readonly at: Date;
}

/** Artifact name → declared relative Workspace path for every `home: workspace`
 *  output any Step produces. An output with no `path` cannot be placed, so it is
 *  skipped (the Composition check is the authority that a workspace home has one). */
function collectMaterializations(steps: readonly Step[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const step of steps) {
    for (const produced of step.produces ?? []) {
      if (produced.home === "workspace" && produced.path !== undefined) {
        map.set(produced.name, produced.path);
      }
    }
  }
  return map;
}

// --- Resume by Step identity (A1) ------------------------------------------

/** Which Step instances already settled, reconstructed from the attempt log. A
 *  Step instance is one (Step, Iteration) pair; its Attempt ids encode that pair
 *  plus the Attempt number, so the log alone says what to skip and what to re-run. */
interface ResumeState {
  /** Instance keys (Step + Iteration) with at least one `succeeded` Attempt. */
  readonly succeeded: ReadonlySet<string>;
  /** Instance key → number of Attempts already recorded, so a re-run continues the
   *  Attempt numbering rather than colliding with a settled Attempt. */
  readonly attempts: ReadonlyMap<string, number>;
}

/** The instance key for a (Step, Iteration): the Iteration is a number, so its
 *  digits before the separator make the key unambiguous whatever the Step id is. */
function instanceKey(stepId: string, iteration: number): string {
  return `${iteration}:${stepId}`;
}

/** Encode an Attempt id from its Step, Iteration, and Attempt number. The numeric
 *  fields lead so the id parses back unambiguously for any Step id, and it stays
 *  human-readable where it surfaces (e.g. a Review checkpoint's Gate Attempt). */
function encodeAttemptId(
  stepId: string,
  iteration: number,
  attempt: number,
): string {
  return `${iteration}.${attempt}:${stepId}`;
}

/** Parse an Attempt id back to its parts, or undefined for an id this Module did
 *  not mint (the Run Store's reconciliation marker is a random UUID). */
function decodeAttemptId(
  id: string,
): { stepId: string; iteration: number; attempt: number } | undefined {
  const match = /^(\d+)\.(\d+):([\s\S]*)$/.exec(id);
  if (match === null) return undefined;
  return {
    iteration: Number(match[1]),
    attempt: Number(match[2]),
    stepId: match[3]!,
  };
}

/** Reconstruct the resume state from the attempt log: which Step instances
 *  succeeded, and how many Attempts each already has. Entries this Module did not
 *  mint (a reconciliation marker) decode to nothing and are ignored — they are
 *  never `succeeded`, so the interrupted Step re-runs. */
function buildResumeState(log: readonly AttemptLogEntry[]): ResumeState {
  const succeeded = new Set<string>();
  const attempts = new Map<string, number>();
  for (const entry of log) {
    const decoded = decodeAttemptId(entry.attemptId);
    if (decoded === undefined) continue;
    const key = instanceKey(decoded.stepId, decoded.iteration);
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    if (entry.outcome === "succeeded") succeeded.add(key);
  }
  return { succeeded, attempts };
}

/** Verify every `home: workspace` Artifact this Step is about to use. Returns the
 *  first conflict, or undefined when every copy matches its bound version. */
function verifyMaterializations(
  step: Step,
  context: StepContext,
  materializations: ReadonlyMap<string, string>,
  at: Date,
): DetectedConflict | undefined {
  const workspacePath = context.owner.record.workspacePath;
  for (const name of stepReferences(step)) {
    const relPath = materializations.get(name);
    if (relPath === undefined) continue; // not Workspace-materialized
    const versionId = context.owner.currentVersion(name);
    if (versionId === undefined) continue; // not bound yet — nothing to verify
    const bound = context.owner.readArtifact(versionId, name);
    if (bound === undefined) continue; // no bytes at the bound version
    const copy = readWorkspaceCopy(workspacePath, relPath);
    if (copy !== undefined && bytesEqual(copy, bound)) continue; // matches
    return {
      artifactName: name,
      path: relPath,
      versionId,
      diagnostic: encode(
        conflictDiagnostic(name, relPath, versionId, bound, copy),
      ),
      at,
    };
  }
  return undefined;
}

/** Write each `home: workspace` output this Step produced into the Workspace at
 *  its declared path, byte-for-byte (AC1/AC4). */
function materializeOutputs(
  step: Step,
  outputs: readonly CandidateOutput[],
  context: StepContext,
): void {
  const wanted = new Map<string, string>();
  for (const produced of step.produces ?? []) {
    if (produced.home === "workspace" && produced.path !== undefined) {
      wanted.set(produced.name, produced.path);
    }
  }
  if (wanted.size === 0) return;
  const workspacePath = context.owner.record.workspacePath;
  for (const output of outputs) {
    const relPath = wanted.get(output.name);
    if (relPath === undefined) continue;
    const target = resolveWorkspacePath(workspacePath, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, output.content);
  }
}

/** The artifact names a Step uses: everything it `requires`, plus every
 *  `{artifact}` a Command resolves in its arguments or env (base and any platform
 *  override). Verification runs over these before the Step executes. */
function stepReferences(step: Step): Set<string> {
  const names = new Set<string>(step.requires ?? []);
  if (step.kind === "command") {
    collectArtifactTokens(step.command, names);
    for (const override of Object.values(step.command.platforms ?? {})) {
      if (override !== undefined) collectArtifactTokens(override, names);
    }
  }
  return names;
}

function collectArtifactTokens(
  invocation: {
    readonly arguments?: readonly (string | Reference)[];
    readonly env?: Readonly<Record<string, string | Reference>>;
  },
  into: Set<string>,
): void {
  for (const token of invocation.arguments ?? []) {
    if (typeof token !== "string" && "artifact" in token)
      into.add(token.artifact);
  }
  for (const value of Object.values(invocation.env ?? {})) {
    if (typeof value !== "string" && "artifact" in value)
      into.add(value.artifact);
  }
}

/** Resolve a declared relative Workspace path identically on Windows and POSIX
 *  (AC4): split on either separator and re-join under the Workspace root. */
function resolveWorkspacePath(workspacePath: string, relPath: string): string {
  return join(
    workspacePath,
    ...relPath.split(/[\\/]+/).filter((segment) => segment.length > 0),
  );
}

/** The current Workspace bytes at a declared path, or undefined if it is absent. */
function readWorkspaceCopy(
  workspacePath: string,
  relPath: string,
): Uint8Array | undefined {
  const target = resolveWorkspacePath(workspacePath, relPath);
  try {
    return existsSync(target) ? readFileSync(target) : undefined;
  } catch {
    return undefined;
  }
}

/** Exact byte comparison — no line-ending or encoding normalization (AC4). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(a, b) === 0;
}

/** The human-readable diagnostic for a conflict: names the artifact, the path,
 *  the bound version, and whether the copy is missing or changed. */
function conflictDiagnostic(
  name: string,
  relPath: string,
  versionId: string,
  bound: Uint8Array,
  copy: Uint8Array | undefined,
): string {
  const state =
    copy === undefined
      ? "the Workspace copy is missing"
      : `the Workspace copy changed (expected ${bound.length} bytes, found ${copy.length})`;
  return (
    [
      `Materialization conflict for artifact "${name}" at Workspace path "${relPath}".`,
      `Before a Step could use it, ${state}; it no longer matches the bound version ${versionId}.`,
      "Secant halted the Run without overwriting the Workspace or adopting its bytes (ADR 0023).",
      `Restore "${relPath}" to its bound content and resume the Run.`,
    ].join("\n") + "\n"
  );
}

function recordConflictOrThrow(
  owner: RunOwner,
  conflict: DetectedConflict,
): void {
  const result = owner.recordMaterializationConflict({
    artifactName: conflict.artifactName,
    path: conflict.path,
    versionId: conflict.versionId,
    diagnostic: conflict.diagnostic,
    at: conflict.at,
  });
  // A fenced owner mid-Run means another process took over; stopping is correct
  // and throwing hands that to composition, like writeStateOrThrow.
  if (!result.ok) {
    throw new Error(
      `execution: cannot record a Materialization conflict: ${result.reason}.`,
    );
  }
}

// --- Human Gate step (a durable pause, not a dispatch) ---------------------

/** A Human Gate does not run to an Attempt: it renders the message the human sees,
 *  names the `text` output a `free-text` answer will bind, and returns a pause the
 *  scheduler records as a pending gate before resting the Run `blocked` (#108).
 *  An `approve-reject` gate produces nothing; a `free-text` gate declares one
 *  `text` output whose name the answer binds. */
async function runHumanGate(
  step: HumanGateStep,
  context: StepContext,
): Promise<StepPause> {
  const outputArtifactName =
    step.shape === "free-text"
      ? step.produces?.find((produced) => produced.type === "text")?.name
      : undefined;
  return {
    pause: true,
    shape: step.shape,
    message: renderGateMessage(step, context),
    ...(outputArtifactName !== undefined ? { outputArtifactName } : {}),
  };
}

/** The exact message a Human Gate shows: the authored `message`, or the decoded
 *  text of an authored `prompt` reference (a Snapshot asset file, or a bound
 *  artifact), or empty when the gate authored neither. */
function renderGateMessage(step: HumanGateStep, context: StepContext): string {
  if (step.message !== undefined) return step.message;
  if (step.prompt === undefined) return "";
  if ("asset" in step.prompt) {
    const path = context.resolveAsset(step.prompt.asset);
    if (path === undefined) {
      throw new Error(
        `execution: gate prompt asset "${step.prompt.asset}" is not in the pinned Bundle Snapshot.`,
      );
    }
    return readFileSync(path, "utf8");
  }
  const versionId = context.owner.currentVersion(step.prompt.artifact);
  if (versionId === undefined) {
    throw new Error(
      `execution: gate prompt artifact "${step.prompt.artifact}" is not bound at this Step.`,
    );
  }
  const bytes = context.owner.readArtifact(versionId, step.prompt.artifact);
  if (bytes === undefined) {
    throw new Error(
      `execution: gate prompt artifact "${step.prompt.artifact}" has no bytes at its bound version.`,
    );
  }
  return new TextDecoder().decode(bytes);
}

// --- Agent step (a Harness Turn dispatch entry, #116) ----------------------

/** The Prompt slot grammar, matching `promptSlotReferences` in the Workflow
 *  Module: substitution only, `{{artifact:name}}`. */
const PROMPT_SLOT = /\{\{artifact:([a-zA-Z0-9._-]+)\}\}/g;

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
async function runAgent(
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
  const prompt = renderAgentPrompt(step, context, harness);
  // `fresh` isolates a new Session per Attempt (per Iteration inside a Repeat
  // group, since the Attempt id encodes both); any other name is reused, so
  // successive Agent Steps naming it share one live process.
  const session =
    step.session === "fresh" ? `fresh-${attemptId}` : step.session;
  // One Turn per Agent Step Attempt in M3. The id keys the durable Turn record.
  const turnId = `${attemptId}#turn`;
  const harnessName = harness.prepared.profile.harness;

  const recorder: DurableTurnRecorder = {
    admit(admission) {
      const result = owner.admitTurn({
        turnId,
        attemptId,
        session,
        origin: admission.origin,
        input: admission.input.text,
        recoveryCoordinate: admission.recoveryCoordinate.opaque,
        harness: harnessName,
        at: new Date(),
      });
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

  const turn = harness.prepared.startTurn({
    session,
    origin: "managed",
    correlationKey: { opaque: turnId },
    recorder,
    input: { text: prompt },
  });
  // The live request-answer channel (#117): each approval request reaches an
  // observing client through the channel, which the client answers by policy
  // (headless) or a human decision (TUI). The Harness Adapter always emits
  // `request-answered` with `by:"human"` (it cannot know a client policy exists),
  // so the client-declared provenance is stashed here and wins in the durable
  // record.
  const channel = context.requestChannel;
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
  // ponytail: an in-flight cancel/interrupt of a live Agent Turn (Ctrl+C, story 38)
  // is not wired here — the plain autonomous Turn runs to its own boundary. Wire
  // `context.cancelSignal` to `turn.interrupt()` with the interrupt slice.
  try {
    const result = await turn.result();
    settleTurnResult(owner, turnId, session, result);
    return mapTurnResult(result);
  } finally {
    // The Turn is over: unbind so a late `answer-harness-request` finds no live
    // answer function and the Application refuses it (the request has expired).
    channel?.bindAnswer(undefined);
  }
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
): string {
  const base = readPromptText(step.prompt, context);
  const filled = base.replace(PROMPT_SLOT, (_match, name: string) =>
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
  return skillLines.length === 0
    ? filled
    : `${filled}\n\n${skillLines.join("\n")}`;
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
function launchInputs(owner: RunOwner): Readonly<Record<string, string>> {
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
 *  content. Immutable in the Store; a fenced write is ignored (the walk unwinds). */
function settleTurnResult(
  owner: RunOwner,
  turnId: string,
  session: string,
  result: TurnResult,
): void {
  const availability = resultAvailability(result);
  owner.settleTurn({
    turnId,
    session,
    resultKind: result.kind,
    resultDetail: JSON.stringify({ kind: result.kind }),
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

/** The post-Turn Session availability a result carries, flattened for the Store. */
function resultAvailability(result: TurnResult): {
  state: string;
  detail?: string;
} {
  if (result.kind === "not-started") {
    return { state: "unusable", detail: result.detail.failure.category };
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

/** Map a Turn result to an Attempt outcome and its effective model (#116). */
function mapTurnResult(result: TurnResult): StepAttempt {
  const model = resultEffectiveModel(result);
  const base = { outputs: [] as readonly CandidateOutput[] };
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

// --- Command step (an executable dispatch entry) ---------------------------

async function runCommand(
  step: CommandStep,
  context: StepContext,
): Promise<StepAttempt> {
  const invocation = resolveInvocation(step.command, context.platform);
  const args = invocation.arguments.map((token) =>
    resolveToken(token, context),
  );
  // No `shell: true`: resolved `{artifact}` bytes flow into args, so a shell would
  // open those to injection. The executable is resolved to a spawnable target here
  // (a native binary, or an npm `.cmd` shim's real `node` + script) so a Windows
  // shim runs directly, never through `cmd.exe` (#21).
  const resolution = resolveExecutable(invocation.executable);
  if (resolution.kind !== "found") {
    // Preflight already refused an unresolvable executable or an unsupported shim;
    // reaching here means it was removed between Preflight and spawn — the command
    // could not execute, so the Attempt failed and is retryable (ADR 0020).
    return { outcome: "failed", outputs: [] };
  }

  const result = await context.spawnCommand({
    executable: resolution.executable,
    args: [...resolution.prefixArgs, ...args],
    cwd: invocation.workingDirectory,
    env: resolveEnv(invocation, context),
    timeoutMs: context.commandTimeoutMs,
    // Execution owns the capture cap policy; the process Module enforces the value.
    maxCaptureBytes: MAX_CAPTURE_BYTES,
    truncationMarker: TRUNCATION_MARKER,
    ...(context.cancelSignal !== undefined
      ? { cancelSignal: context.cancelSignal }
      : {}),
  });

  // Translate the OS outcome at this Seam into a typed Attempt outcome (D-rule:
  // external failures become typed domain failures at their owning Seam).
  switch (result.kind) {
    // A spawn error (ENOENT missing binary) or our own timeout kill means the
    // command could not run to an exit -> the Attempt failed and is retryable.
    // ponytail: the original cause (the spawn error / partial stderr) is dropped —
    // the Run Store's `diagnostics/` has a writer (materialization conflicts, #88)
    // but no channel for a failed Attempt yet. Route this cause there when that
    // channel lands, so a user can see why a Step could not execute.
    case "spawn-error":
    case "timeout":
      return { outcome: "failed", outputs: [] };
    // The caller's cancel signal aborted the command: kill the group and unwind
    // without publishing, so `cancel-run` (T4) owns the `cancelled` rest.
    case "cancelled":
      throw new RunCancelledError();
    // Death by an external signal with no exit — Ctrl+C, an outside SIGTERM, the
    // terminal closing during a live Run. The Attempt's result is genuinely
    // unknown, so it is `indeterminate`: never retried, and the Run rests `halted`
    // for human resume (ADR 0019, #86).
    // ponytail: every external signal death maps to `indeterminate`, including a
    // command that faults in its own code (segfault, abort). Splitting crash
    // signals to a retryable `failed` would stop a deterministically crashing
    // command from looping `halted` on manual resume, but reliably telling crash
    // from interrupt by the reported signal is not portable across Bun on the
    // three OSes (macOS reports SIGABRT for abort(); Linux does not, and hangs
    // ~30s first), so the split was withdrawn. Revisit with a diagnostic channel
    // that records the signal, not a by-signal-name classifier.
    case "signal":
      return { outcome: "indeterminate", outputs: [] };
    case "exited":
      return {
        outcome: "succeeded",
        outputs: commandOutputs(step, result.status === 0, result.text),
      };
  }
}

/** The Command's `verdict` (pass/fail from the exit status) and `text` (captured
 *  output) outputs, named by the Step's declared `produces`. */
function commandOutputs(
  step: CommandStep,
  exitedZero: boolean,
  captured: Uint8Array,
): CandidateOutput[] {
  const outputs: CandidateOutput[] = [];
  for (const produced of step.produces ?? []) {
    if (produced.type === "verdict") {
      outputs.push({
        name: produced.name,
        type: "verdict",
        content: encode(exitedZero ? "pass" : "fail"),
      });
    } else if (produced.type === "text") {
      outputs.push({ name: produced.name, type: "text", content: captured });
    }
    // A Command produces only a verdict and a text (its Step-kind contract); any
    // other declared output stays absent and the Run Store names it as missing.
  }
  return outputs;
}

/** Resolve a Command to its single invocation for the host platform: the platform
 *  override replaces each field it names (Partial semantics), the base fills the
 *  rest. This is how the Windows invocation is selected on Windows and the POSIX
 *  one elsewhere. */
function resolveInvocation(
  command: CommandParams,
  platform: Platform,
): CommandInvocation {
  const override = command.platforms?.[platform];
  if (override === undefined) return command;
  return {
    executable: override.executable ?? command.executable,
    arguments: override.arguments ?? command.arguments,
    workingDirectory: override.workingDirectory ?? command.workingDirectory,
    env: override.env ?? command.env,
  };
}

/** Resolve one argument or env value: a literal passes through; a `{asset}`
 *  becomes its Snapshot path; a `{artifact}` becomes the bytes currently bound to
 *  that name, decoded as UTF-8 text. An unresolved reference is a broken
 *  invariant the Composition check already ruled out, so it throws. */
function resolveToken(token: string | Reference, context: StepContext): string {
  if (typeof token === "string") return token;
  if ("asset" in token) {
    const path = context.resolveAsset(token.asset);
    if (path === undefined) {
      throw new Error(
        `execution: asset "${token.asset}" is not in the pinned Bundle Snapshot.`,
      );
    }
    return path;
  }
  const versionId = context.owner.currentVersion(token.artifact);
  if (versionId === undefined) {
    throw new Error(
      `execution: artifact "${token.artifact}" is not bound at this Step.`,
    );
  }
  const bytes = context.owner.readArtifact(versionId, token.artifact);
  if (bytes === undefined) {
    throw new Error(
      `execution: artifact "${token.artifact}" has no bytes at its bound version.`,
    );
  }
  // ponytail: a bound artifact resolves to its decoded text. file/file-set
  // artifacts (a path, not inline text) need materialization — add it with the
  // first file-producing Step kind; M2 Commands bind only verdict and text.
  return new TextDecoder().decode(bytes);
}

/** The declared env, resolved over the inherited environment. A Command with no
 *  authored env inherits the parent environment unchanged. */
function resolveEnv(
  invocation: CommandInvocation,
  context: StepContext,
): NodeJS.ProcessEnv {
  if (invocation.env === undefined) return process.env;
  const resolved: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(invocation.env)) {
    resolved[name] = resolveToken(value, context);
  }
  return resolved;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function writeStateOrThrow(owner: RunOwner, state: string): void {
  const result = owner.writeState(state);
  // ponytail: a fenced owner mid-Run means another process took over this Run;
  // stopping is correct, and throwing hands that to composition. Return a typed
  // `fenced` RunReport instead if a caller ever needs to resume rather than fault.
  if (!result.ok) {
    throw new Error(
      `execution: cannot advance Run to "${state}": ${result.reason}.`,
    );
  }
}

function publishOrThrow(result: ReturnType<RunOwner["publishAttempt"]>): void {
  if (result.ok) return;
  if ("reason" in result) {
    throw new Error(
      `execution: Attempt publication refused: ${result.reason}.`,
    );
  }
  throw new Error(
    `execution: Attempt publication could not be staged: ${result.problem.kind}.`,
  );
}
