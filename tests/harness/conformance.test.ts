// Runs the shared conformance suite against the deterministic fake Adapter. The
// same suite runs against the Claude Code Adapter over the replayer from #112
// on; running both keeps the fake honest to the Interface.

import type {
  ApprovalDecision,
  HarnessProfile,
  LostUnknown,
  RequestShape,
  TurnResult,
} from "../../src/harness/harness.js";
import {
  type ConformanceScenarios,
  runConformanceSuite,
} from "./conformance.js";
import {
  createFake,
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
    modelSelection: { at: "unavailable", evidence: "fake selects no model" },
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

function fake(...turns: FakeTurnScript[]): FakeScript {
  return { profile: profile(), turns };
}

const scenarios: ConformanceScenarios = {
  label: "fake",
  concurrentCount: 3,
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
};

runConformanceSuite(scenarios);
