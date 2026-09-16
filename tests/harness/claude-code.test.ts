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
  type HarnessAdapterFactory,
  type HarnessRequest,
  type HarnessTurn,
  type TurnAdmission,
  type TurnEvent,
  type TurnRequest,
} from "../../src/harness/harness.js";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  runApprovalRequestCases,
  runInterruptRecoveryCases,
  runPrepareProfileCases,
  runTurnLifecycleCases,
  type ApprovalRequestScenarios,
  type InterruptRecoveryScenarios,
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

// --- Interrupt, lost, recovery, and cleanup over the real replayer -----------

// The shared interrupt, lost, recovery, and cleanup cases over the real replayer.
// A fresh replayer per scenario keeps invocations isolated; each fixed session id
// matches the id its fixture's init acknowledges. The unresponsive-interrupt case
// is POSIX-only: on Windows `taskkill /T /F` always force-kills the tree, so a
// process cannot ignore the graceful signal for the escalation to be observable.
const AUTHENTICATION_REQUIRED =
  "Authentication required for Claude Code. Log in separately through Claude Code, then retry.";
const LEAKED_TOKEN = "sk-ant-oops-secret-token";

const caseScenario =
  (name: string, id: string) => (): HarnessAdapterFactory => {
    const replayer = installReplayer(VERSION, protocolCase(name));
    return () =>
      createClaudeCodeAdapter({
        path: replayer.path,
        env: {},
        sessionId: () => id,
      });
  };

const interruptScenarios: InterruptRecoveryScenarios = {
  ...turnScenarios,
  blockingTurn: caseScenario(
    "blocking",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ),
  unresponsiveInterrupt: caseScenario(
    "unresponsive",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ),
  lostCompletion: caseScenario(
    "lost-completion",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ),
  resumeAcknowledged: caseScenario(
    "resume-acknowledged",
    "55555555-5555-4555-8555-555555555555",
  ),
  resumeUnacknowledged: caseScenario(
    "resume-unacknowledged",
    "66666666-6666-4666-8666-666666666666",
  ),
};
runInterruptRecoveryCases(interruptScenarios, {
  skipUnresponsiveInterrupt: process.platform === "win32",
});

/** Drive one Turn against a protocol case over the real replayer, returning the
 *  events, the result, the prepared Harness (to close), and the replayer. */
async function runProtocolTurn(caseName: string, id: string) {
  const replayer = installReplayer(VERSION, protocolCase(caseName));
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => id,
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");
  const events: TurnEvent[] = [];
  const turn = prepared.harness.startTurn({
    session: caseName,
    origin: "managed",
    correlationKey: { opaque: caseName },
    input: { text: "go" },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  });
  turn.subscribe((event) => events.push(event));
  const result = await turn.result();
  return { harness: prepared.harness, events, result, replayer };
}

test("a not-logged-in result yields the exact authentication failure and leaks no credential", async () => {
  const { harness, result } = await runProtocolTurn(
    "authentication",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  );
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") throw new Error("unreachable");
  assert.equal(result.detail.failure.category, "authentication");
  assert.equal(result.detail.failure.phase, "turn");
  assert.equal(result.detail.failure.diagnostics, AUTHENTICATION_REQUIRED);
  // The raw result quoted a token; nothing but the fixed message crosses the Seam.
  assert.equal(JSON.stringify(result).includes(LEAKED_TOKEN), false);
  await harness.close();
});

test("a malformed JSON-looking line ends the Turn lost with protocol-corruption", async () => {
  const { harness, result } = await runProtocolTurn(
    "protocol-corruption",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  );
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "protocol-corruption");
  await harness.close();
});

test("exit without a result loses the Turn with completion-unknown, the exit code, and the last observation", async () => {
  const { harness, result } = await runProtocolTurn(
    "lost-completion",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  );
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "completion");
  assert.equal(result.detail.failure?.category, "completion-unknown");
  assert.equal(result.detail.failure?.nativeCode, "7");
  // The last authoritative observation before the process closed is preserved.
  assert.match(result.detail.lastObservation, /working on it/);
  await harness.close();
});

test("interrupting a live Turn spawns no resume and settles interrupted with a detached Session", async () => {
  const replayer = installReplayer(VERSION, protocolCase("blocking"));
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");
  const turn = prepared.harness.startTurn({
    session: "blocking",
    origin: "managed",
    correlationKey: { opaque: "blocking" },
    input: { text: "go" },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
  });
  await new Promise<void>((resolve) => {
    const sub = turn.subscribe((event) => {
      if (event.kind === "session") {
        resolve();
        sub.unsubscribe();
      }
    });
  });
  // steer never touches the process: rejected unsupported while the Turn is live.
  assert.deepEqual(await turn.steer({ text: "no" }), {
    outcome: "rejected",
    reason: "unsupported",
  });
  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  const result = await turn.result();
  assert.equal(result.kind, "interrupted");
  if (result.kind !== "interrupted") throw new Error("unreachable");
  assert.equal(result.detail.interruption.mode, "process-only");
  assert.equal(result.detail.session.state, "detached");
  await prepared.harness.close();
  const invocations = replayer.invocations();
  assert.equal(
    invocations.filter((i) => i.args.includes("--resume")).length,
    0,
    "an interrupt spawns no resume process",
  );
  assert.equal(
    invocations.filter((i) => i.args.includes("--session-id")).length,
    1,
  );
});

test("a resumed Turn spawns with --resume and not --session-id", async () => {
  const replayer = installReplayer(
    VERSION,
    protocolCase("resume-acknowledged"),
  );
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => "55555555-5555-4555-8555-555555555555",
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");
  const recorder = {
    admit: () => Promise.resolve({ recorded: true } as const),
    checkpoint: () => Promise.resolve({ recorded: true } as const),
  };
  const turn1 = prepared.harness.startTurn({
    session: "resume",
    origin: "managed",
    correlationKey: { opaque: "t1" },
    input: { text: "go" },
    recorder,
  });
  await new Promise<void>((resolve) => {
    const sub = turn1.subscribe((event) => {
      if (event.kind === "session") {
        resolve();
        sub.unsubscribe();
      }
    });
  });
  await turn1.interrupt();
  const result1 = await turn1.result();
  assert.equal(result1.kind, "interrupted");
  if (result1.kind !== "interrupted") throw new Error("unreachable");
  if (result1.detail.session.state !== "detached")
    throw new Error("unreachable");
  const turn2 = prepared.harness.startTurn({
    session: "resume",
    origin: "managed",
    correlationKey: { opaque: "t2" },
    input: { text: "again" },
    recorder,
    resume: result1.detail.session.coordinate,
  });
  const result2 = await turn2.result();
  assert.equal(result2.kind, "completed");
  await prepared.harness.close();
  const resumeInvocation = replayer
    .invocations()
    .find((i) => i.args.includes("--resume"));
  assert.ok(resumeInvocation, "the second Turn spawned a --resume process");
  assert.equal(resumeInvocation.args.includes("--session-id"), false);
  const flag = resumeInvocation.args.indexOf("--resume");
  assert.equal(
    resumeInvocation.args[flag + 1],
    "55555555-5555-4555-8555-555555555555",
  );
});

test("resuming a coordinate on an untracked Session passes that coordinate, not a fresh mint", async () => {
  // No prior Turn on this Prepared Harness minted the id, so the coordinate must
  // come from the caller's `resume` — a fresh mint would name a Session Claude
  // Code never saw and the acknowledging init would be rejected.
  const replayer = installReplayer(
    VERSION,
    protocolCase("resume-acknowledged"),
  );
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    // A different mint than the coordinate, to prove the mint is not used.
    sessionId: () => "ffffffff-ffff-4fff-8fff-ffffffffffff",
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");
  const coordinate = { opaque: "55555555-5555-4555-8555-555555555555" };
  const turn = prepared.harness.startTurn({
    session: "never-tracked",
    origin: "managed",
    correlationKey: { opaque: "restart" },
    input: { text: "resume me" },
    recorder: {
      admit: () => Promise.resolve({ recorded: true }),
      checkpoint: () => Promise.resolve({ recorded: true }),
    },
    resume: coordinate,
  });
  const result = await turn.result();
  assert.equal(result.kind, "completed");
  await prepared.harness.close();
  const resumeInvocation = replayer
    .invocations()
    .find((i) => i.args.includes("--resume"));
  assert.ok(resumeInvocation);
  const flag = resumeInvocation.args.indexOf("--resume");
  assert.equal(resumeInvocation.args[flag + 1], coordinate.opaque);
  assert.equal(resumeInvocation.args.includes("--session-id"), false);
});

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
