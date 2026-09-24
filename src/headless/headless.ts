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
import { renderFocus, renderRow } from "./render.js";
import { registerRunCommands, splitSelector } from "./run-commands.js";
import { registerHarnessCommands } from "./harness-commands.js";

// The headless client speaks the Application Interfaces and nothing else: the
// Projection Port for the Workspace and Bundle-management for `bundle build`.
// It prints plain text with status carried by words; `--json` prints the
// Projection snapshot, Operation result, or build report verbatim; any Problem
// prints its code, explanation, and remediation and exits non-zero.
//
// One `commander` command tree owns all argument parsing (help is generated, so
// it never drifts from the commands that exist). The tree is built once by
// `buildProgram` and driven two ways: `runHeadless` parses with clients in hand
// (tests, and any in-process caller); `runHeadlessCli` parses behind a
// `CommandExecutor` the CLI host uses to wire the composition root lazily, so
// SQLite stays off the `--help`/`--version` paths. Both `parseAsync` and await
// the action, since a Run command settles asynchronously (execution spawns).

export interface HeadlessClients {
  readonly projectionPort: ProjectionPort;
  readonly bundleManagement: BundleManagement;
  /** The Shipped Bundle startup ensure's notices (ADR 0029). Each command prints
   *  them to stderr before it runs, leaving stdout and its `--json` untouched. */
  readonly startupNotices?: readonly Problem[];
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
  run: (clients: HeadlessClients) => number | Promise<number>,
) => number | Promise<number>;

/** Wraps a command's result so `parseAsync` awaits an async Run command while a
 *  synchronous command sets the exit code at once (see `settle` in `buildProgram`).
 *  Shared with the `run` command group (run-commands.ts). */
export type SettleAction = (
  result: number | Promise<number>,
) => void | Promise<void>;

/** Runs one headless invocation with clients in hand. `args` is everything after
 *  `secant`. Async because a Run command (launch, resume, answer) drives
 *  execution, which spawns and settles asynchronously; `parseAsync` awaits the
 *  action so the exit code is final before this resolves. */
export async function runHeadless(
  clients: HeadlessClients,
  args: readonly string[],
  io: HeadlessIO,
): Promise<number> {
  const { program, state } = buildProgram(io, "0.0.0-dev", (run) =>
    run(clients),
  );
  try {
    await program.parseAsync(args as string[], { from: "user" });
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
  wired: CommandExecutor,
): { program: Command; state: { code: number } } {
  const state = { code: 0 };
  // A failed Shipped Bundle ensure never blocks the command: it is a notice.
  const execute: CommandExecutor = (run) =>
    wired((clients) => {
      for (const notice of clients.startupNotices ?? []) {
        io.err(`Notice [${notice.code}]: ${notice.explanation}\n`);
        io.err(`Remediation: ${notice.remediation}\n`);
      }
      return run(clients);
    });
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

  registerHarnessCommands(program, { io, execute, settle, fail });

  // The `run` command group lives in a private file that registers onto this
  // program (A25); it touches only io/execute/fail/settle, which the entry owns.
  registerRunCommands(program, { io, execute, settle, fail });

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
  // `@` — the same split `run launch` uses (A24).
  const { id, version } = splitSelector(selector);
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

function report(io: HeadlessIO, json: boolean, result: BundleResult): number {
  if (!result.ok) return fail(io, json, result.problem);
  if (json) {
    io.out(`${JSON.stringify(result.report, null, 2)}\n`);
    return 0;
  }
  const { identity, digest, outputPath, installed, findings } = result.report;
  io.out(`Bundle: ${identity.id}@${identity.version}\n`);
  io.out(`Digest: sha256:${digest}\n`);
  if (outputPath !== undefined) io.out(`Wrote ${outputPath}\n`);
  if (installed?.status === "installed") {
    io.out("Installed.\n");
  } else if (installed?.status === "already-installed") {
    io.out("Already installed.\n");
  }
  // The advisory build notes the report carries (the derived engine range, the
  // inserted build-host platform) are printed in plain text too, not only under
  // `--json` (A12) — the field exists to be seen.
  if (findings.length > 0) {
    io.out("Findings:\n");
    for (const finding of findings) io.out(`  ${finding}\n`);
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
