#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { platform, release, tmpdir, version as osVersion } from "node:os";
import { basename, resolve } from "node:path";
import {
  evaluateProofBundleEvidence,
  formatInstalledHarnessDetails,
  observedHarnessForReport,
  parseInstalledHarnessProblem,
  parseTerminalHarnessDiagnostic,
  type CommandDiagnostics,
  type InstalledHarnessFailureDiagnostics,
} from "./installed-harness-report.js";
import {
  formatReleaseEvidenceReport,
  sha256File,
  type ReleaseEvidenceReport,
} from "./release-evidence.js";

type HarnessId = "claude-code" | "codex";

interface ObjectValue {
  readonly [key: string]: unknown;
}

const HELP = `Installed-Harness Proof Bundle release check

Usage:
  bun scripts/release-checks/installed-harness.ts <claude-code|codex> <candidate-binary> <proof-bundle.wfb> <workspace> <failing-test>

The workspace must be a disposable Git worktree prepared for the external Test
Repair Proof Bundle. This check runs the external candidate, approves the
workspace, installs the external Bundle, and approves its authored commit gate.
The check intentionally leaves the resulting repair commit in the workspace.`;

function fail(message: string, cause?: unknown): never {
  throw new Error(message, cause === undefined ? undefined : { cause });
}

function object(value: unknown): ObjectValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as ObjectValue;
}

function json(output: string): ObjectValue | undefined {
  try {
    return object(JSON.parse(output));
  } catch {
    return undefined;
  }
}

function nested(value: unknown, ...path: readonly string[]): unknown {
  let current: unknown = value;
  for (const part of path) current = object(current)?.[part];
  return current;
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): CommandDiagnostics {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
  });
  if (result.error) fail(`Could not run ${basename(command)}.`, result.error);
  if (result.signal) {
    fail(`${basename(command)} was terminated by signal ${result.signal}.`);
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function requireStatus(
  result: CommandDiagnostics,
  expected: number,
  action: string,
): string {
  if (result.status !== expected) {
    fail(
      `${action} exited ${String(result.status)} instead of ${expected}.\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function osName(): string {
  if (platform() === "win32") return "Windows";
  if (platform() === "darwin") return "macOS";
  if (platform() === "linux") return "Linux";
  return platform();
}

function validateFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`${label} is not a file: ${path}`);
  }
}

function validateDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${label} is not a directory: ${path}`);
  }
}

function harnessName(harness: HarnessId): string {
  return harness === "claude-code" ? "Claude Code" : "Codex";
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function runIdFromLaunch(value: ObjectValue | undefined): string | undefined {
  return (
    nonEmptyString(value?.runId) ??
    nonEmptyString(nested(value, "details", "runId"))
  );
}

function runFromSnapshot(
  value: ObjectValue | undefined,
): ObjectValue | undefined {
  return object(nested(value, "result", "run"));
}

function readRun(
  candidate: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  runId: string,
): ObjectValue | undefined {
  const shown = run(candidate, ["run", "show", runId, "--json"], {
    cwd: workspace,
    env,
  });
  return shown.status === 0 ? runFromSnapshot(json(shown.stdout)) : undefined;
}

function readTerminalHarnessDiagnostic(
  candidate: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  runId: string,
): string | undefined {
  const read = run(
    candidate,
    ["run", "read", runId, "--transcript", "--json"],
    { cwd: workspace, env },
  );
  if (read.status !== 0) return undefined;
  return parseTerminalHarnessDiagnostic(json(read.stdout));
}

function failureDiagnostics(
  launchedResult: CommandDiagnostics,
  postApprovalRunResult: CommandDiagnostics | undefined,
  commitVerdict: CommandDiagnostics | undefined,
  commitOutput: CommandDiagnostics | undefined,
  launched: ObjectValue | undefined,
  currentRun: ObjectValue | undefined,
  transcript: string | undefined,
): InstalledHarnessFailureDiagnostics {
  return {
    launch: launchedResult,
    postApprovalRun: postApprovalRunResult,
    commitVerdict,
    commitOutput,
    problem:
      parseInstalledHarnessProblem(launched) ??
      parseInstalledHarnessProblem(currentRun?.problem),
    transcript:
      transcript ?? nonEmptyString(object(currentRun?.problem)?.explanation),
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  const [harnessValue, candidateValue, bundleValue, workspaceValue, testValue] =
    process.argv.slice(2);
  if (harnessValue !== "claude-code" && harnessValue !== "codex") {
    fail(`First argument must be claude-code or codex.\n\n${HELP}`);
  }
  if (
    candidateValue === undefined ||
    bundleValue === undefined ||
    workspaceValue === undefined ||
    testValue === undefined
  ) {
    fail(HELP);
  }

  const harness = harnessValue;
  const candidate = resolve(candidateValue);
  const bundle = resolve(bundleValue);
  const workspace = resolve(workspaceValue);
  const failingTest = resolve(workspace, testValue);
  validateFile(candidate, "Candidate binary");
  validateFile(bundle, "Proof Bundle");
  validateDirectory(workspace, "Workspace");
  validateFile(failingTest, "Failing test");

  const home = mkdtempSync(`${tmpdir()}/secant-harness-evidence-`);
  const env = { ...process.env, SECANT_HOME: home };
  try {
    const secantVersion = requireStatus(
      run(candidate, ["--version"], { cwd: workspace, env }),
      0,
      "Candidate version check",
    ).trim();
    const installed = json(
      requireStatus(
        run(candidate, ["bundle", "install", bundle, "--json"], {
          cwd: workspace,
          env,
        }),
        0,
        "Proof Bundle install",
      ),
    );
    const identity = object(installed?.identity);
    const bundleId = identity?.id;
    const bundleDigest = installed?.digest;
    if (
      typeof bundleId !== "string" ||
      typeof bundleDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(bundleDigest)
    ) {
      fail(
        "Proof Bundle install did not return an identity and SHA-256 digest.",
      );
    }
    requireStatus(
      run(candidate, ["workspace", "approve"], { cwd: workspace, env }),
      0,
      "Workspace approval",
    );
    const baselineCommit = requireStatus(
      run("git", ["rev-parse", "HEAD"], { cwd: workspace, env }),
      0,
      "Baseline commit read",
    ).trim();

    const launchedResult = run(
      candidate,
      [
        "run",
        "launch",
        bundleId,
        "--input",
        `failing-test=${failingTest}`,
        "--trust",
        bundleDigest,
        "--harness",
        harness,
        "--harness-requests",
        "allow",
        "--json",
      ],
      { cwd: workspace, env },
    );
    const launched = json(launchedResult.stdout);
    const runId = runIdFromLaunch(launched);
    const launchedRun = runFromSnapshot(launched);
    const progress = Array.isArray(launchedRun?.progress)
      ? launchedRun.progress
      : [];
    const repairStep = progress.find((step) => object(step)?.id === "fix");
    const repairVerdict =
      typeof runId === "string"
        ? run(candidate, ["run", "read", `${runId}/test-verdict`], {
            cwd: workspace,
            env,
          })
        : undefined;
    const repairPassed =
      object(repairStep)?.status === "succeeded" &&
      repairVerdict?.status === 0 &&
      repairVerdict.stdout.trim() === "pass";
    const authoredGateReached =
      launchedResult.status === 2 &&
      launchedRun?.state === "blocked" &&
      nested(launchedRun, "pendingGate", "gate", "shape") ===
        "approve-reject" &&
      nested(launchedRun, "pendingGate", "gate", "stepId") === "approve-commit";
    const beforeApprovalCommit = requireStatus(
      run("git", ["rev-parse", "HEAD"], { cwd: workspace, env }),
      0,
      "Pre-approval commit read",
    ).trim();

    const answeredResult =
      typeof runId === "string" && authoredGateReached
        ? run(candidate, ["run", "answer", runId, "--continue", "--json"], {
            cwd: workspace,
            env,
          })
        : undefined;
    const answered = json(answeredResult?.stdout ?? "");
    const answeredRun = object(nested(answered, "result", "run"));
    const afterApprovalCommit = requireStatus(
      run("git", ["rev-parse", "HEAD"], { cwd: workspace, env }),
      0,
      "Post-approval commit read",
    ).trim();
    const commitVerdict =
      typeof runId === "string" && answeredResult !== undefined
        ? run(candidate, ["run", "read", `${runId}/commit-verdict`], {
            cwd: workspace,
            env,
          })
        : undefined;
    const commitOutput =
      typeof runId === "string" && answeredResult !== undefined
        ? run(candidate, ["run", "read", `${runId}/commit-output`], {
            cwd: workspace,
            env,
          })
        : undefined;
    const evidence = evaluateProofBundleEvidence({
      repairPassed,
      authoredGateReached,
      committedBeforeApproval: beforeApprovalCommit !== baselineCommit,
      runSucceededAfterApproval:
        answeredResult?.status === 0 && answeredRun?.state === "succeeded",
      postApprovalCommitObserved:
        afterApprovalCommit !== baselineCommit &&
        commitVerdict?.status === 0 &&
        commitVerdict.stdout.trim() === "pass",
    });
    const currentRun =
      evidence.outcome === "fail" && runId !== undefined
        ? readRun(candidate, workspace, env, runId)
        : launchedRun;
    const observedHarness = observedHarnessForReport(
      harnessName(harness),
      launchedRun?.harness ?? currentRun?.harness,
      evidence.outcome,
    );
    const diagnostics =
      evidence.outcome === "fail"
        ? failureDiagnostics(
            launchedResult,
            answeredResult,
            commitVerdict,
            commitOutput,
            launched,
            currentRun,
            runId === undefined
              ? undefined
              : readTerminalHarnessDiagnostic(candidate, workspace, env, runId),
          )
        : undefined;
    const report: ReleaseEvidenceReport = {
      checkName: `${harnessName(harness)} installed-Harness Proof Bundle check`,
      operatingSystem: {
        name: osName(),
        version: `${osVersion()} (${release()})`,
      },
      subject: {
        kind: "harness",
        name: observedHarness.name,
        version: observedHarness.version,
      },
      bunVersion: Bun.version,
      secantVersion,
      binarySha256: await sha256File(candidate),
      outcome: evidence.outcome,
      timestamp: new Date().toISOString(),
    };
    console.log(
      `${formatReleaseEvidenceReport(report)}\n\n${formatInstalledHarnessDetails(evidence, diagnostics)}`,
    );
    if (evidence.outcome === "fail") process.exitCode = 1;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
