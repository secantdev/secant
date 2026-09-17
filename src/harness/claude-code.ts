// The Claude Code Harness Adapter — private to the Harness Module, re-exported
// from `harness.ts` only through its factory. It discovers and qualifies the
// executable, then owns named stream-json Sessions and normalizes their Turns.
// Process spawning, pipe backpressure, and cleanup stay in the `process` Module;
// Claude-native frames and identifiers stay behind this Seam. The MCP permission
// bridge and detached-Session recovery land in later slices.

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import {
  resolveExecutable,
  spawnCommand,
  spawnOwnedProcess,
  type ExecutableResolution,
  type OwnedProcess,
  type OwnedProcessClose,
} from "../process/process.js";
import { APPROVAL_DECISIONS } from "./harness.js";
import type {
  CleanupReport,
  ControlReceipt,
  HarnessAdapter,
  HarnessFailure,
  HarnessPlatform,
  HarnessProfile,
  HarnessRequest,
  HarnessTurn,
  ModelObservation,
  PrepareOptions,
  PrepareResult,
  PreparedHarness,
  RecoveryCoordinate,
  RequestAnswer,
  RequestId,
  SessionAvailability,
  SessionFacts,
  SteerInput,
  TurnEvent,
  TurnEventListener,
  TurnRequest,
  TurnResult,
  TurnSubscription,
  UsageObservation,
} from "./harness.js";
import {
  EXPIRED_MESSAGE,
  startPermissionBridge,
  type ApprovalOutcome,
  type ApprovalRequest,
  type PermissionBridge,
} from "./permission-bridge.js";

/** The message a denied approval returns to the bridge caller. Claude sees it
 *  and adjusts its approach. */
const DENY_MESSAGE = "The tool use was denied.";

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
const DEFAULT_LAUNCH_TIMEOUT_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_STDERR_BYTES = 64 * 1024;

/** The exact remediation surfaced when Claude Code is not authenticated. Secant
 *  transports no credentials, so the fix is always to log in through Claude Code
 *  itself. The raw result is never carried across the Seam — it may quote a key. */
const AUTHENTICATION_REQUIRED =
  "Authentication required for Claude Code. Log in separately through Claude Code, then retry.";

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
  /** Override UUID generation for deterministic protocol replay. */
  readonly sessionId?: () => string;
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
      return {
        ok: true,
        harness: new ClaudeCodePreparedHarness(
          cached,
          target,
          options.workspace,
          this.overrides.sessionId ?? randomUUID,
        ),
      };
    }

    const probe = await this.probeVersion(target);
    if (!probe.ok) return { ok: false, failure: probe.failure };

    const profile = buildProfile(target, probe.version, platform);
    this.cache.set(cacheKey, profile);
    return {
      ok: true,
      harness: new ClaudeCodePreparedHarness(
        profile,
        target,
        options.workspace,
        this.overrides.sessionId ?? randomUUID,
      ),
    };
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

/** One prepared Harness owns every live named Session for one Workspace. It
 * permits one active Turn globally, while retaining each idle Session process
 * for a later Turn. */
class ClaudeCodePreparedHarness implements PreparedHarness {
  private readonly sessions = new Map<string, ClaudeCodeSession>();
  private active: ClaudeCodeTurn | undefined;
  private closed = false;
  private closePromise: Promise<CleanupReport> | undefined;
  /** One MCP permission bridge per prepared Harness, created lazily on the first
   *  launch that could prompt for permission, so a Harness that never runs a
   *  Turn pays nothing. #117 decides which Runs launch a Turn at all. */
  private bridgePromise: Promise<PermissionBridge> | undefined;

  constructor(
    readonly profile: HarnessProfile,
    private readonly target: DiscoveredTarget,
    private readonly workspace: string,
    private readonly createSessionId: () => string,
  ) {}

  /** Memoized bridge start. Its router raises each permission prompt on whatever
   *  Turn is active when Claude calls it. A failed start is not latched: the
   *  memo is cleared so a later Turn re-attempts rather than failing forever on a
   *  transient cause (e.g. a momentary loopback bind clash). */
  private ensureBridge(): Promise<PermissionBridge> {
    if (this.bridgePromise === undefined) {
      const started = startPermissionBridge((request) =>
        this.routeApproval(request),
      ).catch((error) => {
        if (this.bridgePromise === started) this.bridgePromise = undefined;
        throw error;
      });
      this.bridgePromise = started;
    }
    return this.bridgePromise;
  }

  /** Relay one bridge call to the active Turn. With no live Turn to raise it on,
   *  the prompt is denied as expired rather than left hanging. */
  private routeApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const turn = this.active;
    if (turn === undefined || turn.settled) {
      return Promise.resolve({ decision: "deny", message: EXPIRED_MESSAGE });
    }
    return turn.raiseApproval(request.tool, request.input);
  }

  startTurn(request: TurnRequest): HarnessTurn {
    if (this.closed) {
      throw new Error("startTurn after close: the prepared Harness is closed");
    }
    if (this.active !== undefined && !this.active.settled) {
      throw new Error("startTurn while a Turn is active: one active Turn only");
    }

    let session = this.sessions.get(request.session);
    if (session === undefined) {
      // Resuming a Session this Prepared Harness has not tracked (e.g. after a
      // restart): its coordinate is the caller's recovery coordinate, not a fresh
      // mint — otherwise `--resume` would name a Session Claude Code never saw.
      const coordinate = request.resume?.opaque ?? this.createSessionId();
      session = new ClaudeCodeSession(
        request.session,
        this.target,
        this.workspace,
        coordinate,
        () => this.ensureBridge(),
      );
      this.sessions.set(request.session, session);
    }
    const turn = new ClaudeCodeTurn(request, session, () => {
      if (this.active === turn) this.active = undefined;
    });
    this.active = turn;
    session.start(turn);
    return turn;
  }

  close(): Promise<CleanupReport> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    // Expire any prompt the active Turn is waiting on, so a blocked bridge caller
    // is answered `expired` before its transport is torn down under it.
    this.active?.expireForShutdown();
    this.closePromise = this.closeSessions();
    return this.closePromise;
  }

  private async closeSessions(): Promise<CleanupReport> {
    const outcomes = await Promise.all(
      [...this.sessions.values()].map((session) => session.close()),
    );
    if (this.bridgePromise !== undefined) {
      const bridge = await this.bridgePromise.catch(() => undefined);
      await bridge?.close();
    }
    const failed = outcomes.find(
      (
        outcome,
      ): outcome is Extract<SessionCloseOutcome, { readonly clean: false }> =>
        !outcome.clean,
    );
    const sessions = outcomes.map((outcome) => ({
      session: outcome.session,
      availability: outcome.availability,
    }));
    if (failed !== undefined) {
      return {
        clean: false,
        detail: failed.detail,
        failure: failed.failure,
        sessions,
      };
    }
    return {
      clean: true,
      detail: `${outcomes.length} Claude Code Session(s) detached.`,
      sessions,
    };
  }
}

type SessionCloseOutcome = {
  readonly clean: boolean;
  readonly detail: string;
  readonly session: string;
  readonly availability: SessionAvailability;
} & (
  | { readonly clean: true }
  | { readonly clean: false; readonly failure: HarnessFailure }
);

class ClaudeCodeSession {
  readonly coordinate: RecoveryCoordinate;
  private process: OwnedProcess | undefined;
  private launchPromise:
    | Promise<
        | { readonly ok: true }
        | {
            readonly ok: false;
            readonly category: string;
            readonly cause: unknown;
          }
      >
    | undefined;
  private active: ClaudeCodeTurn | undefined;
  private closed = false;
  private initialized = false;
  /** True for the current process only when it was launched with `--resume`, so a
   *  non-acknowledging init is a recovery failure rather than a fresh not-started. */
  private resuming = false;
  /** Once a process has launched for this Session, any relaunch resumes rather than
   *  starts fresh — recovery never silently creates a new conversation. */
  private launchedOnce = false;
  /** Set when a resume was not acknowledged: the Session cannot continue and every
   *  further Turn fails with the same recovery failure. */
  private unusableReason: string | undefined;
  private effectiveModel: ModelObservation = { known: false };
  private stderr = "";

  constructor(
    readonly name: string,
    private readonly target: DiscoveredTarget,
    private readonly workspace: string,
    sessionId: string,
    private readonly ensureBridge: () => Promise<PermissionBridge>,
  ) {
    this.coordinate = { opaque: sessionId };
  }

  start(turn: ClaudeCodeTurn): void {
    this.active = turn;
    queueMicrotask(() => {
      void this.submit(turn);
    });
  }

  model(): ModelObservation {
    return this.effectiveModel;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isResuming(): boolean {
    return this.resuming;
  }

  observeInit(model: ModelObservation): void {
    this.initialized = true;
    this.effectiveModel = model;
  }

  markUnusable(reason: string): void {
    this.unusableReason = reason;
  }

  /** Confirmed interruption: SIGTERM to the process tree through the process
   *  Module, drain to exit, and settle. A process that stops on the graceful
   *  signal ends the Turn `interrupted` (process-only stop); one that has to be
   *  force-killed, or whose termination is unconfirmed, ends it `lost` with
   *  `interruption-unknown`. */
  async interrupt(turn: ClaudeCodeTurn): Promise<void> {
    if (this.active !== turn) return;
    const owned = this.process;
    if (owned === undefined) {
      turn.settleInterrupted();
      return;
    }
    // Claim sole ownership of the process before awaiting: a concurrent `close`
    // then sees no live process and cannot start its own termination sequence on
    // the same child, so the two never report divergent closes. `onClosed` sees
    // `this.process !== owned` and yields the result to this interrupt.
    this.process = undefined;
    this.active = undefined;
    const outcome = await owned.interrupt(DEFAULT_CLEANUP_TIMEOUT_MS);
    if (turn.settled) return;
    const close = outcome.close;
    if (close.kind === "cleanup-error" || close.kind === "cleanup-timeout") {
      turn.settleLost("interruption", turn.lastObservation, {
        phase: "control",
        category: "interruption-unknown",
        possibleEffects: "possible",
        diagnostics: `Claude Code termination was not confirmed: ${describeProcessResult(close)}.`,
        ...(close.kind === "cleanup-error" ? { cause: close.cause } : {}),
      });
      return;
    }
    if (outcome.escalated) {
      turn.settleLost("interruption", turn.lastObservation, {
        phase: "control",
        category: "interruption-unknown",
        possibleEffects: "possible",
        diagnostics: `Claude Code did not stop on SIGTERM and was force-killed (${describeProcessResult(close)}).`,
        ...processCode(close),
      });
      return;
    }
    turn.settleInterrupted();
  }

  async close(): Promise<SessionCloseOutcome> {
    this.closed = true;
    if (this.process === undefined && this.launchPromise === undefined) {
      const active = this.active;
      if (active !== undefined && !active.settled) {
        active.settleNotStarted(
          "closed-before-launch",
          "The prepared Harness closed before Claude Code launched.",
        );
      }
      this.active = undefined;
    }
    const launch = this.launchPromise;
    if (launch !== undefined) await launch;
    const owned = this.process;
    if (owned === undefined) {
      return {
        clean: true,
        detail: `Session '${this.name}' had no live process.`,
        session: this.name,
        availability: this.detached(),
      };
    }
    const result = await owned.closeStdin(DEFAULT_CLEANUP_TIMEOUT_MS);
    const clean = isCleanClose(result);
    const detail = describeClose(this.name, result);
    const availability: SessionAvailability =
      result.kind === "cleanup-error" || result.kind === "cleanup-timeout"
        ? {
            state: "unusable",
            reason: `Claude Code cleanup was not confirmed: ${describeProcessResult(result)}.`,
          }
        : this.detached();
    const common = {
      detail,
      session: this.name,
      availability,
    };
    if (clean) return { clean: true, ...common };
    return {
      clean: false,
      ...common,
      failure: cleanupFailure(result, detail),
    };
  }

  private async submit(turn: ClaudeCodeTurn): Promise<void> {
    if (turn.settled) return;

    if (this.unusableReason !== undefined) {
      turn.settleRecoveryFailure(this.unusableReason, this.model());
      return;
    }

    const admission = await turn.admit(this.coordinate);
    if (!admission.recorded) {
      const owned = this.process;
      if (owned !== undefined) {
        this.process = undefined;
        this.active = undefined;
        await owned.closeStdin(DEFAULT_CLEANUP_TIMEOUT_MS);
      }
      turn.settleNotStarted(
        "durable-admission",
        admission.cause ?? admission.reason,
        admission.reason,
      );
      return;
    }
    if (turn.settled || this.closed) {
      if (!turn.settled) {
        turn.settleNotStarted(
          "closed-before-launch",
          "The prepared Harness closed before Claude Code launched.",
        );
      }
      return;
    }

    if (this.process === undefined) {
      const launch = this.launch(turn);
      this.launchPromise = launch;
      const launched = await launch;
      if (this.launchPromise === launch) this.launchPromise = undefined;
      if (!launched.ok) {
        turn.settleNotStarted(launched.category, launched.cause);
        return;
      }
    }
    if (turn.settled) return;
    if (this.closed) {
      turn.settleNotStarted(
        "closed-before-send",
        "The prepared Harness closed before the Turn was sent.",
      );
      return;
    }

    if (!this.initialized) turn.armHandshake(DEFAULT_HANDSHAKE_TIMEOUT_MS);
    try {
      await this.process!.writeStdin(encodeTurn(turn.request));
    } catch (error) {
      turn.settleLost("acceptance", "stdin write failed", {
        phase: "turn",
        category: "stdin-write",
        possibleEffects: "possible",
        cause: error,
      });
      void this.interrupt(turn);
      return;
    }
  }

  private async launch(turn: ClaudeCodeTurn): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly category: string;
        readonly cause: unknown;
      }
  > {
    let bridge: PermissionBridge;
    try {
      bridge = await this.ensureBridge();
    } catch (error) {
      return { ok: false, category: "permission-bridge", cause: error };
    }
    if (this.closed) {
      return { ok: false, category: "closed-before-launch", cause: undefined };
    }
    // A first launch mints the Session with `--session-id`; any relaunch (an
    // explicit resume coordinate, or a Session that already ran and detached)
    // reattaches with `--resume`, never a silent fresh conversation.
    const resuming = turn.request.resume !== undefined || this.launchedOnce;
    this.resuming = resuming;
    this.launchedOnce = true;
    // Each process re-runs its own init handshake, so init state is per process.
    this.initialized = false;
    const sessionArgs = resuming
      ? ["--resume", this.coordinate.opaque]
      : ["--session-id", this.coordinate.opaque];
    const launched = await spawnOwnedProcess({
      executable: this.target.executable,
      args: [
        ...this.target.prefixArgs,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        ...sessionArgs,
        // The MCP permission bridge: Claude relays every permission prompt to
        // this loopback tool and waits on it. The inline config carries the
        // per-Run bearer token; it is the only place the token appears.
        "--mcp-config",
        bridge.mcpConfigArg,
        "--permission-prompt-tool",
        bridge.toolName,
      ],
      cwd: this.workspace,
      env: process.env,
      launchTimeoutMs: DEFAULT_LAUNCH_TIMEOUT_MS,
    });
    if (!launched.ok) {
      // A spawn error carries the launch argv (Node's `spawnargs`), which
      // includes the bearer token; scrub it before it becomes a failure cause.
      return {
        ok: false,
        category: launched.failure.kind,
        cause: bridge.redactSecret(launched.failure.cause),
      };
    }

    const owned = launched.process;
    this.process = owned;
    void this.consumeStdout(owned).catch((error) => {
      this.active?.protocolCorruption(
        `stdout read failed: ${describe(error)}`,
        error,
      );
    });
    void this.consumeStderr(owned).catch((error) => {
      this.stderr += ` stderr read failed: ${describe(error)}`;
    });
    void owned.closed().then((result) => this.onClosed(owned, result));
    return { ok: true };
  }

  // Hand-rolled NDJSON line splitter, kept over `node:readline` deliberately
  // (D15). The growth rule points both ways to hand-roll: the framing is frozen
  // by the stream-json contract (it does not grow), and correctness depends on the
  // raw bytes — `readline` emits a final unterminated line as an ordinary line,
  // which would erase the `truncated JSON frame` diagnostic below (:745-747) that a
  // recorded `protocol-corruption` fixture pins, degrading it to `malformed JSON
  // frame`. So the builtin is a worse fit here, not a shorter one.
  private async consumeStdout(owned: OwnedProcess): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of owned.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        this.consumeLine(line);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    if (pending.trim().startsWith("{")) {
      this.active?.protocolCorruption("truncated JSON frame");
    }
  }

  private async consumeStderr(owned: OwnedProcess): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of owned.stderr) {
      if (this.stderr.length >= MAX_STDERR_BYTES) continue;
      this.stderr += decoder
        .decode(chunk, { stream: true })
        .slice(0, MAX_STDERR_BYTES - this.stderr.length);
    }
    if (this.stderr.length < MAX_STDERR_BYTES) this.stderr += decoder.decode();
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) return;
    let frame: unknown;
    try {
      frame = JSON.parse(trimmed);
    } catch (error) {
      this.active?.protocolCorruption("malformed JSON frame", error);
      return;
    }
    if (!isRecord(frame)) return;
    this.active?.acceptFrame(frame);
  }

  private onClosed(owned: OwnedProcess, result: OwnedProcessClose): void {
    // A confirmed interrupt claims the process before awaiting, so once it is in
    // flight `this.process !== owned` and the interrupt owns the result here.
    if (this.process !== owned) return;
    this.process = undefined;
    const turn = this.active;
    this.active = undefined;
    if (turn === undefined || turn.settled) return;
    if (turn.interrupting) {
      turn.settleInterrupted();
      return;
    }
    if (!this.initialized) {
      const diagnostics = `Claude Code closed before init (${describeProcessResult(result)}).${this.diagnostics()}`;
      turn.settleNotStarted(
        "initialization",
        result.kind === "cleanup-error" ? result.cause : diagnostics,
        diagnostics,
      );
      return;
    }
    turn.settleLost("completion", turn.lastObservation, {
      phase: "turn",
      category: "completion-unknown",
      possibleEffects: "possible",
      diagnostics: `Process closed before an authoritative result: ${describeProcessResult(result)}.${this.diagnostics()}`,
      ...processCode(result),
      ...(result.kind === "cleanup-error" ? { cause: result.cause } : {}),
    });
  }

  private detached(): SessionAvailability {
    return { state: "detached", coordinate: this.coordinate };
  }

  private diagnostics(): string {
    const text = this.stderr.trim();
    return text.length === 0 ? "" : ` stderr: ${text}`;
  }
}

/** One outstanding approval prompt awaiting an answer, expiry, or shutdown. */
interface PendingApproval {
  readonly request: HarnessRequest;
  status: "outstanding" | "settled";
  readonly resolve: (outcome: ApprovalOutcome) => void;
}

class ClaudeCodeTurn implements HarnessTurn {
  settled = false;
  interrupting = false;
  /** The last authoritative fact observed before truth could be lost — carried
   *  into a `lost` result so a caller sees how far the Turn got. */
  lastObservation = "no authoritative observation before the Turn ended";
  readonly request: TurnRequest;
  private readonly listeners = new Set<TurnEventListener>();
  private readonly events: TurnEvent[] = [];
  private readonly tools = new Map<string, string>();
  private readonly resultPromise: Promise<TurnResult>;
  private resolveResult!: (result: TurnResult) => void;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private preview = "";
  private previewIndex: number | undefined;
  /** Outstanding approval prompts, keyed by their exact request id. Several may
   *  coexist; each expires when the Turn ends, is interrupted, or is lost. */
  private readonly approvals = new Map<string, PendingApproval>();
  private approvalSeq = 0;

  constructor(
    request: TurnRequest,
    private readonly session: ClaudeCodeSession,
    private readonly onSettled: () => void,
  ) {
    this.request = request;
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  subscribe(listener: TurnEventListener): TurnSubscription {
    for (const event of this.events) listener(event);
    this.listeners.add(listener);
    return { unsubscribe: () => this.listeners.delete(listener) };
  }

  result(): Promise<TurnResult> {
    return this.resultPromise;
  }

  steer(_input: SteerInput): Promise<ControlReceipt> {
    return Promise.resolve(
      this.settled || this.interrupting
        ? { outcome: "rejected", reason: "expired" }
        : { outcome: "rejected", reason: "unsupported" },
    );
  }

  async interrupt(): Promise<ControlReceipt> {
    if (this.settled) return { outcome: "rejected", reason: "expired" };
    if (this.interrupting) {
      return { outcome: "rejected", reason: "already-settled" };
    }
    this.interrupting = true;
    // Expire prompts up front so the live bridge caller receives `expired`
    // before the process is terminated under it.
    this.expireOutstanding();
    await this.session.interrupt(this);
    return { outcome: "accepted" };
  }

  /** Raise one permission prompt on this Turn and resolve when it is answered or
   *  expired. Called only by the prepared Harness's bridge router. */
  raiseApproval(tool: string, input: string): Promise<ApprovalOutcome> {
    if (this.settled || this.interrupting) {
      return Promise.resolve({ decision: "deny", message: EXPIRED_MESSAGE });
    }
    const requestId: RequestId = { opaque: `approval-${this.approvalSeq++}` };
    const request: HarnessRequest = {
      requestId,
      shape: {
        kind: "approval",
        tool,
        input,
        decisions: [...APPROVAL_DECISIONS],
      },
    };
    return new Promise<ApprovalOutcome>((resolve) => {
      this.approvals.set(requestId.opaque, {
        request,
        status: "outstanding",
        resolve,
      });
      this.emit({ kind: "request-raised", request });
    });
  }

  answerRequest(answer: RequestAnswer): Promise<ControlReceipt> {
    if (this.settled || this.interrupting) {
      return Promise.resolve({ outcome: "rejected", reason: "expired" });
    }
    const pending = this.approvals.get(answer.requestId.opaque);
    if (pending === undefined) {
      return Promise.resolve({ outcome: "rejected", reason: "expired" });
    }
    if (pending.status === "settled") {
      return Promise.resolve({
        outcome: "rejected",
        reason: "already-settled",
      });
    }
    if (answer.kind !== pending.request.shape.kind) {
      // The request stays outstanding; a correctly shaped answer can still land.
      return Promise.resolve({ outcome: "rejected", reason: "shape-mismatch" });
    }
    pending.status = "settled";
    this.emit({
      kind: "request-answered",
      requestId: answer.requestId,
      by: "human",
      answer,
    });
    pending.resolve(
      answer.kind === "approval" && answer.decision === "allow"
        ? { decision: "allow" }
        : { decision: "deny", message: DENY_MESSAGE },
    );
    return Promise.resolve({ outcome: "accepted" });
  }

  /** Expire every still-outstanding prompt: emit its `request-expired` event and
   *  resolve its bridge call as a deny. Idempotent per request. Callers ensure
   *  this runs while the Turn is not yet settled so the events are observable. */
  private expireOutstanding(): void {
    for (const pending of this.approvals.values()) {
      if (pending.status !== "outstanding") continue;
      pending.status = "settled";
      this.emit({
        kind: "request-expired",
        requestId: pending.request.requestId,
      });
      pending.resolve({ decision: "deny", message: EXPIRED_MESSAGE });
    }
  }

  /** Expire outstanding prompts during `close`, before the process is reaped, so
   *  a blocked bridge caller is answered rather than severed. */
  expireForShutdown(): void {
    if (this.settled) return;
    this.expireOutstanding();
  }

  async admit(coordinate: RecoveryCoordinate): Promise<
    | { readonly recorded: true }
    | {
        readonly recorded: false;
        readonly reason: string;
        readonly cause?: unknown;
      }
  > {
    try {
      return await this.request.recorder.admit({
        correlationKey: this.request.correlationKey,
        session: this.request.session,
        origin: this.request.origin,
        input: this.request.input,
        recoveryCoordinate: coordinate,
        resume: this.request.resume,
      });
    } catch (error) {
      return { recorded: false, reason: describe(error), cause: error };
    }
  }

  armHandshake(timeoutMs: number): void {
    this.handshakeTimer = setTimeout(() => {
      this.settleNotStarted(
        "init-timeout",
        `Claude Code did not emit system/init within ${timeoutMs}ms.`,
      );
      void this.session.interrupt(this);
    }, timeoutMs);
  }

  acceptFrame(frame: Record<string, unknown>): void {
    if (this.settled) return;
    const type = stringField(frame, "type");
    if (type === "system" && stringField(frame, "subtype") === "init") {
      this.acceptInit(frame);
      return;
    }
    if (!this.session.isInitialized()) {
      if (type !== "result") this.emit(genericActivity(type));
      return;
    }
    switch (type) {
      case "assistant":
        this.acceptAssistant(frame);
        return;
      case "user":
        this.acceptToolResults(frame);
        return;
      case "stream_event":
        this.acceptStreamEvent(frame);
        return;
      case "result":
        this.acceptResult(frame);
        return;
      case "telemetry":
        return;
      default:
        this.emit(genericActivity(type));
    }
  }

  protocolCorruption(detail: string, cause?: unknown): void {
    if (this.settled) return;
    this.settleLost("completion", detail, {
      phase: "turn",
      category: "protocol-corruption",
      possibleEffects: "possible",
      diagnostics: detail,
      ...(cause !== undefined ? { cause } : {}),
    });
    void this.session.interrupt(this);
  }

  settleNotStarted(
    category: string,
    cause: unknown,
    diagnostics?: string,
  ): void {
    this.settle({
      kind: "not-started",
      detail: {
        failure: {
          phase:
            category === "spawn-error" || category === "launch-timeout"
              ? "launch"
              : "turn",
          category,
          possibleEffects: "none",
          cause,
          ...(diagnostics !== undefined ? { diagnostics } : {}),
        },
      },
    });
  }

  settleInterrupted(): void {
    this.settle({
      kind: "interrupted",
      detail: {
        interruption: {
          mode: "process-only",
          evidence: "Claude Code process termination ended the active Turn.",
        },
        session: {
          state: "detached",
          coordinate: this.session.coordinate,
        },
      },
    });
  }

  /** A resume that Claude Code did not acknowledge: the Session becomes unusable
   *  and the Turn fails in the `recovery` phase. Recovery never falls back to a
   *  fresh conversation, so this is a typed failure, not a new Session. */
  settleRecoveryFailure(
    reason: string,
    effectiveModel: ModelObservation,
  ): void {
    this.session.markUnusable(reason);
    this.settle({
      kind: "failed",
      detail: {
        failure: {
          phase: "recovery",
          category: "recovery-unacknowledged",
          // The Turn content was already sent before init, so a wrong conversation
          // may have acted on it.
          possibleEffects: "possible",
          diagnostics: reason,
        },
        effectiveModel,
        session: { state: "unusable", reason },
      },
    });
  }

  settleLost(
    unknown: "acceptance" | "completion" | "interruption",
    lastObservation: string,
    failure: HarnessFailure,
  ): void {
    this.settle({
      kind: "lost",
      detail: {
        unknown,
        lastObservation,
        session: {
          state: "detached",
          coordinate: this.session.coordinate,
        },
        failure,
      },
    });
  }

  private acceptInit(frame: Record<string, unknown>): void {
    this.clearHandshake();
    const nativeSessionId = stringField(frame, "session_id");
    if (nativeSessionId !== this.session.coordinate.opaque) {
      // A resume that the Harness does not acknowledge is a recovery failure that
      // makes the Session unusable — never a silent fresh conversation. A fresh
      // launch whose id is not echoed simply never started.
      if (this.session.isResuming()) {
        const reason =
          nativeSessionId === undefined
            ? "Claude Code --resume did not report a Session id, so the conversation cannot be reattached."
            : "Claude Code --resume acknowledged a different Session, so the conversation cannot be reattached.";
        this.settleRecoveryFailure(reason, this.session.model());
      } else {
        this.settleNotStarted(
          "init-session",
          nativeSessionId === undefined
            ? "Claude Code init omitted its Session id."
            : "Claude Code init did not acknowledge the minted Session id.",
        );
      }
      void this.session.interrupt(this);
      return;
    }
    const modelName = stringField(frame, "model");
    const model: ModelObservation =
      modelName === undefined
        ? { known: false }
        : { known: true, model: modelName };
    this.session.observeInit(model);
    this.lastObservation = "Claude Code acknowledged the Session at init";
    const facts = sessionFacts(frame, this.session.coordinate);
    this.emit({ kind: "session", availability: { state: "open" }, facts });
    this.emit({ kind: "model", observation: model });
    this.emit({ kind: "activity", description: describeSessionFacts(facts) });
  }

  private acceptAssistant(frame: Record<string, unknown>): void {
    const parentActivity = optionalString(frame.parent_tool_use_id);
    for (const block of contentBlocks(frame)) {
      const blockType = stringField(block, "type");
      if (blockType === "text") {
        const content = stringField(block, "text");
        if (content !== undefined) {
          this.clearPreview();
          this.lastObservation = `assistant content: ${truncate(content)}`;
          this.emit({
            kind: "assistant-content",
            content,
            ...(parentActivity !== undefined ? { parentActivity } : {}),
          });
        }
        continue;
      }
      if (blockType !== "tool_use") continue;
      const tool = stringField(block, "name") ?? "unknown tool";
      const id = stringField(block, "id");
      if (id !== undefined) this.tools.set(id, tool);
      this.emit({
        kind: "tool-activity",
        activity: {
          tool,
          phase: "started",
          summary: summarize(block.input),
          ...(parentActivity !== undefined ? { parentActivity } : {}),
        },
      });
    }
  }

  private acceptToolResults(frame: Record<string, unknown>): void {
    const parentActivity = optionalString(frame.parent_tool_use_id);
    for (const block of contentBlocks(frame)) {
      if (stringField(block, "type") !== "tool_result") continue;
      const id = stringField(block, "tool_use_id");
      const tool = id === undefined ? undefined : this.tools.get(id);
      this.emit({
        kind: "tool-activity",
        activity: {
          tool: tool ?? "unknown tool",
          phase: "completed",
          summary: summarize(block.content),
          ...(parentActivity !== undefined ? { parentActivity } : {}),
        },
      });
    }
  }

  private acceptStreamEvent(frame: Record<string, unknown>): void {
    if (!isRecord(frame.event) || !isRecord(frame.event.delta)) return;
    if (stringField(frame.event.delta, "type") !== "text_delta") return;
    const text = stringField(frame.event.delta, "text");
    if (text !== undefined) this.emitPreview(text);
  }

  private acceptResult(frame: Record<string, unknown>): void {
    const usage = usageObservation(frame);
    if (usage !== undefined) this.emit({ kind: "usage", observation: usage });
    const subtype = stringField(frame, "subtype") ?? "unknown-result";
    // Authentication is recognized before the success branch: #115's recording
    // pinned the real signal — the not-logged-in result arrives as
    // `subtype:"success"` but with `is_error:true`, zero cost, and empty usage, and
    // `result:"Not logged in · Please run /login"`. Guard the success case on that
    // `is_error` flag: a real answer whose text merely quotes a login phrase settles
    // with `is_error:false`, so it stays a completed Turn. A non-`success` result
    // matching the pattern is an auth failure regardless, as before.
    if (
      isAuthenticationResult(frame) &&
      (subtype !== "success" || frame.is_error === true)
    ) {
      // Never carry the raw result across the Seam: it may quote a key or token.
      // Only the fixed remediation message reaches the caller.
      this.settle({
        kind: "failed",
        detail: {
          failure: {
            phase: "turn",
            category: "authentication",
            possibleEffects: "none",
            diagnostics: AUTHENTICATION_REQUIRED,
          },
          effectiveModel: this.session.model(),
          session: { state: "open" },
        },
      });
      return;
    }
    if (subtype === "success") {
      const finalContent = stringField(frame, "result");
      this.settle({
        kind: "completed",
        detail: {
          ...(finalContent !== undefined ? { finalContent } : {}),
          effectiveModel: this.session.model(),
          session: { state: "open" },
          ...(usage !== undefined ? { usage } : {}),
        },
      });
      return;
    }
    this.settle({
      kind: "failed",
      detail: {
        failure: {
          phase: "turn",
          category: subtype,
          possibleEffects: "possible",
          ...(stringField(frame, "result") !== undefined
            ? { partialOutput: stringField(frame, "result") }
            : {}),
        },
        effectiveModel: this.session.model(),
        session: { state: "open" },
      },
    });
  }

  private emit(event: TurnEvent): void {
    if (this.settled) return;
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  private emitPreview(delta: string): void {
    if (this.settled) return;
    this.preview += delta;
    const event: TurnEvent = { kind: "preview", text: this.preview };
    if (this.previewIndex === undefined) {
      this.previewIndex = this.events.length;
      this.events.push(event);
    } else {
      this.events[this.previewIndex] = event;
    }
    for (const listener of this.listeners) listener(event);
  }

  private clearPreview(): void {
    if (this.previewIndex === undefined) return;
    this.events.splice(this.previewIndex, 1);
    this.previewIndex = undefined;
    this.preview = "";
  }

  private settle(result: TurnResult): void {
    if (this.settled) return;
    this.clearHandshake();
    this.clearPreview();
    // Terminal ordering: expire every outstanding prompt (its events publish
    // here) before the producer closes and the one result settles.
    this.expireOutstanding();
    this.settled = true;
    this.onSettled();
    this.resolveResult(result);
  }

  private clearHandshake(): void {
    if (this.handshakeTimer === undefined) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }
}

function encodeTurn(request: TurnRequest): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: request.input.text },
      parent_tool_use_id: null,
    })}\n`,
  );
}

function contentBlocks(
  frame: Record<string, unknown>,
): Record<string, unknown>[] {
  if (!isRecord(frame.message) || !Array.isArray(frame.message.content)) {
    return [];
  }
  return frame.message.content.filter(isRecord);
}

function sessionFacts(
  frame: Record<string, unknown>,
  coordinate: RecoveryCoordinate,
): SessionFacts {
  const tools = Array.isArray(frame.tools)
    ? frame.tools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const mcp = Array.isArray(frame.mcp_servers)
    ? frame.mcp_servers.filter(isRecord).flatMap((server) => {
        const name = stringField(server, "name");
        const status = stringField(server, "status");
        return name === undefined || status === undefined
          ? []
          : [{ name, status }];
      })
    : [];
  const executableVersion = stringField(frame, "claude_code_version");
  return {
    recoveryCoordinate: coordinate,
    tools,
    mcp,
    ...(executableVersion !== undefined ? { executableVersion } : {}),
  };
}

function describeSessionFacts(facts: SessionFacts): string {
  const version = facts.executableVersion ?? "unknown version";
  const tools = facts.tools.length === 0 ? "no tools" : facts.tools.join(", ");
  const mcp =
    facts.mcp.length === 0
      ? "no MCP servers"
      : facts.mcp.map((server) => `${server.name}=${server.status}`).join(", ");
  return `Claude Code ${version}; tools: ${tools}; MCP: ${mcp}`;
}

function usageObservation(
  frame: Record<string, unknown>,
): UsageObservation | undefined {
  const parts: string[] = [];
  if (isRecord(frame.usage)) {
    const input = numberField(frame.usage, "input_tokens");
    const output = numberField(frame.usage, "output_tokens");
    if (input !== undefined) parts.push(`input ${input}`);
    if (output !== undefined) parts.push(`output ${output} tokens`);
  }
  const cost = numberField(frame, "total_cost_usd");
  if (cost !== undefined) parts.push(`cost estimate USD ${cost}`);
  if (parts.length === 0) return undefined;
  return {
    estimate: true,
    summary: parts.join(", ").replace(", cost", "; cost"),
  };
}

function genericActivity(type: string | undefined): TurnEvent {
  return {
    kind: "activity",
    description: `Claude Code activity: ${type ?? "unknown"}`,
  };
}

function summarize(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "unavailable";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max = 200): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/** The native exit code or terminating signal of a close, as a diagnostic code.
 *  Never a raw frame. */
function processCode(result: OwnedProcessClose): { nativeCode?: string } {
  if (result.kind === "exited") return { nativeCode: String(result.status) };
  if (result.kind === "signal" && result.signal !== null) {
    return { nativeCode: result.signal };
  }
  return {};
}

/** Claude Code reports a not-logged-in run as its stdout result (research:
 *  "missing authentication ... emitted as the stdout result"). No typed auth field
 *  exists in the documented print-mode contract, so this recognises the documented
 *  not-logged-in remediation phrasings only — bare words like "unauthorized" or
 *  "credential" are deliberately excluded so a task result that merely mentions
 *  them keeps its real diagnostics rather than being masked by the login message.
 *  #115's recording pinned the signal: a not-logged-in run returns `subtype:"success"`
 *  with `result:"Not logged in · Please run /login"`, so this is checked before the
 *  success branch. The matched text is never surfaced — only `AUTHENTICATION_REQUIRED`. */
function isAuthenticationResult(frame: Record<string, unknown>): boolean {
  const text = [
    stringField(frame, "subtype") ?? "",
    stringField(frame, "result") ?? "",
    stringField(frame, "error") ?? "",
  ].join(" ");
  return /\bnot\s+logged\s+in\b|please (run \/login|log ?in)|\binvalid api key\b|\bauthentication (required|failed|error)\b|\bnot authenticated\b/i.test(
    text,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  return optionalString(value[field]);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(
  value: Record<string, unknown>,
  field: string,
): number | undefined {
  const found = value[field];
  return typeof found === "number" && Number.isFinite(found)
    ? found
    : undefined;
}

function isCleanClose(result: OwnedProcessClose): boolean {
  return result.kind === "exited" && result.status === 0;
}

function describeClose(session: string, result: OwnedProcessClose): string {
  return `Session '${session}' detached after ${describeProcessResult(result)}.`;
}

function describeProcessResult(result: OwnedProcessClose): string {
  switch (result.kind) {
    case "exited":
      return `process close with exit ${result.status}`;
    case "signal":
      return `process close from signal ${result.signal ?? "unknown"}`;
    case "spawn-error":
      return `process error: ${describe(result.cause)}`;
    case "cleanup-error":
      return `process cleanup error: ${describe(result.cause)}`;
    case "cleanup-timeout":
      return "process cleanup timeout";
  }
}

function cleanupFailure(
  result: OwnedProcessClose,
  diagnostics: string,
): HarnessFailure {
  return {
    phase: "cleanup",
    category: result.kind,
    possibleEffects:
      result.kind === "cleanup-error" || result.kind === "cleanup-timeout"
        ? "possible"
        : "none",
    diagnostics,
    ...(result.kind === "cleanup-error" ? { cause: result.cause } : {}),
    ...(result.kind === "exited"
      ? { nativeCode: String(result.status) }
      : result.kind === "signal" && result.signal !== null
        ? { nativeCode: result.signal }
        : {}),
  };
}

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
