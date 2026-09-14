import assert from "node:assert/strict";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createApplication,
  type Application,
  type RunExecution,
} from "../../src/application/application.js";
import { openCatalog, type Catalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import { openRunGroup, type RunGroup } from "../../src/run/store/store.js";
import {
  ensureRuntimeOnPath,
  hostPlatform,
  writeMaterializationBundle,
} from "../helpers/commandBundle.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";

// #88 through the Projection Port: a `home: workspace` conflict is visible in the
// `run` Projection (state `halted`, a blocked Step, a timeline event naming the
// path, and the diagnostic reachable by reference), and the resume Operation
// continues the Run once the file is restored.

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
  readonly catalogHome: string;
  readonly runGroup: RunGroup;
  readonly workspace: string;
}

function fixture(t: TestContext): Fixture {
  const catalogHome = makeTempDir("secant-mat-home-");
  const catalog = openCatalog(catalogHome);
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-mat-ws-"));
  const runGroup = openRunGroup(makeTempDir("secant-mat-store-"), workspace);
  t.after(() => runGroup.close());
  const app = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution,
  });
  return { app, catalog, catalogHome, runGroup, workspace };
}

function installMaterializationBundle(
  f: Fixture,
  tamper: "modify" | "delete" | "none",
): { id: string; digest: string } {
  const bundle = writeMaterializationBundle({
    workspaceAbsPath: f.workspace,
    tamper,
  });
  const built = f.app.bundleManagement.build(bundle.folder, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog.listEntries().find((e) => e.id === bundle.id);
  assert.ok(entry);
  return { id: bundle.id, digest: entry.digest };
}

async function settled(f: Fixture, operationId: string) {
  return awaitSettled(f.app.projectionPort, operationId);
}

async function launch(f: Fixture, id: string, digest: string): Promise<string> {
  f.catalog.approveWorkspace(f.workspace, new Date());
  const admission = f.app.projectionPort.submit({
    operationId: `launch-${Math.random()}`,
    operation: "launch-run",
    input: { bundle: { id }, launchInputs: {}, trustDigest: digest },
  });
  assert.ok(admission.admitted);
  assert.ok(admission.runId);
  await settled(f, admission.operationId);
  return admission.runId;
}

function runView(f: Fixture, runId: string) {
  const opened = f.app.projectionPort.openProjection({ family: "run", runId });
  const result = opened.snapshot.result;
  opened.close();
  assert.ok(result.found);
  return result.run;
}

test("a modified Workspace copy is a visible conflict resting the Run halted", async (t) => {
  const f = fixture(t);
  const { id, digest } = installMaterializationBundle(f, "modify");
  const runId = await launch(f, id, digest);

  const run = runView(f, runId);
  assert.equal(run.state, "halted");
  // The conflict names the artifact and its declared path.
  assert.ok(run.conflict);
  assert.equal(run.conflict.artifactName, "x");
  assert.equal(run.conflict.path, "out/x.txt");
  // The blocked Step is the one that would have used it (index 2: consume).
  assert.equal(run.progress[2]!.id, "consume");
  assert.equal(run.progress[2]!.status, "blocked");
  assert.equal(run.progress[0]!.status, "succeeded");
  // A timeline event names the path.
  const event = run.timeline.find(
    (e) => e.event === "materialization-conflict",
  );
  assert.ok(event);
  assert.equal(event.detail, "out/x.txt");
  // The diagnostic is readable through its reference (never inlined).
  const read = f.app.projectionPort.readResource(run.conflict.reference);
  assert.ok(read.found);
  assert.equal(read.type, "diagnostic");
  assert.match(read.content, /out\/x\.txt/);
  // The consuming Step never ran, so its output is unbound.
  assert.ok(!run.outputs.some((o) => o.name === "y"));
});

test("a deleted Workspace copy also rests the Run halted", async (t) => {
  const f = fixture(t);
  const { id, digest } = installMaterializationBundle(f, "delete");
  const run = runView(f, await launch(f, id, digest));
  assert.equal(run.state, "halted");
  assert.ok(run.conflict);
  assert.equal(run.conflict.path, "out/x.txt");
});

test("resuming after restoring the file continues the Run to succeeded", async (t) => {
  const f = fixture(t);
  const { id, digest } = installMaterializationBundle(f, "modify");
  const runId = await launch(f, id, digest);
  assert.equal(runView(f, runId).state, "halted");

  // Restore the file to its bound content, then resume through the Port.
  writeFileSync(join(f.workspace, "out", "x.txt"), "materialized-content");
  const admission = f.app.projectionPort.submit({
    operationId: "resume-1",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(admission.admitted);
  await settled(f, admission.operationId);

  const run = runView(f, runId);
  assert.equal(run.state, "succeeded");
  assert.equal(run.conflict, undefined);
  // The consuming Step ran on resume and bound its output.
  assert.ok(run.outputs.some((o) => o.name === "y"));
  assert.equal(
    readFileSync(join(f.workspace, "out", "x.txt"), "utf8"),
    "materialized-content",
  );
});

test("resume of an unknown Run is refused, not thrown", (t) => {
  const f = fixture(t);
  const admission = f.app.projectionPort.submit({
    operationId: "resume-unknown",
    operation: "resume-run",
    input: { runId: "no-such-run" },
  });
  assert.ok(!admission.admitted);
  assert.equal(admission.problem.code, "run-not-found");
});

test("resume of a Run that is not halted is refused", async (t) => {
  const f = fixture(t);
  // A conflict-free Bundle runs to succeeded; resuming it is refused.
  const { id, digest } = installMaterializationBundle(f, "none");
  const runId = await launch(f, id, digest);
  assert.equal(runView(f, runId).state, "succeeded");

  const admission = f.app.projectionPort.submit({
    operationId: "resume-done",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(!admission.admitted);
  assert.equal(admission.problem.code, "run-not-resumable");
});

test("resume of a live (running) Run is refused, not thrown (#86)", (t) => {
  const f = fixture(t);
  // A record left `running` (a live Run, here or elsewhere) is not resumable:
  // resuming would fence the process driving it.
  const created = f.runGroup.createRun({
    operationId: "live-1",
    bundleSnapshotDigest: "sha256:deadbeef",
    launch: {},
    at: new Date(),
  });
  assert.ok(created.outcome === "created");
  const owner = f.runGroup.acquireRun(created.runId);
  assert.ok(owner);
  assert.deepEqual(owner.writeState("running"), { ok: true });
  owner.close();

  const admission = f.app.projectionPort.submit({
    operationId: "resume-live",
    operation: "resume-run",
    input: { runId: created.runId },
  });
  assert.ok(!admission.admitted);
  assert.equal(admission.problem.code, "run-not-resumable");
});

test("resume of a Run whose stored launch payload is not a string map is refused before Preflight (A10)", (t) => {
  const f = fixture(t);
  // A drifted run.db: the launch row is not the string map Preflight consumes. It
  // is created malformed and rested `failed` so it reaches the resume read. The
  // pinned digest is not installed, so if the launch cast were still trusted the
  // resume would fail later with `bundle-bytes-missing`; asserting
  // `run-store-damaged` proves the payload is refused first, ahead of Preflight.
  const created = f.runGroup.createRun({
    operationId: "bad-launch-1",
    bundleSnapshotDigest: "sha256:deadbeef",
    launch: ["not", "a", "string", "map"],
    at: new Date(),
  });
  assert.ok(created.outcome === "created");
  const owner = f.runGroup.acquireRun(created.runId);
  assert.ok(owner);
  assert.deepEqual(owner.writeState("failed"), { ok: true });
  owner.close();

  const admission = f.app.projectionPort.submit({
    operationId: "resume-bad-launch",
    operation: "resume-run",
    input: { runId: created.runId },
  });
  assert.ok(!admission.admitted);
  assert.equal(admission.problem.code, "run-store-damaged");
});

test("resume is idempotent per operation id (#86, AC3)", async (t) => {
  const f = fixture(t);
  const { id, digest } = installMaterializationBundle(f, "modify");
  const runId = await launch(f, id, digest);
  assert.equal(runView(f, runId).state, "halted");
  // Restore the tampered Workspace copy so the resume can complete.
  writeFileSync(join(f.workspace, "out", "x.txt"), "materialized-content");

  const first = f.app.projectionPort.submit({
    operationId: "resume-idem",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(first.admitted);
  await settled(f, first.operationId);
  assert.equal(runView(f, runId).state, "succeeded");

  // A second submit with the same operation id replays: same Run, no re-execution.
  const second = f.app.projectionPort.submit({
    operationId: "resume-idem",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(second.admitted);
  await settled(f, second.operationId);
  assert.equal(second.runId, first.runId);
  assert.equal(runView(f, runId).state, "succeeded");
});

test("resume after the pinned digest is no longer installed names the reinstall (#86, AC3)", async (t) => {
  const f = fixture(t);
  const { id, digest } = installMaterializationBundle(f, "modify");
  const runId = await launch(f, id, digest);
  assert.equal(runView(f, runId).state, "halted");
  writeFileSync(join(f.workspace, "out", "x.txt"), "materialized-content");

  // Replace the pinned install: remove the exact managed bytes the Run pinned.
  rmSync(join(f.catalogHome, "bundles", `${digest}.wfb`));

  const admission = f.app.projectionPort.submit({
    operationId: "resume-replaced",
    operation: "resume-run",
    input: { runId },
  });
  assert.ok(!admission.admitted);
  assert.equal(admission.problem.code, "bundle-bytes-missing");
  assert.match(admission.problem.remediation, /[Rr]einstall/);
  // Refused before authorizing work: the Run stays halted.
  assert.equal(runView(f, runId).state, "halted");
});
