import assert from "node:assert/strict";
import { test } from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { App, createLiveRunLaunchView } from "../../src/tui/tui.js";
import { inertRunActionsView, inertRunListView } from "./inert.js";
import type {
  BundleCatalogView,
  LaunchOutcome,
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
  LaunchRunInput,
  OpenedProjection,
  OperationSnapshot,
  Problem,
  ProjectionPort,
  ProjectionSelector,
  RunSnapshot,
  Submission,
  SubmissionAdmission,
  WorkspaceSnapshot,
} from "../../src/application/projection-port.js";

// In-memory renderer tests for the Start-a-Run flow (#90). Most drive the flow
// through a hand-driven `RunLaunchView` over fake `bundle-catalog` snapshots —
// the chooser + side panel, the trust-acknowledge control, typed inputs with
// inline per-input findings, review, pending feedback, each refusal routed to its
// owning step, and the transition into the Run Workbench on success (#91 replaced
// #90's receipt), with small-width/resize relayout and status readable without
// colour. The last group exercises the real launch seam (`createLiveRunLaunchView`)
// over fake `operation`/`run` snapshots, both directly and end-to-end through the
// App into the Workbench.

const WORKSPACE = "/tmp/secant-launch-workspace";

const DEFAULT_HARNESSES: WorkspaceSnapshot["harnesses"] = [
  { id: "claude-code", name: "Claude Code", availability: "available" },
  { id: "codex", name: "Codex", availability: "available" },
];

function approvedWorkspace(
  harnesses: WorkspaceSnapshot["harnesses"] = DEFAULT_HARNESSES,
): WorkspaceView {
  const [snapshot] = createSignal<WorkspaceSnapshot>({
    family: "workspace",
    path: WORKSPACE,
    approval: { state: "approved", approvedAt: "2026-01-01T00:00:00.000Z" },
    installedBundleCount: 2,
    harnesses,
    actionOffers: [],
  });
  return { snapshot, approve() {} };
}

// --- fake bundle-catalog ---------------------------------------------------

function focus(
  over: Partial<InstalledBundleFocus> & { id: string },
): InstalledBundleFocus {
  const digest = over.digest ?? `digest-${over.id}`;
  return {
    id: over.id,
    version: over.version ?? "1.0.0",
    digest,
    name: over.name ?? over.id,
    description: over.description ?? "A bundle.",
    origin: over.origin ?? { kind: "local-file", location: "/bundles/x.wfb" },
    stability: over.stability ?? "stable",
    platforms: over.platforms ?? ["linux"],
    engine: over.engine ?? { range: ">=0.1.0", satisfied: true },
    trust: over.trust ?? { state: "app-release" },
    author: over.author ?? {},
    launchInputs: over.launchInputs ?? [],
    routing: over.routing ?? [
      { node: "step", step: { id: "build", kind: "command" } },
    ],
    workspacePrerequisites: over.workspacePrerequisites ?? [],
    producedArtifacts: over.producedArtifacts ?? [],
    executionSummary: over.executionSummary ?? {
      platform: "linux",
      identity: { id: over.id, version: over.version ?? "1.0.0" },
      digest,
      origin: over.origin ?? { kind: "local-file", location: "/bundles/x.wfb" },
      platforms: ["linux"],
      stepKindCounts: { command: 1 },
      commands: [],
      warning: "Commands run with your user's authority.",
    },
    compositionFindings: over.compositionFindings ?? [],
  };
}

function catalog(bundles: readonly InstalledBundleFocus[]): BundleCatalogView {
  const [list] = createSignal<BundleCatalogSnapshot>({
    family: "bundle-catalog",
    view: "list",
    result: { found: true, bundles },
  });
  return {
    openList: () => list,
    openFocus: (selector: BundleFocusSelector) => {
      const bundle = bundles.find(
        (candidate) =>
          candidate.id === selector.id &&
          (selector.version === undefined ||
            candidate.version === selector.version),
      );
      const [snapshot] = createSignal<BundleFocusSnapshot>({
        family: "bundle-catalog",
        view: "focus",
        selection: selector,
        result:
          bundle !== undefined
            ? { found: true, bundle }
            : {
                found: false,
                problem: {
                  code: "bundle-not-installed",
                  explanation: "gone",
                  remediation: "install",
                  possibleEffects: "none",
                },
              },
      });
      return snapshot;
    },
  };
}

// --- hand-driven launch seam -----------------------------------------------

function fakeLaunch() {
  const calls: LaunchRunInput[] = [];
  const [outcome, setOutcome] = createSignal<LaunchOutcome>({
    kind: "pending",
  });
  const view: RunLaunchView = {
    launch(input) {
      calls.push(input);
      return outcome;
    },
  };
  return { view, calls, resolve: (o: LaunchOutcome) => setOutcome(() => o) };
}

// The Run Workbench opens only after a successful launch; most flow tests never
// get there. This stub throws if opened, so a stray transition is caught.
function noRunView(): RunWorkbenchView {
  return {
    openRun() {
      throw new Error("run workbench not opened in this test");
    },
    readResource() {
      throw new Error("run workbench not opened in this test");
    },
    readTranscript() {
      throw new Error("run workbench not opened in this test");
    },
    answer() {
      throw new Error("run workbench not opened in this test");
    },
    sendInteractiveTurn() {
      throw new Error("run workbench not opened in this test");
    },
    endInteractiveStep() {
      throw new Error("run workbench not opened in this test");
    },
    steer() {
      throw new Error("run workbench not opened in this test");
    },
    answerText() {
      throw new Error("run workbench not opened in this test");
    },
    answerRequest() {
      throw new Error("run workbench not opened in this test");
    },
  };
}

// A Run Workbench seam that serves any requested Run id as a resting, succeeded
// Run, so the receipt-replacement tests can assert the transition into it (#91).
function succeedingRunView(): RunWorkbenchView {
  return {
    openRun(runId) {
      const [snapshot] = createSignal<RunSnapshot>({
        family: "run",
        runId,
        result: {
          found: true,
          run: {
            runId,
            bundle: {
              id: "dev.alpha",
              version: "1.0.0",
              name: "Alpha",
              digest: "d",
            },
            workspacePath: WORKSPACE,
            launchedAt: "2026-01-01T00:00:00.000Z",
            state: "succeeded",
            liveness: { state: "not-live" },
            progress: [],
            position: 0,
            timeline: [],
            outputs: [],
            actionOffers: [],
          },
        },
      });
      return {
        snapshot,
        live: () => undefined,
        preview: () => undefined,
      };
    },
    readResource() {
      throw new Error("no reference read in this test");
    },
    readTranscript() {
      throw new Error("no transcript read in this test");
    },
    answer() {
      throw new Error("no answer dispatched in this test");
    },
    sendInteractiveTurn() {
      throw new Error("no interactive Turn sent in this test");
    },
    endInteractiveStep() {
      throw new Error("no interactive Step ended in this test");
    },
    steer() {
      throw new Error("no steer dispatched in this test");
    },
    answerText() {
      throw new Error("no answer dispatched in this test");
    },
    answerRequest() {
      throw new Error("no answer dispatched in this test");
    },
  };
}

async function mountFlow(
  bundlesView: BundleCatalogView,
  launchView: RunLaunchView,
  width = 100,
  height = 40,
  runView: RunWorkbenchView = noRunView(),
  harnesses: WorkspaceSnapshot["harnesses"] = DEFAULT_HARNESSES,
) {
  const exits: unknown[] = [];
  const t = await testRender(
    () => (
      <App
        view={approvedWorkspace(harnesses)}
        bundles={bundlesView}
        launch={launchView}
        run={runView}
        runList={inertRunListView()}
        actions={inertRunActionsView()}
        renderer={makeFakeRenderer(width, height).port}
        exit={(reason) => exits.push(reason)}
      />
    ),
    { width, height },
  );
  await t.waitForFrame((f) => f.includes("Secant"));
  // Home menu: Workflow Bundles (0), Start a Run (1).
  t.mockInput.pressArrow("down");
  t.mockInput.pressEnter();
  // "esc back" is in every chooser footer but not Home's, so it marks arrival.
  await t.waitForFrame((f) => f.includes("esc back"));
  return { t, exits };
}

const ALPHA = focus({
  id: "dev.alpha",
  name: "Alpha",
  description: "The trusted one",
  digest: "alpha0000",
  trust: { state: "app-release" },
  launchInputs: [],
});
const AGENT_ALPHA = focus({
  id: "dev.agent-alpha",
  name: "Agent Alpha",
  description: "The agent-bearing one",
  digest: "agentalpha000",
  trust: { state: "app-release" },
  launchInputs: [],
  routing: [{ node: "step", step: { id: "work", kind: "agent" } }],
});
const BETA = focus({
  id: "dev.beta",
  name: "Beta",
  description: "The untrusted one",
  digest: "beta1111",
  trust: { state: "not-yet-trusted" },
  launchInputs: [
    { name: "target", type: "text", description: "What to build" },
    {
      name: "mode",
      type: "choice",
      description: "How to run",
      choices: ["fast", "slow"],
    },
  ],
});
const AGENT_BETA = focus({
  id: "dev.agent-beta",
  name: "Agent Beta",
  description: "An agent Bundle with draft input.",
  digest: "agentbeta111",
  trust: { state: "app-release" },
  launchInputs: [
    { name: "target", type: "text", description: "What to build" },
  ],
  routing: [{ node: "step", step: { id: "work", kind: "agent" } }],
});

// Two trusted Bundles that both declare an input named `target`, for the
// cross-Bundle draft-leak test.
const GAMMA = focus({
  id: "dev.gamma",
  name: "Gamma",
  description: "trusted one",
  digest: "gamma000",
  trust: { state: "app-release" },
  launchInputs: [{ name: "target", type: "text", description: "for gamma" }],
});
const DELTA = focus({
  id: "dev.delta",
  name: "Delta",
  description: "trusted two",
  digest: "delta000",
  trust: { state: "app-release" },
  launchInputs: [{ name: "target", type: "text", description: "for delta" }],
});
// A second untrusted Bundle, for the acknowledgement-persistence test.
const EPSILON = focus({
  id: "dev.epsilon",
  name: "Epsilon",
  description: "untrusted two",
  digest: "eps22222",
  trust: { state: "not-yet-trusted" },
  launchInputs: [],
});

// --- chooser + trust -------------------------------------------------------

test("chooser lists Bundles with the side panel; untrusted shows the acknowledgement, trusted does not; Continue is gated", async () => {
  const { t } = await mountFlow(catalog([ALPHA, BETA]), fakeLaunch().view);
  const first = t.captureCharFrame();
  // Side panel limited to Name, Description, Source, Workflow.
  assert.match(first, /Name/);
  assert.match(first, /The trusted one/);
  assert.match(first, /Source/);
  assert.match(first, /Workflow/);
  assert.match(first, /build \(command\)/);
  // Trusted selection: no acknowledgement, Continue available.
  assert.doesNotMatch(first, /acknowledge/i);
  assert.match(first, /enter continue/);

  // Move to the untrusted Bundle.
  t.mockInput.pressArrow("down");
  await t.waitForFrame((f) => /acknowledge/i.test(f));
  const untrusted = t.captureCharFrame();
  assert.match(untrusted, /Untrusted Bundle/);
  assert.match(untrusted, /press a to acknowledge/);
  // Continue unavailable until acknowledged.
  assert.match(untrusted, /acknowledge trust \(a\) to continue/);

  // Acknowledge.
  t.mockInput.pressKey("a");
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  assert.match(t.captureCharFrame(), /enter continue/);
});

test("a Bundle with no declared inputs skips the inputs screen and reaches review, digest shown once", async () => {
  const { t } = await mountFlow(catalog([ALPHA]), fakeLaunch().view);
  t.mockInput.pressEnter(); // Alpha is trusted + no inputs → straight to review
  await t.waitForFrame((f) => f.includes("Review"));
  const frame = t.captureCharFrame();
  assert.match(frame, /No launch inputs/);
  assert.match(frame, /sha256:alpha0000/);
  assert.equal(
    frame.split("alpha0000").length - 1,
    1,
    "digest shown exactly once",
  );
});

test("[both-client-harness-selection] an Agent Bundle chooses a colour-independent Harness status and reviews the semantic selection", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([AGENT_ALPHA]), launch.view, 40, 20);
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  let frame = t.captureCharFrame();
  assert.match(frame, /Claude Code/);
  assert.match(frame, /Codex/);
  assert.equal(frame.match(/available/g)?.length, 2);
  for (const line of frame.split("\n")) {
    assert.ok(line.length <= 40, `overflow at 40: ${JSON.stringify(line)}`);
  }

  t.mockInput.pressArrow("down");
  t.mockInput.pressEnter();
  await t.waitForFrame((candidate) => candidate.includes("Review"));
  frame = t.captureCharFrame();
  assert.match(frame, /Harness: Codex \(codex\)/);

  t.mockInput.pressEnter();
  await t.waitForFrame((candidate) => candidate.includes("Launching"));
  assert.equal(launch.calls[0]?.harness, "codex");
});

test("changing a Harness after a selected-Harness refusal preserves unrelated input drafts", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([AGENT_BETA]), launch.view);
  t.mockInput.pressEnter(); // Bundle → Harness
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  t.mockInput.pressArrow("down"); // Codex
  t.mockInput.pressEnter(); // Harness → inputs
  await t.waitForFrame((frame) => frame.includes("Launch inputs"));
  t.mockInput.pressKey("h");
  t.mockInput.pressKey("i");
  await t.waitForFrame((frame) => frame.includes("hi"));
  t.mockInput.pressEnter(); // inputs → review
  await t.waitForFrame((frame) => frame.includes("Harness: Codex"));
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((frame) => frame.includes("Launching"));
  launch.resolve({
    kind: "refused",
    problem: {
      code: "harness-not-found",
      explanation: "Codex could not be found.",
      remediation: "Install Codex.",
      possibleEffects: "none",
      correction: "harness-selection",
      details: { harness: "codex" },
    },
  });
  await t.waitForFrame((frame) => frame.includes("harness-not-found"));
  t.mockInput.pressArrow("up"); // Claude Code
  t.mockInput.pressEnter(); // back to inputs
  await t.waitForFrame((frame) => frame.includes("Launch inputs"));
  assert.match(t.captureCharFrame(), /hi/);
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Harness: Claude Code"));
  assert.match(t.captureCharFrame(), /target: hi/);
});

test("an unavailable Harness names its reason, cannot continue, and relayouts after resize", async () => {
  const choices: WorkspaceSnapshot["harnesses"] = [
    { id: "claude-code", name: "Claude Code", availability: "available" },
    {
      id: "codex",
      name: "Codex",
      availability: "unavailable",
      unavailableReason: "Codex support is disabled in this build.",
    },
  ];
  const { t } = await mountFlow(
    catalog([AGENT_ALPHA]),
    fakeLaunch().view,
    50,
    20,
    noRunView(),
    choices,
  );
  t.mockInput.pressEnter();
  await t.waitForFrame((frame) => frame.includes("Choose a Harness"));
  t.mockInput.pressArrow("down");
  await t.waitForFrame((frame) => frame.includes("disabled in this build"));
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /Choose a Harness/);
  assert.doesNotMatch(t.captureCharFrame(), /Review/);
  t.resize(30, 20);
  await t.renderOnce();
  for (const line of t.captureCharFrame().split("\n")) {
    assert.ok(line.length <= 30, `overflow at 30: ${JSON.stringify(line)}`);
  }
});

test("pending feedback then a transition into the Workbench for the Run id; a trusted launch carries no trustDigest", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(
    catalog([ALPHA]),
    launch.view,
    100,
    40,
    succeedingRunView(),
  );
  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Launching"));
  assert.equal(launch.calls.length, 1);
  assert.equal(launch.calls[0]?.trustDigest, undefined);

  // A successful launch replaces #90's receipt with the Run's Workbench (#91).
  launch.resolve({ kind: "launched", runId: "run-42", state: "succeeded" });
  await t.waitForFrame((f) => f.includes("Run run-42"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Run run-42/);
  assert.match(frame, /SUCCEEDED/); // state in words as well as colour
  assert.match(frame, /Timeline/); // timeline-first Workbench
});

// --- typed inputs + inline findings ---------------------------------------

test("renders exactly the declared inputs, carries the acknowledged trustDigest, and shows per-input findings inline after Start", async () => {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([BETA]), launch.view);
  t.mockInput.pressKey("a"); // acknowledge trust (BETA is the only, selected, Bundle)
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressEnter(); // → inputs (BETA has inputs)
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  const inputs = t.captureCharFrame();
  assert.match(inputs, /target \(text\)/);
  assert.match(inputs, /mode \(choice\)/);

  // Type into the focused text input, then cycle the choice input.
  t.mockInput.pressKey("h");
  t.mockInput.pressKey("i");
  await t.waitForFrame((f) => f.includes("hi"));
  t.mockInput.pressArrow("down"); // focus the choice input
  t.mockInput.pressArrow("right"); // choose "fast"
  await t.waitForFrame((f) => /‹ fast ›/.test(f));

  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((f) => f.includes("Review"));
  const review = t.captureCharFrame();
  assert.match(review, /target: hi/);
  assert.match(review, /mode: fast/);

  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Launching"));
  assert.equal(
    launch.calls[0]?.trustDigest,
    "beta1111",
    "acknowledged digest is sent",
  );
  assert.deepEqual(launch.calls[0]?.launchInputs, {
    target: "hi",
    mode: "fast",
  });

  // Refuse with a per-input violation: route back to inputs with the finding,
  // and the drafts stay intact.
  launch.resolve({
    kind: "refused",
    problem: {
      code: "launch-input-invalid",
      explanation: "invalid",
      remediation: "fix",
      possibleEffects: "none",
      fieldViolations: [
        { field: "target", explanation: "must be non-empty text." },
      ],
    },
  });
  await t.waitForFrame((f) => f.includes("must be non-empty text."));
  const refused = t.captureCharFrame();
  assert.match(refused, /Launch inputs/);
  assert.match(refused, /must be non-empty text\./);
  assert.match(refused, /hi/, "the entered draft survives the refusal");

  // Dismissing feedback (moving focus) never removes the inline finding.
  t.mockInput.pressArrow("down");
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /must be non-empty text\./);
});

test("an input draft does not leak into another Bundle's same-named input", async () => {
  const { t } = await mountFlow(catalog([GAMMA, DELTA]), fakeLaunch().view);
  t.mockInput.pressEnter(); // Gamma (trusted) → inputs
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  t.mockInput.pressKey("h");
  t.mockInput.pressKey("i");
  await t.waitForFrame((f) => f.includes("hi"));
  t.mockInput.pressEscape(); // back to the chooser
  await until(() => !t.captureCharFrame().includes("Launch inputs"));
  t.mockInput.pressArrow("down"); // select Delta (also declares `target`)
  t.mockInput.pressEnter(); // → inputs
  await until(() => t.captureCharFrame().includes("for delta"));
  // Delta's `target` starts empty — Gamma's draft did not leak in.
  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((f) => f.includes("Review"));
  assert.match(t.captureCharFrame(), /target: \(not set\)/);
});

test("an acknowledged digest stays acknowledged after visiting another Bundle", async () => {
  const { t } = await mountFlow(catalog([BETA, EPSILON]), fakeLaunch().view);
  t.mockInput.pressKey("a"); // acknowledge Beta
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressArrow("down"); // Epsilon (also untrusted)
  await t.waitForFrame((f) => f.includes("untrusted two"));
  t.mockInput.pressKey("a"); // acknowledge Epsilon too
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressArrow("up"); // back to Beta
  await t.waitForFrame((f) => f.includes("The untrusted one"));
  // Beta is still acknowledged — the set kept it.
  assert.match(t.captureCharFrame(), /Trust acknowledged/);
  assert.match(t.captureCharFrame(), /enter continue/);
});

test("an empty Catalog shows no acknowledge hint", async () => {
  const { t } = await mountFlow(catalog([]), fakeLaunch().view);
  const frame = t.captureCharFrame();
  assert.match(frame, /Catalog is empty/);
  assert.doesNotMatch(frame, /acknowledge/i);
});

// --- refusals routed to their owning step ---------------------------------

async function refuseFromReview(problem: Problem) {
  const launch = fakeLaunch();
  const { t } = await mountFlow(catalog([ALPHA]), launch.view);
  t.mockInput.pressEnter(); // → review
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Launching"));
  launch.resolve({ kind: "refused", problem });
  return t;
}

test("a Workspace prerequisite failure returns to Bundle selection with the remediation", async () => {
  const t = await refuseFromReview({
    code: "workspace-prerequisite-failed",
    explanation: "The Workspace is not a Git worktree root.",
    remediation:
      "Launch from the root of a Git worktree, or choose another Bundle.",
    possibleEffects: "none",
  });
  await t.waitForFrame((f) => f.includes("workspace-prerequisite-failed"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Start a Run/); // back on the chooser
  assert.match(frame, /Launch refused: workspace-prerequisite-failed/);
  assert.match(frame, /choose another Bundle/);
  assert.doesNotMatch(frame, /Timeline/); // never transitioned into the Workbench
});

test("a corrupted Bundle returns to selection advising reinstalling it", async () => {
  const t = await refuseFromReview({
    code: "bundle-snapshot-corrupt",
    explanation:
      "The installed Bundle is corrupted and can no longer be launched.",
    remediation:
      "Reinstall the Bundle to restore an intact copy, then launch again.",
    possibleEffects: "none",
  });
  await t.waitForFrame((f) => f.includes("bundle-snapshot-corrupt"));
  const frame = t.captureCharFrame();
  assert.match(frame, /corrupted/);
  assert.match(frame, /Reinstall the Bundle/);
  assert.doesNotMatch(frame, /Timeline/); // never transitioned into the Workbench
});

test("declining trust launches nothing and cannot continue", async () => {
  const launch = fakeLaunch();
  const { t, exits } = await mountFlow(catalog([BETA]), launch.view);
  // Do not acknowledge; Continue must be unavailable.
  t.mockInput.pressEnter();
  await t.renderOnce();
  assert.match(t.captureCharFrame(), /acknowledge trust \(a\) to continue/);
  assert.equal(launch.calls.length, 0, "no launch was submitted");

  // Escape declines: back to Home, still nothing launched.
  t.mockInput.pressEscape();
  await until(() => t.captureCharFrame().includes("Workspace"));
  assert.match(t.captureCharFrame(), /Secant/);
  assert.equal(launch.calls.length, 0);
  assert.deepEqual(exits, []);
});

test("Escape steps back one screen at a time", async () => {
  const { t } = await mountFlow(catalog([BETA]), fakeLaunch().view);
  t.mockInput.pressKey("a");
  await t.waitForFrame((f) => f.includes("Trust acknowledged"));
  t.mockInput.pressEnter(); // → inputs
  await t.waitForFrame((f) => f.includes("Launch inputs"));
  t.mockInput.pressEscape(); // inputs → choose
  await until(() => !t.captureCharFrame().includes("Launch inputs"));
  assert.match(t.captureCharFrame(), /enter continue/); // back on the chooser
  t.mockInput.pressEscape(); // choose → home
  await until(() => t.captureCharFrame().includes("Workspace"));
  assert.match(t.captureCharFrame(), /enter open/); // Home footer
});

// --- layout ----------------------------------------------------------------

function lineWith(frame: string, needle: string): string {
  return frame.split("\n").find((line) => line.includes(needle)) ?? "";
}

test("wide width places the side panel beside the list; a small width collapses it below, both without horizontal overflow", async () => {
  const { t } = await mountFlow(
    catalog([ALPHA, BETA]),
    fakeLaunch().view,
    100,
    30,
  );
  // Row layout: the panel's "Name" shares a line with the "Alpha" list row.
  assert.ok(lineWith(t.captureCharFrame(), "Alpha").includes("Name"));

  t.resize(40, 30);
  await t.renderOnce();
  const narrow = t.captureCharFrame();
  for (const line of narrow.split("\n")) {
    assert.ok(line.length <= 40, `overflow at 40: ${JSON.stringify(line)}`);
  }
  // Collapsed: the panel is now below the list — "Name" no longer shares the
  // "Alpha" row, and both are still present.
  assert.match(narrow, /Alpha/);
  assert.match(narrow, /Name/);
  assert.ok(
    !lineWith(narrow, "Alpha").includes("Name"),
    "side panel dropped below the list",
  );

  t.resize(30, 30);
  await t.renderOnce();
  for (const line of t.captureCharFrame().split("\n")) {
    assert.ok(line.length <= 30, `overflow at 30: ${JSON.stringify(line)}`);
  }
});

// --- live launch seam over fake operation/run snapshots --------------------

function stubProjection(snapshot: unknown): OpenedProjection {
  return {
    snapshot,
    catchUp: "fresh",
    updates: (async function* () {})(),
    close() {},
  } as OpenedProjection;
}

/** A fake Port that answers submit with a fixed admission and serves the
 *  `operation`/`run` snapshots the launch sequence reads. */
function fakePort(config: {
  admission: SubmissionAdmission;
  operation?: OperationSnapshot;
  run?: RunSnapshot;
  onSubmit?: (submission: Submission) => void;
}): ProjectionPort {
  const openProjection = (selector: ProjectionSelector): OpenedProjection => {
    if (selector.family === "operation")
      return stubProjection(config.operation);
    if (selector.family === "run") return stubProjection(config.run);
    throw new Error(`unexpected selector ${selector.family}`);
  };
  return {
    openProjection: openProjection as ProjectionPort["openProjection"],
    submit(submission: Submission): SubmissionAdmission {
      config.onSubmit?.(submission);
      return config.admission;
    },
    readResource() {
      throw new Error("not used");
    },
    readTranscript() {
      throw new Error("not used");
    },
  };
}

const RUN_SUCCEEDED: RunSnapshot = {
  family: "run",
  runId: "run-9",
  result: {
    found: true,
    run: {
      runId: "run-9",
      bundle: { id: "x", version: "1.0.0", name: "X", digest: "d" },
      workspacePath: WORKSPACE,
      launchedAt: "2026-01-01T00:00:00.000Z",
      state: "succeeded",
      liveness: { state: "not-live" },
      progress: [],
      position: 0,
      timeline: [],
      outputs: [],
      actionOffers: [],
    },
  },
};

test("live seam: submit → applied operation → found Run yields a launched receipt", () => {
  let sent: Submission | undefined;
  const port = fakePort({
    admission: { admitted: true, operationId: "op-1", runId: "run-9" },
    operation: {
      family: "operation",
      operationId: "op-1",
      outcome: { status: "applied" },
    },
    run: RUN_SUCCEEDED,
    onSubmit: (s) => (sent = s),
  });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.deepEqual(outcome, {
    kind: "launched",
    runId: "run-9",
    state: "succeeded",
  });
  assert.equal(sent?.operation, "launch-run");
});

test("live seam: a not-admitted submission is a refusal", () => {
  const problem: Problem = {
    code: "workspace-not-approved",
    explanation: "no",
    remediation: "approve",
    possibleEffects: "none",
  };
  const port = fakePort({ admission: { admitted: false, problem } });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.deepEqual(outcome, { kind: "refused", problem });
});

test("live seam: launch resolves at admission from the running Run, without reading the operation outcome", () => {
  // The operation is still `pending` (settlement is deferred now, #98). The launch
  // must resolve at admission from the live `run` snapshot — never blocking on the
  // operation outcome — so the flow reaches the Workbench before the Run rests (S1).
  const port = fakePort({
    admission: { admitted: true, operationId: "op-1", runId: "run-9" },
    operation: {
      family: "operation",
      operationId: "op-1",
      outcome: { status: "pending" },
    },
    run: {
      family: "run",
      runId: "run-9",
      result: {
        found: true,
        run: {
          runId: "run-9",
          bundle: { id: "x", version: "1.0.0", name: "X", digest: "d" },
          workspacePath: WORKSPACE,
          launchedAt: "2026-01-01T00:00:00.000Z",
          state: "running",
          liveness: { state: "live-here", ownerPid: 123 },
          progress: [],
          position: 0,
          timeline: [],
          outputs: [],
          actionOffers: [],
        },
      },
    },
  });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.deepEqual(outcome, {
    kind: "launched",
    runId: "run-9",
    state: "running",
  });
});

test("live seam: an admitted launch whose Run cannot be read is a refusal", () => {
  const problem: Problem = {
    code: "run-store-damaged",
    explanation: "bad",
    remediation: "fix",
    possibleEffects: "none",
  };
  const port = fakePort({
    admission: { admitted: true, operationId: "op-1", runId: "run-9" },
    run: { family: "run", runId: "run-9", result: { found: false, problem } },
  });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.deepEqual(outcome, { kind: "refused", problem });
});

test("live seam: an admitted launch with no Run id is a contract-breach refusal", () => {
  const port = fakePort({ admission: { admitted: true, operationId: "op-1" } });
  const outcome = createLiveRunLaunchView(port).launch({
    bundle: { id: "x" },
    launchInputs: {},
  })();
  assert.equal(outcome.kind, "refused");
  assert.equal(
    outcome.kind === "refused" ? outcome.problem.code : "",
    "run-not-identified",
  );
});

test("end-to-end over the live seam: a launched Run transitions into its Workbench", async () => {
  const port = fakePort({
    admission: { admitted: true, operationId: "op-1", runId: "run-9" },
    operation: {
      family: "operation",
      operationId: "op-1",
      outcome: { status: "applied" },
    },
    run: RUN_SUCCEEDED,
  });
  const { t } = await mountFlow(
    catalog([ALPHA]),
    createLiveRunLaunchView(port),
    100,
    40,
    succeedingRunView(),
  );
  t.mockInput.pressEnter(); // Alpha is trusted + no inputs → review
  await t.waitForFrame((f) => f.includes("Review"));
  t.mockInput.pressEnter(); // Start
  await t.waitForFrame((f) => f.includes("Run run-9"));
  const frame = t.captureCharFrame();
  assert.match(frame, /Run run-9/);
  assert.match(frame, /SUCCEEDED/);
});
