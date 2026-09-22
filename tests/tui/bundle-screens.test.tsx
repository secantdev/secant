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
  RunWorkbenchView,
  WorkspaceView,
} from "../../src/tui/tui.js";
import { makeFakeRenderer, until } from "./renderer-fixture.js";
import type {
  BundleCatalogSnapshot,
  BundleFocusSelector,
  BundleFocusSnapshot,
  InstalledBundleFocus,
  InstalledBundleSummary,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";

// In-memory renderer tests over fake `bundle-catalog` snapshots: the list, the
// empty state, and the inspection view. Content present, key bindings
// dispatching (Enter opens, Escape returns with focus restored, q quits),
// small-width and resize relayout without overflow, and a focus indicator that
// reads without colour (#57 AC1–AC4).

const WORKSPACE = "/tmp/secant-demo-workspace";

/** An already-approved Workspace so Home is interactive at mount. */
function approvedWorkspace(): WorkspaceView {
  const [snapshot] = createSignal<WorkspaceSnapshot>({
    family: "workspace",
    path: WORKSPACE,
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 3,
    harnesses: [],
    actionOffers: [],
  });
  return { snapshot, approve() {} };
}

function summary(
  over: Partial<InstalledBundleSummary> &
    Pick<InstalledBundleSummary, "id" | "version" | "name">,
): InstalledBundleSummary {
  return {
    digest: "a1b2c3",
    description: "",
    origin: { kind: "local-file", location: "/bundles/x.wfb" },
    stability: "stable",
    platforms: ["macos", "linux", "windows"],
    engine: { range: ">=0.1.0", satisfied: true },
    trust: { state: "not-yet-trusted" },
    ...over,
  };
}

// Sorted by name then version descending, as the Projection guarantees.
const ROWS: InstalledBundleSummary[] = [
  summary({
    id: "com.example.alpha",
    version: "1.0.0",
    name: "Alpha Flow",
    engine: {
      range: ">=0.2.0",
      satisfied: false,
      note: "needs Secant ≥ 0.2",
    },
  }),
  summary({
    id: "com.example.proof",
    version: "2.0.0",
    name: "Proof Bundle",
    description: "Proof of the pipeline",
  }),
  summary({
    id: "com.example.proof",
    version: "1.0.0",
    name: "Proof Bundle",
    stability: "prerelease",
  }),
];

const PROOF_FOCUS: InstalledBundleFocus = {
  ...summary({
    id: "com.example.proof",
    version: "2.0.0",
    name: "Proof Bundle",
    description: "Proof of the pipeline",
  }),
  author: { authors: ["Ada"], license: "MIT" },
  launchInputs: [{ name: "target", type: "text", description: "the goal" }],
  routing: [
    { node: "step", step: { id: "plan", kind: "agent" } },
    {
      node: "repeat",
      until: "done",
      reviewCheckpoint: { interval: 3, message: "check in" },
      steps: [
        { id: "work", kind: "agent" },
        { id: "build", kind: "command" },
      ],
    },
  ],
  workspacePrerequisites: ["git"],
  producedArtifacts: [
    { name: "report", type: "file", home: "workspace", producedBy: "plan" },
  ],
  executionSummary: {
    platform: "macos",
    identity: { id: "com.example.proof", version: "2.0.0" },
    digest: "a1b2c3",
    origin: { kind: "local-file", location: "/bundles/x.wfb" },
    platforms: ["macos", "linux", "windows"],
    stepKindCounts: { agent: 2, command: 1 },
    commands: [
      {
        stepId: "build",
        executable: "make",
        environmentVariableNames: ["CI"],
        scripts: ["build.sh"],
      },
    ],
    warning: "Bundles can run arbitrary code.",
  },
  compositionFindings: [
    {
      code: "C001",
      severity: "warning",
      target: "plan",
      explanation: "no timeout",
    },
  ],
};

function bundles(rows: InstalledBundleSummary[]): BundleCatalogView {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles: rows },
  });
  return {
    openList: () => list,
    openFocus(selector: BundleFocusSelector) {
      const selected = rows.find(
        (row) => row.id === selector.id && row.version === selector.version,
      );
      const bundle =
        selector.id === PROOF_FOCUS.id &&
        selector.version === PROOF_FOCUS.version
          ? PROOF_FOCUS
          : selected === undefined
            ? undefined
            : {
                ...selected,
                author: {},
                launchInputs: [],
                routing: [],
                workspacePrerequisites: [],
                producedArtifacts: [],
                executionSummary: {
                  platform: "macos" as const,
                  identity: { id: selected.id, version: selected.version },
                  digest: selected.digest,
                  origin: selected.origin,
                  platforms: selected.platforms,
                  stepKindCounts: {},
                  commands: [],
                  warning: "Bundles can run arbitrary code.",
                },
                compositionFindings: [],
              };
      const [focus] = createSignal<BundleFocusSnapshot>({
        family: "bundle-catalog",
        view: "focus",
        selection: selector,
        result:
          bundle !== undefined
            ? { found: true, bundle }
            : {
                found: false,
                problem: {
                  code: "not-found",
                  explanation: "No such Bundle.",
                  remediation: "Run `secant bundle list`.",
                  possibleEffects: "none",
                },
              },
      });
      return focus;
    },
  };
}

/** The Bundle screens never launch; a stub launch seam satisfies the App prop. */
function noLaunch(): RunLaunchView {
  return { launch: () => () => ({ kind: "pending" }) };
}

/** The Bundle screens never open the Run Workbench; these stubs satisfy the two
 *  App props the Workbench needs (#91). */
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

async function mount(rows = ROWS, width = 80, height = 40) {
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace()}
        bundles={bundles(rows)}
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
  return { t, exits };
}

/** The single list line carrying the focus glyph identifies the selected row. */
function selectedLine(frame: string): string {
  return frame.split("\n").find((line) => line.includes("│ › ")) ?? "";
}

test("bundle-catalog-two-pane: one catalog shows installed count, sorted rows, and visible focus", async () => {
  const { t } = await mount();
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Proof Bundle"));
  const frame = t.captureCharFrame();
  assert.match(frame, /3 installed/);
  assert.match(frame, /Find an installed Bundle/);
  assert.match(frame, /Inspector/);
  assert.match(frame, /Alpha Flow/);
  assert.match(frame, /com\.example\.alpha@1\.0\.0/);
  assert.match(frame, /local-file/);
  assert.match(frame, /No launch inputs/);
  assert.match(frame, /Start a Run proceeds from Harness to/);
  // Sorted: name asc (Alpha before Proof), then version desc (2.0.0 before 1.0.0).
  assert.ok(frame.indexOf("Alpha Flow") < frame.indexOf("Proof Bundle"));
  assert.ok(
    frame.indexOf("com.example.proof@2.0.0") <
      frame.indexOf("com.example.proof@1.0.0"),
  );
  // Focus indicator on the first row, readable without colour.
  assert.match(selectedLine(frame), /Alpha Flow/);
});

test("Workflow Bundles searches the existing list snapshot and keeps the inspector on one screen", async () => {
  const { t } = await mount();
  await t.waitForFrame((frame) => frame.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("3 installed"));

  const initial = t.captureCharFrame();
  assert.match(initial, /Find an installed Bundle/);
  assert.match(initial, /Alpha Flow/);
  assert.match(initial, /com\.example\.alpha@1\.0\.0/);

  await t.mockInput.typeText("pipeline");
  await t.waitForFrame((frame) => !frame.includes("Alpha Flow"));
  const filtered = t.captureCharFrame();
  assert.match(filtered, /Proof Bundle/);
  assert.match(filtered, /Proof of the pipeline/);
  assert.doesNotMatch(filtered, /Alpha Flow/);

  const replaceQuery = async (current: string, next: string) => {
    for (let index = 0; index < current.length; index += 1) {
      t.mockInput.pressBackspace();
    }
    await t.mockInput.typeText(next);
  };
  await replaceQuery("pipeline", "com.example.alpha");
  await t.waitForFrame((frame) => frame.includes("Alpha Flow"));
  assert.doesNotMatch(t.captureCharFrame(), /Proof Bundle/);

  await replaceQuery("com.example.alpha", "/bundles/x.wfb");
  await t.waitForFrame((frame) => frame.includes("Proof Bundle"));
  assert.match(t.captureCharFrame(), /Alpha Flow/);

  await replaceQuery("/bundles/x.wfb", "Alpha Flow");
  await t.waitForFrame((frame) => !frame.includes("Proof Bundle"));
  assert.match(t.captureCharFrame(), /Alpha Flow/);
  assert.doesNotMatch(t.captureCharFrame(), /Proof Bundle/);

  await replaceQuery("Alpha Flow", "missing");
  await t.waitForFrame(
    (frame) =>
      frame.includes("No matching Workflow") && frame.includes("Bundles"),
  );
  const empty = t.captureCharFrame();
  assert.match(empty, /Try a different name, id/);
  assert.match(empty, /description, or origin/);
});

test("a trusted Bundle uses the shared Trust wording in its inspector", async () => {
  const trustedSummary = summary({
    id: "com.example.trusted",
    version: "1.0.0",
    name: "Trusted Flow",
    trust: {
      state: "trusted",
      operationId: "op-1",
      grantedAt: "2026-09-12T09:00:00.000Z",
    },
  });
  const trustedFocus: InstalledBundleFocus = {
    ...PROOF_FOCUS,
    ...trustedSummary,
    description: "A trusted pipeline",
  };
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles: [trustedSummary] },
  });
  const view: BundleCatalogView = {
    openList: () => list,
    openFocus(selector: BundleFocusSelector) {
      const [focus] = createSignal<BundleFocusSnapshot>({
        family: "bundle-catalog",
        view: "focus",
        selection: selector,
        result: { found: true, bundle: trustedFocus },
      });
      return focus;
    },
  };
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace()}
        bundles={view}
        harnesses={inertHarnessCatalogView()}
        launch={noLaunch()}
        run={noRunView()}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        exit={() => {}}
      />
    ),
    { width: 80, height: 40 },
  );
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Trusted Flow"));
  await t.waitForFrame((f) => f.includes("A trusted pipeline"));
  assert.match(t.captureCharFrame(), /trusted \(granted 2026-09-12/);
});

test("empty Catalog names the headless install commands", async () => {
  const { t } = await mount([]);
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame(
    (f) => f.includes("No installed Workflow") && f.includes("Bundles"),
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /Install one with `secant/);
  assert.match(frame, /bundle build` or `secant/);
  assert.match(frame, /bundle install`/);
});

test("a list whose managed bytes are gone shows the Problem, not rows (#74 A3)", async () => {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: {
      found: false,
      problem: {
        code: "bundle-bytes-missing",
        explanation: "Its stored bytes are missing.",
        remediation: "Reinstall the Bundle to restore its bytes.",
        possibleEffects: "none",
      },
    },
  });
  const view: BundleCatalogView = {
    openList: () => list,
    openFocus: () => {
      throw new Error("not used");
    },
  };
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace()}
        bundles={view}
        harnesses={inertHarnessCatalogView()}
        launch={noLaunch()}
        run={noRunView()}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        exit={() => {}}
      />
    ),
    { width: 80, height: 40 },
  );
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Catalog error"));
  const frame = t.captureCharFrame();
  assert.match(frame, /bundle-bytes-missing/);
  assert.match(frame, /Reinstall the Bundle/);
  assert.doesNotMatch(frame, /Catalog is empty/);
});

test("a focused Bundle whose managed bytes are gone shows its Problem", async () => {
  const row = summary({
    id: "com.example.missing",
    version: "1.0.0",
    name: "Missing Bytes",
  });
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles: [row] },
  });
  const view: BundleCatalogView = {
    openList: () => list,
    openFocus(selector) {
      const [focus] = createSignal<BundleFocusSnapshot>({
        family: "bundle-catalog",
        view: "focus",
        selection: selector,
        result: {
          found: false,
          problem: {
            code: "bundle-bytes-missing",
            explanation: "The selected Bundle's managed bytes are missing.",
            remediation: "Reinstall it.",
            possibleEffects: "none",
          },
        },
      });
      return focus;
    },
  };
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace()}
        bundles={view}
        harnesses={inertHarnessCatalogView()}
        launch={noLaunch()}
        run={noRunView()}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer().port}
        exit={() => {}}
      />
    ),
    { width: 80, height: 24 },
  );
  await t.waitForFrame((frame) => frame.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame(
    (frame) =>
      frame.includes("The selected Bundle's managed bytes are") &&
      frame.includes("missing."),
  );
  assert.match(t.captureCharFrame(), /Missing Bytes/);
});

test("moving the result focus updates the inspector with numbered Workflow commands and allowed facts", async () => {
  const { t } = await mount();
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter(); // Home -> list
  await t.waitForFrame((f) => f.includes("Proof Bundle"));
  t.mockInput.pressArrow("down"); // select the second row (Proof Bundle 2.0.0)
  await t.waitForFrame(() =>
    selectedLine(t.captureCharFrame()).includes("Proof Bundle"),
  );
  await t.waitForFrame((f) => f.includes("Proof of the pipeline"));
  const focus = t.captureCharFrame();
  // The accepted catalog facts, including shared Trust wording and generated
  // Execution summary, stay on the same screen as the result list.
  assert.match(focus, /Proof of the pipeline/);
  assert.match(focus, /sha256:a1b2c3/);
  assert.match(focus, />=0\.1\.0/);
  assert.match(focus, /not yet trusted/);
  assert.match(focus, /target \(text\).*the goal/s);
  assert.match(focus, /1\. plan \(agent\)/);
  assert.match(focus, /2\. Repeat until done/);
  assert.match(focus, /2\.2\. build \(command\)/);
  assert.match(focus, /\$ make/);
  assert.match(focus, /git/);
  assert.match(focus, /Execution summary · macos/);
  assert.match(focus, /make/);
  assert.match(focus, /Warning · Bundles can run arbitrary code/);
  assert.doesNotMatch(focus, /Ada|report \(file\)|C001/);
  assert.doesNotMatch(
    focus,
    /acknowledge trust|install Bundle|uninstall|launch Bundle/i,
  );
  assert.match(selectedLine(focus), /Proof Bundle/);
});

test("pane focus is visible and inspector scrolling clamps at both ends", async () => {
  const { t } = await mount(ROWS, 80, 18);
  await t.waitForFrame((frame) => frame.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Alpha Flow"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((frame) => frame.includes("Proof of the pipeline"));

  assert.match(t.captureCharFrame(), /› Find an installed Bundle/);
  t.mockInput.pressTab();
  await t.waitForFrame((frame) => frame.includes("› Inspector"));
  const top = t.captureCharFrame();
  assert.doesNotMatch(selectedLine(top), /Proof Bundle/);
  t.mockInput.pressArrow("left");
  await t.waitForFrame((frame) => frame.includes("› Find an installed Bundle"));
  t.mockInput.pressTab();
  await t.waitForFrame((frame) => frame.includes("› Inspector"));
  t.mockInput.pressKey("\u001B[6~");
  await t.renderOnce();
  assert.notEqual(t.captureCharFrame(), top);
  t.mockInput.pressKey("\u001B[5~");
  await t.renderOnce();
  assert.equal(t.captureCharFrame(), top);

  for (let index = 0; index < 60; index += 1) {
    t.mockInput.pressArrow("down");
  }
  await t.renderOnce();
  const bottom = t.captureCharFrame();
  assert.match(bottom, /Warning · Bundles can run arbitrary code/);
  assert.doesNotMatch(bottom, /Proof of the pipeline/);

  t.mockInput.pressKey("\u001B[6~");
  await t.renderOnce();
  assert.equal(t.captureCharFrame(), bottom);

  for (let index = 0; index < 60; index += 1) {
    t.mockInput.pressArrow("up");
  }
  await t.renderOnce();
  assert.equal(t.captureCharFrame(), top);
  t.mockInput.pressKey("\u001B[5~");
  await t.renderOnce();
  assert.equal(t.captureCharFrame(), top);
});

test("small terminals stack the result and inspector panes without overflow", async () => {
  const { t } = await mount(ROWS, 50, 24);
  await t.waitForFrame((frame) => frame.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Inspector"));
  const frame = t.captureCharFrame();
  const lines = frame.split("\n");
  const resultsLine = lines.findIndex((line) =>
    line.includes("Find an installed Bundle"),
  );
  const inspectorLine = lines.findIndex((line) => line.includes("Inspector"));
  assert.ok(resultsLine >= 0);
  assert.ok(inspectorLine > resultsLine);
  assert.equal(
    lines.some(
      (line) =>
        line.includes("Find an installed Bundle") && line.includes("Inspector"),
    ),
    false,
  );
  for (const line of lines) {
    assert.ok(line.length <= 50, `overflows 50 cols: ${JSON.stringify(line)}`);
  }
});

test("Back returns to Home or the originating Start a Run Bundle step", async () => {
  const homeRun = await mount();
  await homeRun.t.waitForFrame((frame) => frame.includes("Workflow Bundles"));
  homeRun.t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  homeRun.t.mockInput.pressEnter();
  await homeRun.t.waitForFrame((frame) => frame.includes("3 installed"));
  homeRun.t.mockInput.pressEscape();
  await until(() => !homeRun.t.captureCharFrame().includes("3 installed"));
  await homeRun.t.waitForFrame((frame) => /^ Secant\s*$/m.test(frame));
  assert.doesNotMatch(homeRun.t.captureCharFrame(), /3 installed/);

  const startRun = await mount();
  await startRun.t.waitForFrame((frame) => frame.includes("Workflow Bundles"));
  startRun.t.mockInput.pressEnter(); // Start a Run is the first, default entry
  await startRun.t.waitForFrame((frame) => frame.includes("Start a Run"));
  startRun.t.mockInput.pressArrow("down");
  await startRun.t.waitForFrame((frame) => frame.includes("› Proof Bundle"));
  startRun.t.mockInput.pressKey("v");
  await startRun.t.waitForFrame((frame) => frame.includes("3 installed"));
  assert.match(startRun.t.captureCharFrame(), /Proof of the pipeline/);
  startRun.t.mockInput.pressEscape();
  await until(() => !startRun.t.captureCharFrame().includes("3 installed"));
  await startRun.t.waitForFrame((frame) => /^ Start a Run\s*$/m.test(frame));
  assert.match(startRun.t.captureCharFrame(), /› Proof Bundle/);
});

test("search owns printable keys while Ctrl+C quits from either pane", async () => {
  const listRun = await mount();
  await listRun.t.waitForFrame((f) => f.includes("Workflow Bundles"));
  listRun.t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  listRun.t.mockInput.pressEnter();
  await listRun.t.waitForFrame((f) => f.includes("Proof Bundle"));
  listRun.t.mockInput.pressKey("q");
  await listRun.t.waitForFrame((frame) =>
    frame.includes("No matching Workflow"),
  );
  assert.equal(listRun.exits.length, 0);
  listRun.t.mockInput.pressCtrlC();
  await listRun.t.waitFor(() => listRun.exits.length > 0);
  assert.equal(listRun.exits.length, 1);

  const inspectRun = await mount();
  await inspectRun.t.waitForFrame((f) => f.includes("Workflow Bundles"));
  inspectRun.t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  inspectRun.t.mockInput.pressEnter();
  await inspectRun.t.waitForFrame((f) => f.includes("Proof Bundle"));
  inspectRun.t.mockInput.pressArrow("down");
  await inspectRun.t.waitForFrame((f) => f.includes("Proof of the pipeline"));
  inspectRun.t.mockInput.pressArrow("right");
  await inspectRun.t.waitForFrame((f) => f.includes("› Inspector"));
  inspectRun.t.mockInput.pressKey("q");
  await inspectRun.t.renderOnce();
  assert.equal(inspectRun.exits.length, 0);
  inspectRun.t.mockInput.pressCtrlC();
  await inspectRun.t.waitFor(() => inspectRun.exits.length > 0);
  assert.equal(inspectRun.exits.length, 1);
});

test("long catalog content stays bounded at 80×24 without corrupting visible rows", async () => {
  async function openCatalog(height: number) {
    const { t } = await mount(ROWS, 80, height);
    await t.waitForFrame((f) => f.includes("Workflow Bundles"));
    t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
    t.mockInput.pressEnter(); // Home -> list
    await t.waitForFrame((f) => f.includes("Proof Bundle"));
    t.mockInput.pressArrow("down"); // select Proof Bundle 2.0.0
    await t.waitForFrame(() =>
      selectedLine(t.captureCharFrame()).includes("Proof Bundle"),
    );
    await t.waitForFrame((f) => f.includes("Proof of the pipeline"));
    return t;
  }

  // Tall enough to show the whole focus, then too short for it. `captureCharFrame`
  // ends with a trailing newline, so drop the final empty element.
  const rows = (frame: string) => {
    const lines = frame.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  };
  const full = rows((await openCatalog(40)).captureCharFrame());
  const clipped = rows((await openCatalog(24)).captureCharFrame());

  // No horizontal overflow, and no rows past the box height.
  for (const line of clipped) {
    assert.ok(line.length <= 80, `overflows 80 cols: ${JSON.stringify(line)}`);
  }
  assert.ok(clipped.length <= 24, `rendered ${clipped.length} rows past 24`);

  // The overflow guard clips the bottom and keeps every visible row intact, so
  // the top of the short render matches the tall one line-for-line. Without
  // overflow="hidden" + flexShrink={0} the fixed-height column shrinks every row
  // and the two diverge.
  assert.deepEqual(clipped.slice(0, 10), full.slice(0, 10));
});

test("list fits a small width and after resize without overflow", async () => {
  const { t } = await mount(ROWS, 40, 20);
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressArrow("down"); // select Workflow Bundles (index 1)
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Proof Bundle"));
  for (const line of t.captureCharFrame().split("\n")) {
    assert.ok(line.length <= 40, `overflows 40 cols: ${JSON.stringify(line)}`);
  }
  t.resize(30, 16);
  await t.renderOnce();
  for (const line of t.captureCharFrame().split("\n")) {
    assert.ok(
      line.length <= 30,
      `overflows 30 cols after resize: ${JSON.stringify(line)}`,
    );
  }
});
