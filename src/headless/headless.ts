import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import type {
  BundleManagement,
  BundleResult,
} from "../application/bundle-management.js";
import type {
  Problem,
  ProjectionPort,
} from "../application/projection-port.js";
import { renderFocus, renderRow, renderRun } from "./render.js";

// The headless client speaks the Application Interfaces and nothing else: the
// Projection Port for the Workspace and Bundle-management for `bundle build`.
// It prints plain text with status carried by words; `--json` prints the
// Projection snapshot, Operation result, or build report verbatim; any Problem
// prints its code, explanation, and remediation and exits non-zero.
//
// One `commander` command tree owns all argument parsing (help is generated, so
// it never drifts from the commands that exist). The tree is built once by
// `buildProgram` and driven two ways: `runHeadless` parses synchronously with
// clients in hand (tests, and any in-process caller); `runHeadlessCli` parses
// asynchronously behind a `CommandExecutor` the CLI host uses to wire the
// composition root lazily, so SQLite stays off the `--help`/`--version` paths.

export interface HeadlessClients {
  readonly projectionPort: ProjectionPort;
  readonly bundleManagement: BundleManagement;
}

export interface HeadlessIO {
  out(text: string): void;
  err(text: string): void;
  cwd(): string;
}

/**
 * Runs one headless command against the Application Interfaces. The tests and
 * any in-process caller pass clients directly (synchronous); the CLI host passes
 * an executor that wires the composition root only when a command actually runs
 * (asynchronous), which is what keeps the Catalog's SQLite driver off the help
 * and version paths.
 */
export type CommandExecutor = (
  run: (clients: HeadlessClients) => number,
) => number | Promise<number>;

/** Runs one headless invocation with clients in hand. `args` is everything after
 *  `secant`. */
export function runHeadless(
  clients: HeadlessClients,
  args: readonly string[],
  io: HeadlessIO,
): number {
  const { program, state } = buildProgram(io, "0.0.0-dev", (run) =>
    run(clients),
  );
  try {
    program.parse(args as string[], { from: "user" });
  } catch (error) {
    return translateCommanderError(error, io);
  }
  return state.code;
}

/** Drives the same command tree for the CLI host: it supplies the embedded
 *  version and an executor that lazily wires the composition root. */
export async function runHeadlessCli(
  args: readonly string[],
  io: HeadlessIO,
  version: string,
  execute: CommandExecutor,
): Promise<number> {
  const { program, state } = buildProgram(io, version, execute);
  try {
    await program.parseAsync(args as string[], { from: "user" });
  } catch (error) {
    return translateCommanderError(error, io);
  }
  return state.code;
}

// --- command tree ----------------------------------------------------------

function buildProgram(
  io: HeadlessIO,
  version: string,
  execute: CommandExecutor,
): { program: Command; state: { code: number } } {
  const state = { code: 0 };
  // An action returns the executor's result; when it is a Promise, return it so
  // `parseAsync` awaits it, otherwise set the exit code synchronously for `parse`.
  const settle = (result: number | Promise<number>): void | Promise<void> => {
    if (typeof result === "number") {
      state.code = result;
      return;
    }
    return result.then((code) => {
      state.code = code;
    });
  };

  const program = new Command();
  program
    .name("secant")
    .description("Secant reaches an outcome by routing between Steps.")
    .version(version, "-V, --version", "output the version number")
    .helpOption("-h, --help", "display help for command")
    // So `--json` after a subcommand reaches that subcommand rather than being
    // eaten by a same-named parent option (`workspace approve --json`).
    .enablePositionalOptions()
    // Settings below are copied into every subcommand as it is added, so they
    // must be configured before the `.command(...)` calls.
    .exitOverride()
    .configureOutput({
      writeOut: (str) => io.out(str),
      writeErr: (str) => io.err(str),
      // Parse errors become Problems in translateCommanderError; suppress
      // Commander's own error line so it is not printed twice.
      outputError: () => {},
    })
    // Top-level `--help` lists every command by its full path — including
    // `bundle install` — by flattening the tree, so the listing can never omit a
    // command that exists (A21). Nested help stays scoped to its own children.
    .configureHelp({
      visibleCommands: (cmd) => {
        const listed: Command[] = [];
        const walk = (parent: Command, recurse: boolean): void => {
          for (const sub of parent.commands) {
            if (sub.name() === "help") continue;
            listed.push(sub);
            if (recurse) walk(sub, true);
          }
        };
        walk(cmd, cmd === program);
        return listed;
      },
      subcommandTerm: (cmd) => `${commandPath(cmd)} ${cmd.usage()}`.trim(),
    });
  program.addHelpText(
    "before",
    "Running `secant` with no command opens the interactive workspace shell.\n",
  );

  const workspace = program
    .command("workspace")
    .description("show the Workspace path and approval state")
    .option("--json", "print the Projection snapshot as JSON")
    .action((options: { json?: boolean }) =>
      settle(
        execute((clients) =>
          showWorkspace(clients.projectionPort, io, options.json ?? false),
        ),
      ),
    );
  workspace
    .command("approve")
    .description("approve a directory as the Workspace")
    .argument("[path]", "directory to approve (defaults to the current one)")
    .option("--json", "print the Operation result as JSON")
    .action((path: string | undefined, options: { json?: boolean }) =>
      settle(
        execute((clients) =>
          approve(
            clients.projectionPort,
            io,
            options.json ?? false,
            // Resolve a relative path against the injected cwd, like `bundle
            // build`/`install` (#74 A5), not the process cwd.
            path === undefined ? io.cwd() : resolve(io.cwd(), path),
          ),
        ),
      ),
    );

  // No `bundle` action: with subcommands and none given, Commander rejects an
  // unknown token as an unknown command (not an excess argument) and a bare
  // `bundle` as a missing command — both a usage error, exiting non-zero.
  const bundle = program
    .command("bundle")
    .description("build, install, list, and inspect Bundles");
  bundle
    .command("list")
    .description("list every Installed Bundle")
    .option("--json", "print the Projection snapshot as JSON")
    .action((options: { json?: boolean }) =>
      settle(
        execute((clients) =>
          listBundles(clients.projectionPort, io, options.json ?? false),
        ),
      ),
    );
  bundle
    .command("inspect")
    .description("show one Installed Bundle in full")
    .argument("[id@version]", "Bundle id, optionally with @version")
    .option("--json", "print the Bundle as JSON")
    .action((selector: string | undefined, options: { json?: boolean }) => {
      const json = options.json ?? false;
      if (selector === undefined) {
        return settle(
          fail(io, json, {
            code: "missing-bundle-id",
            explanation: "bundle inspect needs a Bundle id.",
            remediation: "Run `secant bundle inspect <id>[@<version>]`.",
            possibleEffects: "none",
          }),
        );
      }
      return settle(
        execute((clients) =>
          inspectBundle(clients.projectionPort, io, json, selector),
        ),
      );
    });
  bundle
    .command("build")
    .description("build an authoring folder into a .wfb file")
    .argument("[folder]", "authoring folder to build")
    .option("--no-install", "build without installing the result")
    .option("--output <file>", "write the built .wfb to this path")
    .option("--json", "print the build report as JSON")
    .action(
      (
        folder: string | undefined,
        options: { install?: boolean; output?: string; json?: boolean },
      ) => {
        const json = options.json ?? false;
        if (folder === undefined) {
          return settle(
            fail(io, json, {
              code: "missing-folder",
              explanation: "bundle build needs an authoring folder path.",
              remediation: "Run `secant bundle build <folder>`.",
              possibleEffects: "none",
            }),
          );
        }
        return settle(
          execute((clients) =>
            report(
              io,
              json,
              clients.bundleManagement.build(resolve(io.cwd(), folder), {
                noInstall: options.install === false,
                output:
                  options.output === undefined
                    ? undefined
                    : resolve(io.cwd(), options.output),
              }),
            ),
          ),
        );
      },
    );
  bundle
    .command("install")
    .description("install a .wfb file")
    .argument("[file]", "the .wfb file to install")
    .option("--json", "print the install report as JSON")
    .action((file: string | undefined, options: { json?: boolean }) => {
      const json = options.json ?? false;
      if (file === undefined) {
        return settle(
          fail(io, json, {
            code: "missing-file",
            explanation: "bundle install needs a .wfb file path.",
            remediation: "Run `secant bundle install <file.wfb>`.",
            possibleEffects: "none",
          }),
        );
      }
      return settle(
        execute((clients) =>
          report(
            io,
            json,
            clients.bundleManagement.install(resolve(io.cwd(), file)),
          ),
        ),
      );
    });

  // No `run` action: like `bundle`, a bare `run` or an unknown token is a usage
  // error exiting non-zero. `run launch` executes; `run show`/`run read` observe.
  const run = program.command("run").description("launch, show, and read Runs");
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
        execute((clients) => showRun(clients.projectionPort, io, json, runId)),
      );
    });
  run
    .command("resume")
    .description("resume a halted Run after restoring its Workspace file")
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
          resumeRun(clients.projectionPort, io, json, runId),
        ),
      );
    });
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
          readRun(clients.projectionPort, io, json, reference),
        ),
      );
    });

  return { program, state };
}

/** The space-joined path from the root program to `cmd`, e.g. `bundle install`. */
function commandPath(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c?.parent; c = c.parent) {
    parts.unshift(c.name());
  }
  return parts.join(" ");
}

// Help and version are written by Commander before it throws; a parse error
// (unknown command, unknown flag, excess arguments) becomes a Problem so the
// output stays uniform with the rest of the headless surface. A non-Commander
// throw is a genuine failure and propagates to the host's catch.
function translateCommanderError(error: unknown, io: HeadlessIO): number {
  if (!(error instanceof CommanderError)) throw error;
  // Help (including the help shown for a bare command group) and version were
  // already written; the help text is itself the usage message, so just carry
  // Commander's exit code (0 for `--help`/`--version`, non-zero for a group).
  if (
    error.code === "commander.helpDisplayed" ||
    error.code === "commander.help" ||
    error.code === "commander.version"
  ) {
    return error.exitCode;
  }
  const code =
    error.code === "commander.unknownOption"
      ? "unknown-option"
      : error.code === "commander.excessArguments"
        ? "unexpected-argument"
        : error.code === "commander.missingArgument" ||
            error.code === "commander.optionMissingArgument"
          ? "missing-argument"
          : "unknown-command";
  return fail(io, false, {
    code,
    explanation: error.message,
    remediation:
      "Run `secant --help` to see the available commands and options.",
    possibleEffects: "none",
  });
}

// --- command implementations -----------------------------------------------

function approve(
  port: ProjectionPort,
  io: HeadlessIO,
  json: boolean,
  path: string,
): number {
  const admission = port.submit({
    operationId: randomUUID(),
    operation: "approve-workspace",
    input: { path },
  });
  if (!admission.admitted) {
    return fail(io, json, admission.problem);
  }

  const opened = port.openProjection({
    family: "operation",
    operationId: admission.operationId,
  });
  try {
    const snapshot = opened.snapshot;
    if (json) {
      io.out(`${JSON.stringify(snapshot, null, 2)}\n`);
      return snapshot.outcome.status === "applied" ? 0 : 1;
    }
    if (snapshot.outcome.status === "not-applied") {
      return fail(io, false, snapshot.outcome.problem);
    }
    io.out(`Approved workspace ${path}\n`);
    return 0;
  } finally {
    opened.close();
  }
}

function showWorkspace(
  port: ProjectionPort,
  io: HeadlessIO,
  json: boolean,
): number {
  const opened = port.openProjection({ family: "workspace" });
  try {
    const snapshot = opened.snapshot;
    if (json) {
      io.out(`${JSON.stringify(snapshot, null, 2)}\n`);
      return 0;
    }
    io.out(`Workspace: ${snapshot.path}\n`);
    if (snapshot.approval.state === "approved") {
      io.out(`Status: approved (since ${snapshot.approval.approvedAt})\n`);
    } else {
      io.out("Status: unapproved\n");
      io.out("Run `secant workspace approve` to approve this workspace.\n");
    }
    io.out(`Installed Bundles: ${snapshot.installedBundleCount}\n`);
    return 0;
  } finally {
    opened.close();
  }
}

function listBundles(
  port: ProjectionPort,
  io: HeadlessIO,
  json: boolean,
): number {
  const opened = port.openProjection({ family: "bundle-catalog" });
  try {
    const snapshot = opened.snapshot;
    if (!snapshot.result.found) {
      // A listed Bundle's managed bytes are gone: print the Problem and exit
      // non-zero, never a stack trace (#74 A3).
      return fail(io, json, snapshot.result.problem);
    }
    const { bundles } = snapshot.result;
    if (json) {
      io.out(`${JSON.stringify(snapshot, null, 2)}\n`);
      return 0;
    }
    if (bundles.length === 0) {
      io.out("No Bundles are installed.\n");
      return 0;
    }
    io.out(bundles.map(renderRow).join("\n"));
    return 0;
  } finally {
    opened.close();
  }
}

function inspectBundle(
  port: ProjectionPort,
  io: HeadlessIO,
  json: boolean,
  selector: string,
): number {
  // The id is lowercase reverse-domain (no `@`); the optional version follows an
  // `@`, so the first `@` splits them.
  const at = selector.indexOf("@");
  const id = at === -1 ? selector : selector.slice(0, at);
  const version = at === -1 ? undefined : selector.slice(at + 1);

  const opened = port.openProjection({
    family: "bundle-catalog",
    focus: { id, ...(version !== undefined ? { version } : {}) },
  });
  try {
    const snapshot = opened.snapshot;
    if (!snapshot.result.found) {
      return fail(io, json, snapshot.result.problem);
    }
    const bundle = snapshot.result.bundle;
    if (json) {
      io.out(`${JSON.stringify(bundle, null, 2)}\n`);
      return 0;
    }
    io.out(renderFocus(bundle));
    return 0;
  } finally {
    opened.close();
  }
}

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

/** Split `<id>[@<version>]`; the first `@` divides them. */
function splitSelector(selector: string): {
  id: string;
  version?: string;
} {
  const at = selector.indexOf("@");
  return at === -1
    ? { id: selector }
    : { id: selector.slice(0, at), version: selector.slice(at + 1) };
}

function launchRun(
  port: ProjectionPort,
  io: HeadlessIO,
  json: boolean,
  selector: string,
  trust: string | undefined,
  inputs: Record<string, string>,
): number {
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

  // The launch settles inline (headless default), so the Operation is already
  // applied here; surface a settlement Problem before reading the Run.
  const operationView = port.openProjection({
    family: "operation",
    operationId: admission.operationId,
  });
  const outcome = operationView.snapshot.outcome;
  operationView.close();
  if (outcome.status === "not-applied") return fail(io, json, outcome.problem);

  const opened = port.openProjection({ family: "run", runId });
  try {
    const snapshot = opened.snapshot;
    if (json) {
      io.out(`${JSON.stringify(snapshot, null, 2)}\n`);
      return snapshot.result.found && snapshot.result.run.state === "succeeded"
        ? 0
        : 1;
    }
    if (!snapshot.result.found) return fail(io, false, snapshot.result.problem);
    const run = snapshot.result.run;
    io.out(`Run ${run.runId}\n`);
    io.out(`State: ${run.state}\n`);
    return run.state === "succeeded" ? 0 : 1;
  } finally {
    opened.close();
  }
}

function showRun(
  port: ProjectionPort,
  io: HeadlessIO,
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

function resumeRun(
  port: ProjectionPort,
  io: HeadlessIO,
  json: boolean,
  runId: string,
): number {
  const admission = port.submit({
    operationId: randomUUID(),
    operation: "resume-run",
    input: { runId },
  });
  if (!admission.admitted) return fail(io, json, admission.problem);

  // The resume settles inline (headless default); surface a settlement Problem
  // before reading the Run, like `run launch`.
  const operationView = port.openProjection({
    family: "operation",
    operationId: admission.operationId,
  });
  const outcome = operationView.snapshot.outcome;
  operationView.close();
  if (outcome.status === "not-applied") return fail(io, json, outcome.problem);

  const opened = port.openProjection({ family: "run", runId });
  try {
    const snapshot = opened.snapshot;
    if (json) {
      io.out(`${JSON.stringify(snapshot, null, 2)}\n`);
      return snapshot.result.found && snapshot.result.run.state === "succeeded"
        ? 0
        : 1;
    }
    if (!snapshot.result.found) return fail(io, false, snapshot.result.problem);
    const run = snapshot.result.run;
    io.out(`Run ${run.runId}\n`);
    io.out(`State: ${run.state}\n`);
    return run.state === "succeeded" ? 0 : 1;
  } finally {
    opened.close();
  }
}

function readRun(
  port: ProjectionPort,
  io: HeadlessIO,
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

function report(io: HeadlessIO, json: boolean, result: BundleResult): number {
  if (!result.ok) return fail(io, json, result.problem);
  if (json) {
    io.out(`${JSON.stringify(result.report, null, 2)}\n`);
    return 0;
  }
  const { identity, digest, outputPath, installed } = result.report;
  io.out(`Bundle: ${identity.id}@${identity.version}\n`);
  io.out(`Digest: sha256:${digest}\n`);
  if (outputPath !== undefined) io.out(`Wrote ${outputPath}\n`);
  if (installed?.status === "installed") {
    io.out("Installed.\n");
  } else if (installed?.status === "already-installed") {
    io.out("Already installed.\n");
  }
  return 0;
}

function fail(io: HeadlessIO, json: boolean, problem: Problem): number {
  if (json) {
    io.out(`${JSON.stringify(problem, null, 2)}\n`);
  } else {
    io.err(`Error [${problem.code}]: ${problem.explanation}\n`);
    for (const violation of problem.fieldViolations ?? []) {
      io.err(`- ${violation.field}: ${violation.explanation}\n`);
    }
    io.err(`Remediation: ${problem.remediation}\n`);
  }
  return 1;
}
