import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import type { HarnessProfile } from "../../src/harness/harness.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import type {
  ProcessAdapter,
  SpawnResult,
  SpawnSyncResult,
} from "../../src/process/process.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import { makeTempDir } from "../helpers/tempDir.js";

// #149: run the one maintained Test Repair Proof Bundle exactly as a user's
// Bundle, headlessly, through both registered Harnesses. One archive is built
// once; both scenarios install its exact bytes/digest into fresh Workspaces and
// launch with identical routing and launch inputs — only `--harness` differs.
//
// This layer proves the *routing* over deterministic doubles: no real child, no
// recorded Harness replayer. Each Harness is a scripted `createFake` Adapter and
// the Process is a bespoke double (below) — the fix Turn advances, the run-test
// verdict flips fail→pass across it, both selections reach the authored
// approve-commit gate, and answering `--continue` rests the Run succeeded and
// commits. The real git-working-tree evidence (a modified `sum.mjs`, the advanced
// HEAD, the "Repair failing test" commit) is a real-child concern that lives in
// the compiled-binary M3 gate smoke (docs/agents/testing.md), not here.

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROOF_BUNDLE = join(PROJECT_ROOT, "bundles", "test-repair-workflow");
const BUNDLE_ID = "dev.secant.test-repair";

const encoder = new TextEncoder();

function commandExited(status: number, text = ""): SpawnResult {
  return { kind: "exited", status, text: encoder.encode(text) };
}

function syncExited(stdout = "", status = 0): SpawnSyncResult {
  return {
    kind: "exited",
    status,
    stdout: encoder.encode(stdout),
    stderr: new Uint8Array(),
  };
}

// The run-test Step names `bash` on POSIX and `powershell.exe` on Windows (the
// manifest's `platforms.windows` override); the fake must flip either one.
const RUN_TEST_EXECUTABLES = new Set(["bash", "powershell.exe"]);

/** The bespoke Process double for the Test Repair Proof Bundle, process-free: it
 *  resolves the workflow's run-test (`bash`/`powershell.exe`) and `git` commands,
 *  answers the `git-worktree-root` Preflight probe (the Workspace is a worktree
 *  root), flips the run-test verdict fail→pass across the fix Turn (a small counter
 *  reproduces what the real Edit causes: the baseline run fails, the run after the
 *  fix passes), and lets `git commit` succeed. The Run Store's artifact Git
 *  delegates to the in-memory fake Git. */
function fakeTestRepairProcess(): ProcessAdapter {
  const git = createFakeGitProcess();
  let testRuns = 0;
  return createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commandHandler: (options): SpawnResult => {
      if (RUN_TEST_EXECUTABLES.has(options.executable)) {
        testRuns += 1;
        // Baseline run fails; the fix Turn "repairs" the code, so the next run passes.
        return commandExited(testRuns === 1 ? 1 : 0, `run ${testRuns}\n`);
      }
      if (options.executable === "git") return commandExited(0);
      throw new Error(
        `unexpected fake Command executable: ${options.executable}`,
      );
    },
    syncCommandHandler: (options): SpawnSyncResult => {
      // `git -C <workspace> rev-parse --show-toplevel`: the Workspace is the root.
      if (options.args.includes("rev-parse")) {
        return syncExited(`${options.args[1] ?? ""}\n`);
      }
      return git.spawnCommandSync(options);
    },
  });
}

/** A complete Harness profile for a scripted fake Adapter. */
function profile(
  harness: string,
  overrides: Partial<HarnessProfile> = {},
): HarnessProfile {
  return {
    harness,
    executable: `fake-${harness}`,
    executableVersion: "0.0.0-fake",
    platform: "linux",
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "native-reattach", evidence: "scripted fake" },
    interruption: { mode: "process-only", evidence: "scripted fake" },
    approvals: { available: true, evidence: "scripted fake" },
    clarifications: { available: false, evidence: "scripted fake" },
    steer: { available: false, evidence: "scripted fake" },
    modelSelection: { at: "unavailable", evidence: "scripted fake" },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "scripted fake",
    },
    skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
    fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
    ...overrides,
  };
}

/** The Claude Code fix Turn: it surfaces the Edit as an approval Request the
 *  client answers by policy (the permission-bridge seam), then completes. */
function claudeScript(sumPath: string): FakeScript {
  return {
    profile: profile("Claude Code"),
    turns: [
      {
        requests: [
          {
            id: "edit-sum",
            shape: {
              kind: "approval",
              tool: "Edit",
              input: sumPath,
              decisions: ["allow", "deny"],
            },
            awaited: true,
          },
        ],
        result: {
          kind: "completed",
          detail: {
            finalContent: "repaired the failing test",
            effectiveModel: { known: true, model: "claude-opus-5[1m]" },
            session: { state: "open" },
          },
        },
      },
    ],
  };
}

/** The Codex fix Turn: it auto-approves the edit internally, so no approval
 *  Request crosses to the client — the edit is a generic tool-activity event. */
function codexScript(): FakeScript {
  return {
    profile: profile("Codex", {
      steer: { available: true, evidence: "fake native steer" },
    }),
    turns: [
      {
        events: [
          {
            kind: "tool-activity",
            activity: {
              tool: "file-change",
              phase: "completed",
              summary: "applied the repair",
            },
          },
        ],
        result: {
          kind: "completed",
          detail: {
            finalContent: "repaired the failing test",
            effectiveModel: { known: true, model: "gpt-5.6-sol" },
            session: { state: "open" },
          },
        },
      },
    ],
  };
}

/** A generic-seam scenario: the only externally supplied difference between the
 *  two proofs. `evidence` asserts the Harness-specific observable identity that
 *  proves this scenario really drove that Adapter, not the other. */
interface Scenario {
  readonly harness: "claude-code" | "codex";
  readonly effectiveModel: string;
  readonly evidence: (run: RunSnapshot) => void;
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
    evidence: (run) => {
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
  const wired = wireApplication({
    secantHome: home,
    launchCwd: home,
    process: fakeTestRepairProcess(),
  });
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
  // A plain temp Workspace — not the real-git seed helper, which is shared with
  // real-child scenarios. The bespoke Process double answers the git-worktree-root
  // probe, so no real `git init` is needed here. Seed at the canonical path the
  // Application resolves the launch cwd to, so the `file` launch input (an absolute
  // passthrough) names the same directory.
  const workspace = realpathSync.native(makeTempDir("secant-test-repair-ws-"));
  const failingTest = join(workspace, "sum.test.mjs");
  writeFileSync(
    join(workspace, "sum.mjs"),
    "export const sum = (a, b) => a - b;\n",
  );
  writeFileSync(
    failingTest,
    [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'import { sum } from "./sum.mjs";',
      'test("adds two numbers", () => assert.equal(sum(2, 3), 5));',
      "",
    ].join("\n"),
  );

  // Both fake Adapters are wired and both discoveries succeed in every scenario,
  // so the only launch-time difference is `--harness`. Discovery is resolved
  // without a spawn; the scripted fake is what actually runs.
  const secantHome = makeTempDir("secant-test-repair-home-");
  const wired = wireApplication({
    secantHome,
    launchCwd: workspace,
    process: fakeTestRepairProcess(),
    harnessAdapter: createFake(claudeScript(join(workspace, "sum.mjs")))(),
    codexHarnessAdapter: createFake(codexScript())(),
    discoverClaudeCode: () => ({
      kind: "found",
      attempt: {
        source: "path",
        name: "claude",
        description: "PATH name 'claude'",
      },
    }),
    discoverCodex: () => ({
      kind: "found",
      attempt: {
        source: "path",
        name: "codex",
        description: "PATH name 'codex'",
      },
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
    scenario.evidence(run);
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
    // The git-working-tree evidence (modified sum.mjs before the commit) is a
    // real-child concern covered by the compiled-binary M3 gate smoke.

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
    // The advanced HEAD, the "Repair failing test" commit, and the clean tree are
    // real-git evidence covered by the compiled-binary M3 gate smoke, not here.
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
