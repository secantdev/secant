#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { replayRecordedLine } from "./codex-replay-path.ts";

const directory = dirname(fileURLToPath(import.meta.url));
const recording = JSON.parse(
  readFileSync(join(directory, "recording.json"), "utf8"),
);
const id = `${process.pid}-${Date.now()}`;

function log(entry) {
  appendFileSync(
    recording.log,
    `${JSON.stringify(Object.assign({ id }, entry))}\n`,
  );
}

log({ type: "start", args: process.argv.slice(2), cwd: process.cwd() });

if (process.argv[2] === "--version") {
  if (recording.versionExitCode !== undefined) {
    process.exit(recording.versionExitCode);
  }
  process.stdout.write(`${recording.executableVersion}\n`);
  process.exit(0);
}

if (process.argv[2] !== "app-server") process.exit(2);

if (process.argv[3] === "generate-json-schema") {
  const outAt = process.argv.indexOf("--out");
  if (outAt < 0 || process.argv[outAt + 1] === undefined) process.exit(2);
  cpSync(
    join(
      recording.schemaDirectory ?? recording.fixtureDirectory,
      recording.schemaFile,
    ),
    join(process.argv[outAt + 1], "codex_app_server_protocol.schemas.json"),
  );
  process.exit(0);
}

const scenario = JSON.parse(
  readFileSync(join(recording.fixtureDirectory, "case.json"), "utf8"),
);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let trafficAt = 0;
let requestedWorkspace;
let turnNumber = 0;
let activeTurnId;
const outstandingApprovals = new Map();
let steerNumber = 0;

function replayLine(line) {
  return replayRecordedLine(line, requestedWorkspace ?? process.cwd());
}

function expectedStdinLine(recordedLine, actualLine) {
  if (!recordedLine.includes("«WORKSPACE»")) return replayLine(recordedLine);
  try {
    const actual = JSON.parse(actualLine);
    if (
      actual.method === "thread/start" &&
      typeof actual.params?.cwd === "string"
    ) {
      requestedWorkspace = actual.params.cwd;
      return replayLine(recordedLine);
    }
  } catch {
    // The caller's JSON validation below remains authoritative.
  }
  return replayLine(recordedLine);
}

/** Strict stdin match, tolerating the two run-varying fields. The Secant client
 *  version differs by build (the `0.0.0-dev` dev sentinel under `bun test`, the
 *  embedded release version from a compiled binary), and a thread start or resume
 *  carries the replaying Run's own working area as its sole writable-roots config
 *  override (#214), so the same byte-faithful recording must replay under any build
 *  and Run. Every other field of those frames — and every byte of every other
 *  frame — stays strictly matched. */
function stdinFrameMatches(recordedLine, actualLine) {
  const expected = expectedStdinLine(recordedLine, actualLine);
  if (expected === `${actualLine}\n`) return true;
  try {
    const recorded = JSON.parse(expected);
    const actual = JSON.parse(actualLine);
    if (recorded.method !== actual.method) return false;
    if (actual.method === "initialize") {
      if (recorded.params?.clientInfo) {
        delete recorded.params.clientInfo.version;
      }
      if (actual.params?.clientInfo) delete actual.params.clientInfo.version;
    } else if (
      (actual.method === "thread/start" || actual.method === "thread/resume") &&
      recorded.params?.config === undefined &&
      isWorkingAreaOverride(actual.params?.config)
    ) {
      delete actual.params.config;
    } else {
      return false;
    }
    return JSON.stringify(recorded) === JSON.stringify(actual);
  } catch {
    return false;
  }
}

function isWorkingAreaOverride(config) {
  const keys = Object.keys(config ?? {});
  return (
    keys.length === 1 &&
    keys[0] === "sandbox_workspace_write.writable_roots" &&
    Array.isArray(config[keys[0]]) &&
    config[keys[0]].length === 1
  );
}

function applyWorkspacePatch(path) {
  try {
    execFileSync(
      "git",
      ["apply", "--whitespace=nowarn", join(recording.fixtureDirectory, path)],
      { cwd: process.cwd() },
    );
  } catch (error) {
    process.stderr.write(
      `recorded Codex Workspace patch failed: ${error?.message ?? error}\n`,
    );
    process.exit(3);
  }
}

function drainRecordedOutput() {
  while (trafficAt < (scenario.traffic?.length ?? 0)) {
    const entry = scenario.traffic[trafficAt];
    if (entry.direction === "stdin") return;
    trafficAt += 1;
    if (entry.direction === "stdout") {
      process.stdout.write(replayLine(entry.line));
    } else if (entry.direction === "stderr") {
      process.stderr.write(replayLine(entry.line));
    } else if (entry.direction === "workspace-patch") {
      applyWorkspacePatch(entry.path);
    } else {
      process.stderr.write("recorded Codex traffic has an unknown direction\n");
      process.exit(3);
    }
  }
}

if (scenario.replay === "strict") drainRecordedOutput();
for await (const line of lines) {
  log({ type: "stdin", line });
  if (scenario.replay === "strict") {
    const expected = scenario.traffic[trafficAt];
    if (
      expected === undefined ||
      expected.direction !== "stdin" ||
      !stdinFrameMatches(expected.line, line)
    ) {
      process.stderr.write("recorded Codex stdin diverged\n");
      process.exit(3);
    }
    trafficAt += 1;
    drainRecordedOutput();
    continue;
  }
  if (
    scenario.replay === "synthetic-fault-injection" &&
    Array.isArray(scenario.traffic)
  ) {
    const expected = scenario.traffic[trafficAt];
    if (
      expected !== undefined &&
      (expected.direction !== "stdin" || expected.line !== `${line}\n`)
    ) {
      process.stderr.write("recorded Codex stdin diverged\n");
      process.exit(3);
    }
    if (expected !== undefined) {
      trafficAt += 1;
      while (scenario.traffic[trafficAt]?.direction === "stdout") {
        process.stdout.write(scenario.traffic[trafficAt].line);
        trafficAt += 1;
      }
      continue;
    }
  }
  if (scenario.replay !== "synthetic-fault-injection") {
    process.stderr.write("recorded Codex case is not strict or synthetic\n");
    process.exit(3);
  }
  const request = JSON.parse(line);
  if (request.method === undefined && outstandingApprovals.has(request.id)) {
    outstandingApprovals.delete(request.id);
    if (outstandingApprovals.size === 0) completeActiveTurn();
    continue;
  }
  if (request.method === "initialized") continue;
  if (request.method === "thread/start") {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: threadStartResponse("thread-1", request.params) })}\n`,
    );
    continue;
  }
  if (request.method === "thread/resume") {
    if (scenario.recovery?.malformedFrame === true) {
      process.stdout.write("{malformed\n");
      continue;
    }
    const threadId =
      scenario.recovery?.threadId === undefined
        ? "thread-1"
        : scenario.recovery.threadId;
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: threadStartResponse(threadId, request.params) })}\n`,
    );
    continue;
  }
  if (request.method === "turn/start") {
    turnNumber += 1;
    const turnId = `turn-${turnNumber}`;
    activeTurnId = turnId;
    if (scenario.turn?.stallFirstTurn === true && turnNumber === 1) continue;
    if (scenario.turn?.stallFirstTurn === true && turnNumber === 2) {
      emitTurnStarted("turn-1");
      emitTurnCompleted("turn-1", "completed");
    }
    const turn = {
      id: turnId,
      items: [],
      status: "inProgress",
    };
    if (scenario.turn?.approvals !== undefined) {
      for (const approval of scenario.turn.approvals) {
        if (approval.kind === "file" && approval.changes !== undefined) {
          emitFileChangeStarted(approval, turnId);
        }
        outstandingApprovals.set(approval.id, approval);
        emitApprovalRequest(approval, turnId);
      }
      if (scenario.turn.duplicateFirstApproval === true) {
        const [first] = scenario.turn.approvals;
        if (first !== undefined) emitApprovalRequest(first, turnId);
      }
      if (scenario.turn.resolveFirstApproval === true) {
        const [first] = scenario.turn.approvals;
        if (first !== undefined) {
          outstandingApprovals.delete(first.id);
          process.stdout.write(
            `${JSON.stringify({
              method: "serverRequest/resolved",
              params: { requestId: first.id, threadId: "thread-1" },
            })}\n`,
          );
        }
      }
      process.stdout.write(
        `${JSON.stringify({ id: request.id, result: { turn } })}\n`,
      );
      if (scenario.turn.completeWithOutstandingApproval === true) {
        completeActiveTurn();
      }
      continue;
    }
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: { turn } })}\n`,
    );
    if (scenario.turn?.withholdTerminal === true) continue;
    if (scenario.turn?.stopAfter === "accepted") process.exit(0);
    const status = scenario.turn?.status ?? "completed";
    if (scenario.turn?.retryingError !== undefined) {
      process.stdout.write(
        `${JSON.stringify({
          method: "error",
          params: {
            error: { message: scenario.turn.retryingError },
            threadId: "thread-1",
            turnId,
            willRetry: true,
          },
        })}\n`,
      );
    }
    if (scenario.turn?.malformedItem === true) {
      process.stdout.write(
        `${JSON.stringify({
          method: "item/completed",
          params: {
            completedAtMs: 1,
            item: { id: "broken-command", type: "commandExecution" },
            threadId: "thread-1",
            turnId,
          },
        })}\n`,
      );
    }
    if (scenario.turn?.fullActivity === true) emitActivityItems();
    if (status === "completed") {
      process.stdout.write(
        `${JSON.stringify({
          method: "item/agentMessage/delta",
          params: {
            delta: "preview",
            itemId: "item-1",
            threadId: "thread-1",
            turnId,
          },
        })}\n`,
      );
      process.stdout.write(
        `${JSON.stringify({
          method: "item/completed",
          params: {
            completedAtMs: 1,
            item: { id: "item-1", type: "agentMessage", text: "final answer" },
            threadId: "thread-1",
            turnId,
          },
        })}\n`,
      );
    }
    if (scenario.turn?.stopAfter === "item-completed") process.exit(0);
    if (scenario.turn?.malformedFrame === true) {
      process.stdout.write("{malformed\n");
      process.exit(0);
    }
    if (scenario.turn?.truncatedFrame === true) {
      process.stdout.write('{"method":');
      process.exit(0);
    }
    if (scenario.turn?.mismatchedTerminal === true) {
      process.stdout.write(
        `${JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "stale-turn", items: [], status: "completed" },
          },
        })}\n`,
      );
    }
    const terminalLine = JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: turnId,
          items: [],
          status: scenario.turn?.malformedTerminal === true ? "failed" : status,
          ...(scenario.turn?.malformedTerminal === true
            ? { error: { message: 42 } }
            : status === "failed"
              ? { error: { message: scenario.turn.message } }
              : {}),
        },
      },
    });
    process.stdout.write(
      `${terminalLine}${scenario.turn?.terminalLineEnding === "crlf" ? "\r\n" : "\n"}`,
    );
    continue;
  }
  if (request.method === "turn/steer") {
    steerNumber += 1;
    if (
      scenario.turn?.stallSteerResponse === true ||
      (scenario.turn?.stallSecondSteerResponse === true && steerNumber === 2)
    ) {
      continue;
    }
    if (scenario.turn?.steerRpcError !== undefined) {
      const messages = {
        "no-active": "no active turn to steer",
        mismatch: "expected active turn id `turn-1` but found `turn-2`",
        empty: "input must not be empty",
        review: "cannot steer a review turn",
        compact: "cannot steer a compact turn",
        schema: "active turn uses a different output schema",
        "near-miss":
          "expected active turn id `turn-1` but found `turn-2` unexpectedly",
      };
      const message = messages[scenario.turn.steerRpcError];
      process.stdout.write(
        `${JSON.stringify({ id: request.id, error: { code: -32600, message } })}\n`,
      );
      continue;
    }
    const turnId = scenario.turn?.mismatchedSteerResponse
      ? "stale-turn"
      : request.params.expectedTurnId;
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: scenario.turn?.malformedSteerResponse === true ? {} : { turnId } })}\n`,
    );
    if (scenario.turn?.steerTerminal === "completed") {
      emitTurnCompleted(request.params.expectedTurnId, "completed");
    }
    continue;
  }
  if (request.method === "turn/interrupt") {
    if (scenario.turn?.interruptTerminalBeforeResponse !== undefined) {
      emitTurnCompleted(
        request.params.turnId,
        scenario.turn.interruptTerminalBeforeResponse,
      );
    }
    if (scenario.turn?.stallInterruptResponse === true) continue;
    if (scenario.turn?.interruptRpcError !== undefined) {
      const errors = {
        stale: { code: -32600, message: "no active turn to interrupt" },
        mismatch: {
          code: -32600,
          message: "expected active turn id turn-1 but found turn-2",
        },
        "near-miss": {
          code: -32600,
          message:
            "expected active turn id turn-1 but found turn-2 unexpectedly",
        },
        internal: { code: -32603, message: "internal error" },
      };
      const error = errors[scenario.turn.interruptRpcError];
      process.stdout.write(`${JSON.stringify({ id: request.id, error })}\n`);
      continue;
    }
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: scenario.turn?.malformedInterruptResponse === true ? null : {} })}\n`,
    );
    if (scenario.turn?.interruptTerminal === "interrupted") {
      emitTurnCompleted(request.params.turnId, "interrupted");
    }
    if (scenario.turn?.interruptTerminal === "exit") process.exit(0);
    continue;
  }
  const response = scenario.responses[request.method];
  if (response === undefined) {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, error: { code: -32601, message: "method not found" } })}\n`,
    );
    continue;
  }
  if (typeof response.line === "string") {
    process.stdout.write(response.line);
  } else {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: response })}\n`,
    );
  }
}
if (scenario.replay === "strict" && trafficAt < scenario.traffic.length) {
  process.stderr.write("recorded Codex traffic ended early\n");
  process.exit(4);
}
process.exit(scenario.exitCode ?? 0);

function threadStartResponse(threadId = "thread-1", params = {}) {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    cwd: process.cwd(),
    model: "recorded-model",
    modelProvider: "openai",
    sandbox: sandboxFor(params),
    thread: {
      ...(threadId === null ? {} : { id: threadId }),
      turns: [],
    },
  };
}

// The acknowledged sandbox (#214): a `sandbox_workspace_write.writable_roots`
// config override becomes the thread's workspace-write roots, as Codex applies
// it; the `ignoreWritableRoots` scenario acknowledges workspace-write without it.
function sandboxFor(params) {
  const roots = params?.config?.["sandbox_workspace_write.writable_roots"];
  return Array.isArray(roots) && scenario.turn?.ignoreWritableRoots !== true
    ? { type: "workspaceWrite", writableRoots: roots }
    : { type: "workspaceWrite" };
}

function emitActivityItems() {
  const items = [
    {
      id: "command",
      type: "commandExecution",
      command: "bun test",
      commandActions: [],
      cwd: process.cwd(),
      status: "completed",
    },
    {
      id: "files",
      type: "fileChange",
      changes: [
        {
          path: "file.ts",
          diff: "recorded diff",
          kind: { type: "update" },
        },
      ],
      status: "completed",
    },
    {
      id: "mcp",
      type: "mcpToolCall",
      server: "docs",
      tool: "read",
      arguments: { topic: "runtime" },
      status: "completed",
    },
    {
      id: "agent",
      type: "collabAgentToolCall",
      agentsStates: {},
      receiverThreadIds: ["agent-thread"],
      senderThreadId: "thread-1",
      status: "completed",
      tool: "spawnAgent",
    },
    { id: "web", type: "webSearch", query: "Codex app-server" },
    {
      id: "dynamic",
      type: "dynamicToolCall",
      tool: "custom",
      status: "completed",
    },
    { id: "view", type: "imageView", path: "/recorded/image.png" },
    {
      id: "image",
      type: "imageGeneration",
      status: "completed",
    },
    { id: "future", type: "futureDisplayItem" },
  ];
  for (const item of items) {
    for (const phase of ["started", "completed"]) {
      process.stdout.write(
        `${JSON.stringify({
          method: `item/${phase}`,
          params: {
            [`${phase}AtMs`]: 1,
            item,
            threadId: "thread-1",
            turnId: `turn-${turnNumber}`,
          },
        })}\n`,
      );
    }
  }
}

function emitFileChangeStarted(approval, turnId) {
  const changes = approval.changes.map((change) => ({
    path: change.path,
    diff: "recorded diff",
    kind: {
      type: change.kind,
      ...(change.movePath === undefined ? {} : { move_path: change.movePath }),
    },
  }));
  process.stdout.write(
    `${JSON.stringify({
      method: "item/started",
      params: {
        startedAtMs: 1,
        item: {
          id: approval.itemId,
          type: "fileChange",
          changes,
          status: "inProgress",
        },
        threadId: "thread-1",
        turnId,
      },
    })}\n`,
  );
}

function emitTurnStarted(turnId) {
  process.stdout.write(
    `${JSON.stringify({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: { id: turnId, items: [], status: "inProgress" },
      },
    })}\n`,
  );
}

function emitTurnCompleted(turnId, status) {
  process.stdout.write(
    `${JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: turnId,
          items: [],
          status,
          ...(status === "failed"
            ? { error: { message: "scripted terminal failure" } }
            : {}),
        },
      },
    })}\n`,
  );
}

function emitApprovalRequest(approval, turnId) {
  const method =
    approval.kind === "file"
      ? "item/fileChange/requestApproval"
      : approval.kind === "request-user-input"
        ? "item/tool/requestUserInput"
        : "item/commandExecution/requestApproval";
  const params = {
    itemId: approval.itemId,
    startedAtMs: 1,
    threadId: "thread-1",
    turnId,
    ...(approval.kind === "command"
      ? { command: approval.command, kind: "command" }
      : approval.kind === "unsupported-command"
        ? { command: null, kind: "writeStdin" }
        : {}),
  };
  process.stdout.write(
    `${JSON.stringify({ id: approval.id, method, params })}\n`,
  );
}

function completeActiveTurn() {
  if (activeTurnId === undefined) return;
  emitTurnCompleted(activeTurnId, "completed");
  activeTurnId = undefined;
}
