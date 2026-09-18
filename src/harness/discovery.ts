import { resolveExecutable } from "../process/process.js";

/** The one environment variable naming an explicit Claude Code executable. */
export const CLAUDE_CODE_EXECUTABLE_ENV = "SECANT_CLAUDE_CODE";

/** The one environment variable naming an explicit Codex executable. */
export const CODEX_EXECUTABLE_ENV = "SECANT_CODEX";

/** The static capabilities the shipped Claude Code Adapter serves. Preflight
 *  compares the Routing's capability-need union against this Harness-owned fact. */
export const CLAUDE_CODE_SERVED_CAPABILITIES: Readonly<Record<string, true>> =
  Object.freeze({
    "agent-turn": true,
    "interactive-turns": true,
  });

/** The static capabilities the shipped Codex Adapter serves. */
export const CODEX_SERVED_CAPABILITIES: Readonly<Record<string, true>> =
  Object.freeze({
    "agent-turn": true,
    "interactive-turns": true,
  });

const CLAUDE_CODE_PATH_NAME = "claude";
const CODEX_PATH_NAME = "codex";

export interface ClaudeCodeDiscoveryAttempt {
  readonly source: "configured" | "path";
  readonly name: string;
  readonly description: string;
}

export interface DiscoveredClaudeCodeTarget {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly identityPath: string;
  readonly shim: boolean;
}

export type ClaudeCodeDiscovery =
  | {
      readonly kind: "found";
      readonly attempt: ClaudeCodeDiscoveryAttempt;
    }
  | {
      readonly kind: "unsupported-shim";
      readonly attempt: ClaudeCodeDiscoveryAttempt;
      readonly path: string;
    }
  | {
      readonly kind: "not-found";
      readonly attempts: readonly ClaudeCodeDiscoveryAttempt[];
    };

export interface ClaudeCodeDiscoveryOptions {
  readonly configuredExecutable?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly path?: string;
  readonly platform?: NodeJS.Platform;
  readonly resolve?: (name: string) => string | undefined;
}

export interface CodexDiscoveryAttempt {
  readonly source: "configured" | "path";
  readonly name: string;
  readonly description: string;
}

export interface DiscoveredCodexTarget {
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly identityPath: string;
  readonly shim: boolean;
}

export type CodexDiscovery =
  | { readonly kind: "found"; readonly attempt: CodexDiscoveryAttempt }
  | {
      readonly kind: "unsupported-shim";
      readonly attempt: CodexDiscoveryAttempt;
      readonly path: string;
    }
  | {
      readonly kind: "not-found";
      readonly attempts: readonly CodexDiscoveryAttempt[];
    };

export interface CodexDiscoveryOptions {
  readonly configuredExecutable?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly path?: string;
  readonly platform?: NodeJS.Platform;
  readonly resolve?: (name: string) => string | undefined;
}

interface TDiscoveryAttempt {
  readonly source: "configured" | "path";
  readonly name: string;
  readonly description: string;
}

interface TDiscoveryOptions {
  readonly configuredExecutable?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly path?: string;
  readonly platform?: NodeJS.Platform;
  readonly resolve?: (name: string) => string | undefined;
}

interface TDiscoverExecutable {
  readonly options: TDiscoveryOptions;
  readonly executableEnvironmentVariable: string;
  readonly pathName: string;
}

type TExecutableDiscovery =
  | {
      readonly kind: "found";
      readonly attempt: TDiscoveryAttempt;
      readonly target: DiscoveredCodexTarget;
    }
  | {
      readonly kind: "unsupported-shim";
      readonly attempt: TDiscoveryAttempt;
      readonly path: string;
    }
  | {
      readonly kind: "not-found";
      readonly attempts: readonly TDiscoveryAttempt[];
    };

const discoveredTargets = new WeakMap<
  Extract<ClaudeCodeDiscovery, { kind: "found" }>,
  DiscoveredClaudeCodeTarget
>();

const discoveredCodexTargets = new WeakMap<
  Extract<CodexDiscovery, { kind: "found" }>,
  DiscoveredCodexTarget
>();

/** Discover Claude Code synchronously. The configured command is tried first,
 *  followed by the canonical PATH name; an unsupported shim is terminal rather
 *  than silently skipped. Callers translate the result into their own failure
 *  vocabulary. */
export function discoverClaudeCode(
  options: ClaudeCodeDiscoveryOptions = {},
): ClaudeCodeDiscovery {
  const resolved = discoverExecutable({
    options,
    executableEnvironmentVariable: CLAUDE_CODE_EXECUTABLE_ENV,
    pathName: CLAUDE_CODE_PATH_NAME,
  });
  if (resolved.kind !== "found") return resolved;
  const discovery: Extract<ClaudeCodeDiscovery, { kind: "found" }> = {
    kind: "found",
    attempt: resolved.attempt,
  };
  discoveredTargets.set(discovery, resolved.target);
  return discovery;
}

/** The spawn target attached to a successful discovery. Private to the Harness
 *  Module: the public entry re-exports the discovery outcome, never this native
 *  executable detail. */
export function discoveredClaudeCodeTarget(
  discovery: Extract<ClaudeCodeDiscovery, { kind: "found" }>,
): DiscoveredClaudeCodeTarget {
  const target = discoveredTargets.get(discovery);
  if (target === undefined) {
    throw new Error("harness: found Claude Code discovery has no target.");
  }
  return target;
}

/** Discover Codex synchronously, configured command first and canonical PATH
 *  name second. An unsupported configured shim is terminal, never a reason to
 *  substitute another Harness or silently continue to PATH. */
export function discoverCodex(
  options: CodexDiscoveryOptions = {},
): CodexDiscovery {
  const resolved = discoverExecutable({
    options,
    executableEnvironmentVariable: CODEX_EXECUTABLE_ENV,
    pathName: CODEX_PATH_NAME,
  });
  if (resolved.kind !== "found") return resolved;
  const discovery: Extract<CodexDiscovery, { kind: "found" }> = {
    kind: "found",
    attempt: resolved.attempt,
  };
  discoveredCodexTargets.set(discovery, resolved.target);
  return discovery;
}

/** Resolve the spawn detail hidden behind one successful Codex discovery. */
export function discoveredCodexTarget(
  discovery: Extract<CodexDiscovery, { kind: "found" }>,
): DiscoveredCodexTarget {
  const target = discoveredCodexTargets.get(discovery);
  if (target === undefined) {
    throw new Error("harness: found Codex discovery has no target.");
  }
  return target;
}

function discoverExecutable(
  options: TDiscoverExecutable,
): TExecutableDiscovery {
  const environment = options.options.env ?? process.env;
  const configured = (
    options.options.configuredExecutable ??
    environment[options.executableEnvironmentVariable]
  )?.trim();
  const attempts: TDiscoveryAttempt[] = [];
  if (configured !== undefined && configured.length > 0) {
    attempts.push({
      source: "configured",
      name: configured,
      description: `configured command '${configured}'`,
    });
  }
  attempts.push({
    source: "path",
    name: options.pathName,
    description: `PATH name '${options.pathName}'`,
  });

  const resolutionOptions: {
    path?: string;
    platform?: NodeJS.Platform;
    resolve?: (name: string) => string | undefined;
  } = {};
  if (options.options.path !== undefined) {
    resolutionOptions.path = options.options.path;
  }
  if (options.options.platform !== undefined) {
    resolutionOptions.platform = options.options.platform;
  }
  if (options.options.resolve !== undefined) {
    resolutionOptions.resolve = options.options.resolve;
  }

  for (const attempt of attempts) {
    const resolution = resolveExecutable(attempt.name, resolutionOptions);
    if (resolution.kind === "found") {
      return {
        kind: "found",
        attempt,
        target: {
          executable: resolution.executable,
          prefixArgs: resolution.prefixArgs,
          identityPath: resolution.prefixArgs[0] ?? resolution.executable,
          shim: resolution.prefixArgs.length > 0,
        },
      };
    }
    if (resolution.kind === "unsupported-shim") {
      return {
        kind: "unsupported-shim",
        attempt,
        path: resolution.path,
      };
    }
  }
  return { kind: "not-found", attempts };
}
