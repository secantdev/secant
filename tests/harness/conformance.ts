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
import {
  LOST_UNKNOWNS,
  type DurableTurnRecorder,
  type HarnessAdapterFactory,
  type HarnessRequest,
  type HarnessTurn,
  type LostUnknown,
  type RecoveryCoordinate,
  type TurnAdmission,
  type TurnEvent,
  type TurnRequest,
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

/**
 * The full set of scenario factories. Each returns an Adapter factory set up to
 * exhibit one behaviour when the suite drives it through the Interface. The fake
 * implements all of these; a prepare-only provider implements just the inherited
 * prepare/profile subset.
 */
export interface ConformanceScenarios extends PrepareProfileScenarios {
  /** A Turn that raises three requests at once, settling once all are answered. */
  concurrentRequests(): HarnessAdapterFactory;
  /** A Turn that raises one approval request and awaits its answer. */
  awaitedApproval(): HarnessAdapterFactory;
  /** A Turn that raises one request it does not await, expiring it at terminal. */
  expiringRequest(): HarnessAdapterFactory;
  /** A Turn that raises one awaited request and can be interrupted. */
  interruptible(): HarnessAdapterFactory;
  /** A Turn the Harness ends with a terminal error subtype. */
  failedTurn(): HarnessAdapterFactory;
  /** A Turn that ends `lost` with the given unknown. */
  lost(unknown: LostUnknown): HarnessAdapterFactory;
  /** Two Turns: the first detaches, the second resumes and completes. */
  resumable(): HarnessAdapterFactory;
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
    assert.ok(profile.modelSelection.evidence.length > 0);
    assert.ok(profile.recoveryCoordinate.evidence.length > 0);
    assert.ok(profile.skillDelivery.evidence.length > 0);
    assert.ok(profile.fileDelivery.evidence.length > 0);
    await prepared.close();
  });

  test(name("prepare fails with a typed value, not a throw"), async () => {
    const adapter = scenarios.prepareFailure()();
    const result = await adapter.prepare({});
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.ok(result.failure.category.length > 0);
    assert.equal(result.failure.phase, "prepare");
  });
}

/** Run the whole suite against one provider. */
export function runConformanceSuite(scenarios: ConformanceScenarios): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;

  runPrepareProfileCases(scenarios);

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
      // A second read of the result is the same settled value.
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
      await prepared.close();
    },
  );

  test(
    name("several requests are outstanding at once and each is answered"),
    async () => {
      const prepared = await prepare(scenarios.concurrentRequests());
      const turn = prepared.startTurn(request(recorder().recorder));
      const events = observe(turn);
      await events.waitForRequests(3);
      const raised = events.requests();
      assert.equal(raised.length, 3);
      for (const request of raised) await answer(turn, request);
      const result = await turn.result();
      assert.equal(result.kind, "completed");
      const answered = events.all.filter((e) => e.kind === "request-answered");
      assert.equal(answered.length, 3);
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

  test(
    name("interrupt is confirmed and the result is interrupted"),
    async () => {
      const prepared = await prepare(scenarios.interruptible());
      const turn = prepared.startTurn(request(recorder().recorder));
      const events = observe(turn);
      await events.waitForRequests(1);
      const receipt = await turn.interrupt();
      assert.deepEqual(receipt, { outcome: "accepted" });
      const result = await turn.result();
      assert.equal(result.kind, "interrupted");
      if (result.kind !== "interrupted") throw new Error("unreachable");
      assert.equal(result.detail.session.state, "detached");
      // New inputs are rejected after an accepted interrupt.
      const late = await turn.steer({ text: "too late" });
      assert.deepEqual(late, { outcome: "rejected", reason: "expired" });
      await prepared.close();
    },
  );

  test(
    name("an outstanding request expires when the Turn is interrupted"),
    async () => {
      const prepared = await prepare(scenarios.interruptible());
      const turn = prepared.startTurn(request(recorder().recorder));
      const events = observe(turn);
      await events.waitForRequests(1);
      await turn.interrupt();
      await turn.result();
      const expired = events.all.filter((e) => e.kind === "request-expired");
      assert.equal(expired.length, 1);
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

  test(name("close is idempotent and returns the same report"), async () => {
    const prepared = await prepare(scenarios.baseline());
    const once = await prepared.close();
    const twice = await prepared.close();
    assert.deepEqual(once, twice);
    assert.equal(once, twice, "the same report value each time");
  });
}

// --- Driving helpers ---------------------------------------------------------

async function prepare(factory: HarnessAdapterFactory) {
  const result = await factory().prepare({});
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
}

function observe(turn: HarnessTurn): Observation {
  const all: TurnEvent[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  const raisedCount = () =>
    all.filter((event) => event.kind === "request-raised").length;
  turn.subscribe((event) => {
    all.push(event);
    if (event.kind === "request-raised") {
      for (const waiter of waiters) {
        if (raisedCount() >= waiter.count) waiter.resolve();
      }
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
  };
}
