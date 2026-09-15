import type { HeadlessClients } from "../headless/headless.js";
import { wireApplication } from "./wiring.js";

// wireApplication is the one wiring path both roots take; the composition suite
// reaches it through this entry to prove both roots agree (#74 A18).
export {
  wireApplication,
  type Wiring,
  type WiringOverrides,
} from "./wiring.js";

// The composition entry: both surfaces reach the runtime through here.
// `withClients` wires the Application (see wiring.ts) and hands its Ports to the
// callback the CLI host runs, owning the Catalog's lifetime. `launchTui` is the
// TUI root, kept as a thin seam so the CLI reaches the renderer only through a
// dynamic import: the headless paths never load Solid or OpenTUI's native library.

/** Wires the composition root for one headless command, runs `fn` with the
 *  Application Interfaces, and closes the Catalog on every exit path. `fn` is
 *  awaited before the close: a Run command settles asynchronously (execution
 *  spawns), so closing the Run Store the instant `fn` returned its Promise would
 *  pull the store out from under the still-running Run.
 *
 *  It also owns the headless OS-signal exit path (#98): a headless process spawns
 *  each Run in its own detached process group, so a bare SIGINT/SIGHUP/SIGTERM
 *  would kill this process and leave the child running. The handler aborts every
 *  live Run and awaits its rest — killing the child's group and leaving the Run's
 *  Workspace claim live so the next open reconciles it `halted` (ADR 0019) — then
 *  closes the stores and re-raises the signal for the conventional exit. */
export async function withClients<T>(
  fn: (clients: HeadlessClients) => T | Promise<T>,
): Promise<Awaited<T>> {
  const { catalog, runGroup, projectionPort, bundleManagement, shutdown } =
    wireApplication();
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGHUP", "SIGTERM"];
  let signalled = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (signalled) return;
    signalled = true;
    void shutdown().finally(() => {
      runGroup.close();
      catalog.close();
      // Restore the default disposition and re-raise, so the process exits with the
      // conventional 128 + signal code rather than a fabricated one.
      for (const s of signals) process.off(s, onSignal);
      process.kill(process.pid, signal);
    });
  };
  for (const signal of signals) process.on(signal, onSignal);
  try {
    return await fn({ projectionPort, bundleManagement });
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
    // A signal handler already closed the stores (and is re-raising); closing again
    // here would double-close, so leave it to the handler on that path.
    if (!signalled) {
      runGroup.close();
      catalog.close();
    }
  }
}

/** Launches the interactive shell. The TUI runtime is imported lazily so the
 *  headless paths never reach Solid or OpenTUI's native library. */
export async function launchTui(): Promise<number> {
  const { runTuiApp } = await import("./tui-runtime.js");
  return runTuiApp();
}
