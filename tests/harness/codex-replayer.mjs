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
for await (const line of lines) {
  log({ type: "stdin", line });
  if (Array.isArray(scenario.traffic)) {
    const expected = scenario.traffic[trafficAt];
    if (expected?.direction !== "stdin" || expected.line !== `${line}\n`) {
      process.stderr.write("recorded Codex stdin diverged\n");
      process.exit(3);
    }
    trafficAt += 1;
    while (scenario.traffic[trafficAt]?.direction === "stdout") {
      process.stdout.write(scenario.traffic[trafficAt].line);
      trafficAt += 1;
    }
    continue;
  }
  const request = JSON.parse(line);
  if (request.method === "initialized") continue;
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
if (Array.isArray(scenario.traffic) && trafficAt !== scenario.traffic.length) {
  process.stderr.write("recorded Codex traffic ended early\n");
  process.exit(4);
}
process.exit(scenario.exitCode ?? 0);
