import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  BundleManagement,
  BundleResult,
} from "../application/bundle-management.js";
import type {
  OperationSnapshot,
  Problem,
  ProjectionPort,
  WorkspaceSnapshot,
} from "../application/projection-port.js";

// The headless client speaks the Application Interfaces and nothing else: the
// Projection Port for the Workspace and Bundle-management for `bundle build`.
// It prints plain text with status carried by words; `--json` prints the
// Projection snapshot, Operation result, or build report verbatim; any Problem
// prints its code, explanation, and remediation and exits non-zero.

export interface HeadlessClients {
  readonly projectionPort: ProjectionPort;
  readonly bundleManagement: BundleManagement;
}

export interface HeadlessIO {
  out(text: string): void;
  err(text: string): void;
  cwd(): string;
}

/** Runs one headless invocation. `args` is everything after `secant`. */
export function runHeadless(
  clients: HeadlessClients,
  args: readonly string[],
  io: HeadlessIO,
): number {
  if (args[0] === "bundle") {
    return bundleCommand(clients.bundleManagement, io, args.slice(1));
  }
  if (args[0] !== "workspace") {
    return fail(io, false, {
      code: "unknown-command",
      explanation: `Unknown command: ${args.join(" ") || "(none)"}.`,
      remediation:
        "Run `secant workspace`, `secant workspace approve [path]`, or `secant bundle build <folder>`.",
      possibleEffects: "none",
    });
  }
  const port = clients.projectionPort;

  const rest = args.slice(1);
  const json = rest.includes("--json");
  const positional = rest.filter((argument) => !argument.startsWith("-"));

  if (positional[0] === "approve") {
    return approve(port, io, json, positional[1] ?? io.cwd());
  }
  return showWorkspace(port, io, json);
}

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
    const snapshot = opened.snapshot as OperationSnapshot;
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
    const snapshot = opened.snapshot as WorkspaceSnapshot;
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

function bundleCommand(
  bundle: BundleManagement,
  io: HeadlessIO,
  rest: readonly string[],
): number {
  // Single pass so a flag before the folder can't be mistaken for a positional
  // (`--output` consumes the next token as its value, getopt-style).
  const positional: string[] = [];
  let json = false;
  let noInstall = false;
  let output: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--json") json = true;
    else if (token === "--no-install") noInstall = true;
    else if (token === "--output") output = rest[++i];
    else if (token.startsWith("--output="))
      output = token.slice("--output=".length);
    else if (!token.startsWith("-")) positional.push(token);
  }

  const target = positional[1];
  if (positional[0] === "build") {
    if (target === undefined) {
      return fail(io, json, {
        code: "missing-folder",
        explanation: "bundle build needs an authoring folder path.",
        remediation: "Run `secant bundle build <folder>`.",
        possibleEffects: "none",
      });
    }
    return report(
      io,
      json,
      bundle.build(resolve(io.cwd(), target), {
        noInstall,
        output: output === undefined ? undefined : resolve(io.cwd(), output),
      }),
    );
  }
  if (positional[0] === "install") {
    if (target === undefined) {
      return fail(io, json, {
        code: "missing-file",
        explanation: "bundle install needs a .wfb file path.",
        remediation: "Run `secant bundle install <file.wfb>`.",
        possibleEffects: "none",
      });
    }
    return report(io, json, bundle.install(resolve(io.cwd(), target)));
  }
  return fail(io, json, {
    code: "unknown-command",
    explanation: `Unknown bundle command: ${rest.join(" ") || "(none)"}.`,
    remediation:
      "Run `secant bundle build <folder>` or `secant bundle install <file.wfb>`.",
    possibleEffects: "none",
  });
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
    io.out(`Installed (generation ${installed.generation}).\n`);
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
