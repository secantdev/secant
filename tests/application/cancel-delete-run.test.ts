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
import {
  ensureRuntimeOnPath,
  hostPlatform,
  writeCommandBundle,
} from "../helpers/commandBundle.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { makeTempDir } from "../helpers/tempDir.js";

interface Fixture {
  readonly app: Application;
  readonly runGroup: RunGroup;
  readonly catalog: Catalog;
  readonly workspace: string;
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
    runExecution: ({ routing, owner, cancelSignal }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
        // Thread the Application's cancel Seam, as production wiring does, so a
        // cancel of a Run live in this process actually aborts its execution (#98).
        ...(cancelSignal !== undefined ? { cancelSignal } : {}),
      }),
  });
  const cmd = writeCommandBundle();
  const built = app.bundleManagement.build(cmd.folder, { noInstall: false });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = catalog.listEntries().find((e) => e.id === cmd.id)!;
  return { app, runGroup, catalog, workspace, digest: entry.digest };
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

test("cancel-run aborts a Run live in this process, rests it cancelled, and pushes the cancelled snapshot (#98 AC2)", async (t) => {
  ensureRuntimeOnPath();
  const f = fixture(t);
  f.catalog.approveWorkspace(f.workspace, new Date());
  // A Bundle whose command blocks until killed, so the Run stays genuinely live in
  // this process (its child spawned and running) while we cancel it.
  const blocking = writeCommandBundle({
    id: "dev.secant.block",
    script: "setInterval(() => {}, 1_000_000)",
  });
  const built = f.app.bundleManagement.build(blocking.folder, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog.listEntries().find((e) => e.id === blocking.id)!;

  const launch = f.app.projectionPort.submit({
    operationId: "op-launch-block",
    operation: "launch-run",
    input: {
      bundle: { id: blocking.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(launch.admitted);
  const runId = launch.runId!;

  // Open the run Projection before cancelling and collect its durable updates, so
  // we can assert an open observer receives the `cancelled` snapshot (AC2).
  const view = f.app.projectionPort.openProjection({ family: "run", runId });
  const seenStates: string[] = [];
  const draining = (async () => {
    for await (const update of view.updates) {
      if (update.kind === "durable" && update.snapshot.result.found) {
        seenStates.push(update.snapshot.result.run.state);
        if (update.snapshot.result.run.state === "cancelled") return;
      }
      if (update.kind === "closed") return;
    }
  })();

  // The launch Operation is pending while the Run blocks.
  const pending = f.app.projectionPort.openProjection({
    family: "operation",
    operationId: "op-launch-block",
  });
  assert.equal(pending.snapshot.outcome.status, "pending");
  pending.close();

  const cancel = f.app.projectionPort.submit({
    operationId: "op-cancel-block",
    operation: "cancel-run",
    input: { runId },
  });
  assert.ok(cancel.admitted);
  const cancelOutcome = await awaitSettled(
    f.app.projectionPort,
    "op-cancel-block",
  );
  assert.equal(cancelOutcome.status, "applied");

  await draining;
  view.close();

  // The Run rests cancelled — its child was killed and its store kept.
  const read = f.runGroup.readRun(runId);
  assert.ok(read.ok);
  if (read.ok) assert.equal(read.run.state, "cancelled");
  // The claim is released, and an open observer saw the cancelled snapshot.
  assert.equal(
    f.runGroup.listRuns().some((r) => r.runId === runId && r.live),
    false,
  );
  assert.ok(seenStates.includes("cancelled"));
});

test("shutdown aborts a live Run and leaves its claim live for reconciliation (#98 signals)", async (t) => {
  ensureRuntimeOnPath();
  const f = fixture(t);
  f.catalog.approveWorkspace(f.workspace, new Date());
  const blocking = writeCommandBundle({
    id: "dev.secant.block-sig",
    script: "setInterval(() => {}, 1_000_000)",
  });
  const built = f.app.bundleManagement.build(blocking.folder, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = f.catalog.listEntries().find((e) => e.id === blocking.id)!;

  const launch = f.app.projectionPort.submit({
    operationId: "op-launch-sig",
    operation: "launch-run",
    input: {
      bundle: { id: blocking.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(launch.admitted);
  const runId = launch.runId!;

  // Shutdown aborts the live Run and awaits its rest — it resolves only once the
  // child is dead — and leaves the Workspace claim live so the next open reconciles
  // the Run `halted` (it does not rest it `cancelled`, which is cancel-run's job).
  await f.app.shutdown();

  assert.ok(
    f.runGroup.listRuns().some((r) => r.runId === runId && r.live),
    "the claim is left live for the next open to reconcile",
  );
  const read = f.runGroup.readRun(runId);
  assert.ok(read.ok);
  if (read.ok) assert.notEqual(read.run.state, "cancelled");
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

test("a malformed coordination row settles cancel and delete not-applied, never throwing out of submit (#98 A4)", (t) => {
  const catalog = openCatalog(makeTempDir("secant-cd-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-cd-ws-"));
  const real = openRunGroup(makeTempDir("secant-cd-store-"), workspace);
  t.after(() => real.close());
  // A group whose listing throws, as a malformed coordination row makes the real
  // store's listRuns throw. cancel and delete must settle it through their catch —
  // the way run and answer route an execution fault — never throw out of submit.
  const runGroup = {
    ...real,
    listRuns() {
      throw new Error("Run Store: a runs row is malformed.");
    },
  } as unknown as RunGroup;
  const app = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
    runGroup,
  });

  for (const operation of ["cancel-run", "delete-run"] as const) {
    const outcome = submit(app, operation, "run-x", `op-${operation}`);
    assert.equal(outcome.status, "not-applied");
    if (outcome.status === "not-applied") {
      assert.equal(outcome.problem.code, "run-store-damaged");
    }
  }
});
