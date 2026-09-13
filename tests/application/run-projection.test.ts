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
} from "../helpers/commandBundle.js";
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

test("a launch refused workspace-busy grants no trust (the grant follows Run creation)", async (t) => {
  // Hold settlement so the first Run stays live and holds the Workspace claim.
  const held: (() => void)[] = [];
  const f = fixture(t, { scheduleSettlement: (settle) => held.push(settle) });
  const first = installCommandBundle(f, { id: "dev.secant.first" });
  const second = installCommandBundle(f, { id: "dev.secant.second" });
  f.catalog.approveWorkspace(f.workspace, new Date());
  const secondEntry = f.catalog
    .listEntries()
    .find((e) => e.id === "dev.secant.second")!;

  // Launch the first Bundle; it creates a live Run and holds the claim (unsettled).
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

  // Launch the (untrusted) second Bundle while the first holds the claim: it is
  // refused workspace-busy, and — crucially — no trust grant is left behind.
  const b = f.app.projectionPort.submit({
    operationId: "op-b",
    operation: "launch-run",
    input: {
      bundle: { id: second.id },
      launchInputs: {},
      trustDigest: second.digest,
    },
  });
  assert.equal(b.admitted, false);
  if (!b.admitted) assert.equal(b.problem.code, "workspace-busy");
  assert.equal(
    f.catalog.getTrustGrant(
      secondEntry.digest,
      secondEntry.installationGeneration,
    ),
    undefined,
  );
});

test("reading a live Run's projection does not fence the owner executing it", async (t) => {
  const f = fixture(t);
  const { digest } = installCommandBundle(f);
  // Simulate another process executing a Run: create it directly on the Run Store
  // and hold an acquired owner, as a live launch process would.
  const created = f.runGroup.createRun({
    operationId: "c",
    bundleSnapshotDigest: digest,
    launch: {},
    at: new Date(),
  });
  assert.ok(created.outcome === "created");
  const owner = f.runGroup.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());
  assert.equal(owner.writeState("running").ok, true);

  // Read the projection through the Port while the Run is live and this
  // Application has no in-process tracking for it — the cross-process `run show`
  // path. It must show the record-level snapshot without acquiring an owner.
  const result = runResult(f.app, created.runId);
  assert.ok(result.found);
  if (result.found) assert.equal(result.run.state, "running");

  // The executing owner's canonical writes still succeed: the read did not bump
  // the fencing epoch, so it did not abort the running Run.
  assert.equal(owner.writeState("running").ok, true);
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
