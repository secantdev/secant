#!/usr/bin/env bun
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS, hostTargetKey } from "../../scripts/targets.js";
import { removeTempDir, runMain, withTimeout } from "../helpers/standalone.js";

// The real-terminal lifecycle suite (#56). It runs the compiled shell under a
// throwaway pseudo-terminal driven by `Bun.Terminal` (ConPTY on Windows) and
// proves exactly one class: a terminal left broken after exit. For each exit
// path — the quit binding, Ctrl+C, and SIGHUP where the platform supports it —
// it asserts the exit code, that the single teardown ran exactly once, and that
// the terminal modes were restored. It is NOT a presentation test: it never
// checks what the shell drew, only that it handed the terminal back intact.
//
// It is deliberately outside the deterministic `bun test` suite (this file has
// no `.test` suffix, so bare `bun test` never discovers it) and runs as its own
// blocking three-OS CI job under the pinned Bun, against the cross-compiled
// binary for that OS (ADR 0027, as amended by ADR 0030). `Bun.Terminal` lives
// only here under `tests/`, which the runtime-neutrality allowlist does not gate.

// `Bun.Terminal` is not typed in @types/bun@1.4.2 (ADR 0030); declare the shape
// this suite touches locally and cast at the one spawn site.
interface PtyTerminal {
  write(data: string): void;
  close(): void;
  /** POSIX c_lflag; always 0 on Windows (ConPTY has no termios). */
  readonly localFlags: number;
}
interface PtyProcess {
  readonly terminal: PtyTerminal;
  readonly exited: Promise<number>;
  kill(signal?: string | number): void;
}
type PtySpawn = (
  command: string[],
  options: {
    terminal: {
      cols: number;
      rows: number;
      data: (terminal: PtyTerminal, chunk: Uint8Array) => void;
    };
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
) => PtyProcess;
const spawnPty = Bun.spawn as unknown as PtySpawn;

const IS_WINDOWS = process.platform === "win32";
// c_lflag ECHO is 0x8 on both Linux and macOS. Raw mode clears it while the
// shell holds the terminal; a restored terminal has it set again.
const ECHO = 0x8;

// The teardown restores whatever it entered. We assert the invariant as pairs —
// every enable seen on the wire has its matching disable. These are the three
// modes createProductionRenderer enters (it sets useMouse:false, so no
// mouse-tracking modes appear), and the #6 prototype verified ConPTY forwards
// all three resets on Windows, so the check is unconditional on every OS.
const MODE_PAIRS = [
  { name: "alternate screen", enable: "\x1b[?1049h", disable: "\x1b[?1049l" },
  { name: "cursor visibility", enable: "\x1b[?25l", disable: "\x1b[?25h" },
  { name: "bracketed paste", enable: "\x1b[?2004h", disable: "\x1b[?2004l" },
];

function assertRestoredModes(label: string, output: string): void {
  let modesEntered = 0;
  for (const pair of MODE_PAIRS) {
    if (!output.includes(pair.enable)) continue;
    modesEntered++;
    assert.ok(
      output.includes(pair.disable),
      `${label}: terminal left broken — ${pair.name} was enabled but never restored`,
    );
  }
  // Guard against a vacuous pass: a shell that never drew entered no modes, so
  // "restored everything it entered" would be trivially true.
  assert.ok(
    modesEntered > 0,
    `${label}: the shell entered no terminal modes, so restoration cannot be proven`,
  );
}

// After the child exits, the last teardown bytes it wrote may still be draining
// through the pty to our `data` callback. Wait for the byte count to stop
// growing before asserting on the output — a bounded quiet interval, not a
// fixed sleep, so the restored-mode check never races the final flush.
async function settleOutput(read: () => string): Promise<void> {
  const deadline = Date.now() + 2_000;
  let previous = -1;
  for (;;) {
    const current = read().length;
    if (current === previous) return;
    previous = current;
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function waitForReady(logPath: string, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (existsSync(logPath) && readFileSync(logPath, "utf8").includes("ready"))
      return;
    if (Date.now() > deadline) {
      throw new Error(`${label}: the shell did not signal ready within 20s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Approve the Workspace headlessly so the launched shell reaches interactive Home.
 *  This is the suite's first spawn of the freshly-downloaded binary, and on Windows
 *  the very first execution of a just-written `.exe` can transiently fail while
 *  Defender scans and briefly locks it (spawn reports no exit status and empty
 *  output) — the same lingering-lock class removeTempDir already retries here (#64).
 *  `workspace approve` is idempotent (ADR 0021), so retrying a partial run is safe;
 *  the failing status/error/output is surfaced only after the bounded retries. */
function approveWorkspace(
  binary: string,
  cwd: string,
  env: Record<string, string | undefined>,
): void {
  let last: ReturnType<typeof spawnSync> | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = spawnSync(binary, ["workspace", "approve"], {
      cwd,
      env,
      encoding: "utf8",
    });
    if (result.status === 0) return;
    last = result;
    Bun.sleepSync(50);
  }
  throw new Error(
    `workspace approve failed after retries (status ${last?.status}):\n` +
      `${last?.error?.message ?? ""}\n${last?.stdout}\n${last?.stderr}`,
  );
}

type Drive = (proc: PtyProcess) => void;

async function runScenario(
  label: string,
  binary: string,
  drive: Drive,
  expectedExit = 0,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "secant-terminal-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "secant-terminal-ws-"));
  const logPath = join(
    mkdtempSync(join(tmpdir(), "secant-terminal-log-")),
    "log",
  );
  const env = {
    ...process.env,
    SECANT_HOME: home,
    SECANT_TERMINAL_LOG: logPath,
  };
  const cleanup = [home, workspace, dirname(logPath)];

  let output = "";
  let proc: PtyProcess | undefined;
  try {
    approveWorkspace(binary, workspace, env);

    proc = spawnPty([binary], {
      cwd: workspace,
      env,
      terminal: {
        cols: 80,
        rows: 24,
        data: (_terminal, chunk) => {
          // latin1 preserves the raw bytes so escape sequences match exactly.
          output += Buffer.from(chunk).toString("latin1");
        },
      },
    });

    await waitForReady(logPath, label);
    // POSIX only: the shell holds the terminal in raw mode now, so ECHO is off.
    const rawEchoOff = IS_WINDOWS || (proc.terminal.localFlags & ECHO) === 0;

    drive(proc);

    const exitCode = await withTimeout(
      proc.exited,
      20_000,
      `${label}: the shell did not exit after the ${label} signal`,
    );
    assert.equal(
      exitCode,
      expectedExit,
      `${label}: expected exit code ${expectedExit}, got ${exitCode}`,
    );

    await settleOutput(() => output);

    // Restored terminal modes. On POSIX we read them straight off the PTY's
    // termios; the wire pair-invariant corroborates on every OS.
    if (!IS_WINDOWS) {
      assert.ok(
        rawEchoOff,
        `${label}: the shell never entered raw mode, so restoration is vacuous`,
      );
      assert.notEqual(
        proc.terminal.localFlags & ECHO,
        0,
        `${label}: terminal left broken — ECHO was not restored`,
      );
    }
    assertRestoredModes(label, output);

    // Exactly one teardown across the exit path (the composition root's single
    // teardown site, recorded once via the diagnostic side channel).
    const teardownCount = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line === "teardown").length;
    assert.equal(
      teardownCount,
      1,
      `${label}: expected exactly one teardown, saw ${teardownCount}`,
    );

    console.log(`  ok  ${label}`);
  } finally {
    try {
      proc?.terminal.close();
    } catch {
      // Best-effort: the child has already exited by here.
    }
    for (const directory of cleanup) await removeTempDir(directory);
  }
}

function resolveBinary(): string {
  if (process.argv[2]) return resolve(process.argv[2]);
  const key = hostTargetKey(process.platform, process.arch);
  if (key === undefined) {
    throw new Error(
      `No gated target for ${process.platform}-${process.arch}; pass a binary path as the first argument.`,
    );
  }
  const projectRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const binary = join(projectRoot, "dist", TARGETS[key].outfile);
  if (!existsSync(binary)) {
    throw new Error(
      `Compiled binary not found at ${binary}. Run \`bun run build\` first, or pass a binary path.`,
    );
  }
  return binary;
}

async function main(): Promise<void> {
  const binary = resolveBinary();
  console.log(`Real-terminal lifecycle suite against ${binary}`);

  // The quit binding and Ctrl+C are keypresses (OpenTUI's raw mode disables
  // ISIG, so \x03 reaches the app as a key, not SIGINT); SIGHUP is a real OS
  // signal to the child. All three drive the one teardown site to a clean exit.
  await runScenario("quit binding (q)", binary, (proc) =>
    proc.terminal.write("q"),
  );
  await runScenario("Ctrl+C", binary, (proc) => proc.terminal.write("\x03"));
  if (!IS_WINDOWS) {
    // SIGHUP has no portable equivalent under ConPTY, so it is POSIX-only.
    await runScenario("SIGHUP", binary, (proc) => proc.kill("SIGHUP"));
  }

  console.log("Real-terminal lifecycle suite passed.");
}

runMain(main);
