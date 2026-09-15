import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  canonicalizeWorkspacePath,
  createApplication,
  type Application,
  type RunExecution,
} from "../application/application.js";
import { openCatalog, type Catalog } from "../catalog/catalog.js";
import { DEFAULT_BUDGETS, readBundleAssets } from "../bundle/bundle.js";
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

  // The Catalog derives each installed digest's read-only asset tree through the
  // Bundle Module's reader, injected here so Catalog keeps depending only on the
  // Workflow vocabulary (#100, A8).
  const catalog = openCatalog(secantHome, {
    readAssets: (bytes) => readBundleAssets(bytes, DEFAULT_BUDGETS),
  });
  // Sweep the per-Run extraction directory earlier releases wrote under the home;
  // Runs copy nothing now.
  rmSync(join(secantHome, "run-assets"), { recursive: true, force: true });
  try {
    // The Run Store groups Runs by the resolved absolute Workspace path; open it
    // against the same canonicalisation the Application applies (A6, A20), through
    // the one exported canonicaliser rather than a second `realpathSync.native`
    // site, so a fresh `run show` process reaches the same group directory as the
    // launch.
    const runGroup = openRunGroup(
      secantHome,
      canonicalizeWorkspacePath(launchWorkspacePath),
    );
    try {
      const application = createApplication({
        catalog,
        launchWorkspacePath,
        engineVersion: overrides.engineVersion ?? engineVersion,
        ...(host !== undefined ? { hostPlatform: host } : {}),
        runGroup,
        runExecution: makeRunExecution(catalog, host ?? "linux"),
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
// become on-disk paths under the Catalog's digest-named asset tree — extracted
// once at install, shared by every Run of that digest, and re-derived by the
// Catalog when missing (#100, A8). A Run copies nothing. `run read` returns only
// `text`/`verdict` in M2 (execution's file-materialization gap is a documented
// `ponytail:`).
function makeRunExecution(catalog: Catalog, platform: Platform): RunExecution {
  return ({ routing, digest, owner, cancelSignal }) =>
    executeRouting(routing, {
      owner,
      platform,
      resolveAsset: treeResolver(catalog, digest),
      // The Application's per-Run cancel Seam (#98): an abort kills the child's
      // process group and unwinds execution, and the Application decides the rest.
      ...(cancelSignal !== undefined ? { cancelSignal } : {}),
    });
}

/** A resolver mapping a declared asset path to its file in the digest's asset
 *  tree. A digest whose managed bytes are missing resolves nothing; so does a
 *  path that escapes the tree or names no file in it. Execution then throws on
 *  the first unresolved `{asset}`, which composition owns. */
function treeResolver(catalog: Catalog, digest: string): AssetResolver {
  const root = catalog.assetRoot(digest);
  if (root === undefined) return () => undefined;
  return (assetPath) => {
    const target = resolve(root, assetPath);
    if (!target.startsWith(root + sep)) return undefined;
    return existsSync(target) ? target : undefined;
  };
}
