import assert from "node:assert/strict";
import test from "node:test";
import { spawnCommand } from "../../src/process/process.js";

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
