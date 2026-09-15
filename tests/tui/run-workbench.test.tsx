import assert from "node:assert/strict";
import { test } from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { App } from "../../src/tui/tui.js";
import { inertRunActionsView, inertRunListView } from "./inert.js";
import type {
  AnswerOutcome,
  BundleCatalogView,
  RunActionsView,
  RunLaunchView,
  RunWorkbenchView,
  WorkspaceView,
} from "../../src/tui/tui.js";
import type {
  RendererKeyEvent,
  RendererPort,
} from "../../src/tui/renderer/renderer.js";
import type {
  AnswerHumanGateOffer,
  BundleCatalogSnapshot,
  BundleFocusSnapshot,
  DiagnosticReference,
  InstalledBundleFocus,
  ResourceRead,
  ResourceReference,
  RunCheckpointView,
  RunGateReference,
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
  const keys = new Set<(event: RendererKeyEvent) => void>();
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
  // The answer seam is hand-driven: `answer` records the dispatch and returns the
  // outcome accessor a test advances (pending → applied/refused), so the tests
  // exercise the controls-unavailable-while-pending and refusal paths (#92).
  const [answerOutcome, setAnswerOutcome] = createSignal<AnswerOutcome>({
    kind: "pending",
  });
  const answers: {
    gate: RunGateReference;
    answer: "continue" | "stop";
  }[] = [];
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
    answer: (gate, answer) => {
      answers.push({ gate, answer });
      return answerOutcome;
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
    answers,
    setAnswerOutcome,
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

// --- blocked-Run fixtures (#92) --------------------------------------------

const GATE: RunGateReference = {
  runId: "run-1",
  stepId: "work",
  attemptId: "a9",
  shape: "approve-reject",
};

const ANSWER_OFFER: AnswerHumanGateOffer = {
  action: "answer-human-gate",
  gate: GATE,
  continueConsequence:
    "continue: grant one more review interval and resume the Run.",
  stopConsequence:
    "stop: end the Run failed, keeping its history and Artifacts.",
};

function checkpointOf(
  over: Partial<RunCheckpointView> = {},
): RunCheckpointView {
  return {
    message: over.message ?? "Review the batch",
    interval: over.interval ?? 3,
    completedIterations: over.completedIterations ?? 3,
    latestVerdict: over.latestVerdict ?? {
      name: "done",
      value: "fail",
      reference: {
        runId: "run-1",
        artifactName: "done",
        versionId: "v3",
        type: "verdict",
      },
    },
    gate: over.gate ?? GATE,
  };
}

/** A blocked Run resting at a Review checkpoint with the live answer offer. */
function blockedRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "blocked",
    progress: PROGRESS,
    position: 1,
    checkpoint: checkpointOf(),
    actionOffers: [ANSWER_OFFER],
    ...over,
  });
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
  actions?: RunActionsView,
) {
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace()}
        bundles={oneBundle()}
        launch={launchTo(launchRunId)}
        run={control.view}
        runList={inertRunListView()}
        actions={actions ?? inertRunActionsView()}
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

async function mountWorkbench(
  run: RunView,
  width = 100,
  height = 40,
  actions?: RunActionsView,
) {
  const control = makeRunView(snapshotOf(run));
  const renderer = makeRenderer(width, height);
  const { t, exits } = await mountApp(
    control,
    renderer,
    run.runId,
    width,
    height,
    actions,
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

test("launching transitions to the Workbench before the Run rests, and progress rows appear while a Step runs", async () => {
  // Launch resolves at admission (S1): the App walks Start a Run → launch and lands
  // on the Workbench with the Run still running and no activity yet — before it
  // rests. The read seam is a deferred fake: a durable update then appends timeline
  // rows while a Step runs, and they appear live without leaving the Workbench.
  const control = makeRunView(
    snapshotOf(
      runOf({
        state: "running",
        progress: PROGRESS,
        position: 1,
        timeline: [],
      }),
    ),
  );
  const renderer = makeRenderer(100, 20);
  const { t } = await mountApp(control, renderer, "run-1", 100, 20);
  await t.waitForFrame((f) => f.includes("Timeline"));
  assert.match(t.captureCharFrame(), /RUNNING/); // reached the Workbench, still live
  assert.match(t.captureCharFrame(), /no activity yet/); // the Run has not rested
  // A Step runs: durable progress lands and follows the live edge into view.
  control.setRun(
    runOf({
      state: "running",
      progress: PROGRESS,
      position: 1,
      timeline: events(3),
    }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, / e2/); // the newest row appeared while running
  assert.match(frame, /\(live\)/);
});

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

test("captured output with colour escapes and carriage returns renders without them", async () => {
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
  // A command forcing colour with CRLF line endings: SGR escapes plus `\r\n` (D4).
  const raw = "[31mred line[0m\r\nplain line\r\n[1mbold line[0m";
  control.setRead("log", { found: true, type: "text", content: raw });

  await press(t, renderer, "d"); // focus details
  await press(t, renderer, "return"); // open the log reference
  const frame = t.captureCharFrame();
  assert.ok(!frame.includes("["), "no escape sequences survive");
  assert.ok(!frame.includes("\r"), "no carriage returns survive");
  // Split on /\r?\n/: each CRLF started a fresh row, so all three read cleanly.
  assert.match(frame, /red line/);
  assert.match(frame, /plain line/);
  assert.match(frame, /bold line/);
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

test("a halted Run shows the materialization conflict path as a top-level line, at 40 columns", async () => {
  const run = runOf({
    state: "halted",
    conflict: {
      artifactName: "out.txt",
      path: "sub/out.txt",
      reference: { runId: "run-1", diagnosticId: "d1", type: "diagnostic" },
    },
  });
  const { t, renderer } = await mountWorkbench(run, 100, 30);
  // The Workspace path to restore is a top-level line, not only a details-panel
  // row reachable at width ≥ 60 (A13).
  assert.match(t.captureCharFrame(), /restore sub\/out\.txt/);
  renderer.resize(40, 24);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /restore sub\/out\.txt/); // still shown at 40 columns
  noOverflow(frame, 40);
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

// --- Review checkpoint interaction (#92) -----------------------------------

test("a blocked Run shows the checkpoint interaction in place of the footer, with the facts and evidence", async () => {
  const { t } = await mountWorkbench(
    blockedRunOf({
      checkpoint: checkpointOf({
        message: "Ship it?",
        interval: 3,
        completedIterations: 6,
      }),
      outputs: [
        {
          name: "report",
          type: "text",
          reference: {
            runId: "run-1",
            artifactName: "report",
            versionId: "v1",
            type: "text",
          },
        },
      ],
    }),
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /Review checkpoint/);
  assert.match(frame, /every 3 iteration\(s\)/); // cadence
  assert.match(frame, /6 completed/); // completed-iteration count
  assert.match(frame, /Ship it\?/); // the authored message
  assert.match(frame, /latest: done = fail/); // the latest fail Verdict
  assert.match(frame, /Continue 3 More Iterations/); // control names the count
  assert.match(frame, /Stop Run/);
  assert.match(frame, /report/); // evidence: the output link
  assert.match(frame, /enter confirm/); // the interaction's own hints
  assert.doesNotMatch(frame, /d details · end latest/); // footer was replaced
});

test("a non-blocked Run shows no checkpoint control and keeps its footer", async () => {
  const { t } = await mountWorkbench(runOf({ timeline: events(3) }));
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /Review checkpoint/);
  assert.doesNotMatch(frame, /More Iterations/);
  assert.match(frame, /d details/); // footer present
});

test("a checkpoint without a live answer offer shows no controls", async () => {
  const { t } = await mountWorkbench(
    runOf({ state: "blocked", checkpoint: checkpointOf(), actionOffers: [] }),
  );
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /More Iterations/); // no control lacks an offer
  assert.match(frame, /waiting for review/); // the blocked note still shows
});

test("Continue dispatches answer-human-gate continue against the snapshot's gate, with the granted count in the label", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  // Focus lands on the interaction with Continue selected by default.
  assert.match(t.captureCharFrame(), /› \[ Continue 3 More Iterations \]/);
  await press(t, renderer, "return");
  assert.equal(control.answers.length, 1);
  assert.equal(control.answers[0]?.answer, "continue");
  assert.deepEqual(control.answers[0]?.gate, GATE);
});

test("Stop dispatches answer-human-gate stop against the snapshot's gate", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  await press(t, renderer, "right"); // select Stop
  assert.match(t.captureCharFrame(), /› \[ Stop Run \]/);
  await press(t, renderer, "return");
  assert.equal(control.answers.length, 1);
  assert.equal(control.answers[0]?.answer, "stop");
  assert.deepEqual(control.answers[0]?.gate, GATE);
});

test("the controls are unavailable while the answer is pending and gone once it applies", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  control.setAnswerOutcome({ kind: "pending" });
  await press(t, renderer, "return"); // dispatch continue
  await t.renderOnce();
  assert.equal(control.answers.length, 1);
  assert.match(t.captureCharFrame(), /submitting your answer/);
  assert.match(t.captureCharFrame(), /unavailable/);
  // A second confirm while pending dispatches nothing.
  await press(t, renderer, "return");
  assert.equal(control.answers.length, 1);
  // Applied: the live snapshot leaves blocked and the interaction disappears.
  control.setAnswerOutcome({ kind: "applied" });
  control.setRun(
    runOf({ state: "running", timeline: events(2), actionOffers: [] }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /Review checkpoint/);
  assert.match(frame, /d details/); // footer returned
});

test("a refused answer surfaces its Problem and re-enables the controls", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  control.setAnswerOutcome({
    kind: "refused",
    problem: {
      code: "gate-stale",
      explanation: "The Gate moved on.",
      remediation: "Re-open the Run.",
      possibleEffects: "none",
    },
  });
  await press(t, renderer, "return");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /refused: The Gate moved on/);
  assert.doesNotMatch(frame, /unavailable/); // controls available again
});

test("a Run that blocks again after a granted interval shows the interaction with the advanced count", async () => {
  const { t, control, renderer } = await mountWorkbench(
    blockedRunOf({ checkpoint: checkpointOf({ completedIterations: 3 }) }),
  );
  assert.match(t.captureCharFrame(), /3 completed/);
  await press(t, renderer, "return"); // continue
  control.setAnswerOutcome({ kind: "applied" });
  control.setRun(
    runOf({ state: "running", timeline: events(4), actionOffers: [] }),
  );
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /Review checkpoint/);
  // It blocks again after the granted interval, with an advanced count.
  control.setRun(
    blockedRunOf({ checkpoint: checkpointOf({ completedIterations: 6 }) }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /Review checkpoint/);
  assert.match(frame, /6 completed/);
});

test("a re-block at a fresh Gate resets the control to Continue and clears a prior refusal", async () => {
  const { t, control, renderer } = await mountWorkbench(blockedRunOf());
  // Select Stop and dispatch; the answer is refused (the Gate moved on).
  control.setAnswerOutcome({
    kind: "refused",
    problem: {
      code: "gate-stale",
      explanation: "The Gate moved on.",
      remediation: "Re-open the Run.",
      possibleEffects: "none",
    },
  });
  await press(t, renderer, "right"); // select Stop
  await press(t, renderer, "return");
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /refused: The Gate moved on/);
  assert.match(t.captureCharFrame(), /› \[ Stop Run \]/); // Stop still selected

  // The Run runs on, then re-blocks at a *fresh* Gate (a different Attempt).
  control.setRun(
    runOf({ state: "running", timeline: events(2), actionOffers: [] }),
  );
  await t.renderOnce();
  control.setRun(
    blockedRunOf({
      checkpoint: checkpointOf({
        gate: { ...GATE, attemptId: "a10" },
        completedIterations: 6,
      }),
    }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /Review checkpoint/);
  assert.match(frame, /6 completed/); // the advanced count
  assert.doesNotMatch(frame, /refused/); // the stale refusal is gone
  assert.match(frame, /› \[ Continue 3 More Iterations \]/); // reset to Continue
});

test("Stop leaves the Run failed with its timeline and Artifacts still browsable", async () => {
  const { t, control, renderer } = await mountWorkbench(
    blockedRunOf({ timeline: events(3) }),
  );
  await press(t, renderer, "right"); // Stop
  await press(t, renderer, "return");
  control.setAnswerOutcome({ kind: "applied" });
  control.setRun(
    runOf({
      state: "failed",
      timeline: events(3),
      outputs: [
        {
          name: "report",
          type: "text",
          reference: {
            runId: "run-1",
            artifactName: "report",
            versionId: "v1",
            type: "text",
          },
        },
      ],
      actionOffers: [],
    }),
  );
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /FAILED/);
  assert.doesNotMatch(frame, /Review checkpoint/);
  assert.match(frame, / e0/); // the timeline is intact
  await press(t, renderer, "d"); // Artifacts still browsable
  assert.match(t.captureCharFrame(), /report \(text\)/);
});

test("focus lands on the checkpoint when it appears, tabs to the timeline, and returns when it leaves", async () => {
  const { t, control, renderer } = await mountWorkbench(
    blockedRunOf({ timeline: events(4) }),
  );
  assert.match(t.captureCharFrame(), /› Review checkpoint/); // focus on the interaction
  await press(t, renderer, "tab"); // to the timeline
  assert.match(t.captureCharFrame(), /› Timeline/);
  await press(t, renderer, "tab"); // wraps back to the checkpoint
  assert.match(t.captureCharFrame(), /› Review checkpoint/);
  // When it leaves, focus returns to the timeline.
  control.setAnswerOutcome({ kind: "applied" });
  control.setRun(
    runOf({ state: "failed", timeline: events(4), actionOffers: [] }),
  );
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /› Timeline/);
});

test("the checkpoint interaction fits small widths without overflow and states both consequences without colour", async () => {
  const { t, renderer } = await mountWorkbench(blockedRunOf(), 100, 30);
  let frame = t.captureCharFrame();
  noOverflow(frame, 100);
  assert.match(frame, /grant one more review interval/); // continue consequence, plain text
  assert.match(frame, /end the Run failed/); // stop consequence, plain text
  renderer.resize(40, 24);
  await t.renderOnce();
  frame = t.captureCharFrame();
  noOverflow(frame, 40);
  assert.match(frame, /Continue 3 More Iterations/); // controls still readable
  assert.match(frame, /Stop Run/);
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

// --- Run Actions: resume / cancel / delete (#92 ticket, AC3) ---------------

const RESUME_OFFER = {
  action: "resume-run" as const,
  runId: "run-1",
  consequence: "resume: continue from the Step the Run stopped at.",
};
const CANCEL_OFFER = {
  action: "cancel-run" as const,
  runId: "run-1",
  consequence: "end the live Run cancelled, keeping its history and Artifacts.",
};
const DELETE_OFFER = {
  action: "delete-run" as const,
  runId: "run-1",
  consequence: "remove the Run and its stored history and Artifacts from disk.",
};

function okActions(over: Partial<RunActionsView> = {}): RunActionsView {
  return {
    resume: () => () => ({ kind: "ok" }),
    cancel: () => () => ({ kind: "ok" }),
    remove: () => () => ({ kind: "ok" }),
    ...over,
  };
}

test("Run Actions render only when offered, with the consequence and shortcut", async () => {
  const { t } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_OFFER, DELETE_OFFER] }),
    100,
    40,
    okActions(),
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /r resume — resume: continue from the Step/);
  assert.match(frame, /x delete — remove the Run/);
  assert.doesNotMatch(frame, /c cancel/); // not offered while resting
});

test("no Actions section is shown when the Run offers none", async () => {
  const { t } = await mountWorkbench(runOf({ actionOffers: [] }));
  assert.doesNotMatch(t.captureCharFrame(), /Actions:/);
});

test("resume dispatches and the Workbench follows into the running Run", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "halted", actionOffers: [RESUME_OFFER] })),
  );
  const renderer = makeRenderer(100, 40);
  const actions = okActions({
    resume: () => {
      // Production drives the Run and the read seam observes it; model that here:
      // the dispatch settles at once and the snapshot advances to running.
      control.setRun(runOf({ state: "running", actionOffers: [CANCEL_OFFER] }));
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("Timeline"));
  assert.match(t.captureCharFrame(), /r resume/);

  await press(t, renderer, "r");
  const frame = t.captureCharFrame();
  assert.match(frame, /RUNNING/); // transitioned into the running Workbench
  assert.match(frame, /c cancel/); // now offers cancel (live), not resume
  assert.doesNotMatch(frame, /r resume/);
});

test("delete confirms then dispatches and leaves the Workbench", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "failed", actionOffers: [DELETE_OFFER] })),
  );
  const renderer = makeRenderer(100, 40);
  let removed = 0;
  const actions = okActions({
    remove: () => {
      removed += 1;
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("x delete"));
  await press(t, renderer, "x"); // arm the confirmation
  assert.equal(removed, 0); // not dispatched yet
  assert.match(t.captureCharFrame(), /Delete is permanent/);
  await press(t, renderer, "y"); // confirm
  assert.equal(removed, 1);
  // Reached from Start a Run, so a delete returns to Home.
  assert.match(t.captureCharFrame(), /Secant/);
  assert.doesNotMatch(t.captureCharFrame(), /Timeline/);
});

test("Escape backs out of an armed delete without dispatching or leaving", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "failed", actionOffers: [DELETE_OFFER] })),
  );
  const renderer = makeRenderer(100, 40);
  let removed = 0;
  const actions = okActions({
    remove: () => {
      removed += 1;
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("x delete"));
  await press(t, renderer, "x"); // arm
  assert.match(t.captureCharFrame(), /Delete is permanent/);
  await press(t, renderer, "escape"); // back out
  assert.equal(removed, 0);
  assert.doesNotMatch(t.captureCharFrame(), /Delete is permanent/);
  assert.match(t.captureCharFrame(), /Timeline/); // still on the Workbench
});

test("cancel arms a confirmation and dispatches on y", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "running", actionOffers: [CANCEL_OFFER] })),
  );
  const renderer = makeRenderer(100, 40);
  let cancelled = 0;
  const actions = okActions({
    cancel: () => {
      cancelled += 1;
      control.setRun(
        runOf({ state: "cancelled", actionOffers: [DELETE_OFFER] }),
      );
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("c cancel"));
  await press(t, renderer, "c"); // arm
  assert.equal(cancelled, 0);
  assert.match(t.captureCharFrame(), /Cancel ends the Run/);
  await press(t, renderer, "y"); // confirm
  assert.equal(cancelled, 1);
  const frame = t.captureCharFrame();
  assert.match(frame, /CANCELLED/); // transitioned to the cancelled state
  assert.match(frame, /x delete/); // now offers delete, not cancel
  assert.doesNotMatch(frame, /c cancel/);
});

test("a refused action surfaces the reason without leaving", async () => {
  const actions = okActions({
    resume: () => () => ({
      kind: "refused",
      problem: {
        code: "run-live-elsewhere",
        explanation: "The Run is live in another process.",
        remediation: "Wait for it to rest, then retry.",
        possibleEffects: "none",
      },
    }),
  });
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_OFFER] }),
    100,
    40,
    actions,
  );
  await press(t, renderer, "r");
  const frame = t.captureCharFrame();
  assert.match(frame, /live in another process/); // the reason is shown
  assert.match(frame, /Timeline/); // still on the Workbench
});
