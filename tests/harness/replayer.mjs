#!/usr/bin/env bun
// The `claude` replayer (#111/#112). It stands in for a real Claude Code
// executable so the Adapter's discovery, shim resolution, and spawning run for
// real in CI on all three OSes — never a fake in place of a spawn. A test drops
// it on a temporary PATH under the name `claude` (a chmod'd shebang script on
// POSIX; an npm-style `.cmd` shim naming the Bun runtime plus this script on
// Windows) and spawns it directly. It parses argv, answers `--version`, then for
// a Turn case waits for each stdin frame before emitting that Turn's recorded
// stdout/stderr bytes. This preserves the real process and backpressure seam.
//
// It records argv, cwd, and each intact stdin line to the log named in its
// runtime configuration. The protocol case itself is a directory outside the
// recorded-fixture tree; #115 replaces these hand-authored cases with recordings.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const scriptDir = dirname(process.argv[1]);
const recording = JSON.parse(
  readFileSync(join(scriptDir, "recording.json"), "utf8"),
);
const args = process.argv.slice(2);
const invocationId = `${process.pid}-${Date.now()}`;

if (recording.log) {
  appendFileSync(
    recording.log,
    JSON.stringify({
      type: "start",
      id: invocationId,
      args,
      cwd: process.cwd(),
    }) + "\n",
  );
}

if (args.includes("--version")) {
  process.stdout.write(recording.version + "\n");
  process.exit(0);
}

const caseDirectory = recording.protocolCaseDirectory;
if (typeof caseDirectory !== "string") {
  process.stderr.write("secant replayer: no protocol case configured\n");
  process.exit(2);
}

const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const required = [
  ["--input-format", "stream-json"],
  ["--output-format", "stream-json"],
];
const valid =
  args.includes("-p") &&
  args.includes("--verbose") &&
  args.includes("--include-partial-messages") &&
  required.every(([flag, value]) => valueAfter(flag) === value) &&
  (valueAfter("--session-id") !== undefined) !==
    (valueAfter("--resume") !== undefined);
if (!valid) {
  process.stderr.write("secant replayer: required stream-json flags missing\n");
  process.exit(2);
}

const protocolCase = JSON.parse(
  readFileSync(join(caseDirectory, "case.json"), "utf8"),
);
const write = (stream, bytes) =>
  new Promise((resolve, reject) => {
    stream.write(bytes, (error) => (error ? reject(error) : resolve()));
  });

let turnIndex = 0;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.length === 0) continue;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    process.stderr.write("secant replayer: stdin was not JSON\n");
    process.exit(2);
  }
  if (frame.type !== "user" || frame.message?.role !== "user") {
    process.stderr.write("secant replayer: stdin was not a user Turn\n");
    process.exit(2);
  }
  if (recording.log) {
    appendFileSync(
      recording.log,
      JSON.stringify({ type: "stdin", id: invocationId, line }) + "\n",
    );
  }
  const turn = protocolCase.turns[turnIndex++];
  if (!turn) {
    process.stderr.write(
      "secant replayer: received more Turns than recorded\n",
    );
    process.exit(2);
  }
  await write(process.stdout, readFileSync(join(caseDirectory, turn.stdout)));
  if (turn.stderr) {
    await write(process.stderr, readFileSync(join(caseDirectory, turn.stderr)));
  }
}

process.exitCode = protocolCase.exitCode;
