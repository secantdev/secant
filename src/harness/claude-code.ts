// The Claude Code Harness Adapter — private to the Harness Module, re-exported
// from `harness.ts` only through its factory. This first slice (#111) does
// discovery, non-conversational qualification, and the evidence-bearing profile
// `prepare` returns; Turns, the MCP bridge, and resume arrive in #112+. It opens
// no Session and writes nothing to stdin: it probes `claude --version` through
// the `process` Module (the one PATH walk and shim resolver, ADR 0030) and reads
// the platform. Every profile fact is an M3 spec fact (#107) carrying the
// evidence it rests on; the configuration posture is user-compatible, so no
// `--model`, tools, or permission flag is ever built here.

import { statSync } from "node:fs";
import {
  resolveExecutable,
  spawnCommand,
  type ExecutableResolution,
} from "../process/process.js";
import type {
  CleanupReport,
  HarnessAdapter,
  HarnessFailure,
  HarnessPlatform,
  HarnessProfile,
  HarnessTurn,
  PrepareOptions,
  PrepareResult,
  PreparedHarness,
} from "./harness.js";

/** The one M3 environment variable naming an explicit Claude Code executable
 *  path or command, tried before the canonical PATH name (#107). */
export const CLAUDE_CODE_EXECUTABLE_ENV = "SECANT_CLAUDE_CODE";

/** This Adapter's revision, stamped onto every profile it produces so a cached
 *  qualification from an older Adapter is never mistaken for a current one. */
const ADAPTER_REVISION = "claude-code-1";

const HARNESS_NAME = "claude-code";

/** The version probe's own timeout. Per ADR 0022 only launch/probe steps are
 *  bounded; agent thought and tools never are. */
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/** Test seams, all optional; production passes none and the real PATH walk,
 *  host platform, and `process.env` decide. They mirror the process Module's
 *  own `ResolveExecutableOptions`, so the Windows `.cmd`-shim and refusal paths
 *  are driven cross-OS exactly as that Module drives them. */
export interface ClaudeCodeAdapterOverrides {
  /** Where the configured-executable env var is read (default `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** Host platform for the profile and the shim rule (default `process.platform`). */
  readonly platform?: NodeJS.Platform;
  /** Override PATH the walk searches; the real `which` still decides the match. */
  readonly path?: string;
  /** Replace the PATH walk entirely, so the shim rule is testable off Windows. */
  readonly resolve?: (name: string) => string | undefined;
  readonly probeTimeoutMs?: number;
}

/** The factory a composition root calls. Satisfies `HarnessAdapterFactory` when
 *  called with no arguments; the overrides exist only for tests. */
export function createClaudeCodeAdapter(
  overrides: ClaudeCodeAdapterOverrides = {},
): HarnessAdapter {
  return new ClaudeCodeAdapter(overrides);
}

/** One discovery attempt: the human name of where we looked and the bare name
 *  or path handed to the resolver. */
interface DiscoveryAttempt {
  readonly source: string;
  readonly name: string;
}

/** A resolved, spawnable Claude Code target. */
interface DiscoveredTarget {
  readonly source: string;
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  /** The path whose bytes identify this Claude Code: the script an npm `.cmd`
   *  shim wraps (which changes when Claude Code updates), else the executable
   *  itself. Never the shared interpreter (`node`/`bun`), whose bytes never
   *  move when Claude Code does. */
  readonly identityPath: string;
  /** Whether the target is a native binary or an npm-style shim. */
  readonly shim: boolean;
}

class ClaudeCodeAdapter implements HarnessAdapter {
  /** Qualification cache, private to the Adapter, keyed by the discovered
   *  target's path and file identity. Same path + identical bytes ⇒ the probed
   *  version cannot have changed, so the cached profile is reused without
   *  re-running `--version`; any drift in either requalifies. */
  private readonly cache = new Map<string, HarnessProfile>();

  constructor(private readonly overrides: ClaudeCodeAdapterOverrides) {}

  async prepare(options: PrepareOptions): Promise<PrepareResult> {
    const platform = harnessPlatform(
      this.overrides.platform ?? process.platform,
    );
    if (platform === undefined) {
      return failed(
        "unsupported-platform",
        `Claude Code is not supported on platform '${process.platform}'.`,
      );
    }

    const discovery = this.discover(options);
    if (!discovery.ok) return { ok: false, failure: discovery.failure };
    const target = discovery.target;

    const identity = fileIdentity(target.identityPath);
    // Keyed by the target's path and file identity (the spec's cache key); the
    // discovery route is folded in too so a reused profile never reports a stale
    // source (e.g. "configured command" after the same file is later found on PATH).
    const cacheKey = `${target.source}\0${target.identityPath}\0${identity ?? "?"}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return { ok: true, harness: new ClaudeCodePreparedHarness(cached) };
    }

    const probe = await this.probeVersion(target);
    if (!probe.ok) return { ok: false, failure: probe.failure };

    const profile = buildProfile(target, probe.version, platform);
    this.cache.set(cacheKey, profile);
    return { ok: true, harness: new ClaudeCodePreparedHarness(profile) };
  }

  /** Discover in order: an explicit configured command or path (the env var, or
   *  the caller's `configuredExecutable`) first, then the canonical PATH name
   *  `claude`. `not-found` names every searched location; an unparsable shim is
   *  the distinct `unsupported-shim` and is not fallen through. */
  private discover(
    options: PrepareOptions,
  ):
    | { ok: true; target: DiscoveredTarget }
    | { ok: false; failure: HarnessFailure } {
    const configured =
      options.configuredExecutable ??
      (this.overrides.env ?? process.env)[CLAUDE_CODE_EXECUTABLE_ENV];
    const attempts: DiscoveryAttempt[] = [];
    if (configured !== undefined && configured.length > 0) {
      attempts.push({
        source: `configured command '${configured}'`,
        name: configured,
      });
    }
    attempts.push({ source: "PATH name 'claude'", name: "claude" });

    for (const attempt of attempts) {
      const resolution = this.resolve(attempt.name);
      if (resolution.kind === "found") {
        return { ok: true, target: toTarget(attempt, resolution) };
      }
      if (resolution.kind === "unsupported-shim") {
        return {
          ok: false,
          failure: failure(
            "unsupported-shim",
            `Refusing ${attempt.source}: '${resolution.path}' is a Windows shim the resolver cannot parse. Name the interpreter, or point ${CLAUDE_CODE_EXECUTABLE_ENV} at the real executable.`,
          ),
        };
      }
      // not-found: try the next location.
    }
    return {
      ok: false,
      failure: failure(
        "not-found",
        `No Claude Code executable found. Searched: ${attempts
          .map((attempt) => attempt.source)
          .join(", ")}.`,
      ),
    };
  }

  private resolve(name: string): ExecutableResolution {
    return resolveExecutable(name, {
      ...(this.overrides.platform !== undefined
        ? { platform: this.overrides.platform }
        : {}),
      ...(this.overrides.path !== undefined
        ? { path: this.overrides.path }
        : {}),
      ...(this.overrides.resolve !== undefined
        ? { resolve: this.overrides.resolve }
        : {}),
    });
  }

  /** Probe `<executable> --version` and nothing else — the only argv this slice
   *  builds. stdin is closed by `spawnCommand`, so no content is ever sent. */
  private async probeVersion(
    target: DiscoveredTarget,
  ): Promise<
    { ok: true; version: string } | { ok: false; failure: HarnessFailure }
  > {
    const result = await spawnCommand({
      executable: target.executable,
      args: [...target.prefixArgs, "--version"],
      cwd: undefined,
      env: process.env,
      timeoutMs: this.overrides.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      maxCaptureBytes: 64 * 1024,
      truncationMarker: "…",
    });
    if (result.kind !== "exited") {
      return {
        ok: false,
        failure: failure(
          "version-probe",
          `Could not run '${target.executable} --version' (${result.kind}).`,
        ),
      };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        failure: {
          ...failure(
            "version-probe",
            `'${target.executable} --version' exited ${result.status}.`,
          ),
          nativeCode: String(result.status),
        },
      };
    }
    const version = new TextDecoder().decode(result.text).trim();
    if (version.length === 0) {
      return {
        ok: false,
        failure: failure(
          "version-probe",
          `'${target.executable} --version' produced no version output.`,
        ),
      };
    }
    return { ok: true, version };
  }
}

/** The prepared Harness this slice returns. It carries the immutable profile;
 *  Turns are #112, so `startTurn` is a caller-contract violation for now, and
 *  `close` is a clean no-op (nothing was spawned or opened). */
class ClaudeCodePreparedHarness implements PreparedHarness {
  constructor(readonly profile: HarnessProfile) {}

  startTurn(): HarnessTurn {
    throw new Error(
      "Claude Code Turns are not available yet (#112): prepare only qualifies.",
    );
  }

  close(): Promise<CleanupReport> {
    return Promise.resolve(CLEAN_CLOSE);
  }
}

// `prepare` opens no Session and spawns no long-lived process, so close always
// reports the same clean value — the same reference each call keeps it idempotent.
const CLEAN_CLOSE: CleanupReport = {
  clean: true,
  detail: "prepare opened no Session; nothing to clean up.",
};

function toTarget(
  attempt: DiscoveryAttempt,
  resolution: Extract<ExecutableResolution, { kind: "found" }>,
): DiscoveredTarget {
  const shim = resolution.prefixArgs.length > 0;
  return {
    source: attempt.source,
    executable: resolution.executable,
    prefixArgs: resolution.prefixArgs,
    identityPath: resolution.prefixArgs[0] ?? resolution.executable,
    shim,
  };
}

/** The immutable profile, tied to the observed executable, version, platform,
 *  posture, and Adapter revision. Every capability is an M3 fact (#107) with
 *  the evidence it rests on. */
function buildProfile(
  target: DiscoveredTarget,
  version: string,
  platform: HarnessPlatform,
): HarnessProfile {
  // For a shim, the runtime that actually runs is worth naming; the wrapped
  // script is already the identity path in the line below, so it is not repeated.
  const kind = target.shim ? `npm shim via ${target.executable}` : "native";
  return {
    harness: HARNESS_NAME,
    executable: `${target.source} -> ${target.identityPath} (${kind})`,
    executableVersion: version,
    platform,
    adapterRevision: ADAPTER_REVISION,
    configurationPosture:
      "user-compatible: no --bare, --strict-mcp-config, --allowedTools, --tools, --model, or permission-mode flag; the user's settings, hooks, MCP servers, skills, and CLAUDE.md apply.",
    recovery: {
      mode: "native-reattach",
      evidence:
        "Claude Code reattaches a detached Session by resume-by-id (--resume <id>).",
    },
    interruption: {
      mode: "process-only",
      evidence:
        "SIGTERM ends the Turn and the process; the Session stays resumable.",
    },
    approvals: {
      available: true,
      evidence:
        "Approvals are raised through the Secant-hosted MCP permission bridge.",
    },
    clarifications: {
      available: false,
      evidence:
        "Claude Code exposes no raw-CLI question callback; structured clarifications are never emulated.",
    },
    modelSelection: {
      at: "unavailable",
      evidence:
        "Secant selects no model in M3; the effective model is reported from the init message and result usage.",
    },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence:
        "Secant mints the session UUID and passes it at spawn, so the recovery coordinate is durable before submission.",
    },
    skillDelivery: {
      mode: "plain-path",
      evidence:
        "A skill Bundle Asset reaches the agent by its SKILL.md absolute path in v1 (ADR 0022).",
    },
    fileDelivery: {
      mode: "plain-path",
      evidence: "A file artifact reaches the agent as a plain absolute path.",
    },
  };
}

/** The bytes-plus-location identity of a resolved target, or undefined when it
 *  cannot be stat'd (the cache then never hits for it). Windows inodes are
 *  unreliable, so size and mtime carry the identity. */
function fileIdentity(path: string): string | undefined {
  try {
    const stats = statSync(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return undefined;
  }
}

function harnessPlatform(
  platform: NodeJS.Platform,
): HarnessPlatform | undefined {
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

function failure(category: string, diagnostics: string): HarnessFailure {
  return {
    phase: "prepare",
    category,
    possibleEffects: "none",
    diagnostics,
  };
}

function failed(category: string, diagnostics: string): PrepareResult {
  return { ok: false, failure: failure(category, diagnostics) };
}
