import assert from "node:assert/strict";
import { test } from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { App } from "../../src/tui/tui.js";
import {
  inertHarnessCatalogView,
  inertRunActionsView,
  inertRunListView,
} from "./inert.js";
import type {
  BundleCatalogView,
  RunLaunchView,
  RunListState,
  RunListView,
  RunWorkbenchView,
  WorkspaceView,
} from "../../src/tui/tui.js";
import { makeFakeRenderer, until } from "./renderer-fixture.js";
import type {
  BundleCatalogSnapshot,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";

/** A bundle view over an empty Catalog; these Workspace tests never navigate. */
function emptyBundles(): BundleCatalogView {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles: [] },
  });
  return {
    openList: () => list,
    openFocus: () => {
      throw new Error("not used");
    },
  };
}

const PATH = "/tmp/secant-demo-workspace";

function unapproved(): WorkspaceSnapshot {
  return {
    family: "workspace",
    path: PATH,
    approval: { state: "unapproved" },
    installedBundleCount: 0,
    harnesses: [],
    actionOffers: [{ action: "approve-workspace", input: { path: PATH } }],
  };
}
function approved(): WorkspaceSnapshot {
  return {
    family: "workspace",
    path: PATH,
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 0,
    harnesses: [],
    actionOffers: [],
  };
}

/** A hand-driven view over fake snapshots; `approve` flips it to approved. */
function fakeView(): WorkspaceView & { approvedOnce(): boolean } {
  const [snapshot, setSnapshot] = createSignal<WorkspaceSnapshot>(unapproved());
  let approvedCalled = false;
  return {
    snapshot,
    approve() {
      approvedCalled = true;
      setSnapshot(approved());
    },
    approvedOnce: () => approvedCalled,
  };
}

function noLaunch(): RunLaunchView {
  return { launch: () => () => ({ kind: "pending" }) };
}

/** The Workspace/approval screens never open the Run Workbench; stubs satisfy
 *  the two App props the Workbench needs (#91). */
function noRunView(): RunWorkbenchView {
  return {
    openRun() {
      throw new Error("run workbench not used in this test");
    },
    readResource() {
      throw new Error("run workbench not used in this test");
    },
    readTranscript() {
      throw new Error("run workbench not used in this test");
    },
    answer() {
      throw new Error("run workbench not used in this test");
    },
    sendInteractiveTurn() {
      throw new Error("run workbench not used in this test");
    },
    endInteractiveStep() {
      throw new Error("run workbench not used in this test");
    },
    steer() {
      throw new Error("run workbench not used in this test");
    },
    answerText() {
      throw new Error("run workbench not used in this test");
    },
    answerRequest() {
      throw new Error("run workbench not used in this test");
    },
  };
}

async function mount(width = 60, height = 16) {
  const view = fakeView();
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        view={view}
        bundles={emptyBundles()}
        harnesses={inertHarnessCatalogView()}
        launch={noLaunch()}
        run={noRunView()}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        exit={(reason) => exits.push(reason)}
      />
    ),
    { width, height },
  );
  return { t, view, exits };
}

async function mountApproved(
  liveRunCount: number,
  suppliedRunList?: RunListView,
) {
  const [snapshot] = createSignal<WorkspaceSnapshot>(approved());
  const view: WorkspaceView = { snapshot, approve() {} };
  const runList: RunListView = suppliedRunList ?? {
    openRunList: () => ({
      state: () => ({
        rows: Array.from({ length: liveRunCount }, (_, index) => ({
          runId: `run-${index + 1}`,
          bundleName: "Smoke",
          activityAt: "2026-01-01T00:00:00.000Z",
          live: true,
          ownedByThisProcess: true,
          ownerPid: 4000,
          group: "today" as const,
        })),
        filter: "all" as const,
        beginningOfHistory: true,
        hasMore: false,
      }),
      setResumable() {},
      loadMore() {},
    }),
  };
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        view={view}
        bundles={emptyBundles()}
        harnesses={inertHarnessCatalogView()}
        launch={noLaunch()}
        run={noRunView()}
        runList={runList}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        exit={(reason) => exits.push(reason)}
      />
    ),
    { width: 70, height: 18 },
  );
  await t.waitForFrame((frame) => frame.includes("Secant"));
  return { t, exits };
}

test("approval dialog shows the exact path and both options, readable without colour", async () => {
  const { t } = await mount();
  await t.waitForFrame((f) => f.includes(PATH));
  const frame = t.captureCharFrame();
  // Content present: exact absolute path and both options.
  assert.match(frame, /Approve this workspace\?/);
  assert.ok(frame.includes(PATH), "shows the exact absolute path");
  assert.match(frame, /Approve/);
  assert.match(frame, /Decline/);
  // State readable without colour: the active option carries a "›" marker.
  assert.match(frame, /›/);
});

test("Approve opens Home with the Workspace path and the quit binding", async () => {
  const { t, view, exits } = await mount();
  await t.waitForFrame((f) => f.includes(PATH));
  t.mockInput.pressEnter(); // default active option is Approve
  await t.waitForFrame((f) => f.includes("quit"));
  assert.equal(view.approvedOnce(), true);
  const frame = t.captureCharFrame();
  assert.match(frame, /Secant/);
  assert.ok(frame.includes(PATH), "Home shows the Workspace path");
  assert.match(frame, /quit/);
  // Home must not show the approval dialog once approved.
  assert.doesNotMatch(frame, /Approve this workspace/);
  // Approving clears the approval dialog programmatically; that clear must not be
  // mistaken for a user dismissal and exit `declined` (regression).
  assert.deepEqual(exits, []);
});

test("Decline (Escape) declines and exits without approving", async () => {
  const { t, view, exits } = await mount();
  await t.waitForFrame((f) => f.includes(PATH));
  t.mockInput.pressEscape();
  await until(() => exits.length > 0);
  assert.deepEqual(exits, ["declined"]);
  assert.equal(view.approvedOnce(), false);
});

test("Ctrl+C on the approval dialog declines and exits", async () => {
  const { t, exits } = await mount();
  await t.waitForFrame((f) => f.includes(PATH));
  t.mockInput.pressCtrlC();
  await t.waitFor(() => exits.length > 0);
  assert.deepEqual(exits, ["declined"]);
});

test("q quits immediately with no live Runs", async () => {
  const { t, exits } = await mountApproved(0);
  t.mockInput.pressKey("q");
  await t.waitFor(() => exits.length === 1);
  assert.deepEqual(exits, [undefined]);
});

test("q with two live Runs asks once with the count, then quits on confirmation", async () => {
  const { t, exits } = await mountApproved(2);
  t.mockInput.pressKey("q");
  await t.waitForFrame((frame) => frame.includes("Halt 2 live Runs and quit?"));
  assert.equal(exits.length, 0);
  assert.equal(
    t.captureCharFrame().match(/Halt 2 live Runs and quit\?/g)?.length,
    1,
  );
  t.mockInput.pressArrow("right");
  t.mockInput.pressEnter();
  await t.waitFor(() => exits.length === 1);
  assert.deepEqual(exits, [undefined]);
});

test("the quit confirmation defaults to keeping live Runs and stays on Home", async () => {
  const { t, exits } = await mountApproved(2);
  t.mockInput.pressKey("q");
  await t.waitForFrame((frame) => frame.includes("Halt 2 live Runs and quit?"));
  t.mockInput.pressEnter();
  await t.waitForFrame(
    (frame) => !frame.includes("Halt 2 live Runs and quit?"),
  );
  assert.equal(exits.length, 0);
  assert.match(t.captureCharFrame(), /Secant/);
  assert.match(t.captureCharFrame(), /Workflow Bundles/);
});

test("Home orders its four entries, defaults to Start a Run, and omits unheld Harness qualification", async () => {
  const { t } = await mountApproved(2);
  const frame = t.captureCharFrame();
  const start = frame.indexOf("Start a Run");
  const bundles = frame.indexOf("Workflow Bundles");
  const runs = frame.indexOf("Previous Runs");
  const harnesses = frame.indexOf("Harnesses");

  assert.ok(
    start >= 0 && start < bundles && bundles < runs && runs < harnesses,
  );
  assert.match(frame, /› Start a Run/);
  assert.match(frame, /0 installed Bundles · 2 previous Runs/);
  assert.doesNotMatch(frame, /qualified/);
});

test("Home counts every page of Previous Runs in its summary", async () => {
  const pagedRunList: RunListView = {
    openRunList() {
      const [state, setState] = createSignal<RunListState>({
        rows: [
          {
            runId: "run-2",
            bundleName: "Smoke",
            activityAt: "2026-01-02T00:00:00.000Z",
            live: false,
            ownedByThisProcess: false,
            group: "today" as const,
          },
        ],
        filter: "all" as const,
        beginningOfHistory: false,
        hasMore: true,
      });
      return {
        state,
        setResumable() {},
        loadMore() {
          const newest = state().rows[0];
          if (newest === undefined) {
            throw new Error("paged Home fixture lost its newest Run");
          }
          setState({
            rows: [
              newest,
              {
                runId: "run-1",
                bundleName: "Smoke",
                activityAt: "2026-01-01T00:00:00.000Z",
                live: false,
                ownedByThisProcess: false,
                group: "yesterday" as const,
              },
            ],
            filter: "all",
            beginningOfHistory: true,
            hasMore: false,
          });
        },
      };
    },
  };
  const { t } = await mountApproved(0, pagedRunList);
  await t.waitForFrame((frame) => frame.includes("2 previous Runs"));
});

test("layout fits a small width and after resize without overflow", async () => {
  const { t } = await mount(40, 12);
  await t.waitForFrame((f) => f.includes(PATH));
  const narrow = t.captureCharFrame();
  for (const line of narrow.split("\n")) {
    assert.ok(
      line.length <= 40,
      `line overflows 40 cols: ${JSON.stringify(line)}`,
    );
  }
  t.resize(30, 10);
  await t.renderOnce();
  for (const line of t.captureCharFrame().split("\n")) {
    assert.ok(
      line.length <= 30,
      `line overflows 30 cols after resize: ${JSON.stringify(line)}`,
    );
  }
});
