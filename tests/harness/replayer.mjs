#!/usr/bin/env bun
// The `claude` replayer skeleton (#111). It stands in for a real Claude Code
// executable so the Adapter's discovery, shim resolution, and spawning run for
// real in CI on all three OSes — never a fake in place of a spawn. A test drops
// it on a temporary PATH under the name `claude` (a chmod'd shebang script on
// POSIX; an npm-style `.cmd` shim naming the Bun runtime plus this script on
// Windows) and spawns it directly. In this slice it parses argv and answers
// `--version` from a recorded version string; Turn framing arrives with #112.
//
// It records each invocation (argv, and whether stdin carried any bytes) to the
// log named in its recording, so the Adapter's tests can assert that a cached
// qualification skips the probe and that `prepare` writes nothing to stdin. It
// reads its recording from `recording.json` beside itself, resolved from
// argv[1], so its behaviour never depends on the environment the Adapter passes.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const scriptDir = dirname(process.argv[1]);
const recording = JSON.parse(
  readFileSync(join(scriptDir, "recording.json"), "utf8"),
);
const args = process.argv.slice(2);

if (recording.log) {
  // fd 0 is /dev/null (spawnCommand closes stdin), so `readableLength` is 0 for
  // a well-behaved probe; a Turn slice that wrote stdin would show non-zero.
  const stdinBytes = process.stdin.readableLength ?? 0;
  appendFileSync(recording.log, JSON.stringify({ args, stdinBytes }) + "\n");
}

if (args.includes("--version")) {
  process.stdout.write(recording.version + "\n");
  process.exit(0);
}

process.stderr.write(
  "secant replayer: only --version is served in this slice (#111)\n",
);
process.exit(2);
