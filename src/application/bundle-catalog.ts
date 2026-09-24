import semver from "semver";
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
  BundleTrustState,
  EngineRange,
  InstalledBundleFocus,
  InstalledBundleSummary,
  LaunchInputView,
  Problem,
  ProducedArtifactView,
  RoutingNodeView,
  RoutingStepView,
} from "./projection-port.js";
import { bundleBytesCorrupt, bundleBytesMissing } from "./problems.js";
import { selectInstalledEntry } from "./entry-selection.js";
import { selectPlatform } from "./select-platform.js";

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
  /** The digests the running Secant ships (the startup ensure's result), for the
   *  catalog's shipped marker. */
  readonly shipped?: ReadonlySet<string>;
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
      semver.rcompare(a.version, b.version) ||
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
  // Through the one selector shared with the Run join (#98 A18): an omitted version
  // is the highest stable installed version; a prerelease must be named (#9, #49).
  return selectInstalledEntry(entries, selection.id, selection.version);
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
    return {
      problem: bundleBytesMissing({
        digest: entry.digest,
        id: entry.id,
        version: entry.version,
      }),
    };
  }
  const outcome = inspectBundle(bytes, deps.budgets, includeComposition);
  if (!outcome.ok) {
    return {
      problem: bundleBytesCorrupt(
        { digest: entry.digest, id: entry.id, version: entry.version },
        outcome.finding.code,
      ),
    };
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
    shippedWithRunningSecant:
      entry.origin.kind === "built-in" &&
      (deps.shipped?.has(entry.digest) ?? false),
    stability:
      semver.prerelease(entry.version) === null ? "stable" : "prerelease",
    platforms: inspection.platforms,
    engine: engineRange(inspection.engine, deps.engineVersion),
    trust: trustState(deps.catalog, entry),
  };
}

// Trust is read from the Catalog's recorded grant for this exact installed
// digest (#78), never derived from anything the Bundle declares. No grant reads
// as not-yet-trusted. A built-in's grant is the one the startup ensure recorded,
// so it reads as the app-release trust it carries (ADR 0029).
function trustState(catalog: Catalog, entry: CatalogEntry): BundleTrustState {
  const grant = catalog.getTrustGrant(
    entry.digest,
    entry.installationGeneration,
  );
  if (grant === undefined) return { state: "not-yet-trusted" };
  if (entry.origin.kind === "built-in") return { state: "app-release" };
  return {
    state: "trusted",
    operationId: grant.operationId,
    grantedAt: grant.grantedAt,
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
  const platform = selectPlatform(inspection.platforms, deps.hostPlatform);
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

/** The client view of an Entry's origin; the Execution summary shares it. */
export function originView(origin: BundleOrigin): BundleOriginView {
  switch (origin.kind) {
    case "local-build":
      return { kind: "local-build", location: origin.folder };
    case "local-file":
      return { kind: "local-file", location: origin.path };
    case "built-in":
      return { kind: "built-in", secantVersion: origin.secantVersion };
  }
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
      if ("control" in node.repeat) {
        return {
          node: "repeat",
          control: node.repeat.control,
          steps: node.repeat.steps.map(stepView),
        };
      }
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

// --- version facts ---------------------------------------------------------

function engineRange(engine: string, engineVersion: string): EngineRange {
  const floor = engine.slice(">=".length);
  // includePrerelease so a prerelease Secant build above the floor (e.g. an RC)
  // still satisfies the range; without it semver excludes every prerelease host.
  const satisfied = semver.satisfies(engineVersion, engine, {
    includePrerelease: true,
  });
  return {
    range: engine,
    satisfied,
    ...(satisfied
      ? {}
      : {
          note: `needs Secant ≥ ${semver.major(floor)}.${semver.minor(floor)}`,
        }),
  };
}
