import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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
  MAX_CAPTURE_BYTES,
  RunCancelledError,
  TRUNCATION_MARKER,
  type AssetResolver,
  type SpawnCommand,
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
function ownerForFreshRun(
  t: { after: (fn: () => void) => void },
  launch: Readonly<Record<string, string>> = {},
): {
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
    launch,
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

  const report = await run(routing, owner);
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

test("a Command resolves an authored working directory beneath the Run Workspace", async (t) => {
  const { owner } = ownerForFreshRun(t);
  let observedCwd: string | undefined;
  const spawnCommand: SpawnCommand = (options) => {
    observedCwd = options.cwd;
    return Promise.resolve({
      kind: "exited",
      status: 0,
      text: new Uint8Array(),
    });
  };

  assert.deepEqual(
    await run(
      [
        commandStep("nested", {
          executable: NODE,
          arguments: [],
          workingDirectory: "packages/example",
        }),
      ],
      owner,
      { spawnCommand },
    ),
    { outcome: "succeeded" },
  );
  assert.equal(observedCwd, join(WORKSPACE, "packages", "example"));
});

test("a Command artifact argument resolves from the Run's Launch inputs", async (t) => {
  const { owner } = ownerForFreshRun(t, { source: "tests/failing.test.mjs" });
  let observedArgs: readonly string[] = [];
  const spawnCommand: SpawnCommand = (options) => {
    observedArgs = options.args;
    return Promise.resolve({
      kind: "exited",
      status: 0,
      text: new Uint8Array(),
    });
  };

  assert.deepEqual(
    await run(
      [
        commandStep("consume-input", {
          executable: NODE,
          arguments: [{ artifact: "source" }],
        }),
      ],
      owner,
      { spawnCommand },
    ),
    { outcome: "succeeded" },
  );
  assert.deepEqual(observedArgs, ["tests/failing.test.mjs"]);
});

// A command killed by a signal (Ctrl+C / termination) has no exit; its Attempt is
// indeterminate, never retried, and rests the Run halted (ADR 0019, #86). Gated to
// POSIX: Windows has no real signals, so a self-kill maps to an exit code there;
// the cross-OS interrupted case is the real-child SIGKILL test in resume.test.ts.
test(
  "an interrupted Attempt is indeterminate, not retried, and rests the Run halted (#86)",
  { skip: process.platform === "win32" },
  async (t) => {
    const { owner, state } = ownerForFreshRun(t);
    const routing: RoutingNode[] = [
      commandStep(
        "interrupted",
        {
          executable: NODE,
          arguments: ["-e", "process.kill(process.pid, 'SIGKILL')"],
        },
        {
          retry: 2, // a generous budget the interrupted Attempt must NOT consume
          produces: produces({ name: "v", type: "verdict" }),
        },
      ),
      commandStep("after", {
        executable: NODE,
        arguments: ["-e", "console.log('should not run')"],
      }),
    ];

    const report = await run(routing, owner);
    assert.deepEqual(report, { outcome: "halted" });
    assert.equal(state(), "halted");
    // Exactly one Attempt, indeterminate: no retry, and the following Step never ran.
    assert.deepEqual(
      owner.attemptLog().map((entry) => entry.outcome),
      ["indeterminate"],
    );
  },
);

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

  const report = await run(routing, owner);
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

  const report = await run(routing, owner);
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

  const report = await run(routing, owner, { commandTimeoutMs: 200 });
  assert.deepEqual(report, { outcome: "failed" });
  // retry: 1 means 2 attempts, both `failed`.
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.outcome),
    ["failed", "failed"],
  );
});

// D2 (#97): a command that spawns a grandchild holding stdout open and then hangs
// is killed by the process-group kill within the timeout plus the escalation grace,
// not left leaking. A per-child kill would leave the grandchild holding the pipe and
// this would hang; the group kill (POSIX `kill(-pid)`, Windows `taskkill /T`) reaches
// it. Bounded by a short deterministic timeout, so a regression turns it red by
// hanging past the test timeout, not by flaking.
test(
  "a hung command whose grandchild holds stdout open is group-killed and the Attempt fails (D2)",
  { timeout: 20_000 },
  async (t) => {
    const { owner, state } = ownerForFreshRun(t);
    // The child spawns a grandchild that inherits stdout (so it holds our capture
    // pipe open) and sleeps, then the child itself hangs. Only killing the whole
    // group closes the pipe and lets the Attempt settle.
    const hang =
      "const{spawn}=require('node:child_process');" +
      "spawn(process.execPath,['-e','setTimeout(()=>{},1e9)'],{stdio:['ignore','inherit','inherit']});" +
      "setTimeout(()=>{},1e9);";
    const routing: RoutingNode[] = [
      commandStep(
        "hang",
        { executable: NODE, arguments: ["-e", hang] },
        { retry: 0, produces: produces({ name: "v", type: "verdict" }) },
      ),
    ];

    const report = await run(routing, owner, { commandTimeoutMs: 300 });
    // Our own timeout kill -> the Attempt failed and is retryable (retry: 0 = one).
    assert.deepEqual(report, { outcome: "failed" });
    assert.equal(state(), "failed");
    assert.deepEqual(
      owner.attemptLog().map((entry) => entry.outcome),
      ["failed"],
    );
  },
);

// D3 (#97): output past the ~4 MiB cap is dropped while a truncation marker is
// appended to the `text` artifact, and the Attempt still succeeds (the command ran
// to an exit). The cap bounds memory without failing an ordinary noisy command.
test("a command exceeding the capture cap yields a truncated text ending in the marker, and succeeds (D3)", async (t) => {
  const { owner } = ownerForFreshRun(t);
  // Write more than the cap, then exit 0.
  const flood = `process.stdout.write('x'.repeat(${MAX_CAPTURE_BYTES + 1024 * 1024}))`;
  const routing: RoutingNode[] = [
    commandStep(
      "noisy",
      { executable: NODE, arguments: ["-e", flood] },
      {
        produces: produces(
          { name: "v", type: "verdict" },
          { name: "log", type: "text" },
        ),
      },
    ),
  ];

  const report = await run(routing, owner);
  assert.deepEqual(report, { outcome: "succeeded" });
  // The Attempt still succeeded with a pass Verdict (exit 0).
  assert.equal(dec(readBound(owner, "v")), "pass");
  const text = readBound(owner, "log");
  assert.ok(text);
  // The text is exactly the cap's worth of bytes plus the appended marker.
  assert.equal(
    text!.byteLength,
    MAX_CAPTURE_BYTES + Buffer.byteLength(TRUNCATION_MARKER),
  );
  assert.ok(dec(text)!.endsWith(TRUNCATION_MARKER));
});

// #97: an abort from the caller's cancel signal kills the child's group and unwinds
// with RunCancelledError, publishing no Attempt — so `cancel-run` (T4) owns the
// `cancelled` rest. The child is spawned synchronously before executeRouting first
// awaits, so aborting right after the call cancels a live child with no sleep.
test(
  "aborting via the cancel signal kills the child and unwinds without writing an Attempt",
  { skip: process.platform === "win32" },
  async (t) => {
    const { owner, state } = ownerForFreshRun(t);
    const controller = new AbortController();
    const routing: RoutingNode[] = [
      commandStep(
        "cancelme",
        { executable: NODE, arguments: ["-e", "setTimeout(()=>{},1e9)"] },
        { retry: 2, produces: produces({ name: "v", type: "verdict" }) },
      ),
    ];

    const promise = run(routing, owner, { cancelSignal: controller.signal });
    controller.abort();
    await assert.rejects(promise, RunCancelledError);
    // No Attempt was published, and the deciding rest is left to cancel-run (T4):
    // the stored state stays `running`.
    assert.equal(owner.attemptLog().length, 0);
    assert.equal(state(), "running");
  },
);

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
  assert.deepEqual(await run(step(), posix.owner, { platform: "linux" }), {
    outcome: "succeeded",
  });
  assert.equal(dec(readBound(posix.owner, "out")), "posix\n");

  const macos = ownerForFreshRun(t);
  assert.deepEqual(await run(step(), macos.owner, { platform: "macos" }), {
    outcome: "succeeded",
  });
  assert.equal(dec(readBound(macos.owner, "out")), "posix\n");

  const windows = ownerForFreshRun(t);
  await run(step(), windows.owner, { platform: "windows" });
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

  const report = await run(routing, owner, { resolveAsset });
  assert.deepEqual(report, { outcome: "succeeded" });
  assert.equal(dec(readBound(owner, "msg")), "from-asset\n");
  // The artifact reference resolved to the bound bytes ("from-asset\n").
  assert.equal(dec(readBound(owner, "echoed")), "echo:from-asset\n");
});

test("an interactive-agent Step dispatches to a blocked pause with no Attempt (#122)", async (t) => {
  const { owner, state } = ownerForFreshRun(t);
  const interactive = {
    id: "grill",
    kind: "interactive-agent",
    prompt: { asset: "prompt.md" },
    session: "s",
  } as unknown as RoutingNode;
  // The interactive-agent row hands the Session to the human: it runs no Turn, rests
  // the Run `blocked`, and publishes no Attempt (end-interactive-step settles it).
  const report = await run([interactive], owner);
  assert.equal(report.outcome, "blocked");
  assert.equal(state(), "blocked");
  assert.equal(owner.attemptLog().length, 0);
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

  const report = await run(routing, owner);
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
  const fake = fakeExecutor();
  const routing: RoutingNode[] = [
    // Baseline binds `passing` = pass before the group is entered (exit 0).
    fakeStep(
      "baseline",
      { exit: 0 },
      { produces: produces({ name: "passing", type: "verdict" }) },
    ),
    // The group's Command would fail, but it must never run.
    fakeRepeat("check", { exit: 1 }, 5),
    // A node after the group proves the Run continues past a zero-iteration group.
    fakeStep(
      "after",
      { exit: 0, out: "after ran\n" },
      { produces: produces({ name: "done", type: "text" }) },
    ),
  ];

  const report = await run(routing, owner, { spawnCommand: fake.spawn });
  assert.deepEqual(report, { outcome: "succeeded" });
  assert.equal(state(), "succeeded");
  // Only the baseline and the trailing step ran — the group ran zero iterations.
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.outcome),
    ["succeeded", "succeeded"],
  );
  assert.equal(dec(readBound(owner, "done")), "after ran\n");
  // The group's Command executor was never called, so the group ran zero iterations.
  assert.equal(fake.calls("check"), 0);
});

// --- Fast in-process command executor (the SpawnCommand Seam's test Adapter) ---
//
// The loop-arithmetic tests below (Repeat-group cadence, resume, the review clamp)
// assert scheduler behaviour that does not depend on a real process — only on each
// Command's exit code driving the loop. Spawning a real runtime per iteration made
// them race the CI timeout on slow Windows runners (docs/agents/testing.md: a flaky
// test is fixed deterministically, not with a sleep, a retry, or a bumped timeout).
// So they inject this fake executor through the Seam and never spawn. The real spawn
// path stays covered by the Command-contract tests above and by the one real-spawn
// Repeat integration test ("fails twice then passes"), which together catch any
// drift between this fake and the process Module's `spawnCommand` contract.

const FAKE_MARKER = "--secant-fake";

/** A behaviour the fake executor replays: a fixed exit (optionally with captured
 *  stdout), or a counter that exits 1 until its `passAt`-th call then 0. */
type FakePlan =
  | { readonly exit: number; readonly out?: string }
  | { readonly passAt: number };

/** A Command Step wired to the fake executor: it carries its id and plan in its
 *  arguments and keeps a real, resolvable executable (`NODE`) so `resolveExecutable`
 *  still succeeds — but the injected fake replays the plan instead of spawning. */
function fakeStep(
  id: string,
  plan: FakePlan,
  step: Partial<CommandStep> = {},
): CommandStep {
  return commandStep(
    id,
    { executable: NODE, arguments: [FAKE_MARKER, id, JSON.stringify(plan)] },
    step,
  );
}

/** A single-step Repeat group whose `check` Command runs through the fake executor. */
function fakeRepeat(id: string, plan: FakePlan, interval: number): RoutingNode {
  return {
    repeat: {
      until: "passing",
      reviewCheckpoint: { interval, message: "please review the loop" },
      steps: [
        fakeStep(id, plan, {
          produces: produces({ name: "passing", type: "verdict" }),
        }),
      ],
    },
  };
}

/** The fake command executor and a per-Step call counter. It never spawns: it reads
 *  each Command's plan from its arguments and replays it, counting calls per Step id
 *  so a `passAt` counter advances across iterations and resumes (a skipped iteration
 *  never calls it, exactly as a real run never re-spawns one) and a test can assert a
 *  Step's Command never ran. */
function fakeExecutor(): {
  readonly spawn: SpawnCommand;
  readonly calls: (id: string) => number;
} {
  const counts = new Map<string, number>();
  const spawn: SpawnCommand = (options) => {
    const marker = options.args.indexOf(FAKE_MARKER);
    if (marker === -1 || marker + 2 >= options.args.length) {
      throw new Error(
        "fakeExecutor: a Command was not wired through fakeStep.",
      );
    }
    const id = options.args[marker + 1]!;
    const plan = JSON.parse(options.args[marker + 2]!) as FakePlan;
    const n = (counts.get(id) ?? 0) + 1;
    counts.set(id, n);
    const status = "passAt" in plan ? (n >= plan.passAt ? 0 : 1) : plan.exit;
    const out = "passAt" in plan ? "" : (plan.out ?? "");
    return Promise.resolve({
      kind: "exited",
      status,
      text: new TextEncoder().encode(out),
    });
  };
  return { spawn, calls: (id) => counts.get(id) ?? 0 };
}

test("a Repeat group that always fails blocks after `interval` iterations", async (t) => {
  const { owner, state } = ownerForFreshRun(t);
  const fake = fakeExecutor();
  const report = await run([fakeRepeat("check", { exit: 1 }, 3)], owner, {
    spawnCommand: fake.spawn,
  });
  assert.deepEqual(report, { outcome: "blocked" });
  assert.equal(state(), "blocked");
  // Exactly three iterations ran before the checkpoint; every one a fail Verdict.
  assert.deepEqual(
    owner.attemptLog().map((entry) => entry.outcome),
    ["succeeded", "succeeded", "succeeded"],
  );
  assert.equal(dec(readBound(owner, "passing")), "fail");
  assert.equal(fake.calls("check"), 3);
});

test("an authored interval above the engine ceiling never delays the checkpoint beyond the ceiling", async (t) => {
  const { owner } = ownerForFreshRun(t);
  const fake = fakeExecutor();
  const report = await run(
    [fakeRepeat("check", { exit: 1 }, MAX_REVIEW_CHECKPOINT_INTERVAL + 150)],
    owner,
    { spawnCommand: fake.spawn },
  );
  assert.deepEqual(report, { outcome: "blocked" });
  // The clamp caps iterations-between-reviews at the ceiling, not the authored 250.
  // The fake exits deterministically, so every iteration is one `succeeded` Attempt.
  const iterations = owner
    .attemptLog()
    .filter((entry) => entry.outcome === "succeeded").length;
  assert.equal(iterations, MAX_REVIEW_CHECKPOINT_INTERVAL);
  assert.equal(fake.calls("check"), MAX_REVIEW_CHECKPOINT_INTERVAL);
});

test("resuming a blocked Repeat group runs exactly one more interval and blocks again (#85)", async (t) => {
  const { owner, state } = ownerForFreshRun(t);
  const fake = fakeExecutor();
  // First interval: three iterations, then durably blocked.
  assert.deepEqual(
    await run([fakeRepeat("check", { exit: 1 }, 3)], owner, {
      spawnCommand: fake.spawn,
    }),
    { outcome: "blocked" },
  );
  assert.equal(owner.attemptLog().length, 3);
  assert.equal(state(), "blocked");

  // Resume in the same owner (a `continue` grant re-walks the Routing): the three
  // prior iterations are replayed by identity without spawning, and a fresh interval
  // of three runs before the Run blocks again — the count advanced from 3 to 6.
  assert.deepEqual(
    await run([fakeRepeat("check", { exit: 1 }, 3)], owner, {
      spawnCommand: fake.spawn,
    }),
    { outcome: "blocked" },
  );
  assert.equal(
    owner.attemptLog().filter((e) => e.outcome === "succeeded").length,
    6,
  );
  assert.equal(state(), "blocked");
  // Only fresh iterations spawned: three the first run, three the second — the
  // replayed iterations never re-ran.
  assert.equal(fake.calls("check"), 6);
});

test("a granted interval that makes the Verdict pass rests the Run succeeded (#85)", async (t) => {
  const { owner, state } = ownerForFreshRun(t);
  const fake = fakeExecutor();
  // passAt 5, interval 3: the first interval (iterations 1-3) fails and blocks.
  assert.deepEqual(
    await run([fakeRepeat("check", { passAt: 5 }, 3)], owner, {
      spawnCommand: fake.spawn,
    }),
    { outcome: "blocked" },
  );
  assert.equal(owner.attemptLog().length, 3);

  // The granted interval continues the shared counter (call 4, then 5 = pass) and
  // the deciding Attempt rests the Run succeeded within the interval.
  assert.deepEqual(
    await run([fakeRepeat("check", { passAt: 5 }, 3)], owner, {
      spawnCommand: fake.spawn,
    }),
    { outcome: "succeeded" },
  );
  assert.equal(state(), "succeeded");
  assert.equal(dec(readBound(owner, "passing")), "pass");
  assert.equal(owner.attemptLog().length, 5);
});

test("resuming past a group that already passed consumes no skip and does not re-run a later Step (#85)", async (t) => {
  const { owner } = ownerForFreshRun(t);
  const fake = fakeExecutor();
  const routing: RoutingNode[] = [
    // Baseline binds `passing` = pass, so the group runs zero iterations.
    fakeStep(
      "baseline",
      { exit: 0 },
      { produces: produces({ name: "passing", type: "verdict" }) },
    ),
    // Would fail every iteration, but `passing` is already pass, so it never runs.
    fakeRepeat("check", { exit: 1 }, 5),
    fakeStep(
      "after",
      { exit: 0, out: "after\n" },
      { produces: produces({ name: "done", type: "text" }) },
    ),
  ];
  assert.deepEqual(await run(routing, owner, { spawnCommand: fake.spawn }), {
    outcome: "succeeded",
  });
  assert.equal(owner.attemptLog().length, 2); // baseline + after

  // Resume: the already-passed group must consume none of the skip budget (it is
  // not the terminal node), so `after` stays skipped rather than re-running, and
  // the group's Command never runs.
  assert.deepEqual(await run(routing, owner, { spawnCommand: fake.spawn }), {
    outcome: "succeeded",
  });
  assert.equal(owner.attemptLog().length, 2);
  assert.equal(fake.calls("check"), 0);
});

test("resume re-runs a Step that failed after a passed Repeat group, never resting succeeded (A1)", async (t) => {
  const { owner, state } = ownerForFreshRun(t);
  const fake = fakeExecutor();
  const afterAttempts = () =>
    owner.attemptLog().filter((e) => e.attemptId.endsWith(":after")).length;
  const routing: RoutingNode[] = [
    fakeStep(
      "baseline",
      { exit: 0 },
      { produces: produces({ name: "b", type: "text" }) },
    ),
    // Passes on its first iteration, so on resume it early-returns already-pass.
    fakeRepeat("check", { passAt: 1 }, 5),
    // Cannot spawn (missing binary): resolveExecutable fails before the Seam, so the
    // fake is never reached and the Run rests failed. retry: 0 keeps one failed
    // Attempt per run, so the re-run is unambiguous to count.
    commandStep(
      "after",
      { executable: "secant-no-such-binary-xyz", arguments: [] },
      { produces: produces({ name: "after-done", type: "text" }), retry: 0 },
    ),
  ];

  // First run: baseline succeeds, the group passes on iteration 1, `after` fails.
  assert.deepEqual(await run(routing, owner, { spawnCommand: fake.spawn }), {
    outcome: "failed",
  });
  assert.equal(state(), "failed");
  assert.equal(
    owner.attemptLog().filter((e) => e.outcome === "succeeded").length,
    2, // baseline + the one group iteration
  );
  assert.equal(afterAttempts(), 1);
  assert.equal(fake.calls("check"), 1); // one iteration ran

  // Resume: the old flat cursor leaked the group's iteration budget to `after` and
  // skipped it, resting the Run `succeeded` with no new Attempt. Skipping by Step
  // identity, `after` re-runs and the Run rests `failed` — never succeeded.
  assert.deepEqual(await run(routing, owner, { spawnCommand: fake.spawn }), {
    outcome: "failed",
  });
  assert.equal(state(), "failed");
  assert.equal(afterAttempts(), 2); // `after` re-ran
  // The already-passed group did not re-run — its executor was not called again.
  assert.equal(fake.calls("check"), 1);
});

/** Read the bytes currently bound to an artifact name through the owner. */
function readBound(owner: RunOwner, name: string): Uint8Array | undefined {
  const versionId = owner.currentVersion(name);
  return versionId === undefined
    ? undefined
    : owner.readArtifact(versionId, name);
}
