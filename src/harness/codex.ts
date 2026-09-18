import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spawnCommand,
  spawnOwnedProcess,
  type OwnedProcess,
} from "../process/process.js";
import {
  type CleanupReport,
  type HarnessAdapter,
  type HarnessFailure,
  type HarnessPlatform,
  type HarnessProfile,
  type HarnessTurn,
  type PrepareOptions,
  type PrepareResult,
  type PreparedHarness,
  type TurnRequest,
} from "./harness.js";
import {
  CODEX_EXECUTABLE_ENV,
  discoverCodex,
  discoveredCodexTarget,
  type DiscoveredCodexTarget,
} from "./discovery.js";
import {
  CodexDiagnosticCapture,
  CodexQualificationConnection,
  type CodexQualificationObserver,
} from "./codex/qualification.js";
import { validateRequiredSchema } from "./codex/required-schema.js";

export type { CodexQualificationObserver } from "./codex/qualification.js";

const HARNESS_NAME = "codex";
const PROBE_REVISION = "codex-probe-1";
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_SCHEMA_BYTES = 8 * 1024 * 1024;
const GENERATED_SCHEMA_FILE = "codex_app_server_protocol.schemas.json";
const AUTHENTICATION_REQUIRED =
  "Authentication required for Codex. Log in separately through Codex, then retry.";

export interface CodexAdapterOverrides {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform | (() => NodeJS.Platform);
  readonly path?: string;
  readonly resolve?: (name: string) => string | undefined;
  readonly probeTimeoutMs?: number;
  readonly launchTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly probeRevision?: () => string;
  readonly spawn?: typeof spawnOwnedProcess;
  /** Recorder-only observation of the exact qualification bytes. Production
   *  passes none; native protocol data never reaches an ordinary caller. */
  readonly qualificationObserver?: CodexQualificationObserver;
}

interface TDiscoveredTarget extends DiscoveredCodexTarget {
  readonly source: string;
}

type TProbeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: HarnessFailure };

type TLiveQualification =
  | {
      readonly ok: true;
      readonly process: OwnedProcess;
      readonly diagnostics: CodexDiagnosticCapture;
    }
  | { readonly ok: false; readonly failure: HarnessFailure };

export function createCodexAdapter(
  overrides: CodexAdapterOverrides = {},
): HarnessAdapter {
  return new CodexAdapter(overrides);
}

class CodexAdapter implements HarnessAdapter {
  private readonly cache = new Set<string>();

  constructor(private readonly overrides: CodexAdapterOverrides) {}

  async prepare(options: PrepareOptions): Promise<PrepareResult> {
    const nativePlatform = observedPlatform(this.overrides.platform);
    const platform = harnessPlatform(nativePlatform);
    if (platform === undefined) {
      return failed(
        "unsupported-platform",
        `Codex is not supported on platform '${nativePlatform}'.`,
      );
    }

    const discovery = this.discover(options);
    if (!discovery.ok) return discovery;
    const version = await this.probeVersion(discovery.target);
    if (!version.ok) return version;

    const probeRevision = this.overrides.probeRevision?.() ?? PROBE_REVISION;
    const identity = fileIdentity(discovery.target.identityPath);
    const cacheKey = qualificationCacheKey({
      target: discovery.target,
      identity,
      version: version.value,
      platform,
      probeRevision,
    });
    if (cacheKey === undefined || !this.cache.has(cacheKey)) {
      const schema = await this.qualifySchema(discovery.target);
      if (!schema.ok) return schema;
      if (cacheKey !== undefined) this.cache.add(cacheKey);
    }

    const live = await this.qualifyLive(discovery.target, options.workspace);
    if (!live.ok) return live;
    const profile = buildProfile({
      target: discovery.target,
      version: version.value,
      platform,
      probeRevision,
    });
    return {
      ok: true,
      harness: new CodexPreparedHarness(
        profile,
        live.process,
        live.diagnostics,
        this.overrides.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
        this.overrides.qualificationObserver,
      ),
    };
  }

  private discover(
    options: PrepareOptions,
  ):
    | { readonly ok: true; readonly target: TDiscoveredTarget }
    | { readonly ok: false; readonly failure: HarnessFailure } {
    const discoveryOptions: {
      configuredExecutable?: string;
      env: NodeJS.ProcessEnv;
      platform?: NodeJS.Platform;
      path?: string;
      resolve?: (name: string) => string | undefined;
    } = {
      env: this.overrides.env ?? process.env,
    };
    if (options.configuredExecutable !== undefined) {
      discoveryOptions.configuredExecutable = options.configuredExecutable;
    }
    discoveryOptions.platform = observedPlatform(this.overrides.platform);
    if (this.overrides.path !== undefined) {
      discoveryOptions.path = this.overrides.path;
    }
    if (this.overrides.resolve !== undefined) {
      discoveryOptions.resolve = this.overrides.resolve;
    }
    const discovery = discoverCodex(discoveryOptions);
    if (discovery.kind === "found") {
      const target = discoveredCodexTarget(discovery);
      return {
        ok: true,
        target: {
          source: discovery.attempt.description,
          executable: target.executable,
          prefixArgs: target.prefixArgs,
          identityPath: target.identityPath,
          shim: target.shim,
        },
      };
    }
    if (discovery.kind === "unsupported-shim") {
      return {
        ok: false,
        failure: failure(
          "unsupported-shim",
          `Refusing ${discovery.attempt.description}: '${discovery.path}' is a Windows shim the resolver cannot parse. Name the interpreter, or point ${CODEX_EXECUTABLE_ENV} at the real executable.`,
        ),
      };
    }
    const searched = discovery.attempts
      .map((attempt) => attempt.description)
      .join(", ");
    return {
      ok: false,
      failure: failure(
        "not-found",
        `No Codex executable found. Searched: ${searched}.`,
      ),
    };
  }

  private probeVersion(
    target: TDiscoveredTarget,
  ): Promise<TProbeResult<string>> {
    return runTextProbe({
      target,
      args: ["--version"],
      category: "version-probe",
      description: "Codex version probe",
      timeoutMs: this.overrides.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    });
  }

  private async qualifySchema(
    target: TDiscoveredTarget,
  ): Promise<TProbeResult<true>> {
    const directory = mkdtempSync(join(tmpdir(), "secant-codex-schema-"));
    try {
      const generated = await runTextProbe({
        target,
        args: ["app-server", "generate-json-schema", "--out", directory],
        category: "schema-probe",
        description: "Codex stable-schema probe",
        timeoutMs: this.overrides.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        allowEmpty: true,
      });
      if (!generated.ok) return generated;
      const schemaPath = join(directory, GENERATED_SCHEMA_FILE);
      const size = statSync(schemaPath).size;
      if (size > MAX_SCHEMA_BYTES) {
        return failedProbe(
          "protocol-incompatible",
          `Generated Codex schema exceeds ${MAX_SCHEMA_BYTES} bytes.`,
        );
      }
      const schemaText = readFileSync(schemaPath, "utf8");
      this.overrides.qualificationObserver?.schema(schemaText);
      const parsed = JSON.parse(schemaText);
      const validated = validateRequiredSchema(parsed);
      if (!validated.ok) {
        return failedProbe(
          "protocol-incompatible",
          `Generated Codex schema is incompatible: ${validated.diagnostics}.`,
        );
      }
      return { ok: true, value: true };
    } catch (cause) {
      return {
        ok: false,
        failure: failureWithCause(
          "protocol-incompatible",
          "Codex did not produce a readable stable schema bundle.",
          cause,
        ),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  private async qualifyLive(
    target: TDiscoveredTarget,
    workspace: string,
  ): Promise<TLiveQualification> {
    const spawn = this.overrides.spawn ?? spawnOwnedProcess;
    const spawned = await spawn({
      executable: target.executable,
      args: target.prefixArgs.concat("app-server"),
      cwd: workspace,
      env: process.env,
      launchTimeoutMs:
        this.overrides.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
    });
    if (!spawned.ok) {
      return {
        ok: false,
        failure: failureWithCause(
          "app-server-launch",
          "Could not launch Codex app-server.",
          spawned.failure.cause,
        ),
      };
    }

    const connection = new CodexQualificationConnection(
      spawned.process,
      this.overrides.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      this.overrides.qualificationObserver,
    );
    const diagnosticCapture = new CodexDiagnosticCapture(
      spawned.process.stderr,
    );
    try {
      await connection.initialize();
      const account = await connection.readAccount();
      if (
        account.requiresOpenaiAuth &&
        (account.account === null || account.account === undefined)
      ) {
        const authFailure = failure("authentication", AUTHENTICATION_REQUIRED);
        return {
          ok: false,
          failure: await failedQualification({
            process: spawned.process,
            diagnostics: diagnosticCapture,
            failure: authFailure,
            cleanupTimeoutMs:
              this.overrides.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
            includeStderr: false,
          }),
        };
      }
      await connection.listModels();
      return {
        ok: true,
        process: spawned.process,
        diagnostics: diagnosticCapture,
      };
    } catch (cause) {
      const failureDiagnostics =
        cause instanceof Error ? cause.message : "unknown protocol failure";
      return {
        ok: false,
        failure: await failedQualification({
          process: spawned.process,
          diagnostics: diagnosticCapture,
          failure: failureWithCause(
            "protocol-incompatible",
            `Codex live qualification failed: ${failureDiagnostics}`,
            cause,
          ),
          cleanupTimeoutMs:
            this.overrides.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
          includeStderr: true,
        }),
      };
    }
  }
}

class CodexPreparedHarness implements PreparedHarness {
  private closePromise: Promise<CleanupReport> | undefined;

  constructor(
    readonly profile: HarnessProfile,
    private readonly process: OwnedProcess,
    private readonly diagnostics: CodexDiagnosticCapture,
    private readonly cleanupTimeoutMs: number,
    private readonly observer: CodexQualificationObserver | undefined,
  ) {}

  startTurn(_request: TurnRequest): HarnessTurn {
    throw new Error("Codex Turn execution is not available in this slice.");
  }

  close(): Promise<CleanupReport> {
    if (this.closePromise === undefined) {
      this.closePromise = this.closeProcess();
    }
    return this.closePromise;
  }

  private async closeProcess(): Promise<CleanupReport> {
    const closed = await this.process.closeStdin(this.cleanupTimeoutMs);
    this.observer?.closed(
      closed.kind,
      closed.kind === "exited" ? closed.status : undefined,
    );
    const diagnosticResult = await this.diagnostics.settle(
      this.cleanupTimeoutMs,
    );
    if (closed.kind === "exited" && closed.status === 0) {
      if (diagnosticResult.cause !== undefined) {
        const detail =
          "Codex app-server closed, but stderr did not drain cleanly.";
        return {
          clean: false,
          detail,
          failure: failureWithCause(
            "cleanup",
            appendStderr(detail, diagnosticResult.text),
            diagnosticResult.cause,
          ),
          sessions: [],
        };
      }
      return {
        clean: true,
        detail: "Codex app-server closed after stdin EOF.",
        sessions: [],
      };
    }
    const detail = appendStderr(
      `Codex app-server cleanup ended '${closed.kind}'.`,
      diagnosticResult.text,
    );
    const causes: unknown[] = [];
    if (closed.kind === "cleanup-error" || closed.kind === "spawn-error") {
      causes.push(closed.cause);
    }
    if (diagnosticResult.cause !== undefined) {
      causes.push(diagnosticResult.cause);
    }
    const cause = combinedCause(causes, "Codex cleanup failed");
    const cleanupFailure = failureWithOptionalCause("cleanup", detail, cause);
    return {
      clean: false,
      detail,
      failure: cleanupFailure,
      sessions: [],
    };
  }
}

interface TRunTextProbe {
  readonly target: TDiscoveredTarget;
  readonly args: readonly string[];
  readonly category: string;
  readonly description: string;
  readonly timeoutMs: number;
  readonly allowEmpty?: boolean;
}

async function runTextProbe(
  options: TRunTextProbe,
): Promise<TProbeResult<string>> {
  const result = await spawnCommand({
    executable: options.target.executable,
    args: options.target.prefixArgs.concat(options.args),
    cwd: undefined,
    env: process.env,
    timeoutMs: options.timeoutMs,
    maxCaptureBytes: 64 * 1024,
    truncationMarker: "…",
  });
  if (result.kind !== "exited") {
    return failedProbe(
      options.category,
      `${options.description} did not exit cleanly (${result.kind}).`,
    );
  }
  if (result.status !== 0) {
    return {
      ok: false,
      failure: failureWithNativeCode(
        options.category,
        `${options.description} exited ${result.status}.`,
        String(result.status),
      ),
    };
  }
  const text = new TextDecoder().decode(result.text).trim();
  if (text.length === 0 && options.allowEmpty !== true) {
    return failedProbe(
      options.category,
      `${options.description} produced no output.`,
    );
  }
  return { ok: true, value: text };
}

interface TCacheKey {
  readonly target: TDiscoveredTarget;
  readonly identity: string | undefined;
  readonly version: string;
  readonly platform: HarnessPlatform;
  readonly probeRevision: string;
}

function qualificationCacheKey(options: TCacheKey): string | undefined {
  if (options.identity === undefined) return undefined;
  return [
    options.target.source,
    options.target.identityPath,
    options.identity,
    options.version,
    options.platform,
    options.probeRevision,
  ].join("\0");
}

interface TBuildProfile {
  readonly target: TDiscoveredTarget;
  readonly version: string;
  readonly platform: HarnessPlatform;
  readonly probeRevision: string;
}

function buildProfile(options: TBuildProfile): HarnessProfile {
  const executableKind = options.target.shim ? "npm shim" : "native";
  return {
    harness: HARNESS_NAME,
    executable: `${options.target.source} -> ${options.target.identityPath} (${executableKind})`,
    executableVersion: options.version,
    platform: options.platform,
    adapterRevision: options.probeRevision,
    configurationPosture:
      "user-compatible: inherits the user's Codex home and environment; experimental API is disabled, while model, reasoning effort, personality, approval policy, and sandbox policy remain unset by Secant.",
    recovery: {
      mode: "native-reattach",
      evidence: "Codex reattaches a Session by its private native thread id.",
    },
    interruption: {
      mode: "active-turn",
      evidence:
        "Codex accepts turn/interrupt and confirms interruption at the terminal Turn event.",
    },
    approvals: {
      available: true,
      evidence:
        "Stable command and file approval requests support one-time accept and decline.",
    },
    clarifications: {
      available: false,
      evidence:
        "Native request-user-input is experimental and remains disabled; Secant does not emulate it.",
    },
    steer: {
      available: true,
      evidence: "Codex supports native same-Turn guidance through turn/steer.",
    },
    modelSelection: {
      at: "launch-and-per-turn",
      evidence:
        "The stable protocol accepts native model selection at thread and Turn start; M4 leaves user-owned selection unchanged.",
    },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence:
        "thread/start returns the private thread id before durable Turn admission and content submission.",
    },
    skillDelivery: {
      mode: "plain-path",
      evidence: "A skill Bundle Asset reaches Codex by its SKILL.md path.",
    },
    fileDelivery: {
      mode: "plain-path",
      evidence: "A file artifact reaches Codex as a plain absolute path.",
    },
  };
}

function fileIdentity(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function observedPlatform(
  override: CodexAdapterOverrides["platform"],
): NodeJS.Platform {
  if (typeof override === "function") return override();
  return override ?? process.platform;
}

function failure(category: string, diagnostics: string): HarnessFailure {
  return {
    phase: "prepare",
    category,
    possibleEffects: "none",
    diagnostics,
  };
}

function failureWithCause(
  category: string,
  diagnostics: string,
  cause: unknown,
): HarnessFailure {
  return {
    phase: "prepare",
    category,
    possibleEffects: "none",
    diagnostics,
    cause,
  };
}

function failureWithNativeCode(
  category: string,
  diagnostics: string,
  nativeCode: string,
): HarnessFailure {
  return {
    phase: "prepare",
    category,
    possibleEffects: "none",
    diagnostics,
    nativeCode,
  };
}

function failed(category: string, diagnostics: string): PrepareResult {
  return { ok: false, failure: failure(category, diagnostics) };
}

function failedProbe(
  category: string,
  diagnostics: string,
): TProbeResult<never> {
  return { ok: false, failure: failure(category, diagnostics) };
}

interface TFailedQualification {
  readonly process: OwnedProcess;
  readonly diagnostics: CodexDiagnosticCapture;
  readonly failure: HarnessFailure;
  readonly cleanupTimeoutMs: number;
  readonly includeStderr: boolean;
}

async function failedQualification(
  options: TFailedQualification,
): Promise<HarnessFailure> {
  const closed = await options.process.closeStdin(options.cleanupTimeoutMs);
  const diagnosticResult = await options.diagnostics.settle(
    options.cleanupTimeoutMs,
  );
  const stderr = options.includeStderr ? diagnosticResult.text : "";
  let diagnostics = options.failure.diagnostics ?? options.failure.category;
  diagnostics = appendStderr(diagnostics, stderr);
  const causes: unknown[] = [];
  if (options.failure.cause !== undefined) causes.push(options.failure.cause);
  if (diagnosticResult.cause !== undefined) {
    causes.push(diagnosticResult.cause);
  }
  if (closed.kind === "exited" && closed.status === 0) {
    return failureWithOptionalCause(
      options.failure.category,
      diagnostics,
      combinedCause(causes, "Codex qualification failed"),
    );
  }

  diagnostics += ` Cleanup ended '${closed.kind}'.`;
  const cleanupCause =
    closed.kind === "cleanup-error" || closed.kind === "spawn-error"
      ? closed.cause
      : new Error(`Codex cleanup ended '${closed.kind}'`);
  causes.push(cleanupCause);
  return failureWithCause(
    options.failure.category,
    diagnostics,
    new AggregateError(causes, "Codex qualification and cleanup failed"),
  );
}

function combinedCause(causes: readonly unknown[], message: string): unknown {
  if (causes.length === 0) return undefined;
  if (causes.length === 1) return causes[0];
  return new AggregateError(causes, message);
}

function appendStderr(diagnostics: string, stderr: string): string {
  if (stderr.length === 0) return diagnostics;
  return `${diagnostics} Codex stderr: ${stderr}`;
}

function failureWithOptionalCause(
  category: string,
  diagnostics: string,
  cause: unknown,
): HarnessFailure {
  if (cause === undefined) return failure(category, diagnostics);
  return failureWithCause(category, diagnostics, cause);
}
