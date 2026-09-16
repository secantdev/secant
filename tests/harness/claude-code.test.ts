// The Claude Code Adapter (#111): discovery, non-conversational qualification,
// the evidence-bearing profile, and the qualification cache. The shared
// prepare/profile conformance cases run against it over the real replayer,
// which keeps the fake honest; the cases below cover the Claude-Code-specific
// facts the shared suite does not — discovery order and refusals, the M3 profile
// facts and posture, that no forbidden flag or stdin content is ever built, and
// cache reuse versus requalification on drift.

import assert from "node:assert/strict";
import { chmodSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  createClaudeCodeAdapter,
  type HarnessRequest,
  type HarnessTurn,
  type TurnAdmission,
  type TurnEvent,
  type TurnRequest,
} from "../../src/harness/harness.js";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  runApprovalRequestCases,
  runPrepareProfileCases,
  runTurnLifecycleCases,
  type ApprovalRequestScenarios,
  type PrepareProfileScenarios,
  type TurnLifecycleScenarios,
} from "./conformance.js";
import { installReplayer } from "./replayer.js";

const VERSION = "2.1.234 (Claude Code)";
const COMPLETED_CASE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "protocol-cases",
  "claude-code",
  "completed",
);
const protocolCase = (name: string) =>
  join(
    fileURLToPath(new URL(".", import.meta.url)),
    "protocol-cases",
    "claude-code",
    name,
  );
const FORBIDDEN_FLAGS = [
  "--bare",
  "--strict-mcp-config",
  "--allowedTools",
  "--tools",
  "--model",
  "--permission-mode",
  "--session-id",
  "--resume",
];

// --- Shared conformance cases over the real replayer -------------------------

const conformanceReplayer = installReplayer(VERSION);
const scenarios: PrepareProfileScenarios = {
  label: "claude-code",
  baseline: () => () =>
    createClaudeCodeAdapter({ path: conformanceReplayer.path, env: {} }),
  prepareFailure: () => () =>
    createClaudeCodeAdapter({
      path: makeTempDir("secant-claude-empty-"),
      env: {},
    }),
};
runPrepareProfileCases(scenarios);

const turnScenarios: TurnLifecycleScenarios = {
  ...scenarios,
  baseline: () => {
    const replayer = installReplayer(VERSION, COMPLETED_CASE);
    return () =>
      createClaudeCodeAdapter({
        path: replayer.path,
        env: {},
        sessionId: () => "11111111-1111-4111-8111-111111111111",
      });
  },
  failedTurn: () => {
    const replayer = installReplayer(VERSION, protocolCase("failed"));
    return () =>
      createClaudeCodeAdapter({
        path: replayer.path,
        env: {},
        sessionId: () => "22222222-2222-4222-8222-222222222222",
      });
  },
};
runTurnLifecycleCases(turnScenarios);

// --- Approval requests over the real MCP permission bridge -------------------

const APPROVAL_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONCURRENT_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTSTANDING_SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const claudeApprovalAdapter = (session: string, caseName: string) => {
  const replayer = installReplayer(VERSION, protocolCase(caseName));
  return () =>
    createClaudeCodeAdapter({
      path: replayer.path,
      env: {},
      sessionId: () => session,
    });
};

// The shared concurrent-request, race, and interrupt-expiry cases, driven
// against the Claude Code Adapter over a real loopback MCP round-trip.
const approvalScenarios: ApprovalRequestScenarios = {
  label: "claude-code",
  concurrentCount: 2,
  concurrentRequests: () =>
    claudeApprovalAdapter(CONCURRENT_SESSION, "approval-concurrent"),
  awaitedApproval: () => claudeApprovalAdapter(APPROVAL_SESSION, "approval"),
  interruptible: () =>
    claudeApprovalAdapter(OUTSTANDING_SESSION, "approval-outstanding"),
};
runApprovalRequestCases(approvalScenarios);

/** A managed Turn with a trivial always-admitting recorder. */
function bridgeTurn(session: string): TurnRequest {
  return {
    session,
    origin: "managed",
    correlationKey: { opaque: session },
    input: { text: "do the thing" },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  };
}

/** Collect events and resolve with the first approval request raised. */
function firstRequest(turn: HarnessTurn): {
  events: TurnEvent[];
  raised: Promise<HarnessRequest>;
} {
  const events: TurnEvent[] = [];
  let resolve!: (request: HarnessRequest) => void;
  const raised = new Promise<HarnessRequest>((r) => {
    resolve = r;
  });
  turn.subscribe((event) => {
    events.push(event);
    if (event.kind === "request-raised") resolve(event.request);
  });
  return { events, raised };
}

test("an approved tool use raises the exact prompt and returns the unchanged input", async () => {
  const replayer = installReplayer(VERSION, protocolCase("approval"));
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => APPROVAL_SESSION,
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  const turn = prepared.harness.startTurn(bridgeTurn("approve"));
  const { events, raised } = firstRequest(turn);
  const request = await raised;
  assert.equal(request.shape.kind, "approval");
  if (request.shape.kind !== "approval") throw new Error("unreachable");
  assert.equal(request.shape.tool, "Bash");
  assert.match(request.shape.input, /ls -la/);
  assert.deepEqual(request.shape.decisions, ["allow", "deny"]);

  const receipt = await turn.answerRequest({
    requestId: request.requestId,
    kind: "approval",
    decision: "allow",
  });
  assert.deepEqual(receipt, { outcome: "accepted" });
  const result = await turn.result();
  assert.equal(result.kind, "completed");
  await prepared.harness.close();

  assert.ok(events.some((event) => event.kind === "request-answered"));
  const bridges = replayer.bridges();
  assert.equal(bridges.length, 1);
  assert.equal(bridges[0].behavior, "allow");
  assert.deepEqual(bridges[0].updatedInput, {
    command: "ls -la",
    description: "list files",
  });
});

test("a second named Session raises its own approval on the shared bridge", async () => {
  // One prepared Harness, two named Sessions: the first Claude process stays
  // alive (retained idle) while the second launches against the same bridge, so
  // the bridge must host two live MCP sessions, not latch onto the first.
  const replayer = installReplayer(VERSION, protocolCase("approval"));
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => APPROVAL_SESSION,
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  const runSession = async (name: string) => {
    const turn = prepared.harness.startTurn(bridgeTurn(name));
    const { raised } = firstRequest(turn);
    const request = await raised;
    await turn.answerRequest({
      requestId: request.requestId,
      kind: "approval",
      decision: "allow",
    });
    assert.equal((await turn.result()).kind, "completed");
  };

  await runSession("session-a");
  await runSession("session-b");
  await prepared.harness.close();

  const bridges = replayer.bridges();
  assert.equal(
    bridges.length,
    2,
    "both Sessions completed a bridge round-trip",
  );
  assert.ok(bridges.every((entry) => entry.behavior === "allow"));
});

test("a denied tool use returns the deny shape with a message", async () => {
  const replayer = installReplayer(VERSION, protocolCase("approval"));
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => APPROVAL_SESSION,
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  const turn = prepared.harness.startTurn(bridgeTurn("deny"));
  const { raised } = firstRequest(turn);
  const request = await raised;
  const receipt = await turn.answerRequest({
    requestId: request.requestId,
    kind: "approval",
    decision: "deny",
  });
  assert.deepEqual(receipt, { outcome: "accepted" });
  assert.equal((await turn.result()).kind, "completed");
  await prepared.harness.close();

  const [bridge] = replayer.bridges();
  assert.equal(bridge.behavior, "deny");
  assert.ok(typeof bridge.message === "string" && bridge.message.length > 0);
  assert.notEqual(bridge.message, "request expired");
});

test("closing while a permission request is outstanding denies the bridge caller 'request expired'", async () => {
  const replayer = installReplayer(
    VERSION,
    protocolCase("approval-outstanding"),
  );
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => OUTSTANDING_SESSION,
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  const turn = prepared.harness.startTurn(bridgeTurn("closing"));
  const { events, raised } = firstRequest(turn);
  await raised;

  const cleanup = await prepared.harness.close();
  await turn.result();

  assert.equal(cleanup.clean, true);
  assert.ok(
    events.some((event) => event.kind === "request-expired"),
    "the outstanding request expired before the result",
  );
  const [bridge] = replayer.bridges();
  assert.equal(bridge.behavior, "deny");
  assert.equal(bridge.message, "request expired");
});

test("the bearer token never appears in the Turn's events or result", async () => {
  const replayer = installReplayer(VERSION, protocolCase("approval"));
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => APPROVAL_SESSION,
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  const turn = prepared.harness.startTurn(bridgeTurn("approve"));
  const { events, raised } = firstRequest(turn);
  const request = await raised;
  await turn.answerRequest({
    requestId: request.requestId,
    kind: "approval",
    decision: "allow",
  });
  const result = await turn.result();
  await prepared.harness.close();

  // The token exists only in the launch argv; recover it there as ground truth,
  // then prove it appears nowhere a caller can observe.
  const invocation = replayer
    .invocations()
    .find((entry) => entry.args.includes("--mcp-config"));
  assert.ok(invocation);
  const config = JSON.parse(
    invocation.args[invocation.args.indexOf("--mcp-config") + 1],
  );
  const token = config.mcpServers[
    "secant-permissions"
  ].headers.Authorization.replace("Bearer ", "");
  assert.ok(token.length >= 32);
  assert.equal(JSON.stringify(events).includes(token), false);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test(
  "a spawn failure redacts the bearer token from the typed failure",
  { skip: process.platform === "win32" },
  async () => {
    const replayer = installReplayer(VERSION, protocolCase("approval"));
    const prepared = await createClaudeCodeAdapter({
      path: replayer.path,
      env: {},
      sessionId: () => APPROVAL_SESSION,
    }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) throw new Error("unreachable");

    // Make the qualified executable unspawnable after prepare (the cache holds,
    // since mode changes leave size and mtime intact). The launch spawn then
    // errors EACCES, and Node's error carries the full argv — bearer token and
    // all — as `spawnargs`.
    chmodSync(replayer.executablePath, 0o000);
    const turn = prepared.harness.startTurn(bridgeTurn("approve"));
    const result = await turn.result();
    await prepared.harness.close();

    assert.equal(result.kind, "not-started");
    // The launch argv rode into the failure cause, but not the token.
    assert.doesNotMatch(JSON.stringify(result), /Bearer [0-9a-f]{32,}/);
  },
);

test("one stream-json Turn yields normalized events and an authoritative completed result", async () => {
  const replayer = installReplayer(VERSION, COMPLETED_CASE);
  const workspace = makeTempDir("secant-claude-workspace-");
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => "11111111-1111-4111-8111-111111111111",
  }).prepare({ workspace });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  const admissions: TurnAdmission[] = [];
  const turn = prepared.harness.startTurn({
    session: "repair",
    origin: "managed",
    correlationKey: { opaque: "turn-1" },
    input: { text: "Repair the failing test." },
    recorder: {
      admit(admission) {
        admissions.push(admission);
        return Promise.resolve({ recorded: true });
      },
      checkpoint() {
        return Promise.resolve({ recorded: true });
      },
    },
  });
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  const result = await turn.result();

  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("unreachable");
  assert.equal(result.detail.finalContent, "hello");
  assert.deepEqual(result.detail.effectiveModel, {
    known: true,
    model: "claude-sonnet-4-5",
  });
  assert.deepEqual(result.detail.usage, {
    estimate: true,
    summary: "input 10, output 2 tokens; cost estimate USD 0.001",
  });
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "session",
      "model",
      "activity",
      "preview",
      "preview",
      "assistant-content",
      "tool-activity",
      "tool-activity",
      "activity",
      "usage",
    ],
  );
  assert.deepEqual(
    events.flatMap((event) => (event.kind === "preview" ? [event.text] : [])),
    ["hel", "hello"],
    "each preview replaces the prior value with accumulated text",
  );
  const sessionEvent = events.find((event) => event.kind === "session");
  assert.equal(sessionEvent?.kind, "session");
  if (sessionEvent?.kind !== "session") throw new Error("unreachable");
  assert.equal(sessionEvent.facts?.executableVersion, "2.1.234");
  assert.deepEqual(sessionEvent.facts?.tools, ["Read", "Edit"]);
  assert.deepEqual(sessionEvent.facts?.mcp, [
    { name: "secant", status: "connected" },
  ]);
  const assistant = events.find((event) => event.kind === "assistant-content");
  assert.equal(
    assistant?.kind === "assistant-content"
      ? assistant.parentActivity
      : undefined,
    "toolu_parent",
  );
  const tools = events.filter((event) => event.kind === "tool-activity");
  assert.deepEqual(
    tools.map((event) =>
      event.kind === "tool-activity"
        ? [event.activity.phase, event.activity.parentActivity]
        : [],
    ),
    [
      ["started", "toolu_parent"],
      ["completed", "toolu_parent"],
    ],
  );
  assert.equal(
    JSON.stringify(events).includes("private chain of thought"),
    false,
  );
  assert.equal(
    JSON.stringify(events).includes("must-not-cross-the-seam"),
    false,
  );
  assert.equal(
    events.some(
      (event) =>
        event.kind === "activity" && event.description.includes("stderr"),
    ),
    false,
  );
  assert.equal(admissions.length, 1);
  assert.deepEqual(admissions[0].input, {
    text: "Repair the failing test.",
  });
  assert.equal(
    admissions[0].recoveryCoordinate.opaque,
    "11111111-1111-4111-8111-111111111111",
  );

  const cleanup = await prepared.harness.close();
  assert.equal(
    cleanup.clean,
    true,
    "post-result diagnostics must not terminate a completed Session",
  );
  const turnInvocation = replayer
    .invocations()
    .find((invocation) => invocation.args.includes("-p"));
  assert.ok(turnInvocation);
  assert.equal(realpathSync(turnInvocation.cwd), realpathSync(workspace));
  const printFlag = turnInvocation.args.indexOf("-p");
  assert.deepEqual(turnInvocation.args.slice(printFlag, printFlag + 7), [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ]);
  const sessionFlag = turnInvocation.args.indexOf("--session-id");
  assert.equal(
    turnInvocation.args[sessionFlag + 1],
    admissions[0].recoveryCoordinate.opaque,
  );
  assert.equal(turnInvocation.stdinLines.length, 1);
  assert.deepEqual(JSON.parse(turnInvocation.stdinLines[0]), {
    type: "user",
    message: { role: "user", content: "Repair the failing test." },
    parent_tool_use_id: null,
  });
});

test("two large Turns reuse one live Session process and preserve intact stdin frames", async () => {
  const replayer = installReplayer(VERSION, protocolCase("two-turns"));
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => "33333333-3333-4333-8333-333333333333",
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  const firstText = `first-${"a".repeat(256 * 1024)}`;
  const secondText = `second-${"b".repeat(256 * 1024)}`;
  const recorder = {
    admit: () => Promise.resolve({ recorded: true } as const),
    checkpoint: () => Promise.resolve({ recorded: true } as const),
  };
  const first = prepared.harness.startTurn({
    session: "shared",
    origin: "managed",
    correlationKey: { opaque: "first" },
    input: { text: firstText },
    recorder,
  });
  assert.equal((await first.result()).kind, "completed");

  const second = prepared.harness.startTurn({
    session: "shared",
    origin: "managed",
    correlationKey: { opaque: "second" },
    input: { text: secondText },
    recorder,
  });
  const secondResult = await second.result();
  assert.equal(secondResult.kind, "failed");
  if (secondResult.kind !== "failed") throw new Error("unreachable");
  assert.equal(secondResult.detail.failure.category, "error_max_budget_usd");

  const once = await prepared.harness.close();
  const twice = await prepared.harness.close();
  assert.equal(once, twice);
  assert.equal(once.clean, true);
  assert.equal(once.sessions?.[0]?.availability.state, "detached");

  const turnInvocations = replayer
    .invocations()
    .filter((invocation) => invocation.args.includes("-p"));
  assert.equal(turnInvocations.length, 1, "the live process was reused");
  const [invocation] = turnInvocations;
  assert.equal(invocation.stdinLines.length, 2);
  const firstFrame = JSON.parse(invocation.stdinLines[0]);
  const secondFrame = JSON.parse(invocation.stdinLines[1]);
  assert.equal(firstFrame.message.content, firstText);
  assert.equal(secondFrame.message.content, secondText);
});

test("a recorder refusal proves not-started before any stdin byte is written", async () => {
  const replayer = installReplayer(VERSION, COMPLETED_CASE);
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => "11111111-1111-4111-8111-111111111111",
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  const turn = prepared.harness.startTurn({
    session: "refused",
    origin: "human",
    correlationKey: { opaque: "refused" },
    input: { text: "do not send" },
    recorder: {
      admit: () =>
        Promise.resolve({ recorded: false, reason: "run.db unavailable" }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  });
  const result = await turn.result();
  assert.equal(result.kind, "not-started");
  await prepared.harness.close();

  const turnInvocation = replayer
    .invocations()
    .find((invocation) => invocation.args.includes("-p"));
  assert.equal(
    turnInvocation,
    undefined,
    "durable refusal happens before a process is needed",
  );
});

test("close cannot report success before a queued Turn is prevented from launching", async () => {
  const replayer = installReplayer(VERSION, COMPLETED_CASE);
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => "11111111-1111-4111-8111-111111111111",
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  const turn = prepared.harness.startTurn({
    session: "closing",
    origin: "managed",
    correlationKey: { opaque: "closing" },
    input: { text: "must not launch" },
    recorder: {
      admit: () =>
        Promise.resolve({ recorded: false, reason: "harness closing" }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  });

  const cleanup = await prepared.harness.close();
  assert.equal(cleanup.clean, true);
  assert.equal((await turn.result()).kind, "not-started");
  assert.equal(
    replayer
      .invocations()
      .filter((invocation) => invocation.args.includes("-p")).length,
    0,
    "no process may launch after close has settled",
  );
});

test("a process that never emits init settles not-started at the handshake timeout", async () => {
  const replayer = installReplayer(VERSION, protocolCase("no-init"));
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => "44444444-4444-4444-8444-444444444444",
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  const turn = prepared.harness.startTurn({
    session: "no-init",
    origin: "managed",
    correlationKey: { opaque: "no-init" },
    input: { text: "hello" },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  });
  const result = await turn.result();
  assert.equal(result.kind, "not-started");
  if (result.kind !== "not-started") throw new Error("unreachable");
  assert.equal(result.detail.failure.category, "init-timeout");
  await prepared.harness.close();
});

test("a launch that cannot reach init settles not-started", async () => {
  const replayer = installReplayer(VERSION, COMPLETED_CASE);
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => "11111111-1111-4111-8111-111111111111",
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  unlinkSync(replayer.identityPath);
  const turn = prepared.harness.startTurn({
    session: "missing-after-prepare",
    origin: "managed",
    correlationKey: { opaque: "missing-after-prepare" },
    input: { text: "hello" },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  });

  const result = await turn.result();
  assert.equal(result.kind, "not-started");
  if (result.kind !== "not-started") throw new Error("unreachable");
  assert.equal(result.detail.failure.possibleEffects, "none");
  await prepared.harness.close();
});

// --- Discovery ---------------------------------------------------------------

test("the configured env var is used first and reported in the profile", async () => {
  const replayer = installReplayer(VERSION);
  const adapter = createClaudeCodeAdapter({
    // Real PATH only (no replayer `claude` on it), so the interpreter still
    // resolves on Windows and the env var is provably what discovery uses.
    path: process.env.PATH ?? "",
    env: { [CLAUDE_CODE_EXECUTABLE_ENV]: replayer.executablePath },
  });
  const result = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.match(result.harness.profile.executable, /configured command/);
  assert.equal(result.harness.profile.executableVersion, VERSION);
});

test("the caller's configuredExecutable option is honoured", async () => {
  const replayer = installReplayer(VERSION);
  const adapter = createClaudeCodeAdapter({
    path: process.env.PATH ?? "",
    env: {},
  });
  const result = await adapter.prepare({
    workspace: process.cwd(),
    configuredExecutable: replayer.executablePath,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.match(result.harness.profile.executable, /configured command/);
});

test("a configured command wins over a `claude` found on PATH", async () => {
  const onPath = installReplayer("1.0.0 (Claude Code)");
  const configured = installReplayer("2.0.0 (Claude Code)");
  const adapter = createClaudeCodeAdapter({
    path: onPath.path,
    env: { [CLAUDE_CODE_EXECUTABLE_ENV]: configured.executablePath },
  });
  const result = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.harness.profile.executableVersion, "2.0.0 (Claude Code)");
});

test("with neither configured nor on PATH, prepare fails not-found naming both", async () => {
  const adapter = createClaudeCodeAdapter({
    path: makeTempDir("secant-claude-empty-"),
    env: { [CLAUDE_CODE_EXECUTABLE_ENV]: "definitely-not-a-real-command-xyz" },
  });
  const result = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.phase, "prepare");
  assert.equal(result.failure.category, "not-found");
  assert.match(
    result.failure.diagnostics ?? "",
    /definitely-not-a-real-command-xyz/,
  );
  assert.match(result.failure.diagnostics ?? "", /PATH name 'claude'/);
});

test("a Windows shim the resolver cannot parse is an unsupported-shim failure", async () => {
  // Driven cross-OS through the injected platform and resolver, exactly as the
  // process Module drives its own shim tests.
  const dir = makeTempDir("secant-claude-bat-");
  const batPath = join(dir, "claude.bat");
  writeFileSync(batPath, "@echo off\r\necho not a node shim\r\n");
  const adapter = createClaudeCodeAdapter({
    platform: "win32",
    resolve: (name) => (name === "claude" ? batPath : undefined),
    env: {},
  });
  const result = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.failure.category, "unsupported-shim");
  assert.match(
    result.failure.diagnostics ?? "",
    new RegExp(batPath.replace(/\\/g, "\\\\")),
  );
});

// --- The M3 profile ----------------------------------------------------------

test("the profile carries every M3 fact with its evidence and a user-compatible posture", async () => {
  const replayer = installReplayer(VERSION);
  const adapter = createClaudeCodeAdapter({ path: replayer.path, env: {} });
  const result = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const { profile } = result.harness;

  assert.equal(profile.harness, "claude-code");
  assert.equal(profile.executableVersion, VERSION);
  assert.equal(profile.adapterRevision, "claude-code-1");
  assert.equal(
    profile.platform,
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : "linux",
  );
  // shim-vs-native matches the observed executable.
  assert.match(
    profile.executable,
    process.platform === "win32" ? /npm shim/ : /native/,
  );

  assert.equal(profile.recovery.mode, "native-reattach");
  assert.equal(profile.interruption.mode, "process-only");
  assert.equal(profile.approvals.available, true);
  assert.equal(profile.clarifications.available, false);
  assert.equal(profile.modelSelection.at, "unavailable");
  assert.equal(profile.recoveryCoordinate.timing, "before-submission");
  assert.equal(profile.skillDelivery.mode, "plain-path");
  assert.equal(profile.fileDelivery.mode, "plain-path");

  for (const capability of [
    profile.recovery,
    profile.interruption,
    profile.approvals,
    profile.clarifications,
    profile.modelSelection,
    profile.recoveryCoordinate,
    profile.skillDelivery,
    profile.fileDelivery,
  ]) {
    assert.ok(capability.evidence.length > 0);
  }

  assert.match(profile.configurationPosture, /user-compatible/);
  for (const flag of ["--bare", "--allowedTools", "--tools", "--model"]) {
    assert.match(profile.configurationPosture, new RegExp(flag));
  }
});

test("prepare builds only `--version`, no forbidden flag, and writes nothing to stdin", async () => {
  const replayer = installReplayer(VERSION);
  const adapter = createClaudeCodeAdapter({ path: replayer.path, env: {} });
  const result = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(result.ok, true);

  const invocations = replayer.invocations();
  assert.equal(invocations.length, 1);
  const [invocation] = invocations;
  assert.deepEqual(invocation.args, ["--version"]);
  assert.equal(invocation.stdinBytes, 0);
  for (const flag of FORBIDDEN_FLAGS) {
    assert.ok(!invocation.args.includes(flag), `argv must not include ${flag}`);
  }
});

// --- Qualification cache -----------------------------------------------------

test("a second prepare reuses the cache; drift requalifies", async () => {
  const replayer = installReplayer(VERSION);
  const adapter = createClaudeCodeAdapter({ path: replayer.path, env: {} });

  const first = await adapter.prepare({ workspace: process.cwd() });
  const second = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(first.ok && second.ok, true);
  if (!first.ok || !second.ok) throw new Error("unreachable");
  // Same path, version, and file identity: the probe ran once and was reused.
  assert.equal(replayer.invocations().length, 1);
  assert.equal(second.harness.profile.executableVersion, VERSION);

  replayer.drift("9.9.9 (Claude Code)");
  const third = await adapter.prepare({ workspace: process.cwd() });
  assert.equal(third.ok, true);
  if (!third.ok) throw new Error("unreachable");
  // The file identity drifted: the Adapter requalified.
  assert.equal(replayer.invocations().length, 2);
  assert.equal(third.harness.profile.executableVersion, "9.9.9 (Claude Code)");
});

// --- Version-probe failure (POSIX; the mapping itself is OS-agnostic) --------

test(
  "a non-zero `--version` exit is a typed version-probe failure",
  { skip: process.platform === "win32" },
  async () => {
    const dir = makeTempDir("secant-claude-broken-");
    const broken = join(dir, "claude");
    writeFileSync(broken, "#!/bin/sh\necho boom 1>&2\nexit 4\n");
    chmodSync(broken, 0o755);
    const adapter = createClaudeCodeAdapter({ path: dir, env: {} });
    const result = await adapter.prepare({ workspace: process.cwd() });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.failure.category, "version-probe");
    assert.equal(result.failure.nativeCode, "4");
  },
);
