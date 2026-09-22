import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "solid-js";
import type {
  OperationSnapshot,
  ProjectionPort,
  ProjectionSelector,
  ProjectionUpdate,
  RunGateReference,
  RunLiveOverlay,
  RunSnapshot,
  RunView,
} from "../../src/application/projection-port.js";
import {
  createLiveRunWorkbenchView,
  type TRunViewFreshness,
  type RunWorkbenchProjection,
} from "../../src/tui/tui.js";

class UpdateQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | undefined;
  private ended = false;

  push(value: T): void {
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      waiter({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    this.ended = true;
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.ended)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

function runOf(over: Partial<RunView> = {}): RunView {
  return {
    runId: "run-1",
    bundle: {
      id: "dev.alpha",
      version: "1.0.0",
      name: "Alpha",
      digest: "abc123",
    },
    workspacePath: "/tmp/ws",
    launchedAt: "2026-01-01T00:00:00.000Z",
    state: "running",
    liveness: { state: "live-here", ownerPid: 42 },
    progress: [{ id: "repair", kind: "agent", status: "running" }],
    position: 0,
    timeline: [],
    outputs: [],
    actionOffers: [],
    ...over,
  };
}

function snapshotOf(run: RunView): RunSnapshot {
  return {
    family: "run",
    runId: run.runId,
    result: { found: true, run },
  };
}

const WORKING: RunLiveOverlay = {
  runId: "run-1",
  generation: 1,
  phase: "working",
  outstanding: [],
  offers: [],
  activity: "Inspecting the failure",
  preview: "Working",
};

async function flushUpdates(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function healthKind(projection: RunWorkbenchProjection): string {
  return projection.freshness().kind;
}

/** Open a live Run projection over a hand-driven update queue, so a test can push each
 *  update lane (durable, live, preview, closed) and read the joined view. */
function openLiveProjection(initial: RunSnapshot): {
  projection: RunWorkbenchProjection;
  updates: UpdateQueue<ProjectionUpdate<RunSnapshot>>;
  dispose: () => void;
} {
  const updates = new UpdateQueue<ProjectionUpdate<RunSnapshot>>();
  const opened = {
    snapshot: initial,
    catchUp: "fresh" as const,
    updates,
    close() {},
  };
  const port = {
    openProjection: () => opened,
    submit() {
      throw new Error("submit is not used");
    },
    readResource() {
      throw new Error("readResource is not used");
    },
  } as unknown as ProjectionPort;
  let projection!: RunWorkbenchProjection;
  const dispose = createRoot((dispose) => {
    projection = createLiveRunWorkbenchView(port).openRun("run-1");
    return dispose;
  });
  return { projection, updates, dispose };
}

/** A live overlay holding one outstanding approval Harness Request (#117): the view a
 *  lost Turn must not leave standing (A8). */
const REQUESTING: RunLiveOverlay = {
  runId: "run-1",
  generation: 3,
  phase: "working",
  outstanding: [
    {
      requestId: "req-1",
      tool: "Edit",
      input: '{"path":"a.ts"}',
      decisions: ["allow", "deny"],
    },
  ],
  offers: [
    {
      action: "answer-harness-request",
      runId: "run-1",
      requestId: "req-1",
      generation: 3,
      decisions: ["allow", "deny"],
      basis: "ephemeral Harness Request",
    },
  ],
  preview: "Editing a.ts",
};

test("a closed update clears the live overlay and preview so a lost Turn leaves no dead control (A8) — fails at HEAD", async () => {
  const { projection, updates, dispose } = openLiveProjection(
    snapshotOf(runOf()),
  );
  updates.push({ kind: "live", overlay: REQUESTING });
  await flushUpdates();
  assert.equal(projection.live()?.outstanding.length, 1);
  assert.equal(projection.preview(), "Editing a.ts");
  // The follow loop breaks (subject gone) with the last overlay still in state; HEAD
  // returned the state untouched, keeping a dead request control standing.
  updates.push({ kind: "closed", reason: "subject-gone" });
  await flushUpdates();
  assert.equal(projection.live(), undefined);
  assert.equal(projection.preview(), undefined);
  dispose();
  updates.end();
});

test("the Run follow seam reports loss and reopens through loading and catching-up to current", async () => {
  const first = new UpdateQueue<ProjectionUpdate<RunSnapshot>>();
  const second = new UpdateQueue<ProjectionUpdate<RunSnapshot>>();
  const opened = [
    {
      snapshot: snapshotOf(runOf()),
      catchUp: "fresh" as const,
      updates: first,
      close() {},
    },
    {
      snapshot: snapshotOf(runOf({ state: "halted" })),
      catchUp: "rebased" as const,
      updates: second,
      close() {},
    },
  ];
  let opens = 0;
  const port = {
    openProjection() {
      const projection = opened[opens];
      opens += 1;
      if (projection === undefined) throw new Error("unexpected third open");
      return projection;
    },
    submit() {
      throw new Error("submit is not used");
    },
    readResource() {
      throw new Error("readResource is not used");
    },
  } as unknown as ProjectionPort;
  const observed: TRunViewFreshness[] = [];
  let projection!: RunWorkbenchProjection;
  const dispose = createRoot((dispose) => {
    projection = createLiveRunWorkbenchView(port).openRun("run-1");
    return dispose;
  });

  assert.equal(healthKind(projection), "current");
  const lastConfirmedAt = projection.freshness().lastConfirmedAt;
  first.push({ kind: "closed", reason: "observer-lagged" });
  await flushUpdates();
  assert.deepEqual(projection.freshness(), {
    kind: "disconnected",
    reason: "observer-lagged",
    lastConfirmedAt,
  });

  projection.reconnect();
  observed.push(projection.freshness());
  await Promise.resolve();
  observed.push(projection.freshness());
  await Promise.resolve();
  observed.push(projection.freshness());
  assert.deepEqual(
    observed.map((health) => health.kind),
    ["loading", "catching-up", "current"],
  );
  const result = projection.snapshot().result;
  assert.equal(result.found, true);
  if (result.found) {
    assert.equal(result.run.state, "halted");
  }
  assert.equal(opens, 2);

  dispose();
  first.end();
  second.end();
});

test("a pending Operation receipt survives stream loss and settles from the reopened Projection", async () => {
  const first = new UpdateQueue<ProjectionUpdate<OperationSnapshot>>();
  const second = new UpdateQueue<ProjectionUpdate<OperationSnapshot>>();
  const third = new UpdateQueue<ProjectionUpdate<OperationSnapshot>>();
  const pending: OperationSnapshot = {
    family: "operation",
    operationId: "op-1",
    outcome: { status: "pending" },
  };
  const streams = [first, second, third];
  let opens = 0;
  const port = {
    submit() {
      return { admitted: true, operationId: "op-1" } as const;
    },
    openProjection(selector: ProjectionSelector) {
      assert.deepEqual(selector, {
        family: "operation",
        operationId: "op-1",
      });
      const updates = streams[opens];
      opens += 1;
      if (updates === undefined) throw new Error("unexpected third open");
      return {
        snapshot: pending,
        catchUp: "fresh" as const,
        updates,
        close() {},
      };
    },
    readResource() {
      throw new Error("readResource is not used");
    },
  } as unknown as ProjectionPort;
  const gate: RunGateReference = {
    runId: "run-1",
    stepId: "review",
    attemptId: "attempt-1",
    shape: "approve-reject",
  };

  const outcome = createLiveRunWorkbenchView(port).answer(gate, "continue");
  assert.equal(outcome().kind, "pending");
  first.push({ kind: "closed", reason: "temporarily-unavailable" });
  await flushUpdates();
  assert.equal(outcome().kind, "pending");
  assert.equal(opens, 2);

  second.push({ kind: "closed", reason: "observer-lagged" });
  await flushUpdates();
  assert.equal(outcome().kind, "pending");
  assert.equal(opens, 3);

  third.push({
    kind: "durable",
    snapshot: {
      family: "operation",
      operationId: "op-1",
      outcome: { status: "applied" },
    },
  });
  await flushUpdates();
  assert.equal(outcome().kind, "applied");
  first.end();
  second.end();
  third.end();
});

test("a durable update whose liveness leaves live-here drops the live overlay (A8) — fails at HEAD", async () => {
  const { projection, updates, dispose } = openLiveProjection(
    snapshotOf(runOf()),
  );
  updates.push({ kind: "live", overlay: REQUESTING });
  await flushUpdates();
  assert.equal(projection.live()?.outstanding.length, 1);
  // Durable liveness leaves live-here (the Turn is no longer live in this instance);
  // HEAD kept the overlay, so the request control kept standing over a dead Turn.
  updates.push({
    kind: "durable",
    snapshot: snapshotOf(
      runOf({ state: "halted", liveness: { state: "not-live" } }),
    ),
  });
  await flushUpdates();
  assert.equal(projection.live(), undefined);
  assert.equal(projection.preview(), undefined);
  dispose();
  updates.end();
});

test("the live Run view joins durable, overlay, and preview lanes and clears only after authoritative settlement", async () => {
  const initial = snapshotOf(runOf());
  const updates = new UpdateQueue<ProjectionUpdate<RunSnapshot>>();
  let closes = 0;
  const opened = {
    snapshot: initial,
    updates,
    close() {
      closes += 1;
    },
  };
  const port = {
    openProjection(selector: ProjectionSelector) {
      assert.deepEqual(selector, { family: "run", runId: "run-1" });
      return opened;
    },
    submit() {
      throw new Error("submit is not used");
    },
    readResource() {
      throw new Error("readResource is not used");
    },
  } as unknown as ProjectionPort;

  let projection!: RunWorkbenchProjection;
  const dispose = createRoot((dispose) => {
    projection = createLiveRunWorkbenchView(port).openRun("run-1");
    return dispose;
  });

  updates.push({ kind: "preview", text: "First words" });
  await flushUpdates();
  assert.equal(projection.live(), undefined);
  assert.equal(projection.preview(), "First words");

  updates.push({ kind: "live", overlay: WORKING });
  await flushUpdates();
  assert.equal(projection.live()?.activity, "Inspecting the failure");
  assert.equal(projection.preview(), "Working");

  updates.push({ kind: "preview", text: "" });
  await flushUpdates();
  assert.equal(projection.preview(), undefined);

  updates.push({
    kind: "live",
    overlay: { ...WORKING, phase: "settling", preview: "Final draft" },
  });
  updates.push({
    kind: "durable",
    snapshot: snapshotOf(
      runOf({
        timeline: [
          { at: "T000", event: "assistant-content", detail: "Final answer" },
        ],
      }),
    ),
  });
  await flushUpdates();
  assert.equal(projection.live()?.phase, "settling");
  assert.equal(projection.preview(), "Final draft");

  const settled = snapshotOf(
    runOf({
      state: "succeeded",
      progress: [{ id: "repair", kind: "agent", status: "succeeded" }],
      position: 1,
      timeline: [
        { at: "T000", event: "assistant-content", detail: "Final answer" },
        { at: "T001", event: "turn-settled", detail: "completed" },
      ],
    }),
  );
  updates.push({ kind: "durable", snapshot: settled });
  await flushUpdates();
  assert.deepEqual(projection.snapshot(), settled);
  assert.equal(projection.live(), undefined);
  assert.equal(projection.preview(), undefined);

  const beforeDispose = projection.snapshot();
  dispose();
  assert.equal(closes, 1);
  updates.push({
    kind: "durable",
    snapshot: snapshotOf(runOf({ state: "failed" })),
  });
  await flushUpdates();
  assert.deepEqual(projection.snapshot(), beforeDispose);
  updates.end();
});
