import { inspectBundle, generateExecutionSummary } from "../bundle/bundle.js";
import type { Budgets } from "../bundle/bundle.js";
import type { Catalog, CatalogEntry } from "../catalog/catalog.js";
import type { AuthoredManifest, Platform } from "../workflow/workflow.js";
import type { ProcessAdapter } from "../process/process.js";
import { assessPreflight, bundleSnapshotCorrupt } from "./preflight.js";
import { selectPlatform } from "./select-platform.js";
import type { ApplicationHarnessRegistration } from "./harness-registry.js";
import type { ApplicationHarnessQualification } from "./harness-registry.js";
import { selectRunEntry } from "./run-projection.js";
import {
  bundleBytesCorrupt,
  bundleBytesMissing,
  bundleTrustRequired,
  harnessQualificationUnavailable,
  requestedModelUnavailable,
  trustDigestMismatch,
  workspaceNotApproved,
} from "./problems.js";
import { UpdateStream } from "./update-stream.js";
import type {
  ActionOffer,
  BundleOriginView,
  ExecutionSummary,
  HarnessChoice,
  LaunchPreparationDraftView,
  LaunchPreparationSnapshot,
  LaunchRunInput,
  OpenedProjection,
  Problem,
} from "./projection-port.js";

// `launch-preparation` (#189): the read-only assessment of one complete launch
// draft. It reruns the ordered creation-free checks a launch runs today (through
// `evaluate`, the same evaluator `submitLaunch` refuses from, so both clients
// create Runs under identical rules) and, when a model is requested for an
// Agent-bearing routing, additionally qualifies only the selected Harness through
// the process cache to check that model against the declared list. It creates no
// Run, Session, Turn, Trust grant, or durable draft, and releases the prepared
// Harness immediately (composition's qualify path closes it). Changing any draft
// field opens a new Projection — the selector is the draft.

export interface LaunchPreparationDeps {
  readonly catalog: Catalog;
  readonly budgets: Budgets;
  readonly process: ProcessAdapter;
  readonly hostPlatform?: Platform;
  readonly supportsInteractiveTurns: boolean;
  readonly harnessRegistry: readonly ApplicationHarnessRegistration[];
  /** The canonical launch Workspace path (Application already canonicalised it). */
  readonly launchWorkspacePath: string;
  /** The process-scoped Harness qualification path the `harness-catalog` owns, so
   *  assessment and inspection share one cached result per semantic id. */
  readonly qualify: (
    id: string,
  ) => Promise<ApplicationHarnessQualification | undefined>;
}

/** The resolved facts a passing (or partially passing) evaluation carries, so
 *  `submitLaunch` can create the Run without re-resolving them. Absent when the
 *  Bundle could not be resolved or its bytes are gone/corrupt. */
export interface LaunchDraftResolution {
  readonly entry: CatalogEntry;
  readonly manifest: AuthoredManifest;
  readonly selectedHarness?: HarnessChoice["id"];
  readonly requestedModel?: string;
  /** Whether launching will record a new Trust grant (the digest was untrusted
   *  and the draft acknowledges it). */
  readonly needsGrant: boolean;
}

export interface LaunchDraftEvaluation {
  /** Ordered findings in launch order; empty exactly when the draft is launchable
   *  (before the additional model qualification the assessment layers on). */
  readonly findings: readonly Problem[];
  readonly resolution?: LaunchDraftResolution;
}

export interface LaunchPreparation {
  /** The synchronous authoritative checks, shared with `submitLaunch`. */
  evaluate(input: LaunchRunInput): LaunchDraftEvaluation;
  /** Open the live assessment Projection over one draft. */
  open(draft: LaunchRunInput): OpenedProjection<LaunchPreparationSnapshot>;
}

export function createLaunchPreparation(
  deps: LaunchPreparationDeps,
): LaunchPreparation {
  function evaluate(input: LaunchRunInput): LaunchDraftEvaluation {
    const findings: Problem[] = [];
    const selected = selectRunEntry(
      deps.catalog,
      input.bundle.id,
      input.bundle.version,
    );
    if ("problem" in selected) return { findings: [selected.problem] };
    const entry = selected.entry;

    // Workspace approval is checked at a launch's start (before the bytes), so it
    // is collected first here to preserve the first-fail order `submitLaunch` reads.
    if (
      deps.catalog.getWorkspaceApproval(deps.launchWorkspacePath) === undefined
    ) {
      findings.push(workspaceNotApproved(deps.launchWorkspacePath));
    }

    const bytes = deps.catalog.readManagedBytes(entry.digest);
    if (bytes === undefined) {
      findings.push(bundleBytesMissing({ digest: entry.digest }));
      return { findings };
    }
    const inspected = inspectBundle(bytes, deps.budgets, true);
    if (!inspected.ok) {
      findings.push(
        bundleBytesCorrupt({ digest: entry.digest }, inspected.finding.code),
      );
      return { findings };
    }
    const manifest = inspected.inspection.manifest;
    // A pinned Snapshot that no longer composes is corrupt, the same class as
    // missing/invalid bytes: a single hard-stop `bundle` finding, not a fault the
    // remaining checks accumulate atop (a corrupt routing cannot be assessed).
    if (
      inspected.inspection.composition.some(
        (finding) => finding.severity === "error",
      )
    ) {
      findings.push(bundleSnapshotCorrupt(entry.digest));
      return { findings };
    }

    const pre = assessPreflight(
      {
        manifest,
        composition: inspected.inspection.composition,
        workspacePath: deps.launchWorkspacePath,
        launchInputs: input.launchInputs,
        hostPlatform: deps.hostPlatform,
        digest: entry.digest,
        supportsInteractiveTurns: deps.supportsInteractiveTurns,
        harnessSelection: input.harness,
        requestedModel: input.requestedModel,
        harnessRegistry: deps.harnessRegistry,
      },
      deps.process,
    );
    findings.push(...pre.findings);

    // Trust mirrors `submitLaunch` exactly, minus the grant write: an untrusted
    // digest needs a matching acknowledgement; a missing one is `bundle-trust-
    // required`, a mismatching one `trust-digest-mismatch`.
    const grant = deps.catalog.getTrustGrant(
      entry.digest,
      entry.installationGeneration,
    );
    const needsGrant = grant === undefined;
    if (needsGrant) {
      if (input.trustDigest === undefined) {
        findings.push(
          bundleTrustRequired(manifest, entry.digest, deps.hostPlatform),
        );
      } else if (input.trustDigest !== entry.digest) {
        findings.push(trustDigestMismatch(entry.digest, input.trustDigest));
      }
    }

    return {
      findings,
      resolution: {
        entry,
        manifest,
        needsGrant,
        ...(pre.selectedHarness !== undefined
          ? { selectedHarness: pre.selectedHarness }
          : {}),
        ...(pre.requestedModel !== undefined
          ? { requestedModel: pre.requestedModel }
          : {}),
      },
    };
  }

  function open(
    draft: LaunchRunInput,
  ): OpenedProjection<LaunchPreparationSnapshot> {
    const updates = new UpdateStream<LaunchPreparationSnapshot>();
    const evaluation = evaluate(draft);
    const resolution = evaluation.resolution;
    const syncFindings = evaluation.findings;

    // Qualify only when the draft is otherwise ready AND a model is requested.
    // Qualification spawns the real Harness, so it never runs to browse a draft
    // without a model, nor to add a model finding to a draft already not-ready for
    // other reasons — those findings are printed at once and the model is checked
    // once they are fixed (spec: qualification is to check the requested model).
    const modelCheck =
      syncFindings.length === 0 &&
      resolution?.selectedHarness !== undefined &&
      resolution.requestedModel !== undefined
        ? {
            harness: resolution.selectedHarness,
            model: resolution.requestedModel,
          }
        : undefined;

    if (modelCheck === undefined) {
      const status = syncFindings.length > 0 ? "not-ready" : "ready";
      return settled(
        snapshot(status, syncFindings, resolution, draft),
        updates,
      );
    }

    // A qualification error must never read as ready: an unexpected throw becomes a
    // harness finding, the same not-ready outcome a `{ok:false}` result produces.
    void (async () => {
      let extra: Problem | undefined;
      try {
        const qualification = await deps.qualify(modelCheck.harness);
        extra = modelFinding(
          modelCheck.harness,
          modelCheck.model,
          qualification,
        );
      } catch (error) {
        extra = modelFinding(modelCheck.harness, modelCheck.model, {
          ok: false,
          failure: {
            phase: "prepare",
            category: "qualification-exception",
            possibleEffects: "none",
            diagnostics:
              error instanceof Error
                ? error.message
                : "Harness qualification failed unexpectedly.",
          },
        });
      }
      const findings = extra === undefined ? [] : [extra];
      const status = findings.length > 0 ? "not-ready" : "ready";
      updates.push({
        kind: "durable",
        snapshot: snapshot(status, findings, resolution, draft),
      });
    })();

    return settled(
      snapshot("assessing", syncFindings, resolution, draft),
      updates,
    );
  }

  function modelFinding(
    harnessId: HarnessChoice["id"],
    model: string,
    qualification: ApplicationHarnessQualification | undefined,
  ): Problem | undefined {
    // The Harness was already validated by `evaluate`, so an unregistered id here
    // is unreachable; treat a missing qualification as no additional finding.
    if (qualification === undefined) return undefined;
    const choice = deps.harnessRegistry.find(
      (registration) => registration.choice.id === harnessId,
    )?.choice;
    if (choice === undefined) return undefined;
    if (!qualification.ok) {
      return harnessQualificationUnavailable(choice, qualification.failure);
    }
    const { modelSelection } = qualification.profile;
    if (modelSelection.at === "unavailable") return undefined;
    const declaration = modelSelection.declaration;
    if (declaration.kind === "list" && !declaration.models.includes(model)) {
      return requestedModelUnavailable(choice, model, declaration.models);
    }
    return undefined;
  }

  function snapshot(
    status: LaunchPreparationSnapshot["status"],
    findings: readonly Problem[],
    resolution: LaunchDraftResolution | undefined,
    draft: LaunchRunInput,
  ): LaunchPreparationSnapshot {
    const offers: ActionOffer[] =
      status === "ready" && resolution !== undefined
        ? [
            {
              action: "launch-run",
              draft,
              trustRequired: resolution.needsGrant,
              consequence:
                "Create and start a Run for this draft; launch rechecks every requirement.",
            },
          ]
        : [];
    return {
      family: "launch-preparation",
      status,
      draft: draftView(draft, resolution),
      findings,
      ...(resolution !== undefined
        ? { executionSummary: executionSummaryFor(resolution) }
        : {}),
      actionOffers: offers,
    };
  }

  function executionSummaryFor(
    resolution: LaunchDraftResolution,
  ): ExecutionSummary {
    const { manifest, entry } = resolution;
    const platform = selectPlatform(
      manifest.platforms ?? [],
      deps.hostPlatform,
    );
    const core = generateExecutionSummary(manifest, entry.digest, platform);
    return { ...core, origin: originView(entry) };
  }

  return { evaluate, open };
}

function draftView(
  draft: LaunchRunInput,
  resolution: LaunchDraftResolution | undefined,
): LaunchPreparationDraftView {
  const bundle =
    resolution !== undefined
      ? {
          id: resolution.manifest.bundle.id,
          version: resolution.manifest.bundle.version,
          digest: resolution.entry.digest,
          name: resolution.manifest.bundle.name,
        }
      : {
          id: draft.bundle.id,
          ...(draft.bundle.version !== undefined
            ? { version: draft.bundle.version }
            : {}),
        };
  return {
    bundle,
    ...(draft.harness !== undefined ? { harness: draft.harness } : {}),
    ...(draft.requestedModel !== undefined
      ? { requestedModel: draft.requestedModel }
      : {}),
    launchInputs: draft.launchInputs,
    ...(draft.trustDigest !== undefined
      ? { trustDigest: draft.trustDigest }
      : {}),
  };
}

function originView(entry: CatalogEntry): BundleOriginView {
  return entry.origin.kind === "local-build"
    ? { kind: "local-build", location: entry.origin.folder }
    : { kind: "local-file", location: entry.origin.path };
}

function settled(
  snapshot: LaunchPreparationSnapshot,
  updates: UpdateStream<LaunchPreparationSnapshot>,
): OpenedProjection<LaunchPreparationSnapshot> {
  return {
    snapshot,
    catchUp: "fresh",
    updates,
    close() {
      updates.close();
    },
  };
}
