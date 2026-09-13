import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  createApplication,
  type RunExecution,
} from "../../src/application/application.js";
import { type HeadlessIO, runHeadless } from "../../src/headless/headless.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import { openRunGroup } from "../../src/run/store/store.js";
import {
  ensureRuntimeOnPath,
  hostPlatform,
  writeCommandBundle,
} from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";

ensureRuntimeOnPath();

async function harness(t: TestContext) {
  const runExecution: RunExecution = ({ routing, owner }) =>
    executeRouting(routing, {
      owner,
      platform: hostPlatform(),
      resolveAsset: () => undefined,
    });
  const catalog = openCatalog(makeTempDir("secant-rlcd-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-rlcd-ws-"));
  const runGroup = openRunGroup(makeTempDir("secant-rlcd-store-"), workspace);
  t.after(() => runGroup.close());
  const clients = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    runGroup,
    runExecution,
  });
  const out: string[] = [];
  const err: string[] = [];
  const io: HeadlessIO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    cwd: () => workspace,
  };
  const install = () => {
    const cmd = writeCommandBundle();
    assert.equal(runHeadless(clients, ["bundle", "build", cmd.folder], io), 0);
    out.length = 0;
    const entry = catalog.listEntries().find((e) => e.id === cmd.id)!;
    return { id: cmd.id, digest: entry.digest };
  };
  const launch = () => {
    const { id, digest } = install();
    catalog.approveWorkspace(workspace, new Date());
    runHeadless(clients, ["run", "launch", id, "--trust", digest], io);
    const runId = /^Run (\S+)$/m.exec(out.join(""))![1]!;
    out.length = 0;
    return runId;
  };
  return {
    clients,
    io,
    launch,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

test("run list on an empty Workspace prints an informational snapshot", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["run", "list"], h.io), 0);
  assert.match(h.stdout(), /Previous Runs: none yet\./);
});

test("run list shows a launched Run under Today and marks the beginning of history", async (t) => {
  const h = await harness(t);
  const runId = h.launch();

  assert.equal(runHeadless(h.clients, ["run", "list"], h.io), 0);
  const out = h.stdout();
  assert.match(out, /Previous Runs:/);
  assert.match(out, /Today:/);
  assert.match(out, new RegExp(runId));
  assert.match(out, /\(beginning of history\)/);
  h.reset();

  assert.equal(runHeadless(h.clients, ["run", "list", "--json"], h.io), 0);
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
  const runId = h.launch();
  assert.equal(runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  assert.match(h.stdout(), new RegExp(`run delete ${runId}`));
});

test("run delete removes a resting Run; run show then reports run-not-found", async (t) => {
  const h = await harness(t);
  const runId = h.launch();

  assert.equal(runHeadless(h.clients, ["run", "delete", runId], h.io), 0);
  assert.match(h.stdout(), new RegExp(`Deleted run ${runId}`));
  h.reset();

  assert.equal(runHeadless(h.clients, ["run", "show", runId], h.io), 1);
  assert.match(h.stderr(), /run-not-found/);
  h.reset();

  assert.equal(runHeadless(h.clients, ["run", "list"], h.io), 0);
  assert.match(h.stdout(), /none yet/);
});

test("run cancel on a resting Run is refused with run-not-live", async (t) => {
  const h = await harness(t);
  const runId = h.launch();
  assert.equal(runHeadless(h.clients, ["run", "cancel", runId], h.io), 1);
  assert.match(h.stderr(), /run-not-live/);
});

test("run cancel and run delete without a Run id exit non-zero", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["run", "cancel"], h.io), 1);
  assert.match(h.stderr(), /missing-run-id/);
  h.reset();
  assert.equal(runHeadless(h.clients, ["run", "delete"], h.io), 1);
  assert.match(h.stderr(), /missing-run-id/);
});
