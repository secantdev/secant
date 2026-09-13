import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  createApplication,
  type Application,
} from "../../src/application/application.js";
import type { OperationOutcome } from "../../src/application/projection-port.js";
import { openCatalog, type Catalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import { openRunGroup, type RunGroup } from "../../src/run/store/store.js";
import { hostPlatform, writeCommandBundle } from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";

interface Fixture {
  readonly app: Application;
  readonly runGroup: RunGroup;
  readonly catalog: Catalog;
  readonly digest: string;
}

function fixture(t: TestContext): Fixture {
  const catalog = openCatalog(makeTempDir("secant-cd-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-cd-ws-"));
  const runGroup = openRunGroup(makeTempDir("secant-cd-store-"), workspace);
  t.after(() => runGroup.close());
  const app = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
    runExecution: ({ routing, owner }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
      }),
  });
  const cmd = writeCommandBundle();
  const built = app.bundleManagement.build(cmd.folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = catalog.listEntries().find((e) => e.id === cmd.id)!;
  return { app, runGroup, catalog, digest: entry.digest };
}

/** Seed a Run and drive it to `state`; `live` leaves the Workspace claim held. */
function seedRun(f: Fixture, state: string, live: boolean): string {
  const created = f.runGroup.createRun({
    operationId: randomUUID(),
    bundleSnapshotDigest: f.digest,
    launch: {},
    at: new Date(),
  });
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") throw new Error("unreachable");
  const owner = f.runGroup.acquireRun(created.runId)!;
  owner.writeState(state);
  owner.close();
  if (!live) f.runGroup.endRun(created.runId);
  return created.runId;
}

function submit(
  app: Application,
  operation: "cancel-run" | "delete-run",
  runId: string,
  operationId: string,
): OperationOutcome {
  const admission = app.projectionPort.submit({
    operationId,
    operation,
    input: { runId },
  });
  assert.ok(admission.admitted);
  const opened = app.projectionPort.openProjection({
    family: "operation",
    operationId,
  });
  const outcome = opened.snapshot.outcome;
  opened.close();
  return outcome;
}

/** The offered actions on the exact `run` Projection. */
function offers(app: Application, runId: string): string[] {
  const opened = app.projectionPort.openProjection({ family: "run", runId });
  const snapshot = opened.snapshot;
  opened.close();
  assert.ok(snapshot.result.found);
  if (!snapshot.result.found) throw new Error("unreachable");
  return snapshot.result.run.actionOffers.map((o) => o.action);
}

test("cancel-run rests a live Run cancelled, keeps its store, and flips the offer", async (t) => {
  const f = fixture(t);
  const runId = seedRun(f, "running", true);
  // While live, the run Projection offers cancel, not delete.
  assert.deepEqual(offers(f.app, runId), ["cancel-run"]);

  const outcome = submit(f.app, "cancel-run", runId, "op-cancel");
  assert.equal(outcome.status, "applied");

  const read = f.runGroup.readRun(runId);
  assert.ok(read.ok);
  if (read.ok) assert.equal(read.run.state, "cancelled");
  // The claim is released and the Run now offers delete, not cancel.
  assert.equal(
    f.runGroup.listRuns().some((r) => r.runId === runId && r.live),
    false,
  );
  assert.deepEqual(offers(f.app, runId), ["delete-run"]);
});

test("cancel-run on a resting Run is refused and offers no cancel", async (t) => {
  const f = fixture(t);
  const runId = seedRun(f, "succeeded", false);
  assert.deepEqual(offers(f.app, runId), ["delete-run"]);

  const outcome = submit(f.app, "cancel-run", runId, "op-cancel");
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "run-not-live");
  }
  // Unchanged: the Run is still recorded and still resting.
  const read = f.runGroup.readRun(runId);
  assert.ok(read.ok);
  if (read.ok) assert.equal(read.run.state, "succeeded");
});

test("delete-run removes a resting Run's store and is idempotent per operation id", async (t) => {
  const f = fixture(t);
  const runId = seedRun(f, "failed", false);

  const first = submit(f.app, "delete-run", runId, "op-del");
  assert.equal(first.status, "applied");
  // The store is gone: unknown to both list and readRun.
  assert.equal(
    f.runGroup.listRuns().some((r) => r.runId === runId),
    false,
  );
  assert.equal(f.runGroup.readRun(runId).ok, false);

  // Same operation id replays applied (no throw, no second effect).
  const replay = submit(f.app, "delete-run", runId, "op-del");
  assert.equal(replay.status, "applied");
  // A fresh operation id on the already-gone Run still settles applied (the
  // admitted delete is a no-op on an absent Run).
  const again = submit(f.app, "delete-run", runId, "op-del-2");
  assert.equal(again.status, "applied");
});

test("delete-run on a live Run is refused, leaving it present", async (t) => {
  const f = fixture(t);
  const runId = seedRun(f, "running", true);

  const outcome = submit(f.app, "delete-run", runId, "op-del");
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "run-is-live");
  }
  assert.equal(f.runGroup.readRun(runId).ok, true);
});
