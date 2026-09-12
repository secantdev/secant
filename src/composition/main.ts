import { runHeadless } from "../headless/headless.js";
import { wireApplication } from "./wiring.js";

// wireApplication is the one wiring path both roots take; the composition suite
// reaches it through this entry to prove both roots agree (#74 A18).
export {
  wireApplication,
  type Wiring,
  type WiringOverrides,
} from "./wiring.js";

// The composition entry: both surfaces reach the runtime through here. `run`
// wires the Application (see wiring.ts) and hands its Ports to the headless
// client, owning the Catalog's lifetime. `launchTui` is the TUI root, kept as a
// thin seam so the CLI reaches the renderer only through a dynamic import: the
// headless paths never load Solid or OpenTUI's native library.

/** Runs one headless CLI invocation; returns the process exit code. */
export function run(args: readonly string[]): number {
  const { catalog, projectionPort, bundleManagement } = wireApplication();
  try {
    return runHeadless({ projectionPort, bundleManagement }, args, {
      out: (text) => void process.stdout.write(text),
      err: (text) => void process.stderr.write(text),
      cwd: () => process.cwd(),
    });
  } finally {
    catalog.close();
  }
}

/** Launches the interactive shell. The TUI runtime is imported lazily so the
 *  headless paths never reach Solid or OpenTUI's native library. */
export async function launchTui(): Promise<number> {
  const { runTuiApp } = await import("./tui-runtime.js");
  return runTuiApp();
}
