import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
  type HarnessProfile,
  type PrepareOptions,
} from "../../src/harness/harness.js";
import type { RunView } from "../../src/application/projection-port.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import { RUNTIME_NAME } from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";

// The requested model carried from launch through the Run Store, resume, and the Run
// view (#187): a model requested at launch is pinned immutably beside the selected
// Harness, threaded into prepare identically on launch and resume with no fallback,
// participates in idempotent replay identity, is refused as irrelevant for a
// Command-only Bundle, and stays a separate fact from the observed effective model.
// Driven end to end through the composition wiring against the deterministic fake
// Adapter, so the durable behaviour — not just the pure codecs — is proven.

// One shared fake Git backs every wiring here, so a Run's Store commits made under one
// wiring read back after the same home is reopened in a fresh wiring (the reopen and
// resume cases), mirroring `openFakeRunGroup`.
const sharedGit = createFakeGitProcess();

function fakeProcess(): ProcessAdapter {
  const commands = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commandHandler: (options) => {
      const script = options.args[1] ?? "";
      const status = Number(/process\.exit\((\d+)\)/.exec(script)?.[1] ?? "0");
      return { kind: "exited", status, text: new Uint8Array() };
    },
  });
  return {
    resolveExecutable: (name, options) =>
      commands.resolveExecutable(name, options),
    spawnCommand: (options) => commands.spawnCommand(options),
    spawnOwnedProcess: (options) => commands.spawnOwnedProcess(options),
    spawnCommandSync: (options) => sharedGit.spawnCommandSync(options),
  };
}

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
    steer: { available: false, evidence: "scripted fake" },
    // Selection unavailable ⇒ the fake admits any requested model without validating
    // it, so this suite exercises the carry, not #186's admission list.
    modelSelection: { at: "unavailable", evidence: "scripted fake" },
    modelObservation: { available: true, evidence: "scripted fake" },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "scripted fake",
    },
    skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
    fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
  };
}

/** A single-Turn script that completes; `model` is the observed effective model. */
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

/** A single-Turn script that fails, so the Run rests `failed` and is resumable. */
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
            session: { state: "detached", coordinate: { opaque: "s" } },
          },
        },
      },
    ],
  };
}

/** An Adapter that records the requested model of every `prepare` call. */
function capturing(script: FakeScript): {
  adapter: HarnessAdapter;
  models: (string | undefined)[];
} {
  const inner = createFake(script)();
  const models: (string | undefined)[] = [];
  return {
    models,
    adapter: {
      prepare(options: PrepareOptions) {
        models.push(options.requestedModel);
        return inner.prepare(options);
      },
    },
  };
}

function writeAgentBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-requested-model-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(join(folder, "prompts", "go.md"), "Do the work.\n");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.requested-model",
      version: "1.0.0",
      name: "Requested Model E2E",
      description: "A single agent Step for the requested-model carry.",
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
  return { folder, id: manifest.bundle.id };
}

function writeCommandBundle(): { folder: string; id: string } {
  const folder = makeTempDir("secant-requested-model-cmd-");
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: "dev.secant.requested-model-cmd",
      version: "1.0.0",
      name: "Command Only",
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

/** Wire against a home/workspace with the given Adapter, install the bundle, and
 *  approve the Workspace. Returns the wiring and the installed digest. */
function wire(
  t: TestContext,
  adapter: HarnessAdapter,
  bundle: { folder: string; id: string },
  home: string,
  workspace: string,
): { wired: Wiring; digest: string } {
  const saved = process.env[CLAUDE_CODE_EXECUTABLE_ENV];
  process.env[CLAUDE_CODE_EXECUTABLE_ENV] = process.execPath;
  t.after(() => {
    if (saved === undefined) delete process.env[CLAUDE_CODE_EXECUTABLE_ENV];
    else process.env[CLAUDE_CODE_EXECUTABLE_ENV] = saved;
  });
  const wired = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    process: fakeProcess(),
    harnessAdapter: adapter,
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
  return { wired, digest: entry.digest };
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

test("[requested-model-durability] a requested model is pinned, threaded to prepare, projected beside the effective model, and survives reopen", async (t) => {
  const home = makeTempDir("secant-requested-model-home-");
  const workspace = makeTempDir("secant-requested-model-ws-");
  const captured = capturing(completedScript("observed-sonnet"));
  const { wired, digest } = wire(
    t,
    captured.adapter,
    writeAgentBundle(),
    home,
    workspace,
  );

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.requested-model" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: "requested-opus",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);

  // Durable before the first Attempt: the model is pinned on the record.
  const created = wired.runGroup.readRun(runId);
  assert.ok(created.ok);
  assert.equal(created.run.requestedModel, "requested-opus");

  await awaitSettled(wired.projectionPort, "op-launch");

  // Threaded into prepare on launch.
  assert.deepEqual(captured.models, ["requested-opus"]);

  // Requested and effective stay distinct facts on the view.
  const run = readRun(wired, runId);
  assert.equal(run.state, "succeeded");
  assert.equal(run.requestedModel, "requested-opus");
  assert.equal(run.effectiveModel, "observed-sonnet");
  assert.notEqual(run.requestedModel, run.effectiveModel);

  // Reopened in a fresh process, the requested model reads back unchanged.
  const reopened = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    process: fakeProcess(),
    harnessAdapter: createFake(completedScript("observed-sonnet"))(),
  });
  t.after(() => {
    reopened.runGroup.close();
    reopened.catalog.close();
  });
  const reopenedRecord = reopened.runGroup.readRun(runId);
  assert.ok(reopenedRecord.ok);
  assert.equal(reopenedRecord.run.requestedModel, "requested-opus");
  assert.equal(readRun(reopened, runId).requestedModel, "requested-opus");
});

test("[requested-model-durability] resume reuses the stored model with no fallback", async (t) => {
  const home = makeTempDir("secant-requested-model-home-");
  const workspace = makeTempDir("secant-requested-model-ws-");
  const { wired, digest } = wire(
    t,
    createFake(failedScript())(),
    writeAgentBundle(),
    home,
    workspace,
  );

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.requested-model" },
      launchInputs: {},
      trustDigest: digest,
      harness: "claude-code",
      requestedModel: "requested-opus",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await awaitSettled(wired.projectionPort, "op-launch");
  assert.equal(readRun(wired, runId).state, "failed");

  // Reopen in a fresh process with a capturing Adapter and resume (no model flag).
  const captured = capturing(completedScript("observed-later"));
  const reopened = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    process: fakeProcess(),
    harnessAdapter: captured.adapter,
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
  await awaitSettled(reopened.projectionPort, resume.operationId);

  // Resume reused the durable model, not a default, when it prepared.
  assert.deepEqual(captured.models, ["requested-opus"]);
  const run = readRun(reopened, runId);
  assert.equal(run.state, "succeeded");
  assert.equal(run.requestedModel, "requested-opus");
});

test("a Command-only launch refuses a requested model as irrelevant, leaving no Run", async (t) => {
  const home = makeTempDir("secant-requested-model-home-");
  const workspace = makeTempDir("secant-requested-model-ws-");
  const { wired, digest } = wire(
    t,
    createFake(completedScript("observed"))(),
    writeCommandBundle(),
    home,
    workspace,
  );

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: "dev.secant.requested-model-cmd" },
      launchInputs: {},
      trustDigest: digest,
      requestedModel: "requested-opus",
    },
  });
  assert.equal(admission.admitted, false);
  if (!admission.admitted) {
    assert.equal(admission.problem.code, "requested-model-irrelevant");
    assert.equal(admission.problem.details?.model, "requested-opus");
  }
});

test("the requested model participates in idempotent replay identity", async (t) => {
  const home = makeTempDir("secant-requested-model-home-");
  const workspace = makeTempDir("secant-requested-model-ws-");
  const { wired, digest } = wire(
    t,
    createFake(completedScript("observed"))(),
    writeAgentBundle(),
    home,
    workspace,
  );
  const input = {
    bundle: { id: "dev.secant.requested-model" },
    launchInputs: {},
    trustDigest: digest,
    harness: "claude-code",
    requestedModel: "requested-opus",
  } as const;

  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input,
  });
  assert.ok(admission.admitted, JSON.stringify(admission));

  // Same operation id and same model: an idempotent replay, identical result.
  const replay = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input,
  });
  assert.deepEqual(replay, admission);

  // Same operation id, different model: a conflict, because the model is in the key.
  const conflict = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: { ...input, requestedModel: "requested-different" },
  });
  assert.equal(conflict.admitted, false);
  if (!conflict.admitted) {
    assert.equal(conflict.problem.code, "operation-id-reused");
  }
  await awaitSettled(wired.projectionPort, "op-launch");
});
