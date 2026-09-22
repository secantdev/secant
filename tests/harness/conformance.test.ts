// Runs the shared conformance suite against the deterministic fake Adapter. The
// same suite runs against the Claude Code Adapter over the replayer from #112
// on; running both keeps the fake honest to the Interface.

import test from "node:test";
import type {
  ApprovalDecision,
  HarnessProfile,
  LostUnknown,
  RequestShape,
  TurnEvent,
  TurnResult,
} from "../../src/harness/harness.js";
import {
  type ConformanceScenarios,
  runConformanceSuite,
} from "./conformance.js";
import {
  createFake,
  REPLAY_BARRIER,
  type FakeRequestSpec,
  type FakeScript,
  type FakeTurnScript,
} from "./fake-adapter.js";

const DECISIONS: readonly ApprovalDecision[] = ["allow", "deny"];

function profile(overrides?: Partial<HarnessProfile>): HarnessProfile {
  return {
    harness: "fake",
    executable: "fake-harness",
    executableVersion: "0.0.0-fake",
    platform: "linux",
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "load-with-replay", evidence: "fake replays history" },
    interruption: { mode: "process-only", evidence: "fake stops the process" },
    approvals: { available: true, evidence: "fake hosts a bridge" },
    clarifications: {
      available: true,
      evidence: "fake offers a question shape",
    },
    steer: { available: false, evidence: "fake rejects steer unless scripted" },
    modelSelection: {
      at: "launch",
      declaration: { kind: "list", models: ["fake-model-a", "fake-model-b"] },
      evidence: "fake declares a supported-model list",
    },
    modelObservation: {
      available: true,
      evidence: "fake observes the effective model from its script",
    },
    recoveryCoordinate: {
      timing: "before-submission",
      evidence: "fake mints the id before submission",
    },
    skillDelivery: {
      mode: "plain-path",
      evidence: "fake reads a SKILL.md path",
    },
    fileDelivery: {
      mode: "plain-path",
      evidence: "fake reads an absolute path",
    },
    ...overrides,
  };
}

function approval(id: string, awaited: boolean): FakeRequestSpec {
  const shape: RequestShape = {
    kind: "approval",
    tool: "Edit",
    input: `edit ${id}`,
    decisions: DECISIONS,
  };
  return { id, shape, awaited };
}

const COMPLETED_OPEN: TurnResult = {
  kind: "completed",
  detail: {
    finalContent: "done",
    effectiveModel: { known: true, model: "fake-model" },
    session: { state: "open" },
  },
};

const SESSION_OPEN = {
  kind: "session",
  availability: { state: "open" },
} as const;

const DETACHED = {
  state: "detached",
  coordinate: { opaque: "conformance" },
} as const;

const LOST_INTERRUPTION: TurnResult = {
  kind: "lost",
  detail: {
    unknown: "interruption",
    lastObservation: "blocked before the interruption completed",
    session: DETACHED,
  },
};

const LOST_COMPLETION: TurnResult = {
  kind: "lost",
  detail: {
    unknown: "completion",
    lastObservation: "the producer closed before a result",
    session: DETACHED,
  },
};

const FAILED_RECOVERY: TurnResult = {
  kind: "failed",
  detail: {
    failure: {
      phase: "recovery",
      category: "recovery-unacknowledged",
      possibleEffects: "possible",
      diagnostics: "the resumed Session was not acknowledged",
    },
    effectiveModel: { known: false },
    session: {
      state: "unusable",
      reason: "the resumed Session was not acknowledged",
    },
  },
};

function fake(...turns: FakeTurnScript[]): FakeScript {
  return { profile: profile(), turns };
}

const scenarios: ConformanceScenarios = {
  label: "fake",
  concurrentCount: 3,
  // The fake declares a supported-model list, so the declaration case sees a list
  // and the requested-model cases exercise both admission and typed rejection.
  expectedDeclaration: { kind: "list", includes: ["fake-model-a"] },
  requestedModel: "fake-model-a",
  unknownModel: "fake-model-z",
  requestedTurn: () =>
    createFake(
      fake({
        events: [{ kind: "assistant-content", content: "hello" }],
        result: COMPLETED_OPEN,
      }),
    ),
  rejectsUnknownModel: () => createFake(fake({ result: COMPLETED_OPEN })),
  baseline: () =>
    createFake(
      fake({
        events: [
          { kind: "assistant-content", content: "hello" },
          {
            kind: "tool-activity",
            activity: {
              tool: "Read",
              phase: "completed",
              summary: "read a file",
            },
          },
        ],
        result: COMPLETED_OPEN,
      }),
    ),
  prepareFailure: () =>
    createFake({
      profile: profile(),
      prepareFailure: {
        phase: "prepare",
        category: "authentication",
        possibleEffects: "none",
        cause: "Authentication required for the fake Harness.",
      },
      turns: [],
    }),
  concurrentRequests: () =>
    createFake(
      fake({
        requests: [
          approval("req-a", true),
          approval("req-b", true),
          approval("req-c", true),
        ],
        result: COMPLETED_OPEN,
      }),
    ),
  awaitedApproval: () =>
    createFake(
      fake({ requests: [approval("req-1", true)], result: COMPLETED_OPEN }),
    ),
  expiringRequest: () =>
    createFake(
      fake({ requests: [approval("req-x", false)], result: COMPLETED_OPEN }),
    ),
  interruptible: () =>
    createFake(
      fake({ requests: [approval("req-i", true)], result: COMPLETED_OPEN }),
    ),
  failedTurn: () =>
    createFake(
      fake({
        events: [{ kind: "assistant-content", content: "partial work" }],
        result: {
          kind: "failed",
          detail: {
            failure: {
              phase: "turn",
              category: "max-turns",
              possibleEffects: "possible",
              partialOutput: "partial work",
            },
            effectiveModel: { known: true, model: "fake-model" },
            session: { state: "open" },
          },
        },
      }),
    ),
  lost: (unknown: LostUnknown) =>
    createFake(
      fake({
        result: {
          kind: "lost",
          detail: {
            unknown,
            lastObservation: `last authoritative observation before ${unknown} lost`,
            session: {
              state: "detached",
              coordinate: { opaque: "lost-session" },
            },
          },
        },
      }),
    ),
  resumable: () =>
    createFake(
      fake(
        { requests: [approval("req-r", true)], result: COMPLETED_OPEN },
        { result: COMPLETED_OPEN },
      ),
    ),
  blockingTurn: () =>
    createFake(
      fake({ events: [SESSION_OPEN], block: true, result: COMPLETED_OPEN }),
    ),
  unresponsiveInterrupt: () =>
    createFake(
      fake({
        events: [SESSION_OPEN],
        block: true,
        result: COMPLETED_OPEN,
        interruptResult: LOST_INTERRUPTION,
      }),
    ),
  lostCompletion: () =>
    createFake(fake({ events: [SESSION_OPEN], result: LOST_COMPLETION })),
  resumeAcknowledged: () =>
    createFake(
      fake(
        { events: [SESSION_OPEN], block: true, result: COMPLETED_OPEN },
        { events: [SESSION_OPEN], result: COMPLETED_OPEN },
      ),
    ),
  resumeUnacknowledged: () =>
    createFake(
      fake(
        { events: [SESSION_OPEN], block: true, result: COMPLETED_OPEN },
        { result: FAILED_RECOVERY },
      ),
    ),
  loadWithReplay: () => {
    const said: TurnEvent = { kind: "assistant-content", content: "earlier" };
    const read: TurnEvent = {
      kind: "tool-activity",
      activity: { tool: "Read", phase: "completed", summary: "read a file" },
    };
    const progress: TurnEvent = {
      kind: "assistant-content",
      content: "continuing after reattach",
    };
    return {
      // Turn 1 emits the history then blocks; on resume the Harness "re-sends"
      // the last entry (`read`) alongside its new progress, and the fake must
      // reconcile that repeat into the one replayed copy.
      factory: createFake(
        fake(
          {
            events: [SESSION_OPEN, said, read],
            block: true,
            result: COMPLETED_OPEN,
          },
          { events: [read, SESSION_OPEN, progress], result: COMPLETED_OPEN },
        ),
      ),
      history: [said, read],
      repeated: read,
      live: [SESSION_OPEN, progress],
      barrier: REPLAY_BARRIER,
    };
  },
};

runConformanceSuite(scenarios, test);
