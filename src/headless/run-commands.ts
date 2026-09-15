import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type {
  AnswerHumanGateOffer,
  OperationOutcome,
  Problem,
  ProjectionPort,
  RunStateName,
  RunView,
} from "../application/projection-port.js";
import type { CommandExecutor, HeadlessIO, SettleAction } from "./headless.js";
import { renderRun, renderRunList } from "./render.js";

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
  run
    .command("launch")
    .description("launch an installed Command-only Bundle")
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
    .option("--json", "print the Run snapshot as JSON")
    .action(
      (
        selector: string | undefined,
        options: { trust?: string; input: string[]; json?: boolean },
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
        return settle(
          execute((clients) =>
            launchRun(
              clients.projectionPort,
              io,
              fail,
              json,
              selector,
              options.trust,
              inputs.values,
            ),
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
  run
    .command("resume")
    .description(
      "resume a halted or failed Run, running it until it rests again",
    )
    .argument("[run-id]", "the Run id printed at launch")
    .option("--json", "print the Run snapshot as JSON")
    .action((runId: string | undefined, options: { json?: boolean }) => {
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
      return settle(
        execute((clients) =>
          resumeRun(clients.projectionPort, io, fail, json, runId),
        ),
      );
    });
  run
    .command("answer")
    .description("answer the Human Gate a blocked Run rests at")
    .argument("[run-id]", "the Run id printed at launch")
    .option("--continue", "grant one more review interval and resume the Run")
    .option("--stop", "end the Run failed, keeping history and Artifacts")
    .option("--json", "print the Run snapshot as JSON")
    .action(
      (
        runId: string | undefined,
        options: { continue?: boolean; stop?: boolean; json?: boolean },
      ) => {
        const json = options.json ?? false;
        if (runId === undefined) {
          return settle(
            fail(io, json, {
              code: "missing-run-id",
              explanation: "run answer needs a Run id.",
              remediation:
                "Run `secant run answer <run-id> --continue` or `--stop`.",
              possibleEffects: "none",
            }),
          );
        }
        const chosen = [options.continue, options.stop].filter(Boolean).length;
        if (chosen !== 1) {
          return settle(
            fail(io, json, {
              code: "invalid-answer",
              explanation:
                "run answer needs exactly one of --continue or --stop.",
              remediation:
                "Run `secant run answer <run-id> --continue` to grant another interval, or `--stop` to end the Run.",
              possibleEffects: "none",
            }),
          );
        }
        const answer = options.continue ? "continue" : "stop";
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
    .action((reference: string | undefined, options: { json?: boolean }) => {
      const json = options.json ?? false;
      if (reference === undefined) {
        return settle(
          fail(io, json, {
            code: "missing-reference",
            explanation: "run read needs an output reference.",
            remediation: "Run `secant run read <run-id>/<name>`.",
            possibleEffects: "none",
          }),
        );
      }
      return settle(
        execute((clients) =>
          readRun(clients.projectionPort, io, fail, json, reference),
        ),
      );
    });
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
    return exitForState(run.state);
  } finally {
    opened.close();
  }
}

// --- command implementations -----------------------------------------------

async function launchRun(
  port: ProjectionPort,
  io: HeadlessIO,
  fail: RunCommandDeps["fail"],
  json: boolean,
  selector: string,
  trust: string | undefined,
  inputs: Record<string, string>,
): Promise<number> {
  const { id, version } = splitSelector(selector);
  const admission = port.submit({
    operationId: randomUUID(),
    operation: "launch-run",
    input: {
      bundle: { id, ...(version !== undefined ? { version } : {}) },
      launchInputs: inputs,
      ...(trust !== undefined ? { trustDigest: trust } : {}),
    },
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
  // The launch drives execution (async now); await settlement, then report the
  // Run and exit by its rest state — exit-when-blocked (A36).
  return settleAndReportRun(
    port,
    io,
    fail,
    json,
    admission.operationId,
    runId,
    (run) => [`Run ${run.runId}`],
  );
}

function showRun(
  port: ProjectionPort,
  io: HeadlessIO,
  fail: RunCommandDeps["fail"],
  json: boolean,
  runId: string,
): number {
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

async function resumeRun(
  port: ProjectionPort,
  io: HeadlessIO,
  fail: RunCommandDeps["fail"],
  json: boolean,
  runId: string,
): Promise<number> {
  const admission = port.submit({
    operationId: randomUUID(),
    operation: "resume-run",
    input: { runId },
  });
  if (!admission.admitted) return fail(io, json, admission.problem);
  // The resume drives execution (async now); await settlement and report, like
  // `run launch`.
  return settleAndReportRun(
    port,
    io,
    fail,
    json,
    admission.operationId,
    runId,
    (run) => [`Run ${run.runId}`],
  );
}

async function answerRun(
  port: ProjectionPort,
  io: HeadlessIO,
  fail: RunCommandDeps["fail"],
  json: boolean,
  runId: string,
  answer: "continue" | "stop",
): Promise<number> {
  // Gate on the Port's answer Offer (A14): the Offer owns legality
  // (projection-port.ts) and carries the exact Gate reference, so its absence —
  // not a client re-derivation from `run.state` — is what refuses an unanswerable
  // Run, and a Gate that moved between the read and the submit is caught as stale
  // by the Application because we submit against the Offer's reference.
  const opened = port.openProjection({ family: "run", runId });
  let gate;
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
  } finally {
    opened.close();
  }

  const admission = port.submit({
    operationId: randomUUID(),
    operation: "answer-human-gate",
    input: { runId, gate, answer },
  });
  if (!admission.admitted) return fail(io, json, admission.problem);

  // A `continue` answer drives execution (async now); await settlement and report.
  return settleAndReportRun(
    port,
    io,
    fail,
    json,
    admission.operationId,
    runId,
    () => [
      `Run ${runId}`,
      answer === "continue"
        ? "Answered: continue (granted one more review interval)"
        : "Answered: stop (ended the Run failed, history and Artifacts kept)",
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
