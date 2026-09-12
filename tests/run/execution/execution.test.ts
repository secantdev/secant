import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type {
  CommandParams,
  CommandStep,
  Platform,
  ProducedArtifact,
  RoutingNode,
} from "../../../src/workflow/workflow.js";
import {
  executeRouting,
  type AssetResolver,
} from "../../../src/run/execution/execution.js";
import { openRunGroup, type RunOwner } from "../../../src/run/store/store.js";
import { makeTempDir } from "../../helpers/tempDir.js";

const WORKSPACE = "/work/example-project";
const AT = new Date("2026-09-13T12:00:00.000Z");
const HOST: Platform = process.platform === "win32" ? "windows" : "linux";
const NODE = process.execPath; // the runtime binary; runs `-e` scripts and files

const dec = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

/** Acquire an owner for a fresh Run under a temporary Secant home. */
function ownerForFreshRun(t: { after: (fn: () => void) => void }): {
  owner: RunOwner;
  home: string;
  /** The Run's canonical state as the Store records it right now. */
  state: () => string;
} {
  const home = makeTempDir("secant-execution-");
  const group = openRunGroup(home, WORKSPACE);
  t.after(() => group.close());
  const created = group.createRun({
    operationId: "op-1",
    bundleSnapshotDigest: "sha256:deadbeef",
    launch: {},
    at: AT,
  });
  assert.ok(created.outcome === "created");
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  t.after(() => owner.close());
  const state = () => {
    const read = group.readRun(created.runId);
    assert.ok(read.ok);
    return read.run.state;
  };
  return { owner, home, state };
}

const produces = (...decls: ProducedArtifact[]): ProducedArtifact[] => decls;

/** A Command Step running the runtime binary with the given invocation. */
function commandStep(
  id: string,
  command: CommandParams,
  step: Partial<CommandStep> = {},
): CommandStep {
  return { id, kind: "command", command, ...step };
}

/** A resolver that maps declared asset paths to files it writes into `dir`. */
function assetsIn(dir: string, files: Record<string, string>): AssetResolver {
  const paths = new Map<string, string>();
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, content);
    paths.set(name, path);
  }
  return (assetPath) => paths.get(assetPath);
}

const noAssets: AssetResolver = () => undefined;

function run(routing: RoutingNode[], owner: RunOwner, over = {}) {
  return executeRouting(routing, {
    owner,
    platform: HOST,
    resolveAsset: noAssets,
    now: () => AT,
    ...over,
  });
}

test("a two-Command Routing whose scripts exit 0 runs to succeeded", async (t) => {
  const { owner, state } = ownerForFreshRun(t);
  const routing: RoutingNode[] = [
    commandStep(
      "one",
      { executable: NODE, arguments: ["-e", "console.log('first')"] },
      {
        produces: produces(
          { name: "v1", type: "verdict" },
          { name: "t1", type: "text" },
        ),
      },
    ),
    commandStep(
      "two",
      { executable: NODE, arguments: ["-e", "console.log('second')"] },
      {
        produces: produces(
          { name: "v2", type: "verdict" },
          { name: "t2", type: "text" },
        ),
      },
    ),
  ];

  const report = run(routing, owner);
  assert.deepEqual(report, { outcome: "succeeded" });
  // The deciding Attempt rested the Run in one transaction, not a stuck `running`.
  assert.equal(state(), "succeeded");

  // Each Step's pass Verdict and text output are bound.
  assert.equal(dec(readBound(owner, "v1")), "pass");
  assert.equal(dec(readBound(owner, "v2")), "pass");
  assert.equal(dec(readBound(owner, "t1")), "first\n");
  assert.equal(dec(readBound(owner, "t2")), "second\n");

  // One Attempt per Step, all succeeded.
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.outcome),
    ["succeeded", "succeeded"],
  );
});

test("a script exiting 1 yields a fail Verdict, a succeeded Attempt, and the Run proceeds", async (t) => {
  const { owner } = ownerForFreshRun(t);
  const routing: RoutingNode[] = [
    commandStep(
      "failing",
      {
        executable: NODE,
        arguments: ["-e", "console.log('nope'); process.exit(1)"],
      },
      {
        produces: produces(
          { name: "verdict", type: "verdict" },
          { name: "log", type: "text" },
        ),
      },
    ),
    commandStep(
      "after",
      { executable: NODE, arguments: ["-e", "console.log('ran anyway')"] },
      { produces: produces({ name: "v2", type: "verdict" }) },
    ),
  ];

  const report = run(routing, owner);
  assert.deepEqual(report, { outcome: "succeeded" });
  // Exit 1 is a `fail` Verdict, not an Attempt failure.
  assert.equal(dec(readBound(owner, "verdict")), "fail");
  assert.equal(dec(readBound(owner, "log")), "nope\n");
  assert.equal(dec(readBound(owner, "v2")), "pass");
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.outcome),
    ["succeeded", "succeeded"],
  );
});

test("a missing executable is retried within the bound, then rests the Run failed", async (t) => {
  const { owner, state } = ownerForFreshRun(t);
  const routing: RoutingNode[] = [
    commandStep(
      "missing",
      { executable: "secant-no-such-binary-xyz", arguments: [] },
      { retry: 2, produces: produces({ name: "v", type: "verdict" }) },
    ),
  ];

  const report = run(routing, owner);
  assert.deepEqual(report, { outcome: "failed" });
  assert.equal(state(), "failed");
  // retry: 2 means 3 attempts, every one a `failed` Attempt in the log.
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.outcome),
    ["failed", "failed", "failed"],
  );
  // A failed Attempt binds nothing.
  assert.equal(owner.currentVersion("v"), undefined);
});

test("a timed-out command is retried within the bound, then rests the Run failed", async (t) => {
  const { owner } = ownerForFreshRun(t);
  // Sleep far longer than the timeout so no CI jitter lets it finish in time.
  const sleep =
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)";
  const routing: RoutingNode[] = [
    commandStep(
      "slow",
      { executable: NODE, arguments: ["-e", sleep] },
      { retry: 1, produces: produces({ name: "v", type: "verdict" }) },
    ),
  ];

  const report = run(routing, owner, { commandTimeoutMs: 200 });
  assert.deepEqual(report, { outcome: "failed" });
  // retry: 1 means 2 attempts, both `failed`.
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.outcome),
    ["failed", "failed"],
  );
});

test("the platform override selects the Windows invocation on Windows and the POSIX one elsewhere", async (t) => {
  // The base (POSIX) invocation prints "posix"; the Windows override prints
  // "windows". Running the same Step on each platform proves the matrix.
  const command: CommandParams = {
    executable: NODE,
    arguments: ["-e", "console.log('posix')"],
    platforms: {
      windows: { arguments: ["-e", "console.log('windows')"] },
    },
  };
  const step = () =>
    [
      commandStep("cmd", command, {
        produces: produces({ name: "out", type: "text" }),
      }),
    ] as RoutingNode[];

  const posix = ownerForFreshRun(t);
  assert.deepEqual(run(step(), posix.owner, { platform: "linux" }), {
    outcome: "succeeded",
  });
  assert.equal(dec(readBound(posix.owner, "out")), "posix\n");

  const macos = ownerForFreshRun(t);
  assert.deepEqual(run(step(), macos.owner, { platform: "macos" }), {
    outcome: "succeeded",
  });
  assert.equal(dec(readBound(macos.owner, "out")), "posix\n");

  const windows = ownerForFreshRun(t);
  run(step(), windows.owner, { platform: "windows" });
  assert.equal(dec(readBound(windows.owner, "out")), "windows\n");
});

test("asset and artifact references in arguments resolve to the Snapshot asset and the bound artifact", async (t) => {
  const { owner } = ownerForFreshRun(t);
  const assetDir = makeTempDir("secant-assets-");
  const resolveAsset = assetsIn(assetDir, {
    "print.js": "console.log('from-asset')",
  });

  const routing: RoutingNode[] = [
    // Step one runs a script referenced by an {asset} argument and binds its text.
    commandStep(
      "asset-step",
      { executable: NODE, arguments: [{ asset: "print.js" }] },
      { produces: produces({ name: "msg", type: "text" }) },
    ),
    // Step two passes the bound `msg` artifact as an {artifact} argument.
    commandStep(
      "artifact-step",
      {
        executable: NODE,
        arguments: [
          "-e",
          "process.stdout.write('echo:' + process.argv.at(-1))",
          { artifact: "msg" },
        ],
      },
      {
        requires: ["msg"],
        produces: produces({ name: "echoed", type: "text" }),
      },
    ),
  ];

  const report = run(routing, owner, { resolveAsset });
  assert.deepEqual(report, { outcome: "succeeded" });
  assert.equal(dec(readBound(owner, "msg")), "from-asset\n");
  // The artifact reference resolved to the bound bytes ("from-asset\n").
  assert.equal(dec(readBound(owner, "echoed")), "echo:from-asset\n");
});

test("an unknown Step kind is refused (M2 is command-only)", async (t) => {
  const { owner } = ownerForFreshRun(t);
  const gate = {
    id: "gate",
    kind: "human-gate",
    shape: "approve-reject",
  } as unknown as RoutingNode;
  assert.throws(() => run([gate], owner), /not dispatchable/);
});

/** Read the bytes currently bound to an artifact name through the owner. */
function readBound(owner: RunOwner, name: string): Uint8Array | undefined {
  const versionId = owner.currentVersion(name);
  return versionId === undefined
    ? undefined
    : owner.readArtifact(versionId, name);
}
