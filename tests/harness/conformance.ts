// The shared Harness conformance suite. One suite body, parameterized by a set
// of scenario factories, run against any Adapter that implements the Harness
// Interface. It runs against the fake here; from #112 it runs against the Claude
// Code Adapter over the replayer too, which keeps the fake honest to the
// Interface. It drives only the public Interface — never Adapter internals, raw
// frames, or storage — and asserts observable outcomes: profile evidence,
// terminal ordering, concurrent requests, control rejections as values,
// interrupt and every `lost` path, recovery by resume, and idempotent close.

import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  LOST_UNKNOWNS,
  type DurableTurnRecorder,
  type HarnessAdapterFactory,
  type HarnessRequest,
  type HarnessTurn,
  type LostUnknown,
  type PreparedHarness,
  type RecoveryCoordinate,
  type TurnAdmission,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from "../../src/harness/harness.js";

/**
 * The prepare/profile subset of the suite: qualification and the evidence-
 * bearing profile, with no Turn. A prepare-only provider — the Claude Code
 * Adapter over the replayer in #111, before Turns land in #112 — implements
 * just these, and the full `ConformanceScenarios` extends them.
 */
export interface PrepareProfileScenarios {
  readonly label: string;
  /** An Adapter that qualifies and returns an evidence-bearing profile. */
  baseline(): HarnessAdapterFactory;
  /** An Adapter whose `prepare` returns a typed failure. */
  prepareFailure(): HarnessAdapterFactory;
}

/** The common Turn, terminal-ordering, and cleanup behaviours every native
 * Adapter and the deterministic fake must exhibit. */
export interface TurnLifecycleScenarios extends PrepareProfileScenarios {
  /** A Turn the Harness ends with a terminal error subtype. */
  failedTurn(): HarnessAdapterFactory;
}

/** Exact native reattachment behaviours for an Adapter whose deterministic
 * scenario detaches its first Turn without requiring a control operation. */
export interface ExactThreadRecoveryScenarios {
  readonly label: string;
  /** The recovered native conversation acknowledges the requested coordinate. */
  resumeAcknowledged(): HarnessAdapterFactory;
  /** Recovery returns missing or different native conversation evidence. */
  resumeUnacknowledged(): HarnessAdapterFactory;
}

/**
 * The approval-request subset every Adapter that can raise tool approvals must
 * exhibit: several coexisting requests, exact-id answering with its races, and
 * expiry on interruption. Run against the fake here and against the Claude Code
 * Adapter over its MCP permission bridge, so the same executable specification
 * holds for the in-process double and the real loopback round-trip.
 */
export interface ApprovalRequestScenarios {
  readonly label: string;
  /** How many requests `concurrentRequests` raises at once. */
  readonly concurrentCount: number;
  /** A Turn that raises `concurrentCount` requests at once, settling once all
   *  are answered. */
  concurrentRequests(): HarnessAdapterFactory;
  /** A Turn that raises one approval request and awaits its answer. */
  awaitedApproval(): HarnessAdapterFactory;
  /** A Turn that raises one awaited request and can be interrupted. Adapters
   *  whose native interrupt slice has not landed omit this scenario. */
  interruptible?: () => HarnessAdapterFactory;
}

/**
 * The interrupt, lost, recovery, and cleanup behaviours a native Adapter must
 * exhibit without needing Harness Requests (which a raw `claude -p` cannot raise
 * until the MCP bridge lands). Each blocking Turn emits at least one event — a
 * `session` event — before it blocks, so the driver can wait for the Turn to be
 * live without a request. Both the fake and the Claude Code Adapter over the
 * replayer implement these.
 */
export interface InterruptRecoveryScenarios extends TurnLifecycleScenarios {
  /** A Turn that emits a `session` event then blocks until interrupted; the
   *  graceful interrupt stops it and it settles `interrupted` with a detached
   *  Session. */
  blockingTurn(): HarnessAdapterFactory;
  /** A blocking Turn whose process does not stop on the graceful signal and must
   *  be force-killed → `lost` with unknown "interruption". */
  unresponsiveInterrupt(): HarnessAdapterFactory;
  /** A Turn whose producer closes with no authoritative result → `lost` with
   *  unknown "completion". */
  lostCompletion(): HarnessAdapterFactory;
  /** Two Turns on one Session: the first blocks and is interrupted (detaches),
   *  the second resumes from the coordinate and completes. */
  resumeAcknowledged(): HarnessAdapterFactory;
  /** Like `resumeAcknowledged`, but the resumed Session is not acknowledged: it
   *  becomes `unusable` and the second Turn fails in the `recovery` phase. */
  resumeUnacknowledged(): HarnessAdapterFactory;
}

/**
 * The full set of scenario factories. Each returns an Adapter factory set up to
 * exhibit one behaviour when the suite drives it through the Interface. The fake
 * implements all of these; a prepare-only provider implements just the inherited
 * prepare/profile subset.
 */
export interface ConformanceScenarios
  extends InterruptRecoveryScenarios, ApprovalRequestScenarios {
  /** A Turn that raises one request it does not await, expiring it at terminal. */
  expiringRequest(): HarnessAdapterFactory;
  /** A Turn that ends `lost` with the given unknown. */
  lost(unknown: LostUnknown): HarnessAdapterFactory;
  /** Two Turns: the first detaches, the second resumes and completes. */
  resumable(): HarnessAdapterFactory;
  /** Load-with-replay recovery (ADR 0022): the first Turn emits transcript
   *  content then blocks and is interrupted; the second resumes and must replay
   *  that history before a barrier, reconcile one repeated entry, then progress. */
  loadWithReplay(): ReplayScenario;
}

/** What a load-with-replay provider promises the suite can observe on resume. */
export interface ReplayScenario {
  readonly factory: HarnessAdapterFactory;
  /** The transcript events the first Turn emits, in order — the history. */
  readonly history: readonly TurnEvent[];
  /** One history entry the resumed Turn also carries live; it must appear once. */
  readonly repeated: TurnEvent;
  /** The live events the resumed Turn emits after the barrier, in order. */
  readonly live: readonly TurnEvent[];
  /** The one barrier event between history and live progress. */
  readonly barrier: TurnEvent;
}

/** How an interrupt of unconfirmed active work settles for a provider. A
 *  provider that can stop its process on a graceful signal settles `interrupted`;
 *  one that can only force-kill it (Windows offers a hidden console child no
 *  graceful signal) truthfully settles `lost` with interruption unknown (ADR 0022). */
export type InterruptOutcome = "interrupted" | "lost";

export function runTurnLifecycleCases(scenarios: TurnLifecycleScenarios): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;

  test(
    name("a completed Turn settles once, after the producer closes"),
    async () => {
      const prepared = await prepare(scenarios.baseline());
      const turn = prepared.startTurn(request(recorder().recorder));
      let settled = false;
      turn.subscribe((event) => {
        assert.ok(!settled, `event ${event.kind} observed after the result`);
      });
      const result = await turn.result();
      settled = true;
      assert.equal(result.kind, "completed");
      assert.deepEqual(await turn.result(), result);
      await prepared.close();
    },
  );

  test(
    name("durable admission failure proves the Turn not-started"),
    async () => {
      const prepared = await prepare(scenarios.baseline());
      const turn = prepared.startTurn(
        request(recorder({ fail: "run.db write refused" }).recorder),
      );
      const events = observe(turn);
      const result = await turn.result();
      assert.equal(result.kind, "not-started");
      assert.equal(
        events.all.length,
        0,
        "no content precedes durable admission",
      );
      await prepared.close();
    },
  );

  test(
    name("a thrown recorder still proves not-started, never a throw out"),
    async () => {
      const prepared = await prepare(scenarios.baseline());
      const turn = prepared.startTurn(
        request(recorder({ throwOnAdmit: true }).recorder),
      );
      const result = await turn.result();
      assert.equal(result.kind, "not-started");
      if (result.kind !== "not-started") throw new Error("unreachable");
      assert.ok(result.detail.failure.cause instanceof Error);
      assert.equal(result.detail.failure.cause.message, "recorder threw");
      await prepared.close();
    },
  );

  test(name("a terminal error subtype settles the Turn failed"), async () => {
    const prepared = await prepare(scenarios.failedTurn());
    const turn = prepared.startTurn(request(recorder().recorder));
    const result = await turn.result();
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    assert.ok(result.detail.failure.category.length > 0);
    assert.equal(result.detail.failure.phase, "turn");
    assert.ok("state" in result.detail.session);
    await prepared.close();
  });

  test(name("close after an idle Turn is idempotent"), async () => {
    const prepared = await prepare(scenarios.baseline());
    const turn = prepared.startTurn(request(recorder().recorder));
    await turn.result();
    const once = await prepared.close();
    const twice = await prepared.close();
    assert.deepEqual(once, twice);
    assert.equal(once, twice, "the same report value each time");
  });
}

export function runExactThreadRecoveryCases(
  scenarios: ExactThreadRecoveryScenarios,
): void {
  runRecoveryCases({
    ...scenarios,
    assertStickyUnusable: true,
    expectedAdmissionsBeforeFailure: 0,
    expectedMode: "native-reattach",
    detach: async (prepared) => {
      const first = await prepared
        .startTurn(request(recorder().recorder))
        .result();
      return lostDetachedCoordinate(first);
    },
  });
}

interface RecoveryCaseDriver extends ExactThreadRecoveryScenarios {
  readonly assertStickyUnusable?: boolean;
  readonly expectedAdmissionsBeforeFailure?: number;
  readonly expectedMode?: "native-reattach";
  detach(prepared: PreparedHarness): Promise<RecoveryCoordinate>;
}

function runRecoveryCases(driver: RecoveryCaseDriver): void {
  const name = (behaviour: string) => `[${driver.label}] ${behaviour}`;

  test(
    name("a detached Session resumes from its coordinate and completes"),
    async () => {
      const prepared = await prepare(driver.resumeAcknowledged());
      if (driver.expectedMode !== undefined) {
        assert.equal(prepared.profile.recovery.mode, driver.expectedMode);
      }
      const coordinate = await driver.detach(prepared);
      const second = recorder();
      const result = await prepared
        .startTurn(request(second.recorder, { resume: coordinate }))
        .result();
      assert.equal(result.kind, "completed");
      if (result.kind !== "completed") throw new Error("unreachable");
      assert.equal(result.detail.session.state, "open");
      assert.equal(second.admissions.length, 1);
      assert.deepEqual(second.admissions[0]?.resume, coordinate);
      await prepared.close();
    },
  );

  test(
    name("unacknowledged recovery makes the Session permanently unusable"),
    async () => {
      const prepared = await prepare(driver.resumeUnacknowledged());
      const coordinate = await driver.detach(prepared);
      const refused = recorder();
      const second = await prepared
        .startTurn(request(refused.recorder, { resume: coordinate }))
        .result();
      assert.equal(second.kind, "failed");
      if (second.kind !== "failed") throw new Error("unreachable");
      assert.equal(second.detail.failure.phase, "recovery");
      assert.equal(second.detail.session.state, "unusable");
      if (driver.expectedAdmissionsBeforeFailure !== undefined) {
        assert.equal(
          refused.admissions.length,
          driver.expectedAdmissionsBeforeFailure,
        );
      }

      if (driver.assertStickyUnusable === true) {
        const admissionsAfterFailure = refused.admissions.length;
        const third = await prepared
          .startTurn(request(refused.recorder))
          .result();
        assert.deepEqual(third, second);
        assert.equal(refused.admissions.length, admissionsAfterFailure);
      }
      await prepared.close();
    },
  );
}

/**
 * Run the request-free interrupt, lost, recovery, and cleanup cases against one
 * provider. Both the fake and the Claude Code Adapter over the replayer call it.
 * `interruptOutcome` names how the provider's confirmed interrupt of a blocking
 * Turn settles (default `interrupted`); the escalation case runs everywhere.
 */
export function runInterruptRecoveryCases(
  scenarios: InterruptRecoveryScenarios,
  options: { readonly interruptOutcome?: InterruptOutcome } = {},
): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;
  const outcome = options.interruptOutcome ?? "interrupted";

  runRecoveryCases({
    ...scenarios,
    detach: async (prepared) => {
      const turn = prepared.startTurn(request(recorder().recorder));
      const events = observe(turn);
      await events.waitForSession();
      await turn.interrupt();
      return detachedCoordinate(await turn.result(), outcome);
    },
  });

  test(
    name(
      `an interrupt stops a blocking Turn, settles ${outcome}, and detaches the Session`,
    ),
    async () => {
      const prepared = await prepare(scenarios.blockingTurn());
      const turn = prepared.startTurn(request(recorder().recorder));
      const events = observe(turn);
      await events.waitForSession();
      const receipt = await turn.interrupt();
      assert.deepEqual(receipt, { outcome: "accepted" });
      const result = await turn.result();
      detachedCoordinate(result, outcome);
      // New inputs are rejected after an accepted interrupt.
      const late = await turn.steer({ text: "too late" });
      assert.deepEqual(late, { outcome: "rejected", reason: "expired" });
      await prepared.close();
    },
  );

  test(
    name("a process that ignores the graceful signal is force-killed and lost"),
    async () => {
      const prepared = await prepare(scenarios.unresponsiveInterrupt());
      const turn = prepared.startTurn(request(recorder().recorder));
      const events = observe(turn);
      await events.waitForSession();
      await turn.interrupt();
      const result = await turn.result();
      assert.equal(result.kind, "lost");
      if (result.kind !== "lost") throw new Error("unreachable");
      assert.equal(result.detail.unknown, "interruption");
      await prepared.close();
    },
  );

  test(
    name("a producer that closes without a result loses the Turn"),
    async () => {
      const prepared = await prepare(scenarios.lostCompletion());
      const turn = prepared.startTurn(request(recorder().recorder));
      const result = await turn.result();
      assert.equal(result.kind, "lost");
      if (result.kind !== "lost") throw new Error("unreachable");
      assert.equal(result.detail.unknown, "completion");
      assert.ok(result.detail.lastObservation.length > 0);
      await prepared.close();
    },
  );

  test(
    name("close during a live Turn bounds cleanup and is idempotent"),
    async () => {
      const prepared = await prepare(scenarios.blockingTurn());
      const turn = prepared.startTurn(request(recorder().recorder));
      const events = observe(turn);
      await events.waitForSession();
      const once = await prepared.close();
      const twice = await prepared.close();
      assert.deepEqual(once, twice);
      // The live Turn still settles a terminal result rather than hanging.
      const result = await turn.result();
      assert.ok(TURN_RESULT_SETTLED.has(result.kind));
    },
  );
}

const TURN_RESULT_SETTLED = new Set([
  "not-started",
  "completed",
  "failed",
  "interrupted",
  "lost",
]);

/** Assert an interrupted blocking Turn settled as the provider promised and
 *  detached its Session; return the coordinate a resume needs. A `lost` outcome
 *  must say the interruption is what is unknown. */
function detachedCoordinate(
  result: TurnResult,
  expected: InterruptOutcome,
): RecoveryCoordinate {
  assert.equal(result.kind, expected);
  if (result.kind === "lost") {
    assert.equal(result.detail.unknown, "interruption");
    assert.equal(result.detail.failure?.category, "interruption-unknown");
  } else if (result.kind !== "interrupted") {
    throw new Error("unreachable");
  }
  assert.equal(result.detail.session.state, "detached");
  if (result.detail.session.state !== "detached") {
    throw new Error("unreachable");
  }
  return result.detail.session.coordinate;
}

function lostDetachedCoordinate(result: TurnResult): RecoveryCoordinate {
  assert.equal(result.kind, "lost");
  if (result.kind !== "lost") throw new Error("unreachable");
  assert.equal(result.detail.session.state, "detached");
  if (result.detail.session.state !== "detached") {
    throw new Error("unreachable");
  }
  return result.detail.session.coordinate;
}

/** Run the prepare/profile cases against one provider. Both the full suite and
 *  a prepare-only provider (the Claude Code Adapter over the replayer) call it. */
export function runPrepareProfileCases(
  scenarios: PrepareProfileScenarios,
): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;

  test(name("prepare returns an evidence-bearing profile"), async () => {
    const prepared = await prepare(scenarios.baseline());
    const { profile } = prepared;
    assert.ok(profile.harness.length > 0);
    assert.ok(profile.executableVersion.length > 0);
    // Every capability carries the evidence it rests on.
    assert.ok(profile.recovery.evidence.length > 0);
    assert.ok(profile.interruption.evidence.length > 0);
    assert.ok(profile.approvals.evidence.length > 0);
    assert.ok(profile.clarifications.evidence.length > 0);
    assert.ok(profile.steer.evidence.length > 0);
    assert.ok(profile.modelSelection.evidence.length > 0);
    assert.ok(profile.recoveryCoordinate.evidence.length > 0);
    assert.ok(profile.skillDelivery.evidence.length > 0);
    assert.ok(profile.fileDelivery.evidence.length > 0);
    await prepared.close();
  });

  test(name("prepare fails with a typed value, not a throw"), async () => {
    const adapter = scenarios.prepareFailure()();
    const result = await adapter.prepare({ workspace: process.cwd() });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.ok(result.failure.category.length > 0);
    assert.equal(result.failure.phase, "prepare");
  });
}

/** Run the approval request/answer/expiry cases against one provider. Both the
 *  full suite (for the fake) and the Claude Code Adapter over the bridge call it.
 *  `interruptOutcome` names how the provider's interrupt of a live Turn settles
 *  (default `interrupted`), exactly as in `runInterruptRecoveryCases`. */
export function runApprovalRequestCases(
  scenarios: ApprovalRequestScenarios,
  options: { readonly interruptOutcome?: InterruptOutcome } = {},
): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;
  const outcome = options.interruptOutcome ?? "interrupted";

  test(
    name("several requests are outstanding at once and each is answered"),
    async () => {
      const prepared = await prepare(scenarios.concurrentRequests());
      const turn = prepared.startTurn(request(recorder().recorder));
      const events = observe(turn);
      await events.waitForRequests(scenarios.concurrentCount);
      const raised = events.requests();
      assert.equal(raised.length, scenarios.concurrentCount);
      for (const request of raised) await answer(turn, request);
      const result = await turn.result();
      assert.equal(result.kind, "completed");
      const answered = events.all.filter((e) => e.kind === "request-answered");
      assert.equal(answered.length, scenarios.concurrentCount);
      await prepared.close();
    },
  );

  test(
    name("answering an already-answered request is rejected already-settled"),
    async () => {
      const prepared = await prepare(scenarios.awaitedApproval());
      const turn = prepared.startTurn(request(recorder().recorder));
      const events = observe(turn);
      await events.waitForRequests(1);
      const [raised] = events.requests();
      const first = await answer(turn, raised);
      assert.deepEqual(first, { outcome: "accepted" });
      const second = await answer(turn, raised);
      assert.deepEqual(second, {
        outcome: "rejected",
        reason: "already-settled",
      });
      assert.equal((await turn.result()).kind, "completed");
      await prepared.close();
    },
  );

  test(
    name("answering with the wrong shape is rejected shape-mismatch"),
    async () => {
      const prepared = await prepare(scenarios.awaitedApproval());
      const turn = prepared.startTurn(request(recorder().recorder));
      const events = observe(turn);
      await events.waitForRequests(1);
      const [raised] = events.requests();
      const mismatch = await turn.answerRequest({
        requestId: raised.requestId,
        kind: "clarification",
        text: "wrong shape",
      });
      assert.deepEqual(mismatch, {
        outcome: "rejected",
        reason: "shape-mismatch",
      });
      // The request stayed outstanding; a correct answer still lands.
      assert.deepEqual(await answer(turn, raised), { outcome: "accepted" });
      assert.equal((await turn.result()).kind, "completed");
      await prepared.close();
    },
  );

  const interruptible = scenarios.interruptible;
  if (interruptible !== undefined) {
    test(
      name(`interrupt is confirmed and the result is ${outcome}`),
      async () => {
        const prepared = await prepare(interruptible());
        const turn = prepared.startTurn(request(recorder().recorder));
        const events = observe(turn);
        await events.waitForRequests(1);
        const receipt = await turn.interrupt();
        assert.deepEqual(receipt, { outcome: "accepted" });
        detachedCoordinate(await turn.result(), outcome);
        // New inputs are rejected after an accepted interrupt.
        const late = await turn.steer({ text: "too late" });
        assert.deepEqual(late, { outcome: "rejected", reason: "expired" });
        await prepared.close();
      },
    );

    test(
      name("an outstanding request expires when the Turn is interrupted"),
      async () => {
        const prepared = await prepare(interruptible());
        const turn = prepared.startTurn(request(recorder().recorder));
        const events = observe(turn);
        await events.waitForRequests(1);
        await turn.interrupt();
        const result = await turn.result();
        // The expiry event precedes the result: it is in the buffer already.
        const expired = events.all.filter((e) => e.kind === "request-expired");
        assert.equal(expired.length, 1);
        assert.equal(result.kind, outcome);
        await prepared.close();
      },
    );
  }
}

/** Run the whole suite against one provider. */
export function runConformanceSuite(scenarios: ConformanceScenarios): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;

  runPrepareProfileCases(scenarios);
  runTurnLifecycleCases(scenarios);
  runInterruptRecoveryCases(scenarios);
  runApprovalRequestCases(scenarios);

  test(name("answering after the Turn ends is rejected expired"), async () => {
    const prepared = await prepare(scenarios.expiringRequest());
    const turn = prepared.startTurn(request(recorder().recorder));
    const events = observe(turn);
    const result = await turn.result();
    assert.equal(result.kind, "completed");
    const [raised] = events.requests();
    const expiredEvents = events.all.filter(
      (e) => e.kind === "request-expired",
    );
    assert.equal(expiredEvents.length, 1, "the outstanding request expired");
    const late = await answer(turn, raised);
    assert.deepEqual(late, { outcome: "rejected", reason: "expired" });
    await prepared.close();
  });

  test(
    name("steer is rejected unsupported when the profile lacks it"),
    async () => {
      const prepared = await prepare(scenarios.baseline());
      const turn = prepared.startTurn(request(recorder().recorder));
      const receipt = await turn.steer({ text: "guidance" });
      assert.deepEqual(receipt, { outcome: "rejected", reason: "unsupported" });
      await turn.result();
      await prepared.close();
    },
  );

  for (const unknown of LOST_UNKNOWNS) {
    test(name(`a Turn settles lost with unknown ${unknown}`), async () => {
      const prepared = await prepare(scenarios.lost(unknown));
      const turn = prepared.startTurn(request(recorder().recorder));
      const result = await turn.result();
      assert.equal(result.kind, "lost");
      if (result.kind !== "lost") throw new Error("unreachable");
      assert.equal(result.detail.unknown, unknown);
      assert.ok(result.detail.lastObservation.length > 0);
      await prepared.close();
    });
  }

  test(name("a detached Session is recovered by resume"), async () => {
    const prepared = await prepare(scenarios.resumable());
    const first = recorder();
    const turn1 = prepared.startTurn(request(first.recorder));
    const events1 = observe(turn1);
    await events1.waitForRequests(1);
    await turn1.interrupt();
    const result1 = await turn1.result();
    assert.equal(result1.kind, "interrupted");
    if (result1.kind !== "interrupted") throw new Error("unreachable");
    assert.equal(result1.detail.session.state, "detached");
    if (result1.detail.session.state !== "detached")
      throw new Error("unreachable");
    const coordinate = result1.detail.session.coordinate;

    const second = recorder();
    const turn2 = prepared.startTurn(
      request(second.recorder, { resume: coordinate }),
    );
    const result2 = await turn2.result();
    assert.equal(result2.kind, "completed");
    if (result2.kind !== "completed") throw new Error("unreachable");
    assert.equal(result2.detail.session.state, "open");
    assert.equal(second.admissions.length, 1);
    assert.deepEqual(second.admissions[0].resume, coordinate);
    await prepared.close();
  });

  test(
    name(
      "a load-with-replay resume replays history before one barrier, reconciles a repeat, then progresses",
    ),
    async () => {
      const scenario = scenarios.loadWithReplay();
      const prepared = await prepare(scenario.factory);
      assert.equal(prepared.profile.recovery.mode, "load-with-replay");

      const turn1 = prepared.startTurn(request(recorder().recorder));
      const events1 = observe(turn1);
      await events1.waitForSession();
      await turn1.interrupt();
      const coordinate = detachedCoordinate(
        await turn1.result(),
        "interrupted",
      );

      const turn2 = prepared.startTurn(
        request(recorder().recorder, { resume: coordinate }),
      );
      const events2 = observe(turn2);
      assert.equal((await turn2.result()).kind, "completed");

      const all = events2.all;
      const barriers = all.filter((event) =>
        isDeepStrictEqual(event, scenario.barrier),
      );
      assert.equal(barriers.length, 1, "exactly one history/live barrier");
      const barrierAt = all.findIndex((event) =>
        isDeepStrictEqual(event, scenario.barrier),
      );
      assert.deepEqual(
        all.slice(0, barrierAt),
        scenario.history,
        "every historical event precedes the barrier, in order",
      );
      assert.deepEqual(
        all.slice(barrierAt + 1),
        scenario.live,
        "no live event precedes the barrier",
      );
      assert.equal(
        all.filter((event) => isDeepStrictEqual(event, scenario.repeated))
          .length,
        1,
        "a repeated entry appears once",
      );
      await prepared.close();
    },
  );
}

// --- Driving helpers ---------------------------------------------------------

async function prepare(factory: HarnessAdapterFactory) {
  const result = await factory().prepare({ workspace: process.cwd() });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.harness;
}

interface RecorderProbe {
  readonly recorder: DurableTurnRecorder;
  readonly admissions: TurnAdmission[];
  readonly checkpoints: RecoveryCoordinate[];
}

function recorder(options?: {
  readonly fail?: string;
  readonly throwOnAdmit?: boolean;
}): RecorderProbe {
  const admissions: TurnAdmission[] = [];
  const checkpoints: RecoveryCoordinate[] = [];
  return {
    admissions,
    checkpoints,
    recorder: {
      admit(admission) {
        admissions.push(admission);
        if (options?.throwOnAdmit) {
          return Promise.reject(new Error("recorder threw"));
        }
        if (options?.fail) {
          return Promise.resolve({ recorded: false, reason: options.fail });
        }
        return Promise.resolve({ recorded: true });
      },
      checkpoint(coordinate) {
        checkpoints.push(coordinate);
        return Promise.resolve({ recorded: true });
      },
    },
  };
}

let correlation = 0;

function request(
  durableRecorder: DurableTurnRecorder,
  overrides?: { readonly resume?: RecoveryCoordinate },
): TurnRequest {
  return {
    session: "conformance",
    origin: "managed",
    correlationKey: { opaque: `correlation-${correlation++}` },
    recorder: durableRecorder,
    input: { text: "conformance turn" },
    resume: overrides?.resume,
  };
}

function answer(turn: HarnessTurn, raised: HarnessRequest) {
  if (raised.shape.kind === "approval") {
    return turn.answerRequest({
      requestId: raised.requestId,
      kind: "approval",
      decision: "allow",
    });
  }
  return turn.answerRequest({
    requestId: raised.requestId,
    kind: "clarification",
    text: "answered",
  });
}

interface Observation {
  readonly all: TurnEvent[];
  requests(): HarnessRequest[];
  waitForRequests(count: number): Promise<void>;
  /** Resolve once the Turn is live — its first `session` event has arrived. The
   *  request-free interrupt/recovery cases use this in place of a raised request. */
  waitForSession(): Promise<void>;
}

function observe(turn: HarnessTurn): Observation {
  const all: TurnEvent[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const sessionWaiters: (() => void)[] = [];
  const raisedCount = () =>
    all.filter((event) => event.kind === "request-raised").length;
  const hasSession = () => all.some((event) => event.kind === "session");
  turn.subscribe((event) => {
    all.push(event);
    if (event.kind === "request-raised") {
      for (const waiter of waiters) {
        if (raisedCount() >= waiter.count) waiter.resolve();
      }
    }
    if (event.kind === "session") {
      for (const resolve of sessionWaiters.splice(0)) resolve();
    }
  });
  return {
    all,
    requests() {
      const found: HarnessRequest[] = [];
      for (const event of all) {
        if (event.kind === "request-raised") found.push(event.request);
      }
      return found;
    },
    waitForRequests(count) {
      if (raisedCount() >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
      });
    },
    waitForSession() {
      if (hasSession()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        sessionWaiters.push(resolve);
      });
    },
  };
}
