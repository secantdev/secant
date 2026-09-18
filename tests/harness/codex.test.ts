import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CODEX_EXECUTABLE_ENV,
  createCodexAdapter,
  type HarnessPlatform,
} from "../../src/harness/harness.js";
import type { OwnedProcess } from "../../src/process/process.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { runPrepareProfileCases } from "./conformance.js";
import { installCodexReplayer } from "./codex-replayer-install.js";

const replayer = installCodexReplayer();

runPrepareProfileCases({
  label: "codex",
  baseline: () => () => createCodexAdapter({ path: replayer.path, env: {} }),
  prepareFailure: () => () =>
    createCodexAdapter({
      path: makeTempDir("secant-codex-empty-"),
      env: {},
    }),
});

test("codex-qualification initializes once without creating a conversation", async () => {
  const installed = installCodexReplayer();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const invocations = installed.invocations();
  assert.deepEqual(
    invocations.map((invocation) => invocation.args),
    [
      ["--version"],
      ["app-server", "generate-json-schema", "--out", invocations[1]?.args[3]],
      ["app-server"],
    ],
  );

  const appServer = invocations[2];
  assert.ok(appServer !== undefined);
  const messages = appServer.stdinLines.map((line) => JSON.parse(line));
  assert.deepEqual(
    messages.map((message) => message.method),
    ["initialize", "initialized", "account/read", "model/list"],
  );
  assert.equal(
    messages.filter((message) => message.method === "initialize").length,
    1,
  );
  assert.equal(messages[0]?.params.capabilities?.experimentalApi, false);
  assert.ok(
    messages.every(
      (message) =>
        !message.method.startsWith("thread/") &&
        !message.method.startsWith("turn/") &&
        message.params?.input === undefined,
    ),
  );
  const recordedCase = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "fixtures",
        "codex",
        "codex-qualification",
        "case.json",
      ),
      "utf8",
    ),
  );
  const recordedStdin = recordedCase.traffic
    .filter((entry: { direction: string }) => entry.direction === "stdin")
    .map((entry: { line: string }) => entry.line);
  assert.deepEqual(
    appServer.stdinLines.map((line) => `${line}\n`),
    recordedStdin,
  );

  await result.harness.close();
});

test("configured Codex wins over PATH and Claude Code is never a fallback", async () => {
  const configured = installCodexReplayer();
  const onPath = installCodexReplayer();
  onPath.drift("codex-cli 0.146.0");
  const result = await createCodexAdapter({
    path: onPath.path,
    env: { [CODEX_EXECUTABLE_ENV]: configured.executablePath },
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.harness.profile.executableVersion, "codex-cli 0.154.0");
  assert.match(result.harness.profile.executable, /configured command/);
  await result.harness.close();

  const missing = await createCodexAdapter({
    path: makeTempDir("secant-codex-no-fallback-"),
    env: {},
    resolve: () => undefined,
  }).prepare({ workspace: process.cwd() });
  assert.equal(missing.ok, false);
  if (missing.ok) throw new Error("unreachable");
  assert.equal(missing.failure.category, "not-found");
  assert.match(missing.failure.diagnostics ?? "", /PATH name 'codex'/);
  assert.doesNotMatch(missing.failure.diagnostics ?? "", /Claude/);
});

test("an unsupported Windows shim is a typed Codex outcome", async () => {
  const directory = makeTempDir("secant-codex-shim-");
  const shim = join(directory, "codex.cmd");
  writeFileSync(shim, "@echo off\r\necho unsupported\r\n");
  const result = await createCodexAdapter({
    platform: "win32",
    env: {},
    resolve: (name) => (name === "codex" ? shim : undefined),
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "unsupported-shim");
});

test("an unsupported host platform is a typed Codex outcome", async () => {
  const result = await createCodexAdapter({
    platform: "aix",
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "unsupported-platform");
});

test("Codex profile is truthful and user-compatible", async () => {
  const installed = installCodexReplayer();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const { profile } = result.harness;
  assert.equal(profile.harness, "codex");
  assert.equal(profile.adapterRevision, "codex-probe-1");
  assert.equal(profile.recovery.mode, "native-reattach");
  assert.equal(profile.interruption.mode, "active-turn");
  assert.equal(profile.approvals.available, true);
  assert.equal(profile.clarifications.available, false);
  assert.equal(profile.steer.available, true);
  assert.equal(profile.modelSelection.at, "launch-and-per-turn");
  assert.equal(profile.recoveryCoordinate.timing, "before-submission");
  assert.equal(profile.skillDelivery.mode, "plain-path");
  assert.equal(profile.fileDelivery.mode, "plain-path");
  assert.match(profile.configurationPosture, /user-compatible/);
  assert.match(profile.configurationPosture, /experimental.*disabled/i);
  await result.harness.close();
});

test("required schema drift fails closed before app-server launch", async () => {
  const installed = installCodexReplayer();
  installed.removeSchemaMethod("turn/completed");
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(result.failure.diagnostics ?? "", /turn\/completed/);
  assert.equal(
    installed
      .invocations()
      .filter(
        (invocation) =>
          invocation.args.length === 1 && invocation.args[0] === "app-server",
      ).length,
    0,
  );
});

test("a changed required schema field type fails closed", async () => {
  const installed = installCodexReplayer();
  installed.changeTurnStatusShape();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(result.failure.diagnostics ?? "", /Turn status/);
});

test("version and generated-schema probe failures stay typed", async () => {
  const versionFailure = installCodexReplayer();
  versionFailure.failVersion(7);
  const versionResult = await createCodexAdapter({
    path: versionFailure.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(versionResult.ok, false);
  if (versionResult.ok) throw new Error("unreachable");
  assert.equal(versionResult.failure.category, "version-probe");
  assert.equal(versionResult.failure.nativeCode, "7");

  const malformedSchema = installCodexReplayer();
  malformedSchema.corruptSchema();
  const schemaResult = await createCodexAdapter({
    path: malformedSchema.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(schemaResult.ok, false);
  if (schemaResult.ok) throw new Error("unreachable");
  assert.equal(schemaResult.failure.category, "protocol-incompatible");
  assert.ok(schemaResult.failure.cause instanceof Error);
});

test("required live response drift fails closed and reaps the child", async () => {
  const installed = installCodexReplayer();
  installed.removeResponseField("model/list", "data");
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(result.failure.diagnostics ?? "", /model\/list/);
  const appServer = installed
    .invocations()
    .find(
      (invocation) =>
        invocation.args.length === 1 && invocation.args[0] === "app-server",
    );
  assert.ok(appServer !== undefined);
  assert.deepEqual(
    appServer.stdinLines.map((line) => JSON.parse(line).method),
    ["initialize", "initialized", "account/read", "model/list"],
  );
});

test("a child that stops draining stdin cannot outlive the handshake bound", async () => {
  const installed = installCodexReplayer();
  const stalled = stalledProcess();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
    handshakeTimeoutMs: 20,
    spawn: () => Promise.resolve({ ok: true, process: stalled }),
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "protocol-incompatible");
  assert.match(result.failure.diagnostics ?? "", /timed out/);
});

test("a notification flood cannot extend the whole-RPC deadline", async () => {
  const installed = installCodexReplayer();
  const flooding = notificationFloodProcess();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
    handshakeTimeoutMs: 20,
    spawn: () => Promise.resolve({ ok: true, process: flooding }),
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.failure.diagnostics ?? "", /initialize.*timed out/);
});

test("app-server launch and cleanup failures preserve their own evidence", async () => {
  const launchReplayer = installCodexReplayer();
  const launchCause = new Error("scripted app-server launch failure");
  const launchResult = await createCodexAdapter({
    path: launchReplayer.path,
    env: {},
    spawn: () =>
      Promise.resolve({
        ok: false,
        failure: { kind: "spawn-error", cause: launchCause },
      }),
  }).prepare({ workspace: process.cwd() });
  assert.equal(launchResult.ok, false);
  if (launchResult.ok) throw new Error("unreachable");
  assert.equal(launchResult.failure.category, "app-server-launch");
  assert.equal(launchResult.failure.cause, launchCause);

  const cleanupReplayer = installCodexReplayer();
  cleanupReplayer.failCleanup(9);
  const prepared = await createCodexAdapter({
    path: cleanupReplayer.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");
  const first = await prepared.harness.close();
  assert.equal(first.clean, false);
  assert.equal(first.failure?.category, "cleanup");
  assert.strictEqual(await prepared.harness.close(), first);

  const evidenceReplayer = installCodexReplayer();
  const stderrCause = new Error("scripted stderr read failure");
  const cleanupCause = new Error("scripted cleanup failure");
  const evidenceProcess = qualificationProcess({ stderrCause, cleanupCause });
  const evidencePrepared = await createCodexAdapter({
    path: evidenceReplayer.path,
    env: {},
    spawn: () => Promise.resolve({ ok: true, process: evidenceProcess }),
  }).prepare({ workspace: process.cwd() });
  assert.equal(evidencePrepared.ok, true);
  if (!evidencePrepared.ok) throw new Error("unreachable");
  const evidence = await evidencePrepared.harness.close();
  assert.equal(evidence.clean, false);
  assert.ok(evidence.failure?.cause instanceof AggregateError);
  assert.deepEqual(evidence.failure.cause.errors, [cleanupCause, stderrCause]);
});

test("authentication remains Codex-owned with separate-login remediation", async () => {
  const installed = installCodexReplayer();
  installed.requireLogin();
  const result = await createCodexAdapter({
    path: installed.path,
    env: {},
  }).prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "authentication");
  assert.match(
    result.failure.diagnostics ?? "",
    /Log in separately through Codex/,
  );
  assert.doesNotMatch(result.failure.diagnostics ?? "", /recorded@example/);

  const appServer = installed
    .invocations()
    .find(
      (invocation) =>
        invocation.args.length === 1 && invocation.args[0] === "app-server",
    );
  assert.ok(appServer !== undefined);
  assert.deepEqual(
    appServer.stdinLines.map((line) => JSON.parse(line).method),
    ["initialize", "initialized", "account/read"],
  );
});

test("cached schema evidence is reused but every prepare initializes a fresh child", async () => {
  const installed = installCodexReplayer();
  const adapter = createCodexAdapter({ path: installed.path, env: {} });
  const first = await adapter.prepare({ workspace: process.cwd() });
  const second = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) throw new Error("unreachable");

  const invocations = installed.invocations();
  assert.equal(
    invocations.filter((invocation) =>
      invocation.args.includes("generate-json-schema"),
    ).length,
    1,
  );
  assert.equal(
    invocations.filter(
      (invocation) =>
        invocation.args.length === 1 && invocation.args[0] === "app-server",
    ).length,
    2,
  );
  await first.harness.close();
  await second.harness.close();

  installed.driftBytesWithoutMetadataChange();
  const byteDrifted = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(byteDrifted.ok, true);
  if (!byteDrifted.ok) throw new Error("unreachable");
  assert.equal(
    installed
      .invocations()
      .filter((invocation) => invocation.args.includes("generate-json-schema"))
      .length,
    2,
  );
  await byteDrifted.harness.close();

  installed.drift("codex-cli 0.155.0");
  const drifted = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(drifted.ok, true);
  if (!drifted.ok) throw new Error("unreachable");
  assert.equal(drifted.harness.profile.executableVersion, "codex-cli 0.155.0");
  assert.equal(
    installed
      .invocations()
      .filter((invocation) => invocation.args.includes("generate-json-schema"))
      .length,
    3,
  );
  await drifted.harness.close();
});

test("cache evidence invalidates on source, path, version, platform, and probe revision", async () => {
  const installed = installCodexReplayer();
  let cachePlatform: HarnessPlatform = "windows";
  let probeRevision = "codex-probe-1";
  const adapter = createCodexAdapter({
    path: installed.path,
    env: {},
    platform: "win32",
    qualificationCachePlatform: () => cachePlatform,
    probeRevision: () => probeRevision,
    resolve(name) {
      if (name === "codex") return installed.executablePath;
      if (name === "bun") return process.execPath;
      if (name.endsWith("codex.cmd")) return name;
      return undefined;
    },
  });

  const prepared: { harness: { close(): Promise<unknown> } }[] = [];
  const qualify = async (configuredExecutable?: string): Promise<void> => {
    const options: { workspace: string; configuredExecutable?: string } = {
      workspace: process.cwd(),
    };
    if (configuredExecutable !== undefined) {
      options.configuredExecutable = configuredExecutable;
    }
    const result = await adapter.prepare(options);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    prepared.push(result);
  };

  await qualify();
  await qualify(installed.windowsShimPath);
  installed.changeVersionOnly("codex-cli 0.154.1");
  await qualify(installed.windowsShimPath);
  cachePlatform = "linux";
  await qualify(installed.windowsShimPath);
  probeRevision = "codex-probe-2";
  await qualify(installed.windowsShimPath);

  const another = installCodexReplayer();
  await qualify(another.windowsShimPath);
  assert.equal(
    installed
      .invocations()
      .filter((invocation) => invocation.args.includes("generate-json-schema"))
      .length,
    5,
  );
  assert.equal(
    another
      .invocations()
      .filter((invocation) => invocation.args.includes("generate-json-schema"))
      .length,
    1,
  );
  await Promise.all(prepared.map((result) => result.harness.close()));
});

function stalledProcess(): OwnedProcess {
  const noBytes = async function* (): AsyncIterable<Uint8Array> {};
  const never = new Promise<void>(() => undefined);
  return {
    stdout: noBytes(),
    stderr: noBytes(),
    writeStdin: () => never,
    closeStdin: () => Promise.resolve({ kind: "exited", status: 0 }),
    terminate: () => Promise.resolve({ kind: "exited", status: 0 }),
    interrupt: () =>
      Promise.resolve({
        close: { kind: "exited", status: 0 },
        escalated: false,
      }),
    closed: () => Promise.resolve({ kind: "exited", status: 0 }),
  };
}

function notificationFloodProcess(): OwnedProcess {
  let closed = false;
  const stdout = async function* (): AsyncIterable<Uint8Array> {
    while (!closed) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (closed) return;
      yield new TextEncoder().encode(
        `${JSON.stringify({ method: "account/updated", params: {} })}\n`,
      );
    }
  };
  const noBytes = async function* (): AsyncIterable<Uint8Array> {};
  return {
    stdout: stdout(),
    stderr: noBytes(),
    writeStdin: () => Promise.resolve(),
    closeStdin: () => {
      closed = true;
      return Promise.resolve({ kind: "exited", status: 0 });
    },
    terminate: () => Promise.resolve({ kind: "exited", status: 0 }),
    interrupt: () =>
      Promise.resolve({
        close: { kind: "exited", status: 0 },
        escalated: false,
      }),
    closed: () => Promise.resolve({ kind: "exited", status: 0 }),
  };
}

interface TQualificationProcess {
  readonly stderrCause: Error;
  readonly cleanupCause: Error;
}

function qualificationProcess(options: TQualificationProcess): OwnedProcess {
  const encoder = new TextEncoder();
  const stdout = async function* (): AsyncIterable<Uint8Array> {
    yield encoder.encode(
      `${JSON.stringify({ id: 1, result: { userAgent: "recorded", codexHome: "/recorded", platformFamily: "unix", platformOs: "linux" } })}\n`,
    );
    yield encoder.encode(
      `${JSON.stringify({ id: 2, result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } })}\n`,
    );
    yield encoder.encode(
      `${JSON.stringify({ id: 3, result: { data: [{ id: "model", model: "model", displayName: "Model", hidden: false, isDefault: true }] } })}\n`,
    );
  };
  const stderr: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(options.stderrCause),
      };
    },
  };
  return {
    stdout: stdout(),
    stderr,
    writeStdin: () => Promise.resolve(),
    closeStdin: () =>
      Promise.resolve({
        kind: "cleanup-error",
        cause: options.cleanupCause,
      }),
    terminate: () =>
      Promise.resolve({
        kind: "cleanup-error",
        cause: options.cleanupCause,
      }),
    interrupt: () =>
      Promise.resolve({
        close: { kind: "cleanup-error", cause: options.cleanupCause },
        escalated: true,
      }),
    closed: () =>
      Promise.resolve({
        kind: "cleanup-error",
        cause: options.cleanupCause,
      }),
  };
}
