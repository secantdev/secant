import { randomUUID } from "node:crypto";
import stripAnsi from "strip-ansi";
import type { Command } from "commander";
import type {
  AnswerHumanGateOffer,
  LaunchPreparationSnapshot,
  LaunchRunInput,
  OpenedProjection,
  OperationOutcome,
  Problem,
  ProjectionPort,
  ResumeRunOffer,
  RunLiveOverlay,
  RunOutstandingRequest,
  RunSnapshot,
  RunStateName,
  RunView,
} from "../application/projection-port.js";
import type { CommandExecutor, HeadlessIO, SettleAction } from "./headless.js";
import { renderRun, renderRunList } from "./render.js";
import {
  addHarnessRequestsOption,
  parseHarnessRequestPolicy,
  withHarnessRequests,
  type HarnessRequestPolicy,
} from "./harness-requests.js";

// The headless `run` command group, split out of headless.ts (A25): the tree that
// M2 added and M3 grows (launch/show/read/answer/resume/cancel/delete/list) plus
// its implementations. It registers onto the program the entry passes and touches
// only `io`, `execute`, `fail`, and `settle` — the entry keeps ownership of the
// commander settings and the shared helpers. Public entrypoints are unchanged.

export interface RunCommandDeps {
  readonly io: HeadlessIO;
  readonly execute: CommandExecutor;
  /** Wraps a command's result so `parseAsync` awaits an async Run command. */
  readonly settle: SettleAction;
  /** The shared Problem printer (owns the exit-code-1 convention for a refusal). */
  readonly fail: (io: HeadlessIO, json: boolean, problem: Problem) => number;
}

/** Register the `run` command group onto `program`. Called by `buildProgram`
 *  after the commander settings are configured, so the group inherits them. */
export function registerRunCommands(
  program: Command,
  deps: RunCommandDeps,
): void {
  const { io, execute, settle, fail } = deps;

  // No `run` action: like `bundle`, a bare `run` or an unknown token is a usage
  // error exiting non-zero. `run launch` executes; `run show`/`run read` observe.
  const run = program
    .command("run")
    .description(
      "launch, list, show, read, answer, resume, cancel, and delete Runs",
    );
  const launch = run
    .command("launch")
    .description(
      "launch an installed Bundle (Interactive agent Steps are TUI-only)",
    )
    .argument("[id@version]", "Bundle id, optionally with @version")
    .option(
      "--trust <digest>",
      "acknowledge and trust this exact installed digest",
    )
    .option(
      "--input <name=value>",
      "a Launch input (repeatable)",
      (pair: string, prev: string[]) => [...prev, pair],
      [],
    )
    .option(
      "--harness <id>",
      "select claude-code or codex for an Agent-bearing Bundle",
    )
    .option(
      "--model <id>",
      "request a model for an Agent-bearing Bundle (Command-only Bundles reject it)",
    );
  addHarnessRequestsOption(launch)
    .option("--json", "print the Run snapshot as JSON")
    .action(
      (
        selector: string | undefined,
        options: {
          trust?: string;
          input: string[];
          harness?: string;
          model?: string;
          harnessRequests?: string;
          json?: boolean;
        },
      ) => {
        const json = options.json ?? false;
        if (selector === undefined) {
          return settle(
            fail(io, json, {
              code: "missing-bundle-id",
              explanation: "run launch needs a Bundle id.",
              remediation: "Run `secant run launch <id>[@<version>]`.",
              possibleEffects: "none",
            }),
          );
        }
        const inputs = parseInputs(options.input);
        if ("problem" in inputs) return settle(fail(io, json, inputs.problem));
        const policy = parseHarnessRequestPolicy(options.harnessRequests);
        if ("problem" in policy) return settle(fail(io, json, policy.problem));
        return settle(
          execute((clients) =>
            launchRun({
              port: clients.projectionPort,
              io,
              fail,
              json,
              selector,
              trust: options.trust,
              inputs: inputs.values,
              harness: options.harness,
              model: options.model,
              harnessRequests: policy.policy,
            }),
          ),
        );
      },
    );
  run
    .command("show")
    .description("show a Run's snapshot")
    .argument("[run-id]", "the Run id printed at launch")
    .option("--json", "print the Run snapshot as JSON")
    .action((runId: string | undefined, options: { json?: boolean }) => {
      const json = options.json ?? false;
      if (runId === undefined) {
        return settle(
          fail(io, json, {
            code: "missing-run-id",
            explanation: "run show needs a Run id.",
            remediation: "Run `secant run show <run-id>`.",
            possibleEffects: "none",
          }),
        );
      }
      return settle(
        execute((clients) =>
          showRun(clients.projectionPort, io, fail, json, runId),
        ),
      );
    });
  const resume = run
    .command("resume")
    .description(
      "resume a halted or failed Run, running it until it rests again",
    )
    .argument("[run-id]", "the Run id printed at launch")
    .option("--takeover", "take over a Run owned by another process");
  addHarnessRequestsOption(resume)
    .option("--json", "print the Run snapshot as JSON")
    .action(
      (
        runId: string | undefined,
        options: {
          takeover?: boolean;
          harnessRequests?: string;
          json?: boolean;
        },
      ) => {
        const json = options.json ?? false;
        if (runId === undefined) {
          return settle(
            fail(io, json, {
              code: "missing-run-id",
              explanation: "run resume needs a Run id.",
              remediation: "Run `secant run resume <run-id>`.",
              possibleEffects: "none",
            }),
          );
        }
        const policy = parseHarnessRequestPolicy(options.harnessRequests);
        if ("problem" in policy) return settle(fail(io, json, policy.problem));
        return settle(
          execute((clients) =>
            resumeRun({
              port: clients.projectionPort,
              io,
              fail,
              json,
              runId,
              takeover: options.takeover ?? false,
              harnessRequests: policy.policy,
            }),
          ),
        );
      },
    );
  run
    .command("answer")
    .description("answer the Human Gate a blocked Run rests at")
    .argument("[run-id]", "the Run id printed at launch")
    .option("--continue", "grant one more review interval and resume the Run")
    .option("--stop", "end the Run failed, keeping history and Artifacts")
    .option("--text <value>", "answer a free-text gate with this text")
    .option("--json", "print the Run snapshot as JSON")
    .action(
      (
        runId: string | undefined,
        options: {
          continue?: boolean;
          stop?: boolean;
          text?: string;
          json?: boolean;
        },
      ) => {
        const json = options.json ?? false;
        if (runId === undefined) {
          return settle(
            fail(io, json, {
              code: "missing-run-id",
              explanation: "run answer needs a Run id.",
              remediation:
                "Run `secant run answer <run-id> --continue`, `--stop`, or `--text <value>`.",
              possibleEffects: "none",
            }),
          );
        }
        // `--text ""` is a valid (empty) free-text answer, so test presence, not
        // truthiness; exactly one of the three answer forms must be given.
        const chosen = [
          options.continue === true,
          options.stop === true,
          options.text !== undefined,
        ].filter(Boolean).length;
        if (chosen !== 1) {
          return settle(
            fail(io, json, {
              code: "invalid-answer",
              explanation:
                "run answer needs exactly one of --continue, --stop, or --text.",
              remediation:
                "Run `secant run answer <run-id> --continue` or `--stop` for an approve/reject gate, or `--text <value>` for a free-text gate.",
              possibleEffects: "none",
            }),
          );
        }
        const answer: HeadlessGateAnswer =
          options.text !== undefined
            ? { kind: "text", value: options.text }
            : options.continue === true
              ? { kind: "continue" }
              : { kind: "stop" };
        return settle(
          execute((clients) =>
            answerRun(clients.projectionPort, io, fail, json, runId, answer),
          ),
        );
      },
    );
  run
    .command("read")
    .description("read one Run output by reference (<run-id>/<name>)")
    .argument("[reference]", "a Run output reference, <run-id>/<name>")
    .option("--json", "print the resolved output as JSON")
    .option(
      "--transcript",
      "read a Session transcript (newest page and complete export) instead of an output",
    )
    .option(
      "--session <name>",
      "with --transcript, which Session to read (defaults to the sole Session)",
    )
    .action(
      (
        reference: string | undefined,
        options: { json?: boolean; transcript?: boolean; session?: string },
      ) => {
        const json = options.json ?? false;
        if (reference === undefined) {
          return settle(
            fail(io, json, {
              code: "missing-reference",
              explanation: options.transcript
                ? "run read --transcript needs a Run id."
                : "run read needs an output reference.",
              remediation: options.transcript
                ? "Run `secant run read <run-id> --transcript`."
                : "Run `secant run read <run-id>/<name>`.",
              possibleEffects: "none",
            }),
          );
        }
        if (options.transcript) {
          return settle(
            execute((clients) =>
              readTranscript(clients.projectionPort, io, fail, json, {
                reference,
                ...(options.session !== undefined
                  ? { session: options.session }
                  : {}),
              }),
            ),
          );
        }
        return settle(
          execute((clients) =>
            readRun(clients.projectionPort, io, fail, json, reference),
          ),
        );
      },
    );
  run
    .command("list")
    .description("list this Workspace's Previous Runs, newest first")
    .option("--resumable", "show only resumable (halted or failed) Runs")
    .option("--before <cursor>", "page to the next older Runs from this cursor")
    .option("--json", "print the Projection snapshot as JSON")
    .action(
      (options: { resumable?: boolean; before?: string; json?: boolean }) =>
        settle(
          execute((clients) =>
            listRuns(
              clients.projectionPort,
              io,
              options.json ?? false,
              options.resumable ?? false,
              options.before,
            ),
          ),
        ),
    );
  run
    .command("cancel")
    .description("cancel a live Run, ending it cancelled")
    .argument("[run-id]", "the Run id printed at launch")
    .option("--json", "print the Operation result as JSON")
    .action((runId: string | undefined, options: { json?: boolean }) => {
      const json = options.json ?? false;
      if (runId === undefined) {
        return settle(
          fail(io, json, {
            code: "missing-run-id",
            explanation: "run cancel needs a Run id.",
            remediation: "Run `secant run cancel <run-id>`.",
            possibleEffects: "none",
          }),
        );
      }
      return settle(
        execute((clients) =>
          endRunOperation(
            clients.projectionPort,
            io,
            fail,
            json,
            "cancel-run",
            runId,
          ),
        ),
      );
    });
  run
    .command("delete")
    .description("delete a resting or terminal Run's store from disk")
    .argument("[run-id]", "the Run id printed at launch")
    .option("--json", "print the Operation result as JSON")
    .action((runId: string | undefined, options: { json?: boolean }) => {
      const json = options.json ?? false;
      if (runId === undefined) {
        return settle(
          fail(io, json, {
            code: "missing-run-id",
            explanation: "run delete needs a Run id.",
            remediation: "Run `secant run delete <run-id>`.",
            possibleEffects: "none",
          }),
        );
      }
      return settle(
        execute((clients) =>
          endRunOperation(
            clients.projectionPort,
            io,
            fail,
            json,
            "delete-run",
            runId,
          ),
        ),
      );
    });
}

// --- shared parsing --------------------------------------------------------

/** Parse repeated `--input name=value` pairs into a record, or a Problem when a
 *  pair has no `=`. A later pair for the same name wins. */
function parseInputs(
  pairs: readonly string[],
): { values: Record<string, string> } | { problem: Problem } {
  const values: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      return {
        problem: {
          code: "invalid-input",
          explanation: `Launch input "${pair}" is not in name=value form.`,
          remediation: "Pass each input as `--input <name>=<value>`.",
          possibleEffects: "none",
        },
      };
    }
    values[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { values };
}

/** Split `<id>[@<version>]`; the first `@` divides them. Shared with `bundle
 *  inspect` (A24), which selects a Bundle the same way. */
export function splitSelector(selector: string): {
  id: string;
  version?: string;
} {
  const at = selector.indexOf("@");
  return at === -1
    ? { id: selector }
    : { id: selector.slice(0, at), version: selector.slice(at + 1) };
}

// --- shared settlement -----------------------------------------------------

/** Await a submitted Operation's settled outcome. A Run settles asynchronously
 *  now (execution spawns), so the outcome may still be `pending` on the opened
 *  snapshot; when it is, the settled outcome arrives as the operation stream's
 *  first durable update (no sleep, no poll). A synchronous Operation is already
 *  settled and returns at once. */
async function settledOutcome(
  port: ProjectionPort,
  operationId: string,
): Promise<OperationOutcome> {
  const view = port.openProjection({ family: "operation", operationId });
  try {
    if (view.snapshot.outcome.status !== "pending")
      return view.snapshot.outcome;
    for await (const update of view.updates) {
      if (
        update.kind === "durable" &&
        update.snapshot.outcome.status !== "pending"
      ) {
        return update.snapshot.outcome;
      }
    }
    return view.snapshot.outcome;
  } finally {
    view.close();
  }
}

/** The Run-command exit-code contract (A36, src/headless/AGENTS.md): exit 0 only
 *  when the Run rests exactly `succeeded`; 2 when it rests `blocked` at its Human
 *  Gate checkpoint (the gate's expected outcome, distinguished so the CI gate can
 *  assert it with its throw-on-expected helper); 1 for every other rest. */
function exitForState(state: RunStateName): number {
  if (state === "succeeded") return 0;
  if (state === "blocked") return 2;
  return 1;
}

/** The shared tail of the three Run-driving commands (A24): await the Operation's
 *  settled outcome, surface a not-applied refusal, then open the `run` Projection
 *  and report it — `--json` prints the snapshot, plain text prints the caller's
 *  `heading` lines then the state — exiting by the Run's rest state (A36). */
async function settleAndReportRun(
  port: ProjectionPort,
  io: HeadlessIO,
  fail: RunCommandDeps["fail"],
  json: boolean,
  operationId: string,
  runId: string,
  heading: (run: RunView) => readonly string[],
): Promise<number> {
  const outcome = await settledOutcome(port, operationId);
  if (outcome.status === "not-applied") return fail(io, json, outcome.problem);

  const opened = port.openProjection({ family: "run", runId });
  try {
    const snapshot = opened.snapshot;
    if (json) {
      io.out(`${JSON.stringify(snapshot, null, 2)}\n`);
      return snapshot.result.found
        ? exitForState(snapshot.result.run.state)
        : 1;
    }
    if (!snapshot.result.found) return fail(io, false, snapshot.result.problem);
    const run = snapshot.result.run;
    for (const line of heading(run)) io.out(`${line}\n`);
    io.out(`State: ${run.state}\n`);
    // A Run that rests `blocked` names the follow-up answer command so a headless
    // operator knows how to continue (A36, spec stories 33/34): a free-text gate
    // names `--text`, an approve/reject gate (or checkpoint) names `--continue`/`--stop`.
    for (const line of answerHint(run)) io.out(`${line}\n`);
    return exitForState(run.state);
  } finally {
    opened.close();
  }
}

/** The follow-up answer command to name when a Run rests `blocked` at a gate, or
 *  nothing when the Run is not blocked at an answerable gate (#108). */
function answerHint(run: RunView): readonly string[] {
  const offer = run.actionOffers.find(
    (candidate): candidate is AnswerHumanGateOffer =>
      candidate.action === "answer-human-gate",
  );
  if (offer === undefined) return [];
  return offer.gate.shape === "free-text"
    ? [`Next: secant run answer ${run.runId} --text <value>`]
    : [`Next: secant run answer ${run.runId} --continue | --stop`];
}

// --- command implementations -----------------------------------------------

interface TLaunchRunParams {
  readonly port: ProjectionPort;
  readonly io: HeadlessIO;
  readonly fail: RunCommandDeps["fail"];
  readonly json: boolean;
  readonly selector: string;
  readonly trust?: string;
  readonly inputs: Record<string, string>;
  readonly harness?: string;
  readonly model?: string;
  readonly harnessRequests: HarnessRequestPolicy;
}

/** Read the launch-preparation assessment for one draft (#189): return the settled
 *  snapshot, awaiting the first durable update when the initial snapshot is still
 *  `assessing` (a requested model is being qualified), like `harness inspect` waits
 *  on its first focus update. */
async function assessDraft(
  port: ProjectionPort,
  draft: LaunchRunInput,
): Promise<LaunchPreparationSnapshot> {
  const opened = port.openProjection({ family: "launch-preparation", draft });
  try {
    if (opened.snapshot.status !== "assessing") return opened.snapshot;
    for await (const update of opened.updates) {
      if (update.kind === "durable" && update.snapshot.status !== "assessing") {
        return update.snapshot;
      }
    }
    return opened.snapshot;
  } finally {
    opened.close();
  }
}

/** Print every assessment finding and exit one (#189): `--json` prints the
 *  not-ready status with its findings; plain text prints each finding through the
 *  shared `fail` renderer, so an operator sees all problems in one invocation and
 *  the per-Problem format never drifts from a single refusal's. */
function reportNotReady(
  io: HeadlessIO,
  fail: RunCommandDeps["fail"],
  json: boolean,
  findings: readonly Problem[],
): number {
  if (json) {
    io.out(`${JSON.stringify({ status: "not-ready", findings }, null, 2)}\n`);
    return 1;
  }
  for (const problem of findings) fail(io, false, problem);
  return 1;
}

async function launchRun(params: TLaunchRunParams): Promise<number> {
  const { port, io, fail, json, selector, inputs, harnessRequests } = params;
  const { id, version } = splitSelector(selector);
  const draft: LaunchRunInput = {
    bundle: { id, version },
    launchInputs: inputs,
    trustDigest: params.trust,
    harness: params.harness,
    requestedModel: params.model,
  };
  // Read the `launch-preparation` assessment first (#189): when the draft is not
  // ready, print every finding in text and JSON and exit without submitting, so an
  // operator sees all problems in one invocation. A ready draft falls through to
  // the launch, which reruns every authoritative check under identical rules.
  const assessment = await assessDraft(port, draft);
  if (assessment.status === "not-ready") {
    return reportNotReady(io, fail, json, assessment.findings);
  }
  const admission = port.submit({
    operationId: randomUUID(),
    operation: "launch-run",
    input: draft,
  });
  if (!admission.admitted) return fail(io, json, admission.problem);
  const runId = admission.runId;
  if (runId === undefined) {
    // A launch always identifies its Run; a missing id is a contract violation.
    return fail(io, json, {
      code: "run-not-identified",
      explanation: "The launch was admitted without identifying a Run.",
      remediation: "Retry the launch; if it persists, report it.",
      possibleEffects: "unknown",
    });
  }
  // Follow the live Run and answer each approval request by the policy while execution
  // drives it (#117); the follower must be running before settlement is awaited, so an
  // Agent Turn that pauses on an approval is unblocked and can rest (A34).
  return withHarnessRequests(port, runId, harnessRequests, () =>
    // The launch drives execution (async now); await settlement, then report the
    // Run and exit by its rest state — exit-when-blocked (A36).
    settleAndReportRun(
      port,
      io,
      fail,
      json,
      admission.operationId,
      runId,
      (run) => [`Run ${run.runId}`],
    ),
  );
}

async function showRun(
  port: ProjectionPort,
  io: HeadlessIO,
  fail: RunCommandDeps["fail"],
  json: boolean,
  runId: string,
): Promise<number> {
  const opened = port.openProjection({ family: "run", runId });
  try {
    const snapshot = opened.snapshot;
    if (json) {
      io.out(`${JSON.stringify(snapshot, null, 2)}\n`);
      return snapshot.result.found ? 0 : 1;
    }
    if (!snapshot.result.found) return fail(io, false, snapshot.result.problem);
    const run = snapshot.result.run;
    io.out(renderRun(run));
    // The durable snapshot names the durable Human Gate and interactive-Turn bases
    // (renderRun), but the ephemeral approval Harness Request is never durable — it rides
    // the live overlay the launch/resume follower consumes (#117, A15). Peek the current
    // overlay (bounded: it is buffered at open only while a Turn is live here, so it
    // returns at once or not at all) and, when requests are outstanding, name every one
    // and the ephemeral basis. `run show` thus names the blocked basis for all three
    // cases. The frozen `--json` shape is unchanged — this is plain-text only.
    const outstanding = (await peekLiveOverlay(opened))?.outstanding ?? [];
    if (outstanding.length > 0) io.out(renderOutstandingRequests(outstanding));
    // The conflict diagnostic is reached by reference, never inlined in the
    // snapshot (AC5); resolve and print it so `run show` is self-contained.
    if (run.conflict !== undefined) {
      const read = port.readResource(run.conflict.reference);
      if (read.found) io.out(`\nDiagnostic:\n${read.content}`);
    }
    return 0;
  } finally {
    opened.close();
  }
}

/** Read the Run's current live overlay if a Turn is live here, else undefined. The
 *  overlay is buffered into the opened stream at open time when a Turn is live (#117),
 *  so the first update resolves at once; when no Turn is live nothing is buffered and a
 *  bare read would block forever, so race it against an immediate tick. */
async function peekLiveOverlay(
  opened: OpenedProjection<RunSnapshot>,
): Promise<RunLiveOverlay | undefined> {
  const iterator = opened.updates[Symbol.asyncIterator]();
  const tick = new Promise<undefined>((resolve) =>
    setImmediate(() => resolve(undefined)),
  );
  const result = await Promise.race([iterator.next(), tick]);
  // If the tick won, the `iterator.next()` is left outstanding on the single-consumer
  // stream; `showRun`'s `finally` closes the projection right after this returns, which
  // resolves it `done`. No further read of `opened.updates` happens, so nothing is lost.
  if (result === undefined || result.done) return undefined;
  return result.value.kind === "live" ? result.value.overlay : undefined;
}

/** Name every outstanding approval Harness Request and the ephemeral basis for `run
 *  show` (#117, A15): the exact tool, input, and offered decisions Claude Code asked to
 *  run. Several can be outstanding at once, so all are listed — the operator resolves
 *  each. */
function renderOutstandingRequests(
  requests: readonly RunOutstandingRequest[],
): string {
  const lines = ["", "Blocked: ephemeral Harness Request"];
  for (const request of requests) {
    lines.push(
      "Harness Request:",
      `  tool: ${request.tool}`,
      `  input: ${request.input}`,
      `  decisions: ${request.decisions.join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

type TResumeRunParams = {
  readonly port: ProjectionPort;
  readonly io: HeadlessIO;
  readonly fail: RunCommandDeps["fail"];
  readonly json: boolean;
  readonly runId: string;
  readonly takeover: boolean;
  readonly harnessRequests: HarnessRequestPolicy;
};

async function resumeRun(params: TResumeRunParams): Promise<number> {
  const input: { runId: string; takeover?: { ownerPid: number } } = {
    runId: params.runId,
  };
  if (params.takeover) {
    const opened = params.port.openProjection({
      family: "run",
      runId: params.runId,
    });
    try {
      if (opened.snapshot.result.found) {
        const offer = opened.snapshot.result.run.actionOffers.find(
          (candidate): candidate is ResumeRunOffer =>
            candidate.action === "resume-run",
        );
        if (offer?.takeover !== undefined) input.takeover = offer.takeover;
      }
    } finally {
      opened.close();
    }
  }
  const admission = params.port.submit({
    operationId: randomUUID(),
    operation: "resume-run",
    input,
  });
  if (!admission.admitted) {
    return params.fail(params.io, params.json, admission.problem);
  }
  // Follow the live Run and answer approval requests by the policy while execution
  // drives it (#117), like `run launch` (A34).
  return withHarnessRequests(
    params.port,
    params.runId,
    params.harnessRequests,
    () =>
      // The resume drives execution (async now); await settlement and report, like
      // `run launch`.
      settleAndReportRun(
        params.port,
        params.io,
        params.fail,
        params.json,
        admission.operationId,
        params.runId,
        (run) => [`Run ${run.runId}`],
      ),
  );
}

/** The answer a client typed: `continue`/`stop` for an approve-reject gate (or a
 *  Review checkpoint), or free `text` for a free-text gate (#108). The Port decides
 *  legality against the live Gate's shape; the client only forwards what was typed. */
type HeadlessGateAnswer =
  | { readonly kind: "continue" }
  | { readonly kind: "stop" }
  | { readonly kind: "text"; readonly value: string };

async function answerRun(
  port: ProjectionPort,
  io: HeadlessIO,
  fail: RunCommandDeps["fail"],
  json: boolean,
  runId: string,
  answer: HeadlessGateAnswer,
): Promise<number> {
  // Gate on the Port's answer Offer (A14): the Offer owns legality
  // (projection-port.ts) and carries the exact Gate reference, so its absence —
  // not a client re-derivation from `run.state` — is what refuses an unanswerable
  // Run, and a Gate that moved between the read and the submit is caught as stale
  // by the Application because we submit against the Offer's reference. The Offer's
  // gate shape is not re-classified here; a `--text` answer to an approve-reject
  // gate (or vice versa) is left for the Application to refuse precisely.
  const opened = port.openProjection({ family: "run", runId });
  let gate;
  // Whether the Run rests at an authored Human Gate (vs a derived Review
  // checkpoint), read before answering so the report describes what `continue`/
  // `stop` did accurately — an authored gate approves/rejects a single pause, only
  // a checkpoint grants a review interval (#108).
  let authored = false;
  try {
    const snapshot = opened.snapshot;
    if (!snapshot.result.found) return fail(io, json, snapshot.result.problem);
    const run = snapshot.result.run;
    const offer = run.actionOffers.find(
      (candidate): candidate is AnswerHumanGateOffer =>
        candidate.action === "answer-human-gate",
    );
    if (offer === undefined) {
      return fail(io, json, {
        code: "run-not-blocked",
        explanation: `Run ${runId} is ${run.state}, not blocked; there is no Human Gate to answer.`,
        remediation:
          "Run `secant run show <run-id>` to see the Run's state; only a blocked Run can be answered.",
        possibleEffects: "none",
        details: { runId, state: run.state },
      });
    }
    gate = offer.gate;
    authored = run.pendingGate !== undefined;
  } finally {
    opened.close();
  }

  const admission = port.submit({
    operationId: randomUUID(),
    operation: "answer-human-gate",
    input:
      answer.kind === "text"
        ? { runId, gate, text: answer.value }
        : { runId, gate, answer: answer.kind },
  });
  if (!admission.admitted) return fail(io, json, admission.problem);

  // A `continue`/approve/free-text answer drives execution (async now); await
  // settlement and report.
  return settleAndReportRun(
    port,
    io,
    fail,
    json,
    admission.operationId,
    runId,
    () => [
      `Run ${runId}`,
      answer.kind === "continue"
        ? authored
          ? "Answered: continue (approved; the Run advances past the gate)"
          : "Answered: continue (granted one more review interval)"
        : answer.kind === "stop"
          ? authored
            ? "Answered: stop (rejected; the Run ends failed, history and Artifacts kept)"
            : "Answered: stop (ended the Run failed, history and Artifacts kept)"
          : `Answered: ${answer.value} (published as the gate's output)`,
    ],
  );
}

function readRun(
  port: ProjectionPort,
  io: HeadlessIO,
  fail: RunCommandDeps["fail"],
  json: boolean,
  reference: string,
): number {
  const slash = reference.indexOf("/");
  if (slash <= 0 || slash === reference.length - 1) {
    return fail(io, json, {
      code: "invalid-reference",
      explanation: `Reference "${reference}" is not in <run-id>/<name> form.`,
      remediation: "Run `secant run read <run-id>/<name>`.",
      possibleEffects: "none",
    });
  }
  const runId = reference.slice(0, slash);
  const name = reference.slice(slash + 1);

  const opened = port.openProjection({ family: "run", runId });
  let outputRef;
  try {
    const snapshot = opened.snapshot;
    if (!snapshot.result.found) return fail(io, json, snapshot.result.problem);
    const output = snapshot.result.run.outputs.find((o) => o.name === name);
    if (output === undefined) {
      return fail(io, json, {
        code: "run-output-not-found",
        explanation: `Run ${runId} has no bound output named ${name}.`,
        remediation:
          "Run `secant run show <run-id>` to see the Run's current outputs.",
        possibleEffects: "none",
        details: { runId, name },
      });
    }
    outputRef = output.reference;
  } finally {
    opened.close();
  }

  const read = port.readResource(outputRef);
  if (!read.found) return fail(io, json, read.problem);
  if (json) {
    io.out(`${JSON.stringify(read, null, 2)}\n`);
    return 0;
  }
  io.out(read.content.endsWith("\n") ? read.content : `${read.content}\n`);
  return 0;
}

// `run read --transcript` (#124): resolve one Session's newest transcript page and
// its complete export through the same typed References the Workbench uses, so the
// two clients read one transcript the same way. The `--json` shape is additive.
function readTranscript(
  port: ProjectionPort,
  io: HeadlessIO,
  fail: RunCommandDeps["fail"],
  json: boolean,
  options: { reference: string; session?: string },
): number {
  const slash = options.reference.indexOf("/");
  const runId =
    slash > 0 ? options.reference.slice(0, slash) : options.reference;
  // The Session comes from `<run-id>/<session>`, then `--session`.
  const session =
    slash > 0 ? options.reference.slice(slash + 1) : options.session;

  const opened = port.openProjection({ family: "run", runId });
  let pageRef;
  let exportRef;
  try {
    const snapshot = opened.snapshot;
    if (!snapshot.result.found) return fail(io, json, snapshot.result.problem);
    const sessions = (snapshot.result.run.sessions ?? []).filter(
      (s) => s.transcriptPage !== undefined,
    );
    const chosen =
      session !== undefined
        ? sessions.find((s) => s.session === session)
        : sessions.length === 1
          ? sessions[0]
          : undefined;
    if (chosen?.transcriptPage === undefined) {
      return fail(io, json, {
        code: "run-session-not-found",
        explanation:
          session !== undefined
            ? `Run ${runId} has no Session named ${session} with a recorded transcript.`
            : sessions.length === 0
              ? `Run ${runId} has no recorded transcript.`
              : `Run ${runId} has more than one Session; name one with --session.`,
        remediation:
          sessions.length > 1
            ? `Run \`secant run read ${runId} --transcript --session <name>\` (Sessions: ${sessions
                .map((s) => s.session)
                .join(", ")}).`
            : "Run `secant run show <run-id>` to see the Run's Sessions.",
        possibleEffects: "none",
        details: { runId, ...(session !== undefined ? { session } : {}) },
      });
    }
    pageRef = chosen.transcriptPage;
    exportRef = chosen.transcriptExport;
  } finally {
    opened.close();
  }

  const page = port.readTranscript(pageRef);
  if (!page.found) return fail(io, json, page.problem);
  const complete =
    exportRef !== undefined ? port.readTranscript(exportRef) : undefined;
  if (complete !== undefined && !complete.found) {
    return fail(io, json, complete.problem);
  }

  if (json) {
    io.out(`${JSON.stringify({ page, export: complete }, null, 2)}\n`);
    return 0;
  }
  io.out(`Transcript page (${pageRef.session}):\n`);
  io.out(renderTranscriptEntries(page.entries));
  if (page.type === "transcript-page" && page.older !== undefined) {
    io.out("… older entries retained; page up in the Run Workbench.\n");
  }
  if (complete !== undefined && complete.found) {
    io.out(`\nComplete transcript (${pageRef.session}):\n`);
    io.out(renderTranscriptEntries(complete.entries));
  }
  return 0;
}

/** Render transcript entries as plain text, one labelled block per entry. */
function renderTranscriptEntries(
  entries: readonly { role: string; content: string }[],
): string {
  if (entries.length === 0) return "(no entries)\n";
  return entries
    .map(
      (entry) =>
        // Strip ANSI so the transcript reads clean, matching the TUI (D12).
        `${entry.role === "user" ? "user" : "assistant"}: ${stripAnsi(entry.content)}`,
    )
    .join("\n")
    .concat("\n");
}

function listRuns(
  port: ProjectionPort,
  io: HeadlessIO,
  json: boolean,
  resumable: boolean,
  before: string | undefined,
): number {
  const opened = port.openProjection({
    family: "run-list",
    ...(resumable ? { resumable: true } : {}),
    ...(before !== undefined ? { before } : {}),
  });
  try {
    const snapshot = opened.snapshot;
    if (json) {
      io.out(`${JSON.stringify(snapshot, null, 2)}\n`);
      return 0;
    }
    io.out(renderRunList(snapshot));
    return 0;
  } finally {
    opened.close();
  }
}

/** Submit a cancel-run/delete-run Operation and report its settled outcome. Both
 *  settle inline in a headless process (the Run is not live in it: delete is a
 *  synchronous settler, and a cancel of a Run not live here settles at once), so
 *  the Operation is already applied on the opened snapshot. */
function endRunOperation(
  port: ProjectionPort,
  io: HeadlessIO,
  fail: RunCommandDeps["fail"],
  json: boolean,
  operation: "cancel-run" | "delete-run",
  runId: string,
): number {
  const admission = port.submit({
    operationId: randomUUID(),
    operation,
    input: { runId },
  });
  if (!admission.admitted) return fail(io, json, admission.problem);

  const opened = port.openProjection({
    family: "operation",
    operationId: admission.operationId,
  });
  try {
    const outcome = opened.snapshot.outcome;
    if (json) {
      io.out(`${JSON.stringify(opened.snapshot, null, 2)}\n`);
      return outcome.status === "applied" ? 0 : 1;
    }
    if (outcome.status === "not-applied") {
      return fail(io, false, outcome.problem);
    }
    io.out(
      operation === "cancel-run"
        ? `Cancelled run ${runId}\n`
        : `Deleted run ${runId}\n`,
    );
    return 0;
  } finally {
    opened.close();
  }
}
