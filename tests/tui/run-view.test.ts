import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot } from "solid-js";
import type {
  ProjectionPort,
  ProjectionSelector,
  ProjectionUpdate,
  RunLiveOverlay,
  RunSnapshot,
  RunView,
} from "../../src/application/projection-port.js";
import {
  createLiveRunWorkbenchView,
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
