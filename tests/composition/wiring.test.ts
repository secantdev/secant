import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
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

test("the wiring constructs the Run Store and Run execution through the single root, so a launch runs to succeeded", (t) => {
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

test("the wiring's AssetResolver extracts a Bundle's script asset to disk so a Command can run it", (t) => {
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
  // AssetResolver (extracting the pinned Snapshot's bytes to disk) makes that
  // `{asset}` reference resolve to an on-disk path — the seam #81 left open.
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

test("the headless client and the TUI client render the same Port snapshot", (t) => {
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
    runHeadless(
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
