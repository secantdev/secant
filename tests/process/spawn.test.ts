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
// that stops on the graceful stage reports `escalated:false`; one that survives it
// must be force-killed and reports `escalated:true`. Each child announces "ready"
// on stdout once it can observe the graceful stage; the test waits for that before
// signalling, so the signal never races child startup. Both stages are proven on
// every OS (#127 A6): the graceful stage is SIGTERM off Windows and `taskkill /T`
// (a close request to each window) on Windows. Bounded and deterministic: a
// regression flips the boolean, never hangs.
async function awaitReady(process: {
  readonly stdout: AsyncIterable<Uint8Array>;
}): Promise<boolean> {
  const decoder = new TextDecoder();
  let seen = "";
  for await (const chunk of process.stdout) {
    seen += decoder.decode(chunk, { stream: true });
    if (seen.includes("ready")) return true;
  }
  return false;
}

/** A child that stops on the graceful stage. Off Windows any process does: the
 *  default SIGTERM disposition terminates it. On Windows only a window can honour
 *  `taskkill /T`, so the child is a PowerShell process owning one WinForms window
 *  that closes on the request and exits 0; it announces "ready" once shown. */
function gracefulChild(): { executable: string; args: string[] } {
  if (process.platform !== "win32") {
    return {
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write('ready\\n');process.stdin.resume();setTimeout(()=>{},1e9);",
      ],
    };
  }
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$form = New-Object System.Windows.Forms.Form",
    "$form.ShowInTaskbar = $false",
    "$form.Add_Shown({ [Console]::Out.WriteLine('ready'); [Console]::Out.Flush() })",
    "[void][System.Windows.Forms.Application]::Run($form)",
  ].join("; ");
  return {
    executable: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
  };
}

test(
  "interrupt: a child that stops on the graceful stage is not escalated",
  { timeout: 20_000 },
  async () => {
    const launched = await spawnOwnedProcess({
      ...gracefulChild(),
      cwd: process.cwd(),
      env: process.env,
      launchTimeoutMs: 10_000,
    });
    assert.equal(launched.ok, true);
    if (!launched.ok) throw new Error("unreachable");
    // The child must have reached the point where it can observe the graceful
    // stage; a child that died on startup would make the stop below vacuous.
    assert.equal(await awaitReady(launched.process), true);
    const outcome = await launched.process.interrupt(5_000);
    assert.equal(outcome.escalated, false);
    if (process.platform === "win32") {
      // The window closed on request and the process left on its own terms; a
      // forced `taskkill /F` would have ended it with exit 1.
      assert.deepEqual(outcome.close, { kind: "exited", status: 0 });
    }
    // A second call returns the same interruption.
    assert.equal(await launched.process.interrupt(5_000), outcome);
  },
);

test(
  "interrupt: a child that survives the graceful stage is force-killed and escalated",
  { timeout: 20_000 },
  async () => {
    // Swallows SIGTERM off Windows, so only SIGKILL stops it; on Windows it is a
    // hidden console child with no window for `taskkill /T` to close, so it
    // survives the graceful stage the same way. It announces readiness after the
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
    assert.equal(await awaitReady(launched.process), true);
    const outcome = await launched.process.interrupt(1_000);
    assert.equal(outcome.escalated, true);
  },
);
