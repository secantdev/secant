import assert from "node:assert/strict";
import { test } from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { App } from "../../src/tui/tui.js";
import type {
  BundleCatalogView,
  RunLaunchView,
  RunWorkbenchView,
  WorkspaceView,
} from "../../src/tui/tui.js";
import type { RendererPort } from "../../src/tui/renderer/renderer.js";
import type {
  BundleCatalogSnapshot,
  BundleFocusSnapshot,
  DiagnosticReference,
  InstalledBundleFocus,
  ResourceRead,
  ResourceReference,
  RunSnapshot,
  RunStepProgress,
  RunTimelineEvent,
  RunView,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";

// In-memory renderer tests for the Run Workbench (#91), reached the real way:
// through the App from a successful Start a Run, over fake `run` snapshots and a
// fake Renderer Port whose `size`/`onKey`/`onResize` we drive directly (AC7).
// They cover: rendering every headless `run show` fact, the details panel, live
// updates on the live edge, the paging anchor + new-activity count +
// jump-to-latest, reference inspection with a truncation marker, focus movement
// and Escape, small-width breakpoints and resize without overflow (AC1–AC8).

const WORKSPACE = "/tmp/secant-workbench-ws";

// --- a fake Renderer Port we can drive -------------------------------------

function makeRenderer(width: number, height: number) {
  let w = width;
  let h = height;
  const keys = new Set<(event: unknown) => void>();
  const resizes = new Set<(width: number, height: number) => void>();
  const port: RendererPort = {
    size: () => ({ width: w, height: h }),
    onKey: (fn) => {
      keys.add(fn);
      return () => keys.delete(fn);
    },
    onResize: (fn) => {
      resizes.add(fn);
      return () => resizes.delete(fn);
    },
    destroy() {},
    destroyed: false,
  };
  return {
    port,
    key: (name: string, mods: { ctrl?: boolean } = {}) => {
      for (const fn of keys) fn({ name, ...mods });
    },
    resize: (nw: number, nh: number) => {
      w = nw;
      h = nh;
      for (const fn of resizes) fn(nw, nh);
    },
  };
}

// --- fake App seams the flow needs to reach the Workbench ------------------

function approvedWorkspace(): WorkspaceView {
  const [snapshot] = createSignal<WorkspaceSnapshot>({
    family: "workspace",
    path: WORKSPACE,
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 1,
    actionOffers: [],
  });
  return { snapshot, approve() {} };
}

/** One trusted, input-free Bundle so Start a Run reaches Review in one Enter. */
const BUNDLE: InstalledBundleFocus = {
  id: "dev.alpha",
  version: "1.0.0",
  digest: "abc123",
  name: "Alpha Flow",
  description: "A flow.",
  origin: { kind: "local-file", location: "/bundles/x.wfb" },
  stability: "stable",
  platforms: ["linux"],
  engine: { range: ">=0.1.0", satisfied: true },
  trust: { state: "app-release" },
  author: {},
  launchInputs: [],
  routing: [{ node: "step", step: { id: "build", kind: "command" } }],
  workspacePrerequisites: [],
  producedArtifacts: [],
  executionSummary: {
    platform: "linux",
    identity: { id: "dev.alpha", version: "1.0.0" },
    digest: "abc123",
    origin: { kind: "local-file", location: "/bundles/x.wfb" },
    platforms: ["linux"],
    stepKindCounts: { command: 1 },
    commands: [],
    warning: "Commands run with your user's authority.",
  },
  compositionFindings: [],
};

function oneBundle(): BundleCatalogView {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles: [BUNDLE] },
  });
  return {
    openList: () => list,
    openFocus: (selector) => {
      const [snapshot] = createSignal<BundleFocusSnapshot>({
        family: "bundle-catalog",
        view: "focus",
        selection: selector,
        result: { found: true, bundle: BUNDLE },
      });
      return snapshot;
    },
  };
}

/** A launch seam that settles immediately into the Run's Workbench. */
function launchTo(runId: string): RunLaunchView {
  return {
    launch: () => () => ({ kind: "launched", runId, state: "running" }),
  };
}

// --- a hand-driven Run Workbench read seam ---------------------------------

function refKey(reference: ResourceReference | DiagnosticReference): string {
  return reference.type === "diagnostic"
    ? `d:${reference.diagnosticId}`
    : reference.artifactName;
}

function makeRunView(initial: RunSnapshot) {
  const [snapshot, setSnapshot] = createSignal<RunSnapshot>(initial);
  const reads = new Map<string, ResourceRead>();
  const view: RunWorkbenchView = {
    openRun: () => snapshot,
    readResource: (reference) =>
      reads.get(refKey(reference)) ?? {
        found: false,
        problem: {
          code: "resource-gone",
          explanation: "The referenced bytes are gone.",
          remediation: "Re-run to reproduce the output.",
          possibleEffects: "none",
        },
      },
  };
  return {
    view,
    setRun: (run: RunView) =>
      setSnapshot({
        family: "run",
        runId: run.runId,
        result: { found: true, run },
      }),
    setSnapshot,
    setRead: (key: string, read: ResourceRead) => reads.set(key, read),
  };
}

function snapshotOf(run: RunView): RunSnapshot {
  return { family: "run", runId: run.runId, result: { found: true, run } };
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
    workspacePath: over.workspacePath ?? "/tmp/ws",
    launchedAt: over.launchedAt ?? "2026-01-01T00:00:00.000Z",
    state: over.state ?? "running",
    progress: over.progress ?? [],
    position: over.position ?? 0,
    timeline: over.timeline ?? [],
    outputs: over.outputs ?? [],
    ...(over.checkpoint !== undefined ? { checkpoint: over.checkpoint } : {}),
    ...(over.conflict !== undefined ? { conflict: over.conflict } : {}),
    actionOffers: over.actionOffers ?? [],
  };
}

function events(count: number): RunTimelineEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    at: `T${String(index).padStart(3, "0")}`,
    event: "attempt-settled",
    detail: `e${index}`,
  }));
}

// Mount the App and walk Home → Start a Run → launch → the Workbench. The wizard
// screens read the real terminal + keymap (mockInput); the Workbench reads the
// injected fake Renderer Port, which we then drive with `renderer.key`.
async function mountApp(
  control: ReturnType<typeof makeRunView>,
  renderer: ReturnType<typeof makeRenderer>,
  launchRunId: string,
  width: number,
  height: number,
) {
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace()}
        bundles={oneBundle()}
        launch={launchTo(launchRunId)}
        run={control.view}
        renderer={renderer.port}
        exit={(reason) => exits.push(reason)}
      />
    ),
    { width, height },
  );
  await t.waitForFrame((f) => f.includes("Secant"));
  t.mockInput.pressArrow("down"); // Home: select Start a Run
  t.mockInput.pressEnter();
  await t.waitForFrame((f) => f.includes("esc back")); // chooser
  t.mockInput.pressEnter(); // trusted + no inputs → Review
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter(); // Start → launch → Workbench
  return { t, exits };
}

async function mountWorkbench(run: RunView, width = 100, height = 40) {
  const control = makeRunView(snapshotOf(run));
  const renderer = makeRenderer(width, height);
  const { t, exits } = await mountApp(
    control,
    renderer,
    run.runId,
    width,
    height,
  );
  await t.waitForFrame((f) => f.includes("Timeline"));
  return { t, control, renderer, exits };
}

async function press(
  t: { renderOnce: () => Promise<void> },
  renderer: ReturnType<typeof makeRenderer>,
  name: string,
  mods: { ctrl?: boolean } = {},
) {
  renderer.key(name, mods);
  await t.renderOnce();
}

function noOverflow(frame: string, width: number) {
  for (const line of frame.split("\n")) {
    assert.ok(
      line.trimEnd().length <= width,
      `overflow at ${width}: ${JSON.stringify(line)}`,
    );
  }
}

const PROGRESS: RunStepProgress[] = [
  { id: "plan", kind: "agent", status: "succeeded" },
  { id: "build", kind: "command", status: "running" },
  { id: "ship", kind: "command", status: "pending" },
];

// --- rendering (AC1) -------------------------------------------------------

test("header, progress, and timeline render the facts headless run show prints", async () => {
  const { t } = await mountWorkbench(
    runOf({
      runId: "run-77",
      state: "running",
      progress: PROGRESS,
      position: 1,
      timeline: [
        { at: "2026-01-01T00:00:00.000Z", event: "run-created" },
        {
          at: "2026-01-01T00:01:00.000Z",
          event: "attempt-settled",
          detail: "passed",
        },
      ],
    }),
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /Alpha Flow/); // Bundle name
  assert.match(frame, /run-77/); // Run id
  assert.match(frame, /RUNNING/); // state in words
  assert.match(frame, /plan/); // every progress step, always visible
  assert.match(frame, /build/);
  assert.match(frame, /ship/);
  assert.match(frame, /run-created/); // timeline events with detail
  assert.match(frame, /attempt-settled passed/);
});

test("the details panel toggles and shows identity, position, and resources", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      runId: "run-9",
      progress: PROGRESS,
      position: 1,
      outputs: [
        {
          name: "report",
          type: "text",
          reference: {
            runId: "run-9",
            artifactName: "report",
            versionId: "v1",
            type: "text",
          },
        },
      ],
    }),
  );
  assert.doesNotMatch(t.captureCharFrame(), /Workspace:/); // closed by default
  await press(t, renderer, "d");
  const frame = t.captureCharFrame();
  assert.match(frame, /Details/);
  assert.match(frame, /dev\.alpha@1\.0\.0/); // identity
  assert.match(frame, /sha256:abc123/);
  assert.match(frame, /Workspace: \/tmp\/ws/);
  assert.match(frame, /step 2 of 3/); // position
  assert.match(frame, /report \(text\)/); // a resource to open
});

test("a blocked Run shows a waiting-for-review note and the checkpoint facts", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      state: "blocked",
      progress: PROGRESS,
      position: 1,
      checkpoint: {
        message: "Review the batch",
        interval: 3,
        completedIterations: 6,
        latestVerdict: {
          name: "done",
          value: "fail",
          reference: {
            runId: "run-1",
            artifactName: "done",
            versionId: "v3",
            type: "verdict",
          },
        },
        gate: {
          runId: "run-1",
          stepId: "work",
          attemptId: "a9",
          shape: "approve-reject",
        },
      },
    }),
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /BLOCKED/);
  assert.match(frame, /waiting for review/);
  assert.match(frame, /Review the batch/);
  await press(t, renderer, "d");
  assert.match(t.captureCharFrame(), /checkpoint verdict: done = fail/);
});

// --- live updates + timeline mechanics (AC2, AC3) --------------------------

test("the timeline follows the live edge as durable updates append events", async () => {
  const { t, control } = await mountWorkbench(
    runOf({ timeline: events(6) }),
    100,
    16,
  );
  const first = t.captureCharFrame();
  assert.match(first, /\(live\)/);
  assert.match(first, / e5/); // newest visible
  control.setRun(runOf({ timeline: events(9) }));
  await t.renderOnce();
  assert.match(t.captureCharFrame(), / e8/); // followed to the newest
});

test("scrolling up anchors the first visible row, counts new activity, and jump-to-latest returns to the live edge", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: events(30) }),
    100,
    14,
  );
  await press(t, renderer, "up");
  await press(t, renderer, "up");
  const scrolled = t.captureCharFrame();
  const topLine = scrolled.split("\n").find((line) => / e\d/.test(line));
  assert.ok(topLine, "a timeline row is visible");
  assert.doesNotMatch(scrolled, /\(live\)/); // no longer following

  // New events append; the first visible row stays anchored and the count grows.
  control.setRun(runOf({ timeline: events(36) }));
  await t.renderOnce();
  const anchored = t.captureCharFrame();
  assert.equal(
    anchored.split("\n").find((line) => / e\d/.test(line)),
    topLine,
    "first visible row anchored under append",
  );
  assert.match(anchored, /\d+ new/); // a new-activity badge

  await press(t, renderer, "end"); // jump to the live edge
  const live = t.captureCharFrame();
  assert.match(live, /\(live\)/);
  assert.match(live, / e35/); // the newest event
  assert.doesNotMatch(live, /new · end to jump/);
});

test("timeline paging is wired: home reaches the oldest event, end returns to the live edge", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ timeline: events(30) }),
    100,
    14,
  );
  assert.match(t.captureCharFrame(), /\(live\)/);
  await press(t, renderer, "pageup"); // detaches from the live edge
  assert.doesNotMatch(t.captureCharFrame(), /\(live\)/);
  await press(t, renderer, "home"); // jump to the oldest
  assert.match(t.captureCharFrame(), / e0 /);
  await press(t, renderer, "end"); // back to the live edge
  const live = t.captureCharFrame();
  assert.match(live, /\(live\)/);
  assert.match(live, / e29/);
});

test("an empty timeline shows the no-activity placeholder", async () => {
  const { t } = await mountWorkbench(runOf({ timeline: [] }));
  assert.match(t.captureCharFrame(), /no activity yet/);
});

test("pressing d again closes the details panel and returns focus to the timeline", async () => {
  const { t, renderer } = await mountWorkbench(runOf({ timeline: events(4) }));
  await press(t, renderer, "d");
  assert.match(t.captureCharFrame(), /› Details/);
  await press(t, renderer, "d"); // toggle it back off
  assert.doesNotMatch(t.captureCharFrame(), /Workspace:/);
  assert.match(t.captureCharFrame(), /› Timeline/);
});

test("on a terminal too short for the panel, d does not open a clipped details panel", async () => {
  // Wide enough across, but too few rows for DETAILS_HEIGHT plus a timeline row.
  const { t, renderer } = await mountWorkbench(
    runOf({ progress: PROGRESS, timeline: events(6) }),
    100,
    9,
  );
  await press(t, renderer, "d");
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /Workspace:/); // panel stayed hidden
  noOverflow(frame, 100);
});

// --- reference inspection (AC4) --------------------------------------------

test("opening a large text output shows bounded content with a truncation marker and scrolls", async () => {
  const run = runOf({
    outputs: [
      {
        name: "log",
        type: "text",
        reference: {
          runId: "run-1",
          artifactName: "log",
          versionId: "v1",
          type: "text",
        },
      },
    ],
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 30);
  const big = Array.from({ length: 900 }, (_, i) => `line-${i}`).join("\n");
  control.setRead("log", { found: true, type: "text", content: big });

  await press(t, renderer, "d"); // focus details
  await press(t, renderer, "return"); // open the selected (log) reference
  const opened = t.captureCharFrame();
  assert.match(opened, /log \(text\)/); // inspection title
  assert.match(opened, /line-0/); // top of the content
  assert.doesNotMatch(opened, /line-800/); // bounded — not everything inlined

  for (let i = 0; i < 3; i++) await press(t, renderer, "pagedown");
  assert.match(t.captureCharFrame(), /line-\d\d/);

  await press(t, renderer, "end");
  assert.match(t.captureCharFrame(), /output truncated/); // explicit marker

  await press(t, renderer, "escape");
  assert.doesNotMatch(t.captureCharFrame(), /output truncated/);
  assert.match(t.captureCharFrame(), /Details/);
});

test("a Verdict and a diagnostic open through their references", async () => {
  const run = runOf({
    state: "halted",
    outputs: [
      {
        name: "grade",
        type: "verdict",
        reference: {
          runId: "run-1",
          artifactName: "grade",
          versionId: "v1",
          type: "verdict",
        },
      },
    ],
    conflict: {
      artifactName: "out.txt",
      path: "out.txt",
      reference: { runId: "run-1", diagnosticId: "diag-1", type: "diagnostic" },
    },
  });
  const { t, control, renderer } = await mountWorkbench(run, 100, 30);
  control.setRead("grade", { found: true, type: "verdict", content: "pass" });
  control.setRead("d:diag-1", {
    found: true,
    type: "diagnostic",
    content: "workspace copy of out.txt went missing",
  });

  await press(t, renderer, "d"); // details focus, first resource (grade) selected
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), /grade \(verdict\)/);
  assert.match(t.captureCharFrame(), /pass/);
  await press(t, renderer, "escape");

  await press(t, renderer, "down"); // select the diagnostic
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), /halt diagnostic: out\.txt/);
  assert.match(t.captureCharFrame(), /went missing/);
});

test("a missing reference surfaces its Problem rather than throwing", async () => {
  const run = runOf({
    outputs: [
      {
        name: "gone",
        type: "text",
        reference: {
          runId: "run-1",
          artifactName: "gone",
          versionId: "v1",
          type: "text",
        },
      },
    ],
  });
  const { t, renderer } = await mountWorkbench(run, 100, 30);
  await press(t, renderer, "d");
  await press(t, renderer, "return");
  assert.match(t.captureCharFrame(), /resource-gone/);
});

// --- focus + Escape (AC5) --------------------------------------------------

test("focus moves timeline → details → timeline, and Escape leaves the Workbench for Home", async () => {
  const { t, renderer } = await mountWorkbench(runOf({ timeline: events(4) }));
  assert.match(t.captureCharFrame(), /› Timeline/); // focus glyph on the timeline
  await press(t, renderer, "d"); // open + focus details
  assert.match(t.captureCharFrame(), /› Details/);
  await press(t, renderer, "tab"); // back to the timeline
  assert.match(t.captureCharFrame(), /› Timeline/);
  await press(t, renderer, "escape"); // leaves the Workbench
  assert.match(t.captureCharFrame(), /Secant/); // back on Home
  assert.doesNotMatch(t.captureCharFrame(), /Timeline/);
});

test("q and Ctrl+C quit from the Workbench", async () => {
  const first = await mountWorkbench(runOf());
  await press(first.t, first.renderer, "q");
  assert.equal(first.exits.length, 1);

  const second = await mountWorkbench(runOf());
  await press(second.t, second.renderer, "c", { ctrl: true });
  assert.equal(second.exits.length, 1);
});

// --- layout (AC6) ----------------------------------------------------------

test("small width hides the details panel first, then compacts the header, without overflow", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ progress: PROGRESS, timeline: events(6) }),
    100,
    30,
  );
  await press(t, renderer, "d");
  assert.match(t.captureCharFrame(), /Details/);
  assert.match(t.captureCharFrame(), /Alpha Flow/);

  // Below the details breakpoint the panel is gone though it was toggled on.
  renderer.resize(50, 30);
  await t.renderOnce();
  const narrow = t.captureCharFrame();
  assert.doesNotMatch(narrow, /Workspace:/);
  assert.match(narrow, /Alpha Flow/); // header still full here
  noOverflow(narrow, 50);

  // Below the header breakpoint the header compacts to the Run id + state line.
  renderer.resize(34, 30);
  await t.renderOnce();
  const tiny = t.captureCharFrame();
  assert.doesNotMatch(tiny, /Alpha Flow/); // bundle name dropped
  assert.match(tiny, /run-1/);
  noOverflow(tiny, 34);
});

test("resize relayouts the timeline without overflow and keeps every state readable without colour", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "failed", progress: PROGRESS, timeline: events(20) }),
    90,
    24,
  );
  noOverflow(t.captureCharFrame(), 90);
  assert.match(t.captureCharFrame(), /FAILED/); // word, not just colour
  renderer.resize(60, 18);
  await t.renderOnce();
  noOverflow(t.captureCharFrame(), 60);
  assert.match(t.captureCharFrame(), /FAILED/);
});

// --- not found -------------------------------------------------------------

test("a Run that is not found shows the Problem and Escape leaves", async () => {
  const control = makeRunView({
    family: "run",
    runId: "ghost",
    result: {
      found: false,
      problem: {
        code: "run-not-found",
        explanation: "No such Run.",
        remediation: "Run `secant run list`.",
        possibleEffects: "none",
      },
    },
  });
  const renderer = makeRenderer(80, 24);
  const { t } = await mountApp(control, renderer, "ghost", 80, 24);
  await t.waitForFrame((f) => f.includes("not found"));
  assert.match(t.captureCharFrame(), /No such Run/);
  await press(t, renderer, "escape");
  assert.match(t.captureCharFrame(), /Secant/); // back on Home
});
