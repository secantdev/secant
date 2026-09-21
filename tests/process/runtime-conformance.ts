#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createProcessAdapter,
  type OwnedProcessOptions,
  type SpawnOptions,
  type OwnedProcess,
  type ProcessAdapter,
} from "../../src/process/process.js";
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

const executable = process.execPath;
const missing = join(tmpdir(), `secant-process-parity-missing-${process.pid}`);
const SCENARIO_TIMEOUT_MS = 20_000;
const CONCURRENT_CREATE_WORKER = fileURLToPath(
  new URL("../run/store/concurrent-create-worker.ts", import.meta.url),
);

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
  {
    name: "execution-store-on-fake-process",
    body: executionStoreOnFakeProcess,
  },
  { name: "composition-real-process", body: compositionRealProcess },
);

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

async function compositionRealProcess(): Promise<void> {
  const workspace = runtimeTemp("secant-runtime-composition-workspace-");
  const wired = wireApplication({
    secantHome: runtimeTemp("secant-runtime-composition-home-"),
    launchCwd: workspace,
  });
  try {
    const bundle = writeRuntimeCommandBundle();
    const built = wired.bundleManagement.build(bundle.folder, {
      noInstall: false,
    });
    assert.ok(built.ok);
    assert.equal(
      wired.projectionPort.submit({
        operationId: "composition-approve",
        operation: "approve-workspace",
        input: { path: workspace },
      }).admitted,
      true,
    );
    const entry = wired.catalog
      .listEntries()
      .find((candidate) => candidate.id === bundle.id);
    assert.ok(entry);
    const admission = wired.projectionPort.submit({
      operationId: "composition-launch",
      operation: "launch-run",
      input: {
        bundle: { id: bundle.id },
        launchInputs: {},
        trustDigest: entry.digest,
      },
    });
    assert.equal(admission.admitted, true);
    if (!admission.admitted || admission.runId === undefined) {
      throw new Error("composition did not admit the runtime Run");
    }
    await awaitOperation(wired, "composition-launch");
    const opened = wired.projectionPort.openProjection({
      family: "run",
      runId: admission.runId,
    });
    try {
      assert.ok(opened.snapshot.result.found);
      if (!opened.snapshot.result.found) throw new Error("Run disappeared");
      assert.equal(opened.snapshot.result.run.state, "succeeded");
    } finally {
      opened.close();
    }
  } finally {
    wired.runGroup.close();
    wired.catalog.close();
  }
}

async function awaitOperation(
  wired: ReturnType<typeof wireApplication>,
  operationId: string,
): Promise<void> {
  const opened = wired.projectionPort.openProjection({
    family: "operation",
    operationId,
  });
  try {
    if (opened.snapshot.outcome.status !== "pending") return;
    for await (const update of opened.updates) {
      if (
        update.kind === "durable" &&
        update.snapshot.family === "operation" &&
        update.snapshot.outcome.status !== "pending"
      ) {
        return;
      }
    }
    throw new Error(`operation ${operationId} closed before settlement`);
  } finally {
    opened.close();
  }
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

function writeRuntimeCommandBundle(): {
  readonly folder: string;
  readonly id: string;
} {
  const folder = runtimeTemp("secant-runtime-command-bundle-");
  const id = "dev.secant.runtime-command";
  writeFileSync(
    join(folder, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      bundle: {
        id,
        version: "1.0.0",
        name: "Runtime Command",
        description: "Proves production Process composition.",
      },
      platforms: ["windows", "macos", "linux"],
      inputs: {},
      assets: [],
      routing: [
        {
          id: "command",
          kind: "command",
          produces: [{ name: "output", type: "text" }],
          command: {
            executable: basename(process.execPath),
            arguments: ["-e", "process.stdout.write('composed-real-process')"],
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
  const child = await startStoreWriter(
    processAdapter,
    home,
    workspace,
    "owner-op",
    true,
  );
  await child.ready;
  await child.process.writeStdin(new TextEncoder().encode("create\n"));
  await child.created;
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
  const first = await startStoreWriter(processAdapter, home, workspace, "op-1");
  const second = await startStoreWriter(
    processAdapter,
    home,
    workspace,
    "op-2",
  );
  await Promise.all([first.ready, second.ready]);
  await Promise.all([
    first.process.writeStdin(new TextEncoder().encode("create\n")),
    second.process.writeStdin(new TextEncoder().encode("create\n")),
  ]);
  const closes = await Promise.all([
    first.process.closeStdin(5_000),
    second.process.closeStdin(5_000),
  ]);
  assert.deepEqual(
    closes.map((close) => close.kind),
    ["exited", "exited"],
  );
  const group = openRunGroup(home, workspace, { process: processAdapter });
  try {
    assert.equal(group.listRuns().length, 2);
  } finally {
    group.close();
  }
}

async function startStoreWriter(
  processAdapter: ProcessAdapter,
  home: string,
  workspace: string,
  operationId: string,
  holdAfterCreate = false,
): Promise<{
  readonly process: OwnedProcess;
  readonly ready: Promise<void>;
  readonly created: Promise<void>;
}> {
  const spawned = await processAdapter.spawnOwnedProcess({
    executable,
    args: [
      CONCURRENT_CREATE_WORKER,
      home,
      workspace,
      operationId,
      ...(holdAfterCreate ? ["hold"] : []),
    ],
    cwd: process.cwd(),
    env: process.env,
    launchTimeoutMs: 5_000,
  });
  assert.equal(spawned.ok, true);
  if (!spawned.ok) throw new Error("store writer did not launch");
  const output = observeOutput(spawned.process.stdout);
  return {
    process: spawned.process,
    ready: output.waitFor("ready\n"),
    created: output.waitFor("created\n"),
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

async function main(): Promise<void> {
  for (const scenario of cases) {
    try {
      await withinScenarioBound(scenario.body(), scenario.name);
      console.log(`  ok  ${scenario.name}`);
    } catch (error) {
      console.error(`FAILED ${scenario.name}`);
      throw error;
    }
  }
  console.log("Process runtime conformance passed.");
}

function withinScenarioBound(
  result: void | Promise<void>,
  name: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${name} did not settle within 20 seconds`)),
      SCENARIO_TIMEOUT_MS,
    );
  });
  return Promise.race([Promise.resolve(result), elapsed]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
