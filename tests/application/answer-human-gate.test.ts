import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  createApplication,
  type Application,
  type RunExecution,
} from "../../src/application/application.js";
import type {
  OperationOutcome,
  RunGateReference,
  RunView,
} from "../../src/application/projection-port.js";
import { openCatalog, type Catalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import { openRunGroup, type RunGroup } from "../../src/run/store/store.js";
import {
  ensureRuntimeOnPath,
  hostPlatform,
  writeCommandBundle,
  writeRepeatBundle,
  type RepeatBundleOptions,
} from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The `answer-human-gate` Operation on the Projection Port (#85): a `blocked` Run
// is answered against its exact durable Gate reference. Driven straight through
// the Port, so the contract — idempotency, staleness, not-blocked — is exercised
// exactly as a client submits it.

ensureRuntimeOnPath();

const runExecution: RunExecution = ({ routing, owner }) =>
  executeRouting(routing, {
    owner,
    platform: hostPlatform(),
    resolveAsset: () => undefined,
  });

interface Fixture {
  readonly app: Application;
  readonly catalog: Catalog;
  readonly runGroup: RunGroup;
  readonly workspace: string;
}

function fixture(t: TestContext): Fixture {
  const catalog = openCatalog(makeTempDir("secant-answer-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-answer-ws-"));
  const runGroup = openRunGroup(makeTempDir("secant-answer-store-"), workspace);
  t.after(() => runGroup.close());
  const app = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution,
  });
  return { app, catalog, runGroup, workspace };
}

/** Launch a Repeat Bundle to a blocked rest and return the Run id. */
function launchBlocked(f: Fixture, options: RepeatBundleOptions): string {
  const bundle = writeRepeatBundle(options);
  const built = f.app.bundleManagement.build(bundle.folder, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog.listEntries().find((e) => e.id === bundle.id)!;
  f.catalog.approveWorkspace(f.workspace, new Date());
  const admission = f.app.projectionPort.submit({
    operationId: `launch-${bundle.id}`,
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(admission.admitted);
  return admission.runId!;
}

function runOf(app: Application, runId: string): RunView {
  const opened = app.projectionPort.openProjection({ family: "run", runId });
  const result = opened.snapshot.result;
  opened.close();
  assert.ok(result.found);
  if (!result.found) throw new Error("unreachable");
  return result.run;
}

function gateOf(app: Application, runId: string): RunGateReference {
  const gate = runOf(app, runId).checkpoint?.gate;
  assert.ok(gate);
  return gate!;
}

function settleOutcome(
  app: Application,
  operationId: string,
): OperationOutcome {
  const opened = app.projectionPort.openProjection({
    family: "operation",
    operationId,
  });
  const outcome = opened.snapshot.outcome;
  opened.close();
  return outcome;
}

test("continue grants an interval, resolves succeeded, and records a readable answer (#85)", async (t) => {
  const f = fixture(t);
  const runId = launchBlocked(f, { interval: 2, passAt: 3 });
  const gate = gateOf(f.app, runId);

  const admission = f.app.projectionPort.submit({
    operationId: "answer-1",
    operation: "answer-human-gate",
    input: { runId, gate, answer: "continue" },
  });
  assert.ok(admission.admitted);
  assert.deepEqual(settleOutcome(f.app, "answer-1"), { status: "applied" });

  const run = runOf(f.app, runId);
  assert.equal(run.state, "succeeded");
  // The answer is a durable, readable output and lands on the timeline.
  const answer = run.outputs.find((o) => o.name === "human-gate-answer");
  assert.ok(answer);
  const read = f.app.projectionPort.readResource(answer!.reference);
  assert.ok(read.found);
  if (read.found) assert.equal(read.content, "continue");
  assert.ok(
    run.timeline.some(
      (e) => e.event === "gate-answered" && e.detail === "continue",
    ),
  );
});

test("continue that keeps failing re-blocks with the count reset to the interval (#85)", async (t) => {
  const f = fixture(t);
  const runId = launchBlocked(f, { interval: 2 }); // always fails
  const firstGate = gateOf(f.app, runId);
  assert.equal(runOf(f.app, runId).checkpoint?.completedIterations, 2);

  const admission = f.app.projectionPort.submit({
    operationId: "answer-1",
    operation: "answer-human-gate",
    input: { runId, gate: firstGate, answer: "continue" },
  });
  assert.ok(admission.admitted);
  assert.deepEqual(settleOutcome(f.app, "answer-1"), { status: "applied" });

  const run = runOf(f.app, runId);
  assert.equal(run.state, "blocked");
  // The count reset to the interval since the grant; a fresh interval ran, so the
  // Gate now names a different Attempt.
  assert.equal(run.checkpoint?.completedIterations, 2);
  assert.notEqual(run.checkpoint?.gate.attemptId, firstGate.attemptId);
});

test("stop ends the Run failed with history and Artifacts intact (#85)", async (t) => {
  const f = fixture(t);
  const runId = launchBlocked(f, { interval: 2 });
  const gate = gateOf(f.app, runId);

  const admission = f.app.projectionPort.submit({
    operationId: "answer-1",
    operation: "answer-human-gate",
    input: { runId, gate, answer: "stop" },
  });
  assert.ok(admission.admitted);
  assert.deepEqual(settleOutcome(f.app, "answer-1"), { status: "applied" });

  const run = runOf(f.app, runId);
  assert.equal(run.state, "failed");
  // The loop's Verdict and the answer both remain readable; the timeline keeps
  // every iteration plus the answer.
  assert.ok(run.outputs.find((o) => o.name === "passing"));
  assert.ok(run.outputs.find((o) => o.name === "human-gate-answer"));
  assert.equal(run.timeline.filter((e) => e.event === "iteration").length, 2);
  assert.ok(
    run.timeline.some(
      (e) => e.event === "gate-answered" && e.detail === "stop",
    ),
  );
});

test("the same operation id answered twice yields the same outcome and records once (#85)", async (t) => {
  const f = fixture(t);
  const runId = launchBlocked(f, { interval: 2, passAt: 3 });
  const gate = gateOf(f.app, runId);

  const first = f.app.projectionPort.submit({
    operationId: "answer-1",
    operation: "answer-human-gate",
    input: { runId, gate, answer: "continue" },
  });
  assert.ok(first.admitted);
  assert.deepEqual(settleOutcome(f.app, "answer-1"), { status: "applied" });
  assert.equal(runOf(f.app, runId).state, "succeeded");

  // A replay of the same operation id is admitted and applied, with no second
  // answer recorded.
  const replay = f.app.projectionPort.submit({
    operationId: "answer-1",
    operation: "answer-human-gate",
    input: { runId, gate, answer: "continue" },
  });
  assert.ok(replay.admitted);
  assert.deepEqual(settleOutcome(f.app, "answer-1"), { status: "applied" });
  assert.equal(runOf(f.app, runId).state, "succeeded");

  const owner = f.runGroup.acquireRun(runId)!;
  t.after(() => owner.close());
  assert.equal(owner.gateAnswers().length, 1);
});

test("a stale Gate reference is not applied and changes nothing (#85)", async (t) => {
  const f = fixture(t);
  const runId = launchBlocked(f, { interval: 2 });
  const gate = gateOf(f.app, runId);
  const stale: RunGateReference = {
    ...gate,
    attemptId: "not-the-current-attempt",
  };

  const admission = f.app.projectionPort.submit({
    operationId: "answer-1",
    operation: "answer-human-gate",
    input: { runId, gate: stale, answer: "continue" },
  });
  assert.ok(admission.admitted);
  const outcome = settleOutcome(f.app, "answer-1");
  assert.equal(outcome.status, "not-applied");
  if (outcome.status !== "not-applied") throw new Error("unreachable");
  assert.equal(outcome.problem.code, "gate-reference-stale");

  // Nothing changed: the Run is still blocked at the same Gate, no answer recorded.
  const run = runOf(f.app, runId);
  assert.equal(run.state, "blocked");
  assert.equal(run.checkpoint?.gate.attemptId, gate.attemptId);
  assert.equal(
    run.outputs.find((o) => o.name === "human-gate-answer"),
    undefined,
  );
  const owner = f.runGroup.acquireRun(runId)!;
  t.after(() => owner.close());
  assert.equal(owner.gateAnswers().length, 0);
});

test("answering a Run that is not blocked is not applied (#85)", async (t) => {
  const f = fixture(t);
  const cmd = writeCommandBundle();
  const built = f.app.bundleManagement.build(cmd.folder, { noInstall: false });
  assert.ok(built.ok);
  const entry = f.catalog.listEntries().find((e) => e.id === cmd.id)!;
  f.catalog.approveWorkspace(f.workspace, new Date());
  const launch = f.app.projectionPort.submit({
    operationId: "launch-1",
    operation: "launch-run",
    input: {
      bundle: { id: cmd.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(launch.admitted);
  const runId = launch.runId!;
  assert.equal(runOf(f.app, runId).state, "succeeded");

  const admission = f.app.projectionPort.submit({
    operationId: "answer-1",
    operation: "answer-human-gate",
    input: {
      runId,
      gate: {
        runId,
        stepId: "run-check",
        attemptId: "whatever",
        shape: "approve-reject",
      },
      answer: "continue",
    },
  });
  assert.ok(admission.admitted);
  const outcome = settleOutcome(f.app, "answer-1");
  assert.equal(outcome.status, "not-applied");
  if (outcome.status !== "not-applied") throw new Error("unreachable");
  assert.equal(outcome.problem.code, "run-not-blocked");
});
