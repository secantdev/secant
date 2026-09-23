// The shared Harness conformance suite. One suite body, parameterized by a set
// of scenario factories, run against any Adapter that implements the Harness
// Interface. It runs against the fake here; from #112 it runs against the Claude
// Code Adapter over the replayer too, which keeps the fake honest to the
// Interface. It drives only the public Interface — never Adapter internals, raw
// frames, or storage — and asserts observable outcomes: profile evidence,
// terminal ordering, concurrent requests, control rejections as values,
// interrupt and every `lost` path, recovery by resume, and idempotent close.

import assert from "node:assert/strict";
import { join } from "node:path";
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
 * How a conformance behaviour is registered. Under the test runner the caller
 * passes `test` from `node:test`; the standalone runtime-conformance runner
 * passes a callback that pushes each behaviour as its own runtime case (the same
 * split the Process conformance suite uses), so the shared suite drives the fake
 * under the test runner and the real replayers outside it.
 */
export type RegisterConformanceCase = (
  name: string,
  body: () => void | Promise<void>,
) => void;

/** A body a relocated Adapter-specific conformance case runs. */
export type ConformanceCaseBody = () => void | Promise<void>;

/**
 * Collects the Adapter-specific cases a `*-adapter-conformance.ts` file declares
 * (relocated from the process-free semantic suite, #198). The file calls the
 * returned `test` in place of `node:test` — the three-argument form carries
 * `node:test`'s `{ skip }` option, so a case not applicable to a platform is
 * simply not registered there — and `forward` hands the collected cases to the
 * runtime-conformance runner.
 */
export function collectAdapterConformanceCases(): {
  readonly test: (
    name: string,
    optionsOrBody: { readonly skip?: boolean } | ConformanceCaseBody,
    maybeBody?: ConformanceCaseBody,
  ) => void;
  readonly forward: (register: RegisterConformanceCase) => void;
} {
  const cases: { readonly name: string; readonly body: ConformanceCaseBody }[] =
    [];
  return {
    test(name, optionsOrBody, maybeBody) {
      const body =
        typeof optionsOrBody === "function" ? optionsOrBody : maybeBody;
      const skip =
        typeof optionsOrBody === "function" ? false : optionsOrBody.skip;
      if (skip === true || body === undefined) return;
      cases.push({ name, body });
    },
    forward(register) {
      for (const registered of cases)
        register(registered.name, registered.body);
    },
  };
}

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
  readonly inputText?: string;
  /** A Turn the Harness ends with a terminal error subtype. */
  failedTurn(): HarnessAdapterFactory;
}

/** Exact native reattachment behaviours for an Adapter whose deterministic
 * scenario detaches its first Turn without requiring a control operation. */
export interface ExactThreadRecoveryScenarios {
  readonly label: string;
  readonly resumeInputText?: string;
  /** The recovered native conversation acknowledges the requested coordinate. */
  resumeAcknowledged(): HarnessAdapterFactory;
  /** Recovery returns missing or different native conversation evidence. */
  resumeUnacknowledged(): HarnessAdapterFactory;
}

/** Capability-specific native same-Turn guidance. Providers without native
 * Steer stay covered by the common unsupported-profile case. */
export interface NativeSteerScenarios {
  readonly label: string;
  readonly inputText?: string;
  readonly guidanceText?: string;
  steerableTurn(): HarnessAdapterFactory;
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
  readonly awaitedInputText?: string;
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
  readonly interruptInputText?: string;
  readonly resumeInputText?: string;
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
  extends
    InterruptRecoveryScenarios,
    ApprovalRequestScenarios,
    ModelDeclarationScenarios,
    RequestedModelScenarios {
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

export function runTurnLifecycleCases(
  scenarios: TurnLifecycleScenarios,
  register: RegisterConformanceCase,
): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;

  register(
    name("a completed Turn settles once, after the producer closes"),
    async () => {
      const prepared = await prepare(scenarios.baseline());
      const turn = prepared.startTurn(
        request(recorder().recorder, { text: scenarios.inputText }),
      );
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

  register(
    name("durable admission failure proves the Turn not-started"),
    async () => {
      const prepared = await prepare(scenarios.baseline());
      const turn = prepared.startTurn(
        request(recorder({ fail: "run.db write refused" }).recorder, {
          text: scenarios.inputText,
        }),
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

  register(
    name("a thrown recorder still proves not-started, never a throw out"),
    async () => {
      const prepared = await prepare(scenarios.baseline());
      const turn = prepared.startTurn(
        request(recorder({ throwOnAdmit: true }).recorder, {
          text: scenarios.inputText,
        }),
      );
      const result = await turn.result();
      assert.equal(result.kind, "not-started");
      if (result.kind !== "not-started") throw new Error("unreachable");
      assert.ok(result.detail.failure.cause instanceof Error);
      assert.equal(result.detail.failure.cause.message, "recorder threw");
      await prepared.close();
    },
  );

  register(
    name("a terminal error subtype settles the Turn failed"),
    async () => {
      const prepared = await prepare(scenarios.failedTurn());
      const turn = prepared.startTurn(
        request(recorder().recorder, { text: scenarios.inputText }),
      );
      const result = await turn.result();
      assert.equal(result.kind, "failed");
      if (result.kind !== "failed") throw new Error("unreachable");
      assert.ok(result.detail.failure.category.length > 0);
      assert.equal(result.detail.failure.phase, "turn");
      assert.ok("state" in result.detail.session);
      await prepared.close();
    },
  );

  register(name("close after an idle Turn is idempotent"), async () => {
    const prepared = await prepare(scenarios.baseline());
    const turn = prepared.startTurn(
      request(recorder().recorder, { text: scenarios.inputText }),
    );
    await turn.result();
    const once = await prepared.close();
    const twice = await prepared.close();
    assert.deepEqual(once, twice);
    assert.equal(once, twice, "the same report value each time");
  });
}

export function runExactThreadRecoveryCases(
  scenarios: ExactThreadRecoveryScenarios,
  register: RegisterConformanceCase,
): void {
  runRecoveryCases(register, {
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

function runRecoveryCases(
  register: RegisterConformanceCase,
  driver: RecoveryCaseDriver,
): void {
  const name = (behaviour: string) => `[${driver.label}] ${behaviour}`;

  register(
    name("a detached Session resumes from its coordinate and completes"),
    async () => {
      const prepared = await prepare(driver.resumeAcknowledged());
      if (driver.expectedMode !== undefined) {
        assert.equal(prepared.profile.recovery.mode, driver.expectedMode);
      }
      const coordinate = await driver.detach(prepared);
      const second = recorder();
      const result = await prepared
        .startTurn(
          request(second.recorder, {
            resume: coordinate,
            text: driver.resumeInputText,
          }),
        )
        .result();
      assert.equal(result.kind, "completed");
      if (result.kind !== "completed") throw new Error("unreachable");
      assert.equal(result.detail.session.state, "open");
      assert.equal(second.admissions.length, 1);
      assert.deepEqual(second.admissions[0]?.resume, coordinate);
      await prepared.close();
    },
  );

  register(
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

export function runNativeSteerCases(
  scenarios: NativeSteerScenarios,
  register: RegisterConformanceCase,
): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;

  register(
    name("native same-Turn guidance is accepted while the Turn is live"),
    async () => {
      const prepared = await prepare(scenarios.steerableTurn());
      assert.equal(prepared.profile.steer.available, true);
      const turn = prepared.startTurn(
        request(recorder().recorder, { text: scenarios.inputText }),
      );
      const events = observe(turn);
      await events.waitForSession();
      assert.deepEqual(
        await turn.steer({
          text: scenarios.guidanceText ?? "inspect the other seam",
        }),
        {
          outcome: "accepted",
        },
      );
      assert.equal((await turn.result()).kind, "completed");
      assert.deepEqual(await turn.steer({ text: "too late" }), {
        outcome: "rejected",
        reason: "expired",
      });
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
  register: RegisterConformanceCase,
  options: { readonly interruptOutcome?: InterruptOutcome } = {},
): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;
  const outcome = options.interruptOutcome ?? "interrupted";

  runRecoveryCases(register, {
    ...scenarios,
    detach: async (prepared) => {
      const turn = prepared.startTurn(
        request(recorder().recorder, { text: scenarios.interruptInputText }),
      );
      const events = observe(turn);
      await events.waitForSession();
      await turn.interrupt();
      return detachedCoordinate(await turn.result(), outcome);
    },
  });

  register(
    name(
      `an interrupt stops a blocking Turn, settles ${outcome}, and detaches the Session`,
    ),
    async () => {
      const prepared = await prepare(scenarios.blockingTurn());
      const turn = prepared.startTurn(
        request(recorder().recorder, { text: scenarios.interruptInputText }),
      );
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

  register(
    name("a process that ignores the graceful signal is force-killed and lost"),
    async () => {
      const prepared = await prepare(scenarios.unresponsiveInterrupt());
      const turn = prepared.startTurn(
        request(recorder().recorder, { text: scenarios.interruptInputText }),
      );
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

  register(
    name("a producer that closes without a result loses the Turn"),
    async () => {
      const prepared = await prepare(scenarios.lostCompletion());
      const turn = prepared.startTurn(
        request(recorder().recorder, { text: scenarios.interruptInputText }),
      );
      const result = await turn.result();
      assert.equal(result.kind, "lost");
      if (result.kind !== "lost") throw new Error("unreachable");
      assert.equal(result.detail.unknown, "completion");
      assert.ok(result.detail.lastObservation.length > 0);
      await prepared.close();
    },
  );

  register(
    name("close during a live Turn bounds cleanup and is idempotent"),
    async () => {
      const prepared = await prepare(scenarios.blockingTurn());
      const turn = prepared.startTurn(
        request(recorder().recorder, { text: scenarios.interruptInputText }),
      );
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
  register: RegisterConformanceCase,
): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;

  register(name("prepare returns an evidence-bearing profile"), async () => {
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

  register(name("prepare fails with a typed value, not a throw"), async () => {
    const adapter = scenarios.prepareFailure()();
    const result = await adapter.prepare({ workspace: process.cwd() });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.ok(result.failure.category.length > 0);
    assert.equal(result.failure.phase, "prepare");
  });

  // #214: the one additional writable directory is validated identically by every
  // Adapter before anything native runs; an existing absolute directory prepares.
  register(
    name("an existing absolute writable directory prepares"),
    async () => {
      const result = await scenarios.baseline()().prepare({
        workspace: process.cwd(),
        writableDirectory: process.cwd(),
      });
      assert.equal(result.ok, true);
      if (result.ok) await result.harness.close();
    },
  );
  for (const [label, directory] of [
    ["a relative path", "relative/working"],
    ["a missing directory", join(process.cwd(), "secant-no-such-directory")],
    ["a file", process.execPath],
  ] as const) {
    register(
      name(`a writable directory that is ${label} fails prepare typed`),
      async () => {
        const result = await scenarios.baseline()().prepare({
          workspace: process.cwd(),
          writableDirectory: directory,
        });
        assert.equal(result.ok, false);
        if (result.ok) throw new Error("unreachable");
        assert.equal(result.failure.phase, "prepare");
        assert.equal(result.failure.category, "writable-directory-unavailable");
        assert.equal(result.failure.possibleEffects, "none");
        assert.ok(result.failure.diagnostics?.includes(directory));
      },
    );
  }
}

/** A granting Adapter and the directories its native side was handed: one list
 *  per native launch (Claude Code) or thread start/resume (Codex). */
export interface WritableDirectoryGrant {
  readonly factory: HarnessAdapterFactory;
  readonly grants: () => readonly (readonly string[])[];
}

export interface WritableDirectoryGrantScenarios {
  readonly label: string;
  readonly inputText?: string;
  /** A fresh existing absolute directory to grant. */
  readonly directory: () => string;
  readonly granting: () => WritableDirectoryGrant;
  /** An Adapter whose acknowledged native policy cannot admit the directory. */
  readonly refusing?: () => HarnessAdapterFactory;
  /** The coordinate a fresh prepared Harness resumes, proving recovery re-grants. */
  readonly resumeCoordinate?: RecoveryCoordinate;
}

/** The native writable-directory grant (#214): the directory reaches every native
 *  launch or thread exactly and alone, recovery re-grants it, and a native policy
 *  that cannot admit it fails the Turn typed before any content is admitted. */
export function runWritableDirectoryGrantCases(
  scenarios: WritableDirectoryGrantScenarios,
  register: RegisterConformanceCase,
): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;
  const text = scenarios.inputText;

  register(
    name("the writable directory is granted natively and alone"),
    async () => {
      const directory = scenarios.directory();
      const granting = scenarios.granting();
      const prepared = await prepareGranting(granting.factory, directory);
      const result = await prepared
        .startTurn(request(recorder().recorder, { text }))
        .result();
      assert.equal(result.kind, "completed", JSON.stringify(result));
      await prepared.close();
      const grants = granting.grants();
      assert.ok(grants.length > 0, "a native launch or thread was observed");
      for (const grant of grants) assert.deepEqual(grant, [directory]);
    },
  );

  const resumeCoordinate = scenarios.resumeCoordinate;
  if (resumeCoordinate !== undefined) {
    register(
      name("a recovered Session is granted the writable directory again"),
      async () => {
        const directory = scenarios.directory();
        const granting = scenarios.granting();
        const prepared = await prepareGranting(granting.factory, directory);
        const result = await prepared
          .startTurn(
            request(recorder().recorder, { text, resume: resumeCoordinate }),
          )
          .result();
        assert.equal(result.kind, "completed", JSON.stringify(result));
        await prepared.close();
        assert.deepEqual(granting.grants(), [[directory]]);
      },
    );
  }

  const refusing = scenarios.refusing;
  if (refusing !== undefined) {
    register(
      name(
        "a native policy that cannot admit the directory fails the Turn typed",
      ),
      async () => {
        const directory = scenarios.directory();
        const prepared = await prepareGranting(refusing(), directory);
        const probe = recorder();
        const result = await prepared
          .startTurn(request(probe.recorder, { text }))
          .result();
        await prepared.close();
        assert.equal(result.kind, "not-started", JSON.stringify(result));
        if (result.kind !== "not-started") throw new Error("unreachable");
        assert.equal(
          result.detail.failure.category,
          "writable-directory-refused",
        );
        assert.equal(result.detail.failure.possibleEffects, "none");
        assert.ok(result.detail.failure.diagnostics?.includes(directory));
        assert.deepEqual(probe.admissions, [], "no content was admitted");
      },
    );
  }
}

async function prepareGranting(
  factory: HarnessAdapterFactory,
  writableDirectory: string,
) {
  const result = await factory().prepare({
    workspace: process.cwd(),
    writableDirectory,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unreachable");
  return result.harness;
}

/**
 * The model-declaration and model-observation profile facts every shipped Adapter
 * and the fake must carry (ADR 0022, 2026-09-07 amendment): the model-selection
 * capability declares either a supported-model list or free-text entry, and the
 * profile declares a source for the effective-model observation.
 */
export interface ModelDeclarationScenarios {
  readonly label: string;
  baseline(): HarnessAdapterFactory;
  /** What the baseline profile's model-selection capability must declare. A list
   *  Adapter names models the list must include; a free-text Adapter names none. */
  readonly expectedDeclaration:
    | { readonly kind: "free-text" }
    | { readonly kind: "list"; readonly includes: readonly string[] };
}

/** Run the model-declaration cases against one provider. */
export function runModelDeclarationCases(
  scenarios: ModelDeclarationScenarios,
  register: RegisterConformanceCase,
): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;

  register(
    name("the profile declares a model posture and a model-observation source"),
    async () => {
      const prepared = await prepare(scenarios.baseline());
      const { modelSelection, modelObservation } = prepared.profile;
      assert.notEqual(
        modelSelection.at,
        "unavailable",
        "a shipped Adapter declares where selection can occur",
      );
      if (modelSelection.at === "unavailable") {
        throw new Error("unreachable");
      }
      const declaration = modelSelection.declaration;
      assert.equal(declaration.kind, scenarios.expectedDeclaration.kind);
      if (
        declaration.kind === "list" &&
        scenarios.expectedDeclaration.kind === "list"
      ) {
        assert.ok(
          declaration.models.length > 0,
          "a list declaration is non-empty",
        );
        for (const model of scenarios.expectedDeclaration.includes) {
          assert.ok(
            declaration.models.includes(model),
            `the declared list includes ${model}`,
          );
        }
      }
      assert.ok(
        modelObservation.evidence.length > 0,
        "the model-observation capability carries evidence",
      );
      await prepared.close();
    },
  );
}

/**
 * The requested-model behaviours every Adapter and the fake must exhibit: a
 * requested model is threaded through prepare to the Adapter's native mechanism
 * while the effective model stays a separate observed fact, and a requested model
 * a declared list does not admit fails prepare with a typed unavailable result
 * rather than a substitution (ADR 0022).
 */
export interface RequestedModelScenarios {
  readonly label: string;
  readonly inputText?: string;
  /** A model the baseline declaration admits, threaded through prepare. */
  readonly requestedModel: string;
  /** An Adapter that completes a Turn, prepared with `requestedModel`. */
  requestedTurn(): HarnessAdapterFactory;
  /** For a list-declaring Adapter, a model the list rejects. A free-text Adapter
   *  admits any value and omits both this and `rejectsUnknownModel`. */
  readonly unknownModel?: string;
  rejectsUnknownModel?: () => HarnessAdapterFactory;
}

/** Run the requested-model cases against one provider. */
export function runRequestedModelCases(
  scenarios: RequestedModelScenarios,
  register: RegisterConformanceCase,
): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;

  register(
    name(
      "a requested model reaches the Adapter and the effective model stays separate",
    ),
    async () => {
      const prepared = await prepareWith(scenarios.requestedTurn(), {
        requestedModel: scenarios.requestedModel,
      });
      const turn = prepared.startTurn(
        request(recorder().recorder, { text: scenarios.inputText }),
      );
      const result = await turn.result();
      assert.equal(result.kind, "completed");
      if (result.kind !== "completed") throw new Error("unreachable");
      // Requested and effective stay distinct facts: an observed effective model
      // is never the request copied back.
      if (result.detail.effectiveModel.known) {
        assert.notEqual(
          result.detail.effectiveModel.model,
          scenarios.requestedModel,
          "the effective model is observed, not the request",
        );
      }
      await prepared.close();
    },
  );

  register(
    name("an empty requested model is treated as no model requested"),
    async () => {
      // Every Adapter reads `requestedModel` the same way: an empty string is no
      // request, so even a list-declaring Adapter admits it without a list check.
      const prepared = await prepareWith(scenarios.requestedTurn(), {
        requestedModel: "",
      });
      const result = await prepared
        .startTurn(request(recorder().recorder, { text: scenarios.inputText }))
        .result();
      assert.equal(result.kind, "completed");
      await prepared.close();
    },
  );

  const rejectsUnknownModel = scenarios.rejectsUnknownModel;
  const unknownModel = scenarios.unknownModel;
  if (rejectsUnknownModel !== undefined && unknownModel !== undefined) {
    register(
      name(
        "a requested model the declared list rejects fails prepare with a typed unavailable result",
      ),
      async () => {
        const adapter = rejectsUnknownModel()();
        const result = await adapter.prepare({
          workspace: process.cwd(),
          requestedModel: unknownModel,
        });
        assert.equal(result.ok, false);
        if (result.ok) throw new Error("unreachable");
        assert.equal(result.failure.phase, "prepare");
        assert.equal(result.failure.category, "model-unavailable");
      },
    );
  }
}

/** Run the approval request/answer/expiry cases against one provider. Both the
 *  full suite (for the fake) and the Claude Code Adapter over the bridge call it.
 *  `interruptOutcome` names how the provider's interrupt of a live Turn settles
 *  (default `interrupted`), exactly as in `runInterruptRecoveryCases`. */
export function runApprovalRequestCases(
  scenarios: ApprovalRequestScenarios,
  register: RegisterConformanceCase,
  options: { readonly interruptOutcome?: InterruptOutcome } = {},
): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;
  const outcome = options.interruptOutcome ?? "interrupted";

  register(
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

  register(
    name("answering an already-answered request is rejected already-settled"),
    async () => {
      const prepared = await prepare(scenarios.awaitedApproval());
      const turn = prepared.startTurn(
        request(recorder().recorder, { text: scenarios.awaitedInputText }),
      );
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

  register(
    name("answering with the wrong shape is rejected shape-mismatch"),
    async () => {
      const prepared = await prepare(scenarios.awaitedApproval());
      const turn = prepared.startTurn(
        request(recorder().recorder, { text: scenarios.awaitedInputText }),
      );
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
    register(
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

    register(
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
export function runConformanceSuite(
  scenarios: ConformanceScenarios,
  register: RegisterConformanceCase,
): void {
  const name = (behaviour: string) => `[${scenarios.label}] ${behaviour}`;

  runPrepareProfileCases(scenarios, register);
  runModelDeclarationCases(scenarios, register);
  runRequestedModelCases(scenarios, register);
  runTurnLifecycleCases(scenarios, register);
  runInterruptRecoveryCases(scenarios, register);
  runApprovalRequestCases(scenarios, register);

  register(
    name("answering after the Turn ends is rejected expired"),
    async () => {
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
    },
  );

  register(
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
    register(name(`a Turn settles lost with unknown ${unknown}`), async () => {
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

  register(name("a detached Session is recovered by resume"), async () => {
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

  register(
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

async function prepareWith(
  factory: HarnessAdapterFactory,
  options: { readonly requestedModel: string },
) {
  const result = await factory().prepare({
    workspace: process.cwd(),
    requestedModel: options.requestedModel,
  });
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
  overrides?: {
    readonly resume?: RecoveryCoordinate;
    readonly text?: string;
  },
): TurnRequest {
  return {
    session: "conformance",
    origin: "managed",
    correlationKey: { opaque: `correlation-${correlation++}` },
    recorder: durableRecorder,
    input: { text: overrides?.text ?? "conformance turn" },
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
