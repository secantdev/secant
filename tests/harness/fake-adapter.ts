// The deterministic fake Harness Adapter. It lives in the `harness` test domain
// and implements the Harness Adapter Interface (src/harness/harness.ts) from a
// per-test script. It exists for what a recording of a real Harness cannot
// serve: it exercises Interface behaviours Claude Code never exhibits (native
// steer, structured clarifications, load-with-replay recovery, several
// concurrent requests, every `lost` variant), and it lets suites drive the
// Interface without spawning a process. It is never the only end-to-end double.
//
// Determinism without sleeps: a Turn awaits its scripted requests' answers and
// the caller's controls, never a timer. Terminal ordering is exact — remaining
// events publish, outstanding requests expire, the producer closes, then the
// one result settles, and nothing is emitted afterwards.

import type {
  CleanupReport,
  ControlReceipt,
  ControlRejection,
  HarnessAdapter,
  HarnessAdapterFactory,
  HarnessProfile,
  HarnessRequest,
  HarnessFailure,
  PrepareResult,
  PreparedHarness,
  RecordingReceipt,
  RequestAnswer,
  RequestShape,
  SteerInput,
  TurnEvent,
  TurnEventListener,
  TurnRequest,
  TurnResult,
  TurnSubscription,
} from "../../src/harness/harness.js";

/** One request the scripted Turn raises. `awaited` Turns settle only once it is
 *  answered; a non-awaited request is expired at terminal. */
export interface FakeRequestSpec {
  readonly id: string;
  readonly shape: RequestShape;
  readonly awaited: boolean;
}

/** One scripted Turn. `startTurn` consumes the next entry of `turns`. */
export interface FakeTurnScript {
  /** Events emitted in order before requests are awaited. Request lifecycle
   *  events are managed by the fake and must not appear here. */
  readonly events?: readonly TurnEvent[];
  readonly requests?: readonly FakeRequestSpec[];
  /** The result settled when the Turn ends naturally (all awaited requests
   *  answered, or no awaited requests). */
  readonly result: TurnResult;
  /** The result settled when the caller interrupts. Defaults to a plain
   *  `interrupted` result echoing the profile's interruption capability. */
  readonly interruptResult?: TurnResult;
  /** Whether native steer is accepted. Absent means steer is `unsupported`. */
  readonly supportsSteer?: boolean;
  /** A recovery coordinate revealed only after acceptance; recorded through the
   *  recorder's checkpoint and echoed on a `completed` result. */
  readonly revealCoordinateAfterAcceptance?: { readonly opaque: string };
}

/** The whole scripted Adapter. */
export interface FakeScript {
  readonly profile: HarnessProfile;
  /** When set, `prepare` returns this failure instead of a prepared Harness. */
  readonly prepareFailure?: HarnessFailure;
  readonly turns: readonly FakeTurnScript[];
  /** The report `close` returns; the same value on every call. */
  readonly cleanup?: CleanupReport;
}

const DEFAULT_CLEANUP: CleanupReport = {
  clean: true,
  detail: "fake harness closed",
};

/** Build a factory for the fake Adapter from a script. */
export function createFake(script: FakeScript): HarnessAdapterFactory {
  return () => new FakeAdapter(script);
}

class FakeAdapter implements HarnessAdapter {
  constructor(private readonly script: FakeScript) {}

  prepare(): Promise<PrepareResult> {
    if (this.script.prepareFailure) {
      return Promise.resolve({
        ok: false,
        failure: this.script.prepareFailure,
      });
    }
    return Promise.resolve({
      ok: true,
      harness: new FakePreparedHarness(this.script),
    });
  }
}

class FakePreparedHarness implements PreparedHarness {
  readonly profile: HarnessProfile;
  private turnIndex = 0;
  private active: FakeTurn | undefined;
  private closed = false;
  private readonly cleanup: CleanupReport;

  constructor(private readonly script: FakeScript) {
    this.profile = script.profile;
    this.cleanup = script.cleanup ?? DEFAULT_CLEANUP;
  }

  startTurn(request: TurnRequest): FakeTurn {
    if (this.closed) {
      throw new Error("startTurn after close: the prepared Harness is closed");
    }
    if (this.active && !this.active.settled) {
      throw new Error("startTurn while a Turn is active: one active Turn only");
    }
    const scripted = this.script.turns[this.turnIndex++];
    if (!scripted) {
      throw new Error("startTurn beyond the scripted Turns");
    }
    const turn = new FakeTurn(scripted, this.profile, request);
    this.active = turn;
    turn.begin();
    return turn;
  }

  close(): Promise<CleanupReport> {
    this.closed = true;
    // Idempotent: the same report every time.
    return Promise.resolve(this.cleanup);
  }
}

interface RequestState {
  readonly request: HarnessRequest;
  status: "outstanding" | "answered";
  /** Resolves the driver's wait once an awaited request is answered. */
  release?: () => void;
}

class FakeTurn {
  settled = false;
  private terminal = false;
  private interrupting = false;
  private resolveResult!: (result: TurnResult) => void;
  private readonly resultPromise: Promise<TurnResult>;
  private readonly listeners = new Set<TurnEventListener>();
  private readonly buffer: TurnEvent[] = [];
  private readonly requests = new Map<string, RequestState>();
  private interruptSignal?: () => void;

  constructor(
    private readonly script: FakeTurnScript,
    private readonly profile: HarnessProfile,
    private readonly request: TurnRequest,
  ) {
    this.resultPromise = new Promise<TurnResult>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  begin(): void {
    // The handle is already returned; drive on a microtask so a caller can
    // subscribe first.
    queueMicrotask(() => {
      void this.drive();
    });
  }

  subscribe(listener: TurnEventListener): TurnSubscription {
    // Replay history so a late subscriber sees the ordered stream from its
    // start. This is replay to a new consumer, not a new event, so it does not
    // breach terminal ordering even after the result has settled.
    for (const event of this.buffer) listener(event);
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  result(): Promise<TurnResult> {
    return this.resultPromise;
  }

  async steer(_input: SteerInput): Promise<ControlReceipt> {
    if (this.terminal) return reject("expired");
    if (!this.script.supportsSteer) return reject("unsupported");
    this.emit({ kind: "activity", description: "steer accepted" });
    return accept();
  }

  async interrupt(): Promise<ControlReceipt> {
    if (this.terminal) return reject("expired");
    if (this.interrupting) return reject("already-settled");
    this.interrupting = true;
    // Reject new inputs immediately; the driver drains to the interrupt result.
    this.terminal = true;
    this.interruptSignal?.();
    return accept();
  }

  async answerRequest(answer: RequestAnswer): Promise<ControlReceipt> {
    if (this.terminal) return reject("expired");
    const state = this.requests.get(answer.requestId.opaque);
    if (!state) return reject("expired");
    if (state.status === "answered") return reject("already-settled");
    if (answer.kind !== state.request.shape.kind)
      return reject("shape-mismatch");
    state.status = "answered";
    this.emit({
      kind: "request-answered",
      requestId: answer.requestId,
      by: "human",
      answer,
    });
    state.release?.();
    return accept();
  }

  private async drive(): Promise<void> {
    const admission = await this.admit();
    if (!admission.recorded) {
      this.settle(
        notStarted(
          admission.reason,
          "cause" in admission ? admission.cause : admission.reason,
        ),
      );
      return;
    }
    let checkpoint: RecordingReceipt | undefined;
    const coordinate = this.script.revealCoordinateAfterAcceptance;
    if (coordinate) {
      checkpoint = await this.request.recorder.checkpoint(coordinate);
    }

    if (!this.terminal) {
      for (const event of this.script.events ?? []) this.emit(event);
      await this.raiseAndAwaitRequests();
    }

    if (this.interrupting) {
      this.settle(this.script.interruptResult ?? this.defaultInterrupt());
      return;
    }
    this.settle(withCheckpoint(this.script.result, checkpoint));
  }

  private async admit(): Promise<
    | RecordingReceipt
    | {
        readonly recorded: false;
        readonly reason: string;
        readonly cause: unknown;
      }
  > {
    try {
      return await this.request.recorder.admit({
        correlationKey: this.request.correlationKey,
        session: this.request.session,
        origin: this.request.origin,
        input: this.request.input,
        recoveryCoordinate:
          this.request.resume ?? ({ opaque: this.request.session } as const),
        resume: this.request.resume,
      });
    } catch (error) {
      return { recorded: false, reason: describe(error), cause: error };
    }
  }

  private async raiseAndAwaitRequests(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const spec of this.script.requests ?? []) {
      const request: HarnessRequest = {
        requestId: { opaque: spec.id },
        shape: spec.shape,
      };
      const state: RequestState = { request, status: "outstanding" };
      this.requests.set(spec.id, state);
      this.emit({ kind: "request-raised", request });
      if (spec.awaited) {
        waits.push(
          new Promise<void>((resolve) => {
            state.release = resolve;
          }),
        );
      }
    }
    if (waits.length === 0) return;
    const interrupted = new Promise<void>((resolve) => {
      this.interruptSignal = resolve;
    });
    await Promise.race([Promise.all(waits), interrupted]);
  }

  /** Terminal ordering: expire outstanding requests, close the producer, then
   *  settle the one result. No event is emitted after this. */
  private settle(result: TurnResult): void {
    this.terminal = true;
    for (const [, state] of this.requests) {
      if (state.status === "outstanding") {
        this.emit({
          kind: "request-expired",
          requestId: state.request.requestId,
        });
      }
    }
    this.settled = true;
    this.resolveResult(result);
  }

  private emit(event: TurnEvent): void {
    if (this.settled) throw new Error("emit after result: terminal ordering");
    this.buffer.push(event);
    for (const listener of this.listeners) listener(event);
  }

  private defaultInterrupt(): TurnResult {
    return {
      kind: "interrupted",
      detail: {
        interruption: this.profile.interruption,
        session: {
          state: "detached",
          coordinate: { opaque: this.request.session },
        },
      },
    };
  }
}

function accept(): ControlReceipt {
  return { outcome: "accepted" };
}

function reject(reason: ControlRejection): ControlReceipt {
  return { outcome: "rejected", reason };
}

function notStarted(reason: string, cause: unknown): TurnResult {
  const failure: HarnessFailure = {
    phase: "turn",
    category: "durable-admission",
    possibleEffects: "none",
    cause,
    diagnostics: reason,
  };
  return { kind: "not-started", detail: { failure } };
}

function withCheckpoint(
  result: TurnResult,
  checkpoint: RecordingReceipt | undefined,
): TurnResult {
  if (!checkpoint || result.kind !== "completed") return result;
  return {
    kind: "completed",
    detail: { ...result.detail, recoveryCheckpoint: checkpoint },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
