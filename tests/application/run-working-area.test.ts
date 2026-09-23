import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  type HarnessAdapter,
  type HarnessProfile,
  type PrepareOptions,
} from "../../src/harness/harness.js";
import type { OperationOutcome } from "../../src/application/projection-port.js";
import type { ProcessAdapter } from "../../src/process/process.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";

// #214 through the Projection Port: an Agent Step's prompt names the Run's exact
// working area, Harness preparation is granted that directory and nothing
// covering the private Run Store, a Local planning file the agent writes there
// survives resume, deleting the Run removes it, and an unusable area is a typed
// Problem that halts the Run before any Turn.

const BUNDLE_ID = "dev.secant.working-area";

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

function script(kind: "completed" | "failed"): FakeScript {
  return {
    profile: profile(),
    turns: [
      {
        result:
          kind === "completed"
            ? {
                kind: "completed",
                detail: {
                  finalContent: "done",
                  effectiveModel: { known: false },
                  session: { state: "open" },
                },
              }
            : {
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

/** An Adapter standing in for an agent: it records every prepare's writable
 *  directory and every Turn's input, and writes a Local planning file into the
 *  granted directory as its Turn starts. */
function planningAgent(kind: "completed" | "failed", file: string) {
  const inner = createFake(script(kind))();
  const granted: (string | undefined)[] = [];
  const inputs: string[] = [];
  const adapter: HarnessAdapter = {
    async prepare(options: PrepareOptions) {
      granted.push(options.writableDirectory);
      const prepared = await inner.prepare(options);
      if (!prepared.ok) return prepared;
      const harness = prepared.harness;
      return {
        ok: true,
        harness: {
          profile: harness.profile,
          startTurn(request) {
            inputs.push(request.input.text);
            if (options.writableDirectory !== undefined) {
              writeFileSync(join(options.writableDirectory, file), file);
            }
            return harness.startTurn(request);
          },
          close: () => harness.close(),
        },
      };
    },
  };
  return { adapter, granted, inputs };
}

function writeBundle(): string {
  const folder = makeTempDir("secant-working-area-bundle-");
  mkdirSync(join(folder, "prompts"), { recursive: true });
  writeFileSync(
    join(folder, "prompts", "plan.md"),
    "Write the spec into {{run:working-area}} and nowhere else.\n",
  );
  const manifest = {
    formatVersion: 1,
    bundle: {
      id: BUNDLE_ID,
      version: "1.0.0",
      name: "Working Area",
      description: "One planning agent Step writing Local files.",
    },
    platforms: ["windows", "macos", "linux"],
    inputs: {},
    assets: [{ path: "prompts/plan.md", kind: "prompt" }],
    routing: [
      {
        id: "plan",
        kind: "agent",
        retry: 0,
        session: "planning",
        prompt: { asset: "prompts/plan.md" },
      },
    ],
  };
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest));
  return folder;
}

function wire(
  t: TestContext,
  adapter: HarnessAdapter,
  home: string,
  workspace: string,
  process: ProcessAdapter,
): Wiring {
  const saved = globalThis.process.env[CLAUDE_CODE_EXECUTABLE_ENV];
  globalThis.process.env[CLAUDE_CODE_EXECUTABLE_ENV] =
    globalThis.process.execPath;
  t.after(() => {
    if (saved === undefined) {
      delete globalThis.process.env[CLAUDE_CODE_EXECUTABLE_ENV];
    } else {
      globalThis.process.env[CLAUDE_CODE_EXECUTABLE_ENV] = saved;
    }
  });
  const wired = wireApplication({
    secantHome: home,
    launchCwd: workspace,
    process,
    harnessAdapter: adapter,
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  return wired;
}

async function launch(
  t: TestContext,
  agent: ReturnType<typeof planningAgent>,
): Promise<{
  wired: Wiring;
  runId: string;
  home: string;
  workspace: string;
  process: ProcessAdapter;
}> {
  const home = makeTempDir("secant-working-area-home-");
  const workspace = makeTempDir("secant-working-area-ws-");
  const process = createFakeBundleProcess();
  const wired = wire(t, agent.adapter, home, workspace, process);
  assert.ok(
    wired.bundleManagement.build(writeBundle(), { noInstall: false }).ok,
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
  await awaitSettled(wired.projectionPort, "op-launch");
  return { wired, runId: admission.runId, home, workspace, process };
}

function runState(wired: Wiring, runId: string): string {
  const read = wired.runGroup.readRun(runId);
  assert.ok(read.ok);
  return read.run.state;
}

function privateStoreFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.name === "run.db" || entry.name === "artifacts.git") {
      return [path];
    }
    return entry.isDirectory() ? privateStoreFiles(path) : [];
  });
}

test("[run-working-area] the agent is told and granted exactly the Run's working area, which survives resume and dies with the Run", async (t) => {
  const first = planningAgent("failed", "spec.md");
  const { wired, runId, home, workspace, process } = await launch(t, first);
  assert.equal(runState(wired, runId), "failed");

  // Preparation was granted one directory, and the prompt names it exactly.
  assert.equal(first.granted.length, 1);
  const area = first.granted[0];
  assert.ok(area !== undefined);
  assert.equal(first.inputs.length, 1);
  assert.ok(
    first.inputs[0].includes(`Write the spec into ${area} and nowhere else.`),
    first.inputs[0],
  );
  // The grant covers no private Run Store file and is not the Workspace.
  const privateFiles = privateStoreFiles(home);
  assert.ok(privateFiles.length > 0);
  for (const path of privateFiles) {
    assert.ok(relative(area, path).startsWith(".."), path);
  }
  assert.ok(relative(workspace, area).startsWith(".."));
  assert.equal(readFileSync(join(area, "spec.md"), "utf8"), "spec.md");
  assert.deepEqual(readdirSync(workspace), []);

  // Reopened and resumed, the same area is granted with the file intact.
  const second = planningAgent("completed", "ticket-1.md");
  const reopened = wire(t, second.adapter, home, workspace, process);
  const resume = reopened.projectionPort.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  await awaitSettled(reopened.projectionPort, resume.operationId);
  assert.equal(runState(reopened, runId), "succeeded");
  assert.deepEqual(second.granted, [area]);
  assert.ok(second.inputs[0].includes(area));
  assert.deepEqual(readdirSync(area).sort(), ["spec.md", "ticket-1.md"]);

  // Deleting the Run removes its Local files.
  const deleted = reopened.projectionPort.submit({
    operationId: "op-delete",
    operation: "delete-run",
    input: { runId },
  });
  assert.ok(deleted.admitted, JSON.stringify(deleted));
  await awaitSettled(reopened.projectionPort, deleted.operationId);
  assert.equal(existsSync(area), false);
});

test("[run-working-area] an unusable working area halts the Run with a typed Problem before any Turn", async (t) => {
  const first = planningAgent("failed", "spec.md");
  const { wired, runId, home, workspace, process } = await launch(t, first);
  const area = first.granted[0];
  assert.ok(area !== undefined);
  // Something other than a directory now occupies the area's path.
  rmSync(area, { recursive: true });
  writeFileSync(area, "squatter");

  const second = planningAgent("completed", "never.md");
  const reopened = wire(t, second.adapter, home, workspace, process);
  const resume = reopened.projectionPort.submit({
    operationId: "op-resume",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(resume.admitted, JSON.stringify(resume));
  const settled: OperationOutcome = await awaitSettled(
    reopened.projectionPort,
    resume.operationId,
  );
  assert.equal(settled.status, "not-applied", JSON.stringify(settled));
  if (settled.status !== "not-applied") throw new Error("unreachable");
  assert.equal(settled.problem.code, "selected-harness-unavailable");
  assert.equal(settled.problem.details?.category, "working-area-unavailable");
  assert.equal(runState(reopened, runId), "halted");
  // No Harness was prepared and no Turn started.
  assert.deepEqual(second.granted, []);
  assert.deepEqual(second.inputs, []);
  assert.equal(readFileSync(area, "utf8"), "squatter");
  void wired;
});
