import assert from "node:assert/strict";
import { test } from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { App } from "../../src/tui/tui.js";
import type { WorkspaceView } from "../../src/tui/tui.js";
import type { WorkspaceSnapshot } from "../../src/application/projection-port.js";

const PATH = "/tmp/secant-demo-workspace";

function unapproved(): WorkspaceSnapshot {
  return {
    family: "workspace",
    path: PATH,
    approval: { state: "unapproved" },
    installedBundleCount: 0,
    actionOffers: [{ action: "approve-workspace", input: { path: PATH } }],
  };
}
function approved(): WorkspaceSnapshot {
  return {
    family: "workspace",
    path: PATH,
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 0,
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

/** Await a bounded readiness condition in real time (a lone Escape is held
 * briefly by OpenTUI's key disambiguation before its binding fires). */
async function until(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition not met within the time budget.");
}

async function mount(width = 60, height = 16) {
  const view = fakeView();
  const exits: unknown[] = [];
  const t = await testRender(
    () => <App view={view} exit={(reason) => exits.push(reason)} />,
    { width, height },
  );
  return { t, view, exits };
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
  const { t, view } = await mount();
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
