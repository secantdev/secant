import assert from "node:assert/strict";
import { test } from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { App } from "../../src/tui/tui.js";
import type { BundleCatalogView, WorkspaceView } from "../../src/tui/tui.js";
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
  summary({ id: "com.example.proof", version: "2.0.0", name: "Proof Bundle" }),
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
      steps: [{ id: "work", kind: "agent" }],
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
    stepKindCounts: { agent: 2 },
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
      const found =
        selector.id === PROOF_FOCUS.id &&
        selector.version === PROOF_FOCUS.version;
      const [focus] = createSignal<BundleFocusSnapshot>({
        family: "bundle-catalog",
        view: "focus",
        selection: selector,
        result: found
          ? { found: true, bundle: PROOF_FOCUS }
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

async function mount(rows = ROWS, width = 80, height = 40) {
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace()}
        bundles={bundles(rows)}
        exit={(reason) => exits.push(reason)}
      />
    ),
    { width, height },
  );
  return { t, exits };
}

/** The single list line carrying the focus glyph identifies the selected row. */
function selectedLine(frame: string): string {
  return frame.split("\n").find((line) => line.includes("› ")) ?? "";
}

/** Poll a condition in real time (a lone Escape is held briefly by OpenTUI's
 * key disambiguation before its binding fires). */
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

test("Home opens the Bundle list showing every summary fact, sorted", async () => {
  const { t } = await mount();
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Proof Bundle"));
  const frame = t.captureCharFrame();
  // Every summary fact carried by text.
  assert.match(frame, /Alpha Flow/);
  assert.match(frame, /com\.example\.alpha@1\.0\.0/);
  assert.match(frame, /\[stable\]/);
  assert.match(frame, /\[prerelease\]/);
  assert.match(frame, /sha256:a1b2c3/);
  assert.match(frame, /local-file/);
  assert.match(frame, /macos, linux, windows/);
  assert.match(frame, /needs Secant ≥ 0\.2/); // the engine note
  assert.match(frame, /not yet trusted/);
  // Sorted: name asc (Alpha before Proof), then version desc (2.0.0 before 1.0.0).
  assert.ok(frame.indexOf("Alpha Flow") < frame.indexOf("Proof Bundle"));
  assert.ok(
    frame.indexOf("com.example.proof@2.0.0") <
      frame.indexOf("com.example.proof@1.0.0"),
  );
  // Focus indicator on the first row, readable without colour.
  assert.match(selectedLine(frame), /Alpha Flow/);
});

test("empty Catalog names the headless install commands", async () => {
  const { t } = await mount([]);
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Catalog is empty"));
  const frame = t.captureCharFrame();
  assert.match(frame, /secant bundle build/);
  assert.match(frame, /secant bundle install/);
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
    () => <App view={approvedWorkspace()} bundles={view} exit={() => {}} />,
    { width: 80, height: 40 },
  );
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("Catalog error"));
  const frame = t.captureCharFrame();
  assert.match(frame, /bundle-bytes-missing/);
  assert.match(frame, /Reinstall the Bundle/);
  assert.doesNotMatch(frame, /Catalog is empty/);
});

test("Enter inspects; Escape returns with the same row focused", async () => {
  const { t } = await mount();
  await t.waitForFrame((f) => f.includes("Workflow Bundles"));
  t.mockInput.pressEnter(); // Home -> list
  await t.waitForFrame((f) => f.includes("Proof Bundle"));
  t.mockInput.pressArrow("down"); // select the second row (Proof Bundle 2.0.0)
  await t.waitForFrame(() =>
    selectedLine(t.captureCharFrame()).includes("Proof Bundle"),
  );
  t.mockInput.pressEnter(); // list -> inspection
  await t.waitForFrame((f) => f.includes("Proof of the pipeline"));
  const focus = t.captureCharFrame();
  // Every exact-focus fact, including Execution summary and findings.
  assert.match(focus, /Proof of the pipeline/);
  assert.match(focus, /sha256:a1b2c3/);
  assert.match(focus, />=0\.1\.0/);
  assert.match(focus, /not yet trusted/);
  assert.match(focus, /Ada/);
  assert.match(focus, /target \(text\).*the goal/s);
  assert.match(focus, /plan \(agent\)/);
  assert.match(focus, /repeat until done/);
  assert.match(focus, /review every 3/);
  assert.match(focus, /git/);
  assert.match(focus, /report \(file\)/);
  assert.match(focus, /Execution summary \(platform macos\)/);
  assert.match(focus, /make/);
  assert.match(focus, /warning: Bundles can run arbitrary code/);
  assert.match(focus, /\[warning\] C001/); // severity readable without colour

  t.mockInput.pressEscape(); // inspection -> list
  await until(() => !t.captureCharFrame().includes("Proof of the pipeline"));
  // Focus restored to the same row.
  assert.match(selectedLine(t.captureCharFrame()), /Proof Bundle/);
});

test("q quits from both the list and the inspection view", async () => {
  const listRun = await mount();
  await listRun.t.waitForFrame((f) => f.includes("Workflow Bundles"));
  listRun.t.mockInput.pressEnter();
  await listRun.t.waitForFrame((f) => f.includes("Proof Bundle"));
  listRun.t.mockInput.pressKey("q");
  await listRun.t.waitFor(() => listRun.exits.length > 0);
  assert.equal(listRun.exits.length, 1);

  const inspectRun = await mount();
  await inspectRun.t.waitForFrame((f) => f.includes("Workflow Bundles"));
  inspectRun.t.mockInput.pressEnter();
  await inspectRun.t.waitForFrame((f) => f.includes("Proof Bundle"));
  inspectRun.t.mockInput.pressArrow("down");
  inspectRun.t.mockInput.pressEnter();
  await inspectRun.t.waitForFrame((f) => f.includes("Proof of the pipeline"));
  inspectRun.t.mockInput.pressKey("q");
  await inspectRun.t.waitFor(() => inspectRun.exits.length > 0);
  assert.equal(inspectRun.exits.length, 1);
});

test("inspection fits 80×24, clipping a long Bundle instead of corrupting it", async () => {
  async function openInspect(height: number) {
    const { t } = await mount(ROWS, 80, height);
    await t.waitForFrame((f) => f.includes("Workflow Bundles"));
    t.mockInput.pressEnter(); // Home -> list
    await t.waitForFrame((f) => f.includes("Proof Bundle"));
    t.mockInput.pressArrow("down"); // select Proof Bundle 2.0.0
    await t.waitForFrame(() =>
      selectedLine(t.captureCharFrame()).includes("Proof Bundle"),
    );
    t.mockInput.pressEnter(); // list -> inspection
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
  const full = rows((await openInspect(40)).captureCharFrame());
  const clipped = rows((await openInspect(24)).captureCharFrame());

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
