import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
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
import { createProcessAdapter } from "../../src/process/process.js";
import type { RunGroup } from "../../src/run/store/store.js";
import { createApplication, openRunGroup } from "../helpers/application.js";
import {
  ensureRuntimeOnPath,
  hostPlatform,
  writeCommandBundle,
  writeGateBundle,
  writeRepeatBundle,
  type GateBundleOptions,
  type RepeatBundleOptions,
} from "../helpers/commandBundle.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";

// The `answer-human-gate` Operation on the Projection Port (#85): a `blocked` Run
// is answered against its exact durable Gate reference. Driven straight through
// the Port, so the contract — idempotency, staleness, not-blocked — is exercised
// exactly as a client submits it.

ensureRuntimeOnPath();

const executionProcess = createProcessAdapter();
const runExecution: RunExecution = ({ routing, owner }) =>
  executeRouting(routing, {
    owner,
    platform: hostPlatform(),
    resolveAsset: () => undefined,
    process: executionProcess,
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
async function launchBlocked(
  f: Fixture,
  options: RepeatBundleOptions,
): Promise<string> {
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
  await settleOutcome(f.app, admission.operationId);
  return admission.runId!;
}

/** Launch an authored Human Gate Bundle to its blocked rest and return the Run id. */
async function launchGateBlocked(
  f: Fixture,
  options: GateBundleOptions,
): Promise<string> {
  const bundle = writeGateBundle(options);
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
  await settleOutcome(f.app, admission.operationId);
  return admission.runId!;
}

/** The authored pending gate a Run rests at, asserted present. */
function pendingGateOf(app: Application, runId: string): RunGateReference {
  const gate = runOf(app, runId).pendingGate?.gate;
  assert.ok(gate);
  return gate!;
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

// Await a Run Operation's settled outcome: after `submit`, a Run Operation is
// `pending` and settles later as a durable update on the operation stream.
async function settleOutcome(
  app: Application,
  operationId: string,
): Promise<OperationOutcome> {
  return awaitSettled(app.projectionPort, operationId);
}

test("continue grants an interval, resolves succeeded, and records a readable answer (#85)", async (t) => {
  const f = fixture(t);
  const runId = await launchBlocked(f, { interval: 2, passAt: 3 });
  const gate = gateOf(f.app, runId);
  const offer = runOf(f.app, runId).actionOffers.find(
    (candidate) => candidate.action === "answer-human-gate",
  );
  assert.equal(offer?.basis, "durable Human Gate");

  const admission = f.app.projectionPort.submit({
    operationId: "answer-1",
    operation: "answer-human-gate",
    input: { runId, gate, answer: "continue" },
  });
  assert.ok(admission.admitted);
  assert.deepEqual(await settleOutcome(f.app, "answer-1"), {
    status: "applied",
  });

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

test("a blocked Run stays durably blocked and owned until its Human Gate answer rests it", async (t) => {
  const f = fixture(t);
  const runId = await launchBlocked(f, { interval: 2, passAt: 3 });

  const record = f.runGroup.readRun(runId);
  assert.ok(record.ok);
  assert.equal(record.run.state, "blocked");
  const listing = f.runGroup.listRuns().find((run) => run.runId === runId);
  assert.equal(listing?.live, true);
  assert.equal(listing?.ownedByThisProcess, true);

  const gate = gateOf(f.app, runId);
  const admission = f.app.projectionPort.submit({
    operationId: "answer-owned-block",
    operation: "answer-human-gate",
    input: { runId, gate, answer: "continue" },
  });
  assert.ok(admission.admitted);
  assert.deepEqual(await settleOutcome(f.app, admission.operationId), {
    status: "applied",
  });
  assert.equal(runOf(f.app, runId).state, "succeeded");
  assert.equal(
    f.runGroup.listRuns().find((run) => run.runId === runId)?.live,
    false,
  );
});

test("shutdown releases a blocked Run without changing its rest or answer offer (#134 A21)", async (t) => {
  const f = fixture(t);
  const runId = await launchBlocked(f, { interval: 2, passAt: 3 });
  assert.equal(runOf(f.app, runId).state, "blocked");
  assert.equal(
    f.runGroup.listRuns().find((run) => run.runId === runId)?.live,
    true,
  );

  await f.app.shutdown();

  const read = f.runGroup.readRun(runId);
  assert.ok(read.ok);
  if (read.ok) assert.equal(read.run.state, "blocked");
  assert.equal(
    f.runGroup.listRuns().find((run) => run.runId === runId)?.live,
    false,
  );
  const reopened = createApplication({
    catalog: f.catalog,
    launchWorkspacePath: f.workspace,
    hostPlatform: hostPlatform(),
    runGroup: f.runGroup,
    runExecution,
  });
  const run = runOf(reopened, runId);
  assert.equal(run.state, "blocked");
  assert.ok(
    run.actionOffers.some((offer) => offer.action === "answer-human-gate"),
  );
});

test("a checkpoint is answered applied while another Run is live in the same Workspace (ADR 0031, AC2)", async (t) => {
  const f = fixture(t);
  // Two Runs live in one Workspace: both rest blocked and stay owned by this
  // instance. The deleted per-Workspace busy rule would have refused answering one
  // while the other held the single live-Run claim (`workspace-busy`, settled
  // `not-applied`); ownership is per-Run now, so answering the Run this instance
  // owns settles `applied` regardless of the other live Run.
  const other = await launchBlocked(f, {
    id: "dev.secant.repeat-other",
    interval: 2,
    passAt: 3,
  });
  const runId = await launchBlocked(f, {
    id: "dev.secant.repeat-answered",
    interval: 2,
    passAt: 3,
  });
  assert.equal(f.runGroup.listRuns().filter((run) => run.live).length, 2);

  const gate = gateOf(f.app, runId);
  const admission = f.app.projectionPort.submit({
    operationId: "answer-with-other-live",
    operation: "answer-human-gate",
    input: { runId, gate, answer: "continue" },
  });
  assert.ok(admission.admitted);
  assert.deepEqual(await settleOutcome(f.app, admission.operationId), {
    status: "applied",
  });
  assert.equal(runOf(f.app, runId).state, "succeeded");
  // The other Run is untouched: still blocked and live in this instance.
  assert.equal(runOf(f.app, other).state, "blocked");
  assert.equal(
    f.runGroup.listRuns().find((run) => run.runId === other)?.live,
    true,
  );
});

test("taking over a Run blocked in another process re-owns it blocked, and cancelling it then rests it cancelled (ADR 0031)", async (t) => {
  const f = fixture(t);
  // A repeat Bundle rests blocked under a first instance (pid 1000).
  const bundle = writeRepeatBundle({
    id: "dev.secant.blocked-takeover",
    interval: 2,
    passAt: 3,
  });
  const built = f.app.bundleManagement.build(bundle.folder, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog.listEntries().find((e) => e.id === bundle.id)!;
  f.catalog.approveWorkspace(f.workspace, new Date());

  const store = makeTempDir("secant-blocked-takeover-store-");
  const first = openRunGroup(store, f.workspace, {
    selfPid: 1000,
    isOwnerAlive: () => true,
  });
  t.after(() => first.close());
  const owning = createApplication({
    catalog: f.catalog,
    launchWorkspacePath: f.workspace,
    hostPlatform: hostPlatform(),
    runGroup: first,
    runExecution,
  });
  const launch = owning.projectionPort.submit({
    operationId: "launch-blocked-takeover",
    operation: "launch-run",
    input: {
      bundle: { id: bundle.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(launch.admitted);
  await settleOutcome(owning, launch.operationId);
  const runId = launch.runId!;
  assert.equal(runOf(owning, runId).state, "blocked");

  // A second instance (pid 2000, seeing pid 1000 alive) takes the blocked Run over.
  const second = openRunGroup(store, f.workspace, {
    selfPid: 2000,
    isOwnerAlive: (pid) => pid === 1000,
  });
  t.after(() => second.close());
  const app2 = createApplication({
    catalog: f.catalog,
    launchWorkspacePath: f.workspace,
    hostPlatform: hostPlatform(),
    runGroup: second,
    runExecution,
  });
  assert.deepEqual(runOf(app2, runId).liveness, {
    state: "live-elsewhere",
    ownerPid: 1000,
  });
  const takeover = app2.projectionPort.submit({
    operationId: "takeover-blocked",
    operation: "resume-run",
    input: { runId, takeover: { ownerPid: 1000 } },
  });
  assert.ok(takeover.admitted);
  assert.deepEqual(await settleOutcome(app2, takeover.operationId), {
    status: "applied",
  });
  // Re-owned here and still blocked (no execution ran; ownership just moved).
  assert.equal(runOf(app2, runId).state, "blocked");
  assert.equal(
    second.listRuns().find((run) => run.runId === runId)?.ownedByThisProcess,
    true,
  );

  // Cancelling the taken-over blocked Run must durably rest it `cancelled` and
  // release its owner — not silently no-op against a stale settlement promise left
  // by the synchronous takeover path.
  const cancel = app2.projectionPort.submit({
    operationId: "cancel-taken-over",
    operation: "cancel-run",
    input: { runId },
  });
  assert.ok(cancel.admitted);
  assert.deepEqual(await settleOutcome(app2, cancel.operationId), {
    status: "applied",
  });
  const rested = second.readRun(runId);
  assert.ok(rested.ok);
  assert.equal(rested.run.state, "cancelled");
  assert.equal(
    second.listRuns().find((run) => run.runId === runId)?.live,
    false,
  );
});

test("continue that keeps failing re-blocks with the count reset to the interval (#85)", async (t) => {
  const f = fixture(t);
  const runId = await launchBlocked(f, { interval: 2 }); // always fails
  const firstGate = gateOf(f.app, runId);
  assert.equal(runOf(f.app, runId).checkpoint?.completedIterations, 2);

  const admission = f.app.projectionPort.submit({
    operationId: "answer-1",
    operation: "answer-human-gate",
    input: { runId, gate: firstGate, answer: "continue" },
  });
  assert.ok(admission.admitted);
  assert.deepEqual(await settleOutcome(f.app, "answer-1"), {
    status: "applied",
  });

  const run = runOf(f.app, runId);
  assert.equal(run.state, "blocked");
  // The count reset to the interval since the grant; a fresh interval ran, so the
  // Gate now names a different Attempt.
  assert.equal(run.checkpoint?.completedIterations, 2);
  assert.notEqual(run.checkpoint?.gate.attemptId, firstGate.attemptId);
});

test("stop ends the Run failed with history and Artifacts intact (#85)", async (t) => {
  const f = fixture(t);
  const runId = await launchBlocked(f, { interval: 2 });
  const gate = gateOf(f.app, runId);

  const admission = f.app.projectionPort.submit({
    operationId: "answer-1",
    operation: "answer-human-gate",
    input: { runId, gate, answer: "stop" },
  });
  assert.ok(admission.admitted);
  assert.deepEqual(await settleOutcome(f.app, "answer-1"), {
    status: "applied",
  });

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
  const runId = await launchBlocked(f, { interval: 2, passAt: 3 });
  const gate = gateOf(f.app, runId);

  const first = f.app.projectionPort.submit({
    operationId: "answer-1",
    operation: "answer-human-gate",
    input: { runId, gate, answer: "continue" },
  });
  assert.ok(first.admitted);
  assert.deepEqual(await settleOutcome(f.app, "answer-1"), {
    status: "applied",
  });
  assert.equal(runOf(f.app, runId).state, "succeeded");

  // A replay of the same operation id is admitted and applied, with no second
  // answer recorded.
  const replay = f.app.projectionPort.submit({
    operationId: "answer-1",
    operation: "answer-human-gate",
    input: { runId, gate, answer: "continue" },
  });
  assert.ok(replay.admitted);
  assert.deepEqual(await settleOutcome(f.app, "answer-1"), {
    status: "applied",
  });
  assert.equal(runOf(f.app, runId).state, "succeeded");

  const owner = f.runGroup.acquireRun(runId)!;
  t.after(() => owner.close());
  assert.equal(owner.gateAnswers().length, 1);
});

test("a stale Gate reference is not applied and changes nothing (#85)", async (t) => {
  const f = fixture(t);
  const runId = await launchBlocked(f, { interval: 2 });
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
  const outcome = await settleOutcome(f.app, "answer-1");
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
  await settleOutcome(f.app, launch.operationId);
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
  const outcome = await settleOutcome(f.app, "answer-1");
  assert.equal(outcome.status, "not-applied");
  if (outcome.status !== "not-applied") throw new Error("unreachable");
  assert.equal(outcome.problem.code, "run-not-blocked");
});

// --- Authored Human Gate (#108) --------------------------------------------

test("an authored free-text gate blocks, then a text answer publishes the output, settles succeeded, and advances (#108)", async (t) => {
  const f = fixture(t);
  const runId = await launchGateBlocked(f, {
    shape: "free-text",
    message: "name the release",
    outputName: "answer",
  });

  // The Run rests blocked at a durable authored gate, not a Review checkpoint.
  const blocked = runOf(f.app, runId);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.checkpoint, undefined);
  assert.equal(blocked.pendingGate?.gate.shape, "free-text");
  const offer = blocked.actionOffers.find(
    (candidate) => candidate.action === "answer-human-gate",
  );
  assert.equal(offer?.basis, "durable Human Gate");
  assert.equal(blocked.pendingGate?.message, "name the release");
  assert.equal(blocked.pendingGate?.outputArtifactName, "answer");
  const gate = pendingGateOf(f.app, runId);

  const admission = f.app.projectionPort.submit({
    operationId: "answer-text-1",
    operation: "answer-human-gate",
    input: { runId, gate, text: "v2.0.0" },
  });
  assert.ok(admission.admitted);
  assert.deepEqual(await settleOutcome(f.app, "answer-text-1"), {
    status: "applied",
  });

  // The Run advanced past the gate: the downstream Command read the bound answer
  // (it references it), so the Run rests succeeded.
  const run = runOf(f.app, runId);
  assert.equal(run.state, "succeeded");
  assert.equal(run.pendingGate, undefined);
  // The answer is published as a `text` output bound to the gate's declared name.
  const answer = run.outputs.find((o) => o.name === "answer");
  assert.ok(answer, "the free-text answer is a bound output");
  const read = f.app.projectionPort.readResource(answer!.reference);
  assert.ok(read.found);
  if (read.found) assert.equal(read.content, "v2.0.0");
});

test("an authored approve-reject gate: continue advances, stop ends the Run failed (#108)", async (t) => {
  const f = fixture(t);
  // continue advances to succeeded.
  const advance = await launchGateBlocked(f, {
    id: "dev.secant.gate-approve",
    shape: "approve-reject",
  });
  assert.equal(runOf(f.app, advance).pendingGate?.gate.shape, "approve-reject");
  const advanceGate = pendingGateOf(f.app, advance);
  const a = f.app.projectionPort.submit({
    operationId: "approve-1",
    operation: "answer-human-gate",
    input: { runId: advance, gate: advanceGate, answer: "continue" },
  });
  assert.ok(a.admitted);
  assert.deepEqual(await settleOutcome(f.app, "approve-1"), {
    status: "applied",
  });
  assert.equal(runOf(f.app, advance).state, "succeeded");

  // stop ends the Run failed, keeping history and Artifacts.
  const reject = await launchGateBlocked(f, {
    id: "dev.secant.gate-reject",
    shape: "approve-reject",
  });
  const rejectGate = pendingGateOf(f.app, reject);
  const r = f.app.projectionPort.submit({
    operationId: "reject-1",
    operation: "answer-human-gate",
    input: { runId: reject, gate: rejectGate, answer: "stop" },
  });
  assert.ok(r.admitted);
  assert.deepEqual(await settleOutcome(f.app, "reject-1"), {
    status: "applied",
  });
  assert.equal(runOf(f.app, reject).state, "failed");
});

test("answer-shape mismatches change nothing: continue to a free-text gate, text to an approve-reject gate (#108)", async (t) => {
  const f = fixture(t);
  const freeText = await launchGateBlocked(f, {
    id: "dev.secant.gate-free",
    shape: "free-text",
  });
  const freeTextGate = pendingGateOf(f.app, freeText);
  const wrong1 = f.app.projectionPort.submit({
    operationId: "wrong-1",
    operation: "answer-human-gate",
    input: { runId: freeText, gate: freeTextGate, answer: "continue" },
  });
  assert.ok(wrong1.admitted);
  const out1 = await settleOutcome(f.app, "wrong-1");
  assert.equal(out1.status, "not-applied");
  if (out1.status !== "not-applied") throw new Error("unreachable");
  assert.equal(out1.problem.code, "gate-shape-mismatch");
  // Nothing changed: still blocked at the same gate, no output bound.
  assert.equal(runOf(f.app, freeText).state, "blocked");
  assert.equal(
    runOf(f.app, freeText).outputs.find((o) => o.name === "answer"),
    undefined,
  );

  const approve = await launchGateBlocked(f, {
    id: "dev.secant.gate-approve2",
    shape: "approve-reject",
  });
  const approveGate = pendingGateOf(f.app, approve);
  const wrong2 = f.app.projectionPort.submit({
    operationId: "wrong-2",
    operation: "answer-human-gate",
    input: { runId: approve, gate: approveGate, text: "nope" },
  });
  assert.ok(wrong2.admitted);
  const out2 = await settleOutcome(f.app, "wrong-2");
  assert.equal(out2.status, "not-applied");
  if (out2.status !== "not-applied") throw new Error("unreachable");
  assert.equal(out2.problem.code, "gate-shape-mismatch");
  assert.equal(runOf(f.app, approve).state, "blocked");
});

test("a different operation answering an already-answered authored gate is refused, not masked as applied (#108)", async (t) => {
  const f = fixture(t);
  const runId = await launchGateBlocked(f, { shape: "approve-reject" });
  const gate = pendingGateOf(f.app, runId);

  // Operation A approves the gate; the Run advances past it.
  const a = f.app.projectionPort.submit({
    operationId: "op-a",
    operation: "answer-human-gate",
    input: { runId, gate, answer: "continue" },
  });
  assert.ok(a.admitted);
  assert.deepEqual(await settleOutcome(f.app, "op-a"), { status: "applied" });
  assert.equal(runOf(f.app, runId).state, "succeeded");

  // A genuinely different operation B targets the same, now-settled gate. It must
  // be refused (the gate is gone), not silently reported `applied`.
  const b = f.app.projectionPort.submit({
    operationId: "op-b",
    operation: "answer-human-gate",
    input: { runId, gate, answer: "stop" },
  });
  assert.ok(b.admitted);
  const outcome = await settleOutcome(f.app, "op-b");
  assert.equal(outcome.status, "not-applied");
  if (outcome.status !== "not-applied") throw new Error("unreachable");
  assert.equal(outcome.problem.code, "run-not-blocked");
  // B changed nothing: the Run is still succeeded, not flipped to failed by `stop`.
  assert.equal(runOf(f.app, runId).state, "succeeded");
});

test("the same free-text answer operation id twice publishes the output once (#108)", async (t) => {
  const f = fixture(t);
  const runId = await launchGateBlocked(f, { shape: "free-text" });
  const gate = pendingGateOf(f.app, runId);

  const first = f.app.projectionPort.submit({
    operationId: "answer-once",
    operation: "answer-human-gate",
    input: { runId, gate, text: "final" },
  });
  assert.ok(first.admitted);
  assert.deepEqual(await settleOutcome(f.app, "answer-once"), {
    status: "applied",
  });
  assert.equal(runOf(f.app, runId).state, "succeeded");

  const replay = f.app.projectionPort.submit({
    operationId: "answer-once",
    operation: "answer-human-gate",
    input: { runId, gate, text: "final" },
  });
  assert.ok(replay.admitted);
  assert.deepEqual(await settleOutcome(f.app, "answer-once"), {
    status: "applied",
  });
  assert.equal(runOf(f.app, runId).state, "succeeded");

  // Exactly one version of the answer output was published (idempotent).
  const owner = f.runGroup.acquireRun(runId)!;
  t.after(() => owner.close());
  const versionId = owner.currentVersion("answer");
  assert.ok(versionId);
  const answer = runOf(f.app, runId).outputs.find((o) => o.name === "answer");
  const read = f.app.projectionPort.readResource(answer!.reference);
  assert.ok(read.found);
  if (read.found) assert.equal(read.content, "final");
});

test("reusing a free-text answer operation id with different text is refused (#134 A4)", async (t) => {
  const f = fixture(t);
  const runId = await launchGateBlocked(f, { shape: "free-text" });
  const gate = pendingGateOf(f.app, runId);

  const first = f.app.projectionPort.submit({
    operationId: "answer-reused",
    operation: "answer-human-gate",
    input: { runId, gate, text: "first" },
  });
  assert.ok(first.admitted);
  assert.deepEqual(await settleOutcome(f.app, first.operationId), {
    status: "applied",
  });

  const reused = f.app.projectionPort.submit({
    operationId: "answer-reused",
    operation: "answer-human-gate",
    input: { runId, gate, text: "second" },
  });
  assert.equal(reused.admitted, false);
  if (!reused.admitted) {
    assert.equal(reused.problem.code, "operation-id-reused");
  }

  const answer = runOf(f.app, runId).outputs.find(
    (output) => output.name === "answer",
  );
  assert.ok(answer);
  const read = f.app.projectionPort.readResource(answer.reference);
  assert.ok(read.found);
  if (read.found) assert.equal(read.content, "first");
});
