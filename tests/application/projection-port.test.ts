import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApplication } from "../helpers/application.js";
import type {
  OperationSnapshot,
  ProjectionPort,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { makeTempDir } from "../helpers/tempDir.js";

async function fixture(
  t: TestContext,
): Promise<{ port: ProjectionPort; workspace: string }> {
  const catalog = await openCatalog(makeTempDir("secant-port-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-port-ws-"));
  const { projectionPort } = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    harnessRegistry: [
      {
        choice: {
          id: "claude-code",
          name: "Claude Code",
          availability: "available",
        },
        servedCapabilities: ["agent-turn", "interactive-turns"],
        discover: () => ({ kind: "found" }),
      },
      {
        choice: { id: "codex", name: "Codex", availability: "available" },
        servedCapabilities: ["agent-turn", "interactive-turns"],
        discover: () => ({ kind: "found" }),
      },
    ],
  });
  return { port: projectionPort, workspace };
}

// A fixture that holds Operation settlement so the `pending` outcome is
// observable without a real long-lived Run. `releaseAll` settles every
// operation submitted so far, in submission order.
async function deferredFixture(t: TestContext): Promise<{
  port: ProjectionPort;
  workspace: string;
  releaseAll: () => void;
}> {
  const catalog = await openCatalog(makeTempDir("secant-port-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-port-ws-"));
  const held: (() => void)[] = [];
  const { projectionPort } = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    scheduleSettlement: (settle) => {
      held.push(settle);
    },
  });
  return {
    port: projectionPort,
    workspace,
    releaseAll: () => {
      while (held.length > 0) held.shift()?.();
    },
  };
}

test("workspace opens unapproved with the approve-workspace offer", async (t) => {
  const { port, workspace } = await fixture(t);
  const opened = port.openProjection({ family: "workspace" });
  t.after(() => opened.close());

  const snapshot = opened.snapshot as WorkspaceSnapshot;
  assert.equal(snapshot.family, "workspace");
  assert.equal(snapshot.path, workspace);
  assert.equal(snapshot.approval.state, "unapproved");
  assert.deepEqual(snapshot.harnesses, [
    { id: "claude-code", name: "Claude Code", availability: "available" },
    { id: "codex", name: "Codex", availability: "available" },
  ]);
  assert.deepEqual(snapshot.actionOffers, [
    { action: "approve-workspace", input: { path: workspace } },
  ]);
});

test("approving flips the open workspace projection and settles applied", async (t) => {
  const { port, workspace } = await fixture(t);
  const workspaceView = port.openProjection({ family: "workspace" });
  t.after(() => workspaceView.close());
  const updates = workspaceView.updates[Symbol.asyncIterator]();

  const admission = port.submit({
    operationId: "op-1",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.deepEqual(admission, { admitted: true, operationId: "op-1" });

  const operationView = port.openProjection({
    family: "operation",
    operationId: "op-1",
  });
  assert.deepEqual((operationView.snapshot as OperationSnapshot).outcome, {
    status: "applied",
  });
  operationView.close();

  const update = await updates.next();
  assert.equal(update.done, false);
  assert.ok(update.value && update.value.kind === "durable");
  const flipped = update.value.snapshot as WorkspaceSnapshot;
  assert.equal(flipped.approval.state, "approved");
  assert.deepEqual(flipped.actionOffers, []);
});

test("a workspace opened after approval is already approved", async (t) => {
  const { port, workspace } = await fixture(t);
  port.submit({
    operationId: "op-1",
    operation: "approve-workspace",
    input: { path: workspace },
  });

  const opened = port.openProjection({ family: "workspace" });
  t.after(() => opened.close());
  const snapshot = opened.snapshot as WorkspaceSnapshot;
  assert.equal(snapshot.approval.state, "approved");
  assert.equal(snapshot.actionOffers.length, 0);
  if (snapshot.approval.state === "approved") {
    assert.match(snapshot.approval.approvedAt, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test("the same operation id replays and different input is rejected", async (t) => {
  const { port, workspace } = await fixture(t);
  const first = port.submit({
    operationId: "op-1",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  const replay = port.submit({
    operationId: "op-1",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.deepEqual(first, replay);

  const conflict = port.submit({
    operationId: "op-1",
    operation: "approve-workspace",
    input: { path: `${workspace}-other` },
  });
  assert.equal(conflict.admitted, false);
  if (!conflict.admitted) {
    assert.equal(conflict.problem.code, "operation-id-reused");
  }
});

test("approving a non-existent path settles not-applied with a Problem", async (t) => {
  const { port } = await fixture(t);
  const missing = join(makeTempDir("secant-port-missing-"), "does-not-exist");
  const admission = port.submit({
    operationId: "op-x",
    operation: "approve-workspace",
    input: { path: missing },
  });
  assert.equal(admission.admitted, true);

  const operationView = port.openProjection({
    family: "operation",
    operationId: "op-x",
  });
  t.after(() => operationView.close());
  const outcome = (operationView.snapshot as OperationSnapshot).outcome;
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "workspace-path-not-found");
    assert.equal(outcome.problem.possibleEffects, "none");
    assert.ok(outcome.problem.remediation.length > 0);
  }
});

test("a first open reports fresh catch-up for both families", async (t) => {
  const { port, workspace } = await fixture(t);
  const workspaceView = port.openProjection({ family: "workspace" });
  t.after(() => workspaceView.close());
  assert.equal(workspaceView.catchUp, "fresh");

  port.submit({
    operationId: "op-1",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  const operationView = port.openProjection({
    family: "operation",
    operationId: "op-1",
  });
  t.after(() => operationView.close());
  assert.equal(operationView.catchUp, "fresh");
});

test("a deferred operation shows pending, then delivers the settled outcome as a durable update, and stays open", async (t) => {
  const { port, workspace, releaseAll } = await deferredFixture(t);
  const admission = port.submit({
    operationId: "op-1",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.deepEqual(admission, { admitted: true, operationId: "op-1" });

  const operationView = port.openProjection({
    family: "operation",
    operationId: "op-1",
  });
  t.after(() => operationView.close());
  assert.deepEqual((operationView.snapshot as OperationSnapshot).outcome, {
    status: "pending",
  });

  const updates = operationView.updates[Symbol.asyncIterator]();
  releaseAll();

  const update = await updates.next();
  assert.equal(update.done, false);
  assert.ok(update.value && update.value.kind === "durable");
  assert.deepEqual((update.value.snapshot as OperationSnapshot).outcome, {
    status: "applied",
  });

  // The stream stays open after the settled update until the observer closes it.
  const pending = updates.next();
  let resolved = false;
  void pending.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false);
  operationView.close();
  const closed = await pending;
  assert.equal(closed.done, true);
});

test("re-submitting a pending operation id replays, and different input is rejected", async (t) => {
  const { port, workspace } = await deferredFixture(t);
  const first = port.submit({
    operationId: "op-1",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  // Still pending (settlement is held): a same-input re-submit replays.
  const replay = port.submit({
    operationId: "op-1",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.deepEqual(first, replay);

  const conflict = port.submit({
    operationId: "op-1",
    operation: "approve-workspace",
    input: { path: `${workspace}-other` },
  });
  assert.equal(conflict.admitted, false);
  if (!conflict.admitted) {
    assert.equal(conflict.problem.code, "operation-id-reused");
  }
});

test("opening the operation projection on an unknown id yields a Problem snapshot, not a throw", async (t) => {
  const { port } = await fixture(t);
  const opened = port.openProjection({
    family: "operation",
    operationId: "never-submitted",
  });
  t.after(() => opened.close());
  const outcome = (opened.snapshot as OperationSnapshot).outcome;
  assert.equal(outcome.status, "not-applied");
  if (outcome.status === "not-applied") {
    assert.equal(outcome.problem.code, "operation-not-found");
    assert.ok(outcome.problem.remediation.length > 0);
    assert.equal(outcome.problem.possibleEffects, "none");
  }
});

test("closing a projection twice is a no-op", async (t) => {
  const { port } = await fixture(t);
  const opened = port.openProjection({ family: "workspace" });
  opened.close();
  opened.close();
});
