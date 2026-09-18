import { resolveExecutable } from "../process/process.js";

/** The one environment variable naming an explicit Claude Code executable. */
export const CLAUDE_CODE_EXECUTABLE_ENV = "SECANT_CLAUDE_CODE";

/** The static capabilities the shipped Claude Code Adapter serves. Preflight
 *  compares the Routing's capability-need union against this Harness-owned fact. */
export const CLAUDE_CODE_SERVED_CAPABILITIES: Readonly<Record<string, true>> =
  Object.freeze({
    "agent-turn": true,
    "interactive-turns": true,
  });

const CLAUDE_CODE_PATH_NAME = "claude";

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

const discoveredTargets = new WeakMap<
  Extract<ClaudeCodeDiscovery, { kind: "found" }>,
  DiscoveredClaudeCodeTarget
>();

/** Discover Claude Code synchronously. The configured command is tried first,
 *  followed by the canonical PATH name; an unsupported shim is terminal rather
 *  than silently skipped. Callers translate the result into their own failure
 *  vocabulary. */
export function discoverClaudeCode(
  options: ClaudeCodeDiscoveryOptions = {},
): ClaudeCodeDiscovery {
  const configured = (
    options.configuredExecutable ??
    (options.env ?? process.env)[CLAUDE_CODE_EXECUTABLE_ENV]
  )?.trim();
  const attempts: ClaudeCodeDiscoveryAttempt[] = [];
  if (configured !== undefined && configured.length > 0) {
    attempts.push({
      source: "configured",
      name: configured,
      description: `configured command '${configured}'`,
    });
  }
  attempts.push({
    source: "path",
    name: CLAUDE_CODE_PATH_NAME,
    description: `PATH name '${CLAUDE_CODE_PATH_NAME}'`,
  });

  for (const attempt of attempts) {
    const resolution = resolveExecutable(attempt.name, {
      ...(options.path !== undefined ? { path: options.path } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.resolve !== undefined ? { resolve: options.resolve } : {}),
    });
    if (resolution.kind === "found") {
      const discovery: Extract<ClaudeCodeDiscovery, { kind: "found" }> = {
        kind: "found",
        attempt,
      };
      discoveredTargets.set(discovery, {
        executable: resolution.executable,
        prefixArgs: resolution.prefixArgs,
        identityPath: resolution.prefixArgs[0] ?? resolution.executable,
        shim: resolution.prefixArgs.length > 0,
      });
      return discovery;
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
