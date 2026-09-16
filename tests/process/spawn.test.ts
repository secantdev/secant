import assert from "node:assert/strict";
import test from "node:test";
import { spawnCommand, spawnOwnedProcess } from "../../src/process/process.js";

// The process Module's direct spawn/kill Interface (AC4). A per-child kill would
// leave a grandchild holding the capture pipe open, so `close` would never fire and
// spawnCommand would never settle — the test would hang past its own timeout. The
// group kill (POSIX `kill(-pid)`, Windows `taskkill /T`) reaps the whole tree, so
// the pipe closes and the promise settles `timeout`. Cross-OS: the reaping proof is
// the settle itself, bounded by a short deterministic timeout, so a regression turns
// it red by hanging, never by flaking.
test(
  "spawnCommand reaps the whole tree: a parent whose child holds stdout open is group-killed on timeout",
  { timeout: 20_000 },
  async () => {
    // The parent spawns a child that inherits stdout (holding our capture pipe
    // open) and sleeps, then the parent itself hangs. Only killing the whole group
    // closes the pipe and lets the spawn settle.
    const hang =
      "const{spawn}=require('node:child_process');" +
      "spawn(process.execPath,['-e','setTimeout(()=>{},1e9)'],{stdio:['ignore','inherit','inherit']});" +
      "setTimeout(()=>{},1e9);";

    const result = await spawnCommand({
      executable: process.execPath,
      args: ["-e", hang],
      cwd: undefined,
      env: process.env,
      timeoutMs: 300,
      maxCaptureBytes: 4 * 1024 * 1024,
      truncationMarker: "\n[truncated]\n",
    });

    // Settled at all ⇒ the pipe-holding grandchild was reaped; our own timeout kill
    // ⇒ `timeout`.
    assert.equal(result.kind, "timeout");
  },
);

// `interrupt` distinguishes a graceful stop from a force-kill — the fact the
// Harness Adapter needs to tell an `interrupted` Turn from a `lost` one. A child
// that exits on SIGTERM reports `escalated:false`; one that ignores SIGTERM must be
// SIGKILLed and reports `escalated:true`. Each child announces "ready" on stdout
// once its signal handler is installed; the test waits for that before signalling,
// so a SIGTERM never races child startup. Bounded and deterministic: a regression
// flips the boolean, never hangs.
async function awaitReady(process: {
  readonly stdout: AsyncIterable<Uint8Array>;
}): Promise<void> {
  const decoder = new TextDecoder();
  let seen = "";
  for await (const chunk of process.stdout) {
    seen += decoder.decode(chunk, { stream: true });
    if (seen.includes("ready")) return;
  }
}

test(
  "interrupt: a child that exits on the graceful signal is not escalated",
  { timeout: 20_000 },
  async () => {
    // Blocks forever on stdin; the default SIGTERM disposition terminates it.
    const launched = await spawnOwnedProcess({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write('ready\\n');process.stdin.resume();setTimeout(()=>{},1e9);",
      ],
      cwd: process.cwd(),
      env: process.env,
      launchTimeoutMs: 10_000,
    });
    assert.equal(launched.ok, true);
    if (!launched.ok) throw new Error("unreachable");
    await awaitReady(launched.process);
    const outcome = await launched.process.interrupt(5_000);
    assert.equal(outcome.escalated, false);
    // A second call returns the same interruption.
    assert.equal(await launched.process.interrupt(5_000), outcome);
  },
);

test(
  "interrupt: a child that ignores SIGTERM is force-killed and escalated",
  { timeout: 20_000, skip: process.platform === "win32" },
  async () => {
    // Swallows SIGTERM, so only SIGKILL stops it. It announces readiness after the
    // handler is installed so the graceful signal cannot arrive before it.
    const launched = await spawnOwnedProcess({
      executable: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');process.stdin.resume();setTimeout(()=>{},1e9);",
      ],
      cwd: process.cwd(),
      env: process.env,
      launchTimeoutMs: 10_000,
    });
    assert.equal(launched.ok, true);
    if (!launched.ok) throw new Error("unreachable");
    await awaitReady(launched.process);
    const outcome = await launched.process.interrupt(1_000);
    assert.equal(outcome.escalated, true);
  },
);
