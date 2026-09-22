// The Claude-Code-specific Adapter conformance cases: redaction, lenient frame
// parsing, authentication classification, discovery order and refusals, the M3
// profile facts and posture, launch/resume/--model argv, that no forbidden flag
// or stdin content is ever built, and cache reuse versus requalification on
// drift — the facts the shared conformance suite does not cover.
//
// These moved out of the process-free semantic suite (#198): every case drives
// the real Claude Code Adapter (whose `prepare` spawns a `--version` child) or a
// scripted process a real child cannot be made to emit on demand, so they run in
// the standalone runtime-conformance runner (tests/process/runtime-conformance.ts),
// not under the test runner. This file is not a `.test.ts`: a local `test` shim
// collects each case and `registerClaudeCodeAdapterConformance` forwards them to
// the runner; a `skip` option drops a case on the platform it does not apply to.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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
import type {
  OwnedProcess,
  OwnedProcessClose,
  ProcessInterruption,
  spawnOwnedProcess,
} from "../../src/process/process.js";
import { makeTempDir } from "../helpers/tempDir.js";
import {
  collectAdapterConformanceCases,
  type RegisterConformanceCase,
} from "./conformance.js";
import { installReplayer } from "./replayer.js";

// Each `test(...)` below registers with the runtime-conformance runner instead of
// the test runner; the shared collector carries `node:test`'s `{ skip }` option.
const { test, forward } = collectAdapterConformanceCases();

export function registerClaudeCodeAdapterConformance(
  register: RegisterConformanceCase,
): void {
  forward(register);
}

const VERSION = "2.1.234 (Claude Code)";
// Recorded and synthetic case directories both live under the committed fixtures
// tree (#115); the hand-authored `protocol-cases/` tree it replaced is gone.
const fixtureCase = (name: string) =>
  join(
    fileURLToPath(new URL(".", import.meta.url)),
    "fixtures",
    "claude-code",
    name,
  );
// The rich completed-Turn case stays synthetic: it exercises tool activity,
// thinking/telemetry exclusion, preview coalescing, and unknown-frame tolerance a
// real plain Turn does not. The real plain recording is exercised separately below.
const COMPLETED_CASE = fixtureCase("completed");
const protocolCase = fixtureCase;
// Flags Secant never passes at qualification (`--version`). `--model` is not
// here: a launch forwards a caller-requested model as --model, exercised below.
const FORBIDDEN_FLAGS = [
  "--bare",
  "--strict-mcp-config",
  "--allowedTools",
  "--tools",
  "--permission-mode",
  "--session-id",
  "--resume",
];

// The full launch argv the Adapter builds (`claude-code.ts` `launch`), pinned as
// one golden so adding, dropping or reordering a flag fails a test (A23). The two
// per-Run dynamic slots — the inline `--mcp-config` path and the bridge tool name
// — are read from the captured invocation and plugged in; every fixed flag and
// its order, and the session flag/value, are asserted exactly.
function goldenLaunchArgs(
  sessionFlag: "--session-id" | "--resume",
  sessionValue: string,
  mcpConfig: string,
  toolName: string,
): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    sessionFlag,
    sessionValue,
    "--mcp-config",
    mcpConfig,
    "--permission-prompt-tool",
    toolName,
  ];
}

/** The full launch argv the golden pins, reading the two dynamic slots from the
 *  captured invocation itself. */
function assertGoldenLaunch(
  args: string[],
  sessionFlag: "--session-id" | "--resume",
  sessionValue: string,
): void {
  const mcpConfig = args[args.indexOf("--mcp-config") + 1]!;
  const toolName = args[args.indexOf("--permission-prompt-tool") + 1]!;
  assert.deepEqual(
    args,
    goldenLaunchArgs(sessionFlag, sessionValue, mcpConfig, toolName),
  );
}

// The shared prepare/profile, Turn-lifecycle, approval, and interrupt/recovery
// conformance cases over the real replayer moved out of the Bun test runner into
// the standalone runtime-conformance runner (#184): see
// tests/harness/replayer-conformance.ts (`claude-code-replayer-conformance`). The
// Claude-Code-specific cases below stay here. The fixed session ids match the ids
// their fixtures' init frames acknowledge.

// --- Approval requests over the real MCP permission bridge -------------------

const APPROVAL_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTSTANDING_SESSION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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

// The shared interrupt, lost, recovery, and cleanup cases over the real replayer
// moved to the standalone runtime-conformance runner (#184); see
// tests/harness/replayer-conformance.ts. The Claude-Code-specific interrupt,
// recovery, and failure cases below stay here.
const AUTHENTICATION_REQUIRED =
  "Authentication required for Claude Code. Log in separately through Claude Code, then retry.";

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
  // The recorded signal (#115): a not-logged-in run returns `subtype:"success"`
  // with `result:"Not logged in · Please run /login"`, so the Adapter classifies
  // it as an authentication failure before the success branch.
  const { harness, result } = await runProtocolTurn(
    "authentication",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  );
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") throw new Error("unreachable");
  assert.equal(result.detail.failure.category, "authentication");
  assert.equal(result.detail.failure.phase, "turn");
  assert.equal(result.detail.failure.diagnostics, AUTHENTICATION_REQUIRED);
  // The raw remediation never crosses the Seam — only the fixed message does.
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("Not logged in"), false);
  assert.equal(serialized.includes("/login"), false);
  await harness.close();
});

test("a success result that quotes a login phrase but is not an error stays completed", async () => {
  // The auth check runs before the success branch, so it must not swallow a real
  // answer whose text merely quotes "please run /login": that result settles with
  // is_error:false, so it stays completed, not authentication-failed. Only a
  // success result flagged is_error:true is the real not-logged-in signal.
  const { harness, result } = await runProtocolTurn(
    "completed-quotes-login",
    "88888888-8888-4888-8888-888888888888",
  );
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("unreachable");
  assert.match(result.detail.finalContent ?? "", /please run \/login/);
  await harness.close();
});

test("a truncated JSON frame ends the Turn lost with protocol-corruption", async () => {
  // The recorded corruption case (#115): a real stream whose trailing frame was
  // left incomplete by a mid-write kill — the Adapter's end-of-stream check treats
  // the truncated frame as protocol corruption.
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

// --- Lenient frame parsing and redaction below launch (scripted process) -----

// A scripted stand-in for the process Module's owned child, injected through the
// Adapter's `spawn` seam. It hands the Adapter frames a real child cannot be made
// to emit on demand (a malformed known frame) and close observations it cannot be
// made to produce (a cleanup error quoting the launch argv). `token()` recovers
// the bridge bearer from the launch argv the Adapter passed, so a scripted cause
// can quote exactly the secret the Seam must scrub.
interface ScriptedProcess {
  readonly spawn: typeof spawnOwnedProcess;
  /** End stdout and settle `closed()` with the scripted close observation. */
  end(): void;
  /** The bearer recovered from the launch argv the Adapter passed. */
  token(): string;
}

function scriptedProcess(script: {
  readonly frames: readonly unknown[];
  readonly lineEnding?: "\n" | "\r\n";
  readonly splitUtf8Scalars?: boolean;
  readonly close?: (token: string) => OwnedProcessClose;
  readonly interrupt?: (token: string) => ProcessInterruption;
  readonly closeStdin?: (token: string) => OwnedProcessClose;
}): ScriptedProcess {
  let launchArgs: readonly string[] = [];
  const token = (): string => {
    const config = JSON.parse(
      launchArgs[launchArgs.indexOf("--mcp-config") + 1]!,
    );
    return config.mcpServers[
      "secant-permissions"
    ].headers.Authorization.replace("Bearer ", "");
  };
  let resolveClose!: (close: OwnedProcessClose) => void;
  const closed = new Promise<OwnedProcessClose>((resolve) => {
    resolveClose = resolve;
  });
  let endStdout!: () => void;
  const stdoutEnded = new Promise<void>((resolve) => {
    endStdout = resolve;
  });
  async function* stdout(): AsyncGenerator<Uint8Array> {
    for (const frame of script.frames) {
      const bytes = new TextEncoder().encode(
        `${JSON.stringify(frame)}${script.lineEnding ?? "\n"}`,
      );
      const scalarStart = bytes.indexOf(0xe2);
      if (script.splitUtf8Scalars === true && scalarStart >= 0) {
        yield bytes.subarray(0, scalarStart + 1);
        yield bytes.subarray(scalarStart + 1);
      } else {
        yield bytes;
      }
    }
    await stdoutEnded;
  }
  // eslint-disable-next-line require-yield
  async function* stderr(): AsyncGenerator<Uint8Array> {
    await stdoutEnded;
  }
  const settle = (close: OwnedProcessClose): OwnedProcessClose => {
    endStdout();
    resolveClose(close);
    return close;
  };
  const exit0: OwnedProcessClose = { kind: "exited", status: 0 };
  const owned: OwnedProcess = {
    stdout: stdout(),
    stderr: stderr(),
    writeStdin: () => Promise.resolve(),
    closeStdin: () =>
      Promise.resolve(settle(script.closeStdin?.(token()) ?? exit0)),
    interrupt: () => {
      const interruption = script.interrupt?.(token()) ?? {
        close: { kind: "exited", status: 143 },
        escalated: false,
      };
      settle(interruption.close);
      return Promise.resolve(interruption);
    },
    closed: () => closed,
  };
  return {
    spawn: (options) => {
      launchArgs = options.args;
      return Promise.resolve({ ok: true, process: owned });
    },
    end: () => {
      settle(script.close?.(token()) ?? exit0);
    },
    token,
  };
}

const SCRIPTED_SESSION = "99999999-9999-4999-8999-999999999999";
const scriptedInit = {
  type: "system",
  subtype: "init",
  session_id: SCRIPTED_SESSION,
  model: "scripted-model",
  tools: ["Read"],
  mcp_servers: [],
  claude_code_version: "0.0.0-scripted",
};

/** Prepare the Adapter over the replayer for qualification but launch the
 *  Session on the scripted process; resolve once the Turn is live (init seen). */
async function scriptedTurn(scripted: ScriptedProcess) {
  const replayer = installReplayer(VERSION, protocolCase("completed"));
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => SCRIPTED_SESSION,
    spawn: scripted.spawn,
  }).prepare({ workspace: makeTempDir("secant-claude-workspace-") });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");
  const turn = prepared.harness.startTurn(bridgeTurn("scripted"));
  const events: TurnEvent[] = [];
  const live = new Promise<void>((resolve) => {
    turn.subscribe((event) => {
      events.push(event);
      if (event.kind === "session") resolve();
    });
  });
  return { harness: prepared.harness, turn, events, live };
}

/** The bearer must be absent from everything a caller can observe — the JSON of
 *  the value and, for an Error cause (whose message is not enumerable), its
 *  message and stack — while the cause itself is preserved. */
function assertScrubbed(value: unknown, cause: unknown, token: string): void {
  assert.equal(token.length >= 32, true);
  assert.equal(JSON.stringify(value).includes(token), false);
  assert.ok(cause instanceof Error, "the cause is preserved as an Error");
  assert.equal(cause.message.includes(token), false);
  assert.equal((cause.stack ?? "").includes(token), false);
  assert.match(cause.message, /redacted-bearer-token/);
}

test("a known frame with an unrecognised extra field, or with a required field of the wrong type, is generic activity and never protocol corruption", async () => {
  const scripted = scriptedProcess({
    frames: [
      scriptedInit,
      // Known type, one field the model does not know: still a normal frame.
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
        novel_field: { nested: true },
      },
      // Known types whose required field has the wrong type: lenient fallthrough.
      { type: "assistant", message: "not an object" },
      { type: "stream_event", event: 5 },
      { type: "result", subtype: "success", result: "done", is_error: false },
    ],
  });
  const { harness, turn, events } = await scriptedTurn(scripted);
  const result = await turn.result();
  await harness.close();

  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("unreachable");
  assert.equal(result.detail.finalContent, "done");
  assert.deepEqual(
    events.filter((event) => event.kind === "assistant-content"),
    [{ kind: "assistant-content", content: "hello" }],
  );
  const activity = events.flatMap((event) =>
    event.kind === "activity" ? [event.description] : [],
  );
  assert.ok(activity.includes("Claude Code activity: assistant"));
  assert.ok(activity.includes("Claude Code activity: stream_event"));
});

test("CRLF-delimited Claude Code frames preserve a UTF-8 scalar split across chunks", async () => {
  const scripted = scriptedProcess({
    frames: [
      scriptedInit,
      {
        type: "result",
        subtype: "success",
        result: "done → intact",
        is_error: false,
      },
    ],
    lineEnding: "\r\n",
    splitUtf8Scalars: true,
  });
  const { harness, turn } = await scriptedTurn(scripted);
  const result = await turn.result();
  await harness.close();

  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("unreachable");
  assert.equal(result.detail.finalContent, "done → intact");
});

test("a close before a result carries its cause with the bearer redacted", async () => {
  const scripted = scriptedProcess({
    frames: [scriptedInit],
    close: (token) => ({
      kind: "cleanup-error",
      cause: new Error(`pipe error after spawn: Bearer ${token}`),
    }),
  });
  const { harness, turn, live } = await scriptedTurn(scripted);
  await live;
  scripted.end();
  const result = await turn.result();
  await harness.close();

  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.failure?.category, "completion-unknown");
  const token = tokenOf(scripted);
  assertScrubbed(result, result.detail.failure?.cause, token);
  assert.match(
    result.detail.failure?.diagnostics ?? "",
    /pipe error after spawn/,
  );
});

test("an unconfirmed interrupt carries its cause with the bearer redacted", async () => {
  const scripted = scriptedProcess({
    frames: [scriptedInit],
    interrupt: (token) => ({
      close: {
        kind: "cleanup-error",
        cause: new Error(`kill failed: Bearer ${token}`),
      },
      escalated: true,
    }),
  });
  const { harness, turn, live } = await scriptedTurn(scripted);
  await live;
  assert.deepEqual(await turn.interrupt(), { outcome: "accepted" });
  const result = await turn.result();
  await harness.close();

  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.unknown, "interruption");
  assert.equal(result.detail.failure?.category, "interruption-unknown");
  assertScrubbed(result, result.detail.failure?.cause, tokenOf(scripted));
});

test("a cleanup failure carries its cause with the bearer redacted", async () => {
  const scripted = scriptedProcess({
    frames: [scriptedInit],
    closeStdin: (token) => ({
      kind: "cleanup-error",
      cause: new Error(`stdin close failed: Bearer ${token}`),
    }),
  });
  const { harness, turn, live } = await scriptedTurn(scripted);
  await live;
  const cleanup = await harness.close();
  const result = await turn.result();

  assert.equal(cleanup.clean, false);
  assert.equal(cleanup.failure?.phase, "cleanup");
  const token = tokenOf(scripted);
  assertScrubbed(cleanup, cleanup.failure?.cause, token);
  assert.match(cleanup.detail, /stdin close failed/);
  assert.equal(cleanup.sessions?.[0]?.availability.state, "unusable");
  // The live Turn that the cleanup ended is scrubbed on its own route too.
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assertScrubbed(result, result.detail.failure?.cause, token);
});

/** The bearer the scripted process saw on its launch argv. */
function tokenOf(scripted: ScriptedProcess): string {
  return scripted.token();
}

// --- Real recorded Turns (#115) ----------------------------------------------

test("the recorded plain Turn completes with its assistant text, model, and usage", async () => {
  // The real recording of a no-tools Turn: byte-faithful init, partial stream,
  // assistant text, and success result captured from the installed Claude Code.
  const { harness, events, result } = await runProtocolTurn(
    "plain",
    "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("unreachable");
  assert.equal(result.detail.finalContent, "hello");
  assert.equal(result.detail.effectiveModel.known, true);
  if (!result.detail.effectiveModel.known) throw new Error("unreachable");
  assert.match(result.detail.effectiveModel.model, /^claude-/);

  const sessionEvent = events.find((event) => event.kind === "session");
  assert.equal(sessionEvent?.kind, "session");
  if (sessionEvent?.kind !== "session") throw new Error("unreachable");
  // The init frame's real facts crossed the Seam: version and the live bridge.
  assert.match(sessionEvent.facts?.executableVersion ?? "", /^\d+\.\d+\.\d+/);
  assert.ok(
    sessionEvent.facts?.mcp.some(
      (server) =>
        server.name === "secant-permissions" && server.status === "connected",
    ),
    "the recorded init reports the permission bridge connected",
  );
  assert.ok(events.some((event) => event.kind === "usage"));
  assert.ok(
    events.some(
      (event) =>
        event.kind === "assistant-content" && event.content === "hello",
    ),
  );
  await harness.close();
});

test("the recorded Test Repair Turn approves an Edit and its patch makes the failing test pass", async () => {
  // A real Turn that edited a file through the permission bridge. The recording
  // carries the Workspace patch; the replayer applies it to a temporary git repo
  // so the once-failing test passes — the AC for the Test Repair case.
  const workspace = makeTempDir("secant-claude-repair-");
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  // The failing baseline the patch was recorded against: sum() must add, not subtract.
  writeFileSync(
    join(workspace, "sum.mjs"),
    "export const sum = (a, b) => a - b;\n",
  );
  writeFileSync(
    join(workspace, "sum.test.mjs"),
    [
      "import assert from 'node:assert';",
      "import { sum } from './sum.mjs';",
      "assert.equal(sum(2, 3), 5);",
    ].join("\n") + "\n",
  );

  const replayer = installReplayer(VERSION, protocolCase("test-repair"));
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => "77777777-7777-4777-8777-777777777777",
  }).prepare({ workspace });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");

  const turn = prepared.harness.startTurn(bridgeTurn("repair"));
  const { events, raised } = firstRequest(turn);
  const request = await raised;
  assert.equal(request.shape.kind, "approval");
  if (request.shape.kind !== "approval") throw new Error("unreachable");
  assert.equal(request.shape.tool, "Edit");
  await turn.answerRequest({
    requestId: request.requestId,
    kind: "approval",
    decision: "allow",
  });
  const result = await turn.result();
  assert.equal(result.kind, "completed");
  assert.ok(events.some((event) => event.kind === "request-answered"));
  const [bridge] = replayer.bridges();
  assert.equal(bridge.behavior, "allow");
  await prepared.harness.close();

  // The replayer applied the recorded Workspace patch at the Turn's result: the
  // failing test now passes over the patched file.
  assert.match(readFileSync(join(workspace, "sum.mjs"), "utf8"), /a \+ b/);
  execFileSync(process.execPath, ["sum.test.mjs"], { cwd: workspace });
});

test("interrupting a live Turn spawns no resume and settles interrupted with a detached Session", async () => {
  const replayer = installReplayer(VERSION, protocolCase("interrupt"));
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
  // On Windows a live child is force-killed outright and reported escalated, so
  // the Turn is truthfully `lost` (see the interrupt cases above).
  if (process.platform === "win32") {
    assert.equal(result.kind, "lost");
    if (result.kind !== "lost") throw new Error("unreachable");
    assert.equal(result.detail.unknown, "interruption");
  } else {
    assert.equal(result.kind, "interrupted");
    if (result.kind !== "interrupted") throw new Error("unreachable");
    assert.equal(result.detail.interruption.mode, "process-only");
  }
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
  const replayer = installReplayer(VERSION, protocolCase("resume"));
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
  // `interrupted` off Windows, `lost` on it (a live child is force-killed there);
  // either way the Session detaches with its coordinate.
  assert.equal(
    result1.kind,
    process.platform === "win32" ? "lost" : "interrupted",
  );
  if (result1.kind !== "interrupted" && result1.kind !== "lost")
    throw new Error("unreachable");
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
  // Golden: the full launch argv in both forms (A23). The fresh Turn minted with
  // --session-id and the resume Turn with --resume are the two launch shapes.
  const freshInvocation = replayer
    .invocations()
    .find((i) => i.args.includes("--session-id"));
  assert.ok(freshInvocation, "the first Turn spawned a --session-id process");
  assertGoldenLaunch(
    freshInvocation.args,
    "--session-id",
    "55555555-5555-4555-8555-555555555555",
  );
  assertGoldenLaunch(
    resumeInvocation.args,
    "--resume",
    "55555555-5555-4555-8555-555555555555",
  );
});

test("resuming a coordinate on an untracked Session passes that coordinate, not a fresh mint", async () => {
  // No prior Turn on this Prepared Harness minted the id, so the coordinate must
  // come from the caller's `resume` — a fresh mint would name a Session Claude
  // Code never saw and the acknowledging init would be rejected.
  const replayer = installReplayer(VERSION, protocolCase("resume"));
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

test("a requested model is forwarded to the launch as --model, distinct from the effective model", async () => {
  const replayer = installReplayer(VERSION, COMPLETED_CASE);
  const workspace = makeTempDir("secant-claude-workspace-");
  const prepared = await createClaudeCodeAdapter({
    path: replayer.path,
    env: {},
    sessionId: () => "11111111-1111-4111-8111-111111111111",
  }).prepare({ workspace, requestedModel: "claude-opus-4-1" });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("unreachable");
  // Free-text profile: the caller's model is admitted with no list check.
  assert.equal(prepared.harness.profile.modelSelection.at, "launch");
  if (prepared.harness.profile.modelSelection.at !== "launch") {
    throw new Error("unreachable");
  }
  assert.deepEqual(prepared.harness.profile.modelSelection.declaration, {
    kind: "free-text",
  });

  const turn = prepared.harness.startTurn({
    session: "repair",
    origin: "managed",
    correlationKey: { opaque: "turn-1" },
    input: { text: "Repair the failing test." },
    recorder: {
      admit() {
        return Promise.resolve({ recorded: true });
      },
      checkpoint() {
        return Promise.resolve({ recorded: true });
      },
    },
  });
  const result = await turn.result();
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("unreachable");
  // Requested and effective stay distinct facts: the effective model is the one
  // the init reported, never the request copied back.
  assert.deepEqual(result.detail.effectiveModel, {
    known: true,
    model: "claude-sonnet-4-5",
  });
  await prepared.harness.close();

  const invocation = replayer
    .invocations()
    .find((i) => i.args.includes("--session-id"));
  assert.ok(invocation, "the Turn spawned a --session-id process");
  const at = invocation.args.indexOf("--model");
  assert.notEqual(at, -1, "the launch carries --model");
  assert.equal(invocation.args[at + 1], "claude-opus-4-1");
  // The model precedes the session flag, as the golden pins the launch order.
  assert.ok(at < invocation.args.indexOf("--session-id"));
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
  // Claude Code accepts any model string via --model at launch: it declares
  // free-text entry, and observes the effective model from init/result.
  assert.equal(profile.modelSelection.at, "launch");
  if (profile.modelSelection.at !== "launch") throw new Error("unreachable");
  assert.equal(profile.modelSelection.declaration.kind, "free-text");
  assert.equal(profile.modelObservation.available, true);
  assert.equal(profile.recoveryCoordinate.timing, "before-submission");
  assert.equal(profile.skillDelivery.mode, "plain-path");
  assert.equal(profile.fileDelivery.mode, "plain-path");

  for (const capability of [
    profile.recovery,
    profile.interruption,
    profile.approvals,
    profile.clarifications,
    profile.modelSelection,
    profile.modelObservation,
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
