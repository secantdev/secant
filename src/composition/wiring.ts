import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createApplication,
  type Application,
  type RunExecution,
} from "../application/application.js";
import { openCatalog, type Catalog } from "../catalog/catalog.js";
import { DEFAULT_BUDGETS, readZip } from "../bundle/bundle.js";
import {
  executeRouting,
  type AssetResolver,
} from "../run/execution/execution.js";
import { openRunGroup, type RunGroup } from "../run/store/store.js";
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
  readonly runGroup: RunGroup;
}

/** Resolves the Secant home, opens the Catalog and the launch Workspace's Run
 *  Store, constructs the Run execution, and builds the Application with the
 *  running engine version and host platform, handing it the raw launch cwd. The
 *  caller owns `catalog` and `runGroup` and must close both. */
export function wireApplication(overrides: WiringOverrides = {}): Wiring {
  const secantHome =
    overrides.secantHome ??
    (process.env.SECANT_HOME?.trim() || join(homedir(), ".secant"));
  const launchWorkspacePath = overrides.launchCwd ?? process.cwd();
  const host = overrides.hostPlatform ?? hostPlatform(process.platform);

  const catalog = openCatalog(secantHome);
  try {
    // The Run Store groups Runs by the resolved absolute Workspace path; open it
    // against the same canonicalisation the Application applies (A6), so a fresh
    // `run show` process reaches the same group directory as the launch.
    const runGroup = openRunGroup(
      secantHome,
      realpathSync.native(launchWorkspacePath),
    );
    try {
      const application = createApplication({
        catalog,
        launchWorkspacePath,
        engineVersion: overrides.engineVersion ?? engineVersion,
        ...(host !== undefined ? { hostPlatform: host } : {}),
        runGroup,
        runExecution: makeRunExecution(catalog, secantHome, host ?? "linux"),
      });
      return { catalog, runGroup, ...application };
    } catch (error) {
      runGroup.close();
      throw error;
    }
  } catch (error) {
    // Construction can throw (e.g. the launch path no longer resolves); close
    // the Catalog we opened before rethrowing, so no caller leaks it.
    catalog.close();
    throw error;
  }
}

// The Run execution seam #81 left open: an installed Bundle's `{asset}` paths
// become on-disk paths by extracting the pinned Snapshot's bytes
// (`catalog.readManagedBytes(digest)`) under the Secant home, once per Run, then
// mapping each declared asset path to the extracted file. No pinned-Snapshot
// extraction mechanism existed before this slice, so this is the genuinely new
// wiring. `run read` returns only `text`/`verdict` in M2 (execution's
// file-materialization gap is a documented `ponytail:`).
function makeRunExecution(
  catalog: Catalog,
  secantHome: string,
  platform: Platform,
): RunExecution {
  return ({ routing, digest, owner }) => {
    const assetDir = join(secantHome, "run-assets", owner.runId);
    return executeRouting(routing, {
      owner,
      platform,
      resolveAsset: extractAssets(catalog, digest, assetDir),
    });
  };
}

/** Extract the pinned Bundle Snapshot's entries to `assetDir` and return a
 *  resolver mapping a declared asset path to its extracted on-disk path. A digest
 *  whose managed bytes are missing or do not read resolves nothing; execution
 *  then throws on the first unresolved `{asset}`, which composition owns. */
// ponytail: extracts every archive entry to a fresh per-Run directory on each
// launch — no cache by digest, no filtering to only the assets a Routing
// references. Fine at M2 Bundle sizes (a Command-only Bundle is a manifest and a
// script or two). If large payloads or many launches make this bite, extract once
// per digest into a shared `run-assets/<digest>` and resolve only declared assets.
function extractAssets(
  catalog: Catalog,
  digest: string,
  assetDir: string,
): AssetResolver {
  const bytes = catalog.readManagedBytes(digest);
  if (bytes === undefined) return () => undefined;
  const archive = readZip(bytes, DEFAULT_BUDGETS);
  if (!archive.ok) return () => undefined;
  const extracted = new Map<string, string>();
  for (const entry of archive.entries) {
    const target = join(assetDir, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
    extracted.set(entry.path, target);
  }
  return (assetPath) => {
    const path = extracted.get(assetPath);
    return path !== undefined && existsSync(path) ? path : undefined;
  };
}
