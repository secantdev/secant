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

const runExecution: RunExecution = ({ routing, owner }) =>
  executeRouting(routing, {
    owner,
    platform: hostPlatform(),
    resolveAsset: () => undefined,
  });

async function harness(t: TestContext) {
  const catalog = openCatalog(makeTempDir("secant-runcli-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-runcli-ws-"));
  const runGroup = openRunGroup(makeTempDir("secant-runcli-store-"), workspace);
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
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    cwd: () => workspace,
  };
  return {
    clients,
    catalog,
    workspace,
    io,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
    install: (opts?: Parameters<typeof writeCommandBundle>[0]) => {
      const cmd = writeCommandBundle(opts);
      assert.equal(
        runHeadless(clients, ["bundle", "build", cmd.folder], io),
        0,
      );
      out.length = 0;
      const entry = catalog.listEntries().find((e) => e.id === cmd.id);
      assert.ok(entry);
      return { id: cmd.id, digest: entry.digest };
    },
    approve: () => catalog.approveWorkspace(workspace, new Date()),
  };
}

test("run launch on an untrusted digest prints the summary, warning, and digest, and exits non-zero", async (t) => {
  const h = await harness(t);
  const { id, digest } = h.install();
  h.approve();

  assert.equal(runHeadless(h.clients, ["run", "launch", id], h.io), 1);
  const err = h.stderr();
  assert.match(err, /bundle-trust-required/);
  assert.match(err, /Execution summary/);
  assert.match(err, /current user's authority/);
  assert.match(err, new RegExp(digest));
  assert.equal(h.stdout(), "");
});

test("run launch --trust runs to succeeded, and a second launch needs no trust", async (t) => {
  const h = await harness(t);
  const { id, digest } = h.install();
  h.approve();

  assert.equal(
    runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io),
    0,
  );
  assert.match(h.stdout(), /^Run /m);
  assert.match(h.stdout(), /^State: succeeded$/m);

  h.reset();
  assert.equal(runHeadless(h.clients, ["run", "launch", id], h.io), 0);
  assert.match(h.stdout(), /^State: succeeded$/m);
});

test("run launch on an uninstalled Bundle exits non-zero with a Problem", async (t) => {
  const h = await harness(t);
  h.approve();
  assert.equal(
    runHeadless(h.clients, ["run", "launch", "io.example.absent"], h.io),
    1,
  );
  assert.match(h.stderr(), /bundle-not-installed/);
});

test("run launch without an id exits non-zero", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["run", "launch"], h.io), 1);
  assert.match(h.stderr(), /missing-bundle-id/);
});

test("run show prints identity, state, progress, position, and timeline; --json carries the snapshot", async (t) => {
  const h = await harness(t);
  const { id, digest } = h.install({ script: "console.log('shown-output')" });
  h.approve();
  assert.equal(
    runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io),
    0,
  );
  const runId = h.stdout().match(/^Run (\S+)/m)?.[1];
  assert.ok(runId);
  h.reset();

  assert.equal(runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  const text = h.stdout();
  assert.match(text, new RegExp(`Run ${runId}`));
  assert.match(text, /State: succeeded/);
  assert.match(text, /Progress:/);
  assert.match(text, /run-check \(command\): succeeded/);
  assert.match(text, /Position: at rest/);
  assert.match(text, /Timeline:/);
  assert.match(text, /run-created/);

  h.reset();
  assert.equal(
    runHeadless(h.clients, ["run", "show", runId, "--json"], h.io),
    0,
  );
  const snapshot = JSON.parse(h.stdout()) as {
    family: string;
    result: { found: boolean; run: { state: string } };
  };
  assert.equal(snapshot.family, "run");
  assert.equal(snapshot.result.run.state, "succeeded");
});

test("run launch of a Run that rests failed exits non-zero and shows the failed Step", async (t) => {
  const h = await harness(t);
  // A resolvable executable whose Attempt fails at runtime: the command dies by
  // signal, so spawnSync reports no exit status and the Attempt is failed (a clean
  // non-zero exit would instead be a `fail` verdict on a succeeded Attempt). An
  // off-PATH executable is now refused by Preflight before a Run exists (see
  // tests/application/preflight.test.ts).
  const { id, digest } = h.install({
    script: "process.kill(process.pid, 'SIGKILL')",
    retry: 0,
  });
  h.approve();

  assert.equal(
    runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io),
    1,
  );
  assert.match(h.stdout(), /^State: failed$/m);
  const runId = h.stdout().match(/^Run (\S+)/m)?.[1];
  assert.ok(runId);

  h.reset();
  assert.equal(runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  assert.match(h.stdout(), /run-check \(command\): failed/);
});

test("run show on an unknown Run id exits non-zero with a Problem", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["run", "show", "no-such-run"], h.io), 1);
  assert.match(h.stderr(), /run-not-found/);
});

test("run read returns a text Artifact's content and a Verdict's value by reference", async (t) => {
  const h = await harness(t);
  const { id, digest } = h.install({ script: "console.log('read-me')" });
  h.approve();
  assert.equal(
    runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io),
    0,
  );
  const runId = h.stdout().match(/^Run (\S+)/m)?.[1];
  assert.ok(runId);

  h.reset();
  assert.equal(
    runHeadless(h.clients, ["run", "read", `${runId}/output`], h.io),
    0,
  );
  assert.match(h.stdout(), /read-me/);

  h.reset();
  assert.equal(
    runHeadless(h.clients, ["run", "read", `${runId}/verdict`], h.io),
    0,
  );
  assert.equal(h.stdout(), "pass\n");
});

test("run read of an unknown output exits non-zero", async (t) => {
  const h = await harness(t);
  const { id, digest } = h.install();
  h.approve();
  assert.equal(
    runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io),
    0,
  );
  const runId = h.stdout().match(/^Run (\S+)/m)?.[1];
  assert.ok(runId);

  h.reset();
  assert.equal(
    runHeadless(h.clients, ["run", "read", `${runId}/absent`], h.io),
    1,
  );
  assert.match(h.stderr(), /run-output-not-found/);
});
