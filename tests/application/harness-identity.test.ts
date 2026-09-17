import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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

function profile(): HarnessProfile {
  return {
    harness: "Claude Code",
    executable: "/usr/bin/claude",
    executableVersion: "1.2.3",
    platform: "linux",
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "native-reattach", evidence: "scripted fake" },
    interruption: { mode: "process-only", evidence: "scripted fake" },
    approvals: { available: true, evidence: "scripted fake" },
    clarifications: { available: false, evidence: "scripted fake" },
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
function completedScript(model: string | undefined): FakeScript {
  return {
    profile: profile(),
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

/** Author a single-`agent`-step Bundle (session "s"). */
function writeAgentBundle(): { folder: string; id: string } {
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
        session: "s",
        prompt: { asset: "prompts/go.md" },
      },
    ],
  };
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return { folder, id: manifest.bundle.id };
}

/** Author a single-`command`-step Bundle (a Command-only Run: no Harness). */
function writeCommandBundle(): { folder: string; id: string } {
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
  return { folder, id: manifest.bundle.id };
}

/** Wire the Application against a home, install a Bundle, approve, and launch it to
 *  rest. Returns the wiring, run id, and the shared home so a caller can reopen it. */
async function launch(
  t: TestContext,
  script: FakeScript,
  bundle: { folder: string; id: string },
  home: string,
  workspace: string,
): Promise<{ wired: Wiring; runId: string; run: RunView }> {
  const saved = process.env[CLAUDE_CODE_EXECUTABLE_ENV];
  // A resolvable executable so Preflight's Harness discovery passes; the fake Adapter
  // is what actually runs.
  process.env[CLAUDE_CODE_EXECUTABLE_ENV] = process.execPath;
  t.after(() => {
    if (saved === undefined) delete process.env[CLAUDE_CODE_EXECUTABLE_ENV];
    else process.env[CLAUDE_CODE_EXECUTABLE_ENV] = saved;
  });

  const wired = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    harnessAdapter: createFake(script)(),
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
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await awaitSettled(wired.projectionPort, "op-launch");
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

test("a rested Agent Run projects its Harness identity and effective model (#125)", async (t) => {
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
  assert.deepEqual(run.harness, {
    name: "Claude Code",
    executable: "/usr/bin/claude",
    executableVersion: "1.2.3",
  });
  assert.equal(run.effectiveModel, "fake-sonnet");
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

test("a Command-only Run projects no Harness identity (#125)", async (t) => {
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
