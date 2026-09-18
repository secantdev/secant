#!/usr/bin/env bun

import { appendFileSync, cpSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

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
    join(recording.fixtureDirectory, recording.schemaFile),
    join(process.argv[outAt + 1], "codex_app_server_protocol.schemas.json"),
  );
  process.exit(0);
}

const scenario = JSON.parse(
  readFileSync(join(recording.fixtureDirectory, "case.json"), "utf8"),
);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let trafficAt = 0;
let turnNumber = 0;
for await (const line of lines) {
  log({ type: "stdin", line });
  if (Array.isArray(scenario.traffic)) {
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
  const request = JSON.parse(line);
  if (request.method === "initialized") continue;
  if (request.method === "thread/start") {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: threadStartResponse() })}\n`,
    );
    continue;
  }
  if (request.method === "turn/start") {
    turnNumber += 1;
    const turnId = `turn-${turnNumber}`;
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
    process.stdout.write(
      `${JSON.stringify({ id: request.id, result: { turn } })}\n`,
    );
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
    process.stdout.write(
      `${JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: turnId,
            items: [],
            status:
              scenario.turn?.malformedTerminal === true ? "failed" : status,
            ...(scenario.turn?.malformedTerminal === true
              ? { error: { message: 42 } }
              : status === "failed"
                ? { error: { message: scenario.turn.message } }
                : {}),
          },
        },
      })}\n`,
    );
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
if (Array.isArray(scenario.traffic) && trafficAt < scenario.traffic.length) {
  process.stderr.write("recorded Codex traffic ended early\n");
  process.exit(4);
}
process.exit(scenario.exitCode ?? 0);

function threadStartResponse() {
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    cwd: process.cwd(),
    model: "recorded-model",
    modelProvider: "openai",
    sandbox: { type: "workspaceWrite" },
    thread: {
      id: "thread-1",
      turns: [],
    },
  };
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
      changes: [{ path: "file.ts" }],
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
        turn: { id: turnId, items: [], status },
      },
    })}\n`,
  );
}
