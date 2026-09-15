import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  createApplication,
  type Application,
  type RunExecution,
} from "../../src/application/application.js";
import type {
  OperationSnapshot,
  RunSnapshot,
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
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";

ensureRuntimeOnPath();

// The real Run execution, driven synchronously (spawnSync). The test Bundle
// declares no assets, so nothing resolves.
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

function fixture(
  t: TestContext,
  overrides: {
    scheduleSettlement?: (settle: () => void) => void;
  } = {},
): Fixture {
  const catalog = openCatalog(makeTempDir("secant-run-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-run-ws-"));
  const runGroup = openRunGroup(makeTempDir("secant-run-store-"), workspace);
  t.after(() => runGroup.close());
  const app = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution,
    ...(overrides.scheduleSettlement !== undefined
      ? { scheduleSettlement: overrides.scheduleSettlement }
      : {}),
  });
  return { app, catalog, runGroup, workspace };
}

/** Build+install a command-only Bundle and return its installed digest. */
function installCommandBundle(
  f: Fixture,
  options?: Parameters<typeof writeCommandBundle>[0],
): { id: string; digest: string } {
  const cmd = writeCommandBundle(options);
  const built = f.app.bundleManagement.build(cmd.folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog.listEntries().find((e) => e.id === cmd.id);
  assert.ok(entry);
  return { id: cmd.id, digest: entry.digest };
}

function runResult(app: Application, runId: string) {
  const opened = app.projectionPort.openProjection({ family: "run", runId });
  const snapshot = opened.snapshot;
  opened.close();
  return snapshot.result;
}

// Await a Run Operation's settled outcome before reading the Run snapshot: after
// `submit`, a Run Operation is `pending` and settles later as a durable update.
async function settled(app: Application, operationId: string) {
  return awaitSettled(app.projectionPort, operationId);
}

test("launch on an untrusted digest yields bundle-trust-required, no Run and no grant", async (t) => {
  const f = fixture(t);
  const { id, digest } = installCommandBundle(f);
  f.catalog.approveWorkspace(f.workspace, new Date());

  const admission = f.app.projectionPort.submit({
    operationId: "op-1",
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {} },
  });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "bundle-trust-required");
  // The explanation carries the Execution summary and the fixed authority warning.
  assert.match(admission.problem.explanation, /Execution summary/);
  assert.match(admission.problem.explanation, /current user's authority/);
  // The remediation names the exact digest to acknowledge.
  assert.match(admission.problem.remediation, new RegExp(digest));
  // The Execution summary is generated for the host platform (the Bundle supports
  // all three), not the first declared platform.
  assert.equal(admission.problem.details?.platform, hostPlatform());

  // Nothing was granted and no Run exists.
  assert.equal(f.catalog.getTrustGrant(digest, 1), undefined);
  assert.deepEqual(f.runGroup.listRuns(), []);
});

test("a matching acknowledgement records the grant and runs to succeeded; a second launch needs none", async (t) => {
  const f = fixture(t);
  const { id, digest } = installCommandBundle(f);
  f.catalog.approveWorkspace(f.workspace, new Date());

  const first = f.app.projectionPort.submit({
    operationId: "op-1",
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {}, trustDigest: digest },
  });
  assert.ok(first.admitted);
  const firstRunId = first.runId;
  assert.ok(firstRunId);
  await settled(f.app, first.operationId);
  // The grant is recorded and the Run rested succeeded.
  assert.ok(f.catalog.getTrustGrant(digest, 1));
  const firstResult = runResult(f.app, firstRunId);
  assert.ok(firstResult.found);
  assert.equal(firstResult.run.state, "succeeded");

  // A second launch needs no acknowledgement (already trusted).
  const second = f.app.projectionPort.submit({
    operationId: "op-2",
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {} },
  });
  assert.ok(second.admitted);
  await settled(f.app, second.operationId);
  const secondResult = runResult(f.app, second.runId!);
  assert.ok(secondResult.found);
  assert.equal(secondResult.run.state, "succeeded");
});

test("a wrong acknowledged digest is a Problem that grants nothing", async (t) => {
  const f = fixture(t);
  const { id, digest } = installCommandBundle(f);
  f.catalog.approveWorkspace(f.workspace, new Date());

  const admission = f.app.projectionPort.submit({
    operationId: "op-1",
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {}, trustDigest: "not-the-digest" },
  });
  assert.equal(admission.admitted, false);
  if (admission.admitted) throw new Error("unreachable");
  assert.equal(admission.problem.code, "trust-digest-mismatch");
  assert.equal(f.catalog.getTrustGrant(digest, 1), undefined);
  assert.deepEqual(f.runGroup.listRuns(), []);
});

test("an uninstalled Bundle and an unapproved Workspace each yield a Problem and no Run", async (t) => {
  const f = fixture(t);
  // Uninstalled Bundle.
  const missing = f.app.projectionPort.submit({
    operationId: "op-1",
    operation: "launch-run",
    input: { bundle: { id: "io.example.absent" }, launchInputs: {} },
  });
  assert.equal(missing.admitted, false);
  if (!missing.admitted) {
    assert.equal(missing.problem.code, "bundle-not-installed");
  }
  assert.deepEqual(f.runGroup.listRuns(), []);

  // Installed, but the Workspace is not approved.
  const { id, digest } = installCommandBundle(f);
  const unapproved = f.app.projectionPort.submit({
    operationId: "op-2",
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {}, trustDigest: digest },
  });
  assert.equal(unapproved.admitted, false);
  if (!unapproved.admitted) {
    assert.equal(unapproved.problem.code, "workspace-not-approved");
  }
  assert.deepEqual(f.runGroup.listRuns(), []);
  // No grant either — the approval gate runs before the trust grant.
  assert.equal(f.catalog.getTrustGrant(digest, 1), undefined);
});

test("the operation shows pending then applied, and the run projection delivers a durable update per publication", async (t) => {
  const held: (() => void)[] = [];
  const f = fixture(t, {
    scheduleSettlement: (settle) => held.push(settle),
  });
  const { id, digest } = installCommandBundle(f);
  f.catalog.approveWorkspace(f.workspace, new Date());

  const admission = f.app.projectionPort.submit({
    operationId: "op-1",
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {}, trustDigest: digest },
  });
  assert.ok(admission.admitted);
  const runId = admission.runId!;

  const operationView = f.app.projectionPort.openProjection({
    family: "operation",
    operationId: "op-1",
  });
  t.after(() => operationView.close());
  assert.deepEqual((operationView.snapshot as OperationSnapshot).outcome, {
    status: "pending",
  });
  const operationUpdates = operationView.updates[Symbol.asyncIterator]();

  const runView = f.app.projectionPort.openProjection({ family: "run", runId });
  t.after(() => runView.close());
  const runUpdates = runView.updates[Symbol.asyncIterator]();
  const collected: RunSnapshot[] = [];
  const drain = (async () => {
    for await (const update of {
      [Symbol.asyncIterator]: () => runUpdates,
    }) {
      if (update.kind === "durable") collected.push(update.snapshot);
    }
  })();

  // Release the held settlement: the Run executes and publishes.
  held.shift()?.();

  // The Operation settles applied as a durable update.
  const opUpdate = await operationUpdates.next();
  assert.equal(opUpdate.done, false);
  assert.ok(opUpdate.value && opUpdate.value.kind === "durable");
  assert.deepEqual((opUpdate.value.snapshot as OperationSnapshot).outcome, {
    status: "applied",
  });

  // The run projection delivered at least one durable update, ending succeeded.
  runView.close();
  await drain;
  assert.ok(collected.length >= 1);
  const last = collected.at(-1);
  assert.ok(last && last.result.found);
  if (last.result.found) assert.equal(last.result.run.state, "succeeded");
});

test("run projection reports identity, state, progress, position, timeline, and outputs; read returns text and verdict", async (t) => {
  const f = fixture(t);
  const { id, digest } = installCommandBundle(f, {
    script: "console.log('the-output')",
  });
  f.catalog.approveWorkspace(f.workspace, new Date());

  const admission = f.app.projectionPort.submit({
    operationId: "op-1",
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {}, trustDigest: digest },
  });
  assert.ok(admission.admitted);
  const runId = admission.runId!;
  await settled(f.app, admission.operationId);

  const result = runResult(f.app, runId);
  assert.ok(result.found);
  if (!result.found) throw new Error("unreachable");
  const run = result.run;
  assert.equal(run.bundle.id, id);
  assert.equal(run.bundle.digest, digest);
  assert.equal(run.state, "succeeded");
  assert.equal(run.progress.length, 1);
  assert.equal(run.progress[0]!.status, "succeeded");
  assert.equal(run.position, 1);
  assert.equal(run.timeline[0]!.event, "run-created");
  assert.ok(run.timeline.some((e) => e.event === "trust-granted"));
  assert.ok(run.timeline.some((e) => e.event === "attempt-settled"));

  const text = run.outputs.find((o) => o.name === "output");
  const verdict = run.outputs.find((o) => o.name === "verdict");
  assert.ok(text && verdict);

  const textRead = f.app.projectionPort.readResource(text.reference);
  assert.ok(textRead.found);
  if (textRead.found) assert.match(textRead.content, /the-output/);

  const verdictRead = f.app.projectionPort.readResource(verdict.reference);
  assert.ok(verdictRead.found);
  if (verdictRead.found) assert.equal(verdictRead.content, "pass");
});

test("opening the run projection on an unknown run id yields a Problem snapshot, not a throw", async (t) => {
  const f = fixture(t);
  const result = runResult(f.app, "no-such-run");
  assert.equal(result.found, false);
  if (!result.found) assert.equal(result.problem.code, "run-not-found");
});

// A Command whose executable is not on PATH is now refused by Preflight before a
// Run is created (see tests/application/preflight.test.ts, AC3); execution's own
// missing-executable-rests-failed behaviour is covered in
// tests/run/execution/execution.test.ts.

test("a re-submitted launch operation id replays with the same Run; different input is rejected", async (t) => {
  const f = fixture(t);
  const { id, digest } = installCommandBundle(f);
  f.catalog.approveWorkspace(f.workspace, new Date());

  const first = f.app.projectionPort.submit({
    operationId: "op-1",
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {}, trustDigest: digest },
  });
  assert.ok(first.admitted);
  await settled(f.app, first.operationId);
  const replay = f.app.projectionPort.submit({
    operationId: "op-1",
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {}, trustDigest: digest },
  });
  assert.deepEqual(replay, first);

  const conflict = f.app.projectionPort.submit({
    operationId: "op-1",
    operation: "launch-run",
    input: {
      bundle: { id },
      launchInputs: { extra: "x" },
      trustDigest: digest,
    },
  });
  assert.equal(conflict.admitted, false);
  if (!conflict.admitted) {
    assert.equal(conflict.problem.code, "operation-id-reused");
  }
  // The replay did not create a second Run.
  assert.equal(f.runGroup.listRuns().length, 1);
});

test("a launch refused before creation grants no trust, and a second live Run is admitted (ADR 0031)", async (t) => {
  // Hold settlement so the first Run stays live (owned, unsettled).
  const held: (() => void)[] = [];
  const f = fixture(t, { scheduleSettlement: (settle) => held.push(settle) });
  const first = installCommandBundle(f, { id: "dev.secant.first" });
  const second = installCommandBundle(f, { id: "dev.secant.second" });
  f.catalog.approveWorkspace(f.workspace, new Date());
  const secondEntry = f.catalog
    .listEntries()
    .find((e) => e.id === "dev.secant.second")!;

  // Launch the first Bundle; it creates a live Run (unsettled).
  const a = f.app.projectionPort.submit({
    operationId: "op-a",
    operation: "launch-run",
    input: {
      bundle: { id: first.id },
      launchInputs: {},
      trustDigest: first.digest,
    },
  });
  assert.ok(a.admitted);

  // A launch refused *before* the Run is created leaves no trust grant behind — the
  // grant is only recorded after creation. A mismatching trust acknowledgement is
  // one such pre-creation refusal (a Workspace claim is no longer another: any number
  // of Runs may be live, ADR 0031).
  const bad = f.app.projectionPort.submit({
    operationId: "op-bad",
    operation: "launch-run",
    input: {
      bundle: { id: second.id },
      launchInputs: {},
      trustDigest: "sha256:not-the-digest",
    },
  });
  assert.equal(bad.admitted, false);
  if (!bad.admitted) assert.equal(bad.problem.code, "trust-digest-mismatch");
  assert.equal(
    f.catalog.getTrustGrant(
      secondEntry.digest,
      secondEntry.installationGeneration,
    ),
    undefined,
  );

  // With a matching acknowledgement, the second Bundle launches while the first is
  // still live — two Runs live in one Workspace, no busy refusal (ADR 0031).
  const b = f.app.projectionPort.submit({
    operationId: "op-b",
    operation: "launch-run",
    input: {
      bundle: { id: second.id },
      launchInputs: {},
      trustDigest: second.digest,
    },
  });
  assert.ok(b.admitted);
  assert.equal(f.runGroup.listRuns().filter((run) => run.live).length, 2);
  const list = f.app.projectionPort.openProjection({ family: "run-list" });
  assert.equal(list.snapshot.rows.length, 2);
  assert.ok(list.snapshot.rows.every((row) => row.live));
  const updates = list.updates[Symbol.asyncIterator]();

  for (const settle of held) settle();
  await Promise.all([settled(f.app, "op-a"), settled(f.app, "op-b")]);
  let latest = list.snapshot;
  while (latest.rows.some((row) => row.live)) {
    const update = await updates.next();
    assert.equal(update.done, false);
    if (!update.done && update.value.kind === "durable") {
      latest = update.value.snapshot;
    }
  }
  assert.equal(latest.rows.length, 2);
  assert.ok(latest.rows.every((row) => !row.live));
  list.close();
});

test("reading a live Run's projection does not fence the owner executing it", async (t) => {
  const f = fixture(t);
  const { digest } = installCommandBundle(f);
  const store = makeTempDir("secant-foreign-run-store-");
  const first = openRunGroup(store, f.workspace, {
    selfPid: 1000,
    isOwnerAlive: () => true,
  });
  t.after(() => first.close());
  const created = first.createRun({
    operationId: "c",
    bundleSnapshotDigest: digest,
    launch: {},
    at: new Date(),
  });
  assert.ok(created.outcome === "created");
  const owner = first.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());
  assert.equal(owner.writeState("running").ok, true);
  const second = openRunGroup(store, f.workspace, {
    selfPid: 2000,
    isOwnerAlive: (pid) => pid === 1000,
  });
  t.after(() => second.close());
  const observing = createApplication({
    catalog: f.catalog,
    launchWorkspacePath: f.workspace,
    hostPlatform: hostPlatform(),
    runGroup: second,
    runExecution,
  });

  // Read the projection through the Port while the Run is live and this
  // Application has no in-process tracking for it — the cross-process `run show`
  // path. It must show the record-level snapshot without acquiring an owner.
  const result = runResult(observing, created.runId);
  assert.ok(result.found);
  if (result.found) assert.equal(result.run.state, "running");

  // The executing owner's canonical writes still succeed: the read did not bump
  // the fencing epoch, so it did not abort the running Run.
  assert.equal(owner.writeState("running").ok, true);
});

test("a foreign live Run offers an owner-named takeover that resumes and fences its prior owner", async (t) => {
  const f = fixture(t);
  const { digest } = installCommandBundle(f);
  f.catalog.approveWorkspace(f.workspace, new Date());
  f.catalog.grantTrust({
    operationId: "grant-takeover",
    digest,
    installationGeneration: 1,
    grantedAt: new Date(),
  });
  const store = makeTempDir("secant-takeover-store-");
  const first = openRunGroup(store, f.workspace, {
    selfPid: 1000,
    isOwnerAlive: () => true,
  });
  t.after(() => first.close());
  const created = first.createRun({
    operationId: "foreign-live",
    bundleSnapshotDigest: digest,
    launch: {},
    at: new Date(),
  });
  assert.equal(created.outcome, "created");
  const priorOwner = first.acquireRun(created.runId);
  assert.ok(priorOwner);
  t.after(() => priorOwner.close());
  priorOwner.writeState("running");

  const second = openRunGroup(store, f.workspace, {
    selfPid: 2000,
    isOwnerAlive: (pid) => pid === 1000,
  });
  t.after(() => second.close());
  const app = createApplication({
    catalog: f.catalog,
    launchWorkspacePath: f.workspace,
    hostPlatform: hostPlatform(),
    runGroup: second,
    runExecution,
  });
  const result = runResult(app, created.runId);
  assert.ok(result.found);
  assert.deepEqual(result.run.liveness, {
    state: "live-elsewhere",
    ownerPid: 1000,
  });
  const offer = result.run.actionOffers.find(
    (candidate) => candidate.action === "resume-run",
  );
  assert.deepEqual(offer?.takeover, { ownerPid: 1000 });
  assert.ok(offer?.takeover);

  const refused = app.projectionPort.submit({
    operationId: "plain-resume",
    operation: "resume-run",
    input: { runId: created.runId },
  });
  assert.equal(refused.admitted, false);
  if (!refused.admitted) {
    assert.equal(refused.problem.code, "run-live-elsewhere");
    assert.equal(refused.problem.details?.ownerPid, "1000");
  }

  const takeover = app.projectionPort.submit({
    operationId: "takeover-resume",
    operation: "resume-run",
    input: { runId: offer.runId, takeover: offer.takeover },
  });
  assert.ok(takeover.admitted);
  assert.deepEqual(await settled(app, takeover.operationId), {
    status: "applied",
  });
  assert.equal(runResult(app, created.runId).found, true);
  assert.equal(priorOwner.writeState("running").ok, false);
});

test("a fresh Application (no in-process tracking) reads a Run back from its stored bytes", async (t) => {
  const f = fixture(t);
  const { id, digest } = installCommandBundle(f, {
    script: "console.log('persisted-output')",
  });
  f.catalog.approveWorkspace(f.workspace, new Date());
  const admission = f.app.projectionPort.submit({
    operationId: "op-1",
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {}, trustDigest: digest },
  });
  assert.ok(admission.admitted);
  const runId = admission.runId!;
  await settled(f.app, admission.operationId);

  // A second Application over the same Catalog and Run Store has no tracking for
  // this Run, so it must re-derive the routing from the pinned bytes — the
  // `run show` path a separate process takes.
  const fresh = createApplication({
    catalog: f.catalog,
    launchWorkspacePath: f.workspace,
    runGroup: f.runGroup,
    runExecution,
  });
  const result = runResult(fresh, runId);
  assert.ok(result.found);
  if (!result.found) throw new Error("unreachable");
  assert.equal(result.run.state, "succeeded");
  assert.equal(result.run.bundle.id, id);
  assert.equal(result.run.progress[0]!.status, "succeeded");
  const output = result.run.outputs.find((o) => o.name === "output");
  assert.ok(output);
  const read = fresh.projectionPort.readResource(output.reference);
  assert.ok(read.found);
  if (read.found) assert.match(read.content, /persisted-output/);
});

// --- Repeat groups (#84, ADR 0020) -----------------------------------------

/** Build+install a Repeat-group Bundle and return its installed digest. */
function installRepeatBundle(
  f: Fixture,
  options: RepeatBundleOptions,
): { id: string; digest: string } {
  const bundle = writeRepeatBundle(options);
  const built = f.app.bundleManagement.build(bundle.folder, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog.listEntries().find((e) => e.id === bundle.id);
  assert.ok(entry);
  return { id: bundle.id, digest: entry.digest };
}

/** Launch an installed Bundle in an approved Workspace, returning the Run id. */
async function launch(f: Fixture, id: string, digest: string): Promise<string> {
  f.catalog.approveWorkspace(f.workspace, new Date());
  const admission = f.app.projectionPort.submit({
    operationId: `op-${id}`,
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {}, trustDigest: digest },
  });
  assert.ok(admission.admitted);
  await settled(f.app, admission.operationId);
  return admission.runId!;
}

test("a Repeat group that always fails rests blocked and surfaces the checkpoint facts", async (t) => {
  const f = fixture(t);
  const { id, digest } = installRepeatBundle(f, {
    interval: 3,
    message: "human, please look",
  });
  const runId = await launch(f, id, digest);

  const result = runResult(f.app, runId);
  assert.ok(result.found);
  if (!result.found) throw new Error("unreachable");
  const run = result.run;
  assert.equal(run.state, "blocked");

  const checkpoint = run.checkpoint;
  assert.ok(checkpoint);
  if (checkpoint === undefined) throw new Error("unreachable");
  assert.equal(checkpoint.message, "human, please look");
  assert.equal(checkpoint.interval, 3);
  assert.equal(checkpoint.completedIterations, 3);
  assert.equal(checkpoint.latestVerdict.name, "passing");
  assert.equal(checkpoint.latestVerdict.value, "fail");

  // The Gate is derived from the current Step Attempt: the last iteration's
  // `check` Attempt.
  assert.equal(checkpoint.gate.shape, "approve-reject");
  assert.equal(checkpoint.gate.stepId, "check");
  const log = f.runGroup.acquireRun(runId)!;
  t.after(() => log.close());
  const lastAttempt = log.attemptLog().at(-1)!;
  assert.equal(checkpoint.gate.attemptId, lastAttempt.attemptId);

  // Progress marks the loop Step blocked; the timeline records each iteration and
  // the block.
  assert.equal(run.progress.find((s) => s.id === "check")!.status, "blocked");
  assert.equal(run.timeline.filter((e) => e.event === "iteration").length, 3);
  assert.ok(run.timeline.some((e) => e.event === "checkpoint-blocked"));

  // The latest fail Verdict is reachable by reference (references to the latest
  // output), and reads `fail`.
  const verdictRead = f.app.projectionPort.readResource(
    checkpoint.latestVerdict.reference,
  );
  assert.ok(verdictRead.found);
  if (verdictRead.found) assert.equal(verdictRead.content, "fail");
});

test("a Repeat group that fails twice then passes rests succeeded with three iterations", async (t) => {
  const f = fixture(t);
  const { id, digest } = installRepeatBundle(f, { interval: 5, passAt: 3 });
  const runId = await launch(f, id, digest);

  const result = runResult(f.app, runId);
  assert.ok(result.found);
  if (!result.found) throw new Error("unreachable");
  const run = result.run;
  assert.equal(run.state, "succeeded");
  assert.equal(run.checkpoint, undefined);
  // The timeline shows the three iterations (one per Verdict).
  assert.equal(run.timeline.filter((e) => e.event === "iteration").length, 3);
  const passing = run.outputs.find((o) => o.name === "passing");
  assert.ok(passing);
  const read = f.app.projectionPort.readResource(passing.reference);
  assert.ok(read.found);
  if (read.found) assert.equal(read.content, "pass");
});

test("a Repeat group already passing before entry runs zero iterations and the Run continues", async (t) => {
  const f = fixture(t);
  // baselinePass binds `passing` = pass before the group; the group's check would
  // fail, but it must never run.
  const { id, digest } = installRepeatBundle(f, {
    interval: 3,
    baselinePass: true,
  });
  const runId = await launch(f, id, digest);

  const result = runResult(f.app, runId);
  assert.ok(result.found);
  if (!result.found) throw new Error("unreachable");
  assert.equal(result.run.state, "succeeded");
  assert.equal(result.run.checkpoint, undefined);
  // Only the baseline ran: no iteration of the group, so no iteration events.
  assert.equal(
    result.run.timeline.filter((e) => e.event === "iteration").length,
    0,
  );
});

test("reopening the Run Store shows a blocked Run still blocked with the same Gate reference and no new Attempt", async (t) => {
  // Self-contained so a second Run Store can reopen the same on-disk store — the
  // separate-process `run show` path.
  const home = makeTempDir("secant-reopen-home-");
  const storeDir = makeTempDir("secant-reopen-store-");
  const workspace = realpathSync.native(makeTempDir("secant-reopen-ws-"));

  const catalog = openCatalog(home);
  t.after(() => catalog.close());
  const runGroup = openRunGroup(storeDir, workspace);
  const app = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution,
  });
  const f: Fixture = { app, catalog, runGroup, workspace };
  const { id, digest } = installRepeatBundle(f, { interval: 2 });
  const runId = await launch(f, id, digest);

  const before = runResult(app, runId);
  assert.ok(before.found);
  if (!before.found) throw new Error("unreachable");
  assert.equal(before.run.state, "blocked");
  const gateBefore = before.run.checkpoint!.gate;
  const attemptsBefore = runGroup.acquireRun(runId)!;
  const countBefore = attemptsBefore.attemptLog().length;
  attemptsBefore.close();
  runGroup.close();

  // Reopen the same store in a fresh Run Group + Application, as a new process
  // would. The block is re-derived from the current Step Attempt, adding none.
  const reopened = openRunGroup(storeDir, workspace);
  t.after(() => reopened.close());
  const freshApp = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup: reopened,
    runExecution,
  });
  const after = runResult(freshApp, runId);
  assert.ok(after.found);
  if (!after.found) throw new Error("unreachable");
  assert.equal(after.run.state, "blocked");
  assert.equal(after.run.checkpoint!.gate.attemptId, gateBefore.attemptId);
  assert.equal(after.run.checkpoint!.gate.stepId, gateBefore.stepId);

  const attemptsAfter = reopened.acquireRun(runId)!;
  assert.equal(attemptsAfter.attemptLog().length, countBefore);
  attemptsAfter.close();
});

test("a launched Run before its first Attempt reads running with every Step pending", async (t) => {
  // Hold settlement so the Run is admitted but never executed: the Run Store still
  // records its pre-start `created` state, but the client vocabulary has no
  // `created` — a launched Run reads `running` from the moment it is admitted
  // (#98 A7) — and no Attempt has settled, so every Step is still pending.
  const held: (() => void)[] = [];
  const f = fixture(t, { scheduleSettlement: (settle) => held.push(settle) });
  const { id, digest } = installCommandBundle(f);
  f.catalog.approveWorkspace(f.workspace, new Date());
  const admission = f.app.projectionPort.submit({
    operationId: "op-created",
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {}, trustDigest: digest },
  });
  assert.ok(admission.admitted);

  const result = runResult(f.app, admission.runId!);
  assert.ok(result.found);
  if (!result.found) throw new Error("unreachable");
  assert.equal(result.run.state, "running");
  // A Step that has not started is pending, not running.
  assert.ok(result.run.progress.every((s) => s.status === "pending"));
});

test("the timeline is ordered by time, so a later event never precedes an earlier Attempt (#98 A2)", (t) => {
  const f = fixture(t);
  const { digest } = installCommandBundle(f);
  const t0 = "2026-09-15T10:00:00.000Z"; // run created
  const t1 = "2026-09-15T10:00:01.000Z"; // Attempt settled
  const t2 = "2026-09-15T10:00:02.000Z"; // trust granted (later)
  const created = f.runGroup.createRun({
    operationId: "op-tl",
    bundleSnapshotDigest: digest,
    launch: {},
    at: new Date(t0),
  });
  assert.ok(created.outcome === "created");
  if (created.outcome !== "created") throw new Error("unreachable");
  const owner = f.runGroup.acquireRun(created.runId)!;
  // An Attempt at t1, then a trust grant at t2 (later). Emitted category by category
  // the grant — an earlier category — would precede the Attempt; ordered by `at` it
  // must not, so a later event never moves an earlier Attempt.
  const published = owner.publishAttempt({
    attemptId: "a1",
    outcome: "failed",
    required: [],
    outputs: [],
    at: new Date(t1),
    advanceState: "failed",
  });
  assert.ok(published.ok);
  owner.close();
  f.runGroup.endRun(created.runId);
  f.catalog.grantTrust({
    operationId: "grant-late",
    digest,
    installationGeneration: 1,
    grantedAt: new Date(t2),
  });

  const result = runResult(f.app, created.runId);
  assert.ok(result.found);
  if (!result.found) throw new Error("unreachable");
  const timeline = result.run.timeline;
  // Non-decreasing by `at`.
  for (let i = 1; i < timeline.length; i++) {
    assert.ok(
      timeline[i - 1]!.at <= timeline[i]!.at,
      `timeline out of order at ${i}`,
    );
  }
  // The later trust grant sorts after the earlier Attempt, not before it.
  const attemptIdx = timeline.findIndex((e) => e.event === "attempt-settled");
  const trustIdx = timeline.findIndex((e) => e.event === "trust-granted");
  assert.ok(attemptIdx !== -1 && trustIdx !== -1);
  assert.ok(attemptIdx < trustIdx);
});
