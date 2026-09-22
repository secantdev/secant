import assert from "node:assert/strict";
import { test } from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { App } from "../../src/tui/tui.js";
import type {
  BundleCatalogView,
  RunActionsView,
  RunListState,
  RunListView,
  RunLaunchView,
  RunWorkbenchView,
  WorkspaceView,
} from "../../src/tui/tui.js";
import { makeFakeRenderer, until } from "./renderer-fixture.js";
import type {
  BundleCatalogSnapshot,
  RunListRow,
  RunSnapshot,
  RunView,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";

// In-memory renderer tests for the Previous Runs list (#92, verified by #196),
// reached the real way:
// Home → Previous Runs, over a fake `run-list` read seam. They cover ordering and
// Today/Yesterday/Older grouping, the live-marked row, the Resumable filter, the
// empty state, cursor paging with a stable first-visible row and the
// beginning-of-history marker, small-width truncation and resize without overflow,
// the focus glyph and state-free row at the smallest supported width, guarded quit,
// and Enter → the Run's Workbench with Escape restoring the row and delete
// returning to the list without that Run.

const WORKSPACE = "/tmp/secant-previous-runs";
const SMALLEST_SUPPORTED_WIDTH = 30;

// --- a fake Renderer Port we can drive (shared fixture, A52) -------------------

// --- App seams --------------------------------------------------------------

function approvedWorkspace(): WorkspaceView {
  const [snapshot] = createSignal<WorkspaceSnapshot>({
    family: "workspace",
    path: WORKSPACE,
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 1,
    harnesses: [],
    actionOffers: [],
  });
  return { snapshot, approve() {} };
}

function noBundles(): BundleCatalogView {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles: [] },
  });
  return {
    openList: () => list,
    openFocus: () => {
      throw new Error("bundle focus not used in this test");
    },
  };
}

function noLaunch(): RunLaunchView {
  return { launch: () => () => ({ kind: "pending" }) };
}

/** A read seam that returns one running Run for any id, so Enter opens a Workbench. */
function runViewOf(run: RunView): RunWorkbenchView {
  const [snapshot] = createSignal<RunSnapshot>({
    family: "run",
    runId: run.runId,
    result: { found: true, run },
  });
  return {
    openRun: () => ({
      snapshot,
      live: () => undefined,
      preview: () => undefined,
      freshness: () => ({
        kind: "current",
        catchUp: "fresh",
        lastConfirmedAt: "2026-09-22T10:30:00.000Z",
      }),
      reconnect() {},
    }),
    readResource: () => ({
      found: false,
      problem: {
        code: "resource-gone",
        explanation: "gone",
        remediation: "re-run",
        possibleEffects: "none",
      },
    }),
    readTranscript: () => ({
      found: false,
      problem: {
        code: "resource-gone",
        explanation: "gone",
        remediation: "re-run",
        possibleEffects: "none",
      },
    }),
    // These tests never reach the checkpoint or interactive interaction; stubs
    // satisfy the seam.
    answer: () => () => ({ kind: "applied" }),
    sendInteractiveTurn: () => () => ({ kind: "applied" }),
    endInteractiveStep: () => () => ({ kind: "applied" }),
    steer: () => () => ({ kind: "applied" }),
    answerText: () => () => ({ kind: "applied" }),
    answerRequest: () => () => ({ kind: "applied" }),
  };
}

function disappearingRunView(run: RunView): {
  readonly view: RunWorkbenchView;
  deleted(): void;
} {
  const [snapshot, setSnapshot] = createSignal<RunSnapshot>({
    family: "run",
    runId: run.runId,
    result: { found: true, run },
  });
  const base = runViewOf(run);
  return {
    view: {
      openRun: () => ({
        snapshot,
        live: () => undefined,
        preview: () => undefined,
        freshness: () => ({
          kind: "current",
          catchUp: "rebased",
          lastConfirmedAt: "2026-09-22T10:30:00.000Z",
        }),
        reconnect() {},
      }),
      readResource: base.readResource,
      readTranscript: base.readTranscript,
      answer: base.answer,
      sendInteractiveTurn: base.sendInteractiveTurn,
      endInteractiveStep: base.endInteractiveStep,
      steer: base.steer,
      answerText: base.answerText,
      answerRequest: base.answerRequest,
    },
    deleted() {
      setSnapshot({
        family: "run",
        runId: run.runId,
        result: {
          found: false,
          problem: {
            code: "run-not-found",
            explanation: `Run ${run.runId} no longer exists.`,
            remediation: "Return to Previous Runs.",
            possibleEffects: "none",
          },
        },
      });
    },
  };
}

function missingRunView(run: RunView): RunWorkbenchView {
  const base = runViewOf(run);
  const [snapshot] = createSignal<RunSnapshot>({
    family: "run",
    runId: run.runId,
    result: {
      found: false,
      problem: {
        code: "run-not-found",
        explanation: `Run ${run.runId} no longer exists.`,
        remediation: "Return to Previous Runs.",
        possibleEffects: "none",
      },
    },
  });
  return {
    openRun: () => ({
      snapshot,
      live: () => undefined,
      preview: () => undefined,
      freshness: () => ({
        kind: "current",
        catchUp: "fresh",
        lastConfirmedAt: "2026-09-22T10:30:00.000Z",
      }),
      reconnect() {},
    }),
    readResource: base.readResource,
    readTranscript: base.readTranscript,
    answer: base.answer,
    sendInteractiveTurn: base.sendInteractiveTurn,
    endInteractiveStep: base.endInteractiveStep,
    steer: base.steer,
    answerText: base.answerText,
    answerRequest: base.answerRequest,
  };
}

function okActions(onRemove?: (runId: string) => void): RunActionsView {
  return {
    resume: () => () => ({ kind: "ok" }),
    cancel: () => () => ({ kind: "ok" }),
    remove: (runId) => {
      onRemove?.(runId);
      return () => ({ kind: "ok" });
    },
    interrupt: () => () => ({ kind: "ok" }),
  };
}

/** A `run-list` seam that pages a fixed dataset by a small page size, reading the
 *  arrays by reference so a delete (mutating `all`) is reflected on the next open. */
function runListView(
  all: RunListRow[],
  resumable: RunListRow[] = [],
  page = 20,
): RunListView {
  return {
    openRunList() {
      let isResumable = false;
      let loaded = 0;
      const data = () => (isResumable ? resumable : all);
      const [state, setState] = createSignal<RunListState>({
        rows: [],
        filter: "all",
        beginningOfHistory: true,
        hasMore: false,
      });
      const publish = () => {
        const set = data();
        setState({
          rows: set.slice(0, loaded),
          filter: isResumable ? "resumable" : "all",
          beginningOfHistory: loaded >= set.length,
          hasMore: loaded < set.length,
        });
      };
      const nextPage = () => {
        loaded = Math.min(loaded + page, data().length);
        publish();
      };
      nextPage();
      return {
        state,
        setResumable(next) {
          if (next === isResumable) return;
          isResumable = next;
          loaded = 0;
          nextPage();
        },
        loadMore() {
          if (loaded < data().length) nextPage();
        },
      };
    },
  };
}

function row(
  over: Partial<RunListRow> & Pick<RunListRow, "runId">,
): RunListRow {
  return {
    runId: over.runId,
    bundleName: over.bundleName ?? "Alpha Flow",
    activityAt: over.activityAt ?? "2026-01-01T00:00:00.000Z",
    group: over.group ?? "today",
    live: over.live ?? false,
    ownedByThisProcess: over.ownedByThisProcess ?? false,
  };
}

function runOf(over: Partial<RunView> = {}): RunView {
  return {
    runId: over.runId ?? "run-1",
    bundle: over.bundle ?? {
      id: "dev.alpha",
      version: "1.0.0",
      name: "Alpha Flow",
      digest: "abc123",
    },
    workspacePath: over.workspacePath ?? WORKSPACE,
    launchedAt: over.launchedAt ?? "2026-01-01T00:00:00.000Z",
    state: over.state ?? "running",
    liveness: over.liveness ?? { state: "not-live" },
    progress: over.progress ?? [],
    position: over.position ?? 0,
    timeline: over.timeline ?? [],
    outputs: over.outputs ?? [],
    actionOffers: over.actionOffers ?? [],
  };
}

interface MountOptions {
  all?: RunListRow[];
  resumable?: RunListRow[];
  page?: number;
  run?: RunView;
  runView?: RunWorkbenchView;
  onRemove?: (runId: string) => void;
  width?: number;
  height?: number;
}

async function mountHome(options: MountOptions = {}) {
  const width = options.width ?? 80;
  const height = options.height ?? 40;
  const renderer = makeFakeRenderer(width, height);
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace()}
        bundles={noBundles()}
        launch={noLaunch()}
        run={options.runView ?? runViewOf(options.run ?? runOf())}
        runList={runListView(
          options.all ?? [],
          options.resumable ?? [],
          options.page ?? 20,
        )}
        actions={okActions(options.onRemove)}
        renderer={renderer.port}
        exit={(reason) => exits.push(reason)}
      />
    ),
    { width, height },
  );
  return { t, renderer, exits };
}

/** Home → Previous Runs. */
async function openList(options: MountOptions = {}) {
  const mounted = await mountHome(options);
  await mounted.t.waitForFrame((f) => f.includes("Secant"));
  mounted.t.mockInput.pressArrow("down"); // Start a Run
  mounted.t.mockInput.pressArrow("down"); // Previous Runs
  mounted.t.mockInput.pressEnter();
  // Wait for a list-only string: "Previous Runs" alone also names the Home menu
  // entry, so it would match Home before navigation lands. The footer can clip at
  // the smallest supported width, while the filter label remains visible.
  await mounted.t.waitForFrame((f) => f.includes("Filter:"));
  return mounted;
}

function selectedLine(frame: string): string {
  return frame.split("\n").find((line) => line.includes("› ")) ?? "";
}

function firstRunLine(frame: string): string {
  return frame.split("\n").find((line) => /run-\S+/.test(line)) ?? "";
}

// --- AC1: ordering, grouping, three facts, empty ----------------------------

test("rows render newest-first under Today / Yesterday / Older with the live marker", async () => {
  const { t } = await openList({
    all: [
      row({
        runId: "run-a",
        bundleName: "Alpha",
        group: "today",
        live: true,
        ownedByThisProcess: true,
      }),
      row({ runId: "run-b", bundleName: "Bravo", group: "yesterday" }),
      row({ runId: "run-c", bundleName: "Charlie", group: "older" }),
    ],
  });
  const frame = t.captureCharFrame();
  assert.match(frame, /Today/);
  assert.match(frame, /Yesterday/);
  assert.match(frame, /Older/);
  // Group order preserved (newest first).
  assert.ok(frame.indexOf("Today") < frame.indexOf("Yesterday"));
  assert.ok(frame.indexOf("Yesterday") < frame.indexOf("Older"));
  // Each row carries id, activity time, live marker, and Bundle name.
  assert.match(frame, /run-a/);
  assert.match(frame, /2026-01-01/);
  assert.match(frame, /Alpha/);
  assert.match(firstRunLine(frame), /● live/);
  assert.match(frame, /Charlie/);
  // Focus indicator on the first row, readable without colour.
  assert.match(selectedLine(frame), /run-a/);
});

test("both filters explain their empty Previous Runs state", async () => {
  const { t } = await openList({ all: [] });
  const all = t.captureCharFrame();
  assert.match(all, /No previous Runs\s+Start a Run from Home\./);
  assert.match(all, /esc back/);

  t.mockInput.pressKey("f");
  await t.waitForFrame((frame) => frame.includes("No resumable Runs"));
  assert.match(
    t.captureCharFrame(),
    /No resumable Runs\s+Press f to show all Runs\./,
  );
});

// --- AC1: the Resumable filter ----------------------------------------------

test("the Resumable filter toggles by key to show only resting Runs", async () => {
  const { t } = await openList({
    all: [
      row({ runId: "run-live", bundleName: "Live", group: "today" }),
      row({ runId: "run-halted", bundleName: "Halted", group: "today" }),
    ],
    resumable: [
      row({ runId: "run-halted", bundleName: "Halted", group: "today" }),
    ],
  });
  assert.match(t.captureCharFrame(), /All Runs/);
  assert.match(t.captureCharFrame(), /run-live/);

  t.mockInput.pressKey("f"); // → Resumable
  await t.waitForFrame((f) => f.includes("Resumable"));
  const filtered = t.captureCharFrame();
  assert.match(filtered, /run-halted/);
  assert.doesNotMatch(filtered, /run-live/);

  t.mockInput.pressKey("f"); // → All Runs
  await t.waitForFrame((f) => f.includes("All Runs"));
  assert.match(t.captureCharFrame(), /run-live/);
});

// --- AC2: cursor paging, anchor, and the beginning-of-history marker ---------

test("reaching the threshold pages older Runs by cursor, keeps the first row, and ends in the marker", async () => {
  const all = Array.from({ length: 8 }, (_, i) =>
    row({
      runId: `run-0${i}`,
      bundleName: `Bundle ${i}`,
      group: "today",
    }),
  );
  const { t } = await openList({ all, page: 4 });

  const before = t.captureCharFrame();
  assert.match(before, /run-00/); // first page loaded
  assert.doesNotMatch(before, /run-07/); // older page not yet loaded
  assert.doesNotMatch(before, /beginning of history/);
  const firstBefore = firstRunLine(before);
  assert.match(firstBefore, /run-00/);

  t.mockInput.pressArrow("down"); // crosses the load threshold → fetch older page
  await t.waitForFrame((f) => f.includes("run-07"));
  const after = t.captureCharFrame();
  assert.match(after, /run-07/); // older Runs loaded by cursor
  assert.match(after, /beginning of history/); // final page marker
  // The first visible row is unchanged by the append (viewport anchored).
  assert.match(firstRunLine(after), /run-00/);
});

// --- AC5/AC6: small width and resize ----------------------------------------

test("a small width keeps rows on one line, truncating the Bundle name, and resize does not overflow", async () => {
  const longName = "A Very Long Workflow Bundle Name That Will Not Fit";
  const { t } = await openList({
    all: [row({ runId: "run-x", bundleName: longName, group: "today" })],
    width: 40,
    height: 20,
  });
  const frame = t.captureCharFrame();
  for (const line of frame.split("\n")) {
    assert.ok(line.length <= 40, `overflows 40: ${JSON.stringify(line)}`);
  }
  assert.match(frame, /run-x/); // id survives
  assert.doesNotMatch(frame, /That Will Not Fit/); // Bundle name truncated

  t.resize(SMALLEST_SUPPORTED_WIDTH, 16);
  await t.renderOnce();
  for (const line of t.captureCharFrame().split("\n")) {
    assert.ok(
      line.length <= SMALLEST_SUPPORTED_WIDTH,
      `overflows ${SMALLEST_SUPPORTED_WIDTH}: ${JSON.stringify(line)}`,
    );
  }
});

test("previous-runs-verified: focus, state-free rows, and guarded quit", async () => {
  const { t, exits } = await openList({
    all: [
      row({
        runId: "run-focus",
        bundleName: "Focused Bundle",
        group: "today",
        live: true,
        ownedByThisProcess: true,
      }),
    ],
    width: SMALLEST_SUPPORTED_WIDTH,
    height: 16,
  });

  const rowLine = selectedLine(t.captureCharFrame());
  assert.match(rowLine, /^\s*› run-focus/);
  assert.doesNotMatch(
    rowLine,
    /\b(?:running|blocked|halted|failed|succeeded|cancelled)\b/,
  );

  t.resize(40, 16);
  await t.renderOnce();
  t.mockInput.pressKey("q");
  await t.waitForFrame((frame) => frame.includes("Halt 1 live Run and quit?"));
  assert.deepEqual(exits, []);

  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => !frame.includes("Halt 1 live Run and quit?"));
  assert.deepEqual(exits, []);
  assert.match(t.captureCharFrame(), /Previous Runs/);
});

// --- AC3: Enter opens the Workbench; Escape restores the row ----------------

test("Enter opens the selected Run's Workbench; Escape returns with the row restored", async () => {
  const mounted = await openList({
    all: [
      row({ runId: "run-a", bundleName: "Alpha", group: "today" }),
      row({ runId: "run-b", bundleName: "Bravo", group: "today" }),
    ],
    run: runOf({ runId: "run-b", state: "running" }),
  });
  const { t, renderer } = mounted;
  t.mockInput.pressArrow("down"); // select the second row
  await until(() => selectedLine(t.captureCharFrame()).includes("run-b"));
  t.mockInput.pressEnter(); // → Workbench
  await t.waitForFrame((f) => f.includes("Timeline"));

  renderer.key("escape"); // Workbench Escape → back to the list
  await until(() => t.captureCharFrame().includes("Previous Runs"));
  assert.match(selectedLine(t.captureCharFrame()), /run-b/); // row restored
});

test("Escape restores a row from a later page by paging forward on remount", async () => {
  const all = Array.from({ length: 6 }, (_, i) =>
    row({ runId: `run-0${i}`, bundleName: `Bundle ${i}`, group: "today" }),
  );
  const { t, renderer } = await openList({
    all,
    page: 3,
    run: runOf({ runId: "run-05", state: "running" }),
  });
  // Move down to run-05 (on the second page); paging loads it.
  for (let i = 0; i < 5; i++) {
    t.mockInput.pressArrow("down");
    await until(() =>
      selectedLine(t.captureCharFrame()).includes(`run-0${i + 1}`),
    );
  }
  t.mockInput.pressEnter(); // → Workbench
  await t.waitForFrame((f) => f.includes("Timeline"));

  renderer.key("escape"); // back to the list, which remounts with only page 1
  await until(() => t.captureCharFrame().includes("f filter"));
  // The saved index (5) lived on page 2; onMount pages forward and restores it.
  assert.match(selectedLine(t.captureCharFrame()), /run-05/);
});

// --- AC3: delete from the Workbench returns to the list without the Run -------

test("delete from the Workbench returns to the list without that Run", async () => {
  const all = [
    row({ runId: "run-a", bundleName: "Alpha", group: "today" }),
    row({ runId: "run-doomed", bundleName: "Doomed", group: "today" }),
  ];
  const remove = (runId: string) => {
    const at = all.findIndex((r) => r.runId === runId);
    if (at >= 0) all.splice(at, 1);
  };
  const mounted = await openList({
    all,
    run: runOf({
      runId: "run-doomed",
      state: "failed",
      actionOffers: [
        {
          action: "delete-run",
          runId: "run-doomed",
          consequence:
            "remove the Run and its stored history and Artifacts from disk.",
        },
      ],
    }),
    onRemove: remove,
  });
  const { t, renderer } = mounted;
  t.mockInput.pressArrow("down"); // select run-doomed
  await until(() => selectedLine(t.captureCharFrame()).includes("run-doomed"));
  t.mockInput.pressEnter(); // → Workbench
  await t.waitForFrame((f) => f.includes("x delete")); // the delete control is offered

  renderer.key("x"); // arm the delete confirmation
  await until(() => t.captureCharFrame().includes("Delete is permanent"));
  renderer.key("y"); // confirm → returns to the list
  await until(() => t.captureCharFrame().includes("Previous Runs"));
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /run-doomed/); // the Run is gone from the list
  assert.match(frame, /run-a/); // the other Run remains
});

test("a Run deleted outside the Workbench returns to Previous Runs with a dismissible notice", async () => {
  const run = runOf({ runId: "run-doomed" });
  const disappearing = disappearingRunView(run);
  const { t } = await openList({
    all: [row({ runId: run.runId, bundleName: run.bundle.name })],
    runView: disappearing.view,
  });
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Timeline"));

  disappearing.deleted();
  await t.waitForFrame((frame) => frame.includes("was deleted"));
  assert.match(t.captureCharFrame(), /Alpha Flow was deleted/);

  t.mockInput.pressKey("d");
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /was deleted/);
});

test("a Run deleted between list selection and initial open uses the row name in its notice", async () => {
  const run = runOf({ runId: "run-doomed" });
  const { t } = await openList({
    all: [row({ runId: run.runId, bundleName: run.bundle.name })],
    runView: missingRunView(run),
  });

  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("was deleted"));
  assert.match(t.captureCharFrame(), /Alpha Flow was deleted/);
  assert.doesNotMatch(t.captureCharFrame(), /Run run-doomed not found/);
});
