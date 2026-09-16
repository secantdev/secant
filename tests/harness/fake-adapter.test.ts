// Direct tests of the deterministic fake Adapter for the behaviours the shared
// conformance suite does not drive: the Interface behaviours Claude Code never
// exhibits (native steer, structured clarifications), the after-acceptance
// recovery checkpoint, and the caller-contract violations that are the only
// things this Interface throws for.

import assert from "node:assert/strict";
import test from "node:test";
import type {
  DurableTurnRecorder,
  HarnessProfile,
  HarnessRequest,
  PreparedHarness,
  RecoveryCoordinate,
  TurnAdmission,
  TurnEvent,
  TurnRequest,
} from "../../src/harness/harness.js";
import { createFake, type FakeScript } from "./fake-adapter.js";

function profile(): HarnessProfile {
  return {
    harness: "fake",
    executable: "fake-harness",
    executableVersion: "0.0.0-fake",
    platform: "linux",
    adapterRevision: "fake-1",
    configurationPosture: "user-compatible",
    recovery: { mode: "load-with-replay", evidence: "fake replays history" },
    interruption: {
      mode: "active-turn",
      evidence: "fake confirms interruption",
    },
    approvals: { available: true, evidence: "fake hosts a bridge" },
    clarifications: {
      available: true,
      evidence: "fake offers a question shape",
    },
    modelSelection: { at: "launch", evidence: "fake takes a model at launch" },
    recoveryCoordinate: {
      timing: "after-acceptance",
      evidence: "fake reveals the id after acceptance",
    },
    skillDelivery: {
      mode: "native",
      evidence: "fake delivers skills natively",
    },
    fileDelivery: {
      mode: "plain-path",
      evidence: "fake reads an absolute path",
    },
  };
}

function recorder(): {
  recorder: DurableTurnRecorder;
  admissions: TurnAdmission[];
  checkpoints: RecoveryCoordinate[];
} {
  const admissions: TurnAdmission[] = [];
  const checkpoints: RecoveryCoordinate[] = [];
  return {
    admissions,
    checkpoints,
    recorder: {
      admit(admission) {
        admissions.push(admission);
        return Promise.resolve({ recorded: true });
      },
      checkpoint(coordinate) {
        checkpoints.push(coordinate);
        return Promise.resolve({ recorded: true });
      },
    },
  };
}

function request(durable: DurableTurnRecorder): TurnRequest {
  return {
    session: "fake-session",
    origin: "managed",
    correlationKey: { opaque: "k" },
    recorder: durable,
    input: { text: "go" },
  };
}

async function prepared(script: FakeScript): Promise<PreparedHarness> {
  const result = await createFake(script)().prepare({});
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return result.harness;
}

test("native steer is accepted where the profile supports it", async () => {
  const harness = await prepared({
    profile: profile(),
    turns: [
      {
        supportsSteer: true,
        requests: [
          {
            id: "s",
            shape: { kind: "clarification", prompt: "?" },
            awaited: true,
          },
        ],
        result: {
          kind: "completed",
          detail: {
            effectiveModel: { known: false },
            session: { state: "open" },
          },
        },
      },
    ],
  });
  const turn = harness.startTurn(request(recorder().recorder));
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  const receipt = await turn.steer({ text: "try the other file" });
  assert.deepEqual(receipt, { outcome: "accepted" });
  assert.ok(events.some((e) => e.kind === "activity"));
  // Finish the awaited Turn so it settles.
  const raised = await new Promise<HarnessRequest>((resolve) => {
    turn.subscribe((event) => {
      if (event.kind === "request-raised") resolve(event.request);
    });
  });
  await turn.answerRequest({
    requestId: raised.requestId,
    kind: "clarification",
    text: "yes",
  });
  assert.equal((await turn.result()).kind, "completed");
  await harness.close();
});

test("a structured clarification is answered by its text", async () => {
  const harness = await prepared({
    profile: profile(),
    turns: [
      {
        requests: [
          {
            id: "c",
            shape: { kind: "clarification", prompt: "which branch?" },
            awaited: true,
          },
        ],
        result: {
          kind: "completed",
          detail: {
            effectiveModel: { known: false },
            session: { state: "open" },
          },
        },
      },
    ],
  });
  const turn = harness.startTurn(request(recorder().recorder));
  const events: TurnEvent[] = [];
  turn.subscribe((event) => events.push(event));
  const raised = await new Promise<HarnessRequest>((resolve) => {
    turn.subscribe((event) => {
      if (event.kind === "request-raised") resolve(event.request);
    });
  });
  assert.equal(raised.shape.kind, "clarification");
  // An approval answer to a clarification is a shape-mismatch.
  const mismatch = await turn.answerRequest({
    requestId: raised.requestId,
    kind: "approval",
    decision: "allow",
  });
  assert.deepEqual(mismatch, { outcome: "rejected", reason: "shape-mismatch" });
  const ok = await turn.answerRequest({
    requestId: raised.requestId,
    kind: "clarification",
    text: "main",
  });
  assert.deepEqual(ok, { outcome: "accepted" });
  assert.equal((await turn.result()).kind, "completed");
  await harness.close();
});

test("an after-acceptance coordinate is checkpointed without falsifying the result", async () => {
  const probe = recorder();
  const harness = await prepared({
    profile: profile(),
    turns: [
      {
        revealCoordinateAfterAcceptance: { opaque: "native-conv-1" },
        result: {
          kind: "completed",
          detail: {
            effectiveModel: { known: true, model: "m" },
            session: { state: "open" },
          },
        },
      },
    ],
  });
  const turn = harness.startTurn(request(probe.recorder));
  const result = await turn.result();
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("unreachable");
  assert.deepEqual(probe.checkpoints, [{ opaque: "native-conv-1" }]);
  assert.deepEqual(result.detail.recoveryCheckpoint, { recorded: true });
  await harness.close();
});

test("a second concurrent Turn is a caller-contract violation that throws", async () => {
  const harness = await prepared({
    profile: profile(),
    turns: [
      {
        requests: [
          {
            id: "a",
            shape: { kind: "clarification", prompt: "?" },
            awaited: true,
          },
        ],
        result: {
          kind: "completed",
          detail: {
            effectiveModel: { known: false },
            session: { state: "open" },
          },
        },
      },
      {
        result: {
          kind: "completed",
          detail: {
            effectiveModel: { known: false },
            session: { state: "open" },
          },
        },
      },
    ],
  });
  const turn = harness.startTurn(request(recorder().recorder));
  assert.throws(
    () => harness.startTurn(request(recorder().recorder)),
    /one active Turn/,
  );
  const raised = await new Promise<HarnessRequest>((resolve) => {
    turn.subscribe((event) => {
      if (event.kind === "request-raised") resolve(event.request);
    });
  });
  await turn.answerRequest({
    requestId: raised.requestId,
    kind: "clarification",
    text: "done",
  });
  await turn.result();
  await harness.close();
});

test("startTurn after close is a caller-contract violation that throws", async () => {
  const harness = await prepared({
    profile: profile(),
    turns: [
      {
        result: {
          kind: "completed",
          detail: {
            effectiveModel: { known: false },
            session: { state: "open" },
          },
        },
      },
    ],
  });
  await harness.close();
  assert.throws(
    () => harness.startTurn(request(recorder().recorder)),
    /closed/,
  );
});
