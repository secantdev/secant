#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import {
  createProcessAdapter,
  type OwnedProcessOptions,
  type SpawnOptions,
  type OwnedProcess,
  type ProcessAdapter,
} from "../../src/process/process.js";
import type {
  AnswerHarnessRequestOffer,
  RunView,
} from "../../src/application/projection-port.js";
import { createClaudeCodeAdapter } from "../../src/harness/harness.js";
import { wireApplication } from "../../src/composition/main.js";
import {
  executeRouting,
  RunCancelledError,
} from "../../src/run/execution/execution.js";
import {
  isolatedGitEnvironment,
  openRunGroup,
} from "../../src/run/store/store.js";
import { openArtifactRepo } from "../../src/run/store/artifacts/artifacts.js";
import {
  registerProcessConformanceCases,
  type ProcessConformanceBody,
  type ProcessConformanceScenarios,
} from "./conformance.js";
import { createFakeProcess } from "./fake-adapter.js";
import { createFakeGitProcess } from "../run/store/fake-git-process.js";
import {
  registerClaudeCodeReplayerConformance,
  registerCodexReplayerConformance,
} from "../harness/replayer-conformance.js";
import { registerClaudeCodeAdapterConformance } from "../harness/claude-code-adapter-conformance.js";
import { registerCodexAdapterConformance } from "../harness/codex-adapter-conformance.js";
import { writeCommandBundle } from "../helpers/commandBundle.js";
import { awaitSettled } from "../helpers/settleOperation.js";
import { checkEntryDeclarations } from "../architecture/check-vendor-provenance.js";
import { installReplayer } from "../harness/replayer.js";
import { runMain, withTimeout } from "../helpers/standalone.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const executable = process.execPath;
const missing = join(tmpdir(), `secant-process-parity-missing-${process.pid}`);
const SCENARIO_TIMEOUT_MS = 20_000;
const CONCURRENT_CREATE_WORKER = fileURLToPath(
  new URL("../run/store/concurrent-create-worker.ts", import.meta.url),
);
const LOCKED_COORDINATION_WORKER = fileURLToPath(
  new URL("../run/store/locked-coordination-worker.ts", import.meta.url),
);

// The maintained Matt-front Bundle recorded-replayer traversal (#185, from
// tests/tui/matt-front-workbench.test.tsx): the replayer echoes whichever Session
// id the Adapter mints, so the recording's own id gives a verbatim transcript.
const MATT_FRONT_SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MATT_FRONT_REPLAYER_VERSION = "2.1.274 (Claude Code)";

function commandOptions(
  source: string,
  overrides: Partial<SpawnOptions> = {},
): SpawnOptions {
  return {
    executable,
    args: ["-e", source],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5_000,
    maxCaptureBytes: 1_024 * 1_024,
    truncationMarker: "\n[truncated]\n",
    ...overrides,
  };
}

function ownedOptions(source: string): OwnedProcessOptions {
  return {
    executable,
    args: ["-e", source],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5_000,
  };
}

function delayedForcedCloseSource(delayAfterSignalMs: number): string {
  const holder =
    "process.on('message',()=>setTimeout(()=>process.exit(0)," +
    `${delayAfterSignalMs}));process.send?.('ready');setInterval(()=>{},1000)`;
  return (
    "const{spawn}=require('node:child_process');" +
    `const holder=spawn(process.execPath,['-e',${JSON.stringify(holder)}],` +
    "{detached:true,stdio:['ignore','inherit','inherit','ipc']});" +
    "holder.on('message',()=>process.stdout.write('ready\\n'));" +
    "process.on('SIGTERM',()=>holder.send('release'));" +
    "setInterval(()=>{},1000)"
  );
}

const scenarios: ProcessConformanceScenarios = {
  label: "real",
  resolution: () => ({
    process: createProcessAdapter(),
    foundName: executable,
    foundExecutable: executable,
    missingName: missing,
  }),
  commandExit: () => ({
    process: createProcessAdapter(),
    options: commandOptions(
      "process.stdout.write('out');process.stderr.write('err');process.exit(17)",
    ),
    status: 17,
    text: "outerr",
  }),
  commandCancellation: () => {
    const controller = new AbortController();
    return {
      process: createProcessAdapter(),
      options: commandOptions("setInterval(()=>{},1000)", {
        cancelSignal: controller.signal,
      }),
      cancel: () => controller.abort(),
    };
  },
  ownedExit: () => ({
    process: createProcessAdapter(),
    options: ownedOptions(
      "process.stdout.write('out-');process.stdout.write('one');" +
        "process.stderr.write('err-');process.stderr.write('two');process.exit(23)",
    ),
    stdout: "out-one",
    stderr: "err-two",
    status: 23,
  }),
  ownedSignal: () => ({
    process: createProcessAdapter(),
    options: ownedOptions("process.kill(process.pid,'SIGTERM')"),
    terminalKind: process.platform === "win32" ? "exited" : "signal",
  }),
  gracefulInterruption: () => {
    const gracefulMs = 2_000;
    return {
      process: createProcessAdapter(),
      options: ownedOptions(
        // Exit after half the supplied bound. A shutdown that split gracefulMs
        // between stages would force-kill this process instead of observing its
        // graceful exit, turning the escalation assertion red.
        "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),1500));" +
          "process.stdout.write('ready\\n');setInterval(()=>{},1000)",
      ),
      ready: "ready",
      gracefulMs,
      escalated: process.platform === "win32",
    };
  },
  forcedBoundInterruption: () => {
    const gracefulMs = 2_000;
    const source =
      process.platform === "win32"
        ? "process.on('SIGTERM',()=>{});" +
          "process.stdout.write('ready\\n');setInterval(()=>{},1000)"
        : delayedForcedCloseSource(gracefulMs + 1_500);
    return {
      process: createProcessAdapter(),
      options: ownedOptions(source),
      ready: "ready",
      gracefulMs,
      escalated: true,
    };
  },
  escalatingInterruption: () => ({
    process: createProcessAdapter(),
    options: ownedOptions(
      "process.on('SIGTERM',()=>{});" +
        "process.stdout.write('ready\\n');setInterval(()=>{},1000)",
    ),
    ready: "ready",
    gracefulMs: 100,
    escalated: true,
  }),
  treeCleanup: () => ({
    process: createProcessAdapter(),
    options: commandOptions(
      "const{spawn}=require('node:child_process');" +
        "spawn(process.execPath,['-e','setInterval(()=>{},1000)']," +
        "{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)",
      { timeoutMs: 200 },
    ),
  }),
  failures: () => ({
    process: createProcessAdapter(),
    missingName: missing,
    command: {
      ...commandOptions(""),
      executable: missing,
      args: [],
    },
    owned: {
      ...ownedOptions(""),
      executable: missing,
      args: [],
    },
  }),
};

interface RegisteredCase {
  readonly name: string;
  readonly body: ProcessConformanceBody;
}

const cases: RegisteredCase[] = [];
registerProcessConformanceCases(scenarios, (name, body) => {
  cases.push({ name, body });
});
cases.push(
  { name: "execution-real-command", body: executionRealCommand },
  { name: "process-sync-command", body: processSyncCommand },
  { name: "execution-real-nonzero", body: executionRealNonzero },
  { name: "execution-real-cancellation", body: executionRealCancellation },
  { name: "execution-real-group-reaping", body: executionRealGroupReaping },
  { name: "preflight-git-worktree", body: preflightGitWorktree },
  { name: "artifact-git-repository", body: artifactGitRepository },
  { name: "store-owner-death-recovery", body: storeOwnerDeathRecovery },
  { name: "store-concurrent-writer", body: storeConcurrentWriter },
  { name: "store-locked-coordination", body: storeLockedCoordination },
  { name: "process-worker-environment", body: processWorkerEnvironment },
  {
    name: "execution-store-on-fake-process",
    body: executionStoreOnFakeProcess,
  },
  { name: "application-on-doubles", body: applicationOnDoubles },
  {
    name: "matt-front-replayer-workbench",
    body: mattFrontReplayerWorkbench,
  },
  { name: "migration-generator-drift", body: migrationGeneratorDrift },
  { name: "entry-declaration-surface", body: entryDeclarationSurface },
);

// The shared Harness conformance suite over the REAL replayers. Under the test
// runner it runs against the fake (tests/harness/conformance.test.ts); here it
// runs against both recorded-Harness replayers, each behaviour its own bounded
// runtime case, so the semantic suite never spawns while the replayers stay
// covered (#184, M5).
registerClaudeCodeReplayerConformance((name, body) =>
  cases.push({ name, body }),
);
registerCodexReplayerConformance((name, body) => cases.push({ name, body }));

// The Adapter-specific cases relocated from the process-free semantic suite
// (#198): the Claude Code and Codex Harness suites no longer spawn under the test
// runner, so their redaction, frame-parsing, discovery, argv, control, and
// qualification cases run here as bounded runtime cases.
registerClaudeCodeAdapterConformance((name, body) =>
  cases.push({ name, body }),
);
registerCodexAdapterConformance((name, body) => cases.push({ name, body }));

async function applicationOnDoubles(): Promise<void> {
  const git = createFakeGitProcess();
  const commands = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commandHandler: () => ({
      kind: "exited",
      status: 0,
      text: new TextEncoder().encode("ran\n"),
    }),
  });
  const processAdapter: ProcessAdapter = {
    resolveExecutable: (name, options) =>
      commands.resolveExecutable(name, options),
    spawnCommand: (options) => commands.spawnCommand(options),
    spawnOwnedProcess: (options) => commands.spawnOwnedProcess(options),
    spawnCommandSync: (options) => git.spawnCommandSync(options),
  };
  const workspace = runtimeTemp("secant-runtime-app-ws-");
  const wired = wireApplication({
    secantHome: runtimeTemp("secant-runtime-app-home-"),
    launchCwd: workspace,
    process: processAdapter,
  });
  try {
    const bundle = writeCommandBundle();
    const built = wired.bundleManagement.build(bundle.folder, {
      noInstall: false,
    });
    assert.ok(built.ok);
    const entry = wired.catalog
      .listEntries()
      .find((candidate) => candidate.id === bundle.id);
    assert.ok(entry);
    const approval = wired.projectionPort.submit({
      operationId: "app-doubles-approve",
      operation: "approve-workspace",
      input: { path: workspace },
    });
    assert.equal(approval.admitted, true);
    const admission = wired.projectionPort.submit({
      operationId: "app-doubles-launch",
      operation: "launch-run",
      input: {
        bundle: { id: bundle.id },
        launchInputs: {},
        trustDigest: entry.digest,
      },
    });
    assert.equal(admission.admitted, true);
    if (!admission.admitted) throw new Error("launch was not admitted");
    const outcome = await awaitSettled(
      wired.projectionPort,
      "app-doubles-launch",
    );
    assert.equal(outcome.status, "applied");
    const read = wired.runGroup.readRun(admission.runId!);
    assert.ok(read.ok);
    if (read.ok) assert.equal(read.run.state, "succeeded");
  } finally {
    wired.runGroup.close();
    wired.catalog.close();
  }
}

// The maintained Matt-front Bundle driven entirely through the real ProjectionPort
// against the recorded Claude Code replayer (#185; ported from the recorded-replayer
// substance of tests/tui/matt-front-workbench.test.tsx). This runner is a plain `bun`
// process with no Solid/OpenTUI JSX transform, so the flow is driven over the Port,
// not the TUI: the launch seam's `launch-run` replaces the bundle/trust/harness/review
// keypresses, and an `answer-harness-request` over the live overlay replaces the
// [Allow] keypress. The TUI-rendering coverage stays in live-run-workbench.test.tsx;
// this case's job is the recorded-replayer traversal. Nothing is faked in place of a
// spawn: the real Adapter discovers and spawns the PATH-installed replayer, which
// replays the recorded grill and spec Turns. Two human grill Turns are sent, the Step
// is ended, the approve-reject gate is answered, and the spec Turn's file-write
// approval is allowed; the Run reaches `succeeded` with the spec written.
async function mattFrontReplayerWorkbench(): Promise<void> {
  const replayer = installReplayer(
    MATT_FRONT_REPLAYER_VERSION,
    join(repoRoot, "tests", "harness", "fixtures", "claude-code", "matt-front"),
  );
  const workspace = runtimeTemp("secant-runtime-matt-front-ws-");
  const wired = wireApplication({
    secantHome: runtimeTemp("secant-runtime-matt-front-home-"),
    launchCwd: workspace,
    supportsInteractiveTurns: true,
    discoverClaudeCode: () => ({
      kind: "found",
      attempt: {
        source: "configured",
        name: replayer.executablePath,
        description: "injected Matt-front replayer",
      },
    }),
    harnessAdapter: createClaudeCodeAdapter({
      path: replayer.path,
      env: {},
      sessionId: () => MATT_FRONT_SESSION_ID,
    }),
  });
  try {
    const built = wired.bundleManagement.build(
      join(repoRoot, "bundles", "matt-front-spec"),
      { noInstall: false },
    );
    assert.ok(built.ok, JSON.stringify(built));
    const entry = wired.catalog
      .listEntries()
      .find((item) => item.id === "dev.secant.matt-front");
    assert.ok(entry);
    assert.ok(
      wired.projectionPort.submit({
        operationId: "matt-front-approve-ws",
        operation: "approve-workspace",
        input: { path: workspace },
      }).admitted,
    );

    // The launch seam builds this exact LaunchRunInput — the acknowledged installed
    // digest, the interactive Harness selection, no launch inputs. The launch rests
    // the Run `blocked` at the interactive grill Step and only then clears its
    // execution claim, so awaiting this Operation is the correct gate before a human
    // Turn is sent (a Turn before it settles is refused `interactive-turn-busy`).
    const LAUNCH_OP = "matt-front-launch";
    const admission = wired.projectionPort.submit({
      operationId: LAUNCH_OP,
      operation: "launch-run",
      input: {
        bundle: { id: entry.id },
        launchInputs: {},
        trustDigest: entry.digest,
        harness: "claude-code",
      },
    });
    assert.equal(admission.admitted, true);
    if (!admission.admitted || admission.runId === undefined)
      throw new Error("the Matt-front launch was not admitted");
    const runId = admission.runId;
    assert.equal(
      (await awaitSettled(wired.projectionPort, LAUNCH_OP)).status,
      "applied",
    );

    // A projection's `snapshot` is fixed at open, so reopen per read to observe the
    // Turns as they land.
    const readRun = (): RunView => {
      const projection = wired.projectionPort.openProjection({
        family: "run",
        runId,
      });
      try {
        const result = projection.snapshot.result;
        assert.ok(result.found, JSON.stringify(result));
        if (!result.found) throw new Error("unreachable");
        return result.run;
      } finally {
        projection.close();
      }
    };

    // Each human grill Turn over the real Port; the launch (and each prior send)
    // settles the Run back to the Turn boundary first, so each send is admitted there.
    let grillTurn = 0;
    const sendGrillTurn = async (text: string): Promise<void> => {
      const operationId = `matt-front-grill-${++grillTurn}`;
      assert.ok(
        wired.projectionPort.submit({
          operationId,
          operation: "send-interactive-turn",
          input: { runId, stepId: "grill", text },
        }).admitted,
      );
      const outcome = await awaitSettled(wired.projectionPort, operationId);
      assert.equal(outcome.status, "applied", JSON.stringify(outcome));
    };

    await sendGrillTurn("Interview me about a feature.");
    await sendGrillTurn("That is enough context.");

    const afterGrill = readRun();
    assert.equal(afterGrill.state, "blocked");
    const transcriptReference = afterGrill.sessions?.[0]?.transcriptPage;
    assert.ok(transcriptReference);
    const transcript = wired.projectionPort.readTranscript(transcriptReference);
    assert.ok(transcript.found);
    if (!transcript.found) throw new Error("unreachable");
    const humanTurns = transcript.entries
      .filter((entry) => entry.role === "user")
      .map((entry) => entry.content);
    assert.deepEqual(humanTurns, [
      "Interview me about a feature.",
      "That is enough context.",
    ]);
    const assistantText = transcript.entries
      .filter((entry) => entry.role === "assistant")
      .map((entry) => entry.content)
      .join("\n");
    // The recorded grill: a question on the first Turn, a confirmation on the second.
    assert.match(assistantText, /persist per-device|sync across/);
    assert.match(assistantText, /enough to design|Ready when you are/);
    // A detached Session that recorded human Turns still advertises its transcript
    // page/export References alongside its availability (#124).
    assert.deepEqual(afterGrill.sessions, [
      {
        session: "spec",
        availability: "detached",
        transcriptPage: { runId, session: "spec", type: "transcript-page" },
        transcriptExport: {
          runId,
          session: "spec",
          type: "transcript-export",
        },
      },
    ]);

    // End the interactive Step at a Turn boundary; the Run advances to the authored
    // approve-reject gate and rests `blocked` at it.
    assert.ok(
      wired.projectionPort.submit({
        operationId: "matt-front-end-grill",
        operation: "end-interactive-step",
        input: { runId, stepId: "grill" },
      }).admitted,
    );
    assert.equal(
      (await awaitSettled(wired.projectionPort, "matt-front-end-grill")).status,
      "applied",
    );
    const atGate = readRun();
    assert.equal(atGate.pendingGate?.gate.shape, "approve-reject");
    assert.equal(atGate.pendingGate?.gate.stepId, "approve-spec");

    // Approve the gate; the spec Agent Step resumes the Session and raises a
    // file-write approval on the live overlay, then blocks awaiting it. Watch the
    // overlay for the outstanding request (the .tsx test watches the same overlay
    // rather than a rendered frame) and answer it `allow` over the Port — the exact
    // answer-harness-request the Workbench's [Allow] control submits (#121).
    const gate = atGate.pendingGate!.gate;
    const overlayWatch = wired.projectionPort.openProjection({
      family: "run",
      runId,
    });
    wired.projectionPort.submit({
      operationId: "matt-front-answer-gate",
      operation: "answer-human-gate",
      input: { runId, gate, answer: "continue" },
    });
    let offer: AnswerHarnessRequestOffer | undefined;
    for await (const update of overlayWatch.updates) {
      if (update.kind === "live" && update.overlay.offers.length > 0) {
        offer = update.overlay.offers[0];
        break;
      }
    }
    overlayWatch.close();
    assert.ok(offer, "the spec Turn raised no approval request");
    assert.ok(
      wired.projectionPort.submit({
        operationId: "matt-front-allow-request",
        operation: "answer-harness-request",
        input: {
          runId,
          requestId: offer.requestId,
          generation: offer.generation,
          decision: "allow",
          by: "client-policy",
        },
      }).admitted,
    );

    // The spec Turn completes, applies the recorded Workspace patch, and the Run
    // reaches `succeeded`; the answer-gate drive settles once the Run rests.
    assert.equal(
      (await awaitSettled(wired.projectionPort, "matt-front-answer-gate"))
        .status,
      "applied",
    );

    const done = readRun();
    assert.equal(done.state, "succeeded");
    assert.deepEqual(
      done.progress.map((step) => step.status),
      ["succeeded", "succeeded", "succeeded"],
    );
    const specFile = join(workspace, "specs", "spec.md");
    assert.ok(existsSync(specFile), "the spec Turn wrote specs/spec.md");
    assert.match(readFileSync(specFile, "utf8"), /Dark Mode Toggle/);
  } finally {
    wired.runGroup.close();
    wired.catalog.close();
  }
}

async function processWorkerEnvironment(): Promise<void> {
  const processAdapter = createProcessAdapter();
  const probe =
    "console.log(JSON.stringify({bun:process.env.BUN_TEST_WORKER_ID," +
    "jest:process.env.JEST_WORKER_ID,visible:process.env.SECANT_VISIBLE}))";
  const environment = {
    ...process.env,
    BUN_TEST_WORKER_ID: "1",
    JEST_WORKER_ID: "1",
    SECANT_VISIBLE: "yes",
  };
  const command = await processAdapter.spawnCommand({
    ...commandOptions(probe),
    env: environment,
  });
  assert.equal(command.kind, "exited");
  if (command.kind !== "exited") throw new Error("worker probe did not exit");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(command.text)), {
    visible: "yes",
  });

  const launched = await processAdapter.spawnOwnedProcess({
    ...ownedOptions(probe),
    env: environment,
  });
  assert.equal(launched.ok, true);
  if (!launched.ok) throw new Error("owned worker probe did not launch");
  const [output, close] = await Promise.all([
    collectText(launched.process.stdout),
    launched.process.closed(),
  ]);
  assert.deepEqual(JSON.parse(output), { visible: "yes" });
  assert.deepEqual(close, { kind: "exited", status: 0 });
}

function processSyncCommand(): void {
  const processAdapter = createProcessAdapter();
  const exited = processAdapter.spawnCommandSync({
    executable,
    args: [
      "-e",
      "process.stdout.write('out');process.stderr.write('err');process.exit(17)",
    ],
    env: process.env,
    maxBufferBytes: 1024 * 1024,
  });
  assert.equal(exited.kind, "exited");
  if (exited.kind !== "exited") throw new Error("sync child did not exit");
  assert.equal(exited.status, 17);
  assert.equal(new TextDecoder().decode(exited.stdout), "out");
  assert.equal(new TextDecoder().decode(exited.stderr), "err");

  const missing = processAdapter.spawnCommandSync({
    executable: join(runtimeTemp("secant-runtime-sync-missing-"), "missing"),
    args: [],
    env: process.env,
    maxBufferBytes: 1024,
  });
  assert.equal(missing.kind, "spawn-error");

  // Windows has no POSIX signal terminal observation; its documented Process
  // contract reports an exit. The POSIX matrix jobs cover the `signal` branch.
  const signalled = processAdapter.spawnCommandSync({
    executable,
    args: ["-e", "process.kill(process.pid,'SIGTERM')"],
    env: process.env,
    maxBufferBytes: 1024,
  });
  assert.equal(
    signalled.kind,
    process.platform === "win32" ? "exited" : "signal",
  );
}

async function executionStoreOnFakeProcess(): Promise<void> {
  const git = createFakeGitProcess();
  const commands = createFakeProcess({
    resolutionHandler: (name) => ({
      kind: "found",
      executable: name,
      prefixArgs: [],
    }),
    commandHandler: () => ({
      kind: "exited",
      status: 0,
      text: new TextEncoder().encode("fake-output"),
    }),
  });
  const processAdapter: ProcessAdapter = {
    resolveExecutable: (name, options) =>
      commands.resolveExecutable(name, options),
    spawnCommand: (options) => commands.spawnCommand(options),
    spawnOwnedProcess: (options) => commands.spawnOwnedProcess(options),
    spawnCommandSync: (options) => git.spawnCommandSync(options),
  };
  const group = openRunGroup(
    runtimeTemp("secant-runtime-fake-home-"),
    runtimeTemp("secant-runtime-fake-workspace-"),
    { process: processAdapter },
  );
  try {
    const created = group.createRun({
      operationId: "runtime-fake",
      bundleSnapshotDigest: "sha256:runtime-fake",
      launch: {},
      at: new Date("2026-09-21T00:00:00.000Z"),
    });
    const owner = group.acquireRun(created.runId);
    assert.ok(owner);
    try {
      const report = await executeRouting(
        [
          {
            id: "fake-command",
            kind: "command",
            command: { executable: "fake", arguments: [] },
            produces: [{ name: "output", type: "text" }],
          },
        ],
        {
          owner,
          platform: runtimePlatform(),
          resolveAsset: () => undefined,
          process: processAdapter,
        },
      );
      assert.deepEqual(report, { outcome: "succeeded" });
      assert.equal(readBound(owner, "output"), "fake-output");
    } finally {
      owner.close();
    }
  } finally {
    group.close();
  }
}

function runtimeExecutionFixture(prefix: string) {
  const processAdapter = createProcessAdapter();
  const workspace = runtimeTemp(`${prefix}-workspace-`);
  const group = openRunGroup(runtimeTemp(`${prefix}-home-`), workspace, {
    process: processAdapter,
  });
  const created = group.createRun({
    operationId: prefix,
    bundleSnapshotDigest: "sha256:runtime",
    launch: {},
    at: new Date("2026-09-21T00:00:00.000Z"),
  });
  const owner = group.acquireRun(created.runId);
  assert.ok(owner);
  return { processAdapter, workspace, group, owner };
}

async function executionRealNonzero(): Promise<void> {
  const fixture = runtimeExecutionFixture("runtime-nonzero");
  try {
    const report = await executeRouting(
      [
        {
          id: "nonzero",
          kind: "command",
          command: {
            executable,
            arguments: ["-e", "process.stdout.write('no');process.exit(17)"],
          },
          produces: [
            { name: "verdict", type: "verdict" },
            { name: "output", type: "text" },
          ],
        },
      ],
      {
        owner: fixture.owner,
        platform: runtimePlatform(),
        resolveAsset: () => undefined,
        process: fixture.processAdapter,
      },
    );
    assert.deepEqual(report, { outcome: "succeeded" });
    assert.equal(readBound(fixture.owner, "verdict"), "fail");
    assert.equal(readBound(fixture.owner, "output"), "no");
  } finally {
    fixture.owner.close();
    fixture.group.close();
  }
}

async function executionRealCancellation(): Promise<void> {
  const fixture = runtimeExecutionFixture("runtime-cancel");
  const controller = new AbortController();
  try {
    const execution = executeRouting(
      [
        {
          id: "cancel",
          kind: "command",
          command: {
            executable,
            arguments: ["-e", "setInterval(()=>{},1000)"],
          },
        },
      ],
      {
        owner: fixture.owner,
        platform: runtimePlatform(),
        resolveAsset: () => undefined,
        process: fixture.processAdapter,
        cancelSignal: controller.signal,
      },
    );
    controller.abort();
    await assert.rejects(execution, RunCancelledError);
    assert.deepEqual(fixture.owner.attemptLog(), []);
  } finally {
    fixture.owner.close();
    fixture.group.close();
  }
}

async function executionRealGroupReaping(): Promise<void> {
  const fixture = runtimeExecutionFixture("runtime-reaping");
  const source =
    "const{spawn}=require('node:child_process');" +
    "spawn(process.execPath,['-e','setInterval(()=>{},1000)']," +
    "{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)";
  try {
    const report = await executeRouting(
      [
        {
          id: "reap",
          kind: "command",
          retry: 0,
          command: { executable, arguments: ["-e", source] },
        },
      ],
      {
        owner: fixture.owner,
        platform: runtimePlatform(),
        resolveAsset: () => undefined,
        process: fixture.processAdapter,
        commandTimeoutMs: 200,
      },
    );
    assert.deepEqual(report, { outcome: "failed" });
    assert.deepEqual(
      fixture.owner.attemptLog().map((attempt) => attempt.outcome),
      ["failed"],
    );
  } finally {
    fixture.owner.close();
    fixture.group.close();
  }
}

function runtimePlatform(): "windows" | "macos" | "linux" {
  return process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "macos"
      : "linux";
}

function readBound(
  owner: ReturnType<typeof runtimeExecutionFixture>["owner"],
  name: string,
): string | undefined {
  const version = owner.currentVersion(name);
  const bytes =
    version === undefined ? undefined : owner.readArtifact(version, name);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

async function executionRealCommand(): Promise<void> {
  const processAdapter = createProcessAdapter();
  const home = runtimeTemp("secant-runtime-execution-home-");
  const workspace = classicWorktree(processAdapter);
  writeFileSync(join(workspace, "seed.txt"), "changed\n");
  const group = openRunGroup(home, workspace, { process: processAdapter });
  try {
    const created = group.createRun({
      operationId: "runtime-execution",
      bundleSnapshotDigest: "sha256:runtime",
      launch: {},
      at: new Date("2026-09-21T00:00:00.000Z"),
    });
    const owner = group.acquireRun(created.runId);
    assert.ok(owner);
    try {
      const report = await executeRouting(
        [
          {
            id: "real-command",
            kind: "command",
            command: {
              executable: executable,
              arguments: ["-e", "process.stdout.write('runtime-ok')"],
            },
            produces: [{ name: "output", type: "text" }],
          },
          {
            id: "real-git-command",
            kind: "command",
            command: {
              executable: "git",
              arguments: [
                "commit",
                "--all",
                "--message",
                "Runtime unattended commit",
              ],
              workingDirectory: ".",
              env: {
                GIT_AUTHOR_NAME: "Secant",
                GIT_AUTHOR_EMAIL: "secant@localhost",
                GIT_COMMITTER_NAME: "Secant",
                GIT_COMMITTER_EMAIL: "secant@localhost",
              },
            },
            produces: [
              { name: "commit-verdict", type: "verdict" },
              { name: "commit-output", type: "text" },
            ],
          },
        ],
        {
          owner,
          platform:
            process.platform === "win32"
              ? "windows"
              : process.platform === "darwin"
                ? "macos"
                : "linux",
          resolveAsset: () => undefined,
          process: processAdapter,
        },
      );
      assert.deepEqual(report, { outcome: "succeeded" });
      const version = owner.currentVersion("output");
      assert.ok(version);
      assert.equal(
        new TextDecoder().decode(owner.readArtifact(version, "output")),
        "runtime-ok",
      );
      assert.equal(
        readBound(owner, "commit-verdict"),
        "pass",
        readBound(owner, "commit-output"),
      );
      assert.equal(
        readGit(processAdapter, workspace, ["log", "-1", "--format=%s"]),
        "Runtime unattended commit",
      );
    } finally {
      owner.close();
    }
  } finally {
    group.close();
  }
}

function preflightGitWorktree(): void {
  const processAdapter = createProcessAdapter();
  const cases = [
    {
      workspace: classicWorktree(processAdapter),
      expected: "bundle-trust-required",
    },
    {
      workspace: linkedWorktree(processAdapter),
      expected: "bundle-trust-required",
    },
    {
      workspace: unbornWorktree(processAdapter),
      expected: "bundle-trust-required",
    },
    {
      workspace: bareRepo(processAdapter),
      expected: "workspace-prerequisite-failed",
    },
    {
      workspace: runtimeTemp("secant-runtime-plain-"),
      expected: "workspace-prerequisite-failed",
    },
  ];
  const nestedRoot = classicWorktree(processAdapter);
  const nested = join(nestedRoot, "nested");
  mkdirSync(nested);
  writeFileSync(join(nested, ".keep"), "");
  cases.push({ workspace: nested, expected: "workspace-prerequisite-failed" });

  for (const scenario of cases) {
    const wired = wireApplication({
      secantHome: runtimeTemp("secant-runtime-preflight-home-"),
      launchCwd: scenario.workspace,
      process: processAdapter,
    });
    try {
      const bundle = writeGitProbeBundle();
      const built = wired.bundleManagement.build(bundle.folder, {
        noInstall: false,
      });
      assert.ok(built.ok);
      const approval = wired.projectionPort.submit({
        operationId: `approve-${cases.indexOf(scenario)}`,
        operation: "approve-workspace",
        input: { path: scenario.workspace },
      });
      assert.equal(approval.admitted, true);
      const admission = wired.projectionPort.submit({
        operationId: `preflight-${cases.indexOf(scenario)}`,
        operation: "launch-run",
        input: { bundle: { id: bundle.id }, launchInputs: {} },
      });
      assert.equal(admission.admitted, false);
      if (admission.admitted) throw new Error("unexpected preflight admission");
      assert.equal(admission.problem.code, scenario.expected);
    } finally {
      wired.runGroup.close();
      wired.catalog.close();
    }
  }
}

function artifactGitRepository(): void {
  const repo = openArtifactRepo(
    runtimeTemp("secant-runtime-artifact-"),
    createProcessAdapter(),
  );
  const staged = repo.stageCommit(
    "runtime-attempt",
    [{ name: "result", type: "text" }],
    [
      {
        name: "result",
        type: "text",
        content: new TextEncoder().encode("real-git"),
      },
    ],
    new Date("2026-09-21T00:00:00.000Z"),
  );
  assert.ok(staged.ok);
  assert.equal(
    new TextDecoder().decode(repo.read(staged.versionId, "result")),
    "real-git",
  );
}

function runtimeTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeGitProbeBundle(): {
  readonly folder: string;
  readonly id: string;
} {
  const folder = runtimeTemp("secant-runtime-git-bundle-");
  const id = "dev.secant.runtime-git-probe";
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      bundle: {
        id,
        version: "1.0.0",
        name: "Runtime Git Probe",
        description: "Exercises the real Preflight Git probe.",
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [],
      routing: [
        {
          id: "probe",
          kind: "command",
          prerequisites: ["git-worktree-root"],
          command: {
            executable: basename(process.execPath),
            arguments: ["-e", "process.exit(0)"],
          },
        },
      ],
    }),
  );
  return { folder, id };
}

function unbornWorktree(processAdapter: ProcessAdapter): string {
  const directory = runtimeTemp("secant-runtime-unborn-");
  runGit(processAdapter, directory, ["init", "--quiet"]);
  return directory;
}

function classicWorktree(processAdapter: ProcessAdapter): string {
  const directory = unbornWorktree(processAdapter);
  writeFileSync(join(directory, "seed.txt"), "seed\n");
  runGit(processAdapter, directory, ["add", "seed.txt"]);
  runGit(processAdapter, directory, [
    "-c",
    "user.name=Secant",
    "-c",
    "user.email=secant@localhost",
    "commit",
    "--quiet",
    "--message",
    "seed",
  ]);
  return directory;
}

function linkedWorktree(processAdapter: ProcessAdapter): string {
  const root = classicWorktree(processAdapter);
  const linked = runtimeTemp("secant-runtime-linked-");
  runGit(processAdapter, root, [
    "worktree",
    "add",
    "--quiet",
    "-b",
    `runtime-linked-${process.pid}`,
    linked,
  ]);
  return linked;
}

function bareRepo(processAdapter: ProcessAdapter): string {
  const directory = runtimeTemp("secant-runtime-bare-");
  runGit(processAdapter, directory, ["init", "--bare", "--quiet"]);
  return directory;
}

function runGit(
  processAdapter: ProcessAdapter,
  cwd: string,
  args: readonly string[],
): void {
  executeGit(processAdapter, cwd, args);
}

function readGit(
  processAdapter: ProcessAdapter,
  cwd: string,
  args: readonly string[],
): string {
  return new TextDecoder().decode(executeGit(processAdapter, cwd, args)).trim();
}

function executeGit(
  processAdapter: ProcessAdapter,
  cwd: string,
  args: readonly string[],
): Uint8Array {
  const result = processAdapter.spawnCommandSync({
    executable: "git",
    args,
    cwd,
    env: isolatedGitEnvironment({}, "inherited"),
    maxBufferBytes: 1024 * 1024,
  });
  assert.equal(result.kind, "exited");
  if (result.kind !== "exited") throw new Error("Git did not exit normally");
  assert.equal(result.status, 0, new TextDecoder().decode(result.stderr));
  return result.stdout;
}

async function storeOwnerDeathRecovery(): Promise<void> {
  const processAdapter = createProcessAdapter();
  const home = runtimeTemp("secant-runtime-owner-home-");
  const workspace = runtimeTemp("secant-runtime-owner-ws-");
  const child = await startStoreWriter({
    processAdapter,
    home,
    workspace,
    operationId: "owner-op",
    mode: "hold",
  });
  await child.waitFor("ready\n");
  await child.process.writeStdin(new TextEncoder().encode("create\n"));
  await child.waitFor("created\n");
  const interruption = await child.process.interrupt(5_000);
  assert.equal(
    interruption.close.kind === "exited" ||
      interruption.close.kind === "signal",
    true,
  );
  const group = openRunGroup(home, workspace, { process: processAdapter });
  try {
    const listing = group.listRuns();
    assert.equal(listing.length, 1);
    assert.equal(listing[0]?.live, false);
    const read = group.readRun(listing[0]!.runId);
    assert.ok(read.ok);
    assert.equal(read.run.state, "halted");
    assert.equal(group.resumeRun(listing[0]!.runId).outcome, "resumed");
    const owner = group.acquireRun(listing[0]!.runId);
    assert.ok(owner);
    try {
      const report = await executeRouting(
        [
          {
            id: "restart-child",
            kind: "command",
            command: {
              executable,
              arguments: ["-e", "process.stdout.write('restarted')"],
            },
            produces: [{ name: "restart-output", type: "text" }],
          },
        ],
        {
          owner,
          platform: runtimePlatform(),
          resolveAsset: () => undefined,
          process: processAdapter,
        },
      );
      assert.deepEqual(report, { outcome: "succeeded" });
      assert.equal(readBound(owner, "restart-output"), "restarted");
    } finally {
      owner.close();
    }
  } finally {
    group.close();
  }
}

async function storeConcurrentWriter(): Promise<void> {
  const processAdapter = createProcessAdapter();
  const home = runtimeTemp("secant-runtime-concurrent-home-");
  const workspace = runtimeTemp("secant-runtime-concurrent-ws-");
  const first = await startStoreWriter({
    processAdapter,
    home,
    workspace,
    operationId: "op-1",
    mode: "barrier",
  });
  const second = await startStoreWriter({
    processAdapter,
    home,
    workspace,
    operationId: "op-2",
    mode: "barrier",
  });
  await Promise.all([first.waitFor("ready\n"), second.waitFor("ready\n")]);
  await Promise.all([
    first.process.writeStdin(new TextEncoder().encode("create\n")),
    second.process.writeStdin(new TextEncoder().encode("create\n")),
  ]);
  await Promise.all([
    first.waitFor("creating\n"),
    second.waitFor("creating\n"),
  ]);
  await Promise.all([
    first.process.writeStdin(new TextEncoder().encode("continue\n")),
    second.process.writeStdin(new TextEncoder().encode("continue\n")),
  ]);
  await Promise.all([first.waitFor("created\n"), second.waitFor("created\n")]);
  await Promise.all([first.close(), second.close()]);
  const group = openRunGroup(home, workspace, { process: processAdapter });
  try {
    assert.equal(group.listRuns().length, 2);
  } finally {
    group.close();
  }
}

async function storeLockedCoordination(): Promise<void> {
  const processAdapter = createProcessAdapter();
  const home = runtimeTemp("secant-runtime-locked-home-");
  const workspace = runtimeTemp("secant-runtime-locked-workspace-");
  const group = openRunGroup(home, workspace, { process: processAdapter });
  const created = group.createRun({
    operationId: "locked-create",
    bundleSnapshotDigest: "sha256:locked",
    launch: {},
    at: new Date("2026-09-21T00:00:00.000Z"),
  });
  group.close();

  const runsDirectory = join(home, "runs");
  const groupName = readdirSync(runsDirectory)[0];
  assert.ok(groupName);
  const coordinationPath = join(runsDirectory, groupName, "coordination.db");
  const lock = new Database(coordinationPath);
  lock.exec("BEGIN EXCLUSIVE");
  try {
    const launched = await processAdapter.spawnOwnedProcess({
      executable,
      args: [LOCKED_COORDINATION_WORKER, home, workspace],
      cwd: process.cwd(),
      env: process.env,
      launchTimeoutMs: 5_000,
    });
    assert.equal(launched.ok, true);
    if (!launched.ok)
      throw new Error("locked coordination worker did not launch");
    const [output, close] = await Promise.all([
      collectText(launched.process.stdout),
      launched.process.closed(),
    ]);
    assert.deepEqual(close, { kind: "exited", status: 0 });
    assert.deepEqual(JSON.parse(output), {
      kind: "aggregate",
      errorCount: 2,
      causeIsLastError: true,
    });
    assert.equal(existsSync(coordinationPath), true);
  } finally {
    lock.exec("COMMIT");
    lock.close();
  }
  const reopened = openRunGroup(home, workspace, { process: processAdapter });
  try {
    assert.deepEqual(
      reopened.listRuns().map((run) => run.runId),
      [created.runId],
    );
  } finally {
    reopened.close();
  }
}

type TStartStoreWriterParams = {
  readonly processAdapter: ProcessAdapter;
  readonly home: string;
  readonly workspace: string;
  readonly operationId: string;
  readonly mode?: "exit" | "hold" | "barrier";
};

async function startStoreWriter(params: TStartStoreWriterParams): Promise<{
  readonly process: OwnedProcess;
  readonly waitFor: (expected: string) => Promise<void>;
  readonly close: () => Promise<void>;
}> {
  const mode = params.mode ?? "exit";
  const spawned = await params.processAdapter.spawnOwnedProcess({
    executable,
    args: [
      CONCURRENT_CREATE_WORKER,
      params.home,
      params.workspace,
      params.operationId,
      mode,
    ],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5_000,
  });
  assert.equal(spawned.ok, true);
  if (!spawned.ok) throw new Error("store writer did not launch");
  const output = observeOutput(spawned.process.stdout);
  const stderr = collectText(spawned.process.stderr);
  const waitFor = async (expected: string): Promise<void> => {
    try {
      await output.waitFor(expected);
    } catch (cause) {
      const [close, diagnostics] = await Promise.all([
        spawned.process.closed(),
        stderr,
      ]);
      throw new Error(
        `store writer missed ${JSON.stringify(expected)}; close=${JSON.stringify(close)}; stderr=${JSON.stringify(diagnostics)}`,
        { cause },
      );
    }
  };
  return {
    process: spawned.process,
    waitFor,
    async close() {
      const [close, diagnostics] = await Promise.all([
        spawned.process.closeStdin(5_000),
        stderr,
      ]);
      assert.deepEqual(
        close,
        { kind: "exited", status: 0 },
        diagnostics || "store writer did not exit successfully",
      );
    },
  };
}

function observeOutput(stream: AsyncIterable<Uint8Array>): {
  readonly waitFor: (expected: string) => Promise<void>;
} {
  let text = "";
  let closed = false;
  const waiters = new Set<{
    readonly expected: string;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }>();
  void (async () => {
    for await (const chunk of stream) {
      text += new TextDecoder().decode(chunk);
      for (const waiter of waiters) {
        if (!text.includes(waiter.expected)) continue;
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
    closed = true;
    for (const waiter of waiters) {
      waiter.reject(
        new Error(
          `child closed before emitting ${JSON.stringify(waiter.expected)}`,
        ),
      );
    }
    waiters.clear();
  })().catch((cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    for (const waiter of waiters) waiter.reject(error);
    waiters.clear();
  });
  return {
    waitFor(expected) {
      if (text.includes(expected)) return Promise.resolve();
      if (closed) {
        return Promise.reject(
          new Error(`child closed before emitting ${JSON.stringify(expected)}`),
        );
      }
      return new Promise((resolve, reject) => {
        waiters.add({ expected, resolve, reject });
      });
    },
  };
}

async function collectText(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

// The real migration generator rejects an ungenerated schema change and names the
// regeneration command (was tests/architecture/migrations.test.ts; #185). It spawns
// scripts/check-migrations.ts, which itself runs drizzle-kit as real children — so it
// belongs in the runtime runner, not the process-free semantic suite.
function migrationGeneratorDrift(): void {
  const temp = runtimeTemp("secant-migration-check-");
  const migrations = join(temp, "migrations");
  cpSync(join(repoRoot, "src", "drizzle", "catalog"), migrations, {
    recursive: true,
  });

  const sqliteCore = pathToFileURL(
    join(repoRoot, "node_modules", "drizzle-orm", "sqlite-core", "index.js"),
  ).href;
  const existingSchema = readFileSync(
    join(repoRoot, "src", "catalog", "schema.ts"),
    "utf8",
  ).replace('"drizzle-orm/sqlite-core"', JSON.stringify(sqliteCore));
  const schema = join(temp, "schema.ts");
  writeFileSync(
    schema,
    `${existingSchema}\nexport const ungenerated = sqliteTable("ungenerated", { id: text("id").primaryKey() });\n`,
  );
  const config = join(temp, "drizzle.config.ts");
  writeFileSync(
    config,
    `export default ${JSON.stringify({ dialect: "sqlite", schema, out: migrations })};\n`,
  );

  const result = spawnSync(
    process.execPath,
    ["scripts/check-migrations.ts", config],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Schema has changes not captured in migrations!/);
  assert.match(result.stderr, /Run: bun run migrations:generate/);
}

// Real declaration emission keeps fenced packages out of Module entry surfaces (was
// tests/architecture/vendor-provenance.test.ts; #185). `checkEntryDeclarations`
// spawns `tsc` to emit every Module's public .d.ts, so it runs here, not in the
// process-free semantic suite.
function entryDeclarationSurface(): void {
  assert.deepEqual(checkEntryDeclarations(repoRoot), []);
}

async function main(): Promise<void> {
  for (const scenario of cases) {
    try {
      await withTimeout(
        Promise.resolve(scenario.body()),
        SCENARIO_TIMEOUT_MS,
        `${scenario.name} did not settle within 20 seconds`,
      );
      console.log(`  ok  ${scenario.name}`);
    } catch (error) {
      console.error(`FAILED ${scenario.name}`);
      throw error;
    }
  }
  console.log("Process runtime conformance passed.");
}

runMain(main);
