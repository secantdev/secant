import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  createClaudeCodeAdapter,
  createCodexAdapter,
} from "../../src/harness/harness.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import {
  installReplayer,
  type InstalledReplayer,
} from "../harness/replayer.js";
import { installCodexReplayer } from "../harness/codex-replayer.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { seedTestRepairWorkspace } from "../helpers/testRepairWorkspace.js";

// #149: run the one maintained Test Repair Proof Bundle exactly as a user's
// Bundle, headlessly, through both registered Harnesses. One archive is built
// once; both scenarios install its exact bytes/digest into fresh Workspaces and
// launch with identical routing and launch inputs — only `--harness` differs.
// Both recorded replayers repair the test, reach the authored approve-commit
// gate with no earlier commit, then succeed and commit after approval. The
// single-Harness #119 assertion this generalizes stays here as one scenario.

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROOF_BUNDLE = join(PROJECT_ROOT, "bundles", "test-repair-workflow");
const CLAUDE_TEST_REPAIR_FIXTURE = join(
  PROJECT_ROOT,
  "tests",
  "harness",
  "fixtures",
  "claude-code",
  "test-repair",
);
const TEST_REPAIR_SESSION_ID = "77777777-7777-4777-8777-777777777777";
const CLAUDE_REPLAYER_VERSION = "2.1.273 (Claude Code)";
const BUNDLE_ID = "dev.secant.test-repair";

/** A generic-seam scenario: the only externally supplied difference between the
 *  two proofs. `evidence` asserts the Harness-specific observable identity that
 *  proves this scenario really drove that Adapter, not the other. */
interface Scenario {
  readonly harness: "claude-code" | "codex";
  readonly effectiveModel: string;
  readonly evidence: (run: RunSnapshot, f: Fixture) => void;
}

interface RunTimelineEvent {
  readonly event: string;
  readonly detail?: string;
}
interface RunSnapshot {
  readonly bundle: { readonly id: string };
  readonly state: string;
  readonly effectiveModel: string;
  readonly pendingGate?: {
    readonly gate: { readonly shape: string; readonly stepId: string };
  };
  readonly timeline: readonly RunTimelineEvent[];
  readonly progress: readonly {
    readonly id: string;
    readonly status: string;
  }[];
}

const SCENARIOS: readonly Scenario[] = [
  {
    harness: "claude-code",
    effectiveModel: "claude-opus-5[1m]",
    evidence: (run, f) => {
      // Claude Code surfaces the Edit as an approval request the client answers
      // by policy — the permission-bridge seam.
      assert.ok(
        run.timeline.some(
          (event) =>
            event.event === "request-answered" &&
            event.detail === "answered by client policy (allow)",
        ),
        JSON.stringify(run.timeline),
      );
      assert.ok(
        run.timeline.some(
          (event) =>
            event.event === "request-raised" &&
            /^Edit .*sum\.mjs/.test(event.detail ?? ""),
        ),
        JSON.stringify(run.timeline),
      );
      const [editApproval] = f.claudeReplayer.bridges();
      assert.equal(editApproval?.tool_name, "Edit");
      assert.equal(editApproval?.behavior, "allow");
    },
  },
  {
    harness: "codex",
    effectiveModel: "gpt-5.6-sol",
    evidence: (run) => {
      // Codex auto-approves the edit internally, so no approval request crosses
      // to the client; the edit is observable as a generic tool-activity event.
      assert.ok(
        run.timeline.some(
          (event) =>
            event.event === "tool-activity" &&
            event.detail === "file-change completed",
        ),
        JSON.stringify(run.timeline),
      );
      assert.ok(
        !run.timeline.some((event) => event.event === "request-raised"),
        JSON.stringify(run.timeline),
      );
    },
  },
];

interface Fixture {
  readonly wired: Wiring;
  readonly digest: string;
  readonly workspace: string;
  readonly failingTest: string;
  readonly baselineCommit: string;
  readonly claudeReplayer: InstalledReplayer;
}

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();
}

// The one exact `.wfb` archive both scenarios reuse (AC1). Built once with
// --no-install; every scenario installs these same bytes and re-checks the digest.
let sharedArchive:
  { readonly path: string; readonly digest: string } | undefined;
function proofArchive(): { readonly path: string; readonly digest: string } {
  if (sharedArchive !== undefined) return sharedArchive;
  const home = makeTempDir("secant-two-harness-build-home-");
  const output = join(
    makeTempDir("secant-two-harness-archive-"),
    "test-repair.wfb",
  );
  const wired = wireApplication({ secantHome: home, launchCwd: home });
  try {
    const built = wired.bundleManagement.build(PROOF_BUNDLE, {
      noInstall: true,
      output,
    });
    assert.ok(built.ok, JSON.stringify(built));
    sharedArchive = { path: output, digest: built.report.digest };
    return sharedArchive;
  } finally {
    wired.runGroup.close();
    wired.catalog.close();
  }
}

function fixture(t: TestContext, scenario: Scenario): Fixture {
  // Both replayers are installed and both Adapters wired in every scenario, so
  // the only launch-time difference is `--harness`. Claude discovers on PATH;
  // Codex discovers on the explicit path handed to its Adapter (captured before
  // the PATH mutation so its shebang runtime stays resolvable).
  const claudeReplayer = installReplayer(
    CLAUDE_REPLAYER_VERSION,
    CLAUDE_TEST_REPAIR_FIXTURE,
  );
  const codexReplayer = installCodexReplayer("test-repair");
  const savedPath = process.env.PATH;
  const savedConfiguredClaude = process.env.SECANT_CLAUDE_CODE;
  process.env.PATH = claudeReplayer.path;
  delete process.env.SECANT_CLAUDE_CODE;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedConfiguredClaude === undefined)
      delete process.env.SECANT_CLAUDE_CODE;
    else process.env.SECANT_CLAUDE_CODE = savedConfiguredClaude;
  });

  // Seed at the canonical path the Application resolves the launch cwd to, so the
  // `file` launch input (an absolute passthrough) names the same directory the
  // selected Adapter is prepared against. Codex's replayer strict-redacts the
  // Workspace path in the rendered prompt against that cwd; a `/var` vs
  // `/private/var` desync would lose the Turn.
  const workspace = realpathSync.native(makeTempDir("secant-test-repair-ws-"));
  const { failingTest, baselineCommit } = seedTestRepairWorkspace(workspace);

  const secantHome = makeTempDir("secant-test-repair-home-");
  const wired = wireApplication({
    secantHome,
    launchCwd: workspace,
    harnessAdapter: createClaudeCodeAdapter({
      sessionId: () => TEST_REPAIR_SESSION_ID,
    }),
    codexHarnessAdapter: createCodexAdapter({
      path: codexReplayer.path,
      env: {},
    }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const archive = proofArchive();
  const installed = wired.bundleManagement.install(archive.path);
  assert.ok(installed.ok, JSON.stringify(installed));
  // The exact same archive bytes and digest are installed for both scenarios.
  assert.equal(installed.report.digest, archive.digest);
  const entry = wired.catalog
    .listEntries()
    .find((candidate) => candidate.id === BUNDLE_ID);
  assert.ok(entry);
  assert.equal(entry.digest, archive.digest);
  const approved = wired.projectionPort.submit({
    operationId: `approve-test-repair-workspace-${scenario.harness}`,
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.ok(approved.admitted);

  return {
    wired,
    digest: entry.digest,
    workspace,
    failingTest,
    baselineCommit,
    claudeReplayer,
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

for (const scenario of SCENARIOS) {
  test(`the Test Repair Proof Bundle runs headlessly through ${scenario.harness} to the approve-commit gate and succeeds after approval (#149)`, async (t) => {
    const f = fixture(t, scenario);
    const launched = await headless(f.wired, [
      "run",
      "launch",
      BUNDLE_ID,
      "--input",
      `failing-test=${f.failingTest}`,
      "--trust",
      f.digest,
      "--harness",
      scenario.harness,
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
    const run: RunSnapshot = snapshot.result.run;
    assert.equal(run.bundle.id, BUNDLE_ID);
    assert.equal(run.state, "blocked");
    assert.equal(run.pendingGate?.gate.shape, "approve-reject");
    assert.equal(run.pendingGate?.gate.stepId, "approve-commit");
    // The generic Harness Seam yields a per-Attempt observed model; the two
    // scenarios report different models, proving different Adapters ran.
    assert.equal(run.effectiveModel, scenario.effectiveModel);
    scenario.evidence(run, f);
    // The seeded test forces the baseline Verdict to `fail`; observing the fix
    // Step and one completed Repeat iteration proves the group was entered.
    // Reaching the authored gate, plus the bound Verdict below, proves the next
    // Verdict was `pass` and the Repeat exited immediately.
    assert.equal(
      run.timeline.filter((event) => event.event === "iteration").length,
      1,
    );
    assert.equal(
      run.progress.find((step) => step.id === "fix")?.status,
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
    assert.deepEqual(
      git(f.workspace, ["log", "-2", "--format=%s"]).split("\n"),
      ["Repair failing test", "Baseline failing test"],
    );
    assert.equal(git(f.workspace, ["status", "--short"]), "");
    assert.equal(commitVerdict.code, 0, commitVerdict.stderr);
    assert.equal(commitVerdict.stdout.trim(), "pass");
  });
}

// AC5: the two-Harness genericity proof is falsifiable only if no Secant source
// path chooses behavior by the Bundle's identity or Asset paths. Scan target
// source for the maintained Proof Bundle's id, name, and declared asset paths.
test("no Secant source branches on the Proof Bundle id, name, or Asset path (#149)", () => {
  const manifest = JSON.parse(
    readFileSync(join(PROOF_BUNDLE, "manifest.json"), "utf8"),
  ) as {
    bundle: { id: string; name: string };
    assets: readonly { path: string }[];
  };
  const forbidden = [
    manifest.bundle.id,
    manifest.bundle.name,
    ...manifest.assets.map((asset) => asset.path),
  ];
  const offenders: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // Include the TUI presentation Module's `.tsx` source, not only `.ts`.
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      const text = readFileSync(full, "utf8");
      for (const needle of forbidden) {
        if (text.includes(needle)) offenders.push(`${full}: ${needle}`);
      }
    }
  };
  walk(join(PROJECT_ROOT, "src"));
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
