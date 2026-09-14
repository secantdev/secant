import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { wireApplication, type Wiring } from "../../src/composition/main.js";
import { runHeadless, type HeadlessIO } from "../../src/headless/headless.js";
import {
  ensureRuntimeOnPath,
  writeCommandBundle,
} from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { awaitSettled } from "../helpers/settleOperation.js";

/** Await a submitted Run Operation's settled outcome (execution settles async). */
async function settled(wired: Wiring, operationId: string): Promise<void> {
  await awaitSettled(wired.projectionPort, operationId);
}

// The composition wiring suite (#74 A18): it constructs the Application through
// the one wiring path both roots take — against a temporary home, without a
// terminal — and asserts the engine version, host platform, and launch Workspace
// reach the Application. This is the test that would have caught A1: the TUI root
// omitting engineVersion/hostPlatform so the shell ran as 0.0.0-dev on
// platforms[0]. Because both roots call wireApplication and nothing else builds
// the Application, exercising it here guards both.

const proofBundle = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bundles",
  "test-repair-workflow",
);
const proofId = "dev.secant.test-repair";

/** Wire a fresh Application against a temporary home, seed it with the Proof
 *  Bundle (engine floor `>=0.1.0`, above the dev sentinel), and close on teardown. */
function seeded(
  t: TestContext,
  overrides: Parameters<typeof wireApplication>[0],
): Wiring {
  const wired = wireApplication({
    secantHome: makeTempDir("secant-wire-home-"),
    launchCwd: makeTempDir("secant-wire-ws-"),
    ...overrides,
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  assert.ok(wired.bundleManagement.build(proofBundle, { noInstall: false }).ok);
  return wired;
}

/** The Proof Bundle's focus as the Projection Port hands it to every client. */
function focusBundle(wired: Wiring) {
  const opened = wired.projectionPort.openProjection({
    family: "bundle-catalog",
    focus: { id: proofId },
  });
  try {
    assert.ok(
      opened.snapshot.result.found,
      JSON.stringify(opened.snapshot.result),
    );
    if (!opened.snapshot.result.found) throw new Error("unreachable");
    return opened.snapshot.result.bundle;
  } finally {
    opened.close();
  }
}

test("the wiring hands the Application the engine version, host platform, and launch Workspace", (t) => {
  const workspace = makeTempDir("secant-wire-launch-");
  const wired = seeded(t, {
    launchCwd: workspace,
    engineVersion: "9.9.9",
    hostPlatform: "linux",
  });

  // The launch Workspace: the raw cwd, canonicalised by the Application (A6).
  const ws = wired.projectionPort.openProjection({ family: "workspace" });
  assert.equal(ws.snapshot.path, realpathSync.native(workspace));
  ws.close();

  const bundle = focusBundle(wired);
  // engineVersion 9.9.9 reached the Application: it satisfies the 0.1.0 floor.
  // Had a root omitted it and defaulted to 0.0.0-dev — the A1 bug — this would
  // read false.
  assert.equal(bundle.engine.satisfied, true);
  // hostPlatform linux reached the Application: the Execution summary resolves
  // commands for linux, not platforms[0].
  assert.equal(bundle.executionSummary.platform, "linux");
});

test("the wiring constructs the Run Store and Run execution through the single root, so a launch runs to succeeded", async (t) => {
  ensureRuntimeOnPath();
  const workspace = makeTempDir("secant-wire-run-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-wire-run-home-"),
    launchCwd: workspace,
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  const cmd = writeCommandBundle();
  assert.ok(wired.bundleManagement.build(cmd.folder, { noInstall: false }).ok);
  // Approve the launch Workspace through the Port (the raw cwd; the Application
  // canonicalises it), so the launch passes the approval gate.
  const approve = wired.projectionPort.submit({
    operationId: "op-approve",
    operation: "approve-workspace",
    input: { path: workspace },
  });
  assert.ok(approve.admitted);

  const entry = wired.catalog.listEntries()[0];
  assert.ok(entry);
  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: cmd.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId;
  assert.ok(runId);
  await settled(wired, "op-launch");

  const opened = wired.projectionPort.openProjection({ family: "run", runId });
  try {
    assert.ok(opened.snapshot.result.found, JSON.stringify(opened.snapshot));
    if (opened.snapshot.result.found) {
      assert.equal(opened.snapshot.result.run.state, "succeeded");
    }
  } finally {
    opened.close();
  }
});

test("the wiring's AssetResolver maps a Bundle's script asset to its file in the Catalog's tree so a Command can run it", async (t) => {
  ensureRuntimeOnPath();
  const workspace = makeTempDir("secant-wire-asset-ws-");
  const wired = wireApplication({
    secantHome: makeTempDir("secant-wire-asset-home-"),
    launchCwd: workspace,
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });

  // The Command runs `<runtime> {asset:check.js}`; only the composition-built
  // AssetResolver (a path join under the Catalog's digest-named asset tree)
  // makes that `{asset}` reference resolve to an on-disk path — the seam #81
  // left open.
  const cmd = writeCommandBundle({
    asset: { path: "check.js", content: "console.log('ran-from-asset')" },
  });
  assert.ok(wired.bundleManagement.build(cmd.folder, { noInstall: false }).ok);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  const entry = wired.catalog.listEntries()[0];
  assert.ok(entry);
  const admission = wired.projectionPort.submit({
    operationId: "op-launch",
    operation: "launch-run",
    input: {
      bundle: { id: cmd.id },
      launchInputs: {},
      trustDigest: entry.digest,
    },
  });
  assert.ok(admission.admitted, JSON.stringify(admission));
  const runId = admission.runId!;
  await settled(wired, "op-launch");

  const opened = wired.projectionPort.openProjection({ family: "run", runId });
  try {
    assert.ok(opened.snapshot.result.found, JSON.stringify(opened.snapshot));
    if (!opened.snapshot.result.found) throw new Error("unreachable");
    assert.equal(opened.snapshot.result.run.state, "succeeded");
    const output = opened.snapshot.result.run.outputs.find(
      (o) => o.name === "output",
    );
    assert.ok(output);
    const read = wired.projectionPort.readResource(output.reference);
    assert.ok(read.found);
    if (read.found) assert.match(read.content, /ran-from-asset/);
  } finally {
    opened.close();
  }
});

test("the headless client and the TUI client render the same Port snapshot", async (t) => {
  // Defaults for engineVersion and hostPlatform, so both come from the process —
  // the production behaviour of both roots. The headless client and the TUI view
  // both read the focus snapshot the Port hands out (bundle-view seeds its signal
  // from it verbatim), so both show the same engine compatibility and platform.
  const wired = seeded(t, {});
  const shared = focusBundle(wired);

  const out: string[] = [];
  const io: HeadlessIO = {
    out: (text) => out.push(text),
    err: () => {},
    cwd: () => process.cwd(),
  };
  assert.equal(
    await runHeadless(
      {
        projectionPort: wired.projectionPort,
        bundleManagement: wired.bundleManagement,
      },
      ["bundle", "inspect", proofId, "--json"],
      io,
    ),
    0,
  );
  const headless = JSON.parse(out.join("")) as {
    engine: { range: string; satisfied: boolean };
    executionSummary: { platform: string };
  };

  assert.deepEqual(headless.engine, shared.engine);
  assert.equal(
    headless.executionSummary.platform,
    shared.executionSummary.platform,
  );
  // The dev sentinel does not satisfy the 0.1.0 floor, confirming the default
  // engine version flowed through rather than a value that trivially satisfies.
  assert.equal(shared.engine.satisfied, false);
});

// --- zero-copy Runs over the Catalog's derived asset tree (#100, A8) ---------

/** Wire a fresh home + Workspace, install a Command Bundle whose script asset
 *  prints its own on-disk path, and approve the Workspace. */
function assetFixture(t: TestContext) {
  ensureRuntimeOnPath();
  const home = makeTempDir("secant-wire-zc-home-");
  const workspace = makeTempDir("secant-wire-zc-ws-");
  const wired = wireApplication({ secantHome: home, launchCwd: workspace });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  const cmd = writeCommandBundle({
    asset: { path: "check.js", content: "console.log(__filename)" },
  });
  assert.ok(wired.bundleManagement.build(cmd.folder, { noInstall: false }).ok);
  assert.ok(
    wired.projectionPort.submit({
      operationId: "op-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    }).admitted,
  );
  const entry = wired.catalog.listEntries()[0]!;
  return { home, wired, cmd, entry };
}

/** Launch and return the Run's state plus its `output` text (the script's
 *  printed path), or the refusal Problem. */
async function launch(
  wired: Wiring,
  bundleId: string,
  digest: string,
  operationId: string,
): Promise<{ state: string; output: string } | { problemCode: string }> {
  const admission = wired.projectionPort.submit({
    operationId,
    operation: "launch-run",
    input: { bundle: { id: bundleId }, launchInputs: {}, trustDigest: digest },
  });
  if (!admission.admitted) return { problemCode: admission.problem.code };
  await settled(wired, operationId);
  const opened = wired.projectionPort.openProjection({
    family: "run",
    runId: admission.runId!,
  });
  try {
    assert.ok(opened.snapshot.result.found);
    if (!opened.snapshot.result.found) throw new Error("unreachable");
    const run = opened.snapshot.result.run;
    const output = run.outputs.find((o) => o.name === "output");
    assert.ok(output);
    const read = wired.projectionPort.readResource(output.reference);
    assert.ok(read.found);
    return { state: run.state, output: read.found ? read.content.trim() : "" };
  } finally {
    opened.close();
  }
}

test("two launches of one digest copy nothing per Run and resolve the same asset path under the Catalog's tree", async (t) => {
  const { home, wired, cmd, entry } = assetFixture(t);
  const first = await launch(wired, cmd.id, entry.digest, "op-1");
  const second = await launch(wired, cmd.id, entry.digest, "op-2");
  assert.ok("state" in first && "state" in second);
  assert.equal(first.state, "succeeded");
  assert.equal(second.state, "succeeded");
  assert.equal(first.output, second.output);
  const root = wired.catalog.assetRoot(entry.digest);
  assert.ok(root !== undefined);
  assert.equal(
    realpathSync.native(first.output),
    realpathSync.native(join(root, "check.js")),
  );
  assert.ok(!existsSync(join(home, "run-assets")));
});

test("a tree deleted by hand is re-extracted at launch; deleted managed bytes refuse with bundle-bytes-missing", async (t) => {
  const { home, wired, cmd, entry } = assetFixture(t);
  const root = wired.catalog.assetRoot(entry.digest);
  assert.ok(root !== undefined);
  rmSync(root, { recursive: true, force: true });
  const relaunched = await launch(wired, cmd.id, entry.digest, "op-1");
  assert.ok("state" in relaunched);
  assert.equal(relaunched.state, "succeeded");
  assert.ok(existsSync(join(root, "check.js")));

  rmSync(join(home, "bundles", `${entry.digest}.wfb`));
  const refused = await launch(wired, cmd.id, entry.digest, "op-2");
  assert.deepEqual(refused, { problemCode: "bundle-bytes-missing" });
});

test("a legacy run-assets directory is swept once at open", (t) => {
  const home = makeTempDir("secant-wire-sweep-home-");
  mkdirSync(join(home, "run-assets", "run-1"), { recursive: true });
  writeFileSync(join(home, "run-assets", "run-1", "x.js"), "x");
  const wired = wireApplication({
    secantHome: home,
    launchCwd: makeTempDir("secant-wire-sweep-ws-"),
  });
  t.after(() => {
    wired.runGroup.close();
    wired.catalog.close();
  });
  assert.ok(!existsSync(join(home, "run-assets")));
});
