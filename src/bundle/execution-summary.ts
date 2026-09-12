import {
  type AuthoredManifest,
  type CommandInvocation,
  type CommandParams,
  flattenSteps,
  type Platform,
  type StepKindName,
} from "../workflow/workflow.js";

// Crucible's generated account of the authority a Bundle can exercise on one
// platform (#9 glossary). A private submodule of the Bundle Module, re-exported
// by the entry: it is a named glossary concept that touches no filesystem and is
// a pure function of the manifest, the platform, and the digest. Application
// (bundle-catalog) is its only consumer; origin is joined in there.

/** One command Step resolved for a single platform. */
export interface BundleExecutionCommand {
  readonly stepId: string;
  readonly executable: string;
  readonly workingDirectory?: string;
  readonly environmentVariableNames: readonly string[];
  readonly scripts: readonly string[]; // script asset paths the command runs
}

/** Crucible's generated account of the authority a Bundle can exercise on one
 *  platform (#9 glossary). Origin is joined in by Application. */
export interface BundleExecutionSummary {
  readonly platform: Platform;
  readonly identity: { readonly id: string; readonly version: string };
  readonly digest: string;
  readonly platforms: readonly Platform[];
  readonly stepKindCounts: Readonly<Partial<Record<StepKindName, number>>>;
  readonly commands: readonly BundleExecutionCommand[];
  readonly warning: string;
}

/** The fixed authority warning every Execution summary carries (#9 glossary). */
export const EXECUTION_AUTHORITY_WARNING =
  "Commands and Harness actions run with the current user's authority and cannot have all their effects predicted statically.";

/**
 * Generate the Execution summary from a validated manifest for one platform:
 * Step-kind counts, each command resolved for that platform (executable,
 * working directory, environment variable names, and the script assets it runs),
 * and the fixed authority warning. Purely a function of the manifest, the
 * platform, and the digest — no filesystem, no execution.
 */
export function generateExecutionSummary(
  manifest: AuthoredManifest,
  digest: string,
  platform: Platform,
): BundleExecutionSummary {
  const scriptAssets = new Set(
    manifest.assets
      .filter((asset) => asset.kind === "script")
      .map((asset) => asset.path),
  );
  const steps = flattenSteps(manifest.routing);
  const stepKindCounts: Partial<Record<StepKindName, number>> = {};
  const commands: BundleExecutionCommand[] = [];
  for (const step of steps) {
    stepKindCounts[step.kind] = (stepKindCounts[step.kind] ?? 0) + 1;
    if (step.kind === "command") {
      commands.push(
        resolveCommand(step.id, step.command, platform, scriptAssets),
      );
    }
  }
  return {
    platform,
    identity: { id: manifest.bundle.id, version: manifest.bundle.version },
    digest,
    platforms: manifest.platforms ?? [],
    stepKindCounts,
    commands,
    warning: EXECUTION_AUTHORITY_WARNING,
  };
}

function resolveCommand(
  stepId: string,
  command: CommandParams,
  platform: Platform,
  scriptAssets: ReadonlySet<string>,
): BundleExecutionCommand {
  // A per-platform override replaces only the fields it names; the base command
  // supplies the rest (#9 per-platform parameter overrides).
  const override = command.platforms?.[platform] ?? {};
  const invocation: CommandInvocation = {
    executable: override.executable ?? command.executable,
    arguments: override.arguments ?? command.arguments,
    workingDirectory: override.workingDirectory ?? command.workingDirectory,
    env: override.env ?? command.env,
  };
  const scripts: string[] = [];
  for (const token of invocation.arguments) {
    if (
      typeof token !== "string" &&
      "asset" in token &&
      scriptAssets.has(token.asset)
    ) {
      scripts.push(token.asset);
    }
  }
  for (const value of Object.values(invocation.env ?? {})) {
    if (
      typeof value !== "string" &&
      "asset" in value &&
      scriptAssets.has(value.asset)
    ) {
      scripts.push(value.asset);
    }
  }
  return {
    stepId,
    executable: invocation.executable,
    ...(invocation.workingDirectory !== undefined
      ? { workingDirectory: invocation.workingDirectory }
      : {}),
    environmentVariableNames: Object.keys(invocation.env ?? {}).sort(),
    scripts,
  };
}
