import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_REVIEW_CHECKPOINT_INTERVAL,
  type CommandParams,
  type CommandStep,
  type Platform,
  type ProducedArtifact,
  type RoutingNode,
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

// --- Repeat groups (#84, ADR 0020) -----------------------------------------

/** A Command that exits non-zero until its `passAt`th run: it increments a
 *  counter file each run and exits 0 once the count reaches `passAt`. This makes
 *  a Repeat group's Verdict flip from `fail` to `pass` across iterations, without
 *  a platform-specific script (the runtime binary runs the `-e` JS on every OS). */
function counterScript(counterPath: string, passAt: number): CommandParams {
  const code =
    `const fs=require('node:fs');const p=${JSON.stringify(counterPath)};` +
    `let n=0;try{n=Number(fs.readFileSync(p,'utf8'))||0;}catch{}` +
    `n++;fs.writeFileSync(p,String(n));` +
    `console.log('iteration '+n);process.exit(n>=${passAt}?0:1);`;
  return { executable: NODE, arguments: ["-e", code] };
}

/** A single-step Repeat group over a counter Command producing the `until`
 *  Verdict `passing` and a `log` text. */
function repeatOver(
  counterPath: string,
  passAt: number,
  interval: number,
): RoutingNode {
  return {
    repeat: {
      until: "passing",
      reviewCheckpoint: { interval, message: "please review the loop" },
      steps: [
        commandStep("check", counterScript(counterPath, passAt), {
          produces: produces(
            { name: "passing", type: "verdict" },
            { name: "log", type: "text" },
          ),
        }),
      ],
    },
  };
}

/** A fresh counter file path under a temp dir (the file is created on first run). */
function freshCounter(): string {
  return join(makeTempDir("secant-counter-"), "count");
}

test("a Repeat group that fails twice then passes runs three iterations and rests succeeded", async (t) => {
  const { owner, state } = ownerForFreshRun(t);
  const routing = [repeatOver(freshCounter(), 3, 5)];

  const report = run(routing, owner);
  assert.deepEqual(report, { outcome: "succeeded" });
  // The last iteration's deciding Attempt rested the Run in one transaction.
  assert.equal(state(), "succeeded");
  // Three iterations, each a `succeeded` Attempt (a fail Verdict is a value).
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.outcome),
    ["succeeded", "succeeded", "succeeded"],
  );
  assert.equal(dec(readBound(owner, "passing")), "pass");
  assert.equal(dec(readBound(owner, "log")), "iteration 3\n");
});

test("a Repeat group whose Verdict is already pass before entry runs zero iterations and the Run continues", async (t) => {
  const { owner, state } = ownerForFreshRun(t);
  const counter = freshCounter();
  const routing: RoutingNode[] = [
    // Baseline binds `passing` = pass before the group is entered (exit 0).
    commandStep(
      "baseline",
      { executable: NODE, arguments: ["-e", "process.exit(0)"] },
      { produces: produces({ name: "passing", type: "verdict" }) },
    ),
    // The group's counter Command would fail, but it must never run.
    repeatOver(counter, 999, 5),
    // A node after the group proves the Run continues past a zero-iteration group.
    commandStep(
      "after",
      { executable: NODE, arguments: ["-e", "console.log('after ran')"] },
      { produces: produces({ name: "done", type: "text" }) },
    ),
  ];

  const report = run(routing, owner);
  assert.deepEqual(report, { outcome: "succeeded" });
  assert.equal(state(), "succeeded");
  // Only the baseline and the trailing step ran — the group ran zero iterations.
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.outcome),
    ["succeeded", "succeeded"],
  );
  assert.equal(dec(readBound(owner, "done")), "after ran\n");
  // The counter file was never written, so the group's Command never ran.
  assert.equal(existsSync(counter), false);
});

/** An always-failing single-step Repeat group (exit 1 each iteration), cheaper
 *  than the counter for tests that only need the loop to keep failing. */
function alwaysFailRepeat(interval: number): RoutingNode {
  return {
    repeat: {
      until: "passing",
      reviewCheckpoint: { interval, message: "please review the loop" },
      steps: [
        commandStep(
          "check",
          { executable: NODE, arguments: ["-e", "process.exit(1)"] },
          { produces: produces({ name: "passing", type: "verdict" }) },
        ),
      ],
    },
  };
}

test("a Repeat group that always fails blocks after `interval` iterations", async (t) => {
  const { owner, state } = ownerForFreshRun(t);
  const report = run([alwaysFailRepeat(3)], owner);
  assert.deepEqual(report, { outcome: "blocked" });
  // `blocked` is never written: the stored state stays `running`, and the block
  // is derived from the current Step Attempt (a reopened home re-derives it).
  assert.equal(state(), "running");
  // Exactly three iterations ran before the checkpoint; every one a fail Verdict.
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.outcome),
    ["succeeded", "succeeded", "succeeded"],
  );
  assert.equal(dec(readBound(owner, "passing")), "fail");
});

test(
  "an authored interval above the engine ceiling never delays the checkpoint beyond the ceiling",
  { timeout: 60_000 },
  async (t) => {
    const { owner } = ownerForFreshRun(t);
    const report = run(
      [alwaysFailRepeat(MAX_REVIEW_CHECKPOINT_INTERVAL + 150)],
      owner,
    );
    assert.deepEqual(report, { outcome: "blocked" });
    // The clamp caps iterations-between-reviews at the ceiling, not the authored
    // 250. Count only ran iterations (a rare transient spawn retry adds `failed`
    // entries that do not count as an iteration).
    const iterations = owner
      .attemptLog()
      .filter((entry) => entry.outcome === "succeeded").length;
    assert.equal(iterations, MAX_REVIEW_CHECKPOINT_INTERVAL);
  },
);

/** Read the bytes currently bound to an artifact name through the owner. */
function readBound(owner: RunOwner, name: string): Uint8Array | undefined {
  const versionId = owner.currentVersion(name);
  return versionId === undefined
    ? undefined
    : owner.readArtifact(versionId, name);
}
