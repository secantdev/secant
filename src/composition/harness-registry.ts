import type {
  ApplicationHarnessQualification,
  ApplicationHarnessRegistration,
  RunHarnessPreparationFailure,
  THarnessDiscovery,
} from "../application/application.js";
import type { HarnessChoice } from "../application/projection-port.js";
import {
  CLAUDE_CODE_EXECUTABLE_ENV,
  CLAUDE_CODE_SERVED_CAPABILITIES,
  CODEX_EXECUTABLE_ENV,
  CODEX_SERVED_CAPABILITIES,
  createClaudeCodeAdapter,
  createCodexAdapter,
  discoverClaudeCode,
  discoverCodex,
  type HarnessDiscovery,
  type HarnessAdapter,
  type HarnessFailure,
} from "../harness/harness.js";
import type { SelectedHarnessId } from "../run/store/store.js";

export interface HarnessRegistryOverrides {
  readonly claudeCodeAdapter?: HarnessAdapter;
  readonly codexAdapter?: HarnessAdapter;
  readonly discoverClaudeCode?: () => HarnessDiscovery;
  readonly discoverCodex?: () => HarnessDiscovery;
}

interface THarnessRegistryEntry {
  readonly application: ApplicationHarnessRegistration;
  readonly adapter: HarnessAdapter;
}

/** One closed registry table owns both production Harnesses. Application receives
 * only each entry's normalized half; execution resolves the private Adapter by
 * the durable semantic id. */
export class HarnessRegistry {
  private readonly entries: ReadonlyMap<
    SelectedHarnessId,
    THarnessRegistryEntry
  >;

  constructor(
    qualificationWorkspace: string,
    overrides: HarnessRegistryOverrides = {},
  ) {
    const claudeCodeAdapter =
      overrides.claudeCodeAdapter === undefined
        ? createClaudeCodeAdapter()
        : overrides.claudeCodeAdapter;
    const claudeCode: THarnessRegistryEntry = {
      application: {
        choice: {
          id: "claude-code",
          name: "Claude Code",
          availability: "available",
        },
        servedCapabilities: Object.keys(CLAUDE_CODE_SERVED_CAPABILITIES),
        discover: () => {
          const discovery =
            overrides.discoverClaudeCode === undefined
              ? discoverClaudeCode()
              : overrides.discoverClaudeCode();
          return normalizeDiscovery(discovery, CLAUDE_CODE_EXECUTABLE_ENV);
        },
        qualify: () =>
          qualifyAdapter(claudeCodeAdapter, qualificationWorkspace),
      },
      adapter: claudeCodeAdapter,
    };
    const codexAdapter =
      overrides.codexAdapter === undefined
        ? createCodexAdapter()
        : overrides.codexAdapter;
    const codex: THarnessRegistryEntry = {
      application: {
        choice: { id: "codex", name: "Codex", availability: "available" },
        servedCapabilities: Object.keys(CODEX_SERVED_CAPABILITIES),
        discover: () => {
          const discovery =
            overrides.discoverCodex === undefined
              ? discoverCodex()
              : overrides.discoverCodex();
          return normalizeDiscovery(discovery, CODEX_EXECUTABLE_ENV);
        },
        qualify: () => qualifyAdapter(codexAdapter, qualificationWorkspace),
      },
      adapter: codexAdapter,
    };
    this.entries = new Map([
      ["claude-code", claudeCode],
      ["codex", codex],
    ]);
  }

  applicationRegistrations(): readonly ApplicationHarnessRegistration[] {
    return Array.from(this.entries.values()).map((entry) => entry.application);
  }

  choice(selectedHarness: SelectedHarnessId): HarnessChoice {
    return this.entry(selectedHarness).application.choice;
  }

  adapter(selectedHarness: SelectedHarnessId): HarnessAdapter {
    return this.entry(selectedHarness).adapter;
  }

  preparationFailure(
    selectedHarness: SelectedHarnessId,
    failure: HarnessFailure,
  ): RunHarnessPreparationFailure {
    return {
      selectedHarness,
      harnessName: this.choice(selectedHarness).name,
      phase: failure.phase,
      category: failure.category,
      possibleEffects: failure.possibleEffects,
      partialOutput: failure.partialOutput,
      nativeCode: failure.nativeCode,
      retryEvidence: failure.retryEvidence,
      diagnostics: failure.diagnostics,
      cause: failure.cause,
    };
  }

  private entry(selectedHarness: SelectedHarnessId): THarnessRegistryEntry {
    const entry = this.entries.get(selectedHarness);
    if (entry === undefined) {
      throw new Error(
        `composition: selected Harness '${selectedHarness}' is not registered.`,
      );
    }
    return entry;
  }
}

async function qualifyAdapter(
  adapter: HarnessAdapter,
  workspace: string,
): Promise<ApplicationHarnessQualification> {
  let prepared: Awaited<ReturnType<HarnessAdapter["prepare"]>>;
  try {
    prepared = await adapter.prepare({ workspace });
  } catch (error) {
    return qualificationException("prepare", error);
  }
  if (!prepared.ok) {
    return { ok: false, failure: qualificationFailure(prepared.failure) };
  }

  const profile = prepared.harness.profile;
  try {
    const cleanup = await prepared.harness.close();
    if (!cleanup.clean) {
      return {
        ok: false,
        failure:
          cleanup.failure === undefined
            ? {
                phase: "cleanup",
                category: "cleanup",
                possibleEffects: "possible",
                diagnostics: cleanup.detail,
              }
            : qualificationFailure(cleanup.failure),
      };
    }
  } catch (error) {
    return qualificationException("cleanup", error);
  }
  return { ok: true, profile };
}

function qualificationFailure(
  failure: HarnessFailure,
): Extract<ApplicationHarnessQualification, { ok: false }>["failure"] {
  return {
    phase: failure.phase,
    category: failure.category,
    possibleEffects: failure.possibleEffects,
    retryEvidence: failure.retryEvidence,
    diagnostics: failure.diagnostics,
    cause: failure.cause,
  };
}

function qualificationException(
  phase: "prepare" | "cleanup",
  error: unknown,
): ApplicationHarnessQualification {
  return {
    ok: false,
    failure: {
      phase,
      category: `${phase}-exception`,
      possibleEffects: phase === "prepare" ? "none" : "possible",
      diagnostics:
        error instanceof Error
          ? error.message
          : `Harness ${phase} failed unexpectedly.`,
      cause: error,
    },
  };
}

function normalizeDiscovery(
  discovery: HarnessDiscovery,
  executableEnvironmentVariable: string,
): THarnessDiscovery {
  if (discovery.kind === "found") {
    return {
      kind: "found",
      source: discovery.attempt.source,
      description: discovery.attempt.description,
    };
  }
  if (discovery.kind === "unsupported-shim") {
    return {
      kind: "unsupported-shim",
      name: discovery.attempt.name,
      path: discovery.path,
      executableEnvironmentVariable,
    };
  }
  return {
    kind: "not-found",
    searched: searchedDescriptions(
      discovery.attempts,
      executableEnvironmentVariable,
    ),
    executableEnvironmentVariable,
  };
}

function searchedDescriptions(
  attempts: readonly {
    readonly source: "configured" | "path";
    readonly name: string;
    readonly description: string;
  }[],
  executableEnvironmentVariable: string,
): readonly string[] {
  return attempts.map((attempt) => {
    const source =
      attempt.source === "configured"
        ? `configured command (${executableEnvironmentVariable})`
        : attempt.description;
    return `${source}: "${attempt.name}"`;
  });
}
