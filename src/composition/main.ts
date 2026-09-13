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
 *  Application Interfaces, and closes the Catalog on every exit path. */
export function withClients<T>(fn: (clients: HeadlessClients) => T): T {
  const { catalog, runGroup, projectionPort, bundleManagement } =
    wireApplication();
  try {
    return fn({ projectionPort, bundleManagement });
  } finally {
    runGroup.close();
    catalog.close();
  }
}

/** Launches the interactive shell. The TUI runtime is imported lazily so the
 *  headless paths never reach Solid or OpenTUI's native library. */
export async function launchTui(): Promise<number> {
  const { runTuiApp } = await import("./tui-runtime.js");
  return runTuiApp();
}
