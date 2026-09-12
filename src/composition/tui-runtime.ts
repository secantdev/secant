import { appendFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../application/application.js";
import { openCatalog } from "../catalog/catalog.js";
import {
  conhostConsoleProbe,
  createProcessStdinRelease,
  createProductionRenderer,
  createTeardown,
  printConhostNotice,
} from "../tui/renderer/renderer.js";
import { mountTui } from "../tui/tui.js";

// The TUI composition root: it opens the Catalog, constructs the Application,
// creates the production renderer, mounts the shell, and owns the single
// teardown site through every exit path — quit binding, Ctrl+C, SIGHUP,
// SIGTERM, render failure, and unhandled error. `process.exit` is never called
// on the normal path; the returned code becomes `process.exitCode`. Runs
// in-process under the compiled binary, which carries OpenTUI's native library;
// the no-terminal case rejects before the renderer is created, which is what the
// no-TTY smoke proves.

// The precise startup Problem when there is no interactive terminal. Kept stable
// so CI's no-TTY package smoke can assert on it (ADR 0027).
export const NO_TTY_PROBLEM = {
  code: "no-interactive-terminal",
  explanation:
    "Secant's interactive shell needs an interactive terminal, but stdin or stdout is not a TTY.",
  remediation:
    "Run `secant` in a terminal, or use a headless command such as `secant workspace`.",
} as const;

// A test-only diagnostic side channel for the real-terminal lifecycle suite
// (#56). When SECANT_TERMINAL_LOG names a file, the shell appends `ready` once
// mounted and `teardown` when the single teardown runs, so the suite reads
// readiness and the exactly-once teardown from a file instead of scraping the
// PTY stream — unreadable under ConPTY on Windows, where the shell's own output
// is absorbed into the alternate-screen buffer. Unset in production: a no-op.
// node:fs only, never a Bun API, so it stays outside the runtime-neutrality
// allowlist.
function recordTerminalEvent(line: string): void {
  const path = process.env.SECANT_TERMINAL_LOG;
  if (path) appendFileSync(path, `${line}\n`);
}

export async function runTuiApp(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      `Error [${NO_TTY_PROBLEM.code}]: ${NO_TTY_PROBLEM.explanation}\n`,
    );
    process.stderr.write(`Remediation: ${NO_TTY_PROBLEM.remediation}\n`);
    return 1;
  }

  // The one named seam for the legacy-conhost notice: after the no-TTY
  // rejection, before the renderer is created. Suppressed everywhere but a
  // visible conhost window (see conhost-notice.ts). To stdout, not stderr: the
  // gate above guarantees stdout is the (visible) console TTY, whereas stderr
  // may be redirected — so this is where the warning is certain to be seen.
  printConhostNotice(
    conhostConsoleProbe,
    (text) => process.stdout.write(text),
    process.env.WT_SESSION !== undefined,
  );

  const secantHome =
    process.env.SECANT_HOME?.trim() || join(homedir(), ".secant");
  const launchWorkspacePath = realpathSync.native(process.cwd());
  const catalog = openCatalog(secantHome);
  try {
    const { projectionPort } = createApplication({
      catalog,
      launchWorkspacePath,
    });
    const { port, renderer } = await createProductionRenderer();
    // The diagnostic records the single teardown from createTeardown's own
    // once-guard, so it sees one `teardown` no matter how many exit paths fire.
    const teardown = createTeardown(createProcessStdinRelease(), port, () =>
      recordTerminalEvent("teardown"),
    );

    let epilogue: string | undefined;
    let failure: unknown;
    let resolveShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    // Resolving a settled Promise is a no-op, so no extra guard is needed; the
    // teardown itself is the once-only gate.
    const finish = (reason?: unknown) => {
      if (reason instanceof Error && failure === undefined) failure = reason;
      teardown();
      resolveShutdown();
    };

    // The composition root owns every OS-signal exit path (the renderer's own
    // handlers are disabled). Each runs the teardown in the required order.
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGHUP", "SIGTERM"];
    const onSignal = () => finish();
    for (const signal of signals) process.on(signal, onSignal);

    try {
      await mountTui(renderer, {
        projectionPort,
        exit: (reason) => finish(reason),
        onEpilogue: (value) => {
          epilogue = value;
        },
      });
      // Mounted: the renderer holds the terminal in raw mode and Home's quit
      // bindings are live, so the suite may now drive an exit path.
      recordTerminalEvent("ready");
      await shutdown;
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    } finally {
      for (const signal of signals) process.off(signal, onSignal);
      teardown();
    }

    // Print any epilogue or error to the restored terminal, after teardown.
    if (failure !== undefined) {
      const message =
        failure instanceof Error
          ? (failure.stack ?? failure.message)
          : String(failure);
      process.stderr.write(`${message}\n`);
      return 1;
    }
    if (epilogue !== undefined) process.stdout.write(`${epilogue}\n`);
    return 0;
  } finally {
    catalog.close();
  }
}
