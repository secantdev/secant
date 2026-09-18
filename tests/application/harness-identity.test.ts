import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessProfile,
} from "../../src/harness/harness.js";
import type { RunView } from "../../src/application/projection-port.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { ensureRuntimeOnPath, RUNTIME_NAME } from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";

ensureRuntimeOnPath();

// The normalized Harness identity a Run projects for its latest Agent-step Attempt
// (#125), driven end to end through the composition wiring against the deterministic
// fake Adapter. Covers a rested Run, the same Run reopened in a fresh process, a Turn
// that observed no effective model (the identity stays, the model is absent), and a
// Command-only Run (no identity at all). The live case is covered by the Run Workbench
// live suite (tests/tui/live-run-workbench.test.tsx).

function profile(harness = "Claude Code"): HarnessProfile {
  return {
    harness,
    executable: "/usr/bin/claude",
    executableVersion: "1.2.3",
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
  };
}

/** A single-Turn script that completes; `model` controls whether the Turn observed an
 *  effective model (missing-observation ⇒ undefined). */
function completedScript(
  model: string | undefined,
  harness = "Claude Code",
): FakeScript {
  return {
    profile: profile(harness),
    turns: [
      {
        result: {
          kind: "completed",
          detail: {
            finalContent: "done",
            effectiveModel:
              model !== undefined ? { known: true, model } : { known: false },
            session: { state: "open" },
          },
        },
      },
    ],
  };
}

function failedScript(): FakeScript {
  return {
    profile: profile(),
    turns: [
      {
        result: {
          kind: "failed",
          detail: {
            failure: {
              phase: "turn",
              category: "native-failure",
              possibleEffects: "possible",
              diagnostics: "scripted failure",
            },
            effectiveModel: { known: false },
            session: {
              state: "detached",
              coordinate: { opaque: "s" },
            },
          },
        },
      },
    ],
  };
}

/** Author a single-`agent`-step Bundle (session "s"). */
function writeAgentBundle(
  selectedHarness: "claude-code" | "codex" = "claude-code",
): {
  folder: string;
  id: string;
  selectedHarness: "claude-code" | "codex";
  expectedPrepareCount: 1;
} {
  const folder = makeTempDir("secant-harness-id-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "go.md"), "Do the work.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.harness-id",
      version: "1.0.0",
      name: "Harness Identity E2E",
      description: "A single agent Step for the Harness-identity projection.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/go.md", kind: "prompt" }],
    routing: [
      {
        id: "work",
        kind: "agent",
        retry: 0,
        session: "s",
        prompt: { asset: "prompts/go.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return {
    folder,
    id: manifest.bundle.id,
    selectedHarness,
    expectedPrepareCount: 1,
  };
}

/** Author a single `interactive-agent` Step for TUI-capable admission. */
function writeInteractiveAgentBundle(): {
  folder: string;
  id: string;
  selectedHarness: "claude-code";
  expectedPrepareCount: 1;
  supportsInteractiveTurns: true;
} {
  const folder = makeTempDir("secant-selected-harness-interactive-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "talk.md"), "Work with me.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.selected-harness-interactive",
      version: "1.0.0",
      name: "Selected Harness Interactive",
      description: "An Interactive-agent Run for selected-Harness admission.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/talk.md", kind: "prompt" }],
    routing: [
      {
        id: "talk",
        kind: "interactive-agent",
        session: "s",
        prompt: { asset: "prompts/talk.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return {
    folder,
    id: manifest.bundle.id,
    selectedHarness: "claude-code",
    expectedPrepareCount: 1,
    supportsInteractiveTurns: true,
  };
}

/** Author an Agent Step inside a Repeat group whose baseline Verdict already
 *  passes. The Turn never runs, but static routing still requires a Harness. */
function writeNestedAgentBundle(): {
  folder: string;
  id: string;
  selectedHarness: "claude-code";
  expectedPrepareCount: 1;
} {
  const folder = makeTempDir("secant-selected-harness-nested-agent-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "go.md"), "Do the work.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.selected-harness-nested-agent",
      version: "1.0.0",
      name: "Selected Harness Nested Agent",
      description: "An Agent-bearing Repeat group for Harness selection.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/go.md", kind: "prompt" }],
    routing: [
      {
        id: "baseline",
        kind: "command",
        produces: [{ name: "passing", type: "verdict" }],
        command: {
          executable: RUNTIME_NAME,
          arguments: ["-e", "process.exit(0)"],
        },
      },
      {
        repeat: {
          until: "passing",
          reviewCheckpoint: { interval: 1, message: "Review the work." },
          steps: [
            {
              id: "work",
              kind: "agent",
              session: "s",
              prompt: { asset: "prompts/go.md" },
            },
          ],
        },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return {
    folder,
    id: manifest.bundle.id,
    selectedHarness: "claude-code",
    expectedPrepareCount: 1,
  };
}

/** Author a single-`command`-step Bundle (a Command-only Run: no Harness). */
function writeCommandBundle(): {
  folder: string;
  id: string;
  expectedPrepareCount: 0;
  isolateHarnessDiscovery: true;
} {
  const folder = makeTempDir("secant-harness-id-cmd-");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.harness-id-cmd",
      version: "1.0.0",
      name: "Command Only E2E",
      description: "A single command Step, no Harness.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [],
    routing: [
      {
        id: "run",
        kind: "command",
        command: {
          executable: RUNTIME_NAME,
          arguments: ["-e", "process.exit(0)"],
        },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return {
    folder,
    id: manifest.bundle.id,
    expectedPrepareCount: 0,
    isolateHarnessDiscovery: true,
  };
}

/** Wire the Application against a home, install a Bundle, approve, and launch it to
 *  rest. Returns the wiring, run id, and the shared home so a caller can reopen it. */
async function launch(
  t: TestContext,
  script: FakeScript,
  bundle: {
    folder: string;
    id: string;
    selectedHarness?: "claude-code" | "codex";
    expectedPrepareCount: 0 | 1;
    isolateHarnessDiscovery?: true;
    supportsInteractiveTurns?: true;
  },
  home: string,
  workspace: string,
): Promise<{ wired: Wiring; runId: string; run: RunView }> {
  const saved = process.env[CLAUDE_CODE_EXECUTABLE_ENV];
  const savedPath = process.env.PATH;
  let environmentRestored = false;
  const restoreEnvironment = (): void => {
    if (environmentRestored) return;
    environmentRestored = true;
    if (saved === undefined) delete process.env[CLAUDE_CODE_EXECUTABLE_ENV];
    else process.env[CLAUDE_CODE_EXECUTABLE_ENV] = saved;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  };
  if (bundle.isolateHarnessDiscovery === true) {
    // Keep the Command executable resolvable while making both Claude discovery
    // sources fail. If Command-only Preflight accidentally discovers a Harness,
    // admission is refused instead of letting this test pass silently.
    const isolatedBin = makeTempDir("secant-command-only-path-");
    const isolatedRuntime = join(isolatedBin, RUNTIME_NAME);
    copyFileSync(process.execPath, isolatedRuntime);
    chmodSync(isolatedRuntime, 0o755);
    process.env.PATH = isolatedBin;
    process.env[CLAUDE_CODE_EXECUTABLE_ENV] = join(
      isolatedBin,
      "missing-claude",
    );
  } else {
    // A resolvable executable so Agent-bearing Preflight passes; the fake Adapter
    // is what actually runs.
    process.env[CLAUDE_CODE_EXECUTABLE_ENV] = process.execPath;
  }
  t.after(restoreEnvironment);

  const adapter = createFake(script)();
  let prepareCount = 0;
  const countedAdapter = {
    prepare(options: Parameters<typeof adapter.prepare>[0]) {
      prepareCount++;
      return adapter.prepare(options);
    },
  };
  const wired =
    bundle.selectedHarness === "codex"
      ? wireApplication({
          secantHome: home,
          launchCwd: workspace,
          codexHarnessAdapter: countedAdapter,
          discoverCodex: () => ({
            kind: "found",
            attempt: {
              source: "path",
              name: "codex",
              description: "PATH name 'codex'",
            },
          }),
          supportsInteractiveTurns: bundle.supportsInteractiveTurns,
        })
      : wireApplication({
          secantHome: home,
          launchCwd: workspace,
          harnessAdapter: countedAdapter,
          supportsInteractiveTurns: bundle.supportsInteractiveTurns,
        });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  assert.ok(
    wired.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
  );
  const entry = wired.catalog.listEntries().find((e) => e.id === bundle.id);
  assert.ok(entry);

  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: entry.digest,
      harness: bundle.selectedHarness,
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  // The isolated PATH is needed only during synchronous Preflight. Restore it
  // before awaiting so concurrent test files and Command execution see the host.
  if (bundle.isolateHarnessDiscovery === true) restoreEnvironment();

  // Async execution has yielded at Harness preparation when submit returns. The
  // semantic selection must already be durable before an Attempt can start.
  const created = wired.runGroup.readRun(runId);
  assert.ok(created.ok);
  assert.equal(created.run.selectedHarness, bundle.selectedHarness);
  const replay = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: entry.digest,
      harness: bundle.selectedHarness,
    },
  });
  assert.deepEqual(replay, admission);
  const replayed = wired.runGroup.readRun(runId);
  assert.ok(replayed.ok);
  assert.equal(replayed.run.selectedHarness, bundle.selectedHarness);

  await awaitSettled(wired.projectionPort, "op-launch");
  assert.equal(prepareCount, bundle.expectedPrepareCount);
  return { wired, runId, run: readRun(wired, runId) };
}

function readRun(wired: Wiring, runId: string): RunView {
  const opened = wired.projectionPort.openProjection({ family: "run", runId });
  try {
    assert.ok(opened.snapshot.result.found, JSON.stringify(opened.snapshot));
    if (!opened.snapshot.result.found) throw new Error("unreachable");
    return opened.snapshot.result.run;
  } finally {
    opened.close();
  }
}

test("[new-run-harness-selection] a new Agent Run pins Claude Code separately from observed Attempt evidence", async (t) => {
  const home = makeTempDir("secant-harness-id-home-");
  const { run } = await launch(
    t,
    completedScript("fake-sonnet"),
    writeAgentBundle(),
    home,
    makeTempDir("secant-harness-id-ws-"),
  );
  assert.equal(run.state, "succeeded");
  assert.deepEqual(run.harness, {
    name: "Claude Code",
    executable: "/usr/bin/claude",
    executableVersion: "1.2.3",
  });
  assert.equal(run.effectiveModel, "fake-sonnet");
});

test("[both-client-harness-selection] a Codex selection prepares only the Codex registry entry", async (t) => {
  const home = makeTempDir("secant-harness-id-home-");
  const { run, runId, wired } = await launch(
    t,
    completedScript("fake-codex", "Codex"),
    writeAgentBundle("codex"),
    home,
    makeTempDir("secant-harness-id-ws-"),
  );
  const record = wired.runGroup.readRun(runId);
  assert.ok(record.ok);
  assert.equal(record.run.selectedHarness, "codex");
  assert.equal(run.state, "succeeded");
  assert.deepEqual(run.harness, {
    name: "Codex",
    executable: "/usr/bin/claude",
    executableVersion: "1.2.3",
  });
});

test("[both-client-harness-selection] selected Harness authentication and protocol failures halt before content; resume reuses the durable id", async (t) => {
  const home = makeTempDir("secant-harness-failure-home-");
  const workspace = makeTempDir("secant-harness-failure-ws-");
  const prepareCause = new Error("redacted native preparation cause");
  let prepareCount = 0;
  const wired = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    codexHarnessAdapter: {
      async prepare() {
        prepareCount++;
        const authentication = prepareCount === 1;
        return {
          ok: false,
          failure: {
            phase: "prepare",
            category: authentication
              ? "authentication"
              : "protocol-incompatible",
            possibleEffects: authentication ? "possible" : "committed",
            partialOutput: "qualification stopped before a Turn",
            nativeCode: "not-ready",
            retryEvidence: "safe after remediation",
            diagnostics: authentication
              ? "Authentication required for Codex."
              : "The installed protocol does not match the pinned subset.",
            cause: prepareCause,
          },
        };
      },
    },
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
  const bundle = writeAgentBundle("codex");
  assert.ok(
    wired.bundleManagement.build(bundle.folder, { noInstall: false }).ok,
  );
  const entry = wired.catalog.listEntries().find((candidate) => {
    return candidate.id === bundle.id;
  });
  assert.ok(entry);
  const approval = wired.projectionPort.submit({
    operationId: "op-approve-prepare-failure",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.ok(approval.admitted);
  const admission = wired.projectionPort.submit({
    operationId: "op-prepare-failure",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: entry.digest,
      harness: "codex",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  assert.ok(admission.runId);
  const outcome = await awaitSettled(
    wired.projectionPort,
    admission.operationId,
  );
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "selected-harness-unavailable");
    assert.equal(outcome.problem.details?.harness, "codex");
    assert.equal(outcome.problem.details?.category, "authentication");
    assert.equal(outcome.problem.details?.nativeCode, "not-ready");
    assert.equal(
      outcome.problem.details?.partialOutput,
      "qualification stopped before a Turn",
    );
    assert.equal(
      outcome.problem.details?.retryEvidence,
      "safe after remediation",
    );
    assert.equal(outcome.problem.details?.harnessPossibleEffects, "possible");
    assert.equal(outcome.problem.possibleEffects, "unknown");
    assert.match(outcome.problem.explanation, /Authentication required/);
    assert.equal(outcome.problem.cause, prepareCause);
    assert.match(
      outcome.problem.remediation,
      /log in separately through Codex/i,
    );
  }
  const haltedAfterAuthentication = readRun(wired, admission.runId);
  assert.equal(haltedAfterAuthentication.state, "halted");
  assert.equal(
    haltedAfterAuthentication.problem?.code,
    "selected-harness-unavailable",
  );
  const resume = wired.projectionPort.submit({
    operationId: "op-resume-protocol-failure",
    operation: "resume-run",
    input: { runId: admission.runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  const resumeOutcome = await awaitSettled(
    wired.projectionPort,
    resume.operationId,
  );
  assert.equal(resumeOutcome.status, "not-applied");
  if (resumeOutcome.status === "not-applied") {
    assert.equal(resumeOutcome.problem.code, "selected-harness-unavailable");
    assert.equal(
      resumeOutcome.problem.details?.category,
      "protocol-incompatible",
    );
    assert.equal(resumeOutcome.problem.details?.harness, "codex");
    assert.equal(
      resumeOutcome.problem.details?.harnessPossibleEffects,
      "committed",
    );
    assert.equal(resumeOutcome.problem.possibleEffects, "partial");
    assert.match(resumeOutcome.problem.remediation, /installed Codex version/i);
  }
  assert.equal(prepareCount, 2);
  const haltedAfterProtocol = readRun(wired, admission.runId);
  assert.equal(haltedAfterProtocol.state, "halted");
  assert.equal(
    haltedAfterProtocol.problem?.details?.category,
    "protocol-incompatible",
  );
  const owner = wired.runGroup.acquireRun(admission.runId);
  assert.ok(owner);
  assert.deepEqual(owner.turns(), []);
  owner.close();
});

test("[new-run-harness-selection] a new Interactive-agent Run pins Claude Code before its first Turn", async (t) => {
  const home = makeTempDir("secant-harness-id-home-");
  const { run } = await launch(
    t,
    { profile: profile(), turns: [] },
    writeInteractiveAgentBundle(),
    home,
    makeTempDir("secant-harness-id-ws-"),
  );
  assert.equal(run.state, "blocked");
  assert.equal(run.harness, undefined);
  assert.equal(run.effectiveModel, undefined);
});

test("[new-run-harness-selection] an Agent nested in a Repeat group pins Claude Code", async (t) => {
  const home = makeTempDir("secant-harness-id-home-");
  const { run } = await launch(
    t,
    { profile: profile(), turns: [] },
    writeNestedAgentBundle(),
    home,
    makeTempDir("secant-harness-id-ws-"),
  );
  assert.equal(run.state, "succeeded");
  assert.equal(run.harness, undefined);
  assert.equal(run.effectiveModel, undefined);
});

test("the Harness identity is identical after the Run is reopened (#125)", async (t) => {
  const home = makeTempDir("secant-harness-id-home-");
  const workspace = makeTempDir("secant-harness-id-ws-");
  const { runId } = await launch(
    t,
    completedScript("fake-sonnet"),
    writeAgentBundle(),
    home,
    workspace,
  );

  // Reopen the same home and Workspace in a fresh wiring (a new process): the durable
  // identity and the authoritatively-observed effective model read back unchanged.
  const reopened = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    harnessAdapter: createFake(completedScript("fake-sonnet"))(),
  });
  t.after(() => {
    reopened.runGroup.close();
    reopened.catalog.close();
  });
  const run = readRun(reopened, runId);
  const reopenedRecord = reopened.runGroup.readRun(runId);
  assert.ok(reopenedRecord.ok);
  assert.equal(reopenedRecord.run.selectedHarness, "claude-code");
  assert.deepEqual(run.harness, {
    name: "Claude Code",
    executable: "/usr/bin/claude",
    executableVersion: "1.2.3",
  });
  assert.equal(run.effectiveModel, "fake-sonnet");
});

test("a reopened Run's steer Offer uses the recorded profile evidence (#134 A12)", async (t) => {
  const home = makeTempDir("secant-harness-id-home-");
  const workspace = makeTempDir("secant-harness-id-ws-");
  const { runId } = await launch(
    t,
    failedScript(),
    writeAgentBundle(),
    home,
    workspace,
  );

  const resumedScript: FakeScript = {
    profile: profile(),
    turns: [
      {
        requests: [
          {
            id: "hold-resumed-turn",
            shape: {
              kind: "approval",
              tool: "Edit",
              input: "edit after reopen",
              decisions: ["allow", "deny"],
            },
            awaited: true,
          },
        ],
        result: {
          kind: "completed",
          detail: {
            finalContent: "done",
            effectiveModel: { known: false },
            session: { state: "open" },
          },
        },
      },
    ],
  };
  const reopened = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    harnessAdapter: createFake(resumedScript)(),
  });
  t.after(() => {
    reopened.runGroup.close();
    reopened.catalog.close();
  });
  const resume = reopened.projectionPort.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  const opened = reopened.projectionPort.openProjection({
    family: "run",
    runId,
  });
  let requestGeneration: number | undefined;
  for await (const update of opened.updates) {
    if (update.kind === "live" && update.overlay.outstanding.length > 0) {
      requestGeneration = update.overlay.generation;
      break;
    }
  }
  opened.close();
  assert.ok(requestGeneration !== undefined);

  const steer = readRun(reopened, runId).actionOffers.find(
    (offer) => offer.action === "steer-turn",
  );
  assert.ok(steer);
  if (steer?.action === "steer-turn") {
    assert.equal(steer.reason, profile().steer.evidence);
  }

  const answer = reopened.projectionPort.submit({
    operationId: "answer-resumed-request",
    operation: "answer-harness-request",
    input: {
      runId,
      requestId: "hold-resumed-turn",
      generation: requestGeneration,
      decision: "allow",
      by: "human",
    },
  });
  assert.ok(answer.admitted);
  await awaitSettled(reopened.projectionPort, answer.operationId);
  await awaitSettled(reopened.projectionPort, resume.operationId);
});

test("a Turn that observed no model keeps the Harness identity but omits the model (#125)", async (t) => {
  const home = makeTempDir("secant-harness-id-home-");
  const { run } = await launch(
    t,
    completedScript(undefined),
    writeAgentBundle(),
    home,
    makeTempDir("secant-harness-id-ws-"),
  );
  assert.equal(run.state, "succeeded");
  assert.deepEqual(run.harness, {
    name: "Claude Code",
    executable: "/usr/bin/claude",
    executableVersion: "1.2.3",
  });
  // No value is invented for an unobserved model.
  assert.equal(run.effectiveModel, undefined);
});

test("[new-run-harness-selection] a Command-only Run selects, discovers, and prepares no Harness", async (t) => {
  const home = makeTempDir("secant-harness-id-home-");
  const { run } = await launch(
    t,
    completedScript("fake-sonnet"),
    writeCommandBundle(),
    home,
    makeTempDir("secant-harness-id-ws-"),
  );
  assert.equal(run.state, "succeeded");
  assert.equal(run.harness, undefined);
  assert.equal(run.effectiveModel, undefined);
});
