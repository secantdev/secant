import type { HarnessProfile } from "../harness/harness.js";
import type {
  ApplicationHarnessQualification,
  ApplicationHarnessRegistration,
} from "./harness-registry.js";
import {
  harnessDiagnosticMissing,
  harnessNotFound,
  harnessQualificationUnavailable,
} from "./problems.js";
import type {
  HarnessCapabilityView,
  HarnessCatalogSnapshot,
  HarnessDiscoveryView,
  HarnessFocus,
  HarnessDiagnosticReference,
  HarnessFocusSelector,
  HarnessFocusSnapshot,
  HarnessQualificationView,
  HarnessSummary,
  OpenedProjection,
  Problem,
  ResourceRead,
} from "./projection-port.js";
import { UpdateStream } from "./update-stream.js";

interface HeldQualification {
  readonly checkedAt: string;
  readonly result: ApplicationHarnessQualification;
}

export interface HarnessCatalog {
  openList(): OpenedProjection<HarnessCatalogSnapshot>;
  openFocus(
    selection: HarnessFocusSelector,
  ): OpenedProjection<HarnessFocusSnapshot>;
  readDiagnostic(reference: HarnessDiagnosticReference): ResourceRead;
  /** Qualify one registered Harness through the process cache (#189): the same
   *  bounded qualify path a focus uses (prepare then immediate close in
   *  composition), reused by `launch-preparation` to check a requested model
   *  against the Harness's declared model list. A repeated call reuses the held
   *  result. Returns undefined for an unregistered id. */
  qualify(id: string): Promise<ApplicationHarnessQualification | undefined>;
}

/** The read-only Harness catalog owns the process-scoped qualification cache and
 * translates evidence-bearing Harness profiles into the client vocabulary. */
export function createHarnessCatalog(
  registrations: readonly ApplicationHarnessRegistration[],
  now: () => Date,
): HarnessCatalog {
  const held = new Map<string, HeldQualification>();
  const qualifications = new Map<string, Promise<HeldQualification>>();
  const listObservers = new Set<UpdateStream<HarnessCatalogSnapshot>>();

  const listSnapshot = (): HarnessCatalogSnapshot => ({
    family: "harness-catalog",
    view: "list",
    harnesses: registrations.map((registration) =>
      summaryOf(registration, held.get(registration.choice.id)),
    ),
  });

  const registrationFor = (
    id: string,
  ): ApplicationHarnessRegistration | undefined =>
    registrations.find((registration) => registration.choice.id === id);

  const qualifyRegistration = (
    registration: ApplicationHarnessRegistration,
  ): Promise<HeldQualification> => {
    const existing = qualifications.get(registration.choice.id);
    if (existing !== undefined) return existing;

    const pending = registration
      .qualify()
      .catch((error): ApplicationHarnessQualification => ({
        ok: false,
        failure: {
          phase: "prepare",
          category: "qualification-exception",
          possibleEffects: "none",
          diagnostics:
            error instanceof Error
              ? error.message
              : "Harness qualification failed unexpectedly.",
          cause: error,
        },
      }))
      .then((result) => {
        const qualification = { checkedAt: now().toISOString(), result };
        held.set(registration.choice.id, qualification);
        for (const observer of listObservers) {
          observer.push({ kind: "durable", snapshot: listSnapshot() });
        }
        return qualification;
      });
    qualifications.set(registration.choice.id, pending);
    return pending;
  };

  return {
    openList(): OpenedProjection<HarnessCatalogSnapshot> {
      const updates = new UpdateStream<HarnessCatalogSnapshot>();
      listObservers.add(updates);
      return {
        snapshot: listSnapshot(),
        catchUp: "fresh",
        updates,
        close() {
          listObservers.delete(updates);
          updates.close();
        },
      };
    },
    openFocus(
      selection: HarnessFocusSelector,
    ): OpenedProjection<HarnessFocusSnapshot> {
      const updates = new UpdateStream<HarnessFocusSnapshot>();
      const registration = registrationFor(selection.id);
      if (registration === undefined) {
        return openedFocus(
          updates,
          problemSnapshot(selection, harnessNotFound(selection.id)),
        );
      }

      const cached = held.get(registration.choice.id);
      if (cached !== undefined) {
        return openedFocus(
          updates,
          focusSnapshot(selection, registration, cached),
        );
      }

      void qualifyRegistration(registration).then((qualification) => {
        updates.push({
          kind: "durable",
          snapshot: focusSnapshot(selection, registration, qualification),
        });
      });
      return openedFocus(
        updates,
        focusSnapshot(selection, registration, undefined),
      );
    },
    async qualify(
      id: string,
    ): Promise<ApplicationHarnessQualification | undefined> {
      const registration = registrationFor(id);
      if (registration === undefined) return undefined;
      const cached = held.get(id);
      if (cached !== undefined) return cached.result;
      return (await qualifyRegistration(registration)).result;
    },
    readDiagnostic(reference: HarnessDiagnosticReference): ResourceRead {
      const qualification = held.get(reference.harnessId);
      if (
        qualification === undefined ||
        qualification.checkedAt !== reference.checkedAt ||
        qualification.result.ok ||
        qualification.result.failure.diagnostics === undefined
      ) {
        return {
          found: false,
          problem: harnessDiagnosticMissing(reference),
        };
      }
      return {
        found: true,
        type: "diagnostic",
        content: qualification.result.failure.diagnostics,
      };
    },
  };
}

function openedFocus(
  updates: UpdateStream<HarnessFocusSnapshot>,
  snapshot: HarnessFocusSnapshot,
): OpenedProjection<HarnessFocusSnapshot> {
  return {
    snapshot,
    catchUp: "fresh",
    updates,
    close() {
      updates.close();
    },
  };
}

function problemSnapshot(
  selection: HarnessFocusSelector,
  problem: Problem,
): HarnessFocusSnapshot {
  return {
    family: "harness-catalog",
    view: "focus",
    selection,
    result: { found: false, problem },
  };
}

function focusSnapshot(
  selection: HarnessFocusSelector,
  registration: ApplicationHarnessRegistration,
  held: HeldQualification | undefined,
): HarnessFocusSnapshot {
  return {
    family: "harness-catalog",
    view: "focus",
    selection,
    result: { found: true, harness: focusOf(registration, held) },
  };
}

function summaryOf(
  registration: ApplicationHarnessRegistration,
  held: HeldQualification | undefined,
): HarnessSummary {
  return {
    id: registration.choice.id,
    name: registration.choice.name,
    discovery: discoveryView(registration.discover()),
    qualification: qualificationView(held),
  };
}

function focusOf(
  registration: ApplicationHarnessRegistration,
  held: HeldQualification | undefined,
): HarnessFocus {
  const summary = summaryOf(registration, held);
  if (held === undefined) {
    return { ...summary, capabilities: uncheckedCapabilities() };
  }
  if (!held.result.ok) {
    const failure = held.result.failure;
    return {
      ...summary,
      capabilities: uncheckedCapabilities(),
      ...(failure.category === "authentication"
        ? {
            authenticationInstructions: `Log in separately through ${registration.choice.name}; Secant does not transport credentials.`,
          }
        : {}),
      unavailable: harnessQualificationUnavailable(
        registration.choice,
        failure,
      ),
      ...(failure.diagnostics === undefined
        ? {}
        : {
            diagnosticReference: {
              type: "harness-diagnostic",
              harnessId: registration.choice.id,
              checkedAt: held.checkedAt,
            },
          }),
    };
  }

  const { profile } = held.result;
  return {
    ...summary,
    ...(profile.modelSelection.at === "unavailable"
      ? {}
      : { supportedModels: profile.modelSelection.declaration }),
    capabilities: capabilitiesOf(profile),
    configurationPosture: profile.configurationPosture,
  };
}

function discoveryView(
  discovery: ReturnType<ApplicationHarnessRegistration["discover"]>,
): HarnessDiscoveryView {
  if (discovery.kind === "found") {
    return {
      state: "found",
      source: discovery.source,
      description: discovery.description,
    };
  }
  if (discovery.kind === "unsupported-shim") {
    return {
      state: "unsupported-shim",
      name: discovery.name,
      path: discovery.path,
      executableEnvironmentVariable: discovery.executableEnvironmentVariable,
    };
  }
  return {
    state: "not-found",
    searched: discovery.searched,
    executableEnvironmentVariable: discovery.executableEnvironmentVariable,
  };
}

function qualificationView(
  held: HeldQualification | undefined,
): HarnessQualificationView {
  if (held === undefined) return { state: "not-checked" };
  if (!held.result.ok) return { state: "not-ready", checkedAt: held.checkedAt };
  const capabilities = capabilitiesOf(held.result.profile);
  const state = capabilities.every(
    (capability) => capability.state === "available",
  )
    ? "qualified"
    : "qualified-with-limits";
  return {
    state,
    observation: {
      executable: held.result.profile.executable,
      executableVersion: held.result.profile.executableVersion,
      platform: held.result.profile.platform,
      checkedAt: held.checkedAt,
    },
  };
}

const CAPABILITY_DEFINITIONS = [
  {
    capability: "session-recovery",
    name: "Session recovery",
    description: "Resume a Harness Session after process loss.",
  },
  {
    capability: "same-turn-steering",
    name: "Same-Turn steering",
    description: "Send guidance while the current Turn is still working.",
  },
  {
    capability: "turn-interruption",
    name: "Turn interruption",
    description: "Stop the current Turn and its native work.",
  },
  {
    capability: "tool-approvals",
    name: "Tool approvals",
    description: "Review tool actions raised by the Harness.",
  },
  {
    capability: "structured-questions",
    name: "Structured questions",
    description: "Answer structured questions raised by the Harness.",
  },
  {
    capability: "effective-model",
    name: "Effective model",
    description: "Observe the model that actually served a Turn.",
  },
] as const;

function uncheckedCapabilities(): readonly HarnessCapabilityView[] {
  return CAPABILITY_DEFINITIONS.map((definition) => ({
    ...definition,
    state: "not-checked",
  }));
}

function capabilitiesOf(
  profile: HarnessProfile,
): readonly HarnessCapabilityView[] {
  return [
    capability(
      CAPABILITY_DEFINITIONS[0],
      profile.recovery.mode === "native-reattach"
        ? "available"
        : profile.recovery.mode === "load-with-replay"
          ? "available-with-limits"
          : "unavailable",
      profile.recovery.mode === "load-with-replay"
        ? profile.recovery.evidence
        : undefined,
    ),
    capability(
      CAPABILITY_DEFINITIONS[1],
      profile.steer.available ? "available" : "unavailable",
    ),
    capability(
      CAPABILITY_DEFINITIONS[2],
      profile.interruption.mode === "active-turn"
        ? "available"
        : profile.interruption.mode === "process-only"
          ? "available-with-limits"
          : "unavailable",
      profile.interruption.mode === "process-only"
        ? profile.interruption.evidence
        : undefined,
    ),
    capability(
      CAPABILITY_DEFINITIONS[3],
      profile.approvals.available ? "available" : "unavailable",
    ),
    capability(
      CAPABILITY_DEFINITIONS[4],
      profile.clarifications.available ? "available" : "unavailable",
    ),
    capability(
      CAPABILITY_DEFINITIONS[5],
      profile.modelObservation.available ? "available" : "unavailable",
    ),
  ];
}

function capability(
  definition: (typeof CAPABILITY_DEFINITIONS)[number],
  state: HarnessCapabilityView["state"],
  limits?: string,
): HarnessCapabilityView {
  return {
    ...definition,
    state,
    ...(limits === undefined ? {} : { limits }),
  };
}
