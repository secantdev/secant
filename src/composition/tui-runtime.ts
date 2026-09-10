import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../application/application.js";
import { openCatalog } from "../catalog/catalog.js";
import {
  createProcessStdinRelease,
  createProductionRenderer,
  createTeardown,
} from "../tui/renderer/renderer.js";
import { mountTui } from "../tui/tui.js";

// The TUI child composition root: it opens the Catalog, constructs the
// Application, creates the production renderer, mounts the shell, and owns the
// single teardown site through every exit path — quit binding, Ctrl+C, SIGHUP,
// SIGTERM, render failure, and unhandled error. `process.exit` is never called
// on the normal path; the returned code becomes `process.exitCode`. Reached only
// in the FFI re-exec'd child, so `createCliRenderer` and its native library are
// safe to touch here — and OpenTUI's ESM has already resolved from the installed
// package by the time the no-terminal case rejects, which is what the no-TTY
// package smoke proves.

// The precise startup Problem when there is no interactive terminal. Kept stable
// so CI's no-TTY package smoke can assert on it (ADR 0027).
export const NO_TTY_PROBLEM = {
  code: "no-interactive-terminal",
  explanation:
    "Secant's interactive shell needs an interactive terminal, but stdin or stdout is not a TTY.",
  remediation:
    "Run `secant` in a terminal, or use a headless command such as `secant workspace`.",
} as const;

export async function runTuiApp(): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      `Error [${NO_TTY_PROBLEM.code}]: ${NO_TTY_PROBLEM.explanation}\n`,
    );
    process.stderr.write(`Remediation: ${NO_TTY_PROBLEM.remediation}\n`);
    return 1;
  }

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
    const teardown = createTeardown(createProcessStdinRelease(), port);

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
