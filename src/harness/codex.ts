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
  APPROVAL_DECISIONS,
  type CleanupReport,
  type ControlReceipt,
  type HarnessAdapter,
  type HarnessFailure,
  type HarnessPlatform,
  type HarnessProfile,
  type HarnessRequest,
  type HarnessTurn,
  type ModelObservation,
  type PrepareOptions,
  type PrepareResult,
  type PreparedHarness,
  type RecoveryCoordinate,
  type RequestId,
  type RequestAnswer,
  type SessionAvailability,
  type SteerCapability,
  type SteerInput,
  type TurnEvent,
  type TurnEventListener,
  type TurnRequest,
  type TurnResult,
  type TurnSubscription,
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
  type CodexRecordingObserver,
} from "./codex/qualification.js";
import { validateRequiredSchema } from "./codex/required-schema.js";
import {
  boundedCodexExchange,
  CodexExchangeTimeoutError,
  type CodexJsonlConnection,
  CodexProtocolError,
  CodexRpcResponseError,
  type CodexRpcEnvelope,
  parseRuntimeNotification,
  parseThreadResumeResult,
  parseThreadStartResult,
  parseTurnInterruptResult,
  parseTurnSteerResult,
  parseTurnStartResult,
} from "./codex/runtime-protocol.js";

export type { CodexRecordingObserver } from "./codex/qualification.js";

const HARNESS_NAME = "codex";
const PROBE_REVISION = "codex-probe-2";
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
  readonly platform?: NodeJS.Platform;
  /** Cache-key-only platform seam. Production uses the immutable host profile;
   *  tests vary this independently without lying to executable discovery. */
  readonly qualificationCachePlatform?: () => HarnessPlatform;
  readonly path?: string;
  readonly resolve?: (name: string) => string | undefined;
  readonly probeTimeoutMs?: number;
  readonly launchTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly probeRevision?: () => string;
  readonly spawn?: typeof spawnOwnedProcess;
  /** Recorder-only observation of the exact schema, protocol/stderr bytes, and
   *  shutdown. Production passes none; native data never reaches a caller. */
  readonly recordingObserver?: CodexRecordingObserver;
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
      readonly connection: CodexJsonlConnection;
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
    const nativePlatform = this.overrides.platform ?? process.platform;
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
    this.overrides.recordingObserver?.version(version.value);

    const probeRevision = this.overrides.probeRevision?.() ?? PROBE_REVISION;
    const cachePlatform =
      this.overrides.qualificationCachePlatform?.() ?? platform;
    const identity = fileIdentity(discovery.target.identityPath);
    const cacheKey = qualificationCacheKey({
      target: discovery.target,
      identity,
      version: version.value,
      platform: cachePlatform,
      probeRevision,
    });
    if (cacheKey === undefined || !this.cache.has(cacheKey)) {
      const schema = await this.qualifySchema(discovery.target, probeRevision);
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
        live.connection,
        live.diagnostics,
        options.workspace,
        this.overrides.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
        this.overrides.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
        this.overrides.recordingObserver,
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
    discoveryOptions.platform = this.overrides.platform ?? process.platform;
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
    probeRevision: string,
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
      this.overrides.recordingObserver?.schema(schemaText, probeRevision);
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
      this.overrides.recordingObserver,
    );
    const diagnosticCapture = new CodexDiagnosticCapture(
      spawned.process.stderr,
      this.overrides.recordingObserver,
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
            observer: this.overrides.recordingObserver,
          }),
        };
      }
      await connection.listModels();
      return {
        ok: true,
        process: spawned.process,
        diagnostics: diagnosticCapture,
        connection: connection.runtimeConnection(),
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
          observer: this.overrides.recordingObserver,
        }),
      };
    }
  }
}

class CodexPreparedHarness implements PreparedHarness {
  private closePromise: Promise<CleanupReport> | undefined;
  private readonly sessions = new Map<string, CodexSession>();
  private active: CodexTurn | undefined;
  private closed = false;

  constructor(
    readonly profile: HarnessProfile,
    private readonly process: OwnedProcess,
    private readonly connection: CodexJsonlConnection,
    private readonly diagnostics: CodexDiagnosticCapture,
    private readonly workspace: string,
    private readonly handshakeTimeoutMs: number,
    private readonly cleanupTimeoutMs: number,
    private readonly observer: CodexRecordingObserver | undefined,
  ) {
    this.connection.startRuntime({
      message: (message) => this.acceptMessage(message),
      ended: (cause) => {
        const active = this.active;
        if (active === undefined) return;
        if (cause instanceof CodexProtocolError) {
          active.protocolFailure(cause.message, cause);
          return;
        }
        active.connectionEnded(cause);
      },
    });
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
      session = new CodexSession(
        request.session,
        this.connection,
        this.workspace,
        this.handshakeTimeoutMs,
      );
      this.sessions.set(request.session, session);
    }
    const turn = new CodexTurn({
      request,
      session,
      steerCapability: this.profile.steer,
      connection: this.connection,
      controlTimeoutMs: this.handshakeTimeoutMs,
      onSettled: () => {
        if (this.active === turn) this.active = undefined;
      },
    });
    this.active = turn;
    session.start(turn);
    return turn;
  }

  close(): Promise<CleanupReport> {
    if (this.closePromise === undefined) {
      this.closed = true;
      this.closePromise = this.closeProcess();
    }
    return this.closePromise;
  }

  private async closeProcess(): Promise<CleanupReport> {
    const active = this.active;
    if (active !== undefined && !active.settled) {
      active.beginClose();
      await active.interruptForClose(this.cleanupTimeoutMs);
    }
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
          sessions: this.sessionReports(),
        };
      }
      return {
        clean: true,
        detail: "Codex app-server closed after stdin EOF.",
        sessions: this.sessionReports(),
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
      sessions: this.sessionReports(),
    };
  }

  private acceptMessage(message: CodexRpcEnvelope): void {
    const active = this.active;
    if (active === undefined || active.settled) return;
    try {
      const notification = parseRuntimeNotification(message);
      if (notification !== undefined) active.accept(notification);
    } catch (cause) {
      active.protocolFailure("Codex emitted incompatible runtime data.", cause);
    }
  }

  private sessionReports(): readonly {
    readonly session: string;
    readonly availability: SessionAvailability;
  }[] {
    return [...this.sessions.values()].map((session) => ({
      session: session.name,
      availability: session.availability(),
    }));
  }
}

class CodexSession {
  private coordinate: RecoveryCoordinate | undefined;
  private model: ModelObservation = { known: false };
  private detached = false;
  private unusableFailure: HarnessFailure | undefined;

  constructor(
    readonly name: string,
    private readonly connection: CodexJsonlConnection,
    private readonly workspace: string,
    private readonly handshakeTimeoutMs: number,
  ) {}

  start(turn: CodexTurn): void {
    queueMicrotask(() => void this.submit(turn));
  }

  availability(): SessionAvailability {
    if (this.unusableFailure !== undefined) {
      return {
        state: "unusable",
        reason: recoveryFailureDiagnostics(this.unusableFailure),
      };
    }
    return this.coordinate === undefined
      ? { state: "unusable", reason: "Codex thread was not created." }
      : { state: "detached", coordinate: this.coordinate };
  }

  markDetached(): void {
    this.detached = true;
  }

  respondToServerRequest(
    id: string | number,
    decision: "accept" | "decline",
  ): Promise<void> {
    return this.connection.respondToServerRequest(id, { decision });
  }

  private async submit(turn: CodexTurn): Promise<void> {
    if (this.unusableFailure !== undefined) {
      turn.settleRecoveryFailure(this.unusableFailure, this.model);
      return;
    }
    if (
      turn.request.resume !== undefined &&
      this.coordinate !== undefined &&
      turn.request.resume.opaque !== this.coordinate.opaque
    ) {
      this.failRecovery(
        turn,
        "Codex recovery requested a different thread than the one mapped to this Session.",
      );
      return;
    }
    const recoveryCoordinate =
      turn.request.resume ?? (this.detached ? this.coordinate : undefined);
    if (recoveryCoordinate !== undefined) {
      turn.recovering();
      try {
        const result = await boundedCodexExchange({
          operation: () =>
            this.connection.request("thread/resume", {
              threadId: recoveryCoordinate.opaque,
            }),
          timeoutMs: this.handshakeTimeoutMs,
          label: "thread/resume runtime exchange",
        });
        const resumed = parseThreadResumeResult(result);
        if (resumed.threadId !== recoveryCoordinate.opaque) {
          throw new CodexProtocolError(
            "thread/resume acknowledged a different Codex thread",
          );
        }
        this.coordinate = recoveryCoordinate;
        this.model = { known: true, model: resumed.model };
        this.detached = false;
        turn.recovered();
      } catch (cause) {
        this.failRecovery(turn, recoveryFailureReason(cause), cause);
        return;
      }
    }
    if (this.coordinate === undefined) {
      try {
        const result = await boundedCodexExchange({
          operation: () =>
            this.connection.request("thread/start", { cwd: this.workspace }),
          timeoutMs: this.handshakeTimeoutMs,
          label: "thread/start runtime exchange",
        });
        const started = parseThreadStartResult(result);
        this.coordinate = { opaque: started.threadId };
        this.model = { known: true, model: started.model };
      } catch (cause) {
        turn.settleNotStarted(
          "thread-start",
          "Codex did not create a fresh thread before Turn admission.",
          cause,
        );
        return;
      }
    }
    const coordinate = this.coordinate;
    if (coordinate === undefined || turn.settled) return;
    const admission = await turn.admit(coordinate);
    if (!admission.recorded) {
      turn.settleNotStarted(
        "durable-admission",
        admission.reason,
        admission.cause,
      );
      return;
    }
    if (turn.settled) return;
    turn.admitted(coordinate, this.model);
    turn.submitting();
    try {
      const result = await boundedCodexExchange({
        operation: () =>
          this.connection.request("turn/start", {
            threadId: coordinate.opaque,
            input: [{ type: "text", text: turn.request.input.text }],
          }),
        timeoutMs: this.handshakeTimeoutMs,
        label: "turn/start runtime exchange",
      });
      turn.acceptTurn(parseTurnStartResult(result));
    } catch (cause) {
      if (!turn.settled) turn.lostAcceptance(cause);
    }
  }

  private failRecovery(
    turn: CodexTurn,
    diagnostics: string,
    cause?: unknown,
  ): void {
    const failure: HarnessFailure = {
      phase: "recovery",
      category: "recovery-unacknowledged",
      possibleEffects: "none",
      diagnostics,
      ...(cause !== undefined ? { cause } : {}),
    };
    this.unusableFailure = failure;
    turn.settleRecoveryFailure(failure, this.model);
  }
}

type RuntimeNotification = NonNullable<
  ReturnType<typeof parseRuntimeNotification>
>;

interface PendingCodexApproval {
  readonly request: HarnessRequest;
  readonly nativeRequestId: string | number;
  status: "outstanding" | "answering" | "settled";
}

type TCodexNativeTarget = {
  readonly threadId: string;
  readonly turnId: string;
};

type TCodexTurnParams = {
  readonly request: TurnRequest;
  readonly session: CodexSession;
  readonly steerCapability: SteerCapability;
  readonly connection: CodexJsonlConnection;
  readonly controlTimeoutMs: number;
  readonly onSettled: () => void;
};

type TNativeTargetWait = {
  readonly label: string;
  readonly timeoutMs: number;
};

type TControlFailure = {
  readonly category: string;
  readonly diagnostics: string;
  readonly cause: unknown;
  readonly nativeCode?: string;
};

type TInterruptControlState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "targeting" | "sent" | "acknowledged" | "confirmed";
      readonly receipt: Promise<ControlReceipt>;
    };

class CodexTurn implements HarnessTurn {
  settled = false;
  readonly request: TurnRequest;
  private readonly session: CodexSession;
  private readonly steerCapability: SteerCapability;
  private readonly connection: CodexJsonlConnection;
  private readonly controlTimeoutMs: number;
  private readonly onSettled: () => void;
  private readonly listeners = new Set<TurnEventListener>();
  private readonly events: TurnEvent[] = [];
  private readonly resultPromise: Promise<TurnResult>;
  private resolveResult!: (result: TurnResult) => void;
  private admittedToRuntime = false;
  private submitted = false;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private model: ModelObservation = { known: false };
  private finalContent: string | undefined;
  private terminalError: string | undefined;
  private readonly pendingNotifications: RuntimeNotification[] = [];
  private preview = "";
  private previewIndex: number | undefined;
  private lastObservation = "no authoritative Codex Turn observation";
  private recoveryPending = false;
  private readonly approvals = new Map<string, PendingCodexApproval>();
  private readonly approvalsByNativeId = new Map<
    string,
    PendingCodexApproval
  >();
  private readonly approvalInputsByItemId = new Map<string, string>();
  private approvalSequence = 0;
  private readonly nativeTargetPromise: Promise<TCodexNativeTarget | undefined>;
  private resolveNativeTarget!: (
    target: TCodexNativeTarget | undefined,
  ) => void;
  private nativeTargetResolved = false;
  private interruptState: TInterruptControlState = { kind: "idle" };
  private closing = false;

  constructor(params: TCodexTurnParams) {
    this.request = params.request;
    this.session = params.session;
    this.steerCapability = params.steerCapability;
    this.connection = params.connection;
    this.controlTimeoutMs = params.controlTimeoutMs;
    this.onSettled = params.onSettled;
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
    this.nativeTargetPromise = new Promise((resolve) => {
      this.resolveNativeTarget = resolve;
    });
  }

  subscribe(listener: TurnEventListener): TurnSubscription {
    for (const event of this.events) listener(event);
    if (!this.settled) this.listeners.add(listener);
    return { unsubscribe: () => this.listeners.delete(listener) };
  }

  result(): Promise<TurnResult> {
    return this.resultPromise;
  }

  async steer(input: SteerInput): Promise<ControlReceipt> {
    if (this.settled || this.interruptState.kind !== "idle" || this.closing) {
      return { outcome: "rejected", reason: "expired" };
    }
    if (!this.steerCapability.available) {
      return steerReceipt(this.steerCapability);
    }
    const target = await this.waitForNativeTarget({
      label: "turn/steer target exchange",
      timeoutMs: this.controlTimeoutMs,
    });
    if (target === undefined || !this.acceptsNewInput()) {
      return { outcome: "rejected", reason: "expired" };
    }
    return this.steerTarget(input, target);
  }

  private async steerTarget(
    input: SteerInput,
    target: TCodexNativeTarget,
  ): Promise<ControlReceipt> {
    let acceptedWhileLive = false;
    let result: unknown;
    try {
      result = await boundedCodexExchange({
        operation: () =>
          this.connection.requestControl({
            method: "turn/steer",
            params: {
              threadId: target.threadId,
              expectedTurnId: target.turnId,
              input: [{ type: "text", text: input.text }],
            },
            onAccepted: () => {
              acceptedWhileLive = this.acceptsNewInput();
            },
          }),
        timeoutMs: this.controlTimeoutMs,
        label: "turn/steer control exchange",
      });
    } catch (cause) {
      return this.rejectControlFailure(
        "Codex turn/steer control failed.",
        cause,
      );
    }
    let steeredTurnId: string;
    try {
      steeredTurnId = parseTurnSteerResult(result);
    } catch (cause) {
      this.controlFailure({
        category: "protocol-corruption",
        diagnostics: "Codex emitted an invalid turn/steer response.",
        cause,
      });
      return { outcome: "rejected", reason: "expired" };
    }
    if (!acceptedWhileLive || steeredTurnId !== target.turnId) {
      return { outcome: "rejected", reason: "expired" };
    }
    return { outcome: "accepted" };
  }

  async interrupt(): Promise<ControlReceipt> {
    if (this.settled || this.closing) {
      return { outcome: "rejected", reason: "expired" };
    }
    if (this.interruptState.kind !== "idle") {
      return { outcome: "rejected", reason: "already-settled" };
    }
    return this.startInterrupt(this.controlTimeoutMs);
  }

  beginClose(): void {
    this.closing = true;
    this.expireOutstanding();
  }

  interruptForClose(timeoutMs: number): Promise<ControlReceipt> {
    if (this.settled) {
      return Promise.resolve({ outcome: "rejected", reason: "expired" });
    }
    if (this.interruptState.kind === "idle") {
      return this.startInterrupt(timeoutMs);
    }
    return this.waitForInterruptDuringClose(timeoutMs);
  }

  private startInterrupt(timeoutMs: number): Promise<ControlReceipt> {
    // Publish the control state before any already-ready target/response can
    // settle the async operation and reset it during the same microtask turn.
    const interrupt = Promise.resolve().then(() =>
      this.requestInterrupt(timeoutMs),
    );
    this.interruptState = { kind: "targeting", receipt: interrupt };
    return interrupt;
  }

  private async requestInterrupt(timeoutMs: number): Promise<ControlReceipt> {
    const target = await this.waitForNativeTarget({
      label: "turn/interrupt target exchange",
      timeoutMs,
    });
    if (target === undefined || this.settled) {
      this.interruptState = { kind: "idle" };
      return { outcome: "rejected", reason: "expired" };
    }
    const state = this.interruptState;
    if (state.kind !== "targeting") {
      return { outcome: "rejected", reason: "expired" };
    }
    this.interruptState = { kind: "sent", receipt: state.receipt };
    return this.interruptTarget(target, timeoutMs);
  }

  private async interruptTarget(
    target: TCodexNativeTarget,
    timeoutMs: number,
  ): Promise<ControlReceipt> {
    let result: unknown;
    try {
      result = await boundedCodexExchange({
        operation: () =>
          this.connection.request("turn/interrupt", {
            threadId: target.threadId,
            turnId: target.turnId,
          }),
        timeoutMs,
        label: "turn/interrupt control exchange",
      });
    } catch (cause) {
      if (cause instanceof CodexRpcResponseError) {
        this.interruptState = { kind: "idle" };
      }
      return this.rejectControlFailure(
        "Codex turn/interrupt control failed.",
        cause,
      );
    }
    try {
      parseTurnInterruptResult(result);
    } catch (cause) {
      this.controlFailure({
        category: "protocol-corruption",
        diagnostics: "Codex emitted an invalid turn/interrupt response.",
        cause,
      });
      return { outcome: "rejected", reason: "expired" };
    }
    const state = this.interruptState;
    if (state.kind === "confirmed") return { outcome: "accepted" };
    if (this.settled || state.kind !== "sent") {
      return { outcome: "rejected", reason: "expired" };
    }
    this.interruptState = { kind: "acknowledged", receipt: state.receipt };
    this.lastObservation = "Codex acknowledged turn/interrupt";
    return { outcome: "accepted" };
  }

  private async waitForInterruptDuringClose(
    timeoutMs: number,
  ): Promise<ControlReceipt> {
    const state = this.interruptState;
    if (state.kind === "idle") {
      return { outcome: "rejected", reason: "expired" };
    }
    try {
      return await boundedCodexExchange({
        operation: () => state.receipt,
        timeoutMs,
        label: "in-flight turn/interrupt during cleanup",
      });
    } catch {
      return { outcome: "rejected", reason: "expired" };
    }
  }

  private acceptsNewInput(): boolean {
    return (
      !this.settled && this.interruptState.kind === "idle" && !this.closing
    );
  }

  private async waitForNativeTarget(
    params: TNativeTargetWait,
  ): Promise<TCodexNativeTarget | undefined> {
    try {
      return await boundedCodexExchange({
        operation: () => this.nativeTargetPromise,
        timeoutMs: params.timeoutMs,
        label: params.label,
      });
    } catch {
      return undefined;
    }
  }

  private rejectControlFailure(
    diagnostics: string,
    cause: unknown,
  ): ControlReceipt {
    const expected = expectedControlRejection(cause);
    if (expected !== undefined) return expected;
    if (cause instanceof CodexRpcResponseError) {
      this.controlFailure({
        category: "native-control",
        diagnostics,
        cause,
        nativeCode: String(cause.code),
      });
      return { outcome: "rejected", reason: "expired" };
    }
    this.controlFailure({
      category:
        cause instanceof CodexExchangeTimeoutError
          ? "control-timeout"
          : "control-transport",
      diagnostics,
      cause,
    });
    return { outcome: "rejected", reason: "expired" };
  }

  private controlFailure(params: TControlFailure): void {
    if (this.settled) return;
    this.session.markDetached();
    const interruptionUnknown = this.interruptionOutcomeUnknown();
    const failure: HarnessFailure =
      params.nativeCode === undefined
        ? {
            phase: "control",
            category: params.category,
            possibleEffects: this.submitted ? "possible" : "none",
            diagnostics: params.diagnostics,
            cause: params.cause,
          }
        : {
            phase: "control",
            category: params.category,
            possibleEffects: this.submitted ? "possible" : "none",
            diagnostics: params.diagnostics,
            cause: params.cause,
            nativeCode: params.nativeCode,
          };
    this.settle({
      kind: "lost",
      detail: {
        unknown: interruptionUnknown
          ? "interruption"
          : this.turnId === undefined
            ? "acceptance"
            : "completion",
        lastObservation: this.lastObservation,
        session: this.session.availability(),
        failure,
      },
    });
  }

  async answerRequest(answer: RequestAnswer): Promise<ControlReceipt> {
    if (this.settled) return { outcome: "rejected", reason: "expired" };
    const pending = this.approvals.get(answer.requestId.opaque);
    if (pending === undefined) {
      return { outcome: "rejected", reason: "expired" };
    }
    if (pending.status !== "outstanding") {
      return { outcome: "rejected", reason: "already-settled" };
    }
    if (answer.kind !== "approval") {
      return { outcome: "rejected", reason: "shape-mismatch" };
    }
    pending.status = "answering";
    try {
      await this.session.respondToServerRequest(
        pending.nativeRequestId,
        answer.decision === "allow" ? "accept" : "decline",
      );
    } catch (cause) {
      if (pending.status === "answering") pending.status = "outstanding";
      this.protocolFailure(
        "Codex approval response could not be written to app-server.",
        cause,
      );
      return { outcome: "rejected", reason: "expired" };
    }
    if (this.settled) return { outcome: "rejected", reason: "expired" };
    if (pending.status !== "answering") {
      return { outcome: "rejected", reason: "already-settled" };
    }
    pending.status = "settled";
    this.emit({
      kind: "request-answered",
      requestId: answer.requestId,
      by: "human",
      answer,
    });
    return { outcome: "accepted" };
  }

  recovering(): void {
    this.recoveryPending = true;
  }

  recovered(): void {
    this.recoveryPending = false;
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
    } catch (cause) {
      return {
        recorded: false,
        reason: cause instanceof Error ? cause.message : String(cause),
        cause,
      };
    }
  }

  admitted(coordinate: RecoveryCoordinate, model: ModelObservation): void {
    this.admittedToRuntime = true;
    this.threadId = coordinate.opaque;
    this.model = model;
    this.lastObservation = "Codex acknowledged the Session thread";
    this.emit({
      kind: "session",
      availability: { state: "open" },
      facts: { recoveryCoordinate: coordinate, tools: [], mcp: [] },
    });
    this.emit({ kind: "model", observation: model });
  }

  submitting(): void {
    this.submitted = true;
  }

  acceptTurn(turnId: string): void {
    if (this.settled) return;
    const threadId = this.threadId;
    if (threadId === undefined) {
      this.protocolFailure(
        "turn/start was acknowledged before thread creation.",
      );
      return;
    }
    if (this.turnId !== undefined && this.turnId !== turnId) {
      this.protocolFailure("turn/start acknowledged a different Codex Turn.");
      return;
    }
    this.turnId = turnId;
    this.lastObservation = "Codex accepted turn/start";
    this.resolveTarget({ threadId, turnId });
    this.flushPendingNotifications();
  }

  accept(notification: RuntimeNotification): void {
    if (this.settled || !this.admittedToRuntime) return;
    if (notification.kind === "activity") {
      this.emit({ kind: "activity", description: notification.description });
      return;
    }
    if (notification.kind === "unsupported-server-request") {
      this.protocolFailure(
        `Codex raised unsupported server request '${notification.method}'.`,
      );
      return;
    }
    if (notification.threadId !== this.threadId) return;
    if (notification.kind === "server-request-resolved") {
      if (this.turnId === undefined) {
        this.pendingNotifications.push(notification);
        return;
      }
      this.resolveNativeRequest(notification.nativeRequestId);
      return;
    }
    if (notification.kind === "turn-started" && this.turnId === undefined) {
      this.pendingNotifications.push(notification);
      return;
    }
    if (this.turnId === undefined) {
      this.pendingNotifications.push(notification);
      return;
    }
    if (!this.matchesTurn(notification.turnId)) return;
    if (notification.kind === "approval-request") {
      this.raiseApproval(notification);
      return;
    }
    if (notification.kind === "turn-started") {
      this.lastObservation = "Codex emitted matching turn/started";
      return;
    }
    switch (notification.kind) {
      case "preview":
        this.lastObservation = "Codex emitted assistant preview content";
        this.emitPreview(notification.delta);
        return;
      case "item-event":
        if (notification.approvalInput !== undefined) {
          this.approvalInputsByItemId.set(
            notification.itemId,
            notification.approvalInput,
          );
        }
        if (notification.event !== undefined) {
          if (notification.event.kind === "assistant-content") {
            this.clearPreview();
            this.finalContent = notification.event.content;
            this.lastObservation =
              "Codex completed an authoritative agent message";
          }
          this.emit(notification.event);
        }
        return;
      case "error":
        if (!notification.willRetry) {
          this.terminalError = notification.message;
        }
        this.emit({
          kind: "activity",
          description: notification.willRetry
            ? `Codex is retrying after an error: ${notification.message}`
            : `Codex reported an error: ${notification.message}`,
        });
        return;
      case "turn-completed":
        this.acceptTerminal(notification);
        return;
    }
  }

  connectionEnded(cause?: unknown): void {
    if (this.settled) return;
    if (this.recoveryPending) return;
    if (!this.admittedToRuntime) {
      this.settleNotStarted(
        "app-server-closed",
        "Codex app-server closed before durable Turn admission.",
        cause,
      );
      return;
    }
    this.session.markDetached();
    const interruptionUnknown = this.interruptionOutcomeUnknown();
    this.settle({
      kind: "lost",
      detail: {
        unknown: interruptionUnknown
          ? "interruption"
          : this.turnId === undefined
            ? "acceptance"
            : "completion",
        lastObservation: this.lastObservation,
        session: this.session.availability(),
        failure: {
          phase: "turn",
          category: interruptionUnknown
            ? "interruption-unknown"
            : "app-server-closed",
          possibleEffects: this.submitted ? "possible" : "none",
          diagnostics: interruptionUnknown
            ? "Codex app-server closed before confirming native interruption."
            : "Codex app-server closed without a matching terminal Turn event.",
          ...(cause !== undefined ? { cause } : {}),
        },
      },
    });
  }

  lostAcceptance(cause: unknown): void {
    this.session.markDetached();
    this.settle({
      kind: "lost",
      detail: {
        unknown: "acceptance",
        lastObservation: this.lastObservation,
        session: this.session.availability(),
        failure: {
          phase: "turn",
          category: "turn-start",
          possibleEffects: "possible",
          diagnostics: "Codex did not acknowledge turn/start.",
          cause,
        },
      },
    });
  }

  settleNotStarted(
    category: string,
    diagnostics: string,
    cause?: unknown,
  ): void {
    this.settle({
      kind: "not-started",
      detail: {
        failure: {
          phase: "turn",
          category,
          possibleEffects: "none",
          diagnostics,
          ...(cause !== undefined ? { cause } : {}),
        },
      },
    });
  }

  settleRecoveryFailure(
    failure: HarnessFailure,
    effectiveModel: ModelObservation,
  ): void {
    const reason = recoveryFailureDiagnostics(failure);
    this.settle({
      kind: "failed",
      detail: {
        failure,
        effectiveModel,
        session: { state: "unusable", reason },
      },
    });
  }

  protocolFailure(diagnostics: string, cause?: unknown): void {
    if (this.settled) return;
    if (this.recoveryPending) return;
    if (!this.submitted) {
      this.settleNotStarted("protocol-corruption", diagnostics, cause);
      return;
    }
    this.session.markDetached();
    const interruptionUnknown = this.interruptionOutcomeUnknown();
    this.settle({
      kind: "lost",
      detail: {
        unknown: interruptionUnknown
          ? "interruption"
          : this.turnId === undefined
            ? "acceptance"
            : "completion",
        lastObservation: this.lastObservation,
        session: this.session.availability(),
        failure: {
          phase: "turn",
          category: "protocol-corruption",
          possibleEffects: "possible",
          diagnostics,
          ...(cause !== undefined ? { cause } : {}),
        },
      },
    });
  }

  private matchesTurn(turnId: string): boolean {
    return this.turnId === turnId;
  }

  private raiseApproval(
    notification: Extract<
      RuntimeNotification,
      { readonly kind: "approval-request" }
    >,
  ): void {
    const nativeKey = nativeRequestKey(notification.nativeRequestId);
    if (this.approvalsByNativeId.has(nativeKey)) {
      this.protocolFailure("Codex reused an outstanding server request id.");
      return;
    }
    const input =
      notification.input ??
      this.approvalInputsByItemId.get(notification.itemId);
    if (input === undefined || input.length === 0) {
      this.protocolFailure(
        `Codex raised ${notification.tool} approval without exact action context.`,
      );
      return;
    }
    const requestId: RequestId = {
      opaque: `codex-approval-${this.approvalSequence++}`,
    };
    const request: HarnessRequest = {
      requestId,
      shape: {
        kind: "approval",
        tool: notification.tool,
        input,
        decisions: [...APPROVAL_DECISIONS],
      },
    };
    const pending: PendingCodexApproval = {
      request,
      nativeRequestId: notification.nativeRequestId,
      status: "outstanding",
    };
    this.approvals.set(requestId.opaque, pending);
    this.approvalsByNativeId.set(nativeKey, pending);
    this.emit({ kind: "request-raised", request });
  }

  private resolveNativeRequest(nativeRequestId: string | number): void {
    const pending = this.approvalsByNativeId.get(
      nativeRequestKey(nativeRequestId),
    );
    if (pending === undefined || pending.status === "settled") return;
    pending.status = "settled";
    this.emit({
      kind: "request-expired",
      requestId: pending.request.requestId,
    });
  }

  private expireOutstanding(): void {
    for (const pending of this.approvals.values()) {
      if (pending.status === "settled") continue;
      pending.status = "settled";
      this.emit({
        kind: "request-expired",
        requestId: pending.request.requestId,
      });
    }
  }

  private flushPendingNotifications(): void {
    for (const notification of this.pendingNotifications.splice(0)) {
      this.accept(notification);
    }
  }

  private acceptTerminal(
    notification: Extract<
      RuntimeNotification,
      { readonly kind: "turn-completed" }
    >,
  ): void {
    this.lastObservation = `Codex emitted turn/completed: ${notification.status}`;
    if (notification.status === "inProgress") {
      this.protocolFailure(
        "Codex turn/completed carried nonterminal status 'inProgress'.",
      );
      return;
    }
    if (notification.status === "completed") {
      this.settle({
        kind: "completed",
        detail: {
          ...(this.finalContent !== undefined
            ? { finalContent: this.finalContent }
            : {}),
          effectiveModel: this.model,
          session: { state: "open" },
        },
      });
      return;
    }
    if (notification.status === "interrupted") {
      this.confirmInterrupt();
      this.session.markDetached();
      this.settle({
        kind: "interrupted",
        detail: {
          interruption: {
            mode: "active-turn",
            evidence: "Codex emitted a matching interrupted terminal Turn.",
          },
          session: this.session.availability(),
        },
      });
      return;
    }
    const diagnostics =
      notification.error ?? this.terminalError ?? "Codex Turn failed.";
    this.settle({
      kind: "failed",
      detail: {
        failure: {
          phase: "turn",
          category: "execution",
          possibleEffects: "possible",
          diagnostics,
        },
        effectiveModel: this.model,
        session: { state: "open" },
      },
    });
  }

  private emit(event: TurnEvent): void {
    if (this.settled) return;
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  private confirmInterrupt(): void {
    const state = this.interruptState;
    if (state.kind === "idle") return;
    this.interruptState = { kind: "confirmed", receipt: state.receipt };
  }

  private interruptionOutcomeUnknown(): boolean {
    return (
      this.interruptState.kind === "sent" ||
      this.interruptState.kind === "acknowledged"
    );
  }

  private emitPreview(delta: string): void {
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
    this.resolveTarget(undefined);
    this.clearPreview();
    this.expireOutstanding();
    this.settled = true;
    this.listeners.clear();
    this.onSettled();
    this.resolveResult(result);
  }

  private resolveTarget(target: TCodexNativeTarget | undefined): void {
    if (this.nativeTargetResolved) return;
    this.nativeTargetResolved = true;
    this.resolveNativeTarget(target);
  }
}

function nativeRequestKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function steerReceipt(capability: SteerCapability): ControlReceipt {
  return capability.available
    ? { outcome: "accepted" }
    : { outcome: "rejected", reason: "unsupported" };
}

function expectedControlRejection(cause: unknown): ControlReceipt | undefined {
  if (!(cause instanceof CodexRpcResponseError) || cause.code !== -32_600) {
    return undefined;
  }
  // Mirrors codex-rs/app-server/src/request_processors/turn_processor.rs:
  // 1083-1153 and 1610-1619 are the current unstructured control races.
  const message = cause.rpcMessage;
  if (cause.method === "turn/interrupt") {
    if (
      message === "no active turn to interrupt" ||
      isExpectedTurnMismatch(cause.method, message)
    ) {
      return { outcome: "rejected", reason: "expired" };
    }
    return undefined;
  }
  if (cause.method !== "turn/steer") return undefined;
  if (message === "input must not be empty") {
    return { outcome: "rejected", reason: "shape-mismatch" };
  }
  if (
    message === "no active turn to steer" ||
    message === "cannot steer a review turn" ||
    message === "cannot steer a compact turn" ||
    message === "active turn uses a different output schema" ||
    isExpectedTurnMismatch(cause.method, message)
  ) {
    return { outcome: "rejected", reason: "expired" };
  }
  return undefined;
}

function isExpectedTurnMismatch(method: string, message: string): boolean {
  if (method === "turn/steer") {
    return /^expected active turn id `[^`\s]+` but found `[^`\s]+`$/.test(
      message,
    );
  }
  return /^expected active turn id \S+ but found \S+$/.test(message);
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

function recoveryFailureReason(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `Codex could not acknowledge the requested thread during recovery: ${detail}`;
}

function recoveryFailureDiagnostics(failure: HarnessFailure): string {
  return failure.diagnostics ?? "Codex thread recovery failed.";
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
      evidence:
        "Codex thread/resume must acknowledge the exact requested private thread before durable admission and content submission.",
    },
    interruption: {
      mode: "active-turn",
      evidence:
        "Codex confirms active-Turn interruption through the matching terminal Turn event.",
    },
    approvals: {
      available: true,
      evidence:
        "Qualified command and file approvals expose exact actions; allow accepts once and deny declines once.",
    },
    clarifications: {
      available: false,
      evidence:
        "Native request-user-input is experimental and remains disabled; Secant does not emulate it.",
    },
    steer: {
      available: true,
      evidence:
        "Codex accepts native same-Turn guidance addressed to the exact active thread and Turn.",
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
  readonly observer?: CodexRecordingObserver;
}

async function failedQualification(
  options: TFailedQualification,
): Promise<HarnessFailure> {
  const closed = await options.process.closeStdin(options.cleanupTimeoutMs);
  options.observer?.closed(
    closed.kind,
    closed.kind === "exited" ? closed.status : undefined,
  );
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
