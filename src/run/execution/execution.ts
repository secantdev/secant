import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  flattenSteps,
  type AttemptOutcome,
  type CommandInvocation,
  type CommandParams,
  type CommandStep,
  type Platform,
  type Reference,
  type RoutingNode,
  type Step,
  type StepKindName,
} from "../../workflow/workflow.js";
import type { CandidateOutput, RunOwner } from "../store/store.js";

// The Run execution Module owns the Run lifecycle policy: it walks a Routing
// step by step, dispatches each Step through a closed executable Step-kind table,
// retries an Attempt that could not execute within its bound, and rests the Run
// `succeeded` or `failed`. It imports Workflow (the authored vocabulary and the
// Routing walk order) and the Run Store (the canonical record every Attempt lands
// through); the Harness edge stays empty until an agent Step kind lands.
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
// spawn error, a timeout. So a `fail` Verdict advances a straight-line Routing,
// and only a `failed` Attempt consumes the retry budget.

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

/** How a Run came to rest. */
export type RunOutcome = "succeeded" | "failed";

export interface RunReport {
  readonly outcome: RunOutcome;
}

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

/**
 * Drive one acquired Run's Routing to rest. Walks the Steps in Routing order,
 * dispatches each through the closed table, retries a `failed` Attempt within its
 * bound, and rests the Run `succeeded` (every Step ran to an exit) or `failed` (a
 * Step's retry budget was exhausted). A fenced owner or a publication Problem is a
 * coordination/environment fault and throws — the caller (composition) owns it.
 */
export function executeRouting(
  routing: readonly RoutingNode[],
  deps: ExecutionDeps,
): RunReport {
  const now = deps.now ?? (() => new Date());
  const budget = deps.defaultRetryBudget ?? DEFAULT_RETRY_BUDGET;
  const context: StepContext = {
    owner: deps.owner,
    platform: deps.platform,
    resolveAsset: deps.resolveAsset,
    commandTimeoutMs: deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  };

  writeStateOrThrow(deps.owner, "running");

  // ponytail: flattenSteps runs a Repeat group's Steps straight-line once — the
  // loop condition is #84. M2 Routings are command-only and straight-line, so
  // this is the correct walk order (the same one the Composition check uses).
  const steps = flattenSteps(routing);
  // With no Steps the deciding-Attempt path never runs, so rest the Run here.
  if (steps.length === 0) {
    writeStateOrThrow(deps.owner, "succeeded");
    return { outcome: "succeeded" };
  }
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    const executor = STEP_EXECUTORS[step.kind];
    if (executor === undefined) {
      throw new Error(
        `execution: Step kind "${step.kind}" is not dispatchable in M2 ` +
          "(command-only; Human Gates pause and Repeat groups land later).",
      );
    }
    const isLastStep = index === steps.length - 1;
    // Clamp a bad budget to zero so a typo (e.g. -1) still runs the Step once
    // rather than silently skipping it and resting the Run failed with no Attempt.
    const retries = Math.max(0, step.retry ?? budget);
    let outcome: AttemptOutcome = "failed";
    for (let attempt = 0; attempt <= retries; attempt++) {
      const result = executor(step, context);
      outcome = result.outcome;
      // Rest the Run in the same transaction as its deciding Attempt: a success
      // on the last Step rests `succeeded`; a `failed` Attempt that exhausts the
      // budget rests `failed`. Advancing separately would leave a crash between
      // the Attempt commit and the state write stuck at `running`.
      const rested =
        result.outcome === "failed" ? attempt === retries : isLastStep;
      const advanceState = rested
        ? result.outcome === "failed"
          ? "failed"
          : "succeeded"
        : undefined;
      publishOrThrow(
        deps.owner.publishAttempt({
          attemptId: randomUUID(),
          outcome: result.outcome,
          // A failed Attempt moves no binding; a succeeded one publishes exactly
          // the Step's declared outputs.
          required: result.outcome === "succeeded" ? (step.produces ?? []) : [],
          outputs: result.outputs,
          at: now(),
          advanceState,
        }),
      );
      // A Verdict (pass or fail) still ran to an exit, so it advances the Run;
      // only a `failed` Attempt is retried.
      if (result.outcome !== "failed") break;
    }
    if (outcome === "failed") return { outcome: "failed" };
  }

  return { outcome: "succeeded" };
}

// --- Command step (the one executable dispatch entry) ----------------------

function runCommand(step: CommandStep, context: StepContext): StepAttempt {
  const invocation = resolveInvocation(step.command, context.platform);
  const args = invocation.arguments.map((token) =>
    resolveToken(token, context),
  );
  // ponytail: no `shell: true`. Resolved `{artifact}` bytes flow into args, so a
  // shell would open those to injection. The cost is that a Windows `.cmd`/`.bat`
  // shim (npm, npx) will not resolve through CreateProcess — take a cross-spawn-
  // class resolver (a dependency decision, its own issue) when a Bundle needs one.
  const result = spawnSync(invocation.executable, args, {
    cwd: invocation.workingDirectory,
    env: resolveEnv(invocation, context),
    timeout: context.commandTimeoutMs,
    maxBuffer: MAX_CAPTURE_BYTES,
    windowsHide: true,
  });

  // Translate the OS outcome at this Seam into a typed Attempt outcome (D-rule:
  // external failures become typed domain failures at their owning Seam). A spawn
  // error (ENOENT missing binary, a timeout kill) or a signal death without a
  // clean exit means the command could not run to an exit -> the Attempt failed.
  if (result.error !== undefined || result.status === null) {
    // ponytail: the original cause (result.error / result.signal / partial
    // stderr) is dropped — the Run Store has no diagnostic channel for a failed
    // Attempt yet (`diagnostics/` has no writer). Preserve it there when that
    // writer lands, so a user can see why a Step could not execute.
    return { outcome: "failed", outputs: [] };
  }

  // ponytail: a Command never yields `indeterminate` — a spawnSync result is
  // either a clean exit or a spawn/timeout fault. The outcome exists in the model
  // for kinds whose result can be genuinely unknown; add that mapping with them.
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
