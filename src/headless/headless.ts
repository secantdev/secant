import { randomUUID } from "node:crypto";
import type {
  OperationSnapshot,
  Problem,
  ProjectionPort,
  WorkspaceSnapshot,
} from "../application/projection-port.js";

// The headless client speaks the Projection Port and nothing else. It prints
// plain text with status carried by words; `--json` prints the Projection
// snapshot or Operation result verbatim; any Problem prints its code,
// explanation, and remediation and exits non-zero.

export interface HeadlessIO {
  out(text: string): void;
  err(text: string): void;
  cwd(): string;
}

/** Runs one headless invocation. `args` is everything after `secant`. */
export function runHeadless(
  port: ProjectionPort,
  args: readonly string[],
  io: HeadlessIO,
): number {
  if (args[0] !== "workspace") {
    return fail(io, false, {
      code: "unknown-command",
      explanation: `Unknown command: ${args.join(" ") || "(none)"}.`,
      remediation:
        "Run `secant workspace` or `secant workspace approve [path]`.",
      possibleEffects: "none",
    });
  }

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
    return 0;
  } finally {
    opened.close();
  }
}

function fail(io: HeadlessIO, json: boolean, problem: Problem): number {
  if (json) {
    io.out(`${JSON.stringify(problem, null, 2)}\n`);
  } else {
    io.err(`Error [${problem.code}]: ${problem.explanation}\n`);
    io.err(`Remediation: ${problem.remediation}\n`);
  }
  return 1;
}
