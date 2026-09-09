import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../application/application.js";
import { openCatalog } from "../catalog/catalog.js";
import { runHeadless } from "../headless/headless.js";

// The outer composition root wires the runtime: it resolves the Secant home and
// the launch Workspace, opens the Catalog, constructs the Application, and hands
// its Projection Port to the headless client. It owns the Catalog's lifetime and
// closes it on every exit path. A TUI child root joins here in a later slice.

/** Runs one CLI invocation past the engine gate; returns the process exit code. */
export function run(args: readonly string[]): number {
  const secantHome =
    process.env.SECANT_HOME?.trim() || join(homedir(), ".secant");
  const launchWorkspacePath = realpathSync(process.cwd());

  const catalog = openCatalog(secantHome);
  try {
    const { projectionPort } = createApplication({
      catalog,
      launchWorkspacePath,
    });
    return runHeadless(projectionPort, args, {
      out: (text) => void process.stdout.write(text),
      err: (text) => void process.stderr.write(text),
      cwd: () => process.cwd(),
    });
  } finally {
    catalog.close();
  }
}
