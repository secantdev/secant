import assert from "node:assert/strict";
import { test } from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { App } from "../../src/tui/tui.js";
import {
  inertHarnessCatalogView,
  inertLaunchPreparationView,
  inertRunActionsView,
  inertRunListView,
} from "./inert.js";
import type {
  AnswerOutcome,
  BundleCatalogView,
  RunActionOutcome,
  RunActionsView,
  RunLaunchView,
  RunWorkbenchView,
  TRunViewFreshness,
  WorkspaceView,
} from "../../src/tui/tui.js";
import { makeFakeRenderer, type FakeRenderer } from "./renderer-fixture.js";
import type {
  AnswerHumanGateOffer,
  BundleCatalogSnapshot,
  BundleFocusSnapshot,
  DiagnosticReference,
  ContinueRepeatOffer,
  EndStageOffer,
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
  TranscriptRead,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";

// In-memory renderer tests for the Run Workbench (#91), reached the real way:
// through the App from a successful Start a Run, over fake `run` snapshots and a
// fake Renderer Port whose `size`/`onKey`/`onResize` we drive directly (AC7).
// They cover: rendering every headless `run show` fact, the details panel, live
// updates on the live edge, the paging anchor + new-activity count +
// jump-to-latest, reference inspection with a truncation marker, focus movement
// and Escape, small-width breakpoints and resize without overflow (AC1–AC8).
// Issue #195 covers the bounded-window marker, counted Jump-to-latest control,
// large-content truncation parity, inspection paging notice, transient Operation
// receipts, and the interaction regression guard at this public renderer seam. It
// changes neither Renderer nor dependency pins, so the Windows Terminal human
// check is not applicable; the named workbench-timeline-inspection scenario runs
// in the canonical test suite on Windows, macOS, and Linux.

const WORKSPACE = "/tmp/secant-workbench-ws";

// --- a fake Renderer Port we can drive (shared fixture, A52) ----------------

// --- fake App seams the flow needs to reach the Workbench ------------------

function approvedWorkspace(): WorkspaceView {
  const [snapshot] = createSignal<WorkspaceSnapshot>({
    family: "workspace",
    path: WORKSPACE,
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 1,
    startupNotices: [],
    harnesses: [],
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
  shippedWithRunningSecant: false,
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
  const [freshness, setFreshness] = createSignal<TRunViewFreshness>({
    kind: "current",
    catchUp: "fresh",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  const reconnects: string[] = [];
  const reads = new Map<string, ResourceRead>();
  // Transcript pages, keyed by the requested `older` cursor ("" for the newest).
  const transcripts = new Map<string, TranscriptRead>();
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
  const continues: { runId: string; stepId: string }[] = [];
  const endStages: { runId: string; stepId: string }[] = [];
  // The steer seam (#148) is hand-driven the same way: it records each dispatch and
  // returns the shared outcome accessor a test advances (pending → applied/refused),
  // so tests exercise the blank guard, the applied close, and the refusal-keeps-draft.
  const [steerOutcome, setSteerOutcome] = createSignal<AnswerOutcome>({
    kind: "pending",
  });
  const steers: { runId: string; turnId: string; text: string }[] = [];
  const texts: { gate: RunGateReference; text: string }[] = [];
  const requests: {
    requestId: string;
    generation: number;
    decision: "allow" | "deny";
  }[] = [];
  const view: RunWorkbenchView = {
    openRun: () => ({
      snapshot,
      live,
      preview,
      freshness,
      reconnect: () => reconnects.push("reconnect"),
    }),
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
    continueRepeat: (runId, stepId) => {
      continues.push({ runId, stepId });
      return interactiveOutcome;
    },
    endStage: (runId, stepId) => {
      endStages.push({ runId, stepId });
      return interactiveOutcome;
    },
    steer: (runId, turnId, text) => {
      steers.push({ runId, turnId, text });
      return steerOutcome;
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
    readTranscript: (reference) =>
      transcripts.get(
        reference.type === "transcript-page"
          ? (reference.older ?? "")
          : "export",
      ) ?? {
        found: false,
        problem: {
          code: "transcript-gone",
          explanation: "The referenced transcript is gone.",
          remediation: "Re-open the Run.",
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
    setLive: (overlay: RunLiveOverlay | undefined) => {
      setLive(overlay);
      setPreview(overlay?.preview);
    },
    setPreview,
    setFreshness,
    reconnects,
    setRead: (key: string, read: ResourceRead) => reads.set(key, read),
    setTranscript: (cursor: string, read: TranscriptRead) =>
      transcripts.set(cursor, read),
    answers,
    texts,
    requests,
    setAnswerOutcome,
    sends,
    ends,
    continues,
    endStages,
    steers,
    setInteractiveOutcome,
    setSteerOutcome,
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
    ...(over.completion !== undefined ? { completion: over.completion } : {}),
    problem: over.problem,
    ...(over.sessions !== undefined ? { sessions: over.sessions } : {}),
    ...(over.effectiveModel !== undefined
      ? { effectiveModel: over.effectiveModel }
      : {}),
    ...(over.requestedModel !== undefined
      ? { requestedModel: over.requestedModel }
      : {}),
    ...(over.selectedHarness !== undefined
      ? { selectedHarness: over.selectedHarness }
      : {}),
    ...(over.harness !== undefined ? { harness: over.harness } : {}),
    ...(over.turnPosition !== undefined
      ? { turnPosition: over.turnPosition }
      : {}),
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
  basis: "durable Human Gate",
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
  renderer: FakeRenderer,
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
        harnesses={inertHarnessCatalogView()}
        preparation={inertLaunchPreparationView()}
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
  t.mockInput.pressEnter(); // Home: Start a Run is the first, default entry
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
  const renderer = makeFakeRenderer(width, height);
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
  renderer: FakeRenderer,
  name: string,
  mods: { ctrl?: boolean } = {},
) {
  renderer.key(name, mods);
  await t.renderOnce();
}

// Type printable text into a focused native <input> (D9). Text entry rides the
// renderer's mock input (the real terminal path the field reads), never the fake
// Renderer Port — the Port carries only the Workbench dispatcher's command keys.
async function type(
  t: {
    renderOnce: () => Promise<void>;
    mockInput: { typeText: (text: string) => Promise<void> };
  },
  text: string,
) {
  await t.mockInput.typeText(text);
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

test("workbench-view-freshness: four stream-health tokens replace scroll-live and gate Operations", async () => {
  const resumeOffer: ResumeRunOffer = {
    action: "resume-run",
    runId: "run-1",
    available: true,
    consequence: "continue from the resting Step.",
  };
  const [pendingResume] = createSignal<RunActionOutcome>({ kind: "pending" });
  const mounted = await mountWorkbench(
    runOf({
      state: "halted",
      actionOffers: [resumeOffer],
      timeline: events(2),
    }),
    100,
    40,
    okActions({ resume: () => pendingResume }),
  );
  const { t, control, renderer } = mounted;
  assert.match(t.captureCharFrame(), /View current/);
  assert.doesNotMatch(t.captureCharFrame(), /\(live\)/);
  renderer.key("r");
  await t.renderOnce();

  control.setFreshness({
    kind: "loading",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /View loading/);

  control.setFreshness({
    kind: "catching-up",
    catchUp: "continuous",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /View catching up/);

  control.setFreshness({
    kind: "disconnected",
    reason: "observer-lagged",
    lastConfirmedAt: "2026-09-22T10:30:00.000Z",
  });
  await t.renderOnce();
  const disconnected = t.captureCharFrame();
  assert.match(disconnected, /View disconnected/);
  assert.match(disconnected, /last confirmed 2026-09-22 10:30:00Z/);
  assert.match(disconnected, /r Reconnect/);
  assert.match(disconnected, /View freshness · not Run state/);
  assert.match(disconnected, /Operation pending · resume/);
  assert.doesNotMatch(disconnected, /r resume/);

  renderer.key("r");
  await t.renderOnce();
  assert.deepEqual(control.reconnects, ["reconnect"]);
});

test("reopened history renders End Step distinctly from a settled Command Attempt (#134 A19)", async () => {
  const { t } = await mountWorkbench(
    runOf({
      timeline: [
        {
          at: "2026-09-18T00:00:00.000Z",
          event: "interactive-step-ended",
          detail: "succeeded",
        },
        {
          at: "2026-09-18T00:01:00.000Z",
          event: "repeat-continued",
          detail: "succeeded",
        },
        {
          at: "2026-09-18T00:02:00.000Z",
          event: "stage-ended",
          detail: "succeeded",
        },
      ],
    }),
  );
  // A confirmed End Stage reads as its own row, apart from Continue (#218).
  assert.match(t.captureCharFrame(), /stage-ended succeeded/);
  assert.match(t.captureCharFrame(), /interactive-step-ended succeeded/);
  // A human-controlled Repeat's Continue reads as its own history row (#217).
  assert.match(t.captureCharFrame(), /repeat-continued succeeded/);
});

test("the details panel shows the observed Harness, executable, version, and model, and the header no longer does (#194 story 35)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      state: "succeeded",
      progress: PROGRESS,
      selectedHarness: "claude-code",
      requestedModel: "fake-opus",
      harness: {
        name: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
      effectiveModel: "fake-sonnet",
    }),
    100,
    30,
  );
  // The header no longer carries the Harness/model facts (they moved to the panel).
  assert.doesNotMatch(t.captureCharFrame(), /Observed Harness/);
  await press(t, renderer, "d");
  const frame = t.captureCharFrame();
  assert.match(frame, /Selected Harness · claude-code/);
  assert.match(
    frame,
    /Observed Harness · Claude Code · \/usr\/bin\/claude · 1\.2\.3 · model fake-sonnet/,
  );
  // Requested and observed models stay visibly distinct (AC1).
  assert.match(frame, /Requested model · fake-opus/);
  noOverflow(frame, 100);
});

test("the panel drops the long executable path to stay readable at small widths (#194 story 35)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({
      state: "succeeded",
      progress: PROGRESS,
      harness: {
        name: "Claude Code",
        // A long executable path the compact layout drops to fit.
        executable: "/a/very/long/path/to/the/claude/executable/binary/here",
        executableVersion: "1.2.3",
      },
      effectiveModel: "fake-sonnet",
    }),
    100,
    30,
  );
  renderer.resize(70, 30);
  await t.renderOnce();
  await press(t, renderer, "d");
  const compact = t.captureCharFrame();
  assert.match(
    compact,
    /Observed Harness · Claude Code · 1\.2\.3 · model fake-sonnet/,
  );
  noOverflow(compact, 70);
});

test("the panel reports no model rather than inventing one, and omits Harness facts for a Command-only Run (#194 story 35)", async () => {
  // Harness present, model unobserved: the fact is stated honestly, not invented.
  const missing = await mountWorkbench(
    runOf({
      state: "succeeded",
      progress: PROGRESS,
      harness: {
        name: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
    }),
    100,
    30,
  );
  await press(missing.t, missing.renderer, "d");
  assert.match(
    missing.t.captureCharFrame(),
    /Observed Harness · Claude Code · \/usr\/bin\/claude · 1\.2\.3 · model not reported/,
  );

  // Command-only Run: no Harness identity, so no Harness/model lines at all.
  const commandOnly = await mountWorkbench(
    runOf({ state: "succeeded", progress: PROGRESS }),
    100,
    30,
  );
  await press(commandOnly.t, commandOnly.renderer, "d");
  const commandOnlyFrame = commandOnly.t.captureCharFrame();
  assert.doesNotMatch(commandOnlyFrame, /Selected Harness/);
  assert.doesNotMatch(commandOnlyFrame, /Observed Harness/);
  assert.doesNotMatch(commandOnlyFrame, /model/);
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
  const renderer = makeFakeRenderer(100, 20);
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
  assert.match(frame, /View current/);
});

test("the timeline follows the live edge as durable updates append events", async () => {
  const { t, control } = await mountWorkbench(
    runOf({ timeline: events(6) }),
    100,
    16,
  );
  const first = t.captureCharFrame();
  assert.match(first, /View current/);
  assert.match(first, / e5/); // newest visible
  control.setRun(runOf({ timeline: events(9) }));
  await t.renderOnce();
  assert.match(t.captureCharFrame(), / e8/); // followed to the newest
});

test("[selected-versus-observed-evidence] selected and observed Harness facts stay distinct through a live Turn", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "running" }],
      selectedHarness: "codex",
      effectiveModel: "claude-sonnet-4-5",
      harness: {
        name: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
      timeline: [
        {
          at: "T000",
          event: "turn-started",
          detail: "repair",
          turnKind: "agent",
        },
      ],
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
  // Selected and observed facts live in the details panel now (#194 story 35); open
  // it and confirm the two read as visibly distinct lines (AC1), through the live Turn.
  await press(t, renderer, "d");
  const streaming = t.captureCharFrame();
  assert.match(streaming, /Selected Harness · codex/);
  assert.match(
    streaming,
    /Observed Harness · Claude Code · \/usr\/bin\/claude · 1\.2\.3/,
  );
  assert.match(streaming, /model claude-sonnet-4-5/);
  assert.match(streaming, /Agent Turn · working/);
  assert.match(streaming, /Assistant preview · I am checking/);
  assert.match(streaming, /Activity · Edit src\/repair\.ts/);

  // Below the panel's width breakpoint the panel hides (its facts with it), but the
  // screen still relays out without overflow.
  renderer.resize(40, 24);
  await t.renderOnce();
  noOverflow(t.captureCharFrame(), 40);
  renderer.resize(110, 24);
  await t.renderOnce();

  control.setRun(
    runOf({
      progress: [{ id: "repair", kind: "agent", status: "succeeded" }],
      selectedHarness: "codex",
      effectiveModel: "claude-sonnet-4-5",
      harness: {
        name: "Claude Code",
        executable: "/usr/bin/claude",
        executableVersion: "1.2.3",
      },
      timeline: [
        {
          at: "T000",
          event: "turn-started",
          detail: "repair",
          turnKind: "agent",
        },
        {
          at: "T001",
          event: "assistant-content",
          detail: "The assertion is fixed.",
        },
        {
          at: "T002",
          event: "turn-settled",
          detail: "completed",
          turnKind: "agent",
        },
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

test("reopened durable Turn rows label kind by words, colour removed, legacy neutral (#126)", async () => {
  // One reopened Session with an Interactive Turn, a following Agent Turn, and a
  // legacy row whose kind is unknown — the Workbench distinguishes each by glyph
  // plus words alone, with no live overlay (a settled, reopened Run).
  const { t } = await mountWorkbench(
    runOf({
      state: "succeeded",
      progress: [
        { id: "discuss", kind: "interactive-agent", status: "succeeded" },
      ],
      position: 1,
      timeline: [
        {
          at: "T000",
          event: "turn-started",
          detail: "shared",
          turnKind: "interactive-agent",
        },
        {
          at: "T001",
          event: "turn-settled",
          detail: "completed",
          turnKind: "interactive-agent",
        },
        {
          at: "T002",
          event: "turn-started",
          detail: "shared",
          turnKind: "agent",
        },
        {
          at: "T003",
          event: "turn-settled",
          detail: "completed",
          turnKind: "agent",
        },
        // A legacy row (admitted before the kind column): no turnKind, so it reads a
        // neutral "Turn" rather than a fabricated kind.
        { at: "T004", event: "turn-started", detail: "shared" },
      ],
    }),
    110,
    24,
  );
  const frame = t.captureCharFrame();
  assert.match(frame, /Interactive Turn started · shared/);
  assert.match(frame, /Interactive Turn settled · completed/);
  assert.match(frame, /Agent Turn started · shared/);
  assert.match(frame, /Agent Turn settled · completed/);
  assert.match(frame, /● Turn started · shared/); // legacy: neither kind claimed
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
  assert.match(paused, /\d+ new activities · Jump to latest/);

  await press(t, renderer, "end");
  const latest = t.captureCharFrame();
  assert.match(latest, /Assistant preview · new streamed content/);
  assert.match(latest, /View current/);
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
      actionOffers: [
        {
          ...ANSWER_OFFER,
          gate: {
            runId: "run-1",
            stepId: "approve",
            attemptId: "a1",
            shape: "approve-reject",
          },
          basis: "durable Human Gate",
        },
      ],
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
  assert.match(scrolled, /View current/); // freshness is independent of scrolling

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
  assert.match(live, /View current/);
  assert.match(live, / e35/); // the newest event
  assert.doesNotMatch(live, /new activit(?:y|ies) · Jump to latest/);
});

test("timeline paging is wired: home reaches the oldest event, end returns to the live edge", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ timeline: events(30) }),
    100,
    14,
  );
  assert.match(t.captureCharFrame(), /View current/);
  await press(t, renderer, "pageup"); // detaches from the live edge
  assert.match(t.captureCharFrame(), /View current/);
  await press(t, renderer, "home"); // jump to the oldest
  assert.match(t.captureCharFrame(), / e0 /);
  await press(t, renderer, "end"); // back to the live edge
  const live = t.captureCharFrame();
  assert.match(live, /View current/);
  assert.match(live, / e29/);
});

test("workbench-timeline-inspection: the bounded window marks its beginning and counts Jump to latest activity", async () => {
  const { t, control, renderer } = await mountWorkbench(
    runOf({ timeline: events(30) }),
    100,
    14,
  );
  assert.doesNotMatch(t.captureCharFrame(), /Beginning of Run history/);

  await press(t, renderer, "home");
  const beginning = t.captureCharFrame();
  assert.match(beginning, /Beginning of Run history/);
  assert.match(beginning, / e0 /);

  await press(t, renderer, "down");
  assert.doesNotMatch(t.captureCharFrame(), /Beginning of Run history/);

  await press(t, renderer, "end");
  await press(t, renderer, "up");
  assert.match(t.captureCharFrame(), /1 new activity · Jump to latest/);

  control.setRun(runOf({ timeline: events(32) }));
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /3 new activities · Jump to latest/);

  await press(t, renderer, "end");
  assert.doesNotMatch(t.captureCharFrame(), /new activit(?:y|ies)/);

  // A full live window still begins at index zero: the marker is presentation only,
  // so it neither hides an activity nor manufactures a new-activity count.
  const exact = await mountWorkbench(runOf({ timeline: events(7) }), 100, 14);
  const exactFrame = exact.t.captureCharFrame();
  assert.match(exactFrame, /Beginning of Run history/);
  assert.match(exactFrame, / e0 /);
  assert.match(exactFrame, / e6 /);
  assert.doesNotMatch(exactFrame, /new activit(?:y|ies)/);

  const narrow = await mountWorkbench(runOf({ timeline: events(30) }), 40, 14);
  await press(narrow.t, narrow.renderer, "home");
  const narrowBeginning = narrow.t.captureCharFrame();
  assert.match(narrowBeginning, /Beginning of Run history/);
  assert.match(narrowBeginning, /\d+ · Jump to latest/);
  noOverflow(narrowBeginning, 40);
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

/** A Run with one Session `s` that advertises transcript References (#124). */
function transcriptRun() {
  return runOf({
    sessions: [
      {
        session: "s",
        availability: "open",
        transcriptPage: {
          runId: "run-1",
          session: "s",
          type: "transcript-page",
        },
        transcriptExport: {
          runId: "run-1",
          session: "s",
          type: "transcript-export",
        },
      },
    ],
  });
}

/** Transcript entries for Session `s` with the given role and contents. */
function txEntries(role: "user" | "assistant", ...contents: string[]) {
  return contents.map((content) => ({ session: "s", role, content }));
}

test("the Session transcript opens the newest page and restores timeline focus (#124)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    24,
  );
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [
      { session: "s", role: "user", content: "Fix the failing test" },
      { session: "s", role: "assistant", content: "Working on it" },
    ],
  });

  await press(t, renderer, "t");
  const opened = t.captureCharFrame();
  assert.match(opened, /Session transcript/);
  assert.match(opened, /User Turn · session s/);
  assert.match(opened, /Fix the failing test/);
  assert.match(opened, /Assistant · session s/);
  assert.match(opened, /Working on it/);

  await press(t, renderer, "escape");
  assert.match(t.captureCharFrame(), /› Timeline/);
});

test("paging older upward preserves the first visible entry (#124)", async () => {
  // Height 10 → interior 8 → 6-line viewport, smaller than a 12-line page.
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    10,
  );
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "N1", "N2", "N3", "N4"),
    older: "c1",
  });
  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "O1", "O2", "O3", "O4"),
  });

  await press(t, renderer, "t");
  // Opens on the newest entries (the live edge, the bottom); older not loaded.
  let f = t.captureCharFrame();
  assert.match(f, /N4/);
  assert.doesNotMatch(f, /O1|O2|O3|O4/);

  await press(t, renderer, "home");
  assert.match(t.captureCharFrame(), /N1/);

  // Up at the top loads the older page and keeps N1 on screen (anchor preserved):
  // if the view had jumped to the live edge instead, N4 would show and N1 would not.
  await press(t, renderer, "up");
  f = t.captureCharFrame();
  assert.match(f, /N1/);
  assert.doesNotMatch(f, /N4/);

  // Paging further up reaches the just-loaded older entries.
  await press(t, renderer, "pageup");
  assert.match(t.captureCharFrame(), /O1/);
});

test("workbench-timeline-inspection: a failed older-page read is visible and keeps its retry cursor", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    10,
  );
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "N1", "N2", "N3", "N4"),
    older: "c1",
  });
  control.setTranscript("c1", {
    found: false,
    problem: {
      code: "transcript-page-stale",
      explanation: "The older transcript page could not be read.",
      remediation: "Scroll up to retry.",
      possibleEffects: "none",
    },
  });

  await press(t, renderer, "t");
  await press(t, renderer, "home");
  await press(t, renderer, "up");
  const failed = t.captureCharFrame();
  assert.match(failed, /Notice \[transcript-page-stale\]/);
  assert.match(failed, /Scroll up to retry/);

  control.setTranscript("c1", {
    found: true,
    type: "transcript-page",
    entries: txEntries("user", "O1", "O2"),
  });
  await press(t, renderer, "up");
  await press(t, renderer, "pageup");
  assert.match(t.captureCharFrame(), /O1/);
  assert.doesNotMatch(t.captureCharFrame(), /transcript-page-stale/);
});

test("a large transcript entry scrolls without truncation (#124)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    24,
  );
  const big = Array.from({ length: 600 }, (_, i) => `line-${i}`).join("\n");
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [{ session: "s", role: "assistant", content: big }],
  });

  await press(t, renderer, "t");
  // Opens at the bottom, so the newest lines show; nothing is truncated away.
  assert.match(t.captureCharFrame(), /line-599/);
  assert.doesNotMatch(t.captureCharFrame(), /truncated/);
  await press(t, renderer, "home");
  assert.match(t.captureCharFrame(), /line-0\b/);
});

test("the transcript inspection stays within small widths and relays out on resize (#124)", async () => {
  const { t, control, renderer } = await mountWorkbench(
    transcriptRun(),
    100,
    24,
  );
  control.setTranscript("", {
    found: true,
    type: "transcript-page",
    entries: [
      {
        session: "s",
        role: "user",
        content: "a very long single line that exceeds forty columns easily",
      },
    ],
  });

  await press(t, renderer, "t");
  assert.match(t.captureCharFrame(), /Session transcript/);

  // Narrow the terminal: the inspection clips each line to width, no overflow.
  renderer.resize(40, 24);
  await t.renderOnce();
  noOverflow(t.captureCharFrame(), 40);

  // Widen it again: it relays out and stays within the new width.
  renderer.resize(80, 24);
  await t.renderOnce();
  noOverflow(t.captureCharFrame(), 80);
  assert.match(t.captureCharFrame(), /Session transcript/);
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

test("workbench-timeline-inspection: timeline and inspection end truncated content with the same marker", async () => {
  const timeline = await mountWorkbench(
    runOf({
      timeline: [
        {
          at: "T000",
          event: "assistant-content",
          detail: `${"x".repeat(157)} … output truncated`,
        },
        {
          at: "T001",
          event: "assistant-content",
          detail: "Still thinking…",
        },
      ],
    }),
    100,
    30,
  );
  const timelineFrame = timeline.t.captureCharFrame();
  assert.match(timelineFrame, /Assistant.*… output truncated/);
  assert.match(timelineFrame, /Still thinking…/);
  assert.doesNotMatch(timelineFrame, /Still thinking … output truncated/);

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
  const inspection = await mountWorkbench(run, 100, 30);
  inspection.control.setRead("log", {
    found: true,
    type: "text",
    content: Array.from({ length: 501 }, (_, index) => `line-${index}`).join(
      "\n",
    ),
  });
  await press(inspection.t, inspection.renderer, "d");
  await press(inspection.t, inspection.renderer, "return");
  await press(inspection.t, inspection.renderer, "end");
  assert.match(inspection.t.captureCharFrame(), /line-499.*… output truncated/);
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

test("a selected-Harness preparation Problem is visible without colour and survives narrow resize", async () => {
  const run = runOf({
    state: "halted",
    selectedHarness: "codex",
    problem: {
      code: "selected-harness-unavailable",
      explanation: "Codex could not be prepared (authentication).",
      remediation: "Log in separately through Codex, then resume the Run.",
      possibleEffects: "none",
      details: { harness: "codex" },
    },
  });
  const { t, renderer } = await mountWorkbench(run, 100, 30);
  let frame = t.captureCharFrame();
  // The selected-Harness Problem stays a top-level header block, colour-independent.
  assert.match(frame, /selected-harness-unavailable/);
  assert.match(frame, /authentication/);
  assert.match(frame, /Log in separately through Codex/);
  // A halted Run carries its resting prose beside the state word (#194 story 38).
  assert.match(frame, /Execution stopped outside the Workflow\./);
  renderer.resize(40, 24);
  await t.renderOnce();
  frame = t.captureCharFrame();
  assert.match(frame, /selected-harness-unavailable/);
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

// --- deleted between launch and initial open -------------------------------

test("a launched Run missing on initial open returns to Previous Runs with its Bundle notice", async () => {
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
  const renderer = makeFakeRenderer(80, 24);
  const { t } = await mountApp(control, renderer, "ghost", 80, 24);
  await t.waitForFrame((frame) => frame.includes("was deleted"));
  assert.match(t.captureCharFrame(), /Alpha Flow was deleted/);
  assert.doesNotMatch(t.captureCharFrame(), /No such Run/);
});

// --- Run Actions: resume / cancel / delete (#92 ticket, AC3) ---------------

const RESUME_OFFER = {
  action: "resume-run" as const,
  runId: "run-1",
  available: true as const,
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
// A resume that arms an acknowledgement (#194 story 39) and one the Port marks
// unavailable (#194 story 40).
const RESUME_ACK_OFFER = {
  action: "resume-run" as const,
  runId: "run-1",
  available: true as const,
  consequence: "resume: continue from the Step the Run stopped at.",
  acknowledgement:
    "the interrupted command may have already run — resuming re-runs this Step, so its effects may repeat.",
};
const RESUME_UNAVAILABLE_OFFER = {
  action: "resume-run" as const,
  runId: "run-1",
  available: false as const,
  reason:
    'resume needs the "main" Session, which is no longer usable — start a new Run instead.',
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

test("resume stays on the main rail; delete moves into the details panel (#194 story 37)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_OFFER, DELETE_OFFER] }),
    100,
    40,
    okActions(),
  );
  // The main rail keeps the primary action; delete is not on it (AC3).
  const rail = t.captureCharFrame();
  assert.match(rail, /r resume — resume: continue from the Step/);
  assert.doesNotMatch(rail, /x delete/);
  assert.doesNotMatch(rail, /c cancel/);
  // Delete lives in the panel with its consequence.
  await press(t, renderer, "d");
  const panel = t.captureCharFrame();
  assert.match(panel, /x delete — remove the Run/);
  assert.doesNotMatch(panel, /c cancel/); // not offered while resting
});

test("no Actions section is shown when the Run offers none", async () => {
  const { t } = await mountWorkbench(runOf({ actionOffers: [] }));
  assert.doesNotMatch(t.captureCharFrame(), /Actions:/);
});

test("resume dispatches and the Workbench follows into the running Run", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "halted", actionOffers: [RESUME_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
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
  assert.doesNotMatch(frame, /r resume/); // no longer resumable
  // Cancel now lives in the panel (#194 story 37); it is offered while live.
  await press(t, renderer, "d"); // dismiss the "Resume applied" receipt
  await press(t, renderer, "d"); // open the details panel
  assert.match(t.captureCharFrame(), /c cancel/);
});

test("workbench-timeline-inspection: a resume receipt moves from checking to applied and is dismissible", async () => {
  const [outcome, setOutcome] = createSignal<RunActionOutcome>({
    kind: "pending",
  });
  const actions = okActions({ resume: () => outcome });
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_OFFER] }),
    100,
    40,
    actions,
  );

  await press(t, renderer, "r");
  assert.match(t.captureCharFrame(), /Checking resume/);
  assert.doesNotMatch(t.captureCharFrame(), /d dismiss/);

  setOutcome({ kind: "ok" });
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Resume applied · d dismiss/);

  await press(t, renderer, "d");
  const dismissed = t.captureCharFrame();
  assert.doesNotMatch(dismissed, /Resume applied/);
  assert.doesNotMatch(dismissed, /› Details/);
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

test("workbench-interaction-regression: delete stays armed until y confirms and then leaves", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "failed", actionOffers: [DELETE_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
  let removed = 0;
  const actions = okActions({
    remove: () => {
      removed += 1;
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("Timeline"));
  await press(t, renderer, "d"); // open the panel where delete now lives (#194)
  await t.waitForFrame((f) => f.includes("x delete"));
  await press(t, renderer, "x"); // arm the confirmation
  assert.equal(removed, 0); // not dispatched yet
  assert.match(t.captureCharFrame(), /Delete is permanent/);
  await press(t, renderer, "y"); // confirm
  assert.equal(removed, 1);
  assert.match(t.captureCharFrame(), /Previous Runs/);
  assert.match(t.captureCharFrame(), /Alpha Flow was deleted/);
  assert.doesNotMatch(t.captureCharFrame(), /Timeline/);
});

test("Escape backs out of an armed delete without dispatching or leaving", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "failed", actionOffers: [DELETE_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
  let removed = 0;
  const actions = okActions({
    remove: () => {
      removed += 1;
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("Timeline"));
  await press(t, renderer, "d"); // open the panel where delete now lives (#194)
  await t.waitForFrame((f) => f.includes("x delete"));
  await press(t, renderer, "x"); // arm
  assert.match(t.captureCharFrame(), /Delete is permanent/);
  await press(t, renderer, "escape"); // back out
  assert.equal(removed, 0);
  assert.doesNotMatch(t.captureCharFrame(), /Delete is permanent/);
  assert.match(t.captureCharFrame(), /Timeline/); // still on the Workbench
});

test("workbench-interaction-regression: cancel stays armed until y confirms", async () => {
  const control = makeRunView(
    snapshotOf(runOf({ state: "running", actionOffers: [CANCEL_OFFER] })),
  );
  const renderer = makeFakeRenderer(100, 40);
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
  await t.waitForFrame((f) => f.includes("Timeline"));
  await press(t, renderer, "d"); // open the panel where cancel now lives (#194)
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

test("a refused delete surfaces its reason though delete lives only in the panel (#194 story 37)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "failed", actionOffers: [DELETE_OFFER] }),
    100,
    40,
    okActions({
      remove: () => () => ({
        kind: "refused",
        problem: {
          code: "run-store-damaged",
          explanation: "The Run store is damaged.",
          remediation: "Re-open the Run.",
          possibleEffects: "none",
        },
      }),
    }),
  );
  // Delete is the only offer, so the main Actions rail is not shown at all — the
  // refusal must not be gated behind it (the regression this guards).
  assert.doesNotMatch(t.captureCharFrame(), /Actions:/);
  await press(t, renderer, "d"); // open the panel where delete lives
  await press(t, renderer, "x"); // arm
  await press(t, renderer, "y"); // confirm → refused
  const after = t.captureCharFrame();
  assert.match(after, /The Run store is damaged\./); // the reason stays visible
  assert.match(after, /Timeline/); // still on the Workbench
});

// --- recovery evidence, resting prose, and the two resume acknowledgements
//     (#194 stories 36-40) ------------------------------------------------

test("[workbench-details-recovery] the panel renders recovery evidence and hosts the relocated destructive actions", async () => {
  // Coverage dimensions for this slice (AC7): keymap and focus (`d` opens the panel,
  // `x` arms delete from it), terminal layout and the details breakpoint (the panel
  // fits at 100×40 without overflow), colour-independent status (every recovery line
  // and the resting prose read as words), interaction tuning (delete arms then
  // confirms on `y`), and renderer/platform evidence (the sessions/latest-activity
  // facts come only from the Run view). Timeline mechanics and large content are
  // inapplicable to this slice; the Windows Terminal human check is not applicable —
  // the named workbench-details-recovery scenario runs in the canonical suite on
  // Windows, macOS, and Linux.
  const run = runOf({
    state: "halted",
    sessions: [{ session: "main", availability: "unusable" }],
    timeline: [{ at: "T0", event: "turn-settled", detail: "interrupted" }],
    actionOffers: [RESUME_UNAVAILABLE_OFFER, DELETE_OFFER],
  });
  const { t, renderer } = await mountWorkbench(run, 100, 40, okActions());
  // Header: resting prose beside the state word (story 38, AC4).
  const header = t.captureCharFrame();
  assert.match(header, /Execution stopped outside the Workflow\./);
  // Rail: resume is truthfully unavailable, not hidden (story 40); delete is off it.
  assert.match(header, /resume — unavailable · .*no longer usable/);
  assert.doesNotMatch(header, /x delete/);

  await press(t, renderer, "d");
  const panel = t.captureCharFrame();
  assert.match(panel, /Recovery:/);
  assert.match(
    panel,
    /Resting reason · Execution stopped outside the Workflow\./,
  );
  assert.match(panel, /Latest activity · turn-settled interrupted · T0/);
  assert.match(panel, /Session main · unusable/);
  // Nothing invented when absent (story 36, AC2): no conflict line here.
  assert.doesNotMatch(panel, /Materialization conflict/);
  assert.match(panel, /x delete — remove the Run/);
  noOverflow(panel, 100);

  // The relocated delete keeps its confirm-armed behaviour (story 37, AC3).
  await press(t, renderer, "x");
  assert.match(t.captureCharFrame(), /Delete is permanent/);
  await press(t, renderer, "escape"); // Esc backs out without dispatching
  assert.doesNotMatch(t.captureCharFrame(), /Delete is permanent/);
});

test("an unavailable resume is not dispatchable — r does nothing (#194 story 40)", async () => {
  let dispatched = false;
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_UNAVAILABLE_OFFER] }),
    100,
    40,
    okActions({
      resume: () => {
        dispatched = true;
        return () => ({ kind: "ok" });
      },
    }),
  );
  await press(t, renderer, "r");
  assert.equal(dispatched, false);
  assert.match(t.captureCharFrame(), /resume — unavailable/);
});

test("an indeterminate-Command resume arms an acknowledgement before it dispatches (#194 story 39)", async () => {
  let received = false;
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_ACK_OFFER] }),
    100,
    40,
    okActions({
      resume: () => {
        received = true;
        return () => ({ kind: "ok" });
      },
    }),
  );
  // `r` arms the acknowledgement of repeatable effects and does not dispatch yet.
  await press(t, renderer, "r");
  assert.equal(received, false);
  const armed = t.captureCharFrame();
  assert.match(armed, /Resuming may repeat this Step's effects/);
  assert.match(armed, /y to acknowledge and resume/);
  // Esc backs out without resuming.
  await press(t, renderer, "escape");
  assert.equal(received, false);
  assert.doesNotMatch(t.captureCharFrame(), /y to acknowledge/);
  // Arm again and confirm: `y` acknowledges and dispatches the resume.
  await press(t, renderer, "r");
  await press(t, renderer, "y");
  assert.equal(received, true);
});

test("the indeterminate Attempt shows as recovery evidence in the panel (#194 story 36/39)", async () => {
  const { t, renderer } = await mountWorkbench(
    runOf({ state: "halted", actionOffers: [RESUME_ACK_OFFER] }),
    100,
    40,
    okActions(),
  );
  await press(t, renderer, "d");
  assert.match(
    t.captureCharFrame(),
    /Indeterminate Attempt · the interrupted command may have already run/,
  );
});

test("every terminal resting state carries its prose beside the state word (#194 story 38)", async () => {
  for (const [state, prose] of [
    ["succeeded", "Workflow completed."],
    ["failed", "This Run has ended."],
    ["cancelled", "You cancelled this Run."],
    ["halted", "Execution stopped outside the Workflow."],
  ] as const) {
    const { t } = await mountWorkbench(runOf({ state }), 100, 30);
    assert.match(
      t.captureCharFrame(),
      new RegExp(prose.replace(/[.]/g, "\\.")),
      `resting prose for ${state}`,
    );
  }
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
  // Focus is on the native field during the Step; the human's text rides the mock
  // input, while Enter to send comes over the Port dispatcher (D9).
  await type(wb.t, "hi");
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

test("End Step armed blurs the field so the confirming y never types, and dropping the arm refocuses it (D9)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "hi");
  await press(wb.t, wb.renderer, "e", { ctrl: true }); // arm End Step → field blurs
  assert.match(wb.t.captureCharFrame(), /End this interactive Step\?/);
  // While armed the field is blurred: a keystroke (the confirming `y` included) does not
  // type — the draft is unchanged. `y` over the Port confirms; it is never text.
  await type(wb.t, "y");
  assert.match(wb.t.captureCharFrame(), /> hi/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /> hiy/);
  // Esc drops the arm; the field refocuses and accepts text again.
  await press(wb.t, wb.renderer, "escape");
  await type(wb.t, "!");
  assert.match(wb.t.captureCharFrame(), /> hi!/);
});

test("the armed End Step confirms on y over the Port and no y lands in the field (D9)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "draft");
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  await press(wb.t, wb.renderer, "y"); // confirm through the Port dispatcher
  assert.deepEqual(wb.control.ends, [{ runId: "run-1", stepId: "discuss" }]);
});

test("the interactive field is blurred while a send is in flight so no key types (D9)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "hi");
  await press(wb.t, wb.renderer, "return"); // send → outcome pending → field blurs
  assert.match(wb.t.captureCharFrame(), /… sending…/); // the in-flight hint
  await type(wb.t, "X"); // the field is blurred, so this does not land
  assert.match(wb.t.captureCharFrame(), /> hi/);
  assert.doesNotMatch(wb.t.captureCharFrame(), /> hiX/);
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

// --- human-controlled Repeat Continue (#217) -------------------------------

const CONTINUE_OFFER: ContinueRepeatOffer = {
  action: "continue-repeat",
  runId: "run-1",
  stepId: "discuss",
  consequence:
    "this does not close the ticket; a fresh Session reads the tracker again and may choose it while it is still open.",
};

test("Continue replaces End Step in a human-controlled Repeat: ^N arms a confirmation that says no ticket is closed, and y dispatches (#217)", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER, CONTINUE_OFFER] }),
  );
  assert.match(wb.t.captureCharFrame(), /enter send Turn · \^N continue/);
  // End Step is not offered here, so ^E arms nothing.
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), /End this interactive Step\?/);
  await type(wb.t, "draft");
  await press(wb.t, wb.renderer, "n", { ctrl: true });
  const armed = wb.t.captureCharFrame();
  assert.match(armed, /y continue · esc keep/);
  assert.match(armed, /this does not close the ticket/);
  // The arm blurs the field, so the confirming y is never text.
  await type(wb.t, "y");
  assert.doesNotMatch(wb.t.captureCharFrame(), /> drafty/);
  await press(wb.t, wb.renderer, "y");
  assert.deepEqual(wb.control.continues, [
    { runId: "run-1", stepId: "discuss" },
  ]);
  assert.equal(wb.control.ends.length, 0);
});

test("Escape backs out of an armed Continue, and Continue cannot arm mid-Turn (#217)", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({ actionOffers: [SEND_OFFER, CONTINUE_OFFER] }),
  );
  await press(wb.t, wb.renderer, "n", { ctrl: true });
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(wb.t.captureCharFrame(), /y continue/);
  assert.equal(wb.control.continues.length, 0);

  const live = await mountWorkbench(interactiveRunOf({ actionOffers: [] }));
  await press(live.t, live.renderer, "n", { ctrl: true });
  assert.doesNotMatch(live.t.captureCharFrame(), /y continue/);
  await press(live.t, live.renderer, "y");
  assert.equal(live.control.continues.length, 0);
});

// --- human-controlled Repeat End Stage (#218) ------------------------------

const END_STAGE_OFFER: EndStageOffer = {
  action: "end-stage",
  runId: "run-1",
  stepId: "discuss",
  consequence:
    "Secant has not checked the tracker. This ends the stage as complete; use it only after you and the agent verified the tickets are done.",
};

test("^E arms End Stage beside Continue with a confirm saying the tracker is unchecked; esc declines keeping focus and the draft; y dispatches End Stage only (#218)", async () => {
  const wb = await mountWorkbench(
    interactiveRunOf({
      actionOffers: [SEND_OFFER, CONTINUE_OFFER, END_STAGE_OFFER],
    }),
  );
  assert.match(
    wb.t.captureCharFrame(),
    /enter send Turn · \^N continue · \^E end stage/,
  );
  await type(wb.t, "draft");
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  const armed = wb.t.captureCharFrame();
  assert.match(armed, /y end stage · esc keep — Secant has not checked the/);
  assert.doesNotMatch(armed, /End this interactive Step\?/);
  // Declined: nothing dispatches, and the field keeps its draft and focus.
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(wb.t.captureCharFrame(), /y end stage/);
  await type(wb.t, "!");
  assert.match(wb.t.captureCharFrame(), /> draft!/);
  assert.equal(wb.control.endStages.length, 0);
  // Confirmed: the arm blurs the field, so y never types, and only End Stage goes.
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  await type(wb.t, "y");
  assert.doesNotMatch(wb.t.captureCharFrame(), /> draft!y/);
  await press(wb.t, wb.renderer, "y");
  assert.deepEqual(wb.control.endStages, [
    { runId: "run-1", stepId: "discuss" },
  ]);
  assert.equal(wb.control.continues.length, 0);
  assert.equal(wb.control.ends.length, 0);
});

test("End Stage cannot arm mid-Turn (#218)", async () => {
  const live = await mountWorkbench(interactiveRunOf({ actionOffers: [] }));
  await press(live.t, live.renderer, "e", { ctrl: true });
  assert.doesNotMatch(live.t.captureCharFrame(), /y end stage/);
  await press(live.t, live.renderer, "y");
  assert.equal(live.control.endStages.length, 0);
});

test("a human-declared completion says the tracker was not checked, apart from a verified one (#218)", async () => {
  const declared = await mountWorkbench(
    runOf({ state: "succeeded", completion: "human-declared" }),
  );
  assert.match(
    declared.t.captureCharFrame(),
    /You declared the stage complete; Secant did not check the tracker\./,
  );
  const verified = await mountWorkbench(runOf({ state: "succeeded" }));
  assert.match(verified.t.captureCharFrame(), /Workflow completed\./);
  assert.doesNotMatch(verified.t.captureCharFrame(), /did not check/);
});

// --- live interactive Turn interrupt (#219) --------------------------------

/** A human Turn is live in the interactive Step: the Run reads `running`, the
 *  boundary offers are gone, and the live-Turn interrupt (and steer) are offered. */
function liveInteractiveRunOf(over: Partial<RunView> = {}): RunView {
  return interactiveRunOf({
    state: "running",
    actionOffers: [INTERRUPT_OFFER, STEER_OFFER, CANCEL_OFFER],
    ...over,
  });
}

test("a live interactive Turn shows its Interrupt and two Esc presses dispatch it (#219)", async () => {
  let interrupted: typeof INTERRUPT_OFFER | undefined;
  const actions = okActions({
    interrupt: (offer) => {
      interrupted = offer;
      return () => ({ kind: "ok" });
    },
  });
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, actions);
  await type(wb.t, "next");
  const frame = wb.t.captureCharFrame();
  assert.match(frame, /Your Turn/);
  assert.match(frame, /esc esc interrupt/);
  assert.doesNotMatch(frame, /a Turn is running — interrupt it to stop/);

  await press(wb.t, wb.renderer, "escape"); // arm, never leave
  assert.equal(interrupted, undefined);
  const armed = wb.t.captureCharFrame();
  assert.match(armed, /Press esc again to interrupt/);
  assert.match(armed, /Timeline/);
  assert.match(armed, /> next/); // the draft survives the arm

  await press(wb.t, wb.renderer, "escape"); // dispatch
  assert.deepEqual(interrupted, INTERRUPT_OFFER);
  assert.match(wb.t.captureCharFrame(), /Timeline/);
  assert.equal(wb.control.sends.length, 0);
});

test("any other key cancels an armed interactive Interrupt and still types (#219)", async () => {
  let interrupted = 0;
  const actions = okActions({
    interrupt: () => {
      interrupted += 1;
      return () => ({ kind: "ok" });
    },
  });
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, actions);
  await press(wb.t, wb.renderer, "escape");
  assert.match(wb.t.captureCharFrame(), /Press esc again/);
  // One real keypress reaches both the Port dispatcher (which disarms) and the
  // focused field (which types it); the test drives each path.
  wb.renderer.key("a");
  await type(wb.t, "a");
  const frame = wb.t.captureCharFrame();
  assert.doesNotMatch(frame, /Press esc again/);
  assert.match(frame, /> a/);
  assert.equal(interrupted, 0);
  // Disarmed, the next Esc arms again rather than dispatching.
  await press(wb.t, wb.renderer, "escape");
  assert.equal(interrupted, 0);
});

test("Ctrl+E disarms an armed interactive Interrupt, so one more Esc only re-arms (#219)", async () => {
  let interrupted = 0;
  const actions = okActions({
    interrupt: () => {
      interrupted += 1;
      return () => ({ kind: "ok" });
    },
  });
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, actions);
  await press(wb.t, wb.renderer, "escape");
  await press(wb.t, wb.renderer, "e", { ctrl: true });
  assert.doesNotMatch(wb.t.captureCharFrame(), /Press esc again/);
  await press(wb.t, wb.renderer, "escape");
  assert.equal(interrupted, 0);
  assert.match(wb.t.captureCharFrame(), /Press esc again/);
});

test("a request during a live interactive Turn owns Esc before the Interrupt (#219)", async () => {
  const wb = await mountWorkbench(liveInteractiveRunOf(), 100, 40, okActions());
  wb.control.setLive(requestOverlay());
  await wb.t.renderOnce();
  assert.doesNotMatch(wb.t.captureCharFrame(), /esc esc interrupt/);
  await press(wb.t, wb.renderer, "escape");
  assert.equal(wb.control.requests[0]?.decision, "deny");
  assert.doesNotMatch(wb.t.captureCharFrame(), /Press esc again to interrupt/);
});

test("an interrupted interactive Turn rests halted and resume returns to the same Step's input (#219)", async () => {
  const control = makeRunView(snapshotOf(liveInteractiveRunOf()));
  const renderer = makeFakeRenderer(100, 40);
  const actions = okActions({
    interrupt: () => {
      control.setRun(
        interactiveRunOf({
          state: "halted",
          timeline: [
            { at: "T1", event: "turn-settled", detail: "interrupted" },
          ],
          actionOffers: [RESUME_OFFER],
        }),
      );
      return () => ({ kind: "ok" });
    },
    resume: () => {
      control.setRun(interactiveRunOf());
      return () => ({ kind: "ok" });
    },
  });
  const { t } = await mountApp(control, renderer, "run-1", 100, 40, actions);
  await t.waitForFrame((f) => f.includes("Timeline"));
  await press(t, renderer, "escape");
  await press(t, renderer, "escape");
  const halted = t.captureCharFrame();
  assert.match(halted, /HALTED/);
  assert.match(halted, /r resume/);
  assert.doesNotMatch(halted, /Your Turn/);
  await press(t, renderer, "r");
  const back = t.captureCharFrame();
  assert.match(back, /BLOCKED · interactive Turn/);
  assert.match(back, /Your Turn/);
  assert.match(back, /enter send Turn/);
});

test("the live interactive Interrupt reads without colour and fits a small terminal (#219)", async () => {
  const wb = await mountWorkbench(liveInteractiveRunOf(), 40, 16, okActions());
  let frame = wb.t.captureCharFrame();
  assert.match(frame, /esc esc interrupt/);
  noOverflow(frame, 40);
  await press(wb.t, wb.renderer, "escape");
  frame = wb.t.captureCharFrame();
  assert.match(frame, /⚠ Press esc again/);
  noOverflow(frame, 40);
});

test("at a Turn boundary the interactive Esc still leaves the Workbench (#219)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await press(wb.t, wb.renderer, "escape");
  assert.match(wb.t.captureCharFrame(), /Secant/);
});

test("a refused send surfaces the refusal and keeps the typed draft (#122, A9)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "hi");
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
  // A9 (fails at HEAD): the refusal re-enables the field with the draft intact — a long
  // Turn typed at the wrong moment is not lost. HEAD cleared the draft before dispatch.
  assert.match(wb.t.captureCharFrame(), /> hi/);
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

test("the corrected INTERACTIVE_HEIGHT reclaims one timeline row at a fixed height (A33) — fails at HEAD", async () => {
  // At width 100 / height 24 the interactive input now reserves 3 rows (was 4), so the
  // timeline viewport is 15 rows. events(15) fills it exactly: the oldest event (e0) sits
  // at the top and the newest (e14) at the live edge, with no overflow. At HEAD the input
  // over-reserved a row, so the viewport was 14 and e0 fell off the top.
  const wb = await mountWorkbench(
    interactiveRunOf({ timeline: events(15) }),
    100,
    24,
  );
  const frame = wb.t.captureCharFrame();
  assert.match(frame, / e0 /); // the reclaimed row: the oldest event is visible
  assert.match(frame, / e14/); // the newest event still sits at the live edge
  noOverflow(frame, 100);
});

test("the corrected CHECKPOINT_HEIGHT reclaims one timeline row at a fixed height (A33) — fails at HEAD", async () => {
  // At width 100 / height 24 the Review checkpoint now reserves 7 rows (was 8), so the
  // timeline viewport is 10 rows. events(10) fills it exactly: the oldest event (e0) is
  // visible with no overflow. At HEAD the checkpoint over-reserved a row and e0 fell off.
  const wb = await mountWorkbench(
    blockedRunOf({ timeline: events(10) }),
    100,
    24,
  );
  const frame = wb.t.captureCharFrame();
  assert.match(frame, / e0 /); // the reclaimed row: the oldest event is visible
  assert.match(frame, / e9/); // the newest event still sits at the live edge
  noOverflow(frame, 100);
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
  basis: "durable Human Gate",
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

test("the request control vanishes when the Turn settles without an answer, and keys reach the timeline again (A8)", async () => {
  const { t, control, renderer } = await mountWithRequest();
  assert.match(t.captureCharFrame(), /Harness Request · awaiting/);
  assert.match(t.captureCharFrame(), /ephemeral Harness Request/); // the header basis
  // The Turn ends (or is interrupted/lost) and the overlay clears — the reducer drops it
  // on a `closed` update or when durable liveness leaves live-here (A8, run-view.test.ts).
  // Here the mounted view is handed the cleared overlay directly.
  control.setLive(undefined);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  assert.doesNotMatch(frame, /awaiting your approval/); // the request control is gone
  assert.doesNotMatch(frame, /ephemeral Harness Request/); // header no longer claims it
  assert.match(frame, /d details/); // footer returned
  // Ordinary keys reach the timeline again — the modal no longer swallows them.
  await press(t, renderer, "d");
  assert.match(t.captureCharFrame(), /› Details/);
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
  await type(t, "fix 42"); // text rides the native field via the mock input (D9)
  assert.match(t.captureCharFrame(), /> fix 42/); // field echoes the value
  await press(t, renderer, "return"); // Enter to submit comes over the Port dispatcher
  assert.equal(control.texts.length, 1);
  assert.equal(control.texts[0]?.text, "fix 42");
  assert.deepEqual(control.texts[0]?.gate, FREE_TEXT_GATE);
});

test("the free-text field takes capitals and punctuation verbatim (D9) — fails at HEAD", async () => {
  const { t, control, renderer } = await mountWorkbench(freeTextRunOf());
  // At HEAD the hand-rolled buffer lowercased capitals and dropped shifted symbols, so
  // `ABC-1!.` arrived `abc-1!.`; the native field carries the exact text.
  await type(t, "ABC-1!.");
  assert.match(t.captureCharFrame(), /> ABC-1!\./);
  await press(t, renderer, "return");
  assert.equal(control.texts[0]?.text, "ABC-1!.");
});

test("a bracketed paste and a word delete edit the free-text field natively (D9)", async () => {
  const { t, control, renderer } = await mountWorkbench(freeTextRunOf());
  await t.mockInput.pasteBracketedText("fix issue");
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /> fix issue/); // the paste landed whole
  // Ctrl+Backspace deletes the last word — reachable only through the native field.
  t.mockInput.pressBackspace({ ctrl: true });
  await t.renderOnce();
  await press(t, renderer, "return");
  assert.equal(control.texts[0]?.text, "fix ");
});

test("the interactive field takes capitals and punctuation verbatim (D9) — fails at HEAD", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  await type(wb.t, "ABC-1!.");
  assert.match(wb.t.captureCharFrame(), /> ABC-1!\./);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "ABC-1!." },
  ]);
});

test("a capital typed as a shifted key reaches the interactive field as uppercase (D9)", async () => {
  const wb = await mountWorkbench(interactiveRunOf());
  wb.t.mockInput.pressKey("a", { shift: true });
  await wb.t.renderOnce();
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.sends, [
    { runId: "run-1", stepId: "discuss", text: "A" },
  ]);
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

// #213: suggested free-text gate ------------------------------------

function suggestedRunOf(): RunView {
  return freeTextRunOf({
    pendingGate: {
      gate: FREE_TEXT_GATE,
      message: "Where should the spec live?",
      outputArtifactName: "tracker",
      suggestions: ["Local", "GitHub"],
    },
  });
}

test("a suggested gate lists its suggestions beside Other, with Other chosen until the human picks (#213)", async () => {
  const { t } = await mountWorkbench(suggestedRunOf());
  const frame = t.captureCharFrame();
  assert.match(frame, /Human Gate · Where should the spec live\?/);
  assert.match(frame, /Choose: Local · GitHub · \[Other \(type\)\]/);
  assert.match(frame, /↑↓ choose or type · enter submit/);
});

test("down picks a suggestion into the field and Enter submits it as the gate's text answer (#213)", async () => {
  const { t, control, renderer } = await mountWorkbench(suggestedRunOf());
  await press(t, renderer, "down");
  assert.match(t.captureCharFrame(), /Choose: \[Local\] · GitHub/);
  assert.match(t.captureCharFrame(), /> Local/);
  await press(t, renderer, "down");
  assert.match(t.captureCharFrame(), /Choose: Local · \[GitHub\]/);
  await press(t, renderer, "return");
  assert.equal(control.texts.length, 1);
  assert.equal(control.texts[0]?.text, "GitHub");
  assert.deepEqual(control.texts[0]?.gate, FREE_TEXT_GATE);
});

test("up wraps to the last suggestion, and cycling back to Other restores the typed answer (#213)", async () => {
  const { t, control, renderer } = await mountWorkbench(suggestedRunOf());
  await type(t, "Linear");
  await press(t, renderer, "up");
  assert.match(t.captureCharFrame(), /\[GitHub\]/);
  assert.match(t.captureCharFrame(), /> GitHub/);
  await press(t, renderer, "down"); // past the last suggestion: back to Other
  assert.match(t.captureCharFrame(), /\[Other \(type\)\]/);
  assert.match(t.captureCharFrame(), /> Linear/);
  await press(t, renderer, "return");
  assert.equal(control.texts[0]?.text, "Linear");
});

test("editing a picked suggestion turns it into a typed Other answer (#213)", async () => {
  const { t, control, renderer } = await mountWorkbench(suggestedRunOf());
  await press(t, renderer, "down");
  await type(t, " Enterprise");
  assert.match(t.captureCharFrame(), /\[Other \(type\)\]/);
  await press(t, renderer, "return");
  assert.equal(control.texts[0]?.text, "Local Enterprise");
});

test("the suggested gate control fits small widths without overflow (#213)", async () => {
  const { t, renderer } = await mountWorkbench(suggestedRunOf(), 100, 30);
  noOverflow(t.captureCharFrame(), 100);
  renderer.resize(40, 24);
  await t.renderOnce();
  const frame = t.captureCharFrame();
  noOverflow(frame, 40);
  assert.match(frame, /Choose:/);
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
  assert.equal(control.steers.length, 0);
});

// A live Turn under a Harness that declares native steer (Codex): the Actions rail
// names the `s` key, `s` opens a compose input, and Enter sends guidance (#148).
const AVAILABLE_STEER_OFFER = {
  action: "steer-turn" as const,
  runId: "run-1",
  turnId: "turn-7",
  available: true as const,
  consequence:
    "send same-Turn guidance to the running agent without ending the Turn.",
};
function steerableRunOf(over: Partial<RunView> = {}): RunView {
  return runOf({
    state: "running",
    progress: [{ id: "repair", kind: "agent", status: "running" }],
    actionOffers: [INTERRUPT_OFFER, AVAILABLE_STEER_OFFER, CANCEL_OFFER],
    ...over,
  });
}

test("available Steer names the `s` key; `s` opens the compose input and Enter sends the guidance (#148)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 40, okActions());
  // The Actions rail advertises the key and the consequence, readable without colour.
  assert.match(wb.t.captureCharFrame(), /s steer — send same-Turn guidance/);

  // `s` opens the compose input (the footer is replaced with the labelled field).
  await press(wb.t, wb.renderer, "s");
  assert.match(wb.t.captureCharFrame(), /Steer — guide the running Turn/);

  // The guidance rides the native field; Enter sends exactly one steer at the live turnId.
  await type(wb.t, "wrap it up");
  assert.match(wb.t.captureCharFrame(), /> wrap it up/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.steers, [
    { runId: "run-1", turnId: "turn-7", text: "wrap it up" },
  ]);
});

test("blank Steer guidance is not sent, and Esc backs out of the compose (#148)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 40, okActions());
  await press(wb.t, wb.renderer, "s");
  // Enter with an empty draft authors nothing.
  await press(wb.t, wb.renderer, "return");
  assert.equal(wb.control.steers.length, 0);
  // Esc leaves the compose; the passive footer returns and no steer was sent.
  await press(wb.t, wb.renderer, "escape");
  assert.doesNotMatch(
    wb.t.captureCharFrame(),
    /Steer — guide the running Turn/,
  );
  assert.equal(wb.control.steers.length, 0);
});

test("a refused Steer keeps the typed guidance and surfaces the refusal (#148)", async () => {
  const wb = await mountWorkbench(steerableRunOf(), 100, 40, okActions());
  wb.control.setSteerOutcome({
    kind: "refused",
    problem: {
      code: "steer-rejected",
      explanation: "The live Turn rejected the guidance.",
      remediation: "Steer the next live Turn.",
      possibleEffects: "none",
    },
  });
  await press(wb.t, wb.renderer, "s");
  await type(wb.t, "keep going");
  await press(wb.t, wb.renderer, "return");
  const frame = wb.t.captureCharFrame();
  // The draft survives a refusal (A9-style), and the refusal replaces the hint line.
  assert.match(frame, /> keep going/);
  assert.match(frame, /The live Turn rejected the guidance/);
});

test("reopening Steer after Escaping a still-pending send starts a clean, usable compose (#148)", async () => {
  // The default steer outcome stays `pending`, so a dispatched steer never settles.
  const wb = await mountWorkbench(steerableRunOf(), 100, 40, okActions());
  await press(wb.t, wb.renderer, "s");
  await type(wb.t, "first guidance");
  await press(wb.t, wb.renderer, "return"); // dispatch — now pending ("… steering…")
  assert.deepEqual(wb.control.steers, [
    { runId: "run-1", turnId: "turn-7", text: "first guidance" },
  ]);
  assert.match(wb.t.captureCharFrame(), /steering/);

  // Escape out while the send is still in flight, then reopen: the reopened compose
  // must not inherit the abandoned send's pending state (which would blur the field
  // and swallow keys). Typing lands and Enter dispatches the new guidance.
  await press(wb.t, wb.renderer, "escape");
  await press(wb.t, wb.renderer, "s");
  await type(wb.t, "second guidance");
  assert.match(wb.t.captureCharFrame(), /> second guidance/);
  await press(wb.t, wb.renderer, "return");
  assert.deepEqual(wb.control.steers[1], {
    runId: "run-1",
    turnId: "turn-7",
    text: "second guidance",
  });
});

test("the Steer compose stays within a narrow terminal and relays out on resize (#148)", async () => {
  const { t, renderer } = await mountWorkbench(
    steerableRunOf(),
    40,
    24,
    okActions(),
  );
  await press(t, renderer, "s");
  // A long guidance draft cannot push any line past the width.
  await type(
    t,
    "please wrap up the current change and stop before touching anything else",
  );
  noOverflow(t.captureCharFrame(), 40);
  renderer.resize(80, 24);
  await t.renderOnce();
  noOverflow(t.captureCharFrame(), 80);
});

test("Esc from Details returns focus to the timeline during a live Turn, never arming interrupt (A7) — fails at HEAD", async () => {
  // With a live agent Turn the interrupt Offer stands, so at HEAD the two-press Esc arm
  // sat above the focused-region branches and shadowed Details' own Esc: opening Details
  // and pressing Esc armed (and a second Esc cancelled) the Turn instead of going back.
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
  await press(t, renderer, "d"); // open Details; focus moves there
  const detailsFrame = t.captureCharFrame();
  assert.match(detailsFrame, /› Details/);
  assert.match(detailsFrame, /esc back/); // the footer stays honest about what Esc does
  await press(t, renderer, "escape"); // A7: back to the timeline, not an interrupt arm
  const afterEsc = t.captureCharFrame();
  assert.match(afterEsc, /› Timeline/);
  assert.doesNotMatch(afterEsc, /Press esc again to interrupt/);
  // A second Esc — now in timeline focus — only arms; it dispatches no interrupt-turn.
  await press(t, renderer, "escape");
  assert.equal(interrupted, 0);
});

test("workbench-interaction-regression: interrupt requires two Esc presses and keeps the Workbench", async () => {
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

test("workbench-interaction-regression: request modal owns Esc before interrupt and steer controls", async () => {
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
  const renderer = makeFakeRenderer(100, 40);
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
  const renderer = makeFakeRenderer(100, 40);
  let resumed = 0;
  const actions = okActions({
    resume: () => {
      resumed += 1;
      control.setRun(
        liveTurnRunOf({
          timeline: [{ at: "T0", event: "turn-started", turnKind: "agent" }],
        }),
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
