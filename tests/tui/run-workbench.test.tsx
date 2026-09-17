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
  EndInteractiveStepOffer,
  InstalledBundleFocus,
  ResourceRead,
  ResourceReference,
  RunLiveOverlay,
  RunCheckpointView,
  RunGateReference,
  ResumeRunOffer,
  RunSnapshot,
  RunStepProgress,
  RunTimelineEvent,
  RunView,
  SendInteractiveTurnOffer,
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
  const [live, setLive] = createSignal<RunLiveOverlay>();
  const [preview, setPreview] = createSignal<string>();
  const reads = new Map<string, ResourceRead>();
  // The answer seam is hand-driven: `answer` records the dispatch and returns the
  // outcome accessor a test advances (pending → applied/refused), so the tests
  // exercise the controls-unavailable-while-pending and refusal paths (#92).
  const [answerOutcome, setAnswerOutcome] = createSignal<AnswerOutcome>({
    kind: "pending",
  });
  // The three Workbench writes are hand-driven so tests advance each outcome
  // (pending → applied/refused) and assert the exact dispatch (#121).
  const [requestOutcome, setRequestOutcome] = createSignal<AnswerOutcome>({
    kind: "applied",
  });
  const [gateOutcome, setGateOutcome] = createSignal<AnswerOutcome>({
    kind: "applied",
  });
  const answers: {
    gate: RunGateReference;
    answer: "continue" | "stop";
  }[] = [];
  // The interactive seams are hand-driven too (#122): each records its dispatch and
  // returns the shared outcome accessor a test advances, so the tests exercise the
  // blank guard, the boundary-gated End Step, and the pending path.
  const [interactiveOutcome, setInteractiveOutcome] =
    createSignal<AnswerOutcome>({ kind: "pending" });
  const sends: { runId: string; stepId: string; text: string }[] = [];
  const ends: { runId: string; stepId: string }[] = [];
  const texts: { gate: RunGateReference; text: string }[] = [];
  const requests: {
    requestId: string;
    generation: number;
    decision: "allow" | "deny";
  }[] = [];
  const view: RunWorkbenchView = {
    openRun: () => ({ snapshot, live, preview }),
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
    sendInteractiveTurn: (runId, stepId, text) => {
      sends.push({ runId, stepId, text });
      return interactiveOutcome;
    },
    endInteractiveStep: (runId, stepId) => {
      ends.push({ runId, stepId });
      return interactiveOutcome;
    },
    answerText: (gate, text) => {
      texts.push({ gate, text });
      return gateOutcome;
    },
    answerRequest: (offer, decision) => {
      requests.push({
        requestId: offer.requestId,
        generation: offer.generation,
        decision,
      });
      return requestOutcome;
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
    setLive: (overlay: RunLiveOverlay | undefined) => {
      setLive(overlay);
      setPreview(overlay?.preview);
    },
    setPreview,
    setRead: (key: string, read: ResourceRead) => reads.set(key, read),
    answers,
    texts,
    requests,
    setAnswerOutcome,
    sends,
    ends,
    setInteractiveOutcome,
    setRequestOutcome,
    setGateOutcome,
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
    liveness: over.liveness ?? { state: "not-live" },
    progress: over.progress ?? [],
    position: over.position ?? 0,
    timeline: over.timeline ?? [],
    outputs: over.outputs ?? [],
    ...(over.checkpoint !== undefined ? { checkpoint: over.checkpoint } : {}),
    ...(over.pendingGate !== undefined
      ? { pendingGate: over.pendingGate }
      : {}),
    ...(over.conflict !== undefined ? { conflict: over.conflict } : {}),
    ...(over.sessions !== undefined ? { sessions: over.sessions } : {}),
    ...(over.effectiveModel !== undefined
      ? { effectiveModel: over.effectiveModel }
      : {}),
    ...(over.turnPosition !== undefined
      ? { turnPosition: over.turnPosition }
      : {}),
    ...(over.transcript !== undefined ? { transcript: over.transcript } : {}),
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

test("live Turn preview and activity join the durable timeline, then authoritative content replaces the preview", async () => {
  const { t, control } = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
      effectiveModel: "claude-sonnet-4-5",
      timeline: [{ at: "T000", event: "turn-started", detail: "repair" }],
    }),
    110,
    24,
  );

  control.setLive({
    runId: "run-1",
    generation: 2,
    phase: "working",
    outstanding: [],
    offers: [],
    activity: "Edit src/repair.ts",
    preview: "I am checking the failing assertion",
  });
  await t.renderOnce();
  const streaming = t.captureCharFrame();
  assert.match(streaming, /Claude Code/);
  assert.match(streaming, /model claude-sonnet-4-5/);
  assert.match(streaming, /Agent Turn · working/);
  assert.match(streaming, /Assistant preview · I am checking/);
  assert.match(streaming, /Activity · Edit src\/repair\.ts/);

  control.setRun(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "succeeded" }],
      effectiveModel: "claude-sonnet-4-5",
      timeline: [
        { at: "T000", event: "turn-started", detail: "repair" },
        {
          at: "T001",
          event: "assistant-content",
          detail: "The assertion is fixed.",
        },
        { at: "T002", event: "turn-settled", detail: "completed" },
      ],
    }),
  );
  control.setLive(undefined);
  await t.renderOnce();
  const settled = t.captureCharFrame();
  assert.doesNotMatch(settled, /Assistant preview/);
  assert.match(settled, /Assistant · The assertion is fixed\./);
  assert.match(settled, /Agent Turn settled · completed/);
});

test("context and usage appear only when the live overlay reports them", async () => {
  const { t, control } = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
    }),
  );
  control.setLive({
    runId: "run-1",
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /Context ·|Usage ·/);

  control.setLive({
    runId: "run-1",
    generation: 2,
    phase: "working",
    outstanding: [],
    offers: [],
    context: { usedTokens: 12_500, limitTokens: 200_000 },
    usage: "estimated $0.04",
  });
  await t.renderOnce();
  const observed = t.captureCharFrame();
  assert.match(observed, /Context · 12500 \/ 200000 tokens/);
  assert.match(observed, /Usage · estimated \$0\.04/);
});

test("durable tool activity keeps Projection order beneath the live Turn", async () => {
  const { t } = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
      timeline: [
        { at: "T000", event: "turn-started", detail: "repair" },
        { at: "T001", event: "tool-activity", detail: "Bash started" },
        { at: "T002", event: "tool-activity", detail: "Edit completed" },
        { at: "T003", event: "assistant-content", detail: "Done." },
      ],
    }),
  );
  const frame = t.captureCharFrame();
  const bash = frame.indexOf("Tool activity · Bash started");
  const edit = frame.indexOf("Tool activity · Edit completed");
  const assistant = frame.indexOf("Assistant · Done.");
  assert.ok(bash >= 0 && edit > bash && assistant > edit, frame);
});

test("preview-only updates render before a full live overlay exists", async () => {
  const { t, control } = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
    }),
  );
  control.setPreview("First streamed words");
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /Agent Turn · working/);
  assert.match(frame, /Assistant preview · First streamed words/);
});

test("live rows respect paused timeline following and contribute to the new-activity count", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: events(30) }),
    100,
    14,
  );
  await press(t, renderer, "up");
  const before = t.captureCharFrame();
  const topLine = before.split("\n").find((line) => / e\d/.test(line));
  assert.ok(topLine);

  control.setLive({
    runId: "run-1",
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
    preview: "new streamed content",
  });
  await t.renderOnce();
  const paused = t.captureCharFrame();
  assert.equal(
    paused.split("\n").find((line) => / e\d/.test(line)),
    topLine,
  );
  assert.match(paused, /\d+ new · end to jump/);

  await press(t, renderer, "end");
  const latest = t.captureCharFrame();
  assert.match(latest, /Assistant preview · new streamed content/);
  assert.match(latest, /\(live\)/);
});

test("gate, request, interactive Turn, and agent Turn have colour-independent labels", async () => {
  const gate = await mountWorkbench(
    runOf({
      state: "blocked",
      progress: [{ id: "approve", kind: "human-gate", status: "blocked" }],
      pendingGate: {
        gate: {
          runId: "run-1",
          stepId: "approve",
          attemptId: "a1",
          shape: "approve-reject",
        },
        message: "Approve the change?",
      },
    }),
  );
  assert.match(gate.t.captureCharFrame(), /BLOCKED · durable Human Gate/);
  assert.match(gate.t.captureCharFrame(), /Human Gate · Approve the change\?/);

  const request = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
    }),
  );
  request.control.setLive({
    runId: "run-1",
    generation: 3,
    phase: "awaiting-approval",
    outstanding: [
      {
        requestId: "req-1",
        tool: "Edit",
        input: '{"path":"src/a.ts"}',
        decisions: ["allow", "deny"],
      },
    ],
    offers: [],
  });
  await request.t.renderOnce();
  assert.match(
    request.t.captureCharFrame(),
    /BLOCKED · ephemeral Harness Request/,
  );
  assert.match(request.t.captureCharFrame(), /Harness Request · Edit/);
  assert.match(request.t.captureCharFrame(), /Agent Turn · awaiting approval/);

  const interactive = await mountWorkbench(
    runOf({
      state: "blocked",
      progress: [
        { id: "discuss", kind: "interactive-agent", status: "running" },
      ],
    }),
  );
  interactive.control.setLive({
    runId: "run-1",
    generation: 1,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await interactive.t.renderOnce();
  const interactiveFrame = interactive.t.captureCharFrame();
  assert.match(interactiveFrame, /BLOCKED · interactive Turn/);
  assert.match(interactiveFrame, /Interactive Turn · working/);
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

test("the Session transcript opens in the bounded inspection view and restores timeline focus", async () => {
  const longReply = Array.from(
    { length: 600 },
    (_, index) => `assistant-line-${index}`,
  ).join("\n");
  const { t, renderer } = await mountWorkbench(
    runOf({
      transcript: [
        { session: "repair", role: "user", content: "Fix the failing test" },
        { session: "repair", role: "assistant", content: longReply },
      ],
    }),
    100,
    24,
  );

  await press(t, renderer, "t");
  const opened = t.captureCharFrame();
  assert.match(opened, /Session transcript/);
  assert.match(opened, /User Turn · session repair/);
  assert.match(opened, /Fix the failing test/);
  assert.match(opened, /Assistant · session repair/);
  assert.doesNotMatch(opened, /assistant-line-599/);

  await press(t, renderer, "end");
  assert.match(t.captureCharFrame(), /output truncated/);
  await press(t, renderer, "escape");
  assert.match(t.captureCharFrame(), /› Timeline/);
});

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

test("small width compacts the header before hiding the details panel, without overflow", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ progress: PROGRESS, timeline: events(6) }),
    100,
    30,
  );
  await press(t, renderer, "d");
  assert.match(t.captureCharFrame(), /Details/);
  assert.match(t.captureCharFrame(), /Alpha Flow/);

  // The header compacts first while the inspection affordance remains available.
  renderer.resize(70, 30);
  await t.renderOnce();
  const compact = t.captureCharFrame();
  assert.match(compact, /Workspace:/);
  assert.doesNotMatch(compact, /Alpha Flow/);
  assert.match(compact, /Run run-1/);
  noOverflow(compact, 70);

  // Below the details breakpoint the panel is hidden too.
  renderer.resize(50, 30);
  await t.renderOnce();
  const narrow = t.captureCharFrame();
  assert.doesNotMatch(narrow, /Workspace:/);
  assert.doesNotMatch(narrow, /Alpha Flow/);
  assert.match(narrow, /Run run-1/);
  noOverflow(narrow, 50);
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

test("the header names whether the Run is live here or in another owner process", async () => {
  const here = await mountWorkbench(
    runOf({ liveness: { state: "live-here", ownerPid: 4101 } }),
  );
  assert.match(
    here.t.captureCharFrame(),
    /live in this instance \(process 4101\)/,
  );

  const elsewhere = await mountWorkbench(
    runOf({ liveness: { state: "live-elsewhere", ownerPid: 5202 } }),
  );
  assert.match(
    elsewhere.t.captureCharFrame(),
    /live in another instance \(process 5202\)/,
  );
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
    interrupt: () => () => ({ kind: "ok" }),
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

test("resume takeover asks once with the owner pid before dispatching the offered form", async () => {
  const takeover = {
    ...RESUME_OFFER,
    takeover: { ownerPid: 7331 },
  };
  let received: ResumeRunOffer | undefined;
  const { t, renderer } = await mountWorkbench(
    runOf({
      state: "running",
      liveness: { state: "live-elsewhere", ownerPid: 7331 },
      actionOffers: [takeover],
    }),
    100,
    40,
    okActions({
      resume: (offer) => {
        received = offer;
        return () => ({ kind: "ok" });
      },
    }),
  );

  await press(t, renderer, "r");
  assert.equal(received, undefined);
  assert.match(t.captureCharFrame(), /Take over from process 7331/);
  await press(t, renderer, "y");
  assert.deepEqual(received, takeover);
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

// --- interactive-agent turn-taking (#122) ----------------------------------

const SEND_OFFER: SendInteractiveTurnOffer = {
  action: "send-interactive-turn",
  runId: "run-1",
  stepId: "discuss",
  basis: "interactive Turn",
  consequence: "send the typed text as one human Turn in the Step's Session.",
};
const END_OFFER: EndInteractiveStepOffer = {
  action: "end-interactive-step",
  runId: "run-1",
  stepId: "discuss",
  consequence: "end the interactive Step succeeded and advance the Run.",
};

/** A Run blocked at an interactive-agent Step at a Turn boundary (send + end
 *  offered). Omit the offers via `actionOffers: []` to model a live Turn. */
function interactiveRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "blocked",
    progress: [{ id: "discuss", kind: "interactive-agent", status: "running" }],
    position: 0,
    actionOffers: [SEND_OFFER, END_OFFER],
    ...over,
  });
}

// --- Answer requests, gates, interrupt, and resume (#121) ------------------

/** A live overlay carrying one outstanding approval request and its answer Offer,
 *  both at `generation`. Answering targets the exact requestId/generation. */
function requestOverlay(generation = 3, requestId = "req-1"): RunLiveOverlay {
  return {
    runId: "run-1",
    generation,
    phase: "awaiting-approval",
    outstanding: [
      {
        requestId,
        tool: "Edit",
        input: '{"path":"src/fix.ts"}',
        decisions: ["allow", "deny"],
      },
    ],
    offers: [
      {
        action: "answer-harness-request",
        runId: "run-1",
        requestId,
        generation,
        decisions: ["allow", "deny"],
        basis: "ephemeral Harness Request",
      },
    ],
  };
}

/** A running Run whose Turn is live: it offers interrupt and (unavailable) steer,
 *  and cancel, exactly as the Application offers while a Turn runs (#118). */
const INTERRUPT_OFFER = {
  action: "interrupt-turn" as const,
  runId: "run-1",
  turnId: "turn-7",
  consequence: "stop this Turn and rest the Run halted (resumable).",
};
const STEER_OFFER = {
  action: "steer-turn" as const,
  runId: "run-1",
  turnId: "turn-7",
  available: false as const,
  reason: "Claude Code has no same-Turn steer",
};

function liveTurnRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "running",
    progress: [{ id: "repair", kind: "agent", status: "running" }],
    actionOffers: [INTERRUPT_OFFER, STEER_OFFER, CANCEL_OFFER],
    ...over,
  });
}

test("the interactive input takes the human's text and Enter sends one Turn (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  // Focus is on the input during the Step; the human's keystrokes accumulate.
  await press(wb.t, wb.renderer, "h");
  await press(wb.t, wb.renderer, "i");
  assert.match(wb.t.captureCharFrame(), /> hi/);

  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "hi" },
  ]);
});

test("a blank interactive Turn is not sent (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  // Enter with an empty draft sends nothing; a whitespace-only draft is the same.
  await press(wb.t, wb.renderer, "return");
  await press(wb.t, wb.renderer, "space");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends.length, 0);
});

test("End Step arms a confirmation and dispatches on y (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /End this interactive Step\?/);
  await press(wb.t, wb.renderer, "y");
  assert.deepEqual(wb.control.ends, [{ runId: "run-1", stepId: "discuss" }]);
});

test("Escape backs out of an armed End Step without dispatching (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.match(wb.t.captureCharFrame(), /End this interactive Step\?/);
  await press(wb.t, wb.renderer, "escape");
  assert.equal(wb.control.ends.length, 0);
  assert.doesNotMatch(wb.t.captureCharFrame(), /End this interactive Step\?/);
});

test("End Step is not offered mid-Turn (#122)", async () => {
  // No send/end offers means a Turn is live: End Step cannot arm and Enter sends
  // nothing, so the human waits (or interrupts) rather than ending mid-Turn.
  const wb = await mountWorkbench(interactiveRunOf({ actionOffers: [] }));
  const frame = wb.t.captureCharFrame();
  assert.match(frame, /a Turn is running/);
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.equal(wb.control.ends.length, 0);
  assert.doesNotMatch(wb.t.captureCharFrame(), /End this interactive Step\?/);
  await press(wb.t, wb.renderer, "a");
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.sends.length, 0);
});

test("a send refusal surfaces in the input and re-enables it (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await press(wb.t, wb.renderer, "h");
  await press(wb.t, wb.renderer, "return");
  wb.control.setInteractiveOutcome({
    kind: "refused",
    problem: {
      code: "interactive-turn-busy",
      explanation: "a Turn is already live",
      remediation: "wait for it",
      possibleEffects: "none",
    },
  });
  await wb.t.renderOnce();
  assert.match(wb.t.captureCharFrame(), /a Turn is already live/);
});

test("the interactive input reads without colour and fits a narrow terminal (#122)", async () => {
  const wb = await mountWorkbench(interactiveRunOf(), 48, 24);
  const frame = wb.t.captureCharFrame();
  // The Step and its controls read from glyphs and words, not colour.
  assert.match(frame, /BLOCKED · interactive Turn/);
  assert.match(frame, /Your Turn/);
  assert.match(frame, /enter send Turn · \^E end step/);
  noOverflow(frame, 48);
});

const FREE_TEXT_GATE: RunGateReference = {
  runId: "run-1",
  stepId: "ask",
  attemptId: "a1",
  shape: "free-text",
};
const FREE_TEXT_OFFER: AnswerHumanGateOffer = {
  action: "answer-human-gate",
  gate: FREE_TEXT_GATE,
  continueConsequence: "",
  stopConsequence: "",
  textConsequence: "publish the text as the gate's output and advance the Run.",
};
function freeTextRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "blocked",
    progress: [{ id: "ask", kind: "human-gate", status: "blocked" }],
    pendingGate: {
      gate: FREE_TEXT_GATE,
      message: "What is the ticket number?",
      outputArtifactName: "ticket",
    },
    actionOffers: [FREE_TEXT_OFFER],
    ...over,
  });
}

// Mount a running Run and put an outstanding request on the live overlay.
async function mountWithRequest(overlay: RunLiveOverlay = requestOverlay()) {
  const mounted = await mountWorkbench(runOf({ state: "running" }));
  mounted.control.setLive(overlay);
  await mounted.t.renderOnce();
  return mounted;
}

// AC1 --------------------------------------------------------------

test("an outstanding request renders the tool, input, and both decisions in place of the footer", async () => {
  const { t } = await mountWithRequest();
  const frame = t.captureCharFrame();
  assert.match(frame, /Harness Request · awaiting your approval/);
  assert.match(frame, /Tool: Edit/);
  assert.match(frame, /Input: \{"path":"src\/fix\.ts"\}/);
  assert.match(frame, /\[ Allow \]/);
  assert.match(frame, /\[ Deny \]/);
  assert.match(frame, /enter confirm · esc deny/);
  assert.doesNotMatch(frame, /d details · end latest/); // footer replaced
});

test("Enter confirms allow and dispatches answer-harness-request with the offer's id and generation", async () => {
  const { t, control, renderer } = await mountWithRequest(requestOverlay(5));
  assert.match(t.captureCharFrame(), /› \[ Allow \]/); // allow selected by default
  await press(t, renderer, "return");
  assert.equal(control.requests.length, 1);
  assert.deepEqual(control.requests[0], {
    requestId: "req-1",
    generation: 5,
    decision: "allow",
  });
});

test("→ selects deny and Enter dispatches the deny decision", async () => {
  const { t, control, renderer } = await mountWithRequest();
  await press(t, renderer, "right");
  assert.match(t.captureCharFrame(), /› \[ Deny \]/);
  await press(t, renderer, "return");
  assert.equal(control.requests[0]?.decision, "deny");
});

test("Esc denies the outstanding request", async () => {
  const { t, control, renderer } = await mountWithRequest();
  await press(t, renderer, "escape");
  assert.equal(control.requests.length, 1);
  assert.equal(control.requests[0]?.decision, "deny");
});

test("the request control vanishes when the Turn settles without an answer", async () => {
  const { t, control } = await mountWithRequest();
  assert.match(t.captureCharFrame(), /Harness Request · awaiting/);
  // The Turn ends (or is interrupted/lost): the ephemeral overlay is gone.
  control.setLive(undefined);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /awaiting your approval/);
  assert.match(frame, /d details/); // footer returned
});

test("the request is never re-asked: a later overlay with no outstanding clears the control", async () => {
  const { t, control } = await mountWithRequest();
  control.setLive({
    runId: "run-1",
    generation: 4,
    phase: "working",
    outstanding: [],
    offers: [],
  });
  await t.renderOnce();
  assert.doesNotMatch(t.captureCharFrame(), /awaiting your approval/);
});

// AC2 --------------------------------------------------------------

test("a stale answer is refused with the Problem inline and the current offer re-rendered", async () => {
  const { t, control, renderer } = await mountWithRequest(requestOverlay(3));
  control.setRequestOutcome({
    kind: "refused",
    problem: {
      code: "harness-request-stale",
      explanation: "The request moved on.",
      remediation: "Answer the current request.",
      possibleEffects: "none",
    },
  });
  await press(t, renderer, "return");
  await t.renderOnce();
  // The generation bumped under the user; the same requestId re-renders, and the
  // precise Problem shows inline while the control stays up.
  control.setLive(requestOverlay(4));
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /refused: The request moved on/);
  assert.match(frame, /\[ Allow \]/); // the current offer is still rendered
});

test("the controls are unavailable while a request answer is pending and dispatch nothing twice", async () => {
  const { t, control, renderer } = await mountWithRequest();
  control.setRequestOutcome({ kind: "pending" });
  await press(t, renderer, "return");
  await t.renderOnce();
  assert.equal(control.requests.length, 1);
  assert.match(t.captureCharFrame(), /relaying your decision/);
  assert.match(t.captureCharFrame(), /\(unavailable\)/);
  await press(t, renderer, "return"); // a second confirm while pending dispatches nothing
  assert.equal(control.requests.length, 1);
});

// AC3: free-text gate ----------------------------------------------

test("a free-text gate shows a text input in place of the footer", async () => {
  const { t } = await mountWorkbench(freeTextRunOf());
  const frame = t.captureCharFrame();
  assert.match(frame, /Human Gate · What is the ticket number\?/);
  assert.match(frame, /Answer published as: ticket/);
  assert.match(frame, /enter submit · esc back/);
  assert.doesNotMatch(frame, /d details · end latest/); // footer replaced
});

test("typing then Enter dispatches answer-human-gate with the typed text against the gate", async () => {
  const { t, control, renderer } = await mountWorkbench(freeTextRunOf());
  for (const ch of ["f", "i", "x", "space", "4", "2"])
    await press(t, renderer, ch);
  assert.match(t.captureCharFrame(), /> fix 42/); // buffer echoed with a caret
  await press(t, renderer, "return");
  assert.equal(control.texts.length, 1);
  assert.equal(control.texts[0]?.text, "fix 42");
  assert.deepEqual(control.texts[0]?.gate, FREE_TEXT_GATE);
});

test("an empty free-text submission is refused locally without dispatching", async () => {
  const { t, control, renderer } = await mountWorkbench(freeTextRunOf());
  await press(t, renderer, "return"); // nothing typed
  assert.equal(control.texts.length, 0);
  assert.match(t.captureCharFrame(), /cannot be empty/);
  // Backspace on an empty buffer stays empty and still refuses.
  await press(t, renderer, "backspace");
  await press(t, renderer, "return");
  assert.equal(control.texts.length, 0);
});

test("the free-text gate control fits small widths without overflow and reads without colour", async () => {
  const { t, renderer } = await mountWorkbench(freeTextRunOf(), 100, 30);
  noOverflow(t.captureCharFrame(), 100);
  renderer.resize(40, 24);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  noOverflow(frame, 40);
  assert.match(frame, /Human Gate/);
  assert.match(frame, /enter submit/);
});

// AC4: interrupt, steer, resume ------------------------------------

test("Steer renders as unavailable with the exact reason and has no dispatch", async () => {
  const { t, control, renderer } = await mountWorkbench(
    liveTurnRunOf(),
    100,
    40,
    okActions(),
  );
  assert.match(
    t.captureCharFrame(),
    /steer — unavailable · Claude Code has no same-Turn steer/,
  );
  // No key dispatches steer; the seam is never touched from the Workbench.
  await press(t, renderer, "s");
  assert.equal(control.requests.length, 0);
});

test("first Interrupt press arms the hint, second dispatches interrupt-turn, and the Workbench stays", async () => {
  let interrupted: typeof INTERRUPT_OFFER | undefined;
  const actions = okActions({
    interrupt: (offer) => {
      interrupted = offer;
      return () => ({ kind: "ok" });
    },
  });
  const { t, renderer } = await mountWorkbench(
    liveTurnRunOf(),
    100,
    40,
    actions,
  );
  assert.match(t.captureCharFrame(), /esc esc interrupt/); // the control is listed
  await press(t, renderer, "escape"); // arm
  assert.equal(interrupted, undefined);
  assert.match(t.captureCharFrame(), /Press esc again to interrupt/);
  await press(t, renderer, "escape"); // dispatch
  assert.deepEqual(interrupted, INTERRUPT_OFFER);
  assert.match(t.captureCharFrame(), /Timeline/); // did not leave the Workbench
});

test("an outstanding request hides the interrupt/steer controls and Esc denies rather than arming interrupt", async () => {
  // The interrupt/steer offers stand while a Turn is live even at awaiting-approval,
  // so without the modal guard the request control and the interrupt hint collide
  // over Esc. The request modal must own the bottom interaction.
  const { t, control, renderer } = await mountWorkbench(
    liveTurnRunOf(),
    100,
    40,
    okActions(),
  );
  control.setLive(requestOverlay());
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.match(frame, /awaiting your approval/);
  assert.doesNotMatch(frame, /esc esc interrupt/); // interrupt control suppressed
  assert.doesNotMatch(frame, /steer — unavailable/);
  await press(t, renderer, "escape"); // a single Esc denies, and never arms interrupt
  assert.equal(control.requests[0]?.decision, "deny");
  assert.doesNotMatch(t.captureCharFrame(), /Press esc again to interrupt/);
});

test("a request appearing disarms an already-armed interrupt so no stale hint lingers", async () => {
  const mounted = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions());
  await press(mounted.t, mounted.renderer, "escape"); // arm interrupt, no request yet
  assert.match(mounted.t.captureCharFrame(), /Press esc again to interrupt/);
  mounted.control.setLive(requestOverlay()); // a request takes over the interaction
  await mounted.t.renderOnce();
  const frame = mounted.t.captureCharFrame();
  assert.doesNotMatch(frame, /Press esc again to interrupt/); // disarmed and hidden
  assert.match(frame, /awaiting your approval/);
});

test("any other key cancels an armed Interrupt without dispatching or leaving", async () => {
  let interrupted = 0;
  const actions = okActions({
    interrupt: () => {
      interrupted += 1;
      return () => ({ kind: "ok" });
    },
  });
  const { t, renderer } = await mountWorkbench(
    liveTurnRunOf({ timeline: events(4) }),
    100,
    40,
    actions,
  );
  await press(t, renderer, "escape"); // arm
  assert.match(t.captureCharFrame(), /Press esc again/);
  await press(t, renderer, "up"); // any other key cancels the arm
  assert.doesNotMatch(t.captureCharFrame(), /Press esc again/);
  assert.equal(interrupted, 0);
});

test("interrupt rests the Run halted with the Attempt cancelled and offers resume", async () => {
  const control = makeRunView(snapshotOf(liveTurnRunOf()));
  const renderer = makeRenderer(100, 40);
  const actions = okActions({
    interrupt: () => {
      // The live snapshot carries the halted rest in, exactly as production does.
      control.setRun(
        runOf({
          state: "halted",
          timeline: [
            { at: "T0", event: "attempt-settled", detail: "cancelled" },
            { at: "T1", event: "turn-settled", detail: "interrupted" },
          ],
          actionOffers: [RESUME_OFFER],
        }),
      );
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("Timeline"));
  await press(t, renderer, "escape"); // arm
  await press(t, renderer, "escape"); // interrupt
  const frame = t.captureCharFrame();
  assert.match(frame, /HALTED/);
  assert.match(frame, /attempt-settled cancelled/);
  assert.match(frame, /r resume/); // resumable
});

test("resume on a halted Run dispatches resume-run and live rows resume", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "halted", actionOffers: [RESUME_OFFER] })),
  );
  const renderer = makeRenderer(100, 40);
  let resumed = 0;
  const actions = okActions({
    resume: () => {
      resumed += 1;
      control.setRun(
        liveTurnRunOf({ timeline: [{ at: "T0", event: "turn-started" }] }),
      );
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("r resume"));
  await press(t, renderer, "r");
  assert.equal(resumed, 1);
  const frame = t.captureCharFrame();
  assert.match(frame, /RUNNING/);
  assert.match(frame, /Agent Turn started/); // the resumed Turn's rows appear
});

// AC5: Esc modes + focus -------------------------------------------

test("Esc means deny in a request, interrupt-arm during a live Turn, and leave when at rest", async () => {
  // At rest with no live Turn: Esc leaves the Workbench.
  const rest = await mountWorkbench(runOf({ state: "succeeded" }));
  await press(rest.t, rest.renderer, "escape");
  assert.match(rest.t.captureCharFrame(), /Secant/); // back on Home

  // During a live Turn: Esc arms interrupt rather than leaving.
  const live = await mountWorkbench(liveTurnRunOf(), 100, 40, okActions());
  await press(live.t, live.renderer, "escape");
  assert.match(live.t.captureCharFrame(), /Press esc again to interrupt/);
  assert.match(live.t.captureCharFrame(), /Timeline/); // stayed

  // With an outstanding request: Esc denies (does not arm interrupt or leave).
  const req = await mountWithRequest();
  await press(req.t, req.renderer, "escape");
  assert.equal(req.control.requests[0]?.decision, "deny");
});

test("the request control fits small widths without overflow and reads without colour", async () => {
  const mounted = await mountWithRequest();
  noOverflow(mounted.t.captureCharFrame(), 100);
  mounted.renderer.resize(40, 24);
  await mounted.t.renderOnce();
  const frame = mounted.t.captureCharFrame();
  noOverflow(frame, 40);
  assert.match(frame, /Allow/);
  assert.match(frame, /Deny/);
});
