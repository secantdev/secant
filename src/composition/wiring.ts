import { homedir } from "node:os";
import { join } from "node:path";
import {
  createApplication,
  type Application,
} from "../application/application.js";
import { openCatalog, type Catalog } from "../catalog/catalog.js";
import type { Platform } from "../workflow/workflow.js";

// The one wiring path both composition roots take (#74 A1, A2, A6). Before this,
// the headless root and the TUI root each resolved the Secant home, opened the
// Catalog, and constructed the Application — and drifted: the TUI root omitted
// `engineVersion` and `hostPlatform`, so the shell ran as `0.0.0-dev` on
// `platforms[0]`. Here the wiring lives once; the raw launch path is handed to
// the Application, which owns canonicalisation (A6). The caller owns the
// Catalog's lifetime and closes it on every exit path.

// The running engine version, substituted by the Bun compile (scripts/build.ts).
// A free identifier under `bun src/cli/main.ts` (dev) and the Node test runner,
// where the dev sentinel stands in — matching cli/main.ts.
declare const __SECANT_VERSION__: string;
const engineVersion =
  typeof __SECANT_VERSION__ === "string" ? __SECANT_VERSION__ : "0.0.0-dev";

function hostPlatform(platform: NodeJS.Platform): Platform | undefined {
  switch (platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return undefined;
  }
}

/** Overrides for the composition wiring test, which drives the one path both
 *  roots take against a temporary home without a terminal (#74 A18). Production
 *  passes none: the home, cwd, engine version, and host platform come from the
 *  process. */
export interface WiringOverrides {
  readonly secantHome?: string;
  readonly launchCwd?: string;
  readonly engineVersion?: string;
  readonly hostPlatform?: Platform;
}

export interface Wiring extends Application {
  readonly catalog: Catalog;
}

/** Resolves the Secant home, opens the Catalog, and constructs the Application
 *  with the running engine version and host platform, handing it the raw launch
 *  cwd. The caller owns `catalog` and must close it. */
export function wireApplication(overrides: WiringOverrides = {}): Wiring {
  const secantHome =
    overrides.secantHome ??
    (process.env.SECANT_HOME?.trim() || join(homedir(), ".secant"));
  const launchWorkspacePath = overrides.launchCwd ?? process.cwd();
  const host = overrides.hostPlatform ?? hostPlatform(process.platform);

  const catalog = openCatalog(secantHome);
  try {
    const application = createApplication({
      catalog,
      launchWorkspacePath,
      engineVersion: overrides.engineVersion ?? engineVersion,
      ...(host !== undefined ? { hostPlatform: host } : {}),
    });
    return { catalog, ...application };
  } catch (error) {
    // Construction can throw (e.g. the launch path no longer resolves); close
    // the Catalog we opened before rethrowing, so no caller leaks it.
    catalog.close();
    throw error;
  }
}
