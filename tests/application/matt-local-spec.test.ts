import assert from "node:assert/strict";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import type {
  HarnessAdapter,
  HarnessProfile,
} from "../../src/harness/harness.js";
import type { RunView } from "../../src/application/projection-port.js";
import { createFake, type FakeScript } from "../harness/fake-adapter.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";

// [matt-local-spec] The maintained Matt Bundle publishes its spec to the Local
// tracker (#220), over the shared Projection Port with the real Application and Run
// Store on a temporary home and a fake Harness under each v1 Harness selection.
// After the grill and the tracker choice, write-spec runs with no approval Gate in
// the same planning Session, reads the original to-spec folder through its bundled
// path, is told the Run's exact working area, and writes the spec there — never in
// the Workspace. The spec reference is captured only from its Output receipt and is
// retained as the `spec-ref` Run output; a completed Turn without a receipt fails the Run.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MATT_FOLDER = join(repoRoot, "bundles", "matt-front-spec");
const MATT_ID = "dev.secant.matt-front";
const IDEA = "Add a dark-mode toggle that follows me across devices.";
const RECEIPT_LINE =
  /Write the required output "spec-ref" as UTF-8 text to (.+) before you finish;/;

type HarnessId = "claude-code" | "codex";

function profile(harness: HarnessId): HarnessProfile {
  return {
    harness: harness === "codex" ? "codex" : "Claude Code",
    executable: harness === "codex" ? "codex" : "fake-claude",
    executableVersion: "0.0.0-fake",
    platform: "linux",
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "native-reattach", evidence: "scripted fake" },
    interruption: { mode: "process-only", evidence: "scripted fake" },
    approvals: { available: true, evidence: "scripted fake" },
    clarifications: { available: false, evidence: "scripted fake" },
    steer: { available: harness === "codex", evidence: "scripted fake" },
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

const COMPLETED: FakeScript["turns"][number] = {
  events: [{ kind: "assistant-content", content: "ok" }],
  result: {
    kind: "completed",
    detail: {
      finalContent: "ok",
      effectiveModel: { known: true, model: "fake-model" },
      session: { state: "detached", coordinate: { opaque: "coord-spec" } },
    },
  },
};

/** An Adapter playing the planning agent: every Turn completes, and on the spec
 *  Turn (the one naming a receipt) it writes `spec.md` into the granted working
 *  area and, when `writeReceipt`, the spec's path to the receipt. */
function planningAgent(harness: HarnessId, writeReceipt: boolean) {
  const granted: (string | undefined)[] = [];
  const inputs: string[] = [];
  const receipts: string[] = [];
  const adapter: HarnessAdapter = {
    async prepare(options) {
      granted.push(options.writableDirectory);
      const prepared = await createFake({
        profile: profile(harness),
        turns: Array.from({ length: 8 }, () => COMPLETED),
      })().prepare(options);
      if (!prepared.ok) return prepared;
      const inner = prepared.harness;
      return {
        ok: true,
        harness: {
          profile: inner.profile,
          startTurn(request) {
            inputs.push(request.input.text);
            const receipt = RECEIPT_LINE.exec(request.input.text)?.[1];
            const area = options.writableDirectory;
            if (receipt !== undefined && area !== undefined) {
              receipts.push(receipt);
              const spec = join(area, "spec.md");
              writeFileSync(spec, "# Dark mode\n");
              if (writeReceipt) writeFileSync(receipt, `${spec}\n`);
            }
            return inner.startTurn(request);
          },
          close: () => inner.close(),
        },
      };
    },
  };
  return { adapter, granted, inputs, receipts };
}

function wire(
  t: TestContext,
  harness: HarnessId,
  adapter: HarnessAdapter,
): { wired: Wiring; workspace: string; digest: string } {
  const workspace = makeTempDir("secant-matt-spec-ws-");
  const found = (name: string) => () => ({
    kind: "found" as const,
    attempt: {
      source: "path" as const,
      name,
      description: `PATH name '${name}'`,
    },
  });
  const wired = wireApplication({
    secantHome: makeTempDir("secant-matt-spec-home-"),
    launchCwd: workspace,
    supportsInteractiveTurns: true,
    process: createFakeBundleProcess(),
    discoverClaudeCode: found("claude"),
    discoverCodex: found("codex"),
    ...(harness === "codex"
      ? { codexHarnessAdapter: adapter }
      : { harnessAdapter: adapter }),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  const built = wired.bundleManagement.build(MATT_FOLDER, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = wired.catalog.listEntries().find((e) => e.id === MATT_ID);
  assert.ok(entry);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  return { wired, workspace, digest: entry.digest };
}

async function settle(
  wired: Wiring,
  submission: Parameters<Wiring["projectionPort"]["submit"]>[0],
) {
  const admission = wired.projectionPort.submit(submission);
  assert.ok(admission.admitted, JSON.stringify(admission));
  const outcome = await awaitSettled(
    wired.projectionPort,
    submission.operationId,
  );
  assert.equal(outcome.status, "applied", JSON.stringify(outcome));
  return admission;
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

/** Launch, take the grill's entry Turn, end the grill, and choose Local. */
async function planToLocal(
  wired: Wiring,
  digest: string,
  harness: HarnessId,
): Promise<string> {
  const { runId } = await settle(wired, {
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: MATT_ID },
      launchInputs: { idea: IDEA },
      trustDigest: digest,
      harness,
    },
  });
  assert.ok(runId);
  await settle(wired, {
    operationId: "op-end",
    operation: "end-interactive-step",
    input: { runId, stepId: "grill" },
  });
  const gate = readRun(wired, runId).pendingGate?.gate;
  assert.equal(gate?.stepId, "choose-tracker");
  await settle(wired, {
    operationId: "op-tracker",
    operation: "answer-human-gate",
    input: { runId, gate: gate!, text: "Local" },
  });
  return runId;
}

function workingArea(wired: Wiring, runId: string): string {
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    const area = owner.workingArea();
    assert.ok(area.ok);
    if (!area.ok) throw new Error("unreachable");
    return area.path;
  } finally {
    owner.close();
  }
}

function turnSessions(wired: Wiring, runId: string): string[] {
  const owner = wired.runGroup.acquireRun(runId);
  assert.ok(owner);
  try {
    return owner.turns().map((turn) => turn.session);
  } finally {
    owner.close();
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

for (const harness of ["claude-code", "codex"] as const) {
  test(`[matt-local-spec] [${harness}] the spec lands in the Run working area and its reference is retained (#220)`, async (t) => {
    const agent = planningAgent(harness, true);
    const { wired, workspace, digest } = wire(t, harness, agent.adapter);
    const runId = await planToLocal(wired, digest, harness);

    // Spec writing followed the tracker choice with no approval Gate between; the
    // Run then rests at ticket review (#223).
    const run = readRun(wired, runId);
    assert.equal(run.state, "blocked", JSON.stringify(run.progress));
    assert.deepEqual(
      run.progress.map((step) => [step.id, step.status]),
      [
        ["grill", "succeeded"],
        ["choose-tracker", "succeeded"],
        ["write-spec", "succeeded"],
        ["plan-tickets", "blocked"],
        ["publish-tickets", "pending"],
      ],
    );
    // The grill's planning Session is retained for the spec and review Turns.
    assert.deepEqual(turnSessions(wired, runId), ["spec", "spec", "spec"]);

    const area = workingArea(wired, runId);
    const prompt = agent.inputs.find((input) => RECEIPT_LINE.test(input))!;
    // Every prepare granted exactly the working area, which the prompt names.
    assert.ok(agent.granted.length > 0);
    assert.ok(agent.granted.every((dir) => dir === area));
    assert.ok(prompt.includes(area), prompt);
    assert.ok(prompt.includes("the tracker I chose: Local."), prompt);
    // The receipt is inside that one grant, so no second writable root is needed.
    assert.equal(agent.receipts.length, 1);
    assert.ok(
      realpathSync(agent.receipts[0]!).startsWith(area),
      agent.receipts[0],
    );

    // The original to-spec folder resolves complete through its bundled path.
    const match = /(\S*[\\/]to-spec[\\/]SKILL\.md)/.exec(prompt);
    assert.ok(match, prompt);
    const bundled = dirname(match[1]!);
    const source = join(MATT_FOLDER, "skills", "to-spec");
    assert.deepEqual(filesUnder(bundled), filesUnder(source));
    for (const file of filesUnder(source)) {
      assert.deepEqual(
        readFileSync(join(bundled, file)),
        readFileSync(join(source, file)),
      );
    }
    assert.doesNotMatch(prompt, /spec-writing/);

    // The spec is in the working area; the Workspace holds no planning file.
    const spec = join(area, "spec.md");
    assert.ok(existsSync(spec));
    assert.deepEqual(readdirSync(workspace), []);

    // The reference is a retained Run output, readable through the Port.
    const output = run.outputs.find(
      (candidate) => candidate.name === "spec-ref",
    );
    assert.ok(output, JSON.stringify(run.outputs));
    const read = wired.projectionPort.readResource(output.reference);
    assert.ok(read.found, JSON.stringify(read));
    assert.equal(read.content, spec);
  });
}

test("[matt-local-spec] a completed spec Turn without a receipt fails the Run without retrying the publication (#220)", async (t) => {
  const agent = planningAgent("claude-code", false);
  const { wired, digest } = wire(t, "claude-code", agent.adapter);
  const runId = await planToLocal(wired, digest, "claude-code");

  const run = readRun(wired, runId);
  assert.equal(run.state, "failed");
  assert.equal(
    run.progress.find((step) => step.id === "write-spec")?.status,
    "failed",
  );
  // One spec Turn only: a retry would publish the spec a second time.
  assert.equal(agent.receipts.length, 1);
  assert.equal(
    run.outputs.find((candidate) => candidate.name === "spec-ref"),
    undefined,
  );
});
