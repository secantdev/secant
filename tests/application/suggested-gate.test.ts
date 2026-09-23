import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessProfile,
} from "../../src/harness/harness.js";
import type {
  RunGateReference,
  RunView,
} from "../../src/application/projection-port.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";

// A free-text Human Gate with authored suggestions (#213, spec #210 stories 13-18),
// driven through the shared Projection Port the TUI and headless clients both submit
// to. The Bundle here is generic — a tracker-choice gate feeding one Agent Step's
// prompt slot — so the scenario proves the Gate contract, never a Matt identity.

// One shared fake Git backs every wiring, so a Run reopened on the same home in a
// fresh wiring (a new process) reads back the Artifacts the first wiring published.
const sharedGit = createFakeGitProcess();

function fakeProcess(): ProcessAdapter {
  const commands = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
  });
  return {
    resolveExecutable: (name, options) =>
      commands.resolveExecutable(name, options),
    spawnCommand: (options) => commands.spawnCommand(options),
    spawnOwnedProcess: (options) => commands.spawnOwnedProcess(options),
    spawnCommandSync: (options) => sharedGit.spawnCommandSync(options),
  };
}

const PROFILE: HarnessProfile = {
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
  modelSelection: { at: "unavailable", evidence: "scripted fake" },
  modelObservation: { available: true, evidence: "scripted fake" },
  recoveryCoordinate: {
    timing: "before-submission",
    evidence: "scripted fake",
  },
  skillDelivery: { mode: "plain-path", evidence: "scripted fake" },
  fileDelivery: { mode: "plain-path", evidence: "scripted fake" },
};

const COMPLETED: FakeScript = {
  profile: PROFILE,
  turns: [
    {
      result: {
        kind: "completed",
        detail: {
          finalContent: "published",
          effectiveModel: { known: false },
          session: { state: "open" },
        },
      },
    },
  ],
};

const FAILED: FakeScript = {
  profile: PROFILE,
  turns: [
    {
      result: {
        kind: "failed",
        detail: {
          failure: {
            phase: "turn",
            category: "native-failure",
            possibleEffects: "possible",
            diagnostics: "tracker unreachable",
          },
          effectiveModel: { known: false },
          session: { state: "detached", coordinate: { opaque: "s" } },
        },
      },
    },
  ],
};

const BUNDLE_ID = "dev.secant.tracker-choice";

/** gate (free-text, suggestions Local/GitHub, produces `tracker`) → publish (an Agent
 *  Step whose prompt carries the `tracker` slot exactly once). */
function writeTrackerBundle(): string {
  const folder = makeTempDir("secant-suggested-gate-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(
    join(folder, "prompts", "publish.md"),
    "Publish the spec to the chosen tracker: {{artifact:tracker}}\n",
  );
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: BUNDLE_ID,
      version: "1.0.0",
      name: "Tracker Choice",
      description: "A suggested free-text gate feeding a later prompt.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/publish.md", kind: "prompt" }],
    routing: [
      {
        id: "choose-tracker",
        kind: "human-gate",
        shape: "free-text",
        message: "Where should the spec and tickets live?",
        suggestions: ["Local", "GitHub"],
        produces: [{ name: "tracker", type: "text" }],
      },
      {
        id: "publish",
        kind: "agent",
        retry: 0,
        session: "s",
        requires: ["tracker"],
        prompt: { asset: "prompts/publish.md" },
      },
    ],
  };
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest));
  return folder;
}

function wire(
  t: TestContext,
  home: string,
  workspace: string,
  script: FakeScript,
): Wiring {
  const wired = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    process: fakeProcess(),
    harnessAdapter: createFake(script)(),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  return wired;
}

function readRun(wired: Wiring, runId: string): RunView {
  const projection = wired.projectionPort.openProjection({
    family: "run",
    runId,
  });
  try {
    const result = projection.snapshot.result;
    assert.ok(result.found, JSON.stringify(result));
    if (!result.found) throw new Error("unreachable");
    return result.run;
  } finally {
    projection.close();
  }
}

/** Every human/managed input the Run sent its Harness Session, in order. */
function sentPrompts(wired: Wiring, run: RunView): string[] {
  const page = run.sessions?.[0]?.transcriptExport;
  assert.ok(page, "the Agent Step recorded a transcript");
  const transcript = wired.projectionPort.readTranscript(page);
  assert.ok(transcript.found);
  if (!transcript.found) throw new Error("unreachable");
  return transcript.entries
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.content);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

interface Launched {
  readonly home: string;
  readonly workspace: string;
  readonly runId: string;
}

/** Install the tracker Bundle, approve the Workspace, and launch to the gate. */
async function launchToGate(
  t: TestContext,
  wired: Wiring,
  home: string,
  workspace: string,
): Promise<Launched> {
  assert.ok(
    wired.bundleManagement.build(writeTrackerBundle(), { noInstall: false }).ok,
  );
  const entry = wired.catalog.listEntries().find((e) => e.id === BUNDLE_ID);
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
      bundle: { id: BUNDLE_ID },
      launchInputs: {},
      trustDigest: entry.digest,
      harness: "claude-code",
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  assert.ok(admission.runId);
  await awaitSettled(wired.projectionPort, admission.operationId);
  return { home, workspace, runId: admission.runId };
}

function setUp(t: TestContext): { home: string; workspace: string } {
  // A resolvable executable so Agent-bearing Preflight passes; the fake Adapter is
  // what actually runs.
  const saved = process.env[CLAUDE_CODE_EXECUTABLE_ENV];
  process.env[CLAUDE_CODE_EXECUTABLE_ENV] = process.execPath;
  t.after(() => {
    if (saved === undefined) delete process.env[CLAUDE_CODE_EXECUTABLE_ENV];
    else process.env[CLAUDE_CODE_EXECUTABLE_ENV] = saved;
  });
  return {
    home: makeTempDir("secant-suggested-gate-home-"),
    workspace: makeTempDir("secant-suggested-gate-ws-"),
  };
}

async function answer(
  wired: Wiring,
  runId: string,
  operationId: string,
  text: string,
): Promise<RunGateReference> {
  const gate = readRun(wired, runId).pendingGate?.gate;
  assert.ok(gate, "the Run rests at the authored gate");
  const admission = wired.projectionPort.submit({
    operationId,
    operation: "answer-human-gate",
    input: { runId, gate, text },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  assert.deepEqual(await awaitSettled(wired.projectionPort, operationId), {
    status: "applied",
  });
  return gate;
}

test("[suggested-gate] the gate projects its suggestions and a suggested answer binds into the later prompt exactly once", async (t) => {
  const { home, workspace } = setUp(t);
  const wired = wire(t, home, workspace, COMPLETED);
  const { runId } = await launchToGate(t, wired, home, workspace);

  const blocked = readRun(wired, runId);
  assert.equal(blocked.state, "blocked");
  assert.deepEqual(blocked.pendingGate, {
    gate: {
      runId,
      stepId: "choose-tracker",
      attemptId: blocked.pendingGate?.gate.attemptId,
      shape: "free-text",
    },
    message: "Where should the spec and tickets live?",
    outputArtifactName: "tracker",
    suggestions: ["Local", "GitHub"],
  });

  await answer(wired, runId, "op-answer", "GitHub");
  const done = readRun(wired, runId);
  assert.equal(done.state, "succeeded");
  assert.equal(done.pendingGate, undefined);
  const prompts = sentPrompts(wired, done);
  assert.equal(prompts.length, 1);
  assert.equal(occurrences(prompts[0]!, "GitHub"), 1);
  assert.match(prompts[0]!, /chosen tracker: GitHub/);
});

test("[suggested-gate] a typed Other answer outside the suggestions is accepted verbatim", async (t) => {
  const { home, workspace } = setUp(t);
  const wired = wire(t, home, workspace, COMPLETED);
  const { runId } = await launchToGate(t, wired, home, workspace);

  await answer(wired, runId, "op-answer", "Linear (via MCP)");
  const done = readRun(wired, runId);
  assert.equal(done.state, "succeeded");
  const tracker = done.outputs.find((output) => output.name === "tracker");
  assert.ok(tracker);
  const read = wired.projectionPort.readResource(tracker.reference);
  assert.ok(read.found);
  if (read.found) assert.equal(read.content, "Linear (via MCP)");
  const prompts = sentPrompts(wired, done);
  assert.equal(occurrences(prompts[0]!, "Linear (via MCP)"), 1);
  assert.equal(occurrences(prompts[0]!, "GitHub"), 0);
  assert.equal(occurrences(prompts[0]!, "Local"), 0);
});

test("[suggested-gate] suggestions survive a reopen, a replayed answer publishes once, and resume re-renders the same answer once", async (t) => {
  const { home, workspace } = setUp(t);
  const first = wire(t, home, workspace, FAILED);
  const { runId } = await launchToGate(t, first, home, workspace);
  first.runGroup.close();
  first.catalog.close();

  // A fresh process reads the same durable gate, suggestions included, and answers it.
  // Its only Turn fails, so the Run rests `failed` after the gate settled.
  const second = wire(t, home, workspace, FAILED);
  assert.deepEqual(readRun(second, runId).pendingGate?.suggestions, [
    "Local",
    "GitHub",
  ]);
  const gate = await answer(second, runId, "op-answer", "Local");
  const failed = readRun(second, runId);
  assert.equal(failed.state, "failed");

  // Replaying the same answer Operation is idempotent: applied, changing nothing.
  const replay = second.projectionPort.submit({
    operationId: "op-answer",
    operation: "answer-human-gate",
    input: { runId, gate, text: "Local" },
  });
  assert.ok(replay.admitted, JSON.stringify(replay));
  assert.deepEqual(await awaitSettled(second.projectionPort, "op-answer"), {
    status: "applied",
  });
  second.runGroup.close();
  second.catalog.close();

  // Resume in a third process: the gate is not asked again, and the retried Turn
  // renders the durable answer into its prompt exactly once.
  const third = wire(t, home, workspace, COMPLETED);
  const resume = third.projectionPort.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  await awaitSettled(third.projectionPort, "op-resume");
  const done = readRun(third, runId);
  assert.equal(done.state, "succeeded");
  assert.equal(done.pendingGate, undefined);
  const prompts = sentPrompts(third, done);
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.equal(occurrences(prompt, "chosen tracker: Local"), 1);
  }
  const owner = third.runGroup.acquireRun(runId);
  assert.ok(owner);
  t.after(() => owner.close());
  assert.equal(owner.gateAnswers().length, 0); // authored gates settle via Attempts
  // The gate settled once and resume skipped it: one Attempt, never re-raised.
  assert.equal(
    owner
      .attemptLog()
      .filter((entry) => entry.attemptId.includes("choose-tracker")).length,
    1,
  );
});
