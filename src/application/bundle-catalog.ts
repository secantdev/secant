import type {
  BundleOrigin,
  Catalog,
  CatalogEntry,
} from "../catalog/catalog.js";
import {
  generateExecutionSummary,
  inspectBundle,
  type BundleInspection,
  type Budgets,
} from "../bundle/bundle.js";
import {
  flattenSteps,
  type LaunchInput,
  type Platform,
  type ProducedArtifact,
  type RoutingNode,
} from "../workflow/workflow.js";
import type {
  BundleCatalogSnapshot,
  BundleFocusSelector,
  BundleFocusSnapshot,
  BundleOriginView,
  BundleStability,
  EngineRange,
  InstalledBundleFocus,
  InstalledBundleSummary,
  LaunchInputView,
  Problem,
  ProducedArtifactView,
  RoutingNodeView,
  RoutingStepView,
} from "./projection-port.js";

// The `bundle-catalog` Projection join (#54). It reads Catalog Entries and their
// managed bytes through the Catalog Interface, asks the Bundle Module to inspect
// the stored bytes and generate the Execution summary, and translates both into
// the normalized client contract. Application owns this join because it is the
// only place that imports both the Catalog and the Bundle Module; each of those
// imports only the Workflow vocabulary. No storage path, archive object, or
// SQLite type crosses: only bytes leave the Catalog, and only semantic values
// leave here.

export interface BundleCatalogDependencies {
  readonly catalog: Catalog;
  readonly budgets: Budgets;
  /** The running Secant engine version, for the "needs Secant ≥" note. */
  readonly engineVersion: string;
  /** The platform the Execution summary resolves commands for; the host when it
   *  is a supported platform, else the Bundle's first supported platform. */
  readonly hostPlatform?: Platform;
}

/** The list projection: every Installed Bundle as a row, sorted by name then
 *  version descending. */
export function listSnapshot(
  deps: BundleCatalogDependencies,
): BundleCatalogSnapshot {
  const bundles: InstalledBundleSummary[] = [];
  for (const entry of deps.catalog.listEntries()) {
    // The list row never reads composition, so skip that work per entry.
    const inspected = inspectEntry(deps, entry, false);
    if ("problem" in inspected) {
      // A managed-store file the Catalog still lists has been removed or
      // corrupted out from under us: a broken Catalog invariant across the whole
      // set. Carry it as a typed Problem the way a focus carries the same fault
      // (#74 A3), so `bundle list` prints it and exits non-zero, never a crash.
      return {
        family: "bundle-catalog",
        view: "list",
        result: { found: false, problem: inspected.problem },
      };
    }
    bundles.push(summaryOf(entry, inspected.inspection, deps));
  }
  bundles.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      -compareSemver(a.version, b.version) ||
      a.id.localeCompare(b.id),
  );
  return {
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles },
  };
}

/** The focus projection: the exact inspection of one Installed Bundle, or a
 *  Problem when the selection matches nothing or its stored bytes are gone. */
export function focusSnapshot(
  deps: BundleCatalogDependencies,
  selection: BundleFocusSelector,
): BundleFocusSnapshot {
  const problem = (problem: Problem): BundleFocusSnapshot => ({
    family: "bundle-catalog",
    view: "focus",
    selection,
    result: { found: false, problem },
  });

  const found = selectEntry(deps.catalog.listEntries(), selection);
  if ("problem" in found) return problem(found.problem);

  const inspected = inspectEntry(deps, found.entry, true);
  // Inspecting one named Bundle whose bytes are gone is a typed Problem, not a
  // crash (docs/agents/validation.md): the focus channel already carries it.
  if ("problem" in inspected) return problem(inspected.problem);

  return {
    family: "bundle-catalog",
    view: "focus",
    selection,
    result: {
      found: true,
      bundle: focusOf(found.entry, inspected.inspection, deps),
    },
  };
}

// --- entry selection & reading ---------------------------------------------

function selectEntry(
  entries: readonly CatalogEntry[],
  selection: BundleFocusSelector,
): { entry: CatalogEntry } | { problem: Problem } {
  const matching = entries.filter((entry) => entry.id === selection.id);
  if (matching.length === 0) {
    return { problem: bundleNotInstalled(selection.id) };
  }
  if (selection.version !== undefined) {
    const exact = matching.find((entry) => entry.version === selection.version);
    return exact
      ? { entry: exact }
      : { problem: versionNotInstalled(selection.id, selection.version) };
  }
  // Version omitted: the highest stable installed version; a prerelease must be
  // named (#9, #49). With no stable version installed, there is nothing to pick.
  const stable = matching
    .filter((entry) => stabilityOf(entry.version) === "stable")
    .sort((a, b) => -compareSemver(a.version, b.version));
  return stable.length > 0
    ? { entry: stable[0] }
    : { problem: noStableVersion(selection.id) };
}

// Read and inspect one Installed Bundle's stored bytes. A missing or unreadable
// store file — the Catalog lists an Entry whose digest-named bytes are gone — is
// translated to a typed Problem here at the Catalog→Application Seam; the caller
// decides whether that fails a whole-set list or is a single focus's answer.
function inspectEntry(
  deps: BundleCatalogDependencies,
  entry: CatalogEntry,
  includeComposition: boolean,
): { inspection: BundleInspection } | { problem: Problem } {
  const bytes = deps.catalog.readManagedBytes(entry.digest);
  if (bytes === undefined) {
    return { problem: managedBytesMissing(entry) };
  }
  const outcome = inspectBundle(bytes, deps.budgets, includeComposition);
  if (!outcome.ok) {
    return { problem: managedBytesCorrupt(entry, outcome.finding.code) };
  }
  return { inspection: outcome.inspection };
}

// --- translation to the client contract ------------------------------------

function summaryOf(
  entry: CatalogEntry,
  inspection: BundleInspection,
  deps: BundleCatalogDependencies,
): InstalledBundleSummary {
  const { bundle } = inspection.manifest;
  return {
    id: entry.id,
    version: entry.version,
    digest: entry.digest,
    name: bundle.name,
    description: bundle.description,
    origin: originView(entry.origin),
    stability: stabilityOf(entry.version),
    platforms: inspection.platforms,
    engine: engineRange(inspection.engine, deps.engineVersion),
    // M1 origins are all local (External Bundles), which are not yet trusted;
    // no trust action exists (#9, #49). Built-in trust lands with M6 origins.
    trust: { state: "not-yet-trusted" },
  };
}

function focusOf(
  entry: CatalogEntry,
  inspection: BundleInspection,
  deps: BundleCatalogDependencies,
): InstalledBundleFocus {
  const summary = summaryOf(entry, inspection, deps);
  const { manifest } = inspection;
  const { bundle } = manifest;
  const platform = selectPlatform(deps.hostPlatform, inspection.platforms);
  const executionCore = generateExecutionSummary(
    manifest,
    inspection.digest,
    platform,
  );
  return {
    ...summary,
    author: {
      ...(bundle.authors ? { authors: bundle.authors } : {}),
      ...(bundle.license !== undefined ? { license: bundle.license } : {}),
      ...(bundle.homepage !== undefined ? { homepage: bundle.homepage } : {}),
      ...(bundle.repository !== undefined
        ? { repository: bundle.repository }
        : {}),
      ...(bundle.keywords ? { keywords: bundle.keywords } : {}),
      ...(bundle.notices ? { notices: bundle.notices } : {}),
    },
    launchInputs: launchInputViews(manifest.inputs),
    routing: routingViews(manifest.routing),
    workspacePrerequisites: prerequisitesOf(manifest.routing),
    producedArtifacts: producedViews(manifest.routing),
    executionSummary: { ...executionCore, origin: summary.origin },
    compositionFindings: inspection.composition.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      target: finding.target,
      explanation: finding.explanation,
    })),
  };
}

function originView(origin: BundleOrigin): BundleOriginView {
  return origin.kind === "local-build"
    ? { kind: "local-build", location: origin.folder }
    : { kind: "local-file", location: origin.path };
}

function launchInputViews(
  inputs: Readonly<Record<string, LaunchInput>>,
): readonly LaunchInputView[] {
  return Object.entries(inputs).map(([name, input]) => ({
    name,
    type: input.type,
    description: input.description,
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
    ...(input.choices ? { choices: input.choices } : {}),
  }));
}

function routingViews(
  routing: readonly RoutingNode[],
): readonly RoutingNodeView[] {
  return routing.map((node) => {
    if ("repeat" in node) {
      return {
        node: "repeat",
        until: node.repeat.until,
        reviewCheckpoint: {
          interval: node.repeat.reviewCheckpoint.interval,
          message: node.repeat.reviewCheckpoint.message,
        },
        steps: node.repeat.steps.map(stepView),
      };
    }
    return { node: "step", step: stepView(node) };
  });
}

function stepView(step: {
  id: string;
  kind: RoutingStepView["kind"];
}): RoutingStepView {
  return { id: step.id, kind: step.kind };
}

function prerequisitesOf(routing: readonly RoutingNode[]): readonly string[] {
  const seen = new Set<string>();
  for (const step of flattenSteps(routing)) {
    for (const prerequisite of step.prerequisites ?? []) seen.add(prerequisite);
  }
  return [...seen].sort();
}

function producedViews(
  routing: readonly RoutingNode[],
): readonly ProducedArtifactView[] {
  const views: ProducedArtifactView[] = [];
  for (const step of flattenSteps(routing)) {
    for (const produced of step.produces ?? []) {
      views.push(producedView(produced, step.id));
    }
  }
  return views;
}

function producedView(
  produced: ProducedArtifact,
  producedBy: string,
): ProducedArtifactView {
  return {
    name: produced.name,
    type: produced.type,
    home: produced.home ?? "store",
    ...(produced.path !== undefined ? { path: produced.path } : {}),
    producedBy,
  };
}

function selectPlatform(
  host: Platform | undefined,
  platforms: readonly Platform[],
): Platform {
  if (host !== undefined && platforms.includes(host)) return host;
  return platforms[0] ?? "linux";
}

// --- version facts ---------------------------------------------------------

function stabilityOf(version: string): BundleStability {
  // A SemVer prerelease is the `-` segment before any `+` build metadata; build
  // metadata alone (which may itself contain `-`) does not make a prerelease.
  return version.split("+")[0].includes("-") ? "prerelease" : "stable";
}

function engineRange(engine: string, engineVersion: string): EngineRange {
  const floor = engine.slice(">=".length);
  const satisfied = compareSemver(engineVersion, floor) >= 0;
  const [major, minor] = core3(floor);
  return {
    range: engine,
    satisfied,
    ...(satisfied ? {} : { note: `needs Secant ≥ ${major}.${minor}` }),
  };
}

function core3(version: string): [number, number, number] {
  const core = version.split("+")[0].split("-")[0];
  const parts = core.split(".").map((part) => {
    const value = Number(part);
    return Number.isFinite(value) ? value : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

// ponytail: a pragmatic SemVer compare — numeric core, then stable outranks a
// prerelease, then a dotted-identifier compare for two prereleases. Enough for
// sorting rows and picking the highest stable; swap in a full spec comparator if
// prerelease ordering ever needs the numeric-vs-alphanumeric identifier rules.
function compareSemver(a: string, b: string): number {
  const ac = core3(a);
  const bc = core3(b);
  for (let i = 0; i < 3; i++) {
    if (ac[i] !== bc[i]) return ac[i] - bc[i];
  }
  const ap = prerelease(a);
  const bp = prerelease(b);
  if (ap === undefined && bp === undefined) return 0;
  if (ap === undefined) return 1; // a is stable, outranks a prerelease
  if (bp === undefined) return -1;
  return ap === bp ? 0 : ap < bp ? -1 : 1;
}

function prerelease(version: string): string | undefined {
  const core = version.split("+")[0];
  const dash = core.indexOf("-");
  return dash === -1 ? undefined : core.slice(dash + 1);
}

// --- problems --------------------------------------------------------------

function bundleNotInstalled(id: string): Problem {
  return {
    code: "bundle-not-installed",
    explanation: `No Bundle with id ${id} is installed.`,
    remediation:
      "Run `secant bundle list` to see installed Bundles, then inspect one by its id.",
    possibleEffects: "none",
    details: { id },
  };
}

function versionNotInstalled(id: string, version: string): Problem {
  return {
    code: "bundle-version-not-installed",
    explanation: `${id}@${version} is not installed.`,
    remediation:
      "Run `secant bundle list` to see the installed versions, then name one that is installed.",
    possibleEffects: "none",
    details: { id, version },
  };
}

function noStableVersion(id: string): Problem {
  return {
    code: "no-stable-version-installed",
    explanation: `Only prerelease versions of ${id} are installed; a prerelease must be named explicitly.`,
    remediation:
      "Run `secant bundle inspect <id>@<version>` naming a prerelease.",
    possibleEffects: "none",
    details: { id },
  };
}

function managedBytesMissing(entry: CatalogEntry): Problem {
  return {
    code: "bundle-bytes-missing",
    explanation: `${entry.id}@${entry.version} is recorded as installed, but its stored bytes are missing.`,
    remediation:
      "Reinstall the Bundle to restore its bytes, or remove the stale Catalog Entry.",
    possibleEffects: "none",
    details: { id: entry.id, version: entry.version },
  };
}

function managedBytesCorrupt(
  entry: CatalogEntry,
  findingCode: string,
): Problem {
  return {
    code: "bundle-bytes-corrupt",
    explanation: `${entry.id}@${entry.version} is installed, but its stored bytes no longer validate (${findingCode}).`,
    remediation: "Reinstall the Bundle to restore intact bytes.",
    possibleEffects: "none",
    details: { id: entry.id, version: entry.version, finding: findingCode },
  };
}
