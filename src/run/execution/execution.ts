import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import which from "which";
import {
  flattenSteps,
  MAX_REVIEW_CHECKPOINT_INTERVAL,
  type AttemptOutcome,
  type CommandInvocation,
  type CommandParams,
  type CommandStep,
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

// The Run execution Module owns the Run lifecycle policy: it walks a Routing
// node by node, dispatches each Step through a closed executable Step-kind table,
// retries an Attempt that could not execute within its bound, loops a Repeat
// group on its Verdict, and rests the Run `succeeded`, `failed`, or `blocked`. It
// imports Workflow (the authored vocabulary and the Routing walk order) and the
// Run Store (the canonical record every Attempt lands through); the Harness edge
// stays empty until an agent Step kind lands.
//
// The scheduler learns nothing per Step kind — it looks a kind up in the closed
// table (#13) and never branches on Bundle identity (id, name, asset path). M2
// registers exactly one executable kind, `command`; adding a kind means adding a
// row here, never a new branch.
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
// checkpoint. `blocked` is never written — it is derived from the current Step
// Attempt (the Application re-derives it), so the loop simply stops and returns.

/**
 * How a `{asset}` reference reaches execution without importing Bundle or
 * Catalog: composition resolves the asset's path in the pinned Bundle Snapshot
 * and hands execution this port. Returns the absolute on-disk path of the asset,
 * or `undefined` for an asset the Snapshot does not carry.
 */
export type AssetResolver = (assetPath: string) => string | undefined;

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
  /** Injectable clock so Attempt timestamps are deterministic in tests. */
  readonly now?: () => Date;
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
// spawnSync's 1 MiB default would truncate ordinary command output, so cap higher.
// This is execution's own cap, independent of the Artifact Module's git-pipe cap:
// that Module is private to the Run Store and this one cannot import it.
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;

/** One Step Attempt's outcome and, when it ran, the outputs to publish. */
interface StepAttempt {
  readonly outcome: AttemptOutcome;
  readonly outputs: readonly CandidateOutput[];
}

interface StepContext {
  readonly owner: RunOwner;
  readonly platform: Platform;
  readonly resolveAsset: AssetResolver;
  readonly commandTimeoutMs: number;
}

type StepExecutor = (step: Step, context: StepContext) => StepAttempt;

// The closed executable Step-kind dispatch table (#13). Exactly one entry in M2;
// a Human Gate is a durable pause rather than a dispatch, and Repeat groups land
// in #84, so neither has a row here.
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
export function executeRouting(
  routing: readonly RoutingNode[],
  deps: ExecutionDeps,
): RunReport {
  const context: WalkContext = {
    step: {
      owner: deps.owner,
      platform: deps.platform,
      resolveAsset: deps.resolveAsset,
      commandTimeoutMs: deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
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
        ? runRepeatGroup(node.repeat, context, isLastNode)
        : runStep(node, context, isLastNode);
    if (outcome === "failed") return { outcome: "failed" };
    if (outcome === "blocked") return { outcome: "blocked" };
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
function runStep(
  step: Step,
  context: WalkContext,
  isLastNode: boolean,
): NodeOutcome {
  // A plain Step runs once per Run, so its Iteration is always zero.
  const outcome = runStepAttempts(
    step,
    context,
    0,
    isLastNode ? "succeeded" : undefined,
  );
  if (outcome === "halted") return "halted";
  if (outcome === "failed") return "failed";
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
function runRepeatGroup(
  repeat: RepeatGroup["repeat"],
  context: WalkContext,
  isLastNode: boolean,
): NodeOutcome {
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
    const result = runIteration(repeat, context, isLastNode, iteration);
    if (result.outcome === "failed") return "failed";
    if (result.outcome === "halted") return "halted";
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
function runIteration(
  repeat: RepeatGroup["repeat"],
  context: WalkContext,
  isLastNode: boolean,
  iteration: number,
): { outcome: NodeOutcome; ran: boolean } {
  const { steps, until } = repeat;
  let ran = false;
  for (let s = 0; s < steps.length; s++) {
    const step = steps[s]!;
    const isLastSpanStep = s === steps.length - 1;
    // The deciding-`succeeded` Attempt is the last span Step of the last node when
    // it leaves the `until` Verdict reading `pass`. Compute that intent from the
    // Attempt's own outputs (a Step producing the Verdict) or the current binding.
    const decideOnPass = isLastNode && isLastSpanStep;
    const outcome = runStepAttempts(
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
function runStepAttempts(
  step: Step,
  context: WalkContext,
  iteration: number,
  successAdvance: string | undefined,
  decideSuccessAdvance?: (result: StepAttempt) => string | undefined,
): AttemptOutcome | "halted" | "skipped" {
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
      `execution: Step kind "${step.kind}" is not dispatchable in M2 ` +
        "(command-only; Human Gates pause and agent kinds land later).",
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
    const result = executor(step, context.step);
    outcome = result.outcome;
    // An interrupted Attempt (a termination signal, never our timeout) has no
    // result: it is settled `indeterminate`, never retried, and rests the Run
    // `halted` in the same transaction for human resume (ADR 0019, #86).
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

// --- Executable resolution (owned here, shared with Preflight) -------------

/**
 * How a Command's authored executable resolves on this host to something spawnable
 * directly, never through a shell (#21). This is the one executable resolver the
 * execution Module owns and exports; Preflight consumes it (application → execution
 * is an allowed import) so its precondition check and this Module's spawn agree by
 * construction (A40, D1).
 *
 * - `found`: spawn `executable` with `prefixArgs` ahead of the Command's own
 *   arguments. A native binary resolves to itself with no prefix. An npm-style
 *   Windows `.cmd` shim resolves to its real target — `node` plus the script the
 *   shim wraps — so it runs without `cmd.exe` (cross-spawn is rejected precisely
 *   because it routes `.cmd` through `cmd.exe`).
 * - `not-found`: nothing on PATH satisfies the name, or a shim's own interpreter is
 *   unresolvable.
 * - `unsupported-shim`: a Windows `.cmd`/`.bat` that is not an npm-style node shim;
 *   Preflight refuses it and asks the author to name the interpreter.
 */
export type ExecutableResolution =
  | {
      readonly kind: "found";
      readonly executable: string;
      readonly prefixArgs: readonly string[];
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "unsupported-shim"; readonly path: string };

/** The PATH walk and the host platform are the two external facts resolution
 *  depends on; both are injectable adapters (testing.md) so the Windows shim path
 *  is exercised on any OS. Production passes neither. */
export interface ResolveExecutableOptions {
  /** Override PATH the walk searches (the real `which` still decides the match). */
  readonly path?: string;
  /** Override the host platform that gates the `.cmd`/`.bat` shim rule. */
  readonly platform?: NodeJS.Platform;
  /** Replace the PATH walk entirely, so the shim rule is testable without PATHEXT. */
  readonly resolve?: (name: string) => string | undefined;
}

/** The single PATH walk in `src/` (D1): `which` resolves the name to an absolute
 *  path, checking the executable bit (POSIX) and PATHEXT (Windows), so a
 *  non-executable file earlier on PATH never satisfies resolution. */
function walkPath(
  name: string,
  options: ResolveExecutableOptions,
): string | undefined {
  if (options.resolve !== undefined) return options.resolve(name);
  const result = which.sync(name, {
    nothrow: true,
    ...(options.path !== undefined ? { path: options.path } : {}),
  });
  return typeof result === "string" ? result : undefined;
}

export function resolveExecutable(
  name: string,
  options: ResolveExecutableOptions = {},
): ExecutableResolution {
  const resolved = walkPath(name, options);
  if (resolved === undefined) return { kind: "not-found" };
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const ext = extname(resolved).toLowerCase();
    if (ext === ".cmd" || ext === ".bat") {
      return resolveWindowsShim(resolved, options);
    }
  }
  return { kind: "found", executable: resolved, prefixArgs: [] };
}

/** Resolve a Windows `.cmd`/`.bat` to its real target. An npm-style node shim
 *  (`cmd-shim`) is resolved to `node` plus the script it wraps and spawned
 *  directly; anything else is `unsupported-shim` (Preflight refuses it). */
function resolveWindowsShim(
  shimPath: string,
  options: ResolveExecutableOptions,
): ExecutableResolution {
  let text: string;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return { kind: "unsupported-shim", path: shimPath };
  }
  const target = parseNpmCmdShim(text, dirname(shimPath));
  if (target === undefined) return { kind: "unsupported-shim", path: shimPath };
  // The shim's own interpreter must itself resolve on PATH, or the real target
  // cannot run — that is a not-found, not an unsupported shim.
  const interpreter = walkPath(target.interpreter, options);
  if (interpreter === undefined) return { kind: "not-found" };
  return {
    kind: "found",
    executable: interpreter,
    prefixArgs: [target.script],
  };
}

/** Parse an npm `cmd-shim` `.cmd`: it sets `_prog` to its interpreter (a colocated
 *  binary in the `IF EXIST` branch, else the bare name on PATH in the `ELSE`
 *  branch) and invokes it on a `%dp0%`-relative script. Returns the bare
 *  interpreter name to resolve on PATH and the absolute script path, or undefined
 *  for any `.cmd`/`.bat` that is not this npm-style interpreter-plus-script shape. */
function parseNpmCmdShim(
  text: string,
  shimDir: string,
): { interpreter: string; script: string } | undefined {
  // The program-invocation line runs `"%_prog%" "<script>" %*`.
  const invocation = text
    .split(/\r?\n/)
    .find((line) => line.includes("%_prog%"));
  if (invocation === undefined) return undefined;
  const quoted = [...invocation.matchAll(/"([^"]*)"/g)].map(
    (match) => match[1]!,
  );
  const scriptToken = quoted.find(
    (token) => /%dp0%/i.test(token) && /\.[cm]?js$/i.test(token),
  );
  if (scriptToken === undefined) return undefined;
  // The interpreter is the `_prog` value that is a bare PATH name — the `ELSE`
  // branch — not the `%dp0%`-relative colocated one. Its absence means this is not
  // an npm-style shim, so it is refused rather than run through a shell.
  const interpreter = [...text.matchAll(/SET\s+"?_prog=([^"\r\n]+)"?/gi)]
    .map((match) => match[1]!.replace(/"$/, "").trim())
    .find((value) => value.length > 0 && !/%dp0%/i.test(value));
  if (interpreter === undefined) return undefined;
  return { interpreter, script: expandDp0(scriptToken, shimDir) };
}

/** Expand a `%dp0%`-relative shim token to an absolute path under the shim's
 *  directory, joining on either separator so the result is a host-native path. */
function expandDp0(token: string, shimDir: string): string {
  const relative = token.replace(/^%dp0%/i, "");
  const segments = relative.split(/[\\/]+/).filter((segment) => segment.length);
  return join(shimDir, ...segments);
}

// --- Command step (the one executable dispatch entry) ----------------------

function runCommand(step: CommandStep, context: StepContext): StepAttempt {
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
  const result = spawnSync(
    resolution.executable,
    [...resolution.prefixArgs, ...args],
    {
      cwd: invocation.workingDirectory,
      env: resolveEnv(invocation, context),
      timeout: context.commandTimeoutMs,
      maxBuffer: MAX_CAPTURE_BYTES,
      windowsHide: true,
    },
  );

  // Translate the OS outcome at this Seam into a typed Attempt outcome (D-rule:
  // external failures become typed domain failures at their owning Seam). A spawn
  // error (ENOENT missing binary) or our own timeout kill (result.error carries
  // ETIMEDOUT) means the command could not run to an exit -> the Attempt failed
  // and is retryable.
  if (result.error !== undefined) {
    // ponytail: the original cause (result.error / partial stderr) is dropped —
    // the Run Store's `diagnostics/` has a writer (materialization conflicts, #88)
    // but no channel for a failed Attempt yet. Route this cause there when that
    // channel lands, so a user can see why a Step could not execute.
    return { outcome: "failed", outputs: [] };
  }

  // No exit and no error means a signal killed the command — Ctrl+C, SIGTERM, the
  // terminal closing during a live Run. The Attempt's result is genuinely unknown,
  // so it is `indeterminate`: never retried, and the Run rests `halted` for human
  // resume (ADR 0019, #86).
  // ponytail: every signal death maps to `indeterminate`, including a command that
  // faults in its own code (segfault, abort). Splitting crash signals to a
  // retryable `failed` would stop a deterministically crashing command from looping
  // `halted` on manual resume, but reliably telling crash from interrupt by the
  // reported signal is not portable across Bun on the three OSes (macOS reports
  // SIGABRT for abort(); Linux does not, and hangs ~30s first), so the split was
  // withdrawn. Revisit with a diagnostic channel that records the signal, not a
  // by-signal-name classifier.
  if (result.status === null) {
    return { outcome: "indeterminate", outputs: [] };
  }

  const captured = concatCaptured(result.stdout, result.stderr);
  return {
    outcome: "succeeded",
    outputs: commandOutputs(step, result.status === 0, captured),
  };
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

/** Combine captured stdout and stderr (stdout first) into the `text` output. */
function concatCaptured(
  stdout: Buffer | null,
  stderr: Buffer | null,
): Uint8Array {
  return Buffer.concat([stdout ?? Buffer.alloc(0), stderr ?? Buffer.alloc(0)]);
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
