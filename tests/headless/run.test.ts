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
  writeRepeatBundle,
  type RepeatBundleOptions,
} from "../helpers/commandBundle.js";
import { openHeadlessHarness } from "../helpers/headlessHarness.js";
import { makeTempDir } from "../helpers/tempDir.js";

ensureRuntimeOnPath();

function harness(t: TestContext, opts: { commandTimeoutMs?: number } = {}) {
  const h = openHeadlessHarness(t, {
    slug: "secant-runcli",
    ...(opts.commandTimeoutMs !== undefined
      ? { commandTimeoutMs: opts.commandTimeoutMs }
      : {}),
  });
  return {
    ...h,
    install: (bundleOpts?: Parameters<typeof writeCommandBundle>[0]) => {
      const cmd = writeCommandBundle(bundleOpts);
      assert.equal(h.run(["bundle", "build", cmd.folder]), 0);
      h.reset();
      const entry = h.catalog.listEntries().find((e) => e.id === cmd.id);
      assert.ok(entry);
      return { id: cmd.id, digest: entry.digest };
    },
    installRepeat: (repeatOpts: RepeatBundleOptions) => {
      const bundle = writeRepeatBundle(repeatOpts);
      assert.equal(h.run(["bundle", "build", bundle.folder]), 0);
      h.reset();
      const entry = h.catalog.listEntries().find((e) => e.id === bundle.id);
      assert.ok(entry);
      return { id: bundle.id, digest: entry.digest };
    },
    approve: () => h.catalog.approveWorkspace(h.workspace, new Date()),
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
  // A resolvable executable whose Attempt fails at runtime: the command runs past
  // a short command timeout, so spawnSync kills it and reports no exit status —
  // a failed Attempt on every platform (a clean non-zero exit would instead be a
  // `fail` verdict on a *succeeded* Attempt, and Windows has no real signals to
  // force one). An off-PATH executable is now refused by Preflight before a Run
  // exists (see tests/application/preflight.test.ts).
  const h = await harness(t, { commandTimeoutMs: 200 });
  const { id, digest } = h.install({
    script: "setTimeout(() => {}, 60000)",
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

// --- Repeat groups (#84, ADR 0020) -----------------------------------------

test("run launch on a blocking Repeat group names the Run and blocked, and exits non-zero", async (t) => {
  const h = await harness(t);
  const { id, digest } = h.installRepeat({ interval: 3 });
  h.approve();

  assert.equal(
    runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io),
    1,
  );
  assert.match(h.stdout(), /^Run /m);
  assert.match(h.stdout(), /^State: blocked$/m);
});

test("run show prints the Review checkpoint facts for a blocked Run", async (t) => {
  const h = await harness(t);
  const { id, digest } = h.installRepeat({
    interval: 3,
    message: "human, please look",
  });
  h.approve();

  runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io);
  const runId = /^Run (\S+)$/m.exec(h.stdout())![1]!;
  h.reset();

  assert.equal(runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  const out = h.stdout();
  assert.match(out, /^State: blocked$/m);
  assert.match(out, /Review checkpoint:/);
  assert.match(out, /message: human, please look/);
  assert.match(out, /cadence: every 3 iteration/);
  assert.match(out, /completed iterations: 3/);
  assert.match(out, /latest verdict: passing = fail/);
  assert.match(out, /gate: approve-reject at step check/);
});

test("run show --json carries the checkpoint for a blocked Run", async (t) => {
  const h = await harness(t);
  const { id, digest } = h.installRepeat({ interval: 2 });
  h.approve();

  runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io);
  const runId = /^Run (\S+)$/m.exec(h.stdout())![1]!;
  h.reset();

  assert.equal(
    runHeadless(h.clients, ["run", "show", runId, "--json"], h.io),
    0,
  );
  const snapshot = JSON.parse(h.stdout()) as {
    result: {
      found: boolean;
      run: {
        state: string;
        checkpoint?: {
          completedIterations: number;
          gate: { attemptId: string; stepId: string };
        };
      };
    };
  };
  assert.ok(snapshot.result.found);
  assert.equal(snapshot.result.run.state, "blocked");
  assert.equal(snapshot.result.run.checkpoint?.completedIterations, 2);
  assert.equal(snapshot.result.run.checkpoint?.gate.stepId, "check");
  assert.match(snapshot.result.run.checkpoint?.gate.attemptId ?? "", /\S/);
});

// --- Answering the Human Gate (#85, ADR 0020) ------------------------------

/** Launch a blocking Repeat Bundle and return its blocked Run id. */
function launchBlocked(
  h: Awaited<ReturnType<typeof harness>>,
  opts: RepeatBundleOptions,
): string {
  const { id, digest } = h.installRepeat(opts);
  h.approve();
  runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io);
  const runId = /^Run (\S+)$/m.exec(h.stdout())![1]!;
  h.reset();
  return runId;
}

test("run answer --continue grants an interval that passes and rests the Run succeeded", async (t) => {
  const h = await harness(t);
  // interval 2, passes on the 3rd iteration: the first interval blocks, the
  // granted interval reaches the pass.
  const runId = launchBlocked(h, { interval: 2, passAt: 3 });

  assert.equal(
    runHeadless(h.clients, ["run", "answer", runId, "--continue"], h.io),
    0,
  );
  const out = h.stdout();
  assert.match(out, /Answered: continue/);
  assert.match(out, /^State: succeeded$/m);
});

test("run answer --continue that keeps failing blocks again with a fresh interval", async (t) => {
  const h = await harness(t);
  const runId = launchBlocked(h, { interval: 2 }); // always fails

  // The first gate.
  runHeadless(h.clients, ["run", "show", runId, "--json"], h.io);
  const before = parseRun(h.stdout());
  h.reset();
  assert.equal(before.checkpoint?.completedIterations, 2);
  const firstGate = before.checkpoint?.gate.attemptId;

  assert.equal(
    runHeadless(h.clients, ["run", "answer", runId, "--continue"], h.io),
    1, // blocked again, so non-zero
  );
  assert.match(h.stdout(), /^State: blocked$/m);
  h.reset();

  runHeadless(h.clients, ["run", "show", runId, "--json"], h.io);
  const after = parseRun(h.stdout());
  assert.equal(after.state, "blocked");
  // The count reset to the interval since the grant, and the block moved to a
  // fresh Attempt — a new interval actually ran.
  assert.equal(after.checkpoint?.completedIterations, 2);
  assert.notEqual(after.checkpoint?.gate.attemptId, firstGate);
});

test("run answer --stop rests the Run failed with its history and Artifacts intact", async (t) => {
  const h = await harness(t);
  const runId = launchBlocked(h, { interval: 2 });

  assert.equal(
    runHeadless(h.clients, ["run", "answer", runId, "--stop"], h.io),
    1,
  );
  assert.match(h.stdout(), /Answered: stop/);
  assert.match(h.stdout(), /^State: failed$/m);
  h.reset();

  // The answer is a durable, readable Artifact; the loop's Verdict is still
  // readable; the timeline records the answer.
  assert.equal(
    runHeadless(h.clients, ["run", "read", `${runId}/human-gate-answer`], h.io),
    0,
  );
  assert.match(h.stdout(), /^stop$/m);
  h.reset();
  assert.equal(
    runHeadless(h.clients, ["run", "read", `${runId}/passing`], h.io),
    0,
  );
  assert.match(h.stdout(), /^fail$/m);
  h.reset();
  runHeadless(h.clients, ["run", "show", runId], h.io);
  assert.match(h.stdout(), /gate-answered stop/);
});

test("run show offers the answer action only while blocked, naming each consequence", async (t) => {
  const h = await harness(t);
  const runId = launchBlocked(h, { interval: 2, passAt: 3 });

  // While blocked, the offer appears and states the consequence of each answer.
  runHeadless(h.clients, ["run", "show", runId], h.io);
  const blocked = h.stdout();
  assert.match(blocked, /Answer the checkpoint:/);
  assert.match(
    blocked,
    /run answer .* --continue .*grant one more review interval/,
  );
  assert.match(blocked, /run answer .* --stop .*end the Run failed/);
  h.reset();

  // Once answered (and succeeded), the offer is gone.
  runHeadless(h.clients, ["run", "answer", runId, "--continue"], h.io);
  h.reset();
  runHeadless(h.clients, ["run", "show", runId], h.io);
  assert.doesNotMatch(h.stdout(), /Answer the checkpoint:/);
});

test("run answer on a Run that is not blocked is refused, changing nothing", async (t) => {
  const h = await harness(t);
  const { id, digest } = h.install(); // a straight-line Bundle that succeeds
  h.approve();
  runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io);
  const runId = /^Run (\S+)$/m.exec(h.stdout())![1]!;
  h.reset();

  assert.equal(
    runHeadless(h.clients, ["run", "answer", runId, "--continue"], h.io),
    1,
  );
  assert.match(h.stderr(), /run-not-blocked/);
});

test("run answer needs exactly one of --continue or --stop", async (t) => {
  const h = await harness(t);
  assert.equal(runHeadless(h.clients, ["run", "answer", "some-run"], h.io), 1);
  assert.match(h.stderr(), /invalid-answer/);
});

test("two invocations: block under one instance, continue under a fresh instance over the same home (#85, AC6)", async (t) => {
  ensureRuntimeOnPath();
  const catalogHome = makeTempDir("secant-2inv-cat-");
  const storeHome = makeTempDir("secant-2inv-store-");
  const workspace = realpathSync.native(makeTempDir("secant-2inv-ws-"));
  const mkExecution: RunExecution = ({ routing, owner }) =>
    executeRouting(routing, {
      owner,
      platform: hostPlatform(),
      resolveAsset: () => undefined,
    });
  const sink = () => {
    const lines: string[] = [];
    const io: HeadlessIO = {
      out: (t) => lines.push(t),
      err: (t) => lines.push(t),
      cwd: () => workspace,
    };
    return { io, text: () => lines.join("") };
  };

  // A Repeat Bundle that passes on its 3rd iteration, interval 2: the first
  // instance blocks after two iterations, the second instance's granted interval
  // reaches the pass.
  const bundle = writeRepeatBundle({ interval: 2, passAt: 3 });

  // Instance A: build, approve, launch → blocked.
  const catA = openCatalog(catalogHome);
  const groupA = openRunGroup(storeHome, workspace);
  const appA = createApplication({
    catalog: catA,
    launchWorkspacePath: workspace,
    runGroup: groupA,
    runExecution: mkExecution,
  });
  const a = sink();
  assert.equal(runHeadless(appA, ["bundle", "build", bundle.folder], a.io), 0);
  const entry = catA.listEntries().find((e) => e.id === bundle.id)!;
  catA.approveWorkspace(workspace, new Date());
  const launch = sink();
  assert.equal(
    runHeadless(
      appA,
      ["run", "launch", bundle.id, "--trust", entry.digest],
      launch.io,
    ),
    1,
  );
  const runId = /^Run (\S+)$/m.exec(launch.text())![1]!;
  assert.match(launch.text(), /^State: blocked$/m);
  groupA.close();
  catA.close();

  // Instance B: a fresh Application over the same Secant home answers the durable
  // Gate and drives the Run to completion.
  const catB = openCatalog(catalogHome);
  const groupB = openRunGroup(storeHome, workspace);
  t.after(() => groupB.close());
  const appB = createApplication({
    catalog: catB,
    launchWorkspacePath: workspace,
    runGroup: groupB,
    runExecution: mkExecution,
  });
  t.after(() => catB.close());
  const b = sink();
  assert.equal(
    runHeadless(appB, ["run", "answer", runId, "--continue"], b.io),
    0,
  );
  assert.match(b.text(), /^State: succeeded$/m);
});

test("run resume of a Run rested failed by a checkpoint stop resets bounds and blocks after another full interval (#86, AC2)", async (t) => {
  const h = await harness(t);
  const runId = launchBlocked(h, { interval: 2 }); // always fails

  // Stop at the checkpoint: the Run rests failed.
  assert.equal(
    runHeadless(h.clients, ["run", "answer", runId, "--stop"], h.io),
    1,
  );
  assert.match(h.stdout(), /^State: failed$/m);
  h.reset();

  // Resume the failed Run: its Iteration bounds reset, so it runs another full
  // interval and blocks again (non-zero exit), rather than staying failed.
  assert.equal(runHeadless(h.clients, ["run", "resume", runId], h.io), 1);
  assert.match(h.stdout(), /^State: blocked$/m);
  h.reset();

  runHeadless(h.clients, ["run", "show", runId, "--json"], h.io);
  const after = parseRun(h.stdout());
  assert.equal(after.state, "blocked");
  // A full fresh interval ran since the grant, not zero and not a partial count.
  assert.equal(after.checkpoint?.completedIterations, 2);
});

test("run show offers the resume action only while resting failed or halted (#86)", async (t) => {
  const h = await harness(t);
  const runId = launchBlocked(h, { interval: 2 });
  runHeadless(h.clients, ["run", "answer", runId, "--stop"], h.io); // rest failed
  h.reset();

  runHeadless(h.clients, ["run", "show", runId], h.io);
  const failed = h.stdout();
  assert.match(failed, /^State: failed$/m);
  assert.match(failed, /Resume:/);
  assert.match(failed, /secant run resume .*grant another try/);
  h.reset();

  // A succeeded Run offers no resume.
  const { id, digest } = h.install();
  h.approve();
  runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io);
  const doneId = /^Run (\S+)$/m.exec(h.stdout())![1]!;
  h.reset();
  runHeadless(h.clients, ["run", "show", doneId], h.io);
  assert.match(h.stdout(), /^State: succeeded$/m);
  assert.doesNotMatch(h.stdout(), /Resume:/);
});

/** Parse a `run show --json` snapshot's run view (blocked-run shape). */
function parseRun(json: string): {
  state: string;
  checkpoint?: {
    completedIterations: number;
    gate: { attemptId: string };
  };
} {
  const snapshot = JSON.parse(json) as {
    result: { found: boolean; run: ReturnType<typeof parseRun> };
  };
  assert.ok(snapshot.result.found);
  return snapshot.result.run;
}
