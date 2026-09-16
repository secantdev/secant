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
import {
  DEFAULT_BUDGETS,
  inspectBundle,
  readBundleAssets,
} from "../bundle/bundle.js";
import {
  executeRouting,
  type AssetResolver,
  type HarnessExecutionDeps,
} from "../run/execution/execution.js";
import { openRunGroup, type RunGroup } from "../run/store/store.js";
import {
  createClaudeCodeAdapter,
  type HarnessAdapter,
} from "../harness/harness.js";
import {
  type ArtifactType,
  type AssetKind,
  type Platform,
  type RoutingNode,
} from "../workflow/workflow.js";

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
  /** The Harness Adapter the Run execution drives an Agent Step through (#116).
   *  Production constructs the Claude Code Adapter here; a test injects one wired
   *  over the replayer (a fixed session id, a temp-PATH executable). */
  readonly harnessAdapter?: HarnessAdapter;
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
        // The headless client cannot relay human turn-taking; an interactive-agent
        // Bundle is refused at Preflight (#116). The TUI root sets this true later.
        supportsInteractiveTurns: false,
        runExecution: makeRunExecution(
          catalog,
          host ?? "linux",
          overrides.harnessAdapter ?? createClaudeCodeAdapter(),
        ),
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
function makeRunExecution(
  catalog: Catalog,
  platform: Platform,
  adapter: HarnessAdapter,
): RunExecution {
  return async ({ routing, digest, owner, cancelSignal }) => {
    const deps = {
      owner,
      platform,
      resolveAsset: treeResolver(catalog, digest),
      // The Application's per-Run cancel Seam (#98): an abort kills the child's
      // process group and unwinds execution, and the Application decides the rest.
      ...(cancelSignal !== undefined ? { cancelSignal } : {}),
    };
    // A Command-only Run needs no Harness. A Bundle carrying an Agent Step prepares
    // one once, reused across every Agent Step of the Run, and closes it when the
    // Run rests — the ownership ADR 0022 requires to transfer exactly once to the
    // Run (#116). Preflight already proved the executable resolves, so a prepare
    // failure here is an environment fault that surfaces as a run-execution fault.
    if (!routing.some(needsHarness)) return executeRouting(routing, deps);
    const facts = harnessFacts(catalog, digest);
    const prepared = await adapter.prepare({
      workspace: owner.record.workspacePath,
    });
    if (!prepared.ok) {
      throw new Error(
        `composition: could not prepare the Harness: ${prepared.failure.category}.`,
      );
    }
    const harness: HarnessExecutionDeps = {
      prepared: prepared.harness,
      inputTypes: facts.inputTypes,
      assetKinds: facts.assetKinds,
    };
    try {
      return await executeRouting(routing, { ...deps, harness });
    } finally {
      await prepared.harness.close();
    }
  };
}

/** Whether a Routing node carries a Step kind that needs a Harness (an Agent or
 *  interactive-agent Step, top-level or inside a Repeat group). */
function needsHarness(node: RoutingNode): boolean {
  const steps = "repeat" in node ? node.repeat.steps : [node];
  return steps.some(
    (step) => step.kind === "agent" || step.kind === "interactive-agent",
  );
}

/** The manifest facts Agent-prompt rendering resolves against (#116): each Launch
 *  input's declared type and each declared asset's kind, re-derived from the pinned
 *  Snapshot's stored bytes by digest. A read/inspect failure here is an environment
 *  fault (the bytes Preflight just validated are gone or corrupt) — it throws rather
 *  than return empty maps, which would silently render a `file` slot as plain text.
 *  ponytail: these facts are re-derived here rather than threaded from Preflight's
 *  composition re-check, to keep the Harness plumbing out of the Application/
 *  RunExecution seam; the cost is one extra inspect per Agent-bearing Run. Thread
 *  them through if that inspect ever shows up. */
function harnessFacts(
  catalog: Catalog,
  digest: string,
): {
  inputTypes: Record<string, ArtifactType>;
  assetKinds: Record<string, AssetKind>;
} {
  const inputTypes: Record<string, ArtifactType> = {};
  const assetKinds: Record<string, AssetKind> = {};
  const bytes = catalog.readManagedBytes(digest);
  if (bytes === undefined) {
    throw new Error(
      `composition: the pinned Bundle (digest ${digest}) has no stored bytes at execution.`,
    );
  }
  const inspected = inspectBundle(bytes, DEFAULT_BUDGETS, false);
  if (!inspected.ok) {
    throw new Error(
      `composition: the pinned Bundle (digest ${digest}) no longer inspects: ${inspected.finding.code}.`,
    );
  }
  const { manifest } = inspected.inspection;
  for (const [name, input] of Object.entries(manifest.inputs)) {
    inputTypes[name] = input.type;
  }
  for (const asset of manifest.assets) {
    assetKinds[asset.path] = asset.kind;
  }
  return { inputTypes, assetKinds };
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
