import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import { createClaudeCodeAdapter } from "../../src/harness/harness.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import { installReplayer } from "../harness/replayer.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { seedTestRepairWorkspace } from "../helpers/testRepairWorkspace.js";

// #119: run the checked-in Test Repair Proof Bundle exactly as a user's Bundle,
// through the headless client and the PATH-discovered recorded Claude Code fake.

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROOF_BUNDLE = join(PROJECT_ROOT, "bundles", "test-repair-workflow");
const TEST_REPAIR_FIXTURE = join(
  PROJECT_ROOT,
  "tests",
  "harness",
  "fixtures",
  "claude-code",
  "test-repair",
);
const TEST_REPAIR_SESSION_ID = "77777777-7777-4777-8777-777777777777";
const REPLAYER_VERSION = "2.1.273 (Claude Code)";

interface Fixture {
  readonly wired: Wiring;
  readonly bundleId: string;
  readonly digest: string;
  readonly workspace: string;
  readonly failingTest: string;
  readonly baselineCommit: string;
  readonly replayer: ReturnType<typeof installReplayer>;
}

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();
}

function fixture(t: TestContext): Fixture {
  const replayer = installReplayer(REPLAYER_VERSION, TEST_REPAIR_FIXTURE);
  const savedPath = process.env.PATH;
  const savedConfiguredClaude = process.env.SECANT_CLAUDE_CODE;
  process.env.PATH = replayer.path;
  delete process.env.SECANT_CLAUDE_CODE;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedConfiguredClaude === undefined)
      delete process.env.SECANT_CLAUDE_CODE;
    else process.env.SECANT_CLAUDE_CODE = savedConfiguredClaude;
  });

  const workspace = makeTempDir("secant-test-repair-ws-");
  const { failingTest, baselineCommit } = seedTestRepairWorkspace(workspace);

  const secantHome = makeTempDir("secant-test-repair-home-");
  const wired = wireApplication({
    secantHome,
    launchCwd: workspace,
    harnessAdapter: createClaudeCodeAdapter({
      sessionId: () => TEST_REPAIR_SESSION_ID,
    }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const built = wired.bundleManagement.build(PROOF_BUNDLE, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = wired.catalog
    .listEntries()
    .find((candidate) => candidate.id === "dev.secant.test-repair");
  assert.ok(entry);
  const approved = wired.projectionPort.submit({
    operationId: "approve-test-repair-workspace",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.ok(approved.admitted);

  return {
    wired,
    bundleId: entry.id,
    digest: entry.digest,
    workspace,
    failingTest,
    baselineCommit,
    replayer,
  };
}

async function headless(
  wired: Wiring,
  argv: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: HeadlessIO = {
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    cwd: () => process.cwd(),
  };
  const code = await runHeadless(
    {
      projectionPort: wired.projectionPort,
      bundleManagement: wired.bundleManagement,
    },
    [...argv],
    io,
  );
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

test("the Test Repair Proof Bundle runs headlessly through the approve-commit gate to succeeded (#119)", async (t) => {
  const f = fixture(t);
  const launched = await headless(f.wired, [
    "run",
    "launch",
    f.bundleId,
    "--input",
    `failing-test=${f.failingTest}`,
    "--trust",
    f.digest,
    "--harness",
    "claude-code",
    "--harness-requests",
    "allow",
  ]);
  const launchedRunId = /^Run (\S+)$/m.exec(launched.stdout)?.[1];
  let launchDiagnostic = launched.stderr || launched.stdout;
  if (launched.code !== 2 && launchedRunId !== undefined) {
    const shown = await headless(f.wired, ["run", "show", launchedRunId]);
    launchDiagnostic = `${launchDiagnostic}\n${shown.stdout}${shown.stderr}`;
  }
  assert.equal(launched.code, 2, launchDiagnostic);
  assert.match(launched.stdout, /^State: blocked$/m);
  assert.match(launched.stdout, /run answer .*--continue/);
  const runId = launchedRunId;
  assert.ok(runId, launched.stdout);

  const shown = await headless(f.wired, ["run", "show", runId, "--json"]);
  assert.equal(shown.code, 0, shown.stderr);
  const snapshot = JSON.parse(shown.stdout);
  assert.equal(snapshot.family, "run");
  assert.equal(snapshot.runId, runId);
  assert.equal(snapshot.result.found, true);
  const run = snapshot.result.run;
  assert.equal(run.bundle.id, "dev.secant.test-repair");
  assert.equal(run.state, "blocked");
  assert.equal(run.pendingGate?.gate.shape, "approve-reject");
  assert.equal(run.pendingGate?.gate.stepId, "approve-commit");
  assert.equal(run.effectiveModel, "claude-opus-5[1m]");
  assert.ok(
    run.timeline.some(
      (event: { event: string; detail?: string }) =>
        event.event === "request-answered" &&
        event.detail === "answered by client policy (allow)",
    ),
  );
  assert.ok(
    run.timeline.some(
      (event: { event: string; detail?: string }) =>
        event.event === "request-raised" &&
        /^Edit .*sum\.mjs/.test(event.detail ?? ""),
    ),
  );
  const [editApproval] = f.replayer.bridges();
  assert.equal(editApproval?.tool_name, "Edit");
  assert.equal(editApproval?.behavior, "allow");
  // The seeded test forces the baseline Verdict to `fail`; observing the fix Step
  // and one completed Repeat iteration proves the group was entered. Reaching the
  // authored gate, plus the currently bound Verdict below, proves the next Verdict
  // was `pass` and the Repeat exited immediately.
  assert.equal(
    run.timeline.filter(
      (event: { event: string }) => event.event === "iteration",
    ).length,
    1,
  );
  assert.equal(
    run.progress.find((step: { id: string }) => step.id === "fix")?.status,
    "succeeded",
  );
  const verdict = await headless(f.wired, [
    "run",
    "read",
    `${runId}/test-verdict`,
  ]);
  assert.equal(verdict.code, 0, verdict.stderr);
  assert.equal(verdict.stdout.trim(), "pass");
  assert.equal(git(f.workspace, ["rev-parse", "HEAD"]), f.baselineCommit);
  assert.equal(git(f.workspace, ["status", "--short"]), "M sum.mjs");

  const answered = await headless(f.wired, [
    "run",
    "answer",
    runId,
    "--continue",
    "--json",
  ]);
  assert.equal(answered.code, 0, answered.stderr || answered.stdout);
  const completed = JSON.parse(answered.stdout);
  assert.equal(completed.result.run.state, "succeeded");
  assert.equal(completed.result.run.pendingGate, undefined);

  const commitVerdict = await headless(f.wired, [
    "run",
    "read",
    `${runId}/commit-verdict`,
  ]);
  const commitOutput = await headless(f.wired, [
    "run",
    "read",
    `${runId}/commit-output`,
  ]);
  const commitDiagnostic = `${commitVerdict.stdout}\n${commitOutput.stdout}\n${git(f.workspace, ["status", "--short"])}`;
  assert.notEqual(
    git(f.workspace, ["rev-parse", "HEAD"]),
    f.baselineCommit,
    commitDiagnostic,
  );
  assert.deepEqual(git(f.workspace, ["log", "-2", "--format=%s"]).split("\n"), [
    "Repair failing test",
    "Baseline failing test",
  ]);
  assert.equal(git(f.workspace, ["status", "--short"]), "");
  assert.equal(commitVerdict.code, 0, commitVerdict.stderr);
  assert.equal(commitVerdict.stdout.trim(), "pass");
});
