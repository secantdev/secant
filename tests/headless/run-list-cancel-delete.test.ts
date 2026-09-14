import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { runHeadless } from "../../src/headless/headless.js";
import {
  ensureRuntimeOnPath,
  writeCommandBundle,
} from "../helpers/commandBundle.js";
import { openHeadlessHarness } from "../helpers/headlessHarness.js";

ensureRuntimeOnPath();

function harness(t: TestContext) {
  const h = openHeadlessHarness(t, { slug: "secant-rlcd" });
  const install = async () => {
    const cmd = writeCommandBundle();
    assert.equal(await h.run(["bundle", "build", cmd.folder]), 0);
    h.reset();
    const entry = h.catalog.listEntries().find((e) => e.id === cmd.id)!;
    return { id: cmd.id, digest: entry.digest };
  };
  const launch = async () => {
    const { id, digest } = await install();
    h.catalog.approveWorkspace(h.workspace, new Date());
    await h.run(["run", "launch", id, "--trust", digest]);
    const runId = /^Run (\S+)$/m.exec(h.stdout())![1]!;
    h.reset();
    return runId;
  };
  return { ...h, launch };
}

test("run list on an empty Workspace prints an informational snapshot", async (t) => {
  const h = await harness(t);
  assert.equal(await runHeadless(h.clients, ["run", "list"], h.io), 0);
  assert.match(h.stdout(), /Previous Runs: none yet\./);
});

test("run list shows a launched Run under Today and marks the beginning of history", async (t) => {
  const h = await harness(t);
  const runId = await h.launch();

  assert.equal(await runHeadless(h.clients, ["run", "list"], h.io), 0);
  const out = h.stdout();
  assert.match(out, /Previous Runs:/);
  assert.match(out, /Today:/);
  assert.match(out, new RegExp(runId));
  assert.match(out, /\(beginning of history\)/);
  h.reset();

  assert.equal(
    await runHeadless(h.clients, ["run", "list", "--json"], h.io),
    0,
  );
  const snapshot = JSON.parse(h.stdout()) as {
    family: string;
    rows: { runId: string; group: string }[];
    empty: boolean;
  };
  assert.equal(snapshot.family, "run-list");
  assert.equal(snapshot.empty, false);
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0]!.runId, runId);
  assert.equal(snapshot.rows[0]!.group, "today");
});

test("run show offers delete on a resting Run", async (t) => {
  const h = await harness(t);
  const runId = await h.launch();
  assert.equal(await runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  assert.match(h.stdout(), new RegExp(`run delete ${runId}`));
});

test("run delete removes a resting Run; run show then reports run-not-found", async (t) => {
  const h = await harness(t);
  const runId = await h.launch();

  assert.equal(await runHeadless(h.clients, ["run", "delete", runId], h.io), 0);
  assert.match(h.stdout(), new RegExp(`Deleted run ${runId}`));
  h.reset();

  assert.equal(await runHeadless(h.clients, ["run", "show", runId], h.io), 1);
  assert.match(h.stderr(), /run-not-found/);
  h.reset();

  assert.equal(await runHeadless(h.clients, ["run", "list"], h.io), 0);
  assert.match(h.stdout(), /none yet/);
});

test("run cancel on a resting Run is refused with run-not-live", async (t) => {
  const h = await harness(t);
  const runId = await h.launch();
  assert.equal(await runHeadless(h.clients, ["run", "cancel", runId], h.io), 1);
  assert.match(h.stderr(), /run-not-live/);
});

test("run cancel and run delete without a Run id exit non-zero", async (t) => {
  const h = await harness(t);
  assert.equal(await runHeadless(h.clients, ["run", "cancel"], h.io), 1);
  assert.match(h.stderr(), /missing-run-id/);
  h.reset();
  assert.equal(await runHeadless(h.clients, ["run", "delete"], h.io), 1);
  assert.match(h.stderr(), /missing-run-id/);
});
