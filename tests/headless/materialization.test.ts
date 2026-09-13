import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createApplication,
  type RunExecution,
} from "../../src/application/application.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import { openRunGroup } from "../../src/run/store/store.js";
import { type HeadlessIO, runHeadless } from "../../src/headless/headless.js";
import {
  ensureRuntimeOnPath,
  hostPlatform,
  writeMaterializationBundle,
} from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";

// #88 through the headless CLI: `run show` names the conflict and its path and
// prints the diagnostic (read through its reference, AC5); `run resume` continues
// the Run once the file is restored.

ensureRuntimeOnPath();

const runExecution: RunExecution = ({ routing, owner }) =>
  executeRouting(routing, {
    owner,
    platform: hostPlatform(),
    resolveAsset: () => undefined,
  });

function harness(t: TestContext) {
  const catalog = openCatalog(makeTempDir("secant-matcli-home-"));
  t.after(() => catalog.close());
  const workspace = realpathSync.native(makeTempDir("secant-matcli-ws-"));
  const runGroup = openRunGroup(makeTempDir("secant-matcli-store-"), workspace);
  t.after(() => runGroup.close());
  const clients = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    hostPlatform: hostPlatform(),
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
    install: (tamper: "modify" | "delete" | "none") => {
      const bundle = writeMaterializationBundle({
        workspaceAbsPath: workspace,
        tamper,
      });
      assert.equal(
        runHeadless(clients, ["bundle", "build", bundle.folder], io),
        0,
      );
      out.length = 0;
      const entry = catalog.listEntries().find((e) => e.id === bundle.id);
      assert.ok(entry);
      catalog.approveWorkspace(workspace, new Date());
      return { id: bundle.id, digest: entry.digest };
    },
  };
}

test("run show names the conflict, its path, and prints the diagnostic", (t) => {
  const h = harness(t);
  const { id, digest } = h.install("modify");

  // A launch that halts on a conflict exits non-zero and prints the state.
  assert.equal(
    runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io),
    1,
  );
  assert.match(h.stdout(), /^State: halted$/m);
  const runId = h.stdout().match(/^Run (\S+)/m)?.[1];
  assert.ok(runId);
  h.reset();

  assert.equal(runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  const shown = h.stdout();
  assert.match(shown, /State: halted/);
  assert.match(shown, /Materialization conflict:/);
  assert.match(shown, /artifact: x/);
  assert.match(shown, /path: out\/x\.txt/);
  assert.match(shown, /consume \(command\): blocked/);
  // The diagnostic, read through its reference, names the path.
  assert.match(shown, /Diagnostic:/);
  assert.match(shown, /Restore "out\/x\.txt"/);
});

test("run resume continues a halted Run after the file is restored", (t) => {
  const h = harness(t);
  const { id, digest } = h.install("modify");
  runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io);
  const runId = h.stdout().match(/^Run (\S+)/m)?.[1];
  assert.ok(runId);
  h.reset();

  // Resuming while still in conflict stays halted and exits non-zero.
  assert.equal(runHeadless(h.clients, ["run", "resume", runId], h.io), 1);
  assert.match(h.stdout(), /^State: halted$/m);
  h.reset();

  // Restore the file, then resume: the Run reaches succeeded.
  writeFileSync(join(h.workspace, "out", "x.txt"), "materialized-content");
  assert.equal(runHeadless(h.clients, ["run", "resume", runId], h.io), 0);
  assert.match(h.stdout(), /^State: succeeded$/m);
});

test("run resume of an unknown Run reports run-not-found", (t) => {
  const h = harness(t);
  assert.equal(
    runHeadless(h.clients, ["run", "resume", "no-such-run"], h.io),
    1,
  );
  assert.match(h.stderr(), /run-not-found/);
});
