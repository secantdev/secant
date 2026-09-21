import { createHash } from "node:crypto";
/* global Bun */

import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELEASE_VERSION = "1.18.31";
const RELEASE_TAG = `v${RELEASE_VERSION}`;
const REQUEST_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 8_000;
const SECRET_CANARY = "SECANT_MALFORMED_PAYLOAD_CANARY";

const ASSETS = {
  "win32-x64": {
    archive: "opencode-windows-x64.zip",
    sha256: "0ecd7ffc7f26390ce7799e7bcd409e4f11c410144308a6a5b0fcdce63d871006",
    executable: "opencode.exe",
  },
  "darwin-arm64": {
    archive: "opencode-darwin-arm64.zip",
    sha256: "caf7f31fa1aec2353ea859d4ef9ab824c6273d941b016e88d51193fa3028d34e",
    executable: "opencode",
  },
  "linux-x64": {
    archive: "opencode-linux-x64.tar.gz",
    sha256: "e9312be75ed803b7415fc2aeabda1f4fe938912a39673762dc0c38c0e11ebde4",
    executable: "opencode",
  },
};

const platformKey = `${process.platform}-${process.arch}`;
const asset = ASSETS[platformKey];
if (!asset)
  throw new Error(`Unsupported qualification platform: ${platformKey}`);

const root = await mkdtemp(join(tmpdir(), "secant-opencode-qualification-"));
const workspace = join(root, "workspace");
const alternateWorkspace = join(root, "other-workspace");
const home = join(root, "home");
const archivePath = join(root, asset.archive);
const binaryDirectory = join(root, "binary");
const binaryPath = join(binaryDirectory, asset.executable);
const resultPath =
  process.env.QUALIFICATION_RESULT_PATH ??
  join(process.cwd(), "opencode-qualification-result.json");

await Promise.all([
  mkdir(workspace),
  mkdir(alternateWorkspace),
  mkdir(home),
  mkdir(binaryDirectory),
]);

const groupResults = [];
const evidence = [];
const activeClients = new Set();
let provider;
let retainedSessionId;

try {
  const download = await downloadRelease();
  provider = createProviderServer();
  recordEvidence("release", download);
  await qualifyGroup1(download);
  await qualifyGroup2();
  await qualifyGroup3();
  await qualifyGroup4();
  await qualifyGroup5();
  await qualifyGroup6();
  await qualifyGroup7();
  await qualifyGroup8();
  await qualifyGroup9();
  await qualifyGroup10();
} finally {
  provider?.stop(true);
  await rm(root, { recursive: true, force: true });
}

const overall = groupResults.every((item) => item.classification === "pass")
  ? "pass"
  : "defer";
const report = {
  schemaVersion: 1,
  release: {
    version: RELEASE_VERSION,
    tag: RELEASE_TAG,
    archive: asset.archive,
    expectedSha256: asset.sha256,
  },
  platform: {
    key: platformKey,
    os: process.platform,
    arch: process.arch,
  },
  overall,
  groups: groupResults,
  evidence,
};
await Bun.write(resultPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (overall !== "pass") process.exitCode = 1;

async function downloadRelease() {
  const url = `https://github.com/anomalyco/opencode/releases/download/${RELEASE_TAG}/${asset.archive}`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok)
    throw new Error(`Release download failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  await Bun.write(archivePath, bytes);
  if (actualSha256 !== asset.sha256) {
    throw new Error(
      `Release digest mismatch: expected ${asset.sha256}, got ${actualSha256}`,
    );
  }
  const extraction = Bun.spawn(
    ["tar", "-xf", archivePath, "-C", binaryDirectory],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const extractionExit = await extraction.exited;
  if (extractionExit !== 0) {
    const stderr = await new Response(extraction.stderr).text();
    throw new Error(
      `Archive extraction failed (${extractionExit}): ${bounded(stderr)}`,
    );
  }
  await stat(binaryPath);
  if (process.platform !== "win32") await chmod(binaryPath, 0o755);
  return { url, actualSha256, bytes: bytes.length };
}

async function qualifyGroup1(download) {
  await runGroup(
    1,
    "asset identity, launch, loopback bind, and protocol-only stdout",
    async () => {
      const version = await runCommand([binaryPath, "--version"]);
      const help = await runCommand([binaryPath, "acp", "--help"]);
      assert(version.exitCode === 0, `--version exit was ${version.exitCode}`);
      assert(
        version.stdout.trim() === RELEASE_VERSION,
        `reported version was ${bounded(version.stdout)}`,
      );
      assert(
        help.exitCode === 0,
        `opencode acp --help exit was ${help.exitCode}`,
      );
      assert(
        `${help.stdout}${help.stderr}`.toLowerCase().includes("acp"),
        `opencode acp --help returned no ACP usage: ${bounded(`${help.stdout}${help.stderr}`)}`,
      );
      const client = await startClient();
      const initialized = await initialize(client, 1);
      assert(
        initialized.result?.protocolVersion === 1,
        "ACP launch did not initialize on private loopback",
      );
      assert(
        client.malformedStdout.length === 0,
        "stdout contained non-JSON protocol bytes",
      );
      const exitCode = await client.closeGracefully();
      assert(exitCode === 0, `stdin EOF exit was ${exitCode}`);
      return {
        digest: download.actualSha256,
        version: version.stdout.trim(),
        help: "opencode acp usage returned",
        stdout: "strict NDJSON observed",
        eofExitCode: exitCode,
      };
    },
  );
}

async function qualifyGroup2() {
  await runGroup(
    2,
    "ACP initialization, version/capabilities, and authentication metadata",
    async () => {
      const client = await startClient();
      const initialized = await initialize(client, 1);
      const incompatible = await initialize(client, 999);
      const auth = await client.request("authenticate", {
        methodId: "opencode-login",
      });
      await client.closeGracefully();
      const authMethod = initialized.result?.authMethods?.find(
        (item) => item.id === "opencode-login",
      );
      const terminalAuth = authMethod?._meta?.["terminal-auth"];
      assert(
        initialized.result?.protocolVersion === 1,
        "compatible initialization did not return ACP 1",
      );
      assert(
        terminalAuth?.command === "opencode",
        "terminal-auth executable metadata missing",
      );
      assert(
        terminalAuth?.args?.join(" ") === "auth login",
        "terminal-auth argument metadata missing",
      );
      assert(auth.result && !auth.error, "authenticate(opencode-login) failed");
      assert(
        incompatible.error,
        `incompatible requested major 999 was accepted and returned protocol ${incompatible.result?.protocolVersion}`,
      );
      return {
        advertisedProtocol: initialized.result.protocolVersion,
        capabilities: initialized.result.agentCapabilities,
        terminalAuthCommand: `${terminalAuth.command} ${terminalAuth.args.join(" ")}`,
        incompatibleMajor: "refused",
      };
    },
  );
}

async function qualifyGroup3() {
  await runGroup(
    3,
    "isolated state, deterministic provider, and durable admission before prompt",
    async () => {
      const before = provider.state.requests.length;
      const client = await startClient();
      await initialize(client, 1);
      const session = await newSession(client, workspace);
      assert(
        session.result,
        `session/new failed before config checks: ${JSON.stringify(session.error)}`,
      );
      assert(
        typeof session.result?.sessionId === "string",
        "session/new did not return a recovery coordinate",
      );
      retainedSessionId = session.result.sessionId;
      const requestsBeforePrompt = provider.state.requests.length - before;
      assert(
        requestsBeforePrompt === 0,
        "provider saw prompt bytes before Session admission",
      );
      const prompt = client.request(
        "session/prompt",
        promptParams(retainedSessionId, "ADMISSION_OK"),
      );
      const response = await prompt;
      assert(
        response.result?.stopReason === "end_turn",
        "deterministic provider prompt did not complete",
      );
      await client.closeGracefully();
      return {
        isolatedHome: true,
        sessionIdPrefix: retainedSessionId.slice(0, 4),
        providerRequestsBeforePrompt: requestsBeforePrompt,
        promptStopReason: response.result.stopReason,
      };
    },
  );
}

async function qualifyGroup4() {
  await runGroup(
    4,
    "streaming, terminal ordering, tool/usage activity, and backpressure",
    async () => {
      const client = await startClient();
      await initialize(client, 1);
      const session = await newSession(client, workspace);
      const response = await client.request(
        "session/prompt",
        promptParams(session.result.sessionId, "STREAM_BACKPRESSURE"),
      );
      const updates = client.notifications.filter(
        (item) => item.method === "session/update",
      );
      const kinds = updates
        .map((item) => item.params?.update?.sessionUpdate)
        .filter(Boolean);
      const responseSequence = client.sequenceOfResponse(response.id);
      const lastUpdateSequence =
        client.lastNotificationSequence("session/update");
      await client.closeGracefully();
      assert(
        response.result?.stopReason === "end_turn",
        "stream prompt lacked authoritative end_turn",
      );
      assert(
        kinds.includes("agent_message_chunk"),
        "assistant streaming was not observed",
      );
      assert(
        kinds.includes("agent_thought_chunk"),
        "thought streaming was not observed",
      );
      assert(
        kinds.includes("usage_update"),
        "usage streaming was not observed",
      );
      assert(
        lastUpdateSequence < responseSequence,
        "a streamed update arrived after the prompt response",
      );
      assert(
        provider.state.backpressureBytes >= 1_000_000,
        "provider did not exercise a pipe-scale response",
      );
      return {
        observedUpdateKinds: [...new Set(kinds)].sort(),
        lastUpdateSequence,
        responseSequence,
        providerBytes: provider.state.backpressureBytes,
      };
    },
  );
}

async function qualifyGroup5() {
  await runGroup(
    5,
    "permission choices, client cancellation, and terminal expiry",
    async () => {
      const decisions = ["once", "always", "reject"];
      const observed = [];
      for (const decision of decisions) {
        const outcome = await runPermissionCase(
          decision,
          `PERMISSION_${decision.toUpperCase()}`,
        );
        observed.push(outcome);
      }
      const cancelled = await runPermissionCase(
        "cancelled",
        "PERMISSION_CANCELLED",
      );
      observed.push(cancelled);
      const expired = await runOutstandingPermissionExpiry();
      assert(
        observed.every(
          (item) => item.options.join(",") === "once,always,reject",
        ),
        "permission options drifted",
      );
      assert(
        expired.stopReason === "cancelled",
        "outstanding request did not expire through terminal cancellation",
      );
      return { decisions: observed, outstandingExpiry: expired };
    },
  );
}

async function qualifyGroup6() {
  await runGroup(
    6,
    "active cancellation, confirmation/races, reuse, and uncertain loss",
    async () => {
      const client = await startClient();
      await initialize(client, 1);
      const session = await newSession(client, workspace);
      const prompt = client.request(
        "session/prompt",
        promptParams(session.result.sessionId, "CANCEL_ACTIVE"),
      );
      await provider.waitForMarker("CANCEL_ACTIVE");
      client.notify("session/cancel", { sessionId: session.result.sessionId });
      const cancelled = await prompt;
      assert(
        cancelled.result?.stopReason === "cancelled",
        "active cancel was not confirmed by prompt result",
      );
      const reused = await client.request(
        "session/prompt",
        promptParams(session.result.sessionId, "REUSE_AFTER_CANCEL"),
      );
      assert(
        reused.result?.stopReason === "end_turn",
        "Session was not reusable after confirmed cancellation",
      );
      client.notify("session/cancel", { sessionId: session.result.sessionId });
      const raceReuse = await client.request(
        "session/prompt",
        promptParams(session.result.sessionId, "REUSE_AFTER_RACE"),
      );
      assert(
        raceReuse.result?.stopReason === "end_turn",
        "late cancel corrupted the next Turn",
      );
      await client.closeGracefully();

      const lossClient = await startClient();
      await initialize(lossClient, 1);
      const lossSession = await newSession(lossClient, workspace);
      const lossPrompt = lossClient.request(
        "session/prompt",
        promptParams(lossSession.result.sessionId, "LOSS_AFTER_EFFECTS"),
      );
      await provider.waitForMarker("LOSS_AFTER_EFFECTS");
      lossClient.kill();
      const loss = await settleRequest(lossPrompt);
      assert(
        loss.kind === "rejected",
        "connection loss incorrectly produced a prompt result",
      );
      return {
        activeCancel: cancelled.result.stopReason,
        reuse: reused.result.stopReason,
        lateCancelReuse: raceReuse.result.stopReason,
        connectionLoss: "pending call rejected without terminal truth",
      };
    },
  );
}

async function qualifyGroup7() {
  await runGroup(
    7,
    "restart, exact resume, replay barrier, missing Session, and directory mismatch",
    async () => {
      assert(retainedSessionId, "group 3 did not retain a Session coordinate");
      const client = await startClient();
      await initialize(client, 1);
      const resumeStart = client.notifications.length;
      const resumed = await client.request(
        "session/resume",
        sessionParams(retainedSessionId, workspace),
      );
      const resumeUpdates = client.notifications
        .slice(resumeStart)
        .filter((item) => item.method === "session/update");
      assert(
        resumed.result?.configOptions,
        "exact resume failed after process restart",
      );
      assert(
        resumeUpdates.length === 0,
        "resume unexpectedly replayed history",
      );
      await client.request("session/close", { sessionId: retainedSessionId });
      const loadStart = client.sequence;
      const loaded = await client.request(
        "session/load",
        sessionParams(retainedSessionId, workspace),
      );
      const replay = client.notifications.filter(
        (item) =>
          item.sequence > loadStart &&
          item.method === "session/update" &&
          item.sequence < client.sequenceOfResponse(loaded.id),
      );
      assert(loaded.result?.configOptions, "load failed after process restart");
      assert(
        replay.some(isMessageUpdate),
        "load did not replay stored history before its response",
      );
      const missing = await client.request(
        "session/resume",
        sessionParams("ses_missing_secant_probe", workspace),
      );
      const mismatch = await client.request(
        "session/resume",
        sessionParams(retainedSessionId, alternateWorkspace),
      );
      await client.closeGracefully();
      assert(missing.error, "missing Session was accepted");
      assert(mismatch.error, "directory-mismatched Session was accepted");
      return {
        exactResume: "same ID, no replay",
        loadReplayUpdates: replay.length,
        replayBeforeResponse: true,
        missingCode: missing.error.code,
        directoryMismatchCode: mismatch.error.code,
      };
    },
  );
}

async function qualifyGroup8() {
  await runGroup(
    8,
    "model, effort, and mode changes with typed invalid-option failures",
    async () => {
      const client = await startClient();
      await initialize(client, 1);
      const session = await newSession(client, workspace);
      assert(
        session.result,
        `session/new failed before config checks: ${JSON.stringify(session.error)}`,
      );
      const changed = {};
      for (const id of ["model", "effort", "mode"]) {
        const option = findSelectOption(session.result.configOptions, id);
        const alternate = flattenOptions(option).find(
          (item) => item.value !== option.currentValue,
        );
        assert(alternate, `no alternate ${id} option was advertised`);
        const update = await client.request("session/set_config_option", {
          sessionId: session.result.sessionId,
          configId: id,
          value: alternate.value,
        });
        const current = findSelectOption(
          update.result?.configOptions,
          id,
        ).currentValue;
        assert(
          current === alternate.value,
          `${id} change was not acknowledged`,
        );
        changed[id] = current;
      }
      const invalid = await client.request("session/set_config_option", {
        sessionId: session.result.sessionId,
        configId: "model",
        value: "missing-provider/missing-model",
      });
      await client.closeGracefully();
      assert(
        invalid.error?.code === -32602,
        `invalid option error was ${JSON.stringify(invalid.error)}`,
      );
      return { changed, invalidCode: invalid.error.code };
    },
  );
}

async function qualifyGroup9() {
  await runGroup(
    9,
    "Session close, retained history, EOF, and bounded process-tree cleanup",
    async () => {
      assert(retainedSessionId, "group 3 did not retain a Session coordinate");
      const client = await startClient();
      await initialize(client, 1);
      const resumed = await client.request(
        "session/resume",
        sessionParams(retainedSessionId, workspace),
      );
      assert(resumed.result, "retained Session was unavailable before close");
      const closed = await client.request("session/close", {
        sessionId: retainedSessionId,
      });
      assert(closed.result && !closed.error, "session/close failed");
      const loaded = await client.request(
        "session/load",
        sessionParams(retainedSessionId, workspace),
      );
      assert(loaded.result, "session/close deleted durable history");
      const exitCode = await client.closeGracefully();
      assert(exitCode === 0, `stdin EOF exit was ${exitCode}`);

      const cleanup = await observeForcedCleanup();
      assert(cleanup.childGone, `UNKNOWN: ${cleanup.evidence}`);
      return {
        closePreservedHistory: true,
        eofExitCode: exitCode,
        forcedCleanup: cleanup,
      };
    },
  );
}

async function qualifyGroup10() {
  await runGroup(
    10,
    "malformed, truncated, duplicate, mismatched JSON-RPC and unexpected EOF",
    async () => {
      const malformedClient = await startClient();
      await initialize(malformedClient, 1);
      malformedClient.sendRaw(`${SECRET_CANARY}\n`);
      const list = await malformedClient.request("session/list", {
        cwd: workspace,
      });
      assert(list.result, "malformed input wedged the following request");
      await malformedClient.closeGracefully();
      const leaked = malformedClient.stderr.includes(SECRET_CANARY);

      const duplicateClient = await startClient();
      await initialize(duplicateClient, 1);
      const duplicate = await duplicateClient.sendDuplicateRequests(
        "session/list",
        { cwd: workspace },
      );
      await duplicateClient.closeGracefully();

      const mismatch = await runMismatchedPermissionResponse();

      const truncatedClient = await startClient();
      truncatedClient.sendRaw(
        '{"jsonrpc":"2.0","id":77,"method":"initialize","params":',
      );
      const truncatedExit = await truncatedClient.closeGracefully();
      const truncatedLogged = truncatedClient.stderr.includes(
        '"method":"initialize"',
      );

      const eofClient = await startClient();
      await initialize(eofClient, 1);
      const session = await newSession(eofClient, workspace);
      const pending = eofClient.request(
        "session/prompt",
        promptParams(session.result.sessionId, "UNEXPECTED_EOF"),
      );
      await provider.waitForMarker("UNEXPECTED_EOF");
      eofClient.kill();
      const eofResult = await settleRequest(pending);

      assert(
        duplicate.responses === 2,
        "duplicate ids did not produce two independently framed responses",
      );
      assert(
        mismatch.recovered,
        "mismatched response prevented the correct permission response",
      );
      assert(
        eofResult.kind === "rejected",
        "unexpected EOF left the pending request settled as success",
      );
      assert(
        !leaked && !truncatedLogged,
        "payload-bearing malformed or truncated input leaked to stderr",
      );
      return {
        malformedRecovery: true,
        duplicateResponses: duplicate.responses,
        mismatchedResponseIgnored: mismatch.recovered,
        truncatedExit,
        unexpectedEof: eofResult.kind,
        payloadLeak: leaked || truncatedLogged,
      };
    },
  );
}

async function runPermissionCase(decision, marker) {
  let requestShape;
  const client = await startClient({
    onPermission: async (request) => {
      requestShape = request;
      if (decision === "cancelled")
        return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId: decision } };
    },
  });
  await initialize(client, 1);
  const session = await newSession(client, workspace);
  const response = await client.request(
    "session/prompt",
    promptParams(session.result.sessionId, marker),
  );
  await client.closeGracefully();
  assert(requestShape, `${decision} did not raise a permission request`);
  const options = requestShape.params.options.map((item) => item.optionId);
  const expected =
    decision === "once" || decision === "always" ? "end_turn" : "end_turn";
  assert(
    response.result?.stopReason === expected,
    `${decision} prompt ended as ${JSON.stringify(response)}`,
  );
  return { decision, options, stopReason: response.result.stopReason };
}

async function runOutstandingPermissionExpiry() {
  let permissionSeen;
  const client = await startClient({
    onPermission: async () => {
      permissionSeen = true;
      return new Promise(() => {});
    },
  });
  await initialize(client, 1);
  const session = await newSession(client, workspace);
  const prompt = client.request(
    "session/prompt",
    promptParams(session.result.sessionId, "PERMISSION_EXPIRE"),
  );
  await waitFor(
    () => permissionSeen,
    "permission request did not become outstanding",
  );
  client.notify("session/cancel", { sessionId: session.result.sessionId });
  const response = await prompt;
  client.kill();
  return { stopReason: response.result?.stopReason };
}

async function runMismatchedPermissionResponse() {
  let requestId;
  let releaseCorrect;
  const gate = new Promise((resolve) => {
    releaseCorrect = resolve;
  });
  const client = await startClient({
    onPermission: async (request) => {
      requestId = request.id;
      await gate;
      return { outcome: { outcome: "selected", optionId: "reject" } };
    },
  });
  await initialize(client, 1);
  const session = await newSession(client, workspace);
  const prompt = client.request(
    "session/prompt",
    promptParams(session.result.sessionId, "PERMISSION_MISMATCH"),
  );
  await waitFor(
    () => requestId !== undefined,
    "permission request was not observed",
  );
  client.sendObject({
    jsonrpc: "2.0",
    id: `${requestId}-wrong`,
    result: { outcome: { outcome: "selected", optionId: "once" } },
  });
  releaseCorrect();
  const response = await prompt;
  await client.closeGracefully();
  return { recovered: response.result?.stopReason === "end_turn" };
}

async function observeForcedCleanup() {
  return {
    childGone: false,
    evidence:
      "throwaway probe did not implement Secant's cross-platform process-tree owner",
  };
}

function createProviderServer() {
  const state = {
    requests: [],
    markers: new Set(),
    markerWaiters: new Map(),
    backpressureBytes: 0,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    async fetch(request) {
      const body = await request.json();
      const serialized = JSON.stringify(body);
      state.requests.push({
        path: new URL(request.url).pathname,
        model: body.model,
      });
      resolveMarkers(serialized, state);
      if (serialized.includes("Generate a title for this conversation")) {
        return sseResponse([
          textChunk("Probe session"),
          finishChunk("stop", 2, 1),
        ]);
      }
      if (
        serialized.includes("CANCEL_ACTIVE") ||
        serialized.includes("LOSS_AFTER_EFFECTS") ||
        serialized.includes("UNEXPECTED_EOF")
      ) {
        return hangingSseResponse([roleChunk()], request.signal);
      }
      if (serialized.includes("PERMISSION_") && !hasToolResult(body)) {
        return sseResponse([
          roleChunk(),
          toolChunk("call_probe", "bash", {
            command: "echo ACP_TOOL_OK",
            description: "qualification probe",
          }),
          finishChunk("tool_calls", 5, 2),
        ]);
      }
      if (serialized.includes("STREAM_BACKPRESSURE")) {
        const chunks = [roleChunk(), reasoningChunk("reasoned")];
        const text = "x".repeat(256);
        for (let index = 0; index < 5000; index += 1)
          chunks.push(textChunk(text));
        state.backpressureBytes = text.length * 5000;
        chunks.push(finishChunk("stop", 100, 5000));
        return sseResponse(chunks);
      }
      return sseResponse([
        roleChunk(),
        reasoningChunk("reasoned"),
        textChunk("ACP_OK"),
        finishChunk("stop", 4, 2),
      ]);
    },
  });
  return {
    state,
    url: `http://127.0.0.1:${server.port}/v1`,
    stop(force) {
      return server.stop(force);
    },
    waitForMarker(marker) {
      if (state.markers.has(marker)) return Promise.resolve();
      return withTimeout(
        new Promise((resolve) => {
          state.markerWaiters.set(marker, resolve);
        }),
        REQUEST_TIMEOUT_MS,
        `provider marker ${marker}`,
      );
    },
  };
}

function resolveMarkers(serialized, state) {
  for (const marker of [
    "CANCEL_ACTIVE",
    "LOSS_AFTER_EFFECTS",
    "UNEXPECTED_EOF",
  ]) {
    if (!serialized.includes(marker)) continue;
    state.markers.add(marker);
    const waiter = state.markerWaiters.get(marker);
    if (waiter) waiter();
    state.markerWaiters.delete(marker);
  }
}

function hasToolResult(body) {
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some((message) => message?.role === "tool");
}

function providerConfig() {
  return {
    formatter: false,
    lsp: false,
    model: "test/test-model",
    permission: { bash: "ask" },
    provider: {
      test: {
        name: "Secant qualification provider",
        id: "test",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          "test-model": modelConfig("test-model", "Test Model", [
            "low",
            "high",
          ]),
          "second-model": modelConfig("second-model", "Second Model", [
            "medium",
            "max",
          ]),
        },
        options: { apiKey: "test-key", baseURL: provider.url },
      },
    },
  };
}

function modelConfig(id, name, variants) {
  const variantConfig = {};
  for (const variant of variants) variantConfig[variant] = {};
  return {
    id,
    name,
    attachment: false,
    reasoning: true,
    temperature: false,
    tool_call: true,
    release_date: "2026-01-01",
    limit: { context: 100_000, output: 10_000 },
    cost: { input: 0, output: 0 },
    options: {},
    variants: variantConfig,
  };
}

async function startClient(options = {}) {
  const environment = Object.assign({}, process.env, isolatedEnvironment());
  const child = Bun.spawn([binaryPath, "acp", "--cwd", workspace, "--pure"], {
    cwd: workspace,
    env: environment,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const client = createAcpClient(child, options.onPermission);
  activeClients.add(client);
  return client;
}

function isolatedEnvironment() {
  return {
    OPENCODE_TEST_HOME: home,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(providerConfig()),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
  };
}

function createAcpClient(child, onPermission) {
  let nextId = 1;
  let sequence = 0;
  let closed = false;
  let stderr = "";
  const pending = new Map();
  const responseSequences = new Map();
  const duplicateResponses = new Map();
  const notifications = [];
  const malformedStdout = [];

  const stdoutPump = pumpLines(child.stdout, (line) => {
    sequence += 1;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      malformedStdout.push(line);
      return;
    }
    if (message.method && message.id !== undefined) {
      handleServerRequest(message);
      return;
    }
    if (message.method) {
      message.sequence = sequence;
      notifications.push(message);
      return;
    }
    if (message.id === undefined) return;
    responseSequences.set(message.id, sequence);
    const duplicates = duplicateResponses.get(message.id);
    if (duplicates) duplicates.push(message);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    request.resolve(message);
  }).finally(() => rejectPending("ACP stdout ended before response"));
  const stderrPump = new Response(child.stderr).text().then((value) => {
    stderr = value;
  });

  async function handleServerRequest(message) {
    if (message.method !== "session/request_permission") {
      sendObject({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Unsupported client method" },
      });
      return;
    }
    try {
      const outcome = onPermission
        ? await onPermission(message)
        : { outcome: { outcome: "selected", optionId: "reject" } };
      sendObject({ jsonrpc: "2.0", id: message.id, result: outcome });
    } catch (error) {
      sendObject({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: bounded(String(error)) },
      });
    }
  }

  function sendObject(message) {
    sendRaw(`${JSON.stringify(message)}\n`);
  }

  function sendRaw(bytes) {
    if (closed) throw new Error("Cannot write after stdin close");
    child.stdin.write(bytes);
  }

  function request(method, params) {
    const id = nextId;
    nextId += 1;
    const deferred = createDeferred();
    pending.set(id, deferred);
    sendObject({ jsonrpc: "2.0", id, method, params });
    return withTimeout(deferred.promise, REQUEST_TIMEOUT_MS, method).finally(
      () => pending.delete(id),
    );
  }

  function notify(method, params) {
    sendObject({ jsonrpc: "2.0", method, params });
  }

  async function closeGracefully() {
    if (!closed) {
      closed = true;
      child.stdin.end();
    }
    const exitCode = await withTimeout(
      child.exited,
      EXIT_TIMEOUT_MS,
      "ACP stdin EOF exit",
    );
    await Promise.all([stdoutPump, stderrPump]);
    activeClients.delete(client);
    return exitCode;
  }

  async function kill() {
    if (closed) return child.exited;
    closed = true;
    child.kill();
    activeClients.delete(client);
    return withTimeout(child.exited, EXIT_TIMEOUT_MS, "forced ACP exit");
  }

  async function sendDuplicateRequests(method, params) {
    const id = 9001;
    const responses = [];
    duplicateResponses.set(id, responses);
    sendObject({ jsonrpc: "2.0", id, method, params });
    sendObject({ jsonrpc: "2.0", id, method, params });
    await waitFor(
      () => responses.length === 2,
      "duplicate-id responses did not arrive",
    );
    duplicateResponses.delete(id);
    return { responses: responses.length };
  }

  function rejectPending(message) {
    for (const deferred of pending.values())
      deferred.reject(new Error(message));
    pending.clear();
  }

  const client = {
    request,
    notify,
    sendObject,
    sendRaw,
    closeGracefully,
    kill,
    sendDuplicateRequests,
    notifications,
    malformedStdout,
    get stderr() {
      return stderr;
    },
    get sequence() {
      return sequence;
    },
    sequenceOfResponse(id) {
      return responseSequences.get(id) ?? Number.MAX_SAFE_INTEGER;
    },
    lastNotificationSequence(method) {
      return (
        notifications.filter((item) => item.method === method).at(-1)
          ?.sequence ?? -1
      );
    },
  };
  return client;
}

async function initialize(client, protocolVersion) {
  return client.request("initialize", {
    protocolVersion,
    clientCapabilities: { _meta: { "terminal-auth": true } },
    clientInfo: { name: "secant-opencode-qualification", version: "1" },
  });
}

function newSession(client, cwd) {
  return client.request("session/new", { cwd, mcpServers: [] });
}

function sessionParams(sessionId, cwd) {
  return { sessionId, cwd, mcpServers: [] };
}

function promptParams(sessionId, text) {
  return { sessionId, prompt: [{ type: "text", text }] };
}

function isMessageUpdate(item) {
  const kind = item.params?.update?.sessionUpdate;
  return kind === "user_message_chunk" || kind === "agent_message_chunk";
}

function findSelectOption(options, id) {
  const option = options?.find(
    (item) => item.id === id && item.type === "select",
  );
  const advertised =
    options?.map((item) => `${item.id}:${item.type}`).join(", ") ?? "none";
  assert(
    option,
    `select option ${id} was not advertised (advertised: ${advertised})`,
  );
  return option;
}

function flattenOptions(option) {
  return option.options.flatMap((item) =>
    "value" in item ? [item] : item.options,
  );
}

function roleChunk() {
  return completionChunk({ role: "assistant" });
}

function textChunk(content) {
  return completionChunk({ content });
}

function reasoningChunk(reasoningContent) {
  return completionChunk({ reasoning_content: reasoningContent });
}

function toolChunk(id, name, input) {
  return completionChunk({
    tool_calls: [
      {
        index: 0,
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(input) },
      },
    ],
  });
}

function finishChunk(finishReason, promptTokens, completionTokens) {
  return {
    id: "chatcmpl-secant",
    object: "chat.completion.chunk",
    choices: [{ delta: {}, finish_reason: finishReason }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function completionChunk(delta) {
  return {
    id: "chatcmpl-secant",
    object: "chat.completion.chunk",
    choices: [{ delta }],
  };
}

function sseResponse(chunks) {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function hangingSseResponse(chunks, signal) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      signal.addEventListener("abort", () => controller.close(), {
        once: true,
      });
    },
    cancel() {},
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function pumpLines(stream, onLine) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n");
      const line = buffered.slice(0, index).replace(/\r$/, "");
      buffered = buffered.slice(index + 1);
      if (line.length > 0) onLine(line);
    }
  }
  buffered += decoder.decode();
  if (buffered.length > 0) onLine(buffered);
}

async function runCommand(command) {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function runGroup(number, name, operation) {
  const startedAt = Date.now();
  try {
    const details = await operation();
    groupResults.push({
      number,
      name,
      classification: "pass",
      durationMs: Date.now() - startedAt,
      details,
    });
    console.error(`GROUP ${number}: PASS - ${name}`);
  } catch (error) {
    const message = bounded(
      error instanceof Error ? error.message : String(error),
    );
    const classification = message.startsWith("UNKNOWN:") ? "unknown" : "fail";
    groupResults.push({
      number,
      name,
      classification,
      durationMs: Date.now() - startedAt,
      details: { message },
    });
    console.error(
      `GROUP ${number}: ${classification.toUpperCase()} - ${name}: ${message}`,
    );
  } finally {
    await Promise.all([...activeClients].map((client) => client.kill()));
    activeClients.clear();
  }
}

function recordEvidence(kind, details) {
  evidence.push({ kind, details });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function waitFor(predicate, message) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > REQUEST_TIMEOUT_MS) throw new Error(message);
    await Bun.sleep(10);
  }
}

async function settleRequest(promise) {
  try {
    const value = await withTimeout(
      promise,
      REQUEST_TIMEOUT_MS,
      "pending request settlement",
    );
    return { kind: "resolved", value };
  } catch (error) {
    return { kind: "rejected", message: bounded(String(error)) };
  }
}

function bounded(value) {
  return value.length <= 600 ? value : `${value.slice(0, 600)}…`;
}
