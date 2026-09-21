import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  TRANSCRIPT_PAGE_SIZE,
  type RunExecution,
} from "../../src/application/application.js";
import { type HeadlessIO, runHeadless } from "../../src/headless/headless.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { executeRouting } from "../../src/run/execution/execution.js";
import { createApplication } from "../helpers/application.js";
import { openFakeRunGroup as openRunGroup } from "../run/store/fake-git-process.js";
import { createFakeBundleProcess } from "../helpers/fakeBundleProcess.js";
import {
  hostPlatform,
  writeCommandBundle,
  writeGateBundle,
  writeRepeatBundle,
  type GateBundleOptions,
  type RepeatBundleOptions,
} from "../helpers/commandBundle.js";
import { openHeadlessHarness } from "../helpers/headlessHarness.js";
import { makeTempDir } from "../helpers/tempDir.js";

const executionProcess = createFakeBundleProcess();

function harness(t: TestContext, opts: { commandTimeoutMs?: number } = {}) {
  const h = openHeadlessHarness(t, {
    slug: "secant-runcli",
    ...(opts.commandTimeoutMs !== undefined
      ? { commandTimeoutMs: opts.commandTimeoutMs }
      : {}),
  });
  return {
    ...h,
    install: async (bundleOpts?: Parameters<typeof writeCommandBundle>[0]) => {
      const cmd = writeCommandBundle(bundleOpts);
      assert.equal(await h.run(["bundle", "build", cmd.folder]), 0);
      h.reset();
      const entry = h.catalog.listEntries().find((e) => e.id === cmd.id);
      assert.ok(entry);
      return { id: cmd.id, digest: entry.digest };
    },
    installRepeat: async (repeatOpts: RepeatBundleOptions) => {
      const bundle = writeRepeatBundle(repeatOpts);
      assert.equal(await h.run(["bundle", "build", bundle.folder]), 0);
      h.reset();
      const entry = h.catalog.listEntries().find((e) => e.id === bundle.id);
      assert.ok(entry);
      return { id: bundle.id, digest: entry.digest };
    },
    installGate: async (gateOpts: GateBundleOptions) => {
      const bundle = writeGateBundle(gateOpts);
      assert.equal(await h.run(["bundle", "build", bundle.folder]), 0);
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
  const { id, digest } = await h.install();
  h.approve();

  assert.equal(await runHeadless(h.clients, ["run", "launch", id], h.io), 1);
  const err = h.stderr();
  assert.match(err, /bundle-trust-required/);
  assert.match(err, /Execution summary/);
  assert.match(err, /current user's authority/);
  assert.match(err, new RegExp(digest));
  assert.equal(h.stdout(), "");
});

test("[headless-on-doubles] run launch --trust runs to succeeded, and a second launch needs no trust", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();

  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "launch", id, "--trust", digest],
      h.io,
    ),
    0,
  );
  assert.match(h.stdout(), /^Run /m);
  assert.match(h.stdout(), /^State: succeeded$/m);

  h.reset();
  assert.equal(await runHeadless(h.clients, ["run", "launch", id], h.io), 0);
  assert.match(h.stdout(), /^State: succeeded$/m);
});

test("[both-client-harness-selection] run launch rejects --harness for a Command-only Bundle", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "launch", id, "--trust", digest, "--harness", "codex"],
      h.io,
    ),
    1,
  );
  assert.match(h.stderr(), /harness-selection-irrelevant/);
  assert.equal(h.runGroup?.listRuns().length, 0);
});

test("run launch on an uninstalled Bundle exits non-zero with a Problem", async (t) => {
  const h = await harness(t);
  h.approve();
  assert.equal(
    await runHeadless(h.clients, ["run", "launch", "io.example.absent"], h.io),
    1,
  );
  assert.match(h.stderr(), /bundle-not-installed/);
});

test("run launch without an id exits non-zero", async (t) => {
  const h = await harness(t);
  assert.equal(await runHeadless(h.clients, ["run", "launch"], h.io), 1);
  assert.match(h.stderr(), /missing-bundle-id/);
});

test("run show prints identity, state, progress, position, and timeline; --json carries the snapshot", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install({
    script: "console.log('shown-output')",
  });
  h.approve();
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "launch", id, "--trust", digest],
      h.io,
    ),
    0,
  );
  const runId = h.stdout().match(/^Run (\S+)/m)?.[1];
  assert.ok(runId);
  h.reset();

  assert.equal(await runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  const text = h.stdout();
  assert.match(text, new RegExp(`Run ${runId}`));
  assert.match(text, /State: succeeded/);
  assert.match(text, /Progress:/);
  assert.match(text, /run-check \(command\): succeeded/);
  assert.match(text, /Position: at rest/);
  assert.match(text, /Timeline:/);
  assert.match(text, /run-created/);
  assert.doesNotMatch(text, /Selected Harness:/);
  assert.doesNotMatch(text, /Observed Harness:/);

  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io),
    0,
  );
  const snapshot = JSON.parse(h.stdout()) as {
    family: string;
    result: {
      found: boolean;
      run: {
        state: string;
        selectedHarness?: unknown;
        harness?: unknown;
        effectiveModel?: unknown;
      };
    };
  };
  assert.equal(snapshot.family, "run");
  assert.equal(snapshot.result.run.state, "succeeded");
  assert.equal(snapshot.result.run.selectedHarness, undefined);
  assert.equal(snapshot.result.run.harness, undefined);
  assert.equal(snapshot.result.run.effectiveModel, undefined);
});

test("run launch of a Run that rests failed exits non-zero and shows the failed Step", async (t) => {
  // A resolvable executable whose Attempt fails at runtime: the command runs past
  // a short command timeout, so spawnSync kills it and reports no exit status —
  // a failed Attempt on every platform (a clean non-zero exit would instead be a
  // `fail` verdict on a *succeeded* Attempt, and Windows has no real signals to
  // force one). An off-PATH executable is now refused by Preflight before a Run
  // exists (see tests/application/preflight.test.ts).
  const h = await harness(t, { commandTimeoutMs: 200 });
  const { id, digest } = await h.install({
    script: "setTimeout(() => {}, 60000)",
    retry: 0,
  });
  h.approve();

  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "launch", id, "--trust", digest],
      h.io,
    ),
    1,
  );
  assert.match(h.stdout(), /^State: failed$/m);
  const runId = h.stdout().match(/^Run (\S+)/m)?.[1];
  assert.ok(runId);

  h.reset();
  assert.equal(await runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  assert.match(h.stdout(), /run-check \(command\): failed/);
});

test("run show on an unknown Run id exits non-zero with a Problem", async (t) => {
  const h = await harness(t);
  assert.equal(
    await runHeadless(h.clients, ["run", "show", "no-such-run"], h.io),
    1,
  );
  assert.match(h.stderr(), /run-not-found/);
});

test("run read returns a text Artifact's content and a Verdict's value by reference", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install({ script: "console.log('read-me')" });
  h.approve();
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "launch", id, "--trust", digest],
      h.io,
    ),
    0,
  );
  const runId = h.stdout().match(/^Run (\S+)/m)?.[1];
  assert.ok(runId);

  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "read", `${runId}/output`], h.io),
    0,
  );
  assert.match(h.stdout(), /read-me/);

  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "read", `${runId}/verdict`], h.io),
    0,
  );
  assert.equal(h.stdout(), "pass\n");
});

test("run read of an unknown output exits non-zero", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "launch", id, "--trust", digest],
      h.io,
    ),
    0,
  );
  const runId = h.stdout().match(/^Run (\S+)/m)?.[1];
  assert.ok(runId);

  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "read", `${runId}/absent`], h.io),
    1,
  );
  assert.match(h.stderr(), /run-output-not-found/);
});

test("one multi-page transcript reads through both clients, no real Harness (#124)", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install();
  h.approve();
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "launch", id, "--trust", digest],
      h.io,
    ),
    0,
  );
  const runId = h.stdout().match(/^Run (\S+)/m)?.[1];
  assert.ok(runId);
  assert.ok(h.runGroup);

  // Seed a multi-page transcript directly in the Run Store — no Harness runs.
  const total = TRANSCRIPT_PAGE_SIZE + 5;
  const owner = h.runGroup.acquireRun(runId);
  assert.ok(owner);
  for (let i = 0; i < total; i++) {
    owner.admitTurn({
      turnId: `t-${i}`,
      attemptId: "0.0:agent",
      session: "s",
      origin: "managed",
      kind: "agent",
      input: `input ${i}`,
      recoveryCoordinate: "native",
      harness: "claude-code",
      at: new Date(),
    });
  }
  owner.close();

  // Client one — headless `run read --transcript`: a bounded newest page (with an
  // "older" hint) and the complete export.
  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "read", runId, "--transcript"], h.io),
    0,
  );
  const printed = h.stdout();
  assert.match(printed, /Transcript page \(s\)/);
  assert.match(printed, new RegExp(`input ${total - 1}`));
  assert.match(printed, /older entries retained/);
  assert.match(printed, /Complete transcript \(s\)/);
  assert.match(printed, /input 0\b/);

  // Client two — the Projection Port read seam the Workbench uses: the same page
  // is bounded and carries an opaque cursor; the export is complete.
  const opened = h.clients.projectionPort.openProjection({
    family: "run",
    runId,
  });
  const snapshot = opened.snapshot;
  opened.close();
  assert.ok(snapshot.result.found);
  const session = snapshot.result.run.sessions?.find((s) => s.session === "s");
  assert.ok(session?.transcriptPage);
  assert.ok(session.transcriptExport);
  const page = h.clients.projectionPort.readTranscript(session.transcriptPage);
  assert.ok(page.found && page.type === "transcript-page");
  assert.equal(page.entries.length, TRANSCRIPT_PAGE_SIZE);
  assert.ok(page.older, "the bounded page carries an opaque older cursor");
  const complete = h.clients.projectionPort.readTranscript(
    session.transcriptExport,
  );
  assert.ok(complete.found && complete.type === "transcript-export");
  assert.equal(complete.entries.length, total);
});

// --- Repeat groups (#84, ADR 0020) -----------------------------------------

test("run launch on a blocking Repeat group names the Run and blocked, and exits 2 at the checkpoint", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.installRepeat({ interval: 3 });
  h.approve();

  // A Run resting `blocked` at its Human Gate exits 2, distinct from a failure (A36).
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "launch", id, "--trust", digest],
      h.io,
    ),
    2,
  );
  assert.match(h.stdout(), /^Run /m);
  assert.match(h.stdout(), /^State: blocked$/m);
});

test("run show prints the Review checkpoint facts for a blocked Run", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.installRepeat({
    interval: 3,
    message: "human, please look",
  });
  h.approve();

  await runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io);
  const runId = /^Run (\S+)$/m.exec(h.stdout())![1]!;
  h.reset();

  assert.equal(await runHeadless(h.clients, ["run", "show", runId], h.io), 0);
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
  const { id, digest } = await h.installRepeat({ interval: 2 });
  h.approve();

  await runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io);
  const runId = /^Run (\S+)$/m.exec(h.stdout())![1]!;
  h.reset();

  assert.equal(
    await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io),
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
async function launchBlocked(
  h: Awaited<ReturnType<typeof harness>>,
  opts: RepeatBundleOptions,
): Promise<string> {
  const { id, digest } = await h.installRepeat(opts);
  h.approve();
  await runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io);
  const runId = /^Run (\S+)$/m.exec(h.stdout())![1]!;
  h.reset();
  return runId;
}

test("run answer --continue grants an interval that passes and rests the Run succeeded", async (t) => {
  const h = await harness(t);
  // interval 2, passes on the 3rd iteration: the first interval blocks, the
  // granted interval reaches the pass.
  const runId = await launchBlocked(h, { interval: 2, passAt: 3 });

  assert.equal(
    await runHeadless(h.clients, ["run", "answer", runId, "--continue"], h.io),
    0,
  );
  const out = h.stdout();
  assert.match(out, /Answered: continue/);
  assert.match(out, /^State: succeeded$/m);
});

test("run answer --continue that keeps failing blocks again with a fresh interval", async (t) => {
  const h = await harness(t);
  const runId = await launchBlocked(h, { interval: 2 }); // always fails

  // The first gate.
  await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io);
  const before = parseRun(h.stdout());
  h.reset();
  assert.equal(before.checkpoint?.completedIterations, 2);
  const firstGate = before.checkpoint?.gate.attemptId;

  assert.equal(
    await runHeadless(h.clients, ["run", "answer", runId, "--continue"], h.io),
    2, // blocked again at the checkpoint (A36)
  );
  assert.match(h.stdout(), /^State: blocked$/m);
  h.reset();

  await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io);
  const after = parseRun(h.stdout());
  assert.equal(after.state, "blocked");
  // The count reset to the interval since the grant, and the block moved to a
  // fresh Attempt — a new interval actually ran.
  assert.equal(after.checkpoint?.completedIterations, 2);
  assert.notEqual(after.checkpoint?.gate.attemptId, firstGate);
});

test("run answer --stop rests the Run failed with its history and Artifacts intact", async (t) => {
  const h = await harness(t);
  const runId = await launchBlocked(h, { interval: 2 });

  assert.equal(
    await runHeadless(h.clients, ["run", "answer", runId, "--stop"], h.io),
    1,
  );
  assert.match(h.stdout(), /Answered: stop/);
  assert.match(h.stdout(), /^State: failed$/m);
  h.reset();

  // The answer is a durable, readable Artifact; the loop's Verdict is still
  // readable; the timeline records the answer.
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "read", `${runId}/human-gate-answer`],
      h.io,
    ),
    0,
  );
  assert.match(h.stdout(), /^stop$/m);
  h.reset();
  assert.equal(
    await runHeadless(h.clients, ["run", "read", `${runId}/passing`], h.io),
    0,
  );
  assert.match(h.stdout(), /^fail$/m);
  h.reset();
  await runHeadless(h.clients, ["run", "show", runId], h.io);
  assert.match(h.stdout(), /gate-answered stop/);
});

test("run show offers the answer action only while blocked, naming each consequence", async (t) => {
  const h = await harness(t);
  const runId = await launchBlocked(h, { interval: 2, passAt: 3 });

  // While blocked, the offer appears and states the consequence of each answer.
  await runHeadless(h.clients, ["run", "show", runId], h.io);
  const blocked = h.stdout();
  assert.match(blocked, /Answer the checkpoint:/);
  assert.match(
    blocked,
    /run answer .* --continue .*grant one more review interval/,
  );
  assert.match(blocked, /run answer .* --stop .*end the Run failed/);
  h.reset();

  // Once answered (and succeeded), the offer is gone.
  await runHeadless(h.clients, ["run", "answer", runId, "--continue"], h.io);
  h.reset();
  await runHeadless(h.clients, ["run", "show", runId], h.io);
  assert.doesNotMatch(h.stdout(), /Answer the checkpoint:/);
});

test("run answer on a Run that is not blocked is refused, changing nothing", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.install(); // a straight-line Bundle that succeeds
  h.approve();
  await runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io);
  const runId = /^Run (\S+)$/m.exec(h.stdout())![1]!;
  h.reset();

  assert.equal(
    await runHeadless(h.clients, ["run", "answer", runId, "--continue"], h.io),
    1,
  );
  assert.match(h.stderr(), /run-not-blocked/);
});

test("run answer needs exactly one of --continue or --stop", async (t) => {
  const h = await harness(t);
  assert.equal(
    await runHeadless(h.clients, ["run", "answer", "some-run"], h.io),
    1,
  );
  assert.match(h.stderr(), /invalid-answer/);
});

test("two invocations: block under one instance, continue under a fresh instance over the same home (#85, AC6)", async (t) => {
  const catalogHome = makeTempDir("secant-2inv-cat-");
  const storeHome = makeTempDir("secant-2inv-store-");
  const workspace = realpathSync.native(makeTempDir("secant-2inv-ws-"));
  const mkExecution: RunExecution = ({ routing, owner }) =>
    executeRouting(routing, {
      owner,
      platform: hostPlatform(),
      resolveAsset: () => undefined,
      process: executionProcess,
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
  assert.equal(
    await runHeadless(appA, ["bundle", "build", bundle.folder], a.io),
    0,
  );
  const entry = catA.listEntries().find((e) => e.id === bundle.id)!;
  catA.approveWorkspace(workspace, new Date());
  const launch = sink();
  assert.equal(
    await runHeadless(
      appA,
      ["run", "launch", bundle.id, "--trust", entry.digest],
      launch.io,
    ),
    2, // blocked at the checkpoint (A36)
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
    await runHeadless(appB, ["run", "answer", runId, "--continue"], b.io),
    0,
  );
  assert.match(b.text(), /^State: succeeded$/m);
});

test("run resume reports a live foreign owner and --takeover continues while fencing it", async (t) => {
  const catalogHome = makeTempDir("secant-takeover-cat-");
  const storeHome = makeTempDir("secant-takeover-store-");
  const workspace = realpathSync.native(makeTempDir("secant-takeover-ws-"));
  const catalog = openCatalog(catalogHome);
  t.after(() => catalog.close());
  const first = openRunGroup(storeHome, workspace, { selfPid: 1000 });
  t.after(() => first.close());
  const buildApp = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    runGroup: first,
    runExecution: ({ routing, owner }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
        process: executionProcess,
      }),
  });
  const bundle = writeCommandBundle({ id: "dev.secant.takeover" });
  const built = buildApp.bundleManagement.build(bundle.folder, {
    noInstall: false,
  });
  assert.ok(built.ok, JSON.stringify(built));
  const entry = catalog
    .listEntries()
    .find((candidate) => candidate.id === bundle.id);
  assert.ok(entry);
  catalog.approveWorkspace(workspace, new Date());
  catalog.grantTrust({
    operationId: "trust-takeover",
    digest: entry.digest,
    installationGeneration: entry.installationGeneration,
    grantedAt: new Date(),
  });
  const created = first.createRun({
    operationId: "create-takeover",
    bundleSnapshotDigest: entry.digest,
    launch: {},
    at: new Date(),
  });
  assert.equal(created.outcome, "created");
  const priorOwner = first.acquireRun(created.runId);
  assert.ok(priorOwner);
  t.after(() => priorOwner.close());
  assert.deepEqual(priorOwner.writeState("running"), { ok: true });

  const second = openRunGroup(storeHome, workspace, {
    selfPid: 2000,
    isOwnerAlive: (pid) => pid === 1000,
  });
  t.after(() => second.close());
  const app = createApplication({
    catalog,
    launchWorkspacePath: workspace,
    runGroup: second,
    runExecution: ({ routing, owner }) =>
      executeRouting(routing, {
        owner,
        platform: hostPlatform(),
        resolveAsset: () => undefined,
        process: executionProcess,
      }),
  });
  const output: string[] = [];
  const io: HeadlessIO = {
    out: (text) => output.push(text),
    err: (text) => output.push(text),
    cwd: () => workspace,
  };

  assert.equal(await runHeadless(app, ["run", "resume", created.runId], io), 1);
  assert.match(output.join(""), /run-live-elsewhere/);
  assert.match(output.join(""), /process 1000/);
  output.length = 0;

  // `run show` names the foreign owner in its header while the Run is live
  // elsewhere (ADR 0031).
  assert.equal(await runHeadless(app, ["run", "show", created.runId], io), 0);
  assert.match(
    output.join(""),
    /^Live: in another instance \(process 1000\)$/m,
  );
  output.length = 0;

  assert.equal(
    await runHeadless(app, ["run", "resume", created.runId, "--takeover"], io),
    0,
  );
  assert.match(output.join(""), /^State: succeeded$/m);
  assert.deepEqual(priorOwner.writeState("cancelled"), {
    ok: false,
    reason: "fenced",
  });
  assert.deepEqual(priorOwner.release(), { ok: false, reason: "fenced" });
});

test("run resume of a Run rested failed by a checkpoint stop resets bounds and blocks after another full interval (#86, AC2)", async (t) => {
  const h = await harness(t);
  const runId = await launchBlocked(h, { interval: 2 }); // always fails

  // Stop at the checkpoint: the Run rests failed.
  assert.equal(
    await runHeadless(h.clients, ["run", "answer", runId, "--stop"], h.io),
    1,
  );
  assert.match(h.stdout(), /^State: failed$/m);
  h.reset();

  // Resume the failed Run: its Iteration bounds reset, so it runs another full
  // interval and blocks again (exit 2 at the checkpoint, A36), rather than failed.
  assert.equal(await runHeadless(h.clients, ["run", "resume", runId], h.io), 2);
  assert.match(h.stdout(), /^State: blocked$/m);
  h.reset();

  await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io);
  const after = parseRun(h.stdout());
  assert.equal(after.state, "blocked");
  // A full fresh interval ran since the grant, not zero and not a partial count.
  assert.equal(after.checkpoint?.completedIterations, 2);
});

test("run show offers the resume action only while resting failed or halted (#86)", async (t) => {
  const h = await harness(t);
  const runId = await launchBlocked(h, { interval: 2 });
  await runHeadless(h.clients, ["run", "answer", runId, "--stop"], h.io); // rest failed
  h.reset();

  await runHeadless(h.clients, ["run", "show", runId], h.io);
  const failed = h.stdout();
  assert.match(failed, /^State: failed$/m);
  assert.match(failed, /Resume:/);
  assert.match(failed, /secant run resume .*grant another try/);
  h.reset();

  // A succeeded Run offers no resume.
  const { id, digest } = await h.install();
  h.approve();
  await runHeadless(h.clients, ["run", "launch", id, "--trust", digest], h.io);
  const doneId = /^Run (\S+)$/m.exec(h.stdout())![1]!;
  h.reset();
  await runHeadless(h.clients, ["run", "show", doneId], h.io);
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

// --- Authored Human Gate, headless end to end (#108) ------------------------

/** Launch an authored Human Gate Bundle and return its blocked Run id, asserting
 *  it exits 2 at the gate and names the follow-up answer command. */
async function launchGate(
  h: Awaited<ReturnType<typeof harness>>,
  opts: GateBundleOptions,
): Promise<string> {
  const { id, digest } = await h.installGate(opts);
  h.approve();
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "launch", id, "--trust", digest],
      h.io,
    ),
    2,
  );
  const out = h.stdout();
  assert.match(out, /^State: blocked$/m);
  const runId = /^Run (\S+)$/m.exec(out)![1]!;
  h.reset();
  return runId;
}

test("a free-text gate rests blocked naming run answer --text, and answering continues the Run reading the bound answer (#108, AC1)", async (t) => {
  const h = await harness(t);
  const { id, digest } = await h.installGate({
    shape: "free-text",
    message: "name the release",
    outputName: "answer",
  });
  h.approve();

  // The Run rests blocked at the gate, exits 2, and names the follow-up command.
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "launch", id, "--trust", digest],
      h.io,
    ),
    2,
  );
  const launch = h.stdout();
  assert.match(launch, /^State: blocked$/m);
  assert.match(launch, /run answer .*--text/);
  const runId = /^Run (\S+)$/m.exec(launch)![1]!;
  h.reset();

  // A later invocation answers with free text; the Run continues in that process
  // and the downstream Command reads the bound answer, resting succeeded (exit 0).
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "answer", runId, "--text", "v2.0.0"],
      h.io,
    ),
    0,
  );
  assert.match(h.stdout(), /Answered: v2\.0\.0/);
  assert.match(h.stdout(), /^State: succeeded$/m);
  h.reset();

  // The free-text answer is published as the gate's declared `text` output.
  assert.equal(
    await runHeadless(h.clients, ["run", "read", `${runId}/answer`], h.io),
    0,
  );
  assert.match(h.stdout(), /^v2\.0\.0$/m);
});

test("an authored approve-reject gate: --continue advances succeeded, --stop rests failed (#108, AC2)", async (t) => {
  const h = await harness(t);
  const approveId = await launchGate(h, {
    id: "dev.secant.gate-cli-approve",
    shape: "approve-reject",
  });
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "answer", approveId, "--continue"],
      h.io,
    ),
    0,
  );
  assert.match(h.stdout(), /^State: succeeded$/m);
  h.reset();

  const rejectId = await launchGate(h, {
    id: "dev.secant.gate-cli-reject",
    shape: "approve-reject",
  });
  assert.equal(
    await runHeadless(h.clients, ["run", "answer", rejectId, "--stop"], h.io),
    1,
  );
  assert.match(h.stdout(), /^State: failed$/m);
});

test("run show and --json carry the authored pending gate; blocked reads durable Human Gate (#108, AC4)", async (t) => {
  const h = await harness(t);
  const runId = await launchGate(h, {
    shape: "free-text",
    message: "name the release",
    outputName: "answer",
  });

  assert.equal(await runHeadless(h.clients, ["run", "show", runId], h.io), 0);
  const out = h.stdout();
  assert.match(out, /^State: blocked$/m);
  assert.match(out, /durable Human Gate/);
  assert.match(out, /shape: free-text/);
  assert.match(out, /message: name the release/);
  assert.match(out, /output: answer/);
  assert.match(out, /Answer the gate:/);
  assert.match(out, /run answer .*--text/);
  h.reset();

  assert.equal(
    await runHeadless(h.clients, ["run", "show", runId, "--json"], h.io),
    0,
  );
  const snapshot = JSON.parse(h.stdout()) as {
    result: {
      found: boolean;
      run: {
        state: string;
        pendingGate?: {
          message: string;
          outputArtifactName?: string;
          gate: { shape: string; stepId: string; attemptId: string };
        };
      };
    };
  };
  assert.ok(snapshot.result.found);
  // Frozen existing field unchanged; new pending-gate fields are additive.
  assert.equal(snapshot.result.run.state, "blocked");
  assert.equal(snapshot.result.run.pendingGate?.gate.shape, "free-text");
  assert.equal(snapshot.result.run.pendingGate?.message, "name the release");
  assert.equal(snapshot.result.run.pendingGate?.outputArtifactName, "answer");
  assert.match(snapshot.result.run.pendingGate?.gate.attemptId ?? "", /\S/);
});

test("answer-shape mismatches are refused and change nothing (#108, AC3)", async (t) => {
  const h = await harness(t);
  // --text to an approve-reject gate is refused; the Run stays blocked.
  const approveId = await launchGate(h, {
    id: "dev.secant.gate-cli-mismatch-a",
    shape: "approve-reject",
  });
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "answer", approveId, "--text", "nope"],
      h.io,
    ),
    1,
  );
  assert.match(h.stderr(), /gate-shape-mismatch/);
  h.reset();
  await runHeadless(h.clients, ["run", "show", approveId], h.io);
  assert.match(h.stdout(), /^State: blocked$/m);
  h.reset();

  // --continue to a free-text gate is refused; the Run stays blocked.
  const freeTextId = await launchGate(h, {
    id: "dev.secant.gate-cli-mismatch-f",
    shape: "free-text",
  });
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "answer", freeTextId, "--continue"],
      h.io,
    ),
    1,
  );
  assert.match(h.stderr(), /gate-shape-mismatch/);
});

test("run answer needs exactly one of --continue, --stop, or --text (#108)", async (t) => {
  const h = await harness(t);
  const runId = await launchGate(h, {
    id: "dev.secant.gate-cli-invalid",
    shape: "free-text",
  });
  // Two answer forms at once is refused before any submission.
  assert.equal(
    await runHeadless(
      h.clients,
      ["run", "answer", runId, "--continue", "--text", "x"],
      h.io,
    ),
    1,
  );
  assert.match(h.stderr(), /invalid-answer/);
});
